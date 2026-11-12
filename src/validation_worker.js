'use strict';
importScripts('./validation_core.js');
self.onmessage=async({data})=>{
  const id=data?.id??null;
  try {
    if(data?.operation==='splits')self.postMessage({id,result:ValidationCore.checkSplits(data.study)});
    else if(data?.operation==='evaluate'||data?.operation===undefined)self.postMessage({id,result:await ValidationCore.evaluateBundle(data.bundle,data.options)});
    else throw Error('Unsupported validation operation.');
  } catch(error) {self.postMessage({id,error:error.message});}
};
