/* Runs the atlas match off the main thread so the page stays responsive. Nothing is fetched or sent anywhere. */
'use strict';
importScripts('./atlas_match_core.js');
self.onmessage=event=>{const{outlines,umPerPixel,atlas}=event.data;
 try{const result=self.AtlasMatchCore.match(outlines,umPerPixel,atlas,{useNames:false,onProgress:(done,total)=>self.postMessage({progress:[done,total]})});self.postMessage({result});}
 catch(error){self.postMessage({error:String(error&&error.message||error)});}};
