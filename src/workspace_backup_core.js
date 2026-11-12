/* A bounded, local, source-preserving container across three active workspaces. */
(function(root){'use strict';
const SCHEMA='cerebellum-workspace-backup/1',NAMES=Object.freeze(['observations','analysis','study']);
const TEMPORARY_TOOL_EXCLUSIONS=Object.freeze([
 'Evidence tools: independently loaded atlas reference files',
 'Evidence tools: temporary landmark rows, observation candidates and unapplied settings',
 'Evidence tools: pairing input files, exclusion rows and prepared pairs not installed in Study',
 'Evidence-tool reports; download them separately with Download evidence report'
]);
const fail=message=>{throw Error(message);};
function adapters(){const all={observations:root.CerebellumResearch?.backup,analysis:root.CerebellumAnalysis?.backup,study:root.CerebellumStudy?.backup};for(const name of NAMES)if(!all[name]||!['export','prepare','checkpoint','commit','hasWork'].every(key=>typeof all[name][key]==='function'))fail('Workspace backup tools are not ready. Wait for the page to finish loading.');return all;}
async function capture(all=adapters()){
 const workspaces={},originals=new Map(),included=[],missing=['Example annotations and their separate review history','Unattached files, other browser recovery versions and server or cloud backups',...TEMPORARY_TOOL_EXCLUSIONS],requirements=[];
 for(const name of NAMES){const result=await all[name].export();if(!result||!(result.binaries instanceof Map)||!Array.isArray(result.included)||!Array.isArray(result.missing))fail('Invalid workspace backup adapter result.');workspaces[name]=result.document;included.push(...result.included);missing.push(...result.missing);requirements.push(...(result.requirements||[]));for(const[path,blob]of result.binaries){if(!(blob instanceof Blob))fail('Workspace originals must be binary files.');const previous=originals.get(path);if(previous&&previous.size!==blob.size)fail('Conflicting original file references across workspaces.');originals.set(path,blob);}}
 const references=requirements.map(item=>({...item,included:originals.has('originals/'+String(item.sha256).toLowerCase())}));
 for(const item of references)if(!item.included)missing.push(item.role+': '+item.name+' · SHA-256 '+item.sha256);
 const document={schema:SCHEMA,created_at:new Date().toISOString(),workspaces,scope:{included:[...new Set(included)],missing:[...new Set(missing)],source_references:references,approval_policy:'Imported approvals remain history. Fresh human review and approval are required.',source_bytes_included:[...originals.values()].reduce((n,b)=>n+b.size,0)}};
 const written=await root.ResearchPackage.write(document,originals,'workspace');return {...written,document};
}
async function prepare(blob,all=adapters()){
 const pack=await root.ResearchPackage.read(blob),doc=pack.document;
 if(pack.manifest.kind!=='workspace'||doc.schema!==SCHEMA||!doc.workspaces||Object.keys(doc.workspaces).length!==NAMES.length||!NAMES.every(n=>Object.hasOwn(doc.workspaces,n)))fail('This file is not a supported three-workspace backup.');
 if(!doc.scope||!Array.isArray(doc.scope.included)||!Array.isArray(doc.scope.missing)||JSON.stringify(pack.manifest.included)!==JSON.stringify(doc.scope.included)||JSON.stringify(pack.manifest.not_included)!==JSON.stringify(doc.scope.missing))fail('The workspace scope does not match its manifest.');
 const prepared={};for(const name of NAMES)prepared[name]=await all[name].prepare(doc.workspaces[name],pack.originals);
 return {prepared,document:doc,manifest:pack.manifest,blob};
}
async function restore(preparation,all=adapters(),archiveStore=root.WorkspaceBackupStore){
 if(!preparation?.prepared||!(preparation.blob instanceof Blob))fail('Validate a workspace backup before restoring it.');
 const old=await capture(all),checkpoints=[],rollbackErrors=[];let archives=null,commitStarted=false;
 try{
  for(const name of NAMES)checkpoints.push({name,value:await all[name].checkpoint()});
  // A single IndexedDB transaction preserves both immutable archives before any live commit.
  archives=await archiveStore.preserve(old.blob,preparation.blob);
  for(const name of NAMES){commitStarted=true;await all[name].commit(preparation.prepared[name]);}
  return {archives,scope:preparation.document.scope};
 }catch(error){
  // Checkpoints preserve existing records but do not replace live work. Avoid
  // reinstalling anything when a stale revision or archive quota stops us first.
  if(commitStarted)for(const {name,value}of [...checkpoints].reverse())try{await value.rollback();}catch(rollbackError){rollbackErrors.push({workspace:name,message:rollbackError.message});}
  error.workspaceRollbackErrors=rollbackErrors;error.workspaceArchives=archives;
  throw error;
 }finally{for(const {value}of checkpoints)try{await value.release?.();}catch{/* Safety archives remain available even when a lock release fails. */}}
}
const api=Object.freeze({SCHEMA,NAMES,TEMPORARY_TOOL_EXCLUSIONS,adapters,capture,prepare,restore});root.WorkspaceBackupCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
