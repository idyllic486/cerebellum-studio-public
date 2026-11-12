/* Study workspace recovery; JSON evidence and pending fields stay on this origin.
 * Original TIFF / ROI / CSV bytes are not embedded by the Study format.
 * Compare-and-swap revisions prevent tabs from overwriting newer work.
 */
(function(root){
'use strict';
const DB_NAME='cerebellum-study-recovery',STORE='sessions',DB_VERSION=1;
const LIMITS=Object.freeze({records:20,jsonBytes:256*1024*1024,timeoutMs:5000});
function failure(name,message){const error=new Error(message);error.name=name;return error;}
function validId(id){if(typeof id!=='string'||!id.trim()||id.length>128)throw failure('ValidationError','Invalid recovery record identity.');}
function validRevision(revision){if(!Number.isSafeInteger(revision)||revision<0)throw failure('ValidationError','Invalid recovery revision.');}
function validate(record){
 if(!record||typeof record!=='object')throw failure('ValidationError','Invalid study recovery record.');
 validId(record.id);
 if(record.schema!=='cerebellum-study-recovery/1'||!record.study||record.study.schema!=='cerebellum-study/1'||!Array.isArray(record.study.animals)||typeof record.study.title!=='string')throw failure('ValidationError','Unsupported study recovery format.');
 if(!record.fields||typeof record.fields!=='object'||Array.isArray(record.fields)||!Array.isArray(record.pending)||record.pending.some(v=>!['metadata','protocol'].includes(v)))throw failure('ValidationError','Invalid study recovery fields.');
 const walk=(value,depth=0)=>{if(depth>45)throw failure('ValidationError','Study recovery data are too deeply nested.');if(typeof value==='number'&&!Number.isFinite(value))throw failure('ValidationError','Study recovery contains a non-finite number.');if(value&&typeof value==='object'){if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw failure('ValidationError','Study recovery must contain JSON values.');for(const key of Object.keys(value)){if(['__proto__','constructor','prototype'].includes(key))throw failure('ValidationError','Unsafe study recovery key.');walk(value[key],depth+1);}}else if(value!==null&&!['string','number','boolean'].includes(typeof value))throw failure('ValidationError','Study recovery must contain JSON values.');};
 walk(record);
 if(new TextEncoder().encode(JSON.stringify(record)).length>LIMITS.jsonBytes)throw failure('ValidationError','Study recovery exceeds 256 MiB. Download smaller study and result files separately.');
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
  request.onsuccess=safe(()=>done(request.result.map(record=>({id:record.id,revision:record.revision,updatedAt:record.updatedAt,title:record.study.title,animals:record.study.animals.length,sections:record.study.animals.reduce((n,a)=>n+(a.sections?.length||0),0),pending:record.pending.length,kind:record.kind||'autosave'})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))));
 });
}
async function load(id){validId(id);return transaction('readonly',(store,done,abort,safe)=>{const request=store.get(id);request.onsuccess=safe(()=>done(request.result||null));});}
async function save(record,expectedRevision){
 validate(record);validRevision(expectedRevision);
 // Snapshot before awaiting storage so later edits cannot change the committed revision.
 const snapshot=structuredClone(record);
 return transaction('readwrite',(store,done,abort,safe)=>{
  const request=store.get(snapshot.id);
  request.onsuccess=safe(()=>{
   const current=request.result;
   if((current?.revision||0)!==expectedRevision){abort(failure('ConflictError','This recovery record changed in another tab. Restore the newer copy before saving.'));return;}
   if(expectedRevision===Number.MAX_SAFE_INTEGER){abort(failure('ValidationError','Recovery revision limit reached.'));return;}
   const write=()=>{const metadata={id:snapshot.id,revision:expectedRevision+1,updatedAt:new Date().toISOString()};store.put({...snapshot,...metadata});done(metadata);};
   if(current){write();return;}
   const count=store.count();
   count.onsuccess=safe(()=>{if(count.result>=LIMITS.records){abort(failure('CapacityError','Local recovery contains 20 study versions. Download and remove an older version before saving another.'));return;}write();});
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
   if(current)store.delete(id);
   done({id,removed:!!current});
  });
 });
}
const api=Object.freeze({DB_NAME,DB_VERSION,STORE,LIMITS,validate,list,load,save,remove});
root.StudyRecoveryStore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
