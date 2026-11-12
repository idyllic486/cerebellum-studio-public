/* Browser-local Study recovery. Download requests never imply that a disk write completed. */
(function(root){'use strict';
const SCHEMA='cerebellum-study-recovery/1';
function create(options){
 const $=id=>document.getElementById(id),store=root.StudyRecoveryStore;
 let active=null,version=0,savedVersion=0,timer=null,saving=null,error=null,suspended=false,listed=[],replacement=null;
 const uid=()=>root.crypto.randomUUID();
 const message=(text,state='ready')=>{$('studyRecoveryStatus').textContent=text;$('studyRecoveryStatus').dataset.state=state;};
 function controls(){const has=!!options.capture(),busy=options.busy()||!!replacement,selected=listed.find(r=>r.id===$('studyRecoveryList').value);['studyRecoveryRetry','studyRecoveryCheckpoint','studyRecoveryDownload'].forEach(id=>$(id).disabled=!has||busy);$('studyRecoveryImport').disabled=busy;$('studyRecoveryRestore').disabled=$('studyRecoveryExport').disabled=!selected||busy;$('studyRecoveryRemove').disabled=!selected||selected.id===active?.id||busy;$('studyRecoveryRefresh').disabled=busy;}
 function failure(e){error=e;message('Recovery could not be saved. Your current study is still open. Download workspace recovery, then retry browser storage. '+e.message,'error');controls();}
 function snapshot(){const value=options.capture();return value?{schema:SCHEMA,...value}:null;}
 async function refresh(){if(!store)throw Error('Study recovery storage is not loaded.');const selected=$('studyRecoveryList').value;listed=await store.list();$('studyRecoveryList').replaceChildren(...(listed.length?listed.map(r=>{const option=new Option(r.title+' · '+new Date(r.updatedAt).toLocaleString()+' · '+r.animals+' / '+r.sections+(r.pending?' · pending fields':'')+(r.id===active?.id?' · current':''),r.id);option.setAttribute('translate','no');return option;}):[new Option('No saved study versions','')]));if(listed.some(r=>r.id===selected))$('studyRecoveryList').value=selected;controls();return listed;}
 function changed(){if(suspended||!options.capture())return;version++;clearTimeout(timer);if(!error)message('Recovery changes pending. Keep this tab open until saved.','pending');timer=setTimeout(()=>flush().catch(failure),350);controls();}
 async function flush(){
  clearTimeout(timer);if(saving){await saving;return flush();}if(!snapshot())return null;if(active&&savedVersion===version&&!error)return active;
  const value=snapshot(),target=version,identity=active||{id:uid(),revision:0};
  saving=(async()=>{const saved=await store.save({...value,id:identity.id,kind:'autosave'},identity.revision);active=saved;savedVersion=target;error=null;message('Recovery saved in this browser. Keep a downloaded copy and the original files.');await refresh();return saved;})();
  try{await saving;}catch(e){failure(e);throw e;}finally{saving=null;controls();}
  if(savedVersion!==version)return flush();return active;
 }
 async function choose(title){if(!options.capture())return true;return new Promise(resolve=>{replacement=resolve;$('studyReplaceNames').textContent=options.capture().study.title+' / '+title;$('studyReplaceDialog').showModal();$('studyReplaceCancel').focus();controls();});}
 function finishChoice(yes){if(!replacement)return;const resolve=replacement;replacement=null;$('studyReplaceDialog').close();controls();resolve(yes);}
 async function replace(record,apply,{ask=true}={}){
  if(ask&&!(await choose(record.study.title)))return false;
  // The old workspace is committed before a different record is created. Neither is evicted.
  if(options.capture()){try{await flush();}catch(e){if(e.name!=='ConflictError')throw e;const preserved=await store.save({...snapshot(),id:uid(),kind:'conflict-copy'},0);active=preserved;savedVersion=version;error=null;}}
  clearTimeout(timer);const previouslySuspended=suspended;suspended=true;
  try{const saved=await store.save({schema:SCHEMA,...record,id:uid(),kind:'workspace'},0);active=saved;version=0;savedVersion=0;await apply();error=null;message('Workspace opened. The previous study remains in Saved study versions.');await refresh();return true;}
  catch(e){failure(e);throw e;}finally{suspended=previouslySuspended;controls();}
 }
 async function checkpoint(){await flush();const record=snapshot();const saved=await store.save({...record,id:uid(),kind:'checkpoint'},0);await refresh();$('studyRecoveryList').value=saved.id;controls();message('Current version preserved. Later edits stay in a separate recovery record.');}
 function download(record){const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='cerebellum-study-workspace.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);message('Workspace download requested. Check the downloaded file before relying on it; browser recovery is retained.');}
 const action=fn=>async()=>{try{await fn();}catch(e){failure(e);}};
 $('studyReplaceCancel').addEventListener('click',()=>finishChoice(false));$('studyReplaceConfirm').addEventListener('click',()=>finishChoice(true));$('studyReplaceDialog').addEventListener('cancel',e=>{e.preventDefault();finishChoice(false);});
 $('studyRecoveryRetry').addEventListener('click',action(flush));$('studyRecoveryCheckpoint').addEventListener('click',action(checkpoint));$('studyRecoveryDownload').addEventListener('click',action(()=>download(snapshot())));$('studyRecoveryRefresh').addEventListener('click',action(refresh));$('studyRecoveryList').addEventListener('change',controls);
 $('studyRecoveryRestore').addEventListener('click',action(async()=>{const record=await store.load($('studyRecoveryList').value);if(!record)throw Error('This saved version no longer exists. Refresh the version list.');await options.restore(record);}));
 $('studyRecoveryExport').addEventListener('click',action(async()=>{const record=await store.load($('studyRecoveryList').value);if(!record)throw Error('This saved version no longer exists. Refresh the version list.');download(record);}));
 $('studyRecoveryRemove').addEventListener('click',action(async()=>{const selected=listed.find(r=>r.id===$('studyRecoveryList').value);if(!selected||selected.id===active?.id)return;if(!root.confirm('Remove this saved study version? Keep a downloaded copy if you need it.'))return;await store.remove(selected.id,selected.revision);await refresh();message('Selected saved version removed. The current study is unchanged.');}));
 $('studyRecoveryImport').addEventListener('change',action(async()=>{const input=$('studyRecoveryImport'),file=input.files?.[0];try{if(!file)return;if(file.size>store.LIMITS.jsonBytes)throw Error('Workspace recovery exceeds 256 MiB.');const record=JSON.parse(await file.text());store.validate({...record,id:record.id||uid()});await options.restore(record);}finally{input.value='';}}));
 root.addEventListener('beforeunload',e=>{if(options.capture()&&(options.busy()||error||saving||savedVersion!==version||!active)){e.preventDefault();e.returnValue='';}});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&options.capture())flush().catch(failure);});
 refresh().then(list=>message(list.length?'Saved study versions are available. Restore a version to continue.':'No study recovery yet. A study is saved automatically after it is opened.')).catch(failure);
 async function pause(){clearTimeout(timer);suspended=true;await flush();if(active){const latest=await store.load(active.id);if(latest?.revision!==active.revision)throw Object.assign(Error('This study recovery changed in another tab.'),{name:'ConflictError'});}}
 async function transactionCheckpoint(){
  try{await pause();}catch(e){suspended=false;controls();throw e;}
  const previous={active:active?{...active}:null,version,savedVersion,error};
  return {rollback:async()=>{clearTimeout(timer);if(saving)await saving;active=previous.active;version=previous.version;savedVersion=previous.savedVersion;error=previous.error;suspended=true;await refresh();message(error?'Previous Study restored; retry its browser recovery.':'Previous Study and its recovery identity were restored.',error?'error':'ready');},release:()=>{suspended=false;controls();}};
 }
 return Object.freeze({changed,flush,replace,refresh,controls,pause,transactionCheckpoint,resume:()=>{suspended=false;controls();},reset:async()=>{clearTimeout(timer);active=null;version=savedVersion=0;error=null;await refresh();},state:()=>({active:active?{...active}:null,version,savedVersion,pending:!!saving||version!==savedVersion,error:error?.message||null})});
}
root.StudyRecoveryUI=Object.freeze({SCHEMA,create});
})(globalThis);
