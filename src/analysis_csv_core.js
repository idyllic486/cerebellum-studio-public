/* Source CSV context. No imported number replaces derived polygon measurements. */
(function(root){'use strict';
const SCHEMA='cerebellum-measurement-csv/1',LIMITS=Object.freeze({bytes:2*1024*1024,rows:10000,columns:128});
const fail=message=>{throw Error(message);},normal=s=>s.trim().toLowerCase().replace(/[\s_-]/g,'');
function research(){return root.ResearchCore||(typeof require==='function'?require('./research_core.js'):null);}
function validate(value){
 if(!value||value.schema!==SCHEMA||!value.file||typeof value.file.name!=='string'||!value.file.name||value.file.name.length>1024||!/^[a-f0-9]{64}$/.test(value.file.sha256)||!Number.isSafeInteger(value.file.size)||value.file.size<1||value.file.size>LIMITS.bytes)fail('Invalid original measurement CSV evidence.');
 if(!Array.isArray(value.headers)||value.headers.length>LIMITS.columns||!value.headers.every(x=>typeof x==='string')||!Array.isArray(value.rows)||value.rows.length>LIMITS.rows||value.rows.some(r=>!Array.isArray(r)||r.length>LIMITS.columns||!r.every(x=>typeof x==='string')))fail('Measurement CSV exceeds the supported rows or columns.');
 if(new TextEncoder().encode(JSON.stringify(value)).length>4*1024*1024)fail('Measurement CSV parsed data exceeds 4 MiB.');return value;
}
function parse(text,file){const parsed=research().parseCSV(text);return validate({schema:SCHEMA,file:{...file},...parsed});}
function metric(header){
 const key=header.trim().toLowerCase().replace(/[μµ]/g,'u').replace(/²/g,'2').replace(/[\s_()[\]^]/g,'');
 return ({areapx2:{key:'area_px2',unit:'px²'},areaum2:{key:'area_um2',unit:'µm²'},perimeterpx:{key:'perimeter_px',unit:'px'},perimeterum:{key:'perimeter_um',unit:'µm'},lengthpx:{key:'length_px',unit:'px'},lengthum:{key:'length_um',unit:'µm'},pointcount:{key:'point_count',unit:'count'}})[key]||null;
}
function compare(reference,state,measure){
 validate(reference);const ids=reference.headers.map((h,i)=>normal(h)==='roiid'?i:-1).filter(i=>i>=0),names=reference.headers.map((h,i)=>['roi','roiname','name','label'].includes(normal(h))?i:-1).filter(i=>i>=0),columns=ids.length?ids:names,index=columns.length===1?columns[0]:null,ambiguousColumns=ids.length>1||names.length>1;
 const metricCounts=new Map();for(const h of reference.headers){const m=metric(h);if(m)metricCounts.set(m.key,(metricCounts.get(m.key)||0)+1);}const aliases=new Map();function add(name,id){if(!name)return;if(!aliases.has(name))aliases.set(name,new Set());aliases.get(name).add(id);}
 for(const roi of state.rois){add(roi.id,roi.id);add(roi.name,roi.id);add(roi.label+'_'+roi.id,roi.id);for(const source of state.original_prediction.names||[])if(source.id===roi.id)add(source.name,roi.id);}
 const conflicts=new Set(),matches=reference.rows.map((row,i)=>{
  if(index===null||ambiguousColumns)return[];
  // An explicit ROI ID denotes an ID, not a loosely interchangeable name. A
  // second stated name must resolve to that same ROI before comparison is safe.
  const found=ids.length?state.rois.filter(r=>r.id===row[index]).map(r=>r.id):[...(aliases.get(row[index])||[])];
  if(ids.length&&names.length&&row[names[0]]!==undefined&&row[names[0]]!==''){
   const named=[...(aliases.get(row[names[0]])||[])];if(named.length!==1||found.length!==1||named[0]!==found[0])conflicts.add(i);
  }
  return found;
 }),counts=new Map();for(const ids of matches)if(ids.length===1)counts.set(ids[0],(counts.get(ids[0])||0)+1);
 return reference.rows.map((row,i)=>{
  const matched=matches[i],ambiguous=index===null||ambiguousColumns||conflicts.has(i)||matched.length>1||matched.length===1&&counts.get(matched[0])>1,roi=!ambiguous&&matched.length===1?state.rois.find(r=>r.id===matched[0]):null,measured=roi?.included?measure(roi,state.metadata):null;
  const values=reference.headers.flatMap((header,column)=>{const m=metric(header);if(!m)return[];const raw=column<row.length?row[column]:null,numeric=raw===null?null:research().numericCell(raw),reviewed=metricCounts.get(m.key)===1?(measured?.[m.key]??null):null;return[{column,header,unit:m.unit,source_raw:raw,source_numeric:numeric,ambiguity:metricCounts.get(m.key)>1?'duplicate_metric_columns':null,reviewed_value:reviewed,difference:numeric!==null&&reviewed!==null?reviewed-numeric:null}];});
  return {row:i+1,source_roi_name:index===null?null:(row[index]??null),roi_id:roi?.id??null,status:ambiguous?'ambiguous':!roi?'unmatched':!roi.included?'excluded':!values.length?'no_explicit_units':values.some(v=>v.difference!==null)?'compared':'missing_or_uncalibrated',values};
 });
}
const api=Object.freeze({SCHEMA,LIMITS,parse,validate,compare});root.AnalysisCSVCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
