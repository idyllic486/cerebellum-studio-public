// Scientific fixture setup reveals details programmatically; universal-card user activation is verified in check_quiet_ui.cjs.
/* Display-only review and direct Study handoff. Synthetic fixtures, no anatomy claim. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createHash,webcrypto}=require('node:crypto'),{chromium}=require('playwright'),JSZip=require('jszip');
globalThis.crypto||=webcrypto;
const C=require('../src/analysis_core.js'),root=path.resolve(__dirname,'..'),dist=path.resolve(root,process.env.ANALYSIS_PREVIEW||'dist');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'analysis-views-')),report={pass:false,synthetic_data:true,checks:[],page_errors:[]};
const record=name=>{report.checks.push(name);console.log(name);},hash=x=>createHash('sha256').update(x).digest('hex');
function tiff(){const w=64,h=48,entries=[[256,4,w],[257,4,h],[258,3,8],[259,3,1],[262,3,1],[273,4,134],[277,3,1],[278,4,h],[279,4,w*h],[339,3,1]],b=Buffer.alloc(134+w*h,200);b.write('II');b.writeUInt16LE(42,2);b.writeUInt32LE(8,4);b.writeUInt16LE(entries.length,8);entries.forEach(([tag,type,n],i)=>{const p=10+12*i;b.writeUInt16LE(tag,p);b.writeUInt16LE(type,p+2);b.writeUInt32LE(1,p+4);b.writeUInt32LE(n,p+8);});b.writeUInt32LE(0,130);return b;}
(async()=>{
 const original=tiff(),source={name:'synthetic-view.tif',sha256:hash(original),width:64,height:48};
 let fixture=C.createFromROIs([
  {id:'cb',label:'CB',paths:[[[4,4],[60,4],[60,44],[4,44]],[[20,20],[26,20],[26,26],[20,26]]]},
  {id:'pl',label:'PL',kind:'polyline',closed:false,paths:[[[8,8],[15,12],[20,8]]]},
  {id:'points',label:'LANDMARK',kind:'point',closed:false,paths:[[[30,12],[35,15]]]},
  {id:'excluded',label:'FISSURE',kind:'polyline',closed:false,paths:[[[40,30],[45,35]]]},
 ],source);
 fixture=C.setMetadata(fixture,{animal_id:'synthetic',section_id:'view',single_section_confirmed:true});
 fixture=await C.approve(fixture,{reviewer:'Synthetic fixture',protocol:'Display mechanics',checked:true});
 const inputZip=new JSZip();for(const file of (await C.exportApproved(fixture)).files)inputZip.file(file.name,file.bytes);
 const roiBytes=await inputZip.generateAsync({type:'nodebuffer'});
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost'),target=path.resolve(dist,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));if(!target.startsWith(dist+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile())return res.writeHead(404).end();res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[path.extname(target)]||'application/octet-stream');fs.createReadStream(target).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.on('pageerror',error=>report.page_errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('body.ready').waitFor({timeout:60000});await page.evaluate(()=>CerebellumWorkspace.open('image'));
  const idle=()=>page.waitForFunction(()=>!document.getElementById('analysisImage').disabled),snapshot=()=>page.evaluate(()=>CerebellumAnalysis.snapshot());
  const saved=()=>page.waitForFunction(()=>{const s=CerebellumAnalysis.recoveryState();return s.savedVersion===s.changeVersion&&!s.error;});
  await page.locator('#analysisImage').setInputFiles({name:source.name,mimeType:'image/tiff',buffer:original});await idle();
  await page.locator('#analysisROIImport').setInputFiles({name:'mixed.zip',mimeType:'application/zip',buffer:roiBytes});await idle();
  const imported=await snapshot();assert.equal(imported.rois.length,4);assert.equal(imported.rois[0].paths.length,2);
  await page.locator('#analysisROI').selectOption(imported.rois[3].id);await page.locator('#analysisExcluded').check();await page.locator('#analysisExclusionReason').fill('Synthetic exclusion');await page.locator('#analysisApplyExclusion').click();
  for(const[id,value]of Object.entries({analysisAnimal:'synthetic',analysisSection:'view',analysisScaleX:'2',analysisScaleY:'3'}))await page.locator('#'+id).fill(value);
  await page.locator('#analysisSingle').check();await page.locator('#analysisApplyMetadata').click();
  await page.locator('#analysisReviewer').fill('Synthetic reviewer');await page.locator('#analysisProtocol').fill('View switching must preserve evidence');await page.locator('#analysisCoordinatesChecked').check();await page.locator('#analysisChecked').check();await page.locator('#analysisApprove').click();await idle();
  const before=await snapshot();assert(before.approval,await page.locator('#analysisStatus').innerText());
  const measurements=before.rois.map(r=>C.measure(r,before.metadata));
  const originalHref=await page.locator('#analysisRaster').getAttribute('href');
  for(const mode of ['original','roi','overlay','roi']){
   await page.locator('#analysisViewMode').selectOption(mode);
   const visual=await page.evaluate(()=>{const style=id=>getComputedStyle(document.getElementById(id)).display;return{raster:style('analysisRaster'),contours:style('analysisContours'),failed:style('analysisFailedRasterPreview'),drawing:style('analysisDrawing'),mode:document.getElementById('analysisCanvas').dataset.viewMode,marker:document.getElementById('analysisVertexMarker').getAttribute('visibility')};});
   assert.equal(visual.mode,mode);assert.equal(visual.raster==='none',mode==='roi');assert.equal(visual.contours==='none',mode==='original');assert.equal(visual.failed==='none',mode!=='overlay');assert.equal(visual.drawing==='none',mode==='original');if(mode==='original')assert.equal(visual.marker,'hidden');
   assert.deepEqual(await snapshot(),before);assert.equal(await page.locator('#analysisRaster').getAttribute('href'),originalHref);assert(!await page.locator('#analysisExport').isDisabled());
  }
  assert.deepEqual((await snapshot()).rois.map(r=>C.measure(r,before.metadata)),measurements);
  assert.equal(await page.locator('#analysisContours [data-geometry=area]').getAttribute('fill-rule'),'evenodd');
  assert(!/Z/.test(await page.locator('#analysisContours [data-geometry=polyline]').first().getAttribute('d')));assert.equal(await page.locator('#analysisContours [data-geometry=point] circle').count(),2);
  assert.equal(await page.locator('#analysisContours [data-roi="'+before.rois[3].id+'"]').getAttribute('stroke-dasharray'),'6 4');
  record('Original/overlay/ROI-only hide the intended layers, preserving mixed geometry, holes, exclusions, source, measurements and approval exactly');
  await page.locator('#analysisViewMode').selectOption('original');await page.locator('#analysisDrawROI').click();assert.equal(await page.locator('#analysisViewMode').inputValue(),'overlay');assert(await page.locator('#analysisViewMode').isDisabled());await page.locator('#analysisCancelDrawing').click();assert.deepEqual(await snapshot(),before);await page.locator('#analysisViewMode').selectOption('roi');
  await page.locator('#analysisX').fill('41');assert(await page.locator('#analysisContinueStudy').isDisabled());await page.locator('#analysisResetFields').click();assert.deepEqual(await snapshot(),before);assert(!await page.locator('#analysisContinueStudy').isDisabled());
  record('Drawing switches to visible overlay; pending edits block direct handoff and cancelling display-only drawing preserves approval');
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#analysisExport').click()]);const archivePath=path.join(tmp,'approved.zip');await download.saveAs(archivePath);await idle();
  const archive=await JSZip.loadAsync(fs.readFileSync(archivePath));assert.deepEqual(await archive.file('originals/source.tif').async('nodebuffer'),original);assert.equal(JSON.parse(await archive.file('review.json').async('string')).analysis.approval.fingerprint,before.approval.fingerprint);
  record('ROI-only approved export retains original TIFF bytes and approval fingerprint');
  await page.evaluate(async()=>{window.displayBackup=await CerebellumAnalysis.backup.export();window.displayCheckpoint=await CerebellumAnalysis.backup.checkpoint();});
  assert.equal(await page.evaluate(()=>displayBackup.document.viewMode),'roi');
  await page.locator('#analysisViewMode').selectOption('original');await page.evaluate(()=>displayCheckpoint.rollback());assert.equal(await page.locator('#analysisViewMode').inputValue(),'roi');assert.deepEqual(await snapshot(),before);
  await page.evaluate(async()=>{const bad=structuredClone(displayBackup.document);bad.viewMode='erase';let rejected=false;try{await CerebellumAnalysis.backup.prepare(bad,displayBackup.binaries);}catch{rejected=true;}if(!rejected)throw Error('Unknown display mode accepted');});assert.deepEqual(await snapshot(),before);
  record('Display preference is separate backup data; rollback preserves approval and invalid display modes are rejected without mutation');
  await page.locator('#analysisContinueStudy').click();await page.waitForFunction(()=>CerebellumStudy.snapshot()&&!CerebellumStudy.pendingState().busy);
  const study=await page.evaluate(()=>CerebellumStudy.snapshot()),section=study.animals[0].sections[0];assert.equal(section.source.sha256,source.sha256);assert.equal(section.review,null);assert.deepEqual(section.rois.map(r=>r.paths),before.rois.map(r=>r.paths));assert.deepEqual(await snapshot(),before);assert.equal(await page.locator('#researchView').getAttribute('data-workspace-mode'),'study');
  record('One-click Study handoff preserves source and geometry while requiring a fresh Study review');
  await page.evaluate(()=>CerebellumWorkspace.open('image'));await saved();const recovery=await page.evaluate(()=>CerebellumAnalysis.recoveryState().sessionId);
  await page.reload();await page.locator('body.ready').waitFor({timeout:60000});await page.evaluate(()=>CerebellumWorkspace.open('image'));if(!await page.locator('.analysis-recovery').evaluate(n=>n.open))await page.locator('.analysis-recovery > summary').evaluate(n=>n.closest('details').open=true);await page.locator('#analysisRecoveryList').selectOption(recovery);await page.locator('#analysisRestoreSession').click();await idle();
  assert.equal(await page.locator('#analysisViewMode').inputValue(),'roi');assert.equal(await page.locator('#analysisRaster').evaluate(n=>getComputedStyle(n).display),'none');assert.deepEqual((await snapshot()).rois,before.rois);assert.equal((await snapshot()).approval,null);
  record('Browser recovery retains ROI-only display and geometry; existing fresh-approval policy remains enforced');
  await page.setViewportSize({width:320,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=321));assert.deepEqual(report.page_errors,[]);report.pass=true;
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});fs.writeFileSync(path.resolve(process.env.ANALYSIS_VIEW_REPORT||path.join(__dirname,'analysis-view-modes.json')),JSON.stringify(report,null,2)+'\n');}
})().catch(error=>{console.error(error);process.exitCode=1;});
