const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
global.pako=require('../dist/vendor/pako.min.js');
const context={self:global,console,require:name=>{assert.equal(name,'pako');return global.pako;},module:{exports:{}}};
vm.runInNewContext(fs.readFileSync(require.resolve('../dist/vendor/UTIF.js'),'utf8'),context);
global.UTIF=context.module.exports;
const R=require('../src/research_image.js');
function tiff({little=true,bits=8,format=1,width=2,height=2,photo=1,compression=1,raw,extra={}}={}){
 raw=raw||new Uint8Array(width*height*bits/8);const payload=compression===8?pako.deflate(raw):raw;
 const tags={256:[4,[width]],257:[4,[height]],258:[3,[bits]],259:[3,[compression]],262:[3,[photo]],273:[4,[0]],277:[3,[1]],278:[4,[height]],279:[4,[payload.length]],339:[3,[format]],...extra};
 const entries=Object.entries(tags).sort((a,b)=>Number(a[0])-Number(b[0])),end=8+2+entries.length*12+4;
 tags[273][1][0]=end;const b=new Uint8Array(end+payload.length),v=new DataView(b.buffer);b.set(little?[73,73,42,0]:[77,77,0,42]);v.setUint32(4,8,little);v.setUint16(8,entries.length,little);
 entries.forEach(([tag,[type,vals]],i)=>{assert.equal(vals.length,1);const o=10+i*12;v.setUint16(o,Number(tag),little);v.setUint16(o+2,type,little);v.setUint32(o+4,1,little);if(type===3)v.setUint16(o+8,vals[0],little);else v.setUint32(o+8,vals[0],little);});b.set(payload,end);return b;
}
function read(bytes){const p=R.validateTIFF(bytes);R.decodeTIFF(bytes,p);return Array.from(UTIF.toRGBA8(p));}
assert.deepEqual(read(tiff({raw:new Uint8Array([0,64,128,255])})),[0,0,0,255,64,64,64,255,128,128,128,255,255,255,255,255]);
const le=tiff({bits:16,raw:new Uint8Array([0,0,0,64,0,128,0,255])}),be=tiff({little:false,bits:16,raw:new Uint8Array([0,0,64,0,128,0,255,0])});
assert.deepEqual(read(le),read(be),'Big-endian unsigned16 display must agree with little-endian');
for(const source of [le,be]){const before=source.slice(),page=R.validateTIFF(source);R.decodeTIFF(source,page);const preview=R.previewTIFF(page,1);assert.deepEqual({width:preview.width,height:preview.height,previewWidth:preview.previewWidth,previewHeight:preview.previewHeight},{width:2,height:2,previewWidth:1,previewHeight:1});assert.deepEqual(Array.from(preview.rgba),[255,255,255,255],'Nearest source pixel at the preview centre must preserve gray16 display values');assert.deepEqual(source,before,'Preview must not mutate source bytes');}
const pixels=tiff({width:4,height:2,raw:new Uint8Array([10,20,30,40,50,60,70,80])}),sampled=R.validateTIFF(pixels);R.decodeTIFF(pixels,sampled);assert.deepEqual(Array.from(R.previewTIFF(sampled,2).rgba),[60,60,60,255,80,80,80,255],'2x1 preview samples the original 4x2 pixel grid');
assert.equal(R.LIMITS.fileBytes,256*1024*1024);assert.equal(R.LIMITS.decodedBytes,128*1024*1024);assert.equal(R.LIMITS.pixels,40000000);

assert.deepEqual(read(tiff({compression:8,raw:new Uint8Array([0,64,128,255])})),read(tiff({raw:new Uint8Array([0,64,128,255])})));
assert.throws(()=>R.validateTIFF(tiff({bits:32,format:3})),/Floating-point/);
assert.throws(()=>R.validateTIFF(tiff({compression:999})),/compression/);
assert.throws(()=>R.validateTIFF(tiff({photo:4})),/colour\/bit/);
assert.throws(()=>R.validateTIFF(tiff({extra:{284:[3,[2]]}})),/Planar-separated/);
assert.throws(()=>R.validateTIFF(tiff({extra:{274:[3,[6]]}})),/orientation/);
assert.throws(()=>R.validateTIFF(tiff({extra:{330:[4,[8]]}})),/sub-IFD/);
const cycle=tiff(),cv=new DataView(cycle.buffer),count=cv.getUint16(8,true);cv.setUint32(10+count*12,8,true);assert.throws(()=>R.validateTIFF(cycle),/Multi-page/);
const oversized=tiff(),ov=new DataView(oversized.buffer);ov.setUint32(14,0xffffffff,true);assert.throws(()=>R.validateTIFF(oversized),/count/);
const bomb=tiff({compression:8,raw:new Uint8Array(100000)});const bp=R.validateTIFF(bomb),originalInflate=pako.inflate;assert.throws(()=>R.decodeTIFF(bomb,bp),/size/);assert.equal(pako.inflate,originalInflate,'Inflate must be restored after rejection');
const changed=tiff(),p=R.validateTIFF(changed);changed[changed.length-1]=44;assert.throws(()=>R.decodeTIFF(changed,p),/Unvalidated/);
function exif(value){const b=new Uint8Array(26),v=new DataView(b.buffer);b.set([73,73,42,0,8,0,0,0,1,0]);v.setUint16(10,274,true);v.setUint16(12,3,true);v.setUint32(14,1,true);v.setUint16(18,value,true);return b;}
function jpeg(value){const e=exif(value),b=new Uint8Array(2+4+6+e.length+13+2);b.set([255,216,255,225,0,e.length+8,69,120,105,102,0,0]);b.set(e,12);b.set([255,192,0,11,8,0,2,0,2,1,1,17,0],12+e.length);b.set([255,217],b.length-2);return b;}
function png(value){const e=exif(value),b=new Uint8Array(8+25+12+e.length+12),v=new DataView(b.buffer);b.set([137,80,78,71,13,10,26,10]);v.setUint32(8,13,false);b.set([73,72,68,82],12);v.setUint32(16,2,false);v.setUint32(20,2,false);b.set([8,2,0,0,0],24);v.setUint32(33,e.length,false);b.set([101,88,73,102],37);b.set(e,41);b.set([73,69,78,68],b.length-8);return b;}
assert.equal(R.validateRasterOrientation(jpeg(1),'jpg'),1);assert.throws(()=>R.validateRasterOrientation(jpeg(6),'jpeg'),/orientation/);
assert.equal(R.validateRasterOrientation(png(1),'png'),1);assert.throws(()=>R.validateRasterOrientation(png(8),'png'),/orientation/);
assert.throws(()=>R.validateRasterOrientation(jpeg(1).slice(0,17),'jpeg'),/length/);
const pngBomb=png(1);new DataView(pngBomb.buffer).setUint32(16,1000000,false);new DataView(pngBomb.buffer).setUint32(20,1000000,false);assert.throws(()=>R.validateRasterOrientation(pngBomb,'png'),/40 million/);
const jpegBomb=jpeg(1),sof=12+exif(1).length;jpegBomb[sof+5]=255;jpegBomb[sof+6]=255;jpegBomb[sof+7]=255;jpegBomb[sof+8]=255;assert.throws(()=>R.validateRasterOrientation(jpegBomb,'jpg'),/40 million/);
console.log('ResearchImage: gray8/16 LE+BE, bounded Deflate, float/unsupported TIFF, IFD cycles/counts, immutable preflight, JPEG/PNG EXIF passed.');
