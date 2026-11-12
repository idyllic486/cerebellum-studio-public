'use strict';
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const ResearchZip = require('../src/research_zip.js');
async function archive(files, options = {}) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data, {createFolders: false});
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE', ...options});
}
function centralOffsets(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), result = [];
  for (let i = 0; i < bytes.length - 4; i++) if (v.getUint32(i, true) === 0x02014b50) result.push(i);
  return result;
}
(async () => {
  const payload = Uint8Array.from([73, 111, 117, 116, 0, 228, 1, 2]);
  const bytes = await archive({'nested/α.roi': payload, 'notes.csv': 'x,y\n1,2'});
  const result = await ResearchZip.read(bytes);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].name, 'nested/α.roi');
  assert.deepEqual(result.entries[0].bytes, payload);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.expandedBytes, payload.length + 7);
  await assert.rejects(ResearchZip.read(bytes, {remainingBytes: payload.length}), /budget/);
  await assert.rejects(ResearchZip.read(await archive({'notes.csv': 'x,y'})), /no ImageJ/);
  const badCRC = new Uint8Array(await archive({'a.roi': payload}));
  const badView = new DataView(badCRC.buffer), central = centralOffsets(badCRC)[0];
  badView.setUint32(central + 16, badView.getUint32(central + 16, true) ^ 1, true);
  await assert.rejects(ResearchZip.read(badCRC), /CRC32/);
  const duplicate = new Uint8Array(await archive({'a.roi': payload, 'b.roi': payload}));
  const dView = new DataView(duplicate.buffer), second = centralOffsets(duplicate)[1];
  duplicate[second + 46] = 97;
  duplicate[dView.getUint32(second + 42, true) + 30] = 97;
  await assert.rejects(ResearchZip.read(duplicate), /duplicate/);
  await assert.rejects(ResearchZip.read(await archive({'../a.roi': payload})), /unsafe/);
  await assert.rejects(ResearchZip.read(await archive({'a\\b.roi': payload})), /unsafe/);
  await assert.rejects(ResearchZip.read(await archive({'é.roi': payload, 'e\u0301.roi': payload})), /duplicate/);
  const mismatch = new Uint8Array(await archive({'a.roi': payload}));
  mismatch[30] = 98;
  await assert.rejects(ResearchZip.read(mismatch), /local name/);
  const huge = new Uint8Array(await archive({'a.roi': payload}));
  new DataView(huge.buffer).setUint32(centralOffsets(huge)[0] + 24, 16 * 1024 * 1024 + 1, true);
  await assert.rejects(ResearchZip.read(huge), /16 MiB/);
  const countMismatch = new Uint8Array(await archive({'a.roi': payload}));
  const countView = new DataView(countMismatch.buffer), end = countMismatch.length - 22;
  countView.setUint16(end + 8, 2, true); countView.setUint16(end + 10, 2, true);
  await assert.rejects(ResearchZip.read(countMismatch), /ZIP/);
  const stored = await ResearchZip.read(await archive({'a.roi': payload}, {compression: 'STORE'}));
  assert.deepEqual(stored.entries[0].bytes, payload);
  const streaming = await ResearchZip.read(await archive({'a.roi': payload}, {streamFiles: true}));
  assert.deepEqual(streaming.entries[0].bytes, payload);
  const oversizedActual = new Uint8Array(await archive({'a.roi': new Uint8Array(100000)}));
  new DataView(oversizedActual.buffer).setUint32(centralOffsets(oversizedActual)[0] + 24, 1, true);
  await assert.rejects(ResearchZip.read(oversizedActual), /declared expanded size/);
  console.log('Research ZIP checks passed: real ZIP, UTF-8, ignored files, CRC, duplicate/path names, bounds, budget, STORE/DEFLATE, bounded streaming.');
})().catch(error => { console.error(error); process.exitCode = 1; });
