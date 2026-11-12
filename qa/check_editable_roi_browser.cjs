/* The draft leaves the site as polygons ImageJ can edit and comes back as layers. Synthetic fixtures only. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createHash,webcrypto}=require('node:crypto'),{chromium}=require('playwright'),JSZip=require('jszip');globalThis.crypto||=webcrypto;
const C=require('../src/analysis_core.js'),R=require('../src/research_core.js'),E=require('../src/editable_roi_core.js');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'editable-roi-'));
const report={pass:false,synthetic_data:true,checks:[],page_errors:[],external_requests:[]},record=(name,details={})=>{report.checks.push({name,pass:true,...details});console.log(name);},hash=x=>createHash('sha256').update(x).digest('hex');
const W=400,H=300;
function tiff(){const entries=[[256,4,W],[257,4,H],[258,3,8],[259,3,1],[262,3,1],[273,4,134],[277,3,1],[278,4,H],[279,4,W*H],[339,3,1]],b=Buffer.alloc(134+W*H,200);b.write('II');b.writeUInt16LE(42,2);b.writeUInt32LE(8,4);b.writeUInt16LE(entries.length,8);entries.forEach(([tag,type,n],i)=>{const p=10+12*i;b.writeUInt16LE(tag,p);b.writeUInt16LE(type,p+2);b.writeUInt32LE(1,p+4);b.writeUInt32LE(n,p+8);});b.writeUInt32LE(0,130);return b;}
const fixture=(name,bytes)=>{const file=path.join(tmp,name);fs.writeFileSync(file,bytes);return file;},box=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
(async()=>{
 record('The served build is in step with the sources',require('./dist_fresh.cjs')(root));
 const original=tiff(),source={name:'synthetic.tif',sha256:hash(original),width:W,height:H},sourceFile=fixture(source.name,original);
 // CB with a separate small part, ML around GL, GL around WM; the model draft keeps layers as one ROI each.
 const prediction={schema:C.PREDICTION_SCHEMA,source,model:{id:'fixture',version:'1',weights_sha256:'b'.repeat(64)},rois:[
  {id:'cb',label:'CB',paths:[box(20,20,300,260),box(330,40,360,70)]},{id:'ml',label:'ML',paths:[box(20,20,300,260),box(60,60,260,220),box(330,40,360,70)]},
  {id:'gl',label:'GL',paths:[box(60,60,260,220),box(100,100,220,180)]},{id:'wm',label:'WM',paths:[box(100,100,220,180)]}]},predictionFile=fixture('prediction.json',Buffer.from(JSON.stringify(prediction)));
 const server=http.createServer((req,res)=>{const target=path.resolve(dist,'.'+(new URL(req.url,'http://localhost').pathname==='/'?'/index.html':decodeURIComponent(new URL(req.url,'http://localhost').pathname)));if(!target.startsWith(dist+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile())return res.writeHead(404).end();res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[path.extname(target)]||'application/octet-stream');fs.createReadStream(target).pipe(res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.on('pageerror',e=>report.page_errors.push(e.message));page.on('request',r=>{if(![origin,'data:','blob:'].some(p=>r.url().startsWith(p)))report.external_requests.push(r.url());});page.on('dialog',d=>d.accept());
  await page.goto(origin);await page.locator('body.ready').waitFor({timeout:60000});await page.evaluate(()=>CerebellumWorkspace.open('image'));
  const snapshot=()=>page.evaluate(()=>CerebellumAnalysis.snapshot()),idle=()=>page.waitForFunction(()=>!document.getElementById('analysisImage').disabled,null,{timeout:60000});
  await page.locator('#analysisImage').setInputFiles(sourceFile);await idle();await page.locator('#analysisAdvanced > summary').evaluate(n=>n.closest('details').open=true);
  await page.locator('#analysisPrediction').setInputFiles(predictionFile);await idle();const draft=await snapshot();assert.ok(draft,await page.locator('#analysisStatus').innerText());assert.equal(draft.rois.length,4);assert.equal(draft.approval,null);
  // Download: polygons and one polyline, named by outline, part and hole; the small separate part is still there because no pixel size is set.
  const save=async name=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#analysisExportDraftROI').click()]);assert.equal(d.suggestedFilename(),'ROI-draft-editable-not-approved.zip');const target=path.join(tmp,name);await d.saveAs(target);await idle();return target;};
  const first=await save('first.zip'),zip=await JSZip.loadAsync(fs.readFileSync(first)),entries=[];for(const name of Object.keys(zip.files)){const bytes=await zip.file(name).async('uint8array');entries.push({file:name,type:bytes[6],roi:R.parseROI(bytes,name)});}
  assert.deepEqual(entries.map(e=>e.file),['Cb_part01.roi','Cb_part02.roi','GL+WM_part01.roi','WM_part01.roi']);
  assert.ok(entries.every(e=>e.type===0),'Areas must be ImageJ polygons (type 0)');
  assert.deepEqual(entries[0].roi.paths,[box(20,20,300,260)]);assert.deepEqual(entries[2].roi.paths,[box(60,60,260,220)]);assert.deepEqual(entries[3].roi.paths,[box(100,100,220,180)]);assert.deepEqual(entries[1].roi.paths,[box(330,40,360,70)]);
  assert.deepEqual(await snapshot(),draft,'Saving the editable file changed the review');
  record('The draft downloads as ImageJ polygons, one per part, with ML and GL left to follow from the outlines',{files:entries.map(e=>e.file)});
  // A person corrects it in ImageJ: deletes the small part, moves the WM edge, cuts a hole into Cb. Written here with the same encoder.
  const corrected=new JSZip();for(const [name,kind,pts] of [['Cb_part01','polygon',box(20,20,300,260)],['GL+WM_part01','polygon',box(60,60,260,220)],['WM_part01','polygon',box(100,100,240,180)],['Cb_hole_new','polygon',box(30,30,50,50)],['PL_TOTAL','polyline',[[60,60],[260,60],[260,220]]]])corrected.file(name+'.roi',E.encodeROI(name,kind,pts));
  const correctedFile=fixture('corrected.zip',await corrected.generateAsync({type:'nodebuffer'}));
  await page.locator('#analysisROIImport').setInputFiles(correctedFile);await idle();assert.ok(await page.locator('#analysisReplacement').isVisible(),'Corrected polygons must be offered as a new result');
  await page.locator('#analysisAcceptReplacement').click();await idle();const back=await snapshot(),by=Object.fromEntries(back.rois.map(r=>[r.label,r]));
  assert.deepEqual(back.rois.map(r=>r.label),['CB','ML','GL','WM','PL']);assert.equal(back.original_prediction.origin,'imagej');assert.equal(back.approval,null);
  const area=roi=>C.measure(roi,back.metadata).area_px2;
  assert.equal(area(by.CB),280*240-400);assert.equal(area(by.GL),200*160-140*80);assert.equal(area(by.WM),140*80);assert.equal(area(by.ML),280*240-400-200*160);
  assert.equal(area(by.CB),area(by.ML)+area(by.GL)+area(by.WM),'Without a pixel size no band is taken out, so the layers fill Cb');assert.deepEqual(by.PL.paths,[[[60,60],[260,60],[260,220]]]);
  const combined=await page.evaluate(()=>CerebellumAnalysis.lastCombined());assert.equal(combined.band,false);assert.deepEqual(combined.how.rois_used.Cb,{added:['Cb_part01'],holes:['Cb_hole_new']});assert.deepEqual(combined.how.rois_ignored,[]);
  record('Corrected polygons come back as CB, ML, GL and WM with the deleted part gone, the moved edge and the new hole applied');
  // With a pixel size the 20 µm Purkinje band leaves ML when the corrected file comes back, exactly as the core computes it.
  const fill=(id,value)=>page.locator('#'+id).fill(String(value));await page.locator('#analysisScaleX').evaluate(n=>{for(let d=n.closest('details');d;d=d.parentElement.closest('details'))d.open=true;});
  await fill('analysisScaleX',1);await fill('analysisScaleY',1);await page.locator('#analysisApplyMetadata').click();await idle();assert.equal((await snapshot()).metadata.um_per_pixel_x,1);
  const polygons=[];{const z=await JSZip.loadAsync(fs.readFileSync(correctedFile));for(const name of Object.keys(z.files)){const r=R.parseROI(await z.file(name).async('uint8array'),name);polygons.push({name:r.name,kind:r.kind,paths:r.paths});}}
  const expected=E.rebuild(polygons,W,H,{pl_band_width_um:20,pixels_per_micron:1});assert.ok(expected.how.purkinje_band.pixels>5000);
  await page.locator('#analysisROIImport').setInputFiles([]);await page.locator('#analysisROIImport').setInputFiles(correctedFile);await idle();await page.locator('#analysisAcceptReplacement').click();await idle();
  const banded=await snapshot(),layer=Object.fromEntries(banded.rois.map(r=>[r.label,r]));
  assert.equal(area(layer.ML),expected.how.pixels.ML);assert.equal(area(layer.ML),280*240-400-200*160-expected.how.purkinje_band.pixels);assert.equal(area(layer.GL),200*160-140*80);assert.equal(area(layer.CB),280*240-400);
  assert.equal((await page.evaluate(()=>CerebellumAnalysis.lastCombined())).band,true);
  record('With a pixel size set, the 20 µm Purkinje band is taken out of ML on import and matches the core',{band_pixels:expected.how.purkinje_band.pixels});
  // The next download carries the new hole as its own polygon, and the pixel size lets small separate parts be left out.
  const second=await JSZip.loadAsync(fs.readFileSync(await save('second.zip')));assert.deepEqual(Object.keys(second.files),['Cb_part01.roi','Cb_part01_hole01.roi','GL+WM_part01.roi','WM_part01.roi','PL_TOTAL.roi']);
  assert.deepEqual(R.parseROI(await second.file('Cb_part01_hole01.roi').async('uint8array'),'h.roi').paths[0].map(String).sort(),box(30,30,50,50).map(String).sort(),'The hole is the square that was cut, whichever way it winds');assert.equal((await second.file('PL_TOTAL.roi').async('uint8array'))[6],5);
  record('A second download holds the corrected outlines, the hole and the line');
  // Two corrected files at once, or a file without a Cb outline, are refused and the review stays.
  const kept=await snapshot(),alone=new JSZip();alone.file('GL+WM_part01.roi',E.encodeROI('GL+WM_part01','polygon',box(60,60,260,220)));alone.file('Cb_part01.roi',E.encodeROI('Cb_part01','polygon',box(20,20,300,260)));
  const other=fixture('other.zip',await alone.generateAsync({type:'nodebuffer'}));await page.locator('#analysisROIImport').setInputFiles([]);await page.locator('#analysisROIImport').setInputFiles([correctedFile,other]);await idle();
  assert.match(await page.locator('#analysisStatus').innerText(),/one file of corrected polygons/);assert.deepEqual(await snapshot(),kept);assert.ok(await page.locator('#analysisReplacement').isHidden());
  record('Several corrected files at once are refused and the review is kept');
  // An ordinary ROI file also holds ROIs named Cb and GL+WM; it is imported as it is, not combined.
  const usual=new JSZip();for(const [name,pts] of [['Cb',box(20,20,300,260)],['ML_TOTAL',box(20,20,300,60)],['GL_TOTAL',box(60,60,260,220)],['GL+WM',box(60,60,260,220)],['WM',box(100,100,220,180)]])usual.file(name+'.roi',E.encodeROI(name,'polygon',pts));
  const usualFile=fixture('usual.zip',await usual.generateAsync({type:'nodebuffer'}));await page.locator('#analysisROIImport').setInputFiles([]);await page.locator('#analysisROIImport').setInputFiles(usualFile);await idle();await page.locator('#analysisAcceptReplacement').click();await idle();
  const plain=await snapshot();assert.equal(await page.evaluate(()=>CerebellumAnalysis.lastCombined()),null);assert.deepEqual(plain.rois.map(r=>r.name),['Cb','ML_TOTAL','GL_TOTAL','GL+WM','WM']);assert.deepEqual(plain.rois.find(r=>r.name==='ML_TOTAL').paths[0].map(String).sort(),box(20,20,300,60).map(String).sort());
  record('An ordinary ROI file with Cb and GL+WM is imported unchanged');
  assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.external_requests,[]);record('No browser errors or external requests');report.pass=true;
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});fs.writeFileSync(path.join(__dirname,'editable-roi-browser.json'),JSON.stringify(report,null,2)+'\n');}
})().catch(e=>{console.error(e);process.exitCode=1;});
