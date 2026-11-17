/* Runs the atlas match off the main thread so the page stays responsive. Nothing is fetched or sent anywhere. */
'use strict';
importScripts('./editable_roi_core.js','./atlas_match_core.js');
/* The match compares the whole-cerebellum outline and the outline of granular layer with white matter taken together,
   as the laboratory ROI files carry it (GL+WM). A review carries GL and WM as separate layers; taken one by one their
   shared border would be counted more than once and the match would drift. So the outer outline of GL and WM together
   is traced here, at the section's own pixels, and added as GL+WM. Without the image size the layers are used as given.
   The same pass counts the pixels of each layer, which gives the section areas a volume is integrated from. */
function withCombined(outlines,width,height){const E=self.EditableROICore,is=(o,names)=>names.includes(String(o.name).toUpperCase());
 const given=outlines.some(o=>o.name==='GL+WM'),layers=outlines.filter(o=>is(o,['GL','GL_TOTAL','WM','WM_TOTAL']));
 if(!(width>0&&height>0)||!Number.isInteger(width)||!Number.isInteger(height)||width*height>E.LIMITS.pixels)return{outlines,granular_outline:given?'as given':layers.length?'layers one by one':'none',areas_px2:null};
 // One pass over the section's own pixels: bit 1 whole cerebellum, bit 2 granular layer, bit 4 white matter
 const mask=new Uint8Array(width*height),seen={1:false,2:false,4:false};
 for(const o of outlines){const bit=is(o,['CB','CB_TOTAL'])?1:is(o,['GL','GL_TOTAL'])?2:is(o,['WM','WM_TOTAL'])?4:0;if(bit){E.rasterInto(mask,width,height,o.paths,bit);seen[bit]=true;}}
 const count=[0,0,0];for(let i=0;i<mask.length;i++){const v=mask[i];if(v){if(v&1)count[0]++;if(v&2)count[1]++;if(v&4)count[2]++;}}
 const areas_px2={Cb:seen[1]?count[0]:null,GL_TOTAL:seen[2]?count[1]:null,WM:seen[4]?count[2]:null};
 if(given)return{outlines,granular_outline:'as given',areas_px2};if(!layers.length)return{outlines,granular_outline:'none',areas_px2};
 const rings=E.traceRings(mask,width,height,6);if(!rings.length)return{outlines,granular_outline:'layers one by one',areas_px2};
 return{outlines:outlines.concat([{name:'GL+WM',closed:true,paths:rings}]),granular_outline:'GL and WM together',areas_px2};}
self.onmessage=event=>{const{outlines,umPerPixel,atlas,width,height}=event.data;
 try{const input=withCombined(outlines,width,height),result=self.AtlasMatchCore.match(input.outlines,umPerPixel,atlas,{useNames:false,onProgress:(done,total)=>self.postMessage({progress:[done,total]})});
  result.granular_outline=input.granular_outline;result.areas_px2=input.areas_px2;self.postMessage({result});}
 catch(error){self.postMessage({error:String(error&&error.message||error)});}};
