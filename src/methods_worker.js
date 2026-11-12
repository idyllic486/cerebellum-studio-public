'use strict';
importScripts('./methods_core.js');
self.onmessage=({data})=>{try{self.postMessage({result:MethodsCore.run(data.study,data.options)});}catch(e){self.postMessage({error:e.message});}};
