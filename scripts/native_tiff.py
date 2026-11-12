"""Bounded native-coordinate TIFF windows, using only the Python standard library.

This adapter deliberately accepts only classic, unsigned 8-bit, uncompressed
BlackIsZero grayscale or RGB TIFF strips. It never resamples or changes color.
It is a source preparation adapter, not an anatomical or calibration validator.
"""
from pathlib import Path
import math
import os
import stat
import struct

MAX_FILE_BYTES = 2 * 1024 ** 3
MAX_WINDOW_BYTES = 64 * 1024 ** 2
MAX_IFD_ENTRIES = 4096
MAX_STRIPS = 65536
MAX_AXIS = 32767


def require(condition, message):
    if not condition:
        raise ValueError(message)


class NativeTiff:
    """Read exact windows without allocating or decoding an entire native image."""

    def __init__(self, path):
        self.path = Path(path)
        self._handle = None
        require(not self.path.is_symlink(), 'Source TIFF must not be a symbolic link.')
        require(stat.S_ISREG(self.path.stat().st_mode), 'Source TIFF must be a regular file.')
        try:
            self._handle = self.path.open('rb')
            info = os.fstat(self._handle.fileno())
            require(stat.S_ISREG(info.st_mode), 'Source TIFF must be a regular file.')
            require(8 <= info.st_size <= MAX_FILE_BYTES, 'Source TIFF is empty or exceeds the 2 GiB preparation limit.')
            self._identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            self._size = info.st_size
            self._parse()
            self._check_stable()
        except BaseException:
            self.close()
            raise

    def _read(self, offset, length):
        require(0 <= offset <= self._size and 0 <= length <= self._size - offset,
                'TIFF metadata or pixels point outside the source file.')
        self._handle.seek(offset)
        value = self._handle.read(length)
        require(len(value) == length, 'TIFF is truncated or changed during reading.')
        return value

    def _check_stable(self):
        require(self._handle is not None, 'TIFF reader is closed.')
        info = os.fstat(self._handle.fileno())
        current = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        require(current == self._identity, 'Source TIFF changed during preparation.')

    def _parse(self):
        header = self._read(0, 8)
        self._endian = '<' if header[:2] == b'II' else '>' if header[:2] == b'MM' else None
        require(self._endian is not None, 'Unknown TIFF byte order.')
        magic, ifd = struct.unpack(self._endian + 'HI', header[2:])
        require(magic == 42, 'Native window preparation requires classic TIFF; BigTIFF is not silently converted.')
        require(ifd >= 8, 'TIFF image directory overlaps its header.')
        count = struct.unpack(self._endian + 'H', self._read(ifd, 2))[0]
        require(0 < count <= MAX_IFD_ENTRIES, 'TIFF image directory entry count is unsupported.')
        directory_end = ifd + 2 + count * 12 + 4
        raw = self._read(ifd + 2, count * 12 + 4)
        require(struct.unpack(self._endian + 'I', raw[-4:])[0] == 0,
                'Exactly one physical section per TIFF is required; multiple pages are not selected automatically.')
        self._metadata_ranges = [(0, 8), (ifd, directory_end)]
        entries = {}
        for index in range(count):
            entry = raw[index * 12:(index + 1) * 12]
            tag, kind, number = struct.unpack(self._endian + 'HHI', entry[:8])
            require(tag not in entries, 'Duplicate TIFF metadata tag.')
            entries[tag] = (kind, number, entry[8:])
        require(not ({322, 323, 324, 325} & entries.keys()),
                'Tiled TIFF layout is unsupported by this strip adapter; no pixels were transformed.')
        require(330 not in entries, 'Sub-IFD or pyramidal TIFF is ambiguous; no plane was chosen.')

        def values(tag, default=None, limit=16):
            if tag not in entries:
                return default
            kind, number, field = entries[tag]
            formats = {1: ('B', 1), 3: ('H', 2), 4: ('I', 4)}
            require(kind in formats and 0 < number <= limit, 'Unsupported TIFF metadata type or count.')
            code, unit = formats[kind]
            length = number * unit
            if length <= 4:
                data = field[:length]
            else:
                offset = struct.unpack(self._endian + 'I', field)[0]
                data = self._read(offset, length)
                require(offset >= 8 and not (offset < directory_end and offset + length > ifd),
                        'TIFF metadata values overlap the header or image directory.')
                self._metadata_ranges.append((offset, offset + length))
            return list(struct.unpack(self._endian + code * number, data))

        def scalar(tag, default=None):
            result = values(tag, None)
            if result is None:
                return default
            require(len(result) == 1, 'Expected scalar TIFF metadata.')
            return result[0]

        self.width, self.height = scalar(256), scalar(257)
        require(isinstance(self.width, int) and isinstance(self.height, int)
                and 0 < self.width <= MAX_AXIS and 0 < self.height <= MAX_AXIS,
                'TIFF dimensions exceed the native ImageJ coordinate limit or are missing.')
        self.channels = scalar(277, 1)
        require(self.channels in (1, 3), 'Only grayscale or RGB source channels are supported; channels are never dropped.')
        bits = values(258, [1])
        require(bits == [8] * self.channels, 'Only unsigned 8-bit samples are supported; no intensity conversion is performed.')
        require(scalar(259, 1) == 1, 'Compressed TIFF is unsupported by this native strip adapter.')
        require(scalar(262) == (1 if self.channels == 1 else 2),
                'Only BlackIsZero grayscale or RGB is supported; color interpretation is never inferred.')
        require(scalar(274, 1) == 1, 'TIFF orientation must be top-left; no rotation or mirroring is performed.')
        require(scalar(284, 1) == 1, 'TIFF channels must be contiguous, not planar.')
        require(values(339, [1] * self.channels) in ([1], [1] * self.channels), 'TIFF samples must be unsigned integers.')
        require(338 not in entries, 'Extra TIFF samples require an explicit interpretation; none were discarded.')
        rows = scalar(278, 2 ** 32 - 1)
        require(isinstance(rows, int) and rows > 0, 'TIFF RowsPerStrip must be positive.')
        self._rows_per_strip = rows
        strip_count = math.ceil(self.height / rows)
        require(strip_count <= MAX_STRIPS, 'Too many TIFF strips for bounded preparation.')
        self._offsets = values(273, None, MAX_STRIPS)
        self._counts = values(279, None, MAX_STRIPS)
        require(self._offsets is not None and self._counts is not None
                and len(self._offsets) == len(self._counts) == strip_count,
                'Strip offsets/counts do not cover the complete native image.')
        self._row_bytes = self.width * self.channels
        require(self._row_bytes * self.height <= MAX_FILE_BYTES, 'Native pixel bytes exceed the 2 GiB preparation limit.')
        ranges = []
        for index, (offset, length) in enumerate(zip(self._offsets, self._counts)):
            expected = min(rows, self.height - index * rows) * self._row_bytes
            require(length == expected, 'Uncompressed TIFF strip byte count differs from its complete native rows.')
            require(offset >= 8 and offset + length <= self._size, 'TIFF pixel strip is truncated or points outside the file.')
            require(not any(offset < end and offset + length > start for start, end in self._metadata_ranges),
                    'TIFF pixel data overlap required metadata.')
            ranges.append((offset, offset + length))
        ordered = sorted(ranges)
        require(all(left[1] <= right[0] for left, right in zip(ordered, ordered[1:])),
                'TIFF pixel strips overlap; source rows are ambiguous.')
        self.metadata = {'width': self.width, 'height': self.height, 'channels': self.channels,
                         'dtype': 'uint8', 'compression': 'none', 'rows_per_strip': rows,
                         'strip_count': strip_count, 'source_bytes': self._size,
                         'coordinate_system': 'original image pixels', 'resampled': False,
                         'calibration_verified': False, 'whole_image_allocated': False}

    def read_window(self, x, y, width, height):
        """Return exact row-major pixels for [x,x+width) × [y,y+height)."""
        self._check_stable()
        require(all(type(v) is int for v in (x, y, width, height)), 'Window coordinates and dimensions must be integers.')
        require(x >= 0 and y >= 0 and width > 0 and height > 0
                and x + width <= self.width and y + height <= self.height,
                'Window lies outside the original image.')
        row_bytes = width * self.channels
        require(row_bytes * height <= MAX_WINDOW_BYTES, 'Requested window exceeds the 64 MiB allocation limit.')
        output = bytearray(row_bytes * height)
        for row in range(height):
            source_y = y + row
            strip, local_row = divmod(source_y, self._rows_per_strip)
            offset = self._offsets[strip] + local_row * self._row_bytes + x * self.channels
            output[row * row_bytes:(row + 1) * row_bytes] = self._read(offset, row_bytes)
        self._check_stable()
        return bytes(output)

    def close(self):
        if self._handle is not None:
            self._handle.close()
            self._handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def write_tiff(path, width, height, pixels, channels=3):
    """Write a small exact tile/label TIFF, exclusively, without inventing scale."""
    require(type(width) is int and type(height) is int and 0 < width <= MAX_AXIS and 0 < height <= MAX_AXIS,
            'Output TIFF dimensions must be positive native-coordinate integers.')
    require(type(channels) is int and channels in (1, 3), 'Output channels must be one or three.')
    require(isinstance(pixels, (bytes, bytearray, memoryview)), 'Output pixels must be an explicit byte buffer.')
    data = memoryview(pixels)
    require(data.contiguous and data.itemsize == 1, 'Output pixels require a contiguous byte buffer.')
    data = data.cast('B')
    size = width * height * channels
    require(data.nbytes == size and size <= MAX_WINDOW_BYTES, 'Output pixel length differs from dimensions or exceeds 64 MiB.')
    # One strip, classic little-endian TIFF. Resolution tags are intentionally absent.
    tags = [(256, 4, 1, width), (257, 4, 1, height), (258, 3, channels, 8),
            (259, 3, 1, 1), (262, 3, 1, 1 if channels == 1 else 2),
            (273, 4, 1, 0), (274, 3, 1, 1), (277, 3, 1, channels),
            (278, 4, 1, height), (279, 4, 1, size), (284, 3, 1, 1), (339, 3, 1, 1)]
    extra_offset = 8 + 2 + 12 * len(tags) + 4
    extra = struct.pack('<HHH', 8, 8, 8) if channels == 3 else b''
    pixel_offset = extra_offset + len(extra)
    header = bytearray(struct.pack('<2sHIH', b'II', 42, 8, len(tags)))
    for tag, kind, count, value in tags:
        if tag == 273:
            value = pixel_offset
        if tag == 258 and channels == 3:
            field = struct.pack('<I', extra_offset)
        else:
            field = struct.pack('<H', value) + b'\0\0' if kind == 3 else struct.pack('<I', value)
        header.extend(struct.pack('<HHI', tag, kind, count) + field)
    header.extend(b'\0\0\0\0' + extra)
    target = Path(path)
    created = False
    try:
        with target.open('xb') as handle:
            created = True
            handle.write(header)
            handle.write(data)
    except BaseException:
        if created:
            target.unlink(missing_ok=True)
        raise
    return {'path': str(target), 'width': width, 'height': height, 'channels': channels,
            'dtype': 'uint8', 'source_pixels_changed': False, 'calibration_written': False}
