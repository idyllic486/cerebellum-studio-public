/* Recovery persistence and concurrency only; synthetic bytes are not Nissl evidence. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const report={pass:false,synthetic_data:true,checks:[],page_errors:[],external_requests:[]};
const record=(name,details={})=>report.checks.push({name,pass:true,...details});
async function main(){
 const script=fs.readFileSync(path.join(__dirname,'../src/analysis_recovery_store.js'));
 const server=http.createServer((req,res)=>{if(req.url==='/analysis_recovery_store.js'){res.setHeader('Content-Type','text/javascript');res.end(script);}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Recovery store test</title><script src="/analysis_recovery_store.js"></script>');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),headless:true});
  const context=await browser.newContext(),page=await context.newPage();
  const observe=p=>{p.on('pageerror',e=>report.page_errors.push(e.message));p.on('request',r=>{if(!r.url().startsWith(origin))report.external_requests.push(r.url());});};observe(page);
  await page.goto(origin);
  assert.deepEqual(await page.evaluate(()=>AnalysisRecoveryStore.list()),[]);
  const first=await page.evaluate(async()=>{
   const bytes=new Uint8Array(32*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
   const digest=buffer=>crypto.subtle.digest('SHA-256',buffer).then(hash=>[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join(''));
   const source={name:'synthetic-32MiB.tif',sha256:await digest(bytes),width:64,height:48};
   const value={id:'session-a',source,sourceBlob:new Blob([bytes],{type:'image/tiff'}),previewBlob:new Blob(['preview'],{type:'image/png'}),predictionBlob:new Blob(['{"fixture":true}'],{type:'application/json'}),predictionName:'fixture.json',state:{metadata:{thickness_um:null},rois:[{included:false,exclusion_reason:'Synthetic tear'}],history:[{type:'fixture'}]},fields:{analysisX:'7.125',analysisExclusionReason:'Pending reason'},selection:{selected:'cb',pathIndex:0,vertexIndex:1},modelFile:new File(['model-fixture'],'model.json',{type:'application/json'})};
   const saved=await AnalysisRecoveryStore.save(value,0);value.fields.analysisX='changed after save';
   const restored=await AnalysisRecoveryStore.load('session-a');
   return {saved,sourceHash:source.sha256,restoredHash:await digest(await restored.sourceBlob.arrayBuffer()),bytes:restored.sourceBlob.size,preview:await restored.previewBlob.text(),prediction:await restored.predictionBlob.text(),model:await restored.modelFile.text(),modelName:restored.modelFile.name,fields:restored.fields,state:restored.state};
  });
  assert.equal(first.saved.revision,1);assert.equal(first.bytes,32*1024*1024);assert.equal(first.restoredHash,first.sourceHash);assert.equal(first.fields.analysisX,'7.125');assert.equal(first.state.metadata.thickness_um,null);assert.equal(first.state.rois[0].exclusion_reason,'Synthetic tear');assert.equal(first.preview,'preview');assert.equal(first.prediction,'{"fixture":true}');assert.equal(first.model,'model-fixture');assert.equal(first.modelName,'model.json');
  record('32 MiB source bytes, preview, prediction, model File, pending fields and missing/excluded values survive an atomic save',{source_bytes:first.bytes});
  await page.reload();
  const reopened=await page.evaluate(async()=>({record:await AnalysisRecoveryStore.load('session-a'),list:await AnalysisRecoveryStore.list()}));
  assert.equal(reopened.record.revision,1);assert.equal(reopened.record.fields.analysisX,'7.125');assert.deepEqual(Object.keys(reopened.list[0]).sort(),['hasReview','id','revision','source','updatedAt']);assert.equal(reopened.list[0].hasReview,true);
  record('Reload restores persisted state and the list exposes summaries without raw blobs');
  const other=await context.newPage();observe(other);await other.goto(origin);
  const compete=p=>p.evaluate(async()=>{const saved=await AnalysisRecoveryStore.load('session-a');saved.fields.analysisX=location.href;try{return {value:await AnalysisRecoveryStore.save(saved,1)};}catch(error){return {error:error.name};}});
  const writes=await Promise.all([compete(page),compete(other)]);
  assert.equal(writes.filter(x=>x.value?.revision===2).length,1);assert.equal(writes.filter(x=>x.error==='ConflictError').length,1);
  const staleDelete=await other.evaluate(async()=>{try{await AnalysisRecoveryStore.remove('session-a',1);return 'deleted';}catch(error){return error.name;}});
  assert.equal(staleDelete,'ConflictError');assert.equal((await page.evaluate(()=>AnalysisRecoveryStore.load('session-a'))).revision,2);
  record('Concurrent tabs cannot overwrite or delete a newer revision');
  const failed=await page.evaluate(async()=>{
   const before=await AnalysisRecoveryStore.load('session-a'),original=IDBObjectStore.prototype.put;
   let error;try{IDBObjectStore.prototype.put=function(){throw new DOMException('Synthetic storage quota failure','QuotaExceededError');};await AnalysisRecoveryStore.save({...before,fields:{analysisX:'must not persist'}},2);}catch(e){error=e.name;}finally{IDBObjectStore.prototype.put=original;}
   const after=await AnalysisRecoveryStore.load('session-a');return {error,revision:after.revision,unchanged:JSON.stringify(after.fields)===JSON.stringify(before.fields)};
  });
  assert.equal(failed.error,'QuotaExceededError');assert.equal(failed.revision,2);assert.equal(failed.unchanged,true);
  record('Injected quota failure aborts the transaction and preserves the previous committed revision');
  const capacity=await page.evaluate(async()=>{
   const base=await AnalysisRecoveryStore.load('session-a');base.sourceBlob=new Blob(['tiny']);base.modelFile=null;
   for(let i=1;i<AnalysisRecoveryStore.LIMITS.records;i++)await AnalysisRecoveryStore.save({...base,id:'session-'+i},0);
   let error;try{await AnalysisRecoveryStore.save({...base,id:'overflow'},0);}catch(e){error=e.name;}
   const current=await AnalysisRecoveryStore.load('session-a');const update=await AnalysisRecoveryStore.save(current,current.revision);
   return {error,count:(await AnalysisRecoveryStore.list()).length,originalExists:!!await AnalysisRecoveryStore.load('session-a'),overflow:await AnalysisRecoveryStore.load('overflow'),update};
  });
  assert.equal(capacity.error,'CapacityError');assert.equal(capacity.count,20);assert.equal(capacity.originalExists,true);assert.equal(capacity.overflow,null);assert.equal(capacity.update.revision,3);
  record('Twenty-session capacity blocks additions without eviction while existing sessions remain updatable');
  const staleList=await other.evaluate(async()=>{window.staleRecovery=await AnalysisRecoveryStore.load('session-1');return (await AnalysisRecoveryStore.list()).find(r=>r.id==='session-1');});
  const removal=await page.evaluate(async()=>{window.removedRecovery=await AnalysisRecoveryStore.load('session-1');const removed=await AnalysisRecoveryStore.remove('session-1',1);const tombstone=await new Promise((resolve,reject)=>{const q=indexedDB.open(AnalysisRecoveryStore.DB_NAME,AnalysisRecoveryStore.DB_VERSION);q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction(AnalysisRecoveryStore.STORE,'readonly'),get=tx.objectStore(AnalysisRecoveryStore.STORE).get('session-1');let value;get.onsuccess=()=>value=get.result;tx.oncomplete=()=>{db.close();resolve(value);};tx.onabort=()=>{db.close();reject(tx.error);};};});return {removed,tombstone,missing:await AnalysisRecoveryStore.load('session-1'),count:(await AnalysisRecoveryStore.list()).length};});
  assert.equal(removal.removed.removed,true);assert.equal(removal.removed.revision,2);assert.equal(removal.missing,null);assert.equal(removal.count,19);assert.deepEqual(Object.keys(removal.tombstone).sort(),['deleted','id','revision','updatedAt']);assert.equal(removal.tombstone.deleted,true);assert.equal(removal.tombstone.revision,2);
  record('Removal drops all source/review content, retains only a monotonic tombstone, and hides it from recovery load/list');
  const resetAttempt=await page.evaluate(async()=>{try{await AnalysisRecoveryStore.save(window.removedRecovery,0);return 'saved';}catch(error){return error.name;}});
  assert.equal(resetAttempt,'ConflictError');
  const reuseCapacity=await page.evaluate(async()=>{const base=await AnalysisRecoveryStore.load('session-2');await AnalysisRecoveryStore.save({...base,id:'after-removal'},0);let reviveError;try{await AnalysisRecoveryStore.save(window.removedRecovery,2);}catch(error){reviveError=error.name;}return {count:(await AnalysisRecoveryStore.list()).length,reviveError,deleted:await AnalysisRecoveryStore.load('session-1')};});
  assert.equal(reuseCapacity.count,20);assert.equal(reuseCapacity.reviveError,'CapacityError');assert.equal(reuseCapacity.deleted,null);
  record('Tombstones free active capacity; creating or reviving a session still enforces the atomic twenty-active-session bound');
  const recreated=await page.evaluate(async()=>{await AnalysisRecoveryStore.remove('after-removal',1);window.removedRecovery.fields.analysisX='new input after deletion';return AnalysisRecoveryStore.save(window.removedRecovery,2);});
  assert.equal(recreated.revision,3);
  const staleAfterRecreate=await other.evaluate(async revision=>{let deletion,write;try{await AnalysisRecoveryStore.remove('session-1',revision);deletion='deleted';}catch(error){deletion=error.name;}try{await AnalysisRecoveryStore.save(window.staleRecovery,revision);write='saved';}catch(error){write=error.name;}return {deletion,write};},staleList.revision);
  assert.deepEqual(staleAfterRecreate,{deletion:'ConflictError',write:'ConflictError'});
  await page.reload();const surviving=await page.evaluate(()=>AnalysisRecoveryStore.load('session-1'));assert.equal(surviving.revision,3);assert.equal(surviving.fields.analysisX,'new input after deletion');assert.equal(await page.evaluate(()=>AnalysisRecoveryStore.load('after-removal')),null);
  record('Delete/recreate cannot reuse a revision: a stale second tab cannot delete or overwrite the newer copy, which survives reload');
  const failedRemoval=await page.evaluate(async()=>{const before=await AnalysisRecoveryStore.load('session-2'),put=IDBObjectStore.prototype.put;let error;try{IDBObjectStore.prototype.put=function(){throw new DOMException('Synthetic tombstone quota failure','QuotaExceededError');};await AnalysisRecoveryStore.remove(before.id,before.revision);}catch(e){error=e.name;}finally{IDBObjectStore.prototype.put=put;}const after=await AnalysisRecoveryStore.load(before.id);return {error,revision:after.revision,unchanged:JSON.stringify(after.fields)===JSON.stringify(before.fields),source:await after.sourceBlob.text()};});
  assert.equal(failedRemoval.error,'QuotaExceededError');assert.equal(failedRemoval.revision,1);assert.equal(failedRemoval.unchanged,true);assert.equal(failedRemoval.source,'tiny');
  record('Failed tombstone persistence aborts deletion and retains the complete previously committed recovery');
  await page.evaluate(()=>AnalysisRecoveryStore.remove('session-3',1));
  const add=p=>p.evaluate(async id=>{const base=await AnalysisRecoveryStore.load('session-2');try{return {saved:await AnalysisRecoveryStore.save({...base,id},0)};}catch(error){return {error:error.name};}},p===page?'concurrent-a':'concurrent-b');
  const additions=await Promise.all([add(page),add(other)]);assert.equal(additions.filter(x=>x.saved?.revision===1).length,1);assert.equal(additions.filter(x=>x.error==='CapacityError').length,1);assert.equal((await page.evaluate(()=>AnalysisRecoveryStore.list())).length,20);
  record('Concurrent additions with deletion tombstones cannot exceed twenty active sessions');
  const legacyContext=await browser.newContext(),legacyPage=await legacyContext.newPage();observe(legacyPage);await legacyPage.goto(origin);
  const legacy=await legacyPage.evaluate(async()=>{const value={id:'legacy-v1',revision:7,updatedAt:'2026-01-01T00:00:00.000Z',source:{name:'legacy.tif',sha256:'a'.repeat(64),width:1,height:1},sourceBlob:new Blob(['legacy-original']),previewBlob:new Blob(['preview']),predictionBlob:null,modelFile:null,fields:{analysisX:'preserved legacy input'}};await new Promise((resolve,reject)=>{const q=indexedDB.open('cerebellum-analysis-recovery',1);q.onupgradeneeded=()=>q.result.createObjectStore('sessions',{keyPath:'id'});q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').put(value);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};};});const loaded=await AnalysisRecoveryStore.load(value.id),listed=await AnalysisRecoveryStore.list(),saved=await AnalysisRecoveryStore.save(loaded,loaded.revision),removed=await AnalysisRecoveryStore.remove(value.id,saved.revision);return {loadedRevision:loaded.revision,input:loaded.fields.analysisX,source:await loaded.sourceBlob.text(),listed:listed.length,savedRevision:saved.revision,removedRevision:removed.revision,after:await AnalysisRecoveryStore.load(value.id)};});
  assert.deepEqual(legacy,{loadedRevision:7,input:'preserved legacy input',source:'legacy-original',listed:1,savedRevision:8,removedRevision:9,after:null});await legacyContext.close();
  record('Existing version-one records without deletion metadata remain readable, editable and removable without a destructive database migration');
  const unavailable=await page.evaluate(async()=>{const descriptor=Object.getOwnPropertyDescriptor(window,'indexedDB');Object.defineProperty(window,'indexedDB',{configurable:true,value:null});try{await AnalysisRecoveryStore.list();return 'unexpected success';}catch(e){return e.name;}finally{if(descriptor)Object.defineProperty(window,'indexedDB',descriptor);else delete window.indexedDB;}});
  assert.equal(unavailable,'StorageUnavailableError');
  record('Unavailable browser storage is an explicit error rather than a false save');
  const timeout=await page.evaluate(async()=>{const original=indexedDB.open;const started=performance.now();indexedDB.open=()=>({});try{await AnalysisRecoveryStore.list();return {name:'unexpected success'};}catch(e){return {name:e.name,elapsed:performance.now()-started};}finally{indexedDB.open=original;}});
  assert.equal(timeout.name,'TimeoutError');assert.ok(timeout.elapsed>=4900&&timeout.elapsed<10000);
  record('A stalled database open rejects within the bounded timeout',{elapsed_ms:Math.round(timeout.elapsed)});
  assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.external_requests,[]);report.pass=true;
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(__dirname,'analysis-recovery-store.json'),JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
