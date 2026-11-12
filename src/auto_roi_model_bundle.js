/* Two independently fitted tissue tasks; retain the exact selected file as evidence. */
(function(root){'use strict';
const fail=message=>{throw Error(message);};
function core(){return root.BrowserModelCore||(typeof require==='function'?require('./browser_model_core.js'):null);}
function evaluation(value,models){
 if(value===undefined)return null;
 const ids=a=>Array.isArray(a)&&a.length>0&&a.length<=500&&a.every(x=>typeof x==='string'&&x.length>0&&x.length<=101)&&new Set(a).size===a.length;
 if(!value||value.schema!=='cerebellum-sampled-animal-evaluation/1'||!ids(value.training_animals)||!ids(value.evaluation_animals)||value.evaluation_animals.some(a=>value.training_animals.includes(a))||JSON.stringify([...value.training_animals].sort())!==JSON.stringify([...models.layers.training_animals].sort())||typeof value.prior_exposure_unknown!=='boolean'||value.independent_validation_established!==false||!value.tasks)fail('Invalid sampled evaluation provenance in the model bundle.');
 const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<=1e9,close=(a,b)=>b===null?a===null:typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<1e-8;
 for(const head of Object.keys(models)){
  const task=value.tasks[head],classes=models[head].classes,m=task?.aggregate,c=m?.confusion_rows_reference_columns_prediction;
  if(!task||task.evaluation_pixels_used_for_fitting!==0||!integer(task.training_pixels)||task.training_pixels<1||!integer(m?.sample_pixels)||m.sample_pixels<1||!Array.isArray(c)||c.length!==classes.length||c.some(row=>!Array.isArray(row)||row.length!==classes.length||row.some(n=>!integer(n)))||c.flat().reduce((a,b)=>a+b,0)!==m.sample_pixels)fail('Invalid sampled evaluation counts in the model bundle.');
  if(!close(m.accuracy_on_sampled_pixels,c.reduce((s,row,i)=>s+row[i],0)/m.sample_pixels))fail('Sampled evaluation accuracy does not match its confusion matrix.');
  classes.forEach((name,i)=>{const actual=c[i].reduce((a,b)=>a+b,0),predicted=c.reduce((s,row)=>s+row[i],0),tp=c[i][i],item=m.per_class?.[name];if(!item||item.reference_sample_pixels!==actual||item.predicted_sample_pixels!==predicted||!close(item.precision,predicted?tp/predicted:null)||!close(item.recall,actual?tp/actual:null)||!close(item.dice_on_sampled_pixels,actual+predicted?2*tp/(actual+predicted):null))fail('Sampled tissue scores do not match their confusion matrix.');});
 }
 return value;
}
// A U-Net bundle yields both tissue maps from one network; classes stay declared per map.
function unetTensorNames(){const names=['o.weight','o.bias'];for(const side of ['d','u'])for(let i=0;i<(side==='d'?5:4);i++)for(const layer of [0,1,3,4])for(const part of ['weight','bias'])names.push(side+'.'+i+'.'+layer+'.'+part);return names;}
function unetShapes(base){const shapes={},width=[base,base*2,base*4,base*8,base*16];const stage=(prefix,a,b)=>{for(const [index,from]of [[0,a],[3,b]]){shapes[prefix+'.'+index+'.weight']=[b,from,3,3];shapes[prefix+'.'+index+'.bias']=[b];shapes[prefix+'.'+(index+1)+'.weight']=[b];shapes[prefix+'.'+(index+1)+'.bias']=[b];}};stage('d.0',3,width[0]);for(let i=1;i<5;i++)stage('d.'+i,width[i-1],width[i]);for(let i=0;i<4;i++)stage('u.'+i,width[i+1]+width[i],width[i]);shapes['o.weight']=[4,base,1,1];shapes['o.bias']=[4];return shapes;}
function validateUnet(value){
 const a=value.architecture,input=value.input,run=value.inference,classes=['background','ML','GL','WM'];
 if(typeof value.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value.id)||typeof value.version!=='string'||!value.version||value.version.length>100)fail('Model identity/version is missing or invalid.');
 if(a?.name!=='unet-groupnorm/1'||a.depth!==5||a.group_norm_groups!==4||![4,8,16,24,32].includes(a.base_channels)||JSON.stringify(a.classes)!==JSON.stringify(classes))fail('The U-Net architecture is unsupported.');
 if(input?.channels!=='RGB'||input.dtype!=='uint8'||JSON.stringify(input.scale)!=='[255,255,255]'||![2,4,8,16].includes(input.block_mean_factor))fail('Invalid explicit model input channels, dtype or normalization scale.');
 if(run?.upsample!=='bilinear-probabilities'||!Number.isInteger(run.tile)||!Number.isInteger(run.keep)||run.keep<64||run.tile>2048||run.tile<=run.keep||(run.tile-run.keep)%2)fail('The U-Net inference settings are invalid.');
 const animals=value.training_animals,sources=value.training_sources,sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 if(!Array.isArray(animals)||!animals.length||animals.length>500||animals.some(x=>typeof x!=='string'||!x||x.length>101)||new Set(animals).size!==animals.length)fail('Training-animal provenance is required.');
 if(!Array.isArray(sources)||!sources.length||sources.length>500||sources.some(s=>!s||!animals.includes(s.animal_id)||!sha(s.source_sha256))||new Set(sources.map(s=>s.animal_id)).size!==animals.length)fail('Training-source provenance is incomplete.');
 if(value.review_required!==true||value.independent_validation_established!==false||value.anatomical_accuracy_established!==false)fail('The U-Net bundle must declare that review is required and accuracy is not established.');
 if(!value.tensors||typeof value.tensors!=='object')fail('U-Net weights are missing.');
 const shapes=unetShapes(a.base_channels),names=Object.keys(value.tensors).sort();
 if(JSON.stringify(names)!==JSON.stringify(unetTensorNames().sort()))fail('U-Net weights do not match the declared architecture.');
 for(const name of names){const t=value.tensors[name];if(JSON.stringify(t?.shape)!==JSON.stringify(shapes[name])||typeof t.base64!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(t.base64)||Math.floor(t.base64.length/4)*3-(t.base64.endsWith('==')?2:t.base64.endsWith('=')?1:0)!==t.shape.reduce((x,y)=>x*y,4))fail('U-Net weights do not match the declared architecture.');}
 let evaluation=null;
 if(value.evaluation!=null){const e=value.evaluation,score=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1;if(e.schema!=='cerebellum-declared-whole-image-evaluation/1'||!Array.isArray(e.evaluation_animals)||!e.evaluation_animals.length||e.evaluation_animals.some(x=>typeof x!=='string'||animals.includes(x))||e.independent_validation_established!==false||!['CB','ML','GL','WM'].every(n=>score(e.dice?.[n])))fail('Invalid declared whole-image evaluation in the model bundle.');evaluation=e;}
 const head=headClasses=>({classes:headClasses,input,training_animals:animals,training_sources:sources,features:a.name});
 return {isBundle:true,family:'experimental-unet',id:value.id,version:value.version,primary:'layers',models:{cb:head(['background','CB']),layers:head(classes)},input,training_animals:animals,training_sources:sources,features:a.name,evaluation:null,whole_image_evaluation:evaluation};
}
function validate(value){
 const C=core();if(!C)fail('Local model validation is unavailable.');
 if(value?.schema==='cerebellum-auto-roi-unet/1')return validateUnet(value);
 if(value?.schema!=='cerebellum-auto-roi-models/1'){
  const model=C.validateModel(value);return {...model,isBundle:false,primary:'primary',models:{primary:model}};
 }
 if(value.primary!=='layers'||!value.models||!['cb,layers','cb,layers,lobules'].includes(Object.keys(value.models).sort().join(',')))fail('The automatic ROI bundle requires CB and tissue-layer models, with an optional named cortical-region model.');
 const cb=C.validateModel(value.models.cb),layers=C.validateModel(value.models.layers),models={cb,layers};
 if(Object.hasOwn(value.models,'lobules')){const lobules=C.validateModel(value.models.lobules);if(!lobules.classes.slice(1).every(name=>name.startsWith('LOBULE_')))fail('The optional cortical-region model has incompatible classes.');models.lobules=lobules;}
 if(JSON.stringify(cb.classes)!==JSON.stringify(['background','CB'])||JSON.stringify(layers.classes)!==JSON.stringify(['background','ML','GL','WM']))fail('The automatic ROI bundle has incompatible tissue tasks.');
 if(Object.values(models).some(model=>JSON.stringify(cb.input)!==JSON.stringify(model.input)))fail('All fitted models must use identical native image inputs.');
 const animals=model=>JSON.stringify([...model.training_animals].sort()),sources=model=>JSON.stringify(model.training_sources.map(s=>[s.animal_id,s.section_id??null,s.source_sha256]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
 if(Object.values(models).some(model=>animals(cb)!==animals(model)||sources(cb)!==sources(model)))fail('All fitted models must retain the same training animals and original images.');
 if(Object.values(models).flatMap(model=>model.trees).reduce((n,t)=>n+t.left.length,0)>C.LIMITS.nodes)fail('Combined automatic ROI model exceeds the node limit.');
 return {isBundle:true,id:models.lobules?layers.id.slice(0,70)+'-cb-layers-lobules':layers.id.slice(0,80)+'-cb-layers',version:'1.0.0',primary:'layers',models,input:layers.input,training_animals:layers.training_animals,training_sources:layers.training_sources,features:layers.features,evaluation:evaluation(value.evaluation,models)};
}
function heads(value){const checked=validate(value);return Object.entries(checked.models);}
function modelForHead(value,head){const checked=validate(value);if(!checked.isBundle){if(head!==undefined&&head!==null&&head!=='primary')fail('Invalid model head.');return checked.models.primary;}if(!Object.hasOwn(checked.models,head))fail('The retained label map must identify its model head.');return checked.models[head];}
const DB='cerebellum-selected-model',STORE='selection',DISABLED='cerebellum-model-cache-disabled';let cacheQueue=Promise.resolve();
function cacheDisabled(){try{return !root.localStorage||root.localStorage.getItem(DISABLED)==='1';}catch{return true;}}
function cacheGuard(disabled){try{if(disabled)root.localStorage?.setItem(DISABLED,'1');else root.localStorage?.removeItem(DISABLED);}catch{}}
function cache(operation){
 const task=cacheQueue.then(()=>new Promise((resolve,reject)=>{
  let request,db,tx,settled=false,result;const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);if(db)db.close();error?reject(error):resolve(result);};
  const timer=setTimeout(()=>{try{tx?.abort();}catch{}finish(Error('Browser model storage timed out.'));},5000);
  try{if(!root.indexedDB)throw Error('Browser model storage is unavailable.');request=root.indexedDB.open(DB,1);
   request.onupgradeneeded=()=>{if(settled){request.transaction.abort();return;}if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};
   request.onerror=()=>finish(request.error);request.onblocked=()=>finish(Error('Browser model storage is blocked.'));
   request.onsuccess=()=>{db=request.result;if(settled){db.close();return;}db.onversionchange=()=>db.close();try{tx=db.transaction(STORE,operation.kind==='load'?'readonly':'readwrite');const store=tx.objectStore(STORE),r=operation.kind==='load'?store.get('current'):operation.kind==='save'?store.put(operation.value,'current'):store.delete('current');r.onsuccess=()=>{result=r.result;};tx.oncomplete=()=>finish();tx.onabort=()=>finish(tx.error||Error('Browser model storage was interrupted.'));tx.onerror=()=>{};}catch(e){finish(e);}};
  }catch(e){finish(e);}
 }));cacheQueue=task.catch(()=>{});return task;
}
async function hash(blob){return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');}
async function remember(file){if(!(file instanceof root.Blob)||!file.size||file.size>core().LIMITS.modelBytes)fail('Invalid model file for browser storage.');validate(JSON.parse(await file.text()));await cache({kind:'save',value:{blob:file,name:file.name||'model.json',sha256:await hash(file)}});cacheGuard(false);}
async function recalled(){if(cacheDisabled())return null;const saved=await cache({kind:'load'});if(!saved)return null;if(!(saved.blob instanceof root.Blob)||!saved.blob.size||saved.blob.size>core().LIMITS.modelBytes||typeof saved.name!=='string'||saved.name.length>1024||await hash(saved.blob)!==saved.sha256)fail('Saved model evidence does not match.');validate(JSON.parse(await saved.blob.text()));return new File([saved.blob],saved.name,{type:'application/json'});}
const api=Object.freeze({validate,heads,modelForHead,remember,recalled,forget:()=>{cacheGuard(true);return cache({kind:'remove'});}});root.AutoROIModelBundle=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
