// Scientific fixture setup reveals details programmatically; universal-card user activation is verified in check_quiet_ui.cjs.
/* Actual fitted synthetic pixel forests -> fragmented native maps -> explicitly
 * approximate editable candidates. Mechanics only, never anatomical validation. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawnSync}=require('node:child_process'),{createHash}=require('node:crypto'),{chromium}=require('playwright'),JSZip=require('jszip');
const root=path.resolve(__dirname,'..'),dist=path.join(root,process.env.ANALYSIS_PREVIEW||'dist'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'roi-candidates-'));
const report={pass:false,synthetic_data:true,real_animal_accuracy_established:false,checks:[],page_errors:[],external_requests:[]};
const hash=x=>createHash('sha256').update(x).digest('hex'),record=name=>{report.checks.push({name,pass:true});console.log(name);};
const generator=String.raw`
import sys,json,hashlib
from pathlib import Path
import numpy as np,tifffile
from sklearn.ensemble import RandomForestClassifier
sys.path.insert(0,sys.argv[2]+'/scripts')
from nissl_lab import features,validate_forest,forest_predict
out=Path(sys.argv[1]);rng=np.random.default_rng(812)
train_labels=rng.integers(0,4,(128,128),dtype=np.uint8)
values=np.array([240,45,110,175],np.uint8)
train=np.repeat(values[train_labels][:,:,None],3,axis=2)
smooth=np.zeros((128,128),np.uint8)
smooth[16:112,16:48]=1;smooth[16:112,48:80]=2;smooth[16:112,80:112]=3
noisy=smooth.copy()
for y in [2,6,10,114,118,122]:
 for x in range(2,126,4):noisy[y:y+2,x:x+2]=1
assert int(np.count_nonzero(smooth!=noisy))==744
sha=lambda b:hashlib.sha256(b).hexdigest()
cfg={'channels':'RGB','dtype':'uint8','scale':[255,255,255]}
X=features(train,cfg['scale']).reshape(-1,15);models={}
for head,classes,target in [('cb',['background','CB'],(train_labels>0).astype(np.uint8)),('layers',['background','ML','GL','WM'],train_labels),('lobules',['background','LOBULE_Crus1','LOBULE_Sim','LOBULE_Cop'],train_labels)]:
 forest=RandomForestClassifier(n_estimators=4,max_depth=3,max_features=None,bootstrap=False,random_state=17,n_jobs=1).fit(X,target.ravel())
 trees=[]
 for est in forest.estimators_:
  t=est.tree_;p=t.value[:,0,:];p=p/p.sum(axis=1,keepdims=True)
  trees.append({'left':t.children_left.tolist(),'right':t.children_right.tolist(),'feature':t.feature.tolist(),'threshold':t.threshold.tolist(),'probabilities':p.tolist()})
 model={'schema':'cerebellum-pixel-forest/1','id':'synthetic-candidate-'+head,'version':'1.0.0','input':cfg,'classes':classes,'features':'raw+gaussian_mean_std_sigma1_sigma3_reflect_truncate4/1','trees':trees,'training_animals':['synthetic-train'],'training_sources':[{'animal_id':'synthetic-train','section_id':'1','source_sha256':sha(train.tobytes()),'label_sha256':sha(target.tobytes())}]}
 validate_forest(model);models[head]=model
 for name,labels in [('fragmented',noisy),('smooth',smooth)]:
  image=np.repeat(values[labels][:,:,None],3,axis=2)
  predicted=forest_predict(model,image);expected=(labels>0).astype(np.uint8) if head=='cb' else labels
  assert np.array_equal(predicted,expected),(head,name)
  if name=='fragmented':predicted.tofile(out/(head+'-labels.uint8'))
  tifffile.imwrite(out/(name+'.tif'),image,photometric='rgb',metadata=None)
(out/'auto-roi-models.json').write_text(json.dumps({'schema':'cerebellum-auto-roi-models/1','primary':'layers','models':{head:models[head] for head in ['cb','layers']}}))
(out/'three-head-models.json').write_text(json.dumps({'schema':'cerebellum-auto-roi-models/1','primary':'layers','models':models}))
`;
async function main(){
 const python=process.env.NISSL_LAB_PYTHON||(fs.existsSync('/tmp/cerebellum-locked-env/bin/python')?'/tmp/cerebellum-locked-env/bin/python':'python3');
 const generated=spawnSync(python,['-c',generator,temp,root],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
 const original=fs.readFileSync(path.join(temp,'fragmented.tif')),model=fs.readFileSync(path.join(temp,'auto-roi-models.json'));
 const expected=Object.fromEntries(['cb','layers'].map(head=>[head,fs.readFileSync(path.join(temp,head+'-labels.uint8'))]));
 const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname,p=path.resolve(dist,'.'+(pathname==='/'?'/index.html':pathname));if(!p.startsWith(dist+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile())return res.writeHead(404).end();res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[path.extname(p)]||'application/octet-stream');fs.createReadStream(p).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--enable-unsafe-swiftshader']});
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}}),page=await context.newPage();
  const monitor=p=>{p.on('pageerror',e=>report.page_errors.push(e.message));p.on('request',r=>{if(!r.url().startsWith(origin)&&!r.url().startsWith('blob:')&&!r.url().startsWith('data:'))report.external_requests.push(r.url());});};monitor(page);
  const open=async p=>{await p.goto(origin);await p.locator('body.ready').waitFor({timeout:60000});await p.evaluate(()=>CerebellumWorkspace.open('image'));await p.locator('#analysisAdvanced > summary').evaluate(n=>n.closest('details').open=true);};
  const idle=()=>page.waitForFunction(()=>!document.getElementById('analysisImage').disabled,null,{timeout:60000}),snap=()=>page.evaluate(()=>CerebellumAnalysis.snapshot());
  const saved=()=>page.waitForFunction(()=>{const s=CerebellumAnalysis.recoveryState();return !s.error&&s.savedVersion===s.changeVersion;},null,{timeout:20000});
  const maps=()=>page.evaluate(async()=>{const b=await CerebellumAnalysis.backup.export(),r=b.document.failed_raster;if(!r)throw Error('Native evidence is missing');return Promise.all([r,...(r.additional_rasters||[])].map(async item=>({head:item.metadata.head,metadata:item.metadata,bytes:Array.from(new Uint8Array(await b.binaries.get(item.labels_file.original_ref).arrayBuffer()))})));});
  await open(page);assert.equal(await page.locator('#analysisIncludePL').isChecked(),false);await page.locator('#analysisModel').setInputFiles(path.join(temp,'auto-roi-models.json'));await idle();await page.locator('#analysisAutoGenerate').check();await page.locator('#analysisImage').setInputFiles(path.join(temp,'fragmented.tif'));await page.locator('#analysisRasterFailure').waitFor({state:'visible',timeout:60000});await idle();
  assert.equal(await snap(),null);assert.match(await page.locator('#analysisRasterFailureReason').innerText(),/64 connected/);
  const originalMaps=await maps();assert.equal(originalMaps.length,2);for(const m of originalMaps){assert.deepEqual(Buffer.from(m.bytes),expected[m.head]);assert.equal(m.metadata.label_sha256,hash(expected[m.head]));assert.equal(m.metadata.model.weights_sha256,hash(model));}
  record('Real fitted synthetic models produce fragmented native maps; both maps match independently computed Python predictions byte-for-byte');
  await page.locator('#analysisRasterFailure details > summary').click();assert.ok(await page.locator('#analysisRasterFailure details > dialog').evaluate(n=>n.matches(':modal')));await page.locator('#analysisCandidateBlock').selectOption('8');await page.locator('#analysisCreateCandidates').click();await idle();await page.keyboard.press('Escape');await page.locator('#analysisRasterFailure details > dialog').waitFor({state:'detached'});
  let state=await snap();assert.ok(state,await page.locator('#analysisStatus').innerText());assert.deepEqual(state.rois.map(r=>r.label).sort(),['CB','GL','ML','WM']);assert.equal(state.approval,null);assert.ok(await page.locator('#analysisExport').isDisabled());assert.equal(await page.locator('#analysisViewMode').inputValue(),'roi');
  assert.equal(state.original_prediction.reference.label_sha256,originalMaps.find(m=>m.head===state.original_prediction.reference.head).metadata.label_sha256);
  for(const h of state.original_prediction.processing.heads){assert.equal(h.candidate.changed_pixels,744);assert.equal(h.candidate.total_pixels,16384);assert.equal(h.candidate.block_size_px,8);assert.equal(h.candidate.removed_component_pixels,0);assert.equal(h.candidate.transition_pixel_counts.flat().reduce((a,b)=>a+b,0),16384);}
  assert.match(await page.locator('#analysisCandidateSummary').textContent(),/744/);assert.deepEqual(await maps(),originalMaps);
  record('Explicit 8-pixel block conversion produces four editable unapproved area ROIs, reports exactly 744 changed pixels per head and preserves all native labels');
  for(const[id,value]of [['analysisAnimal','synthetic'],['analysisSection','one'],['analysisScaleX','2'],['analysisScaleY','3']])await page.locator('#'+id).fill(value);
  await page.locator('#analysisSingle').check();await page.locator('#analysisApplyMetadata').click();await page.locator('#analysisQCNote').fill('Synthetic block changes inspected; no biological validation');await page.locator('#analysisAcknowledgeQC').click();await page.locator('#analysisReviewer').fill('Synthetic reviewer');await page.locator('#analysisProtocol').fill('Synthetic candidate mechanics');await page.locator('#analysisChecked').check();await page.locator('#analysisApprove').click();await idle();const approved=await snap();assert.ok(approved.approval,await page.locator('#analysisStatus').innerText());
  const[download]=await Promise.all([page.waitForEvent('download'),page.locator('#analysisExport').click()]);await download.saveAs(path.join(temp,'candidate-results.zip'));await idle();const zip=await JSZip.loadAsync(fs.readFileSync(path.join(temp,'candidate-results.zip')));assert.deepEqual(await zip.file('originals/source.tif').async('nodebuffer'),original);assert.deepEqual(await zip.file('originals/model.json').async('nodebuffer'),model);
  const retained=JSON.parse(await zip.file('reference-maps.json').async('string'));assert.equal(retained.length,2);for(const m of retained)assert.deepEqual(await zip.file(m.labels_file).async('nodebuffer'),expected[m.head]);assert.ok(zip.file('measurement.csv'));assert.ok(zip.file('result.csv'));assert.ok(zip.file('ROI.zip'));
  record('Researcher-approved candidate archive retains unchanged source/model/maps together with the processing record and all three requested export files');
  // The actual candidate postcard path was exercised above; reveal controls inline for subsequent scientific replacement/PL fixtures.
  await page.locator('#analysisCreateCandidates').evaluate(n=>n.closest('details').open=true);await page.locator('#analysisIncludePL').check();await page.locator('#analysisCreateCandidates').click();await idle();assert.ok(await page.locator('#analysisReplacement').isVisible());assert.deepEqual(await snap(),approved);await page.locator('#analysisKeepCurrent').click();assert.deepEqual(await snap(),approved);assert.deepEqual(await maps(),originalMaps);
  record('Generating a different candidate stages a replacement; declining preserves the exact previous approved review and native evidence');
  await page.locator('#analysisCreateCandidates').click();await idle();await page.locator('#analysisAcceptReplacement').click();await idle();state=await snap();const pl=state.rois.filter(r=>r.label==='PL');assert.equal(pl.length,1);assert.equal(pl[0].kind,'polyline');assert.equal(pl[0].closed,false);assert.equal(pl[0].metadata.candidate_only,true);assert.equal(pl[0].metadata.purkinje_identity_established,false);assert.equal(state.approval,null);assert.ok(await page.locator('#analysisExport').isDisabled());const measured=await page.evaluate(()=>{const s=CerebellumAnalysis.snapshot();return AnalysisCore.measure(s.rois.find(r=>r.label==='PL'),s.metadata);});assert.equal(measured.length_px,96);assert.equal(measured.area_px2,null);assert.equal(measured.length_um,null);assert.deepEqual(await maps(),originalMaps);
  record('Opt-in PL review adds an explicitly unverified ML–GL open interface of 96 source pixels; it has no area, inferred calibration or inherited approval');
  await saved();const beforeBackup=await snap();await page.evaluate(async()=>{const b=await CerebellumAnalysis.backup.export(),p=await CerebellumAnalysis.backup.prepare(b.document,b.binaries);await CerebellumAnalysis.backup.commit(p);});await idle();assert.deepEqual((await snap()).rois,beforeBackup.rois);assert.equal((await snap()).approval,null);assert.deepEqual(await maps(),originalMaps);
  record('Validated workspace backup and restore retain candidate polygons, typed PL interface, processing provenance and both original native maps');
  const nativePage=await context.newPage();monitor(nativePage);await open(nativePage);await nativePage.locator('#analysisModel').setInputFiles(path.join(temp,'auto-roi-models.json'));await nativePage.waitForFunction(()=>!document.getElementById('analysisImage').disabled);await nativePage.locator('#analysisIncludePL').check();await nativePage.locator('#analysisAutoGenerate').check();await nativePage.locator('#analysisImage').setInputFiles(path.join(temp,'smooth.tif'));await nativePage.waitForFunction(()=>CerebellumAnalysis.snapshot()?.rois.some(r=>r.label==='PL'),null,{timeout:60000});const native=await nativePage.evaluate(()=>{const s=CerebellumAnalysis.snapshot();return{state:s,measure:AnalysisCore.measure(s.rois.find(r=>r.label==='PL'))};});assert.equal(native.state.approval,null);assert.equal(native.measure.length_px,96);assert.equal(native.measure.area_px2,null);assert.equal(native.state.original_prediction.processing.pl_candidate.total_length_px,96);assert.equal(await nativePage.locator('#analysisRasterFailure').isVisible(),false);
  record('Successful native inference also supports the opt-in open ML–GL interface without invoking approximate conversion or claiming Purkinje-cell detection');
  // Optional third head is a separately fitted synthetic forest. Exact original
  // annotation tokens remain cortical-area metadata, never asserted whole lobules.
  const threePage=await context.newPage();monitor(threePage);await open(threePage);
  const threeIdle=()=>threePage.waitForFunction(()=>!document.getElementById('analysisImage').disabled,null,{timeout:60000}),threeSnap=()=>threePage.evaluate(()=>CerebellumAnalysis.snapshot());
  await threePage.locator('#analysisModel').setInputFiles(path.join(temp,'three-head-models.json'));await threeIdle();await threePage.locator('#analysisIncludePL').check();await threePage.locator('#analysisAutoGenerate').check();await threePage.locator('#analysisImage').setInputFiles(path.join(temp,'smooth.tif'));
  await threePage.waitForFunction(()=>CerebellumAnalysis.snapshot()?.rois.filter(r=>r.label==='OTHER').length===3,null,{timeout:60000});await threeIdle();
  const threeNative=await threeSnap(),regions=threeNative.rois.filter(r=>r.label==='OTHER');assert.deepEqual(regions.map(r=>r.region).sort(),['Cop','Crus1','Sim']);
  for(const r of regions){assert.equal(r.kind,'area');assert.equal(r.metadata.model_class,'LOBULE_'+r.region);assert.equal(r.metadata.anatomy_scope,'ML+GL annotated cortical subregions; not whole lobule');}
  assert.deepEqual(threeNative.original_prediction.processing.heads.map(h=>h.head).sort(),['cb','layers','lobules']);assert.equal(threeNative.rois.filter(r=>r.label==='PL'&&r.kind==='polyline').length,1);assert.equal(threeNative.approval,null);assert.ok(await threePage.locator('#analysisExport').isDisabled());
  record('Three actually fitted model heads produce tissue areas, exact named cortical-region metadata and optional PL open interface through native browser inference without approval');
  await threePage.locator('#analysisClearImage').click();await threeIdle();await threePage.locator('#analysisImage').setInputFiles(path.join(temp,'fragmented.tif'));await threePage.locator('#analysisRasterFailure').waitFor({state:'visible',timeout:60000});await threeIdle();assert.equal(await threeSnap(),null);assert.equal(await threePage.locator('#analysisRasterHead option').count(),3);
  const threeMaps=()=>threePage.evaluate(async()=>{const b=await CerebellumAnalysis.backup.export(),r=b.document.failed_raster;return Promise.all([r,...r.additional_rasters].map(async item=>({head:item.metadata.head,metadata:item.metadata,bytes:Array.from(new Uint8Array(await b.binaries.get(item.labels_file.original_ref).arrayBuffer()))})));});
  const threeOriginalMaps=await threeMaps(),threeModelHash=hash(fs.readFileSync(path.join(temp,'three-head-models.json')));assert.equal(threeOriginalMaps.length,3);
  for(const m of threeOriginalMaps){const expectedBytes=fs.readFileSync(path.join(temp,m.head+'-labels.uint8'));assert.deepEqual(Buffer.from(m.bytes),expectedBytes);assert.equal(m.metadata.label_sha256,hash(expectedBytes));assert.equal(m.metadata.model.weights_sha256,threeModelHash);}
  await threePage.locator('#analysisRasterHead').selectOption('lobules');await threePage.waitForFunction(()=>document.getElementById('analysisRasterCounts').textContent.includes('LOBULE_Cop:'));
  await threePage.locator('#analysisRasterFailure details > summary').evaluate(n=>n.closest('details').open=true);await threePage.locator('#analysisCreateCandidates').click();await threeIdle();const threeCandidate=await threeSnap();assert.ok(threeCandidate,await threePage.locator('#analysisStatus').innerText());assert.equal(threeCandidate.approval,null);assert.equal(threeCandidate.rois.filter(r=>r.label==='OTHER').length,3);assert.equal(threeCandidate.rois.filter(r=>r.label==='PL').length,1);
  assert.equal(threeCandidate.original_prediction.processing.heads.length,3);for(const h of threeCandidate.original_prediction.processing.heads)assert.equal(h.candidate.changed_pixels,744);
  await threePage.evaluate(async()=>{const b=await CerebellumAnalysis.backup.export(),prepared=await CerebellumAnalysis.backup.prepare(b.document,b.binaries);await CerebellumAnalysis.backup.commit(prepared);});await threeIdle();assert.deepEqual((await threeSnap()).rois,threeCandidate.rois);assert.equal((await threeSnap()).approval,null);assert.deepEqual(await threeMaps(),threeOriginalMaps);assert.equal(await threePage.locator('#analysisRasterHead option').count(),3);
  record('Three-head fragmented inference retains exact native hashes; approximate cortical/PL candidates and all three untouched maps survive validated backup and restore');
  assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.external_requests,[]);report.pass=true;
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);report.error=String(error.stack||error);process.exitCode=1;}).finally(()=>{fs.rmSync(temp,{recursive:true,force:true});fs.writeFileSync(path.join(__dirname,'roi-candidate-browser.json'),JSON.stringify(report,null,2)+'\n');});
