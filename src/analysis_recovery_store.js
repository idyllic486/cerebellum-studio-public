/* Browser-local recovery; no source or review data leave this origin.
 * Compare-and-swap revisions prevent tabs from overwriting newer work.
 */
(function(root){
'use strict';
const DB_NAME='cerebellum-analysis-recovery',STORE='sessions',DB_VERSION=1;
const LIMITS=Object.freeze({records:20,sourceBytes:256*1024*1024,previewBytes:32*1024*1024,predictionBytes:48*1024*1024,modelBytes:64*1024*1024,timeoutMs:5000});
function failure(name,message){const error=new Error(message);error.name=name;return error;}
function validId(id){if(typeof id!=='string'||!id.trim()||id.length>128)throw failure('ValidationError','Invalid recovery record identity.');}
function validRevision(revision){if(!Number.isSafeInteger(revision)||revision<0)throw failure('ValidationError','Invalid recovery revision.');}
const active=record=>!!record&&record.deleted!==true;
function blob(value,limit,name,optional=false){
 if(optional&&(value===null||value===undefined))return;
 if(!(value instanceof root.Blob)||!value.size||value.size>limit)throw failure('ValidationError','Invalid or oversized recovery '+name+'.');
}
function validate(record){
 if(!record||typeof record!=='object')throw failure('ValidationError','Invalid recovery record.');
 validId(record.id);
 const source=record.source;
 if(!source||typeof source.name!=='string'||!source.name||source.name.length>1024||!(/^[a-f0-9]{64}$/i).test(source.sha256)||!Number.isInteger(source.width)||source.width<1||source.width>32767||!Number.isInteger(source.height)||source.height<1||source.height>32767)throw failure('ValidationError','Invalid recovery source metadata.');
 blob(record.sourceBlob,LIMITS.sourceBytes,'source TIFF');
 blob(record.previewBlob,LIMITS.previewBytes,'preview');
 blob(record.predictionBlob,LIMITS.predictionBytes,'prediction',true);
 blob(record.modelFile,LIMITS.modelBytes,'model',true);
}
function open(){
 return new Promise((resolve,reject)=>{
  let request,settled=false;
  const finish=(error,db)=>{if(settled){if(db)db.close();return;}settled=true;clearTimeout(timer);if(error)reject(error);else resolve(db);};
  const timer=setTimeout(()=>finish(failure('TimeoutError','Local recovery storage did not open in time.')),LIMITS.timeoutMs);
  try{
   if(!root.indexedDB)throw failure('StorageUnavailableError','Local recovery storage is unavailable in this browser.');
   request=root.indexedDB.open(DB_NAME,DB_VERSION);
   request.onupgradeneeded=()=>{if(settled){request.transaction.abort();return;}if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'id'});};
   request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();finish(null,db);};
   request.onerror=()=>finish(request.error||failure('StorageUnavailableError','Local recovery storage could not be opened.'));
   request.onblocked=()=>finish(failure('BlockedError','Local recovery storage is blocked by another open tab. Close that tab and retry.'));
  }catch(error){finish(error);}
 });
}
async function transaction(mode,run){
 const db=await open();
 return new Promise((resolve,reject)=>{
  let tx,result,customError,settled=false;
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);db.close();if(error)reject(error);else resolve(result);};
  const abort=error=>{customError=error;try{tx.abort();}catch{finish(error);}};
  const safe=callback=>(...args)=>{try{callback(...args);}catch(error){abort(error);}};
  const timer=setTimeout(()=>{const error=failure('TimeoutError','Local recovery storage did not finish in time.');if(tx)abort(error);finish(error);},LIMITS.timeoutMs);
  try{
   tx=db.transaction(STORE,mode);
   tx.oncomplete=()=>finish();
   tx.onabort=()=>finish(customError||tx.error||failure('AbortError','Local recovery storage was interrupted.'));
   tx.onerror=()=>{ /* Abort is authoritative; never report a request as saved. */ };
   run(tx.objectStore(STORE),value=>{result=value;},abort,safe);
  }catch(error){if(tx)abort(error);else finish(error);}
 });
}
async function list(){
 return transaction('readonly',(store,done,abort,safe)=>{
  const request=store.getAll();
  request.onsuccess=safe(()=>done(request.result.filter(active).map(record=>({id:record.id,revision:record.revision,updatedAt:record.updatedAt,source:record.source,hasReview:!!record.state})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))));
 });
}
async function load(id){validId(id);return transaction('readonly',(store,done,abort,safe)=>{const request=store.get(id);request.onsuccess=safe(()=>done(active(request.result)?request.result:null));});}
async function save(record,expectedRevision){
 validate(record);validRevision(expectedRevision);
 // Snapshot metadata before awaiting storage; Blob bytes remain immutable.
 const snapshot=structuredClone(record);delete snapshot.deleted;
 return transaction('readwrite',(store,done,abort,safe)=>{
  const request=store.get(snapshot.id);
  request.onsuccess=safe(()=>{
   const current=request.result;
   if((current?.revision||0)!==expectedRevision){abort(failure('ConflictError','This recovery record changed in another tab. Restore the newer copy before saving.'));return;}
   if(expectedRevision===Number.MAX_SAFE_INTEGER){abort(failure('ValidationError','Recovery revision limit reached.'));return;}
   const write=()=>{const metadata={id:snapshot.id,revision:expectedRevision+1,updatedAt:new Date().toISOString()};store.put({...snapshot,...metadata});done(metadata);};
   if(active(current)){write();return;}
   // Deleted identities retain their revision but do not consume an active slot.
   // Count and write in this transaction so concurrent additions cannot exceed the bound.
   let count=0;const cursor=store.openCursor();
   cursor.onsuccess=safe(()=>{const row=cursor.result;if(!row){write();return;}if(active(row.value)&&++count>=LIMITS.records){abort(failure('CapacityError','Local recovery contains 20 sessions. Download and remove an older session before saving another.'));return;}row.continue();});
  });
 });
}
async function remove(id,expectedRevision){
 validId(id);validRevision(expectedRevision);
 return transaction('readwrite',(store,done,abort,safe)=>{
  const request=store.get(id);
  request.onsuccess=safe(()=>{
   const current=request.result;
   if((current?.revision||0)!==expectedRevision){abort(failure('ConflictError','This recovery record changed in another tab. Refresh the recovery list before removing it.'));return;}
   if(expectedRevision===Number.MAX_SAFE_INTEGER){abort(failure('ValidationError','Recovery revision limit reached.'));return;}
   // Keep only identity/version metadata. Reusing revision 1 after deletion would
   // let an old tab delete or overwrite a newer recovery copy (the ABA problem).
   const metadata={id,revision:expectedRevision+1,updatedAt:new Date().toISOString()};
   store.put({...metadata,deleted:true});
   done({...metadata,removed:active(current)});
  });
 });
}
const api=Object.freeze({DB_NAME,DB_VERSION,STORE,LIMITS,list,load,save,remove});
root.AnalysisRecoveryStore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
