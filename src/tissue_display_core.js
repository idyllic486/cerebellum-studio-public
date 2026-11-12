/* Display-only separation of a declared whole-layer contour and regional annotations.
 * No union, stitching, filling, coordinate changes or measurements happen here.
 */
(function(root){
  'use strict';
  const LAYERS=Object.freeze(['CB','ML','GL','WM','PL']);
  function layerOf(roi){
    return /^(CB|ML|GL|WM|PL)(?:[_\s.-]|$)/i.exec(String(roi?.name??'').trim())?.[1].toUpperCase()||'other';
  }
  const isIncluded=roi=>roi.included!==false;
  const canBeLayer=(roi,layer)=>layer==='PL'?roi.kind==='polyline':roi.kind==='area'&&roi.closed===true;
  function isVisible(item,{layer='all',showRegions=false}={}){
    return item.role!=='excluded'&&(layer==='all'||item.layer===layer)&&(item.role!=='regional'||showRegions===true);
  }
  function plan(rois,options={}){
    if(!Array.isArray(rois))throw Error('Display planning requires a source ROI array.');
    if(options.layer!==undefined&&!['all',...LAYERS,'other'].includes(options.layer))throw Error('Unknown display layer.');
    const items=rois.map((roi,index)=>({index,name:String(roi.name??''),layer:layerOf(roi),role:isIncluded(roi)?'source':'excluded'})),layers=[];
    for(const layer of LAYERS){
      const candidates=items.filter(item=>item.layer===layer&&item.role!=='excluded');
      const total=candidates.filter(item=>item.name.trim().toUpperCase()===layer+'_TOTAL'&&canBeLayer(rois[item.index],layer));
      const exact=candidates.filter(item=>item.name.trim().toUpperCase()===layer&&canBeLayer(rois[item.index],layer));
      let selected=null,status='missing';
      if(total.length===1){selected=total[0];status='total';}
      else if(total.length>1)status='ambiguous';
      else if(exact.length===1){selected=exact[0];status='exact';}
      else if(exact.length>1)status='ambiguous';
      else if(candidates.length)status='fragments';
      if(selected)for(const item of candidates)item.role=item===selected?'layer':'regional';
      const regional=candidates.filter(item=>item.role==='regional');
      layers.push(Object.freeze({layer,status,selected_index:selected?.index??null,selected_name:selected?.name??null,source_count:candidates.length,regional_count:regional.length,regional_names:Object.freeze(regional.map(item=>item.name)),excluded_count:items.filter(item=>item.layer===layer&&item.role==='excluded').length}));
    }
    for(const item of items){item.visible=isVisible(item,options);Object.freeze(item);}
    return Object.freeze({items:Object.freeze(items),layers:Object.freeze(layers),measurement_role:'none',source_coordinates_changed:false});
  }
  const api=Object.freeze({LAYERS,layerOf,plan,isVisible});
  root.TissueDisplayCore=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
