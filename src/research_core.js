/* Research import primitives. Original coordinates and raw CSV strings are retained.
 * ImageJ format reference: ij/io/RoiDecoder.java (ImageJ), big-endian ROI format.
 * Imported outlines are observations supplied by the researcher, not anatomical validation.
 */
(function (root) {
  'use strict';
  const SCHEMA = 'cerebellum-research/1', BINARY_SCHEMA = 'cerebellum-research/2';
  const LIMITS = Object.freeze({fileBytes: 256 * 1024 * 1024, projectBytes: 192 * 1024 * 1024, binaryProjectBytes: 512 * 1024 * 1024, binaryFiles: 4998, jsonBytes: 320 * 1024 * 1024, roiBytes: 16 * 1024 * 1024,
    csvBytes: 16 * 1024 * 1024, sections: 100, rois: 20000, coordinates: 2000000,
    csvRows: 100000, csvColumns: 512, coordinateMagnitude: 1e7});
  const fail = message => { throw new Error(message); };
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const coordinate = n => finite(n) && Math.abs(n) <= LIMITS.coordinateMagnitude;
  function bytesOf(input) {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return fail('Expected an ArrayBuffer or typed array.');
  }
  async function sha256(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : bytesOf(input);
    if (!root.crypto || !root.crypto.subtle) fail('SHA-256 requires a secure browser context.');
    const result = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('');
  }

  function parseROI(input, sourceName = 'untitled.roi') {
    const bytes = bytesOf(input);
    if (bytes.byteLength < 64 || bytes.byteLength > LIMITS.roiBytes) fail('Invalid ROI byte length (64 bytes–16 MiB required).');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ensure = (offset, length) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length)
        fail('Truncated or invalid ImageJ ROI data.');
    };
    const u16 = o => { ensure(o, 2); return view.getUint16(o, false); };
    // ImageJ interprets short coordinates below -5000 as unsigned values.
    const ijShort = o => { ensure(o, 2); const n = view.getInt16(o, false); return n < -5000 ? n + 65536 : n; };
    const i32 = o => { ensure(o, 4); return view.getInt32(o, false); };
    const f32 = o => { ensure(o, 4); const n = view.getFloat32(o, false); if (!coordinate(n)) fail('ROI contains non-finite or out-of-range coordinates.'); return n; };
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'Iout') fail('Not an ImageJ .roi file (missing Iout signature).');
    if (typeof sourceName !== 'string' || sourceName.length > 1024) fail('Invalid ROI source name.');
    const version = u16(4), code = bytes[6], subtype = u16(48), options = u16(50);
    const names = {0: 'polygon', 1: 'rectangle', 2: 'oval', 3: 'line', 4: 'freeline', 5: 'polyline', 7: 'freehand', 8: 'traced', 9: 'angle', 10: 'point'};
    if (!(code in names)) fail('Unsupported ImageJ ROI type: ' + code + '. Original file was not interpreted.');
    if (subtype !== 0) fail('Unsupported ImageJ ROI subtype: ' + subtype + ' (text, arrow, image, rotated rectangle or ellipse).');
    // ImageJ reconstructs a spline from these stored control points. Connecting
    // them with straight segments would change the observed outline and length.
    if (version >= 218 && (options & 1) && [0,4,5,7,8,9,10].includes(code))
      fail('Spline-fit ImageJ ROI is not supported; its control points have not been substituted for the fitted outline.');
    const left = ijShort(10), top = ijShort(8), right = ijShort(14), bottom = ijShort(12);
    const subpixel = version >= 222 && (options & 128) !== 0;
    const metadata = {format: 'ImageJ ROI', version, type_code: code, subtype, options,
      coordinate_system: 'original image pixels', position: i32(56), subpixel,
      bounds: {x: left, y: top, width: right - left, height: bottom - top}};
    let name = sourceName.replace(/\.roi$/i, ''), paths = [], kind = 'area', closed = true;
    const warnings = [];
    const h2 = i32(60);
    if (h2 < 0) fail('Invalid ImageJ secondary header offset.');
    if (h2 > 0) {
      ensure(h2, 36);
      metadata.channel = i32(h2 + 4); metadata.slice = i32(h2 + 8); metadata.frame = i32(h2 + 12);
      const offset = i32(h2 + 16), length = i32(h2 + 20);
      if (length < 0 || length > 4096 || offset < 0) fail('Invalid ImageJ ROI name.');
      if (length) {
        ensure(offset, length * 2);
        name = ''; for (let i = 0; i < length; i++) name += String.fromCharCode(u16(offset + i * 2));
      }
    }
    const shapeSize = i32(36);
    if (shapeSize < 0) fail('Invalid composite ROI size.');
    if (shapeSize > 0) {
      if (code !== 1 || shapeSize > LIMITS.coordinates * 3) fail('Invalid composite ROI type or size.');
      ensure(64, shapeSize * 4);
      let path = null;
      for (let i = 0; i < shapeSize;) {
        const command = f32(64 + i++ * 4);
        if (command === 0 || command === 1) {
          if (i + 2 > shapeSize) fail('Truncated composite ROI path.');
          const point = [f32(64 + i++ * 4), f32(64 + i++ * 4)];
          if (command === 0) {
            if (path) fail('Composite ROI contains an unclosed contour.');
            path = [point];
          } else {
            if (!path) fail('Composite ROI path has no starting point.');
            path.push(point);
          }
        } else if (command === 4) {
          if (!path || path.length < 3) fail('Composite ROI contour needs at least three vertices.');
          paths.push(path); path = null;
        } else if (command === 2 || command === 3) {
          fail('Composite ROI with quadratic/cubic curves is not supported; original file has not been approximated.');
        } else fail('Unsupported composite ROI path command: ' + command);
      }
      if (path || !paths.length) fail('Composite ROI contains unclosed or empty contours.');
      metadata.composite = true;
      metadata.fill_rule = 'evenodd';
      warnings.push('Composite contours and holes retain their original coordinates. Area measurement requires validated contour topology.');
    } else if (code === 1 || code === 2) {
      let x = left, y = top, width = right - left, height = bottom - top;
      if (subpixel && version >= 223) { x = f32(18); y = f32(22); width = f32(26); height = f32(30); }
      if (!(width > 0 && height > 0) || !coordinate(x + width) || !coordinate(y + height)) fail('ROI rectangle/oval bounds are empty or invalid.');
      metadata.bounds = {x, y, width, height};
      if (code === 1) {
        if (u16(54) > 0) fail('Rounded rectangle ROI is not supported; original file has not been approximated.');
        paths = [[[x,y], [x+width,y], [x+width,y+height], [x,y+height]]];
      } else {
        paths = [Array.from({length: 128}, (_, i) => { const a = i * 2 * Math.PI / 128; return [x + width / 2 * (1 + Math.cos(a)), y + height / 2 * (1 + Math.sin(a))]; })];
        metadata.outline_approximation = '128-point ellipse; original bounds retained';
        warnings.push('Oval display uses a 128-point outline; area uses the exact ellipse bounds.');
      }
    } else if (code === 3) {
      paths = [[[f32(18), f32(22)], [f32(26), f32(30)]]]; kind = 'polyline'; closed = false;
    } else {
      let n = u16(16); if (n === 0) n = i32(18);
      if (!Number.isSafeInteger(n) || n < 1 || n > LIMITS.coordinates) fail('Invalid ROI coordinate count.');
      ensure(64, n * (subpixel ? 12 : 4));
      const path = [];
      for (let i = 0; i < n; i++) {
        if (subpixel) path.push([f32(64 + 4 * n + 4 * i), f32(64 + 8 * n + 4 * i)]);
        else {
          const dx = ijShort(64 + 2 * i), dy = ijShort(64 + 2 * n + 2 * i);
          if (dx < 0 || dy < 0) fail('Negative relative ROI coordinates would be clamped by ImageJ; explicit correction is required.');
          path.push([left + dx, top + dy]);
        }
      }
      paths = [path];
      if ([4,5,9].includes(code)) { kind = 'polyline'; closed = false; }
      if (code === 10) { kind = 'point'; closed = false; }
      if (path.length < (kind === 'area' ? 3 : kind === 'polyline' ? 2 : 1)) fail('ROI has insufficient coordinates for its type.');
    }
    const roi = {name, source_name: sourceName, source_file: sourceName, type: metadata.composite ? 'composite' : names[code], kind, closed, paths, metadata, warnings};
    validateROI(roi, {coordinates: 0});
    return roi;
  }

  function parseCSV(text) {
    if (typeof text !== 'string' || text.length > LIMITS.csvBytes || new TextEncoder().encode(text).length > LIMITS.csvBytes) fail('CSV exceeds the 16 MiB import limit.');
    text = text.replace(/^\uFEFF/, '');
    // Delimiter inference counts separators only outside quoted fields in the first record.
    let quoted = false; const counts = {',': 0, '\t': 0, ';': 0};
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { if (quoted && text[i+1] === '"') i++; else quoted = !quoted; }
      else if (!quoted && (c === '\n' || c === '\r')) break;
      else if (!quoted && c in counts) counts[c]++;
    }
    const delimiter = Object.keys(counts).sort((a,b) => counts[b] - counts[a])[0];
    const records = []; let row = [], cell = '', inQuote = false, afterQuote = false, started = false;
    const pushCell = () => { row.push(cell); cell = ''; afterQuote = false; if (row.length > LIMITS.csvColumns) fail('CSV exceeds 512 columns.'); };
    const pushRow = () => { pushCell(); records.push(row); row = []; started = false; if (records.length > LIMITS.csvRows + 1) fail('CSV exceeds 100,000 data rows.'); };
    for (let i = 0; i < text.length; i++) {
      const c = text[i]; started = true;
      if (inQuote) {
        if (c === '"') { if (text[i+1] === '"') {cell += '"'; i++;} else {inQuote = false; afterQuote = true;} }
        else cell += c;
      } else if (c === delimiter) pushCell();
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i+1] === '\n') i++; pushRow(); }
      else if (c === '"') { if (cell || afterQuote) fail('Malformed CSV: quote inside unquoted field.'); inQuote = true; }
      else { if (afterQuote) fail('Malformed CSV: unexpected text after closing quote.'); cell += c; }
    }
    if (inQuote) fail('Malformed CSV: unterminated quoted field.');
    if (started || row.length || cell || afterQuote) pushRow();
    const headers = records.shift() || [], warnings = [];
    if (new Set(headers).size !== headers.length || headers.some(h => !h.trim())) warnings.push('Empty or duplicate headers are preserved by column position.');
    if (records.some(r => r.length !== headers.length)) warnings.push('Rows have differing column counts; original cells are preserved without padding.');
    if (records.some(r => r.some(c => /^\s*[=+@]/.test(c)))) warnings.push('Formula-like strings are retained as plain text and are never executed.');
    return {headers, rows: records, delimiter, row_count: records.length, warnings};
  }

  function numericCell(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    // Deliberately exclude formula syntax, hexadecimal and locale guesses.
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
    const n = Number(value); return Number.isFinite(n) ? n : null;
  }

  function validateROI(roi, counter) {
    if (!roi || !['area','polyline','point'].includes(roi.kind) || typeof roi.closed !== 'boolean' || roi.closed !== (roi.kind === 'area')) fail('Invalid ROI kind/closed state.');
    string(roi.name, 'ROI name', 4096); string(roi.type, 'ROI type', 128);
    if (!Array.isArray(roi.paths) || !roi.paths.length || roi.paths.length > LIMITS.coordinates) fail('Invalid ROI paths.');
    for (const path of roi.paths) {
      if (!Array.isArray(path) || path.length < (roi.kind === 'area' ? 3 : roi.kind === 'polyline' ? 2 : 1)) fail('ROI path has too few points.');
      counter.coordinates += path.length;
      if (counter.coordinates > LIMITS.coordinates) fail('Study exceeds two million ROI coordinates.');
      for (const point of path) if (!Array.isArray(point) || point.length !== 2 || !point.every(coordinate)) fail('Invalid ROI coordinate.');
    }
  }
  function string(value, label, max = 1024, required = false) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('Invalid ' + label + '.');
  }
  function hash(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) fail('Invalid SHA-256 fingerprint.'); }
  function base64Length(value) {
    if (typeof value !== 'string' || value.length > Math.ceil(LIMITS.fileBytes / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) fail('Invalid or oversized base64 source.');
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    if (value.slice(0, value.length - padding).includes('=')) fail('Invalid base64 padding.');
    return value.length / 4 * 3 - padding;
  }
  function assertJSON(value, depth = 0, state = {strings: 0, nodes: 0, seen: new Set()}) {
    if (++state.nodes > 10000000 || depth > 32) fail('Research bundle is too deeply nested or complex.');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Research bundle contains non-finite numbers.'); return; }
    if (typeof value === 'string') { state.strings += value.length; if (state.strings > LIMITS.jsonBytes) fail('Research bundle strings exceed the size limit.'); return; }
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail('Research bundle must contain JSON data only.');
    if (state.seen.has(value)) fail('Research bundle contains circular references.');
    state.seen.add(value);
    for (const key of Object.keys(value)) {
      if (['__proto__','prototype','constructor'].includes(key)) fail('Unsafe object key in research bundle.');
      assertJSON(value[key], depth + 1, state);
    }
    state.seen.delete(value);
  }
  function date(value) { string(value, 'timestamp', 64, true); if (!Number.isFinite(Date.parse(value))) fail('Invalid timestamp.'); }
  function validateBundle(bundle) {
    assertJSON(bundle);
    if (!bundle || ![SCHEMA, BINARY_SCHEMA].includes(bundle.schema)) fail('Unsupported research bundle schema.');
    const binary = bundle.schema === BINARY_SCHEMA;
    string(bundle.id, 'study ID', 128, true); string(bundle.title, 'study title', 256, true); date(bundle.created_at);
    const cal = bundle.calibration;
    if (!cal || !['px','um'].includes(cal.xy_unit) || !['index','um'].includes(cal.z_unit)) fail('Invalid coordinate calibration units.');
    if (cal.um_per_pixel !== null && (!finite(cal.um_per_pixel) || cal.um_per_pixel <= 0)) fail('XY calibration must be null or a positive finite µm/pixel value.');
    if (cal.xy_unit === 'um' && cal.um_per_pixel === null) fail('Physical XY units require a µm/pixel calibration.');
    if (!Array.isArray(bundle.sections) || bundle.sections.length > LIMITS.sections) fail('Study exceeds 100 sections or has invalid sections.');
    const ids = new Set(), orders = new Set(), counter = {coordinates: 0}; let rawBytes = 0, roiCount = 0, fileCount = 0;
    for (const section of bundle.sections) {
      if (!section || typeof section !== 'object') fail('Invalid study section.');
      string(section.id, 'section ID', 128, true); string(section.label, 'section label', 256, true);
      if (ids.has(section.id)) fail('Duplicate section ID: ' + section.id); ids.add(section.id);
      if (!Number.isSafeInteger(section.order) || section.order < 0 || orders.has(section.order)) fail('Section orders must be unique nonnegative integers.'); orders.add(section.order);
      if (section.z !== null && !coordinate(section.z)) fail('Invalid section depth.');
      if (cal.z_unit === 'um' && section.z === null) fail('Physical Z units require an explicit depth for every section.');
      if (typeof section.included !== 'boolean') fail('Section inclusion must be explicit.');
      string(section.exclusion_reason, 'exclusion reason', 4096);
      if (!section.included && !section.exclusion_reason.trim()) fail('Excluded sections require an exclusion reason.');
      if (!Array.isArray(section.files)) fail('Section original files are missing.');
      const files = new Map();
      for (const file of section.files) {
        if (!file) fail('Invalid original file.');
        if (binary && ++fileCount > LIMITS.binaryFiles) fail('Binary projects support up to 4998 original files; group ImageJ ROIs in ROI ZIPs or split the project.');
        string(file.name, 'original filename', 1024, true); hash(file.sha256);
        if (files.has(file.name)) fail('Duplicate original filename in a section: ' + file.name);
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes) fail('Invalid original file size.');
        if (binary) {
          if (file.original_ref !== 'originals/' + file.sha256.toLowerCase() || file.base64 !== undefined) fail('Original file reference must identify its SHA-256 binary payload.');
        } else if (base64Length(file.base64) !== file.size) fail('Original file size does not match its base64 payload.');
        rawBytes += file.size; if (rawBytes > (binary ? LIMITS.binaryProjectBytes : LIMITS.projectBytes)) fail(binary ? 'Original files exceed the 512 MiB binary project limit.' : 'Original files exceed the 192 MiB study limit.');
        files.set(file.name, file);
      }
      if (section.image !== null) {
        const im = section.image;
        if (!im) fail('Invalid image metadata.');
        string(im.name, 'image filename', 1024, true); hash(im.sha256);
        if (!Number.isSafeInteger(im.width) || !Number.isSafeInteger(im.height) || im.width <= 0 || im.height <= 0 || im.width * im.height > 200000000) fail('Invalid or oversized image dimensions.');
        if (!files.has(im.name) || files.get(im.name).sha256 !== im.sha256) fail('Image fingerprint must reference an original file.');
        if (im.preview !== undefined) {
          if (typeof im.preview !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(im.preview)) fail('Only PNG/JPEG data previews are allowed.');
          base64Length(im.preview.slice(im.preview.indexOf(',') + 1));
        }
      }
      if (!Array.isArray(section.rois)) fail('Invalid ROI list.');
      roiCount += section.rois.length; if (roiCount > LIMITS.rois) fail('Study exceeds 20,000 ROIs.');
      for (const roi of section.rois) validateROI(roi, counter);
      if (section.csv !== null) {
        const csv = section.csv;
        if (!csv || !Array.isArray(csv.headers) || !Array.isArray(csv.rows) || csv.headers.length > LIMITS.csvColumns || csv.rows.length > LIMITS.csvRows || csv.row_count !== csv.rows.length || ![',',';','\t'].includes(csv.delimiter)) fail('Invalid raw CSV structure.');
        for (const row of [csv.headers, ...csv.rows]) {
          if (!Array.isArray(row) || row.length > LIMITS.csvColumns || row.some(cell => typeof cell !== 'string')) fail('CSV cells must remain raw strings, including missing values.');
        }
      }
    }
    if (!Array.isArray(bundle.reviews) || bundle.reviews.length > 10000) fail('Invalid review list.');
    const reviews = new Set();
    for (const review of bundle.reviews) {
      if (!review) fail('Invalid review.');
      string(review.id, 'review ID', 128, true); if (reviews.has(review.id)) fail('Duplicate review ID.'); reviews.add(review.id);
      if (review.project_id !== bundle.id || (review.section_id !== null && !ids.has(review.section_id))) fail('Review references a different study or missing section.');
      string(review.reviewer, 'reviewer', 256, true); string(review.text, 'review text', 20000, true); date(review.created_at); hash(review.project_fingerprint);
    }
    return bundle;
  }

  function measureROI(roi, umPerPixel = null) {
    validateROI(roi, {coordinates: 0});
    if (umPerPixel !== null && (!finite(umPerPixel) || umPerPixel <= 0)) fail('Measurement calibration must be positive or null.');
    const warnings = []; let area = null, length = null;
    if (roi.kind !== 'point') {
      length = 0;
      for (const path of roi.paths) for (let i = 0; i < path.length - (roi.closed ? 0 : 1); i++) {
        const a = path[i], b = path[(i+1) % path.length]; length += Math.hypot(b[0]-a[0], b[1]-a[1]);
      }
    }
    // Exact simple bounds are usable; arbitrary imported contours may self-intersect.
    if (roi.type === 'rectangle' || roi.type === 'oval') {
      const b = roi.metadata && roi.metadata.bounds;
      if (b && finite(b.width) && finite(b.height) && b.width > 0 && b.height > 0) area = b.width * b.height * (roi.type === 'oval' ? Math.PI/4 : 1);
      if (roi.type === 'oval') warnings.push('Oval perimeter is measured on the sampled display outline.');
    } else if (roi.kind === 'area') warnings.push('Area is not inferred for arbitrary imported contours; topology and anatomical labels require review.');
    if (roi.kind === 'area') warnings.push('Boundary length is not Purkinje-layer length or cortical thickness.');
    const areaUm = area !== null && umPerPixel !== null ? area * umPerPixel * umPerPixel : null;
    const lengthUm = length !== null && umPerPixel !== null ? length * umPerPixel : null;
    for (const [raw, converted] of [[area, area], [length, length], [area, areaUm], [length, lengthUm]])
      if (converted !== null && (!finite(converted) || (raw > 0 && converted === 0)))
        fail('Measurement or calibration exceeds the supported numeric range.');
    return {area_px2: area, length_px: length, area_um2: areaUm, length_um: lengthUm, warnings};
  }

  const api = Object.freeze({SCHEMA, BINARY_SCHEMA, LIMITS, parseROI, parseCSV, numericCell, sha256, validateBundle, measureROI});
  root.ResearchCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
