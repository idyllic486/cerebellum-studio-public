'use strict';
importScripts('./reconstruction_core.js');
let prepared=null;
self.onmessage=({data})=>{const request_id=data?.request_id;try{let result;if(data.operation==='cut'){if(!prepared)throw Error('Reconstruct a physical series before requesting a cut.');result=ReconstructionCore.cutPrepared(prepared,data.z_um);}else if(data.operation==='reconstruct'||data.operation===undefined){prepared=null;const next=ReconstructionCore.prepare(data.series,data.options);result=ReconstructionCore.meshPrepared(next);prepared=next;}else throw Error('Unsupported reconstruction operation.');self.postMessage({request_id,result});}catch(e){self.postMessage({request_id,error:e.message});}};
