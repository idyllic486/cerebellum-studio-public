/* Synthetic import fixtures; no existing animal/source data are changed. */
const assert = require('node:assert/strict');
const C = require('../src/research_core.js');

function header(type, bytes = 64) {
  const b = new ArrayBuffer(bytes), v = new DataView(b);
  new Uint8Array(b).set([73,111,117,116]); v.setUint16(4, 228); v.setUint8(6, type);
  v.setInt16(8, 20); v.setInt16(10, 10); v.setInt16(12, 40); v.setInt16(14, 30);
  return {b, v};
}
function polygon(points, type = 0, subpixel = false) {
  const {b,v} = header(type, 64 + points.length * (subpixel ? 12 : 4));
  v.setUint16(16, points.length); if (subpixel) v.setUint16(50, 128);
  points.forEach(([x,y], i) => {
    v.setUint16(64 + 2 * i, Math.max(0, x - 10)); v.setUint16(64 + 2 * points.length + 2 * i, Math.max(0, y - 20));
    if (subpixel) {v.setFloat32(64 + points.length * 4 + i * 4, x); v.setFloat32(64 + points.length * 8 + i * 4, y);}
  });
  return b;
}
function shape(paths) {
  const commands = paths.flatMap(path => [0, ...path[0], ...path.slice(1).flatMap(p => [1,...p]), 4]);
  const {b,v} = header(1, 64 + commands.length * 4);
  v.setInt32(36, commands.length); commands.forEach((n,i) => v.setFloat32(64 + i * 4, n)); return b;
}
function minimalBundle(roi) {
  return {schema: C.SCHEMA, id:'study-1', title:'Synthetic study', created_at:'2026-11-02T00:00:00Z',
    calibration:{xy_unit:'px', um_per_pixel:null, z_unit:'index'}, reviews:[],
    sections:[{id:'s1', label:'Section 1', order:0, z:null, included:true, exclusion_reason:'', image:null, rois:[roi], csv:null, files:[]}]};
}

(async () => {
  const points = [[10,20],[30,20],[30,40],[10,40]];
  for (const type of [0,7,8]) {
    const roi = C.parseROI(polygon(points,type),'source.roi');
    assert.deepEqual(roi.paths, [points]); assert.equal(roi.kind,'area'); assert.equal(roi.source_file,'source.roi');
  }
  for (const type of [4,5,9]) assert.equal(C.parseROI(polygon(points,type)).kind,'polyline');
  assert.equal(C.parseROI(polygon([[10,20]],10)).kind,'point');
  const fraction = [[10.5,20.25],[30.75,20.25],[30.75,40.5]];
  assert.deepEqual(C.parseROI(polygon(fraction,0,true)).paths,[fraction]);
  const spline = polygon(points); new DataView(spline).setUint16(50,1);
  assert.throws(() => C.parseROI(spline), /Spline-fit/);
  const padded = new Uint8Array(polygon(points).byteLength + 16);
  padded.set(new Uint8Array(polygon(points)), 8);
  assert.deepEqual(C.parseROI(padded.subarray(8, padded.length - 8)).paths,[points]);
  const {b:line,v:lv} = header(3);
  [0,0,3,4].forEach((n,i) => lv.setFloat32(18+i*4,n));
  assert.equal(C.measureROI(C.parseROI(line),2).length_um,10);
  const rect = C.parseROI(header(1).b);
  assert.equal(C.measureROI(rect).area_px2,400);
  assert.equal(C.measureROI(rect).area_um2,null);
  assert.equal(C.measureROI(rect,0.5).area_um2,100);
  assert.throws(() => C.measureROI(rect,1e308), /numeric range/);
  assert.throws(() => C.measureROI(rect,1e-300), /numeric range/);
  const oval = C.parseROI(header(2).b);
  assert.equal(oval.paths[0].length,128);
  assert.equal(C.measureROI(oval).area_px2,100*Math.PI);
  assert.ok(oval.warnings.length);
  const hole = [[15,25],[25,25],[25,35],[15,35]];
  const composite = C.parseROI(shape([points,hole]),'with-hole.roi');
  assert.deepEqual(composite.paths,[points,hole]);
  assert.equal(composite.type,'composite', 'ImageJ rectangle type code must not turn a composite into a rectangle measurement');
  assert.equal(composite.metadata.fill_rule,'evenodd');
  assert.equal(C.measureROI(composite).area_px2,null, 'No ambiguous filled area claim for unvalidated contours');
  const curved = shape([points]); new DataView(curved).setFloat32(64 + 3 * 4,2);
  assert.throws(() => C.parseROI(curved), /curves is not supported/);
  const subtype = header(1); subtype.v.setUint16(48,4);
  assert.throws(() => C.parseROI(subtype.b), /Unsupported ImageJ ROI subtype/);
  assert.throws(() => C.parseROI(header(6).b), /Unsupported ImageJ ROI type/);
  assert.throws(() => C.parseROI(polygon(points).slice(0,66)), /Truncated/);
  const bad = polygon(fraction,0,true); new DataView(bad).setFloat32(64+fraction.length*4,NaN);
  assert.throws(() => C.parseROI(bad), /non-finite/);
  const rounded = header(1); rounded.v.setUint16(54,4);
  assert.throws(() => C.parseROI(rounded.b), /Rounded rectangle/);

  const csv = C.parseCSV('\uFEFFsection,area,pl,notes\r\n1,0,,"a,b"\r\n2,,0,"line 1\nline ""2"""\r\n3,=1+1,,plain\r\n');
  assert.deepEqual(csv.headers,['section','area','pl','notes']);
  assert.equal(csv.row_count,3); assert.equal(csv.rows[0][1],'0'); assert.equal(csv.rows[0][2],'');
  assert.equal(csv.rows[1][3],'line 1\nline "2"'); assert.equal(csv.rows[2][1],'=1+1');
  assert.equal(C.numericCell(csv.rows[0][1]),0); assert.equal(C.numericCell(csv.rows[0][2]),null);
  assert.equal(C.numericCell('=1+1'),null); assert.equal(C.numericCell('0xFF'),null); assert.equal(C.numericCell('1e3'),1000);
  assert.equal(C.parseCSV('a\tb\n1\t2\n').delimiter,'\t');
  assert.equal(C.parseCSV('a;b\n1;2\n').delimiter,';');
  assert.deepEqual(C.parseCSV('a,b\n1,\n\n').rows,[['1',''],['']]);
  assert.throws(() => C.parseCSV('a,b\n"unterminated'), /unterminated/);
  assert.throws(() => C.parseCSV('a,b\n"a"oops,2'), /after closing quote/);
  assert.throws(() => C.parseCSV('a'.repeat(C.LIMITS.csvBytes + 1)), /16 MiB/);

  const digest = await C.sha256('abc');
  assert.equal(digest,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const bundle = minimalBundle(composite); bundle.sections[0].csv = csv;
  bundle.sections[0].files.push({name:'test.bin',size:3,sha256:digest,base64:'YWJj'});
  assert.equal(C.validateBundle(bundle),bundle);
  assert.deepEqual(C.validateBundle(JSON.parse(JSON.stringify(bundle))),bundle);
  function rejects(change, pattern) {const b=structuredClone(bundle); change(b); assert.throws(() => C.validateBundle(b),pattern);}
  rejects(b => b.schema='wrong', /schema/);
  rejects(b => b.sections.push(structuredClone(b.sections[0])), /Duplicate section ID/);
  rejects(b => b.sections[0].rois[0].paths[0][0][0]=Infinity, /non-finite/);
  rejects(b => b.sections[0].csv.rows[0][1]=0, /raw strings/);
  rejects(b => b.calibration.um_per_pixel=0, /positive/);
  rejects(b => b.calibration.xy_unit='um', /require/);
  rejects(b => b.calibration.z_unit='um', /explicit depth/);
  rejects(b => b.sections[0].included=false, /exclusion reason/);
  rejects(b => b.sections[0].files[0].sha256='bad', /fingerprint/);
  rejects(b => b.sections[0].files[0].size=4, /size does not match/);
  rejects(b => b.sections[0].files[0].base64='Y=Jj', /padding/);
  rejects(b => b.sections[0].image={name:'test.bin',sha256:digest,width:1,height:1,preview:'data:image/svg+xml;base64,AAAA'}, /PNG\/JPEG/);
  rejects(b => b.reviews=[{id:'r1',project_id:'other',section_id:null,reviewer:'Researcher',text:'Review',created_at:b.created_at,project_fingerprint:digest}], /different study/);
  rejects(b => {b.reviews.push({id:'r1',project_id:b.id,section_id:'s1',reviewer:'Researcher',text:'Raw text <b>preserved</b>',created_at:b.created_at,project_fingerprint:digest}); b.reviews.push({...b.reviews[0]});}, /Duplicate review/);
  const polluted = JSON.parse(JSON.stringify(bundle).replace('"schema":', '"__proto__":{},"schema":'));
  assert.throws(() => C.validateBundle(polluted), /Unsafe object key/);
  console.log('ResearchCore: ROI types, subpixel coordinates, holes, unsupported formats, raw CSV missing/zero, SHA-256 and bundle validation passed.');
})().catch(error => {console.error(error); process.exitCode=1;});
