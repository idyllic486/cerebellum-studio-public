/* Bounded ImageJ ROI ZIP reader. Original ZIP bytes remain in the project. */
(function (root) {
  'use strict';
  const MAX_TOTAL = 64 * 1024 * 1024, MAX_ENTRY = 16 * 1024 * 1024, MAX_ENTRIES = 2000;
  const fail = message => { throw new Error(message); };
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    table[i] = c >>> 0;
  }
  function crcUpdate(crc, bytes) { for (const b of bytes) crc = (crc >>> 8) ^ table[(crc ^ b) & 255]; return crc >>> 0; }
  const crc32 = bytes => (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
  function asBytes(input) {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return fail('ZIP input must be an ArrayBuffer or typed array.');
  }
  function utf8(bytes) {
    try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
    catch (_) { return fail('ZIP entry names must use UTF-8; legacy encodings are unsupported.'); }
  }
  function inspect(bytes, budget) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const inside = (o, n) => { if (!Number.isSafeInteger(o) || o < 0 || o + n > bytes.length) fail('Truncated ZIP structure.'); };
    const u16 = o => { inside(o, 2); return v.getUint16(o, true); };
    const u32 = o => { inside(o, 4); return v.getUint32(o, true); };
    let end = -1;
    for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 65557); o--) {
      if (u32(o) === 0x06054b50 && o + 22 + u16(o + 20) === bytes.length) { end = o; break; }
    }
    if (end < 0) fail('ZIP end record is missing or malformed.');
    const count = u16(end + 10), centralSize = u32(end + 12), centralStart = u32(end + 16);
    if (count === 65535 || centralSize === 0xffffffff || centralStart === 0xffffffff ||
        (end >= 20 && u32(end - 20) === 0x07064b50)) fail('ZIP64 archives are unsupported.');
    if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count) fail('Multi-disk ZIP archives are unsupported.');
    if (count > MAX_ENTRIES) fail('ZIP exceeds 2000 entries.');
    if (centralStart + centralSize !== end) fail('ZIP central directory bounds are inconsistent.');
    const records = [], names = new Set(), ranges = [];
    let offset = centralStart, expandedBytes = 0;
    for (let i = 0; i < count; i++) {
      inside(offset, 46);
      if (u32(offset) !== 0x02014b50) fail('ZIP central directory entry is invalid.');
      const flags = u16(offset + 8), method = u16(offset + 10), crc = u32(offset + 16);
      const compressed = u32(offset + 20), expanded = u32(offset + 24), nameLength = u16(offset + 28);
      const extraLength = u16(offset + 30), commentLength = u16(offset + 32), local = u32(offset + 42);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > end) fail('ZIP central directory entry overruns its bounds.');
      if (u16(offset + 34)) fail('Multi-disk ZIP entries are unsupported.');
      if ([compressed, expanded, local].includes(0xffffffff)) fail('ZIP64 entries are unsupported.');
      if (flags & (1 | 64)) fail('Encrypted ZIP entries are unsupported.');
      if (expanded > MAX_ENTRY) fail('ZIP entry exceeds 16 MiB expanded size.');
      expandedBytes += expanded;
      if (expandedBytes > budget) fail('ZIP exceeds the remaining 64 MiB expanded-data budget.');
      const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
      let name = utf8(rawName), extra = offset + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra < extraEnd) {
        if (extra + 4 > extraEnd) fail('Malformed ZIP extra field.');
        const type = u16(extra), length = u16(extra + 2), start = extra + 4;
        if (start + length > extraEnd) fail('Malformed ZIP extra field length.');
        if (type === 1) fail('ZIP64 extra fields are unsupported.');
        if (!(flags & 2048) && type === 0x7075 && length >= 5 && bytes[start] === 1 && u32(start + 1) === crc32(rawName))
          name = utf8(bytes.subarray(start + 5, start + length));
        extra = start + length;
      }
      const directory = name.endsWith('/');
      const parts = (directory ? name.slice(0, -1) : name).split('/');
      if (!name || name.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(name) || /^[A-Za-z]:/.test(name) ||
          parts.some(part => !part || part === '.' || part === '..')) fail('ZIP contains an unsafe or ambiguous entry name.');
      const normalized = name.normalize('NFC');
      if (names.has(normalized)) fail('ZIP contains duplicate entry names.');
      names.add(normalized);
      inside(local, 30);
      if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method)
        fail('ZIP local and central headers disagree.');
      const localNameLength = u16(local + 26), localExtraLength = u16(local + 28);
      const dataStart = local + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressed;
      if (dataEnd > centralStart || localNameLength !== nameLength ||
          rawName.some((b, j) => bytes[local + 30 + j] !== b)) fail('ZIP local name or data bounds disagree.');
      ranges.push([local, dataEnd]);
      if (directory && expanded) fail('ZIP directory contains unexpected file data.');
      records.push({name, directory, expanded, crc, method});
      offset = next;
    }
    if (offset !== end) fail('ZIP entry count does not match the central directory.');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('ZIP entries overlap.');
    return {records, expandedBytes};
  }
  function extract(entry, record) {
    return new Promise((resolve, reject) => {
      let length = 0, crc = 0xffffffff, stopped = false;
      const chunks = [], stream = entry.internalStream('uint8array');
      const stop = error => { if (!stopped) { stopped = true; stream.pause(); chunks.length = 0; reject(error); } };
      stream.on('data', chunk => {
        if (stopped) return;
        length += chunk.length;
        if (length > record.expanded || length > MAX_ENTRY) return stop(new Error('ZIP entry exceeds its declared expanded size.'));
        crc = crcUpdate(crc, chunk); chunks.push(chunk);
      }).on('error', stop).on('end', () => {
        if (stopped) return;
        if (length !== record.expanded || ((crc ^ 0xffffffff) >>> 0) !== record.crc)
          return stop(new Error('ZIP ROI size or CRC32 verification failed: ' + record.name));
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        stopped = true; resolve({name: record.name, bytes});
      }).resume();
    });
  }
  async function read(input, options = {}) {
    const bytes = asBytes(input), remaining = options.remainingBytes === undefined ? MAX_TOTAL : options.remainingBytes;
    if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > MAX_TOTAL) fail('Invalid remaining ZIP data budget.');
    if (bytes.length > MAX_TOTAL) fail('ZIP source exceeds 64 MiB.');
    const {records, expandedBytes} = inspect(bytes, remaining);
    const roiRecords = records.filter(r => !r.directory && /\.roi$/i.test(r.name));
    if (!roiRecords.length) fail('ZIP contains no ImageJ .roi files.');
    for (const record of roiRecords) if (![0, 8].includes(record.method)) fail('Unsupported ROI ZIP compression method.');
    const JSZip = root.JSZip || (typeof require === 'function' ? require('jszip') : null);
    if (!JSZip) fail('JSZip is unavailable.');
    const zip = await JSZip.loadAsync(bytes, {createFolders: false, checkCRC32: false});
    if (Object.keys(zip.files).length !== records.length) fail('ZIP loader changed the entry count; duplicate or sanitized names are unsupported.');
    for (const record of records) {
      const entry = zip.files[record.name];
      if (!entry || entry.dir !== record.directory || (entry.unsafeOriginalName && entry.unsafeOriginalName !== record.name))
        fail('ZIP loader changed an entry name or type.');
    }
    const entries = [];
    for (const record of roiRecords) entries.push(await extract(zip.files[record.name], record));
    const ignored = records.filter(r => !r.directory && !/\.roi$/i.test(r.name)).length;
    return {entries, expandedBytes, warnings: ignored ? [ignored + ' non-ROI ZIP file(s) were not interpreted; the original ZIP is preserved.'] : []};
  }
  const api = Object.freeze({read});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ResearchZip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
