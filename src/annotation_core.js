/* Validated annotation format; shared by the browser and Node verification. */
((scope)=>{'use strict';
 const STATUSES={unverified:'Unverified',candidate:'Atlas-based candidate',confirmed:'Observation-confirmed'};
 const GEOMETRIES={point:1,polyline:2,polygon:3};
 function validateRecord(a,reference){
  if(!a||typeof a!=='object')throw Error('Invalid annotation format.');
  const s=reference.sections[a.section_id];if(!s)throw Error('Unknown section.');
  if(typeof a.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(a.id))throw Error('Invalid annotation ID');
  if(a.source_roi_sha256!==s.roi_sha256)throw Error('The annotation refers to a different source ROI.');
  if(!reference.terms.some(t=>t.id===a.term_id))throw Error('Unregistered anatomical term.');
  if(!Object.hasOwn(STATUSES,a.status)||!Object.hasOwn(GEOMETRIES,a.geometry))throw Error('Invalid status or geometry');
  if(!Array.isArray(a.points_px)||a.points_px.length<GEOMETRIES[a.geometry]||a.points_px.length>5000||(a.geometry==='point'&&a.points_px.length!==1))throw Error('Check the number of points required for this geometry.');
  for(const p of a.points_px)if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<0||p[0]>s.width||p[1]<0||p[1]>s.height)throw Error('A point lies outside the source image.');
  if(a.geometry!=='point'&&new Set(a.points_px.map(p=>p.join(','))).size<GEOMETRIES[a.geometry])throw Error('Specify distinct points.');
  if(a.geometry==='polygon'){let area=0;for(let i=0;i<a.points_px.length;i++){const p=a.points_px[i],q=a.points_px[(i+1)%a.points_px.length];area+=p[0]*q[1]-q[0]*p[1];}if(Math.abs(area)<1)throw Error('The region has zero area. Please specify the points again.');}
  for(const k of ['note','evidence','reviewer'])if(typeof a[k]!=='string'||a[k].length>4000)throw Error('Invalid note format');
  if(a.status==='confirmed'&&(!a.reviewer.trim()||!a.evidence.trim()))throw Error('Observation-confirmed annotations require a reviewer and supporting evidence.');
  if(a.status==='candidate'&&(a.term_id==='unassigned'||!a.evidence.trim()||!a.reference_figure))throw Error('Atlas candidates require a term, a reference plate and supporting evidence.');
  if(a.reference_figure!==null&&![101,113,123].includes(a.reference_figure))throw Error('Invalid reference plate');
  if(typeof a.deleted!=='boolean'||!Array.isArray(a.history)||a.history.length>500)throw Error('Invalid history format');
  for(const key of ['created_at','updated_at'])if(typeof a[key]!=='string'||!Number.isFinite(Date.parse(a[key])))throw Error('Invalid date format');
  if(a.source_feature_id!==undefined&&a.source_feature_id!==null){const f=reference.source_features?.[a.source_feature_id];if(!f||f.section_id!==a.section_id||f.source_roi_sha256!==a.source_roi_sha256)throw Error('The source ROI link does not match.');}
  // Return only supported keys; arbitrary imported fields never enter the live model.
  return Object.fromEntries(['id','section_id','term_id','geometry','points_px','status','reviewer','note','evidence','origin','source_roi_sha256','reference_figure','created_at','updated_at','deleted','history','source_feature_id'].map(k=>[k,JSON.parse(JSON.stringify(a[k]??null))]));
 }
 function envelope(records,reference){return {schema:'cerebellum-annotations/1',specimen:reference.specimen,coordinate_system:'original_montage_pixels_xy',exported_at:new Date().toISOString(),source_hashes:Object.fromEntries(Object.entries(reference.sections).map(([id,s])=>[id,s.roi_sha256])),annotations:records};}
 function parseEnvelope(raw,reference){
  if(typeof raw!=='string'||raw.length>4*1024*1024)throw Error('Select an annotation JSON file of 4 MB or less.');
  const e=JSON.parse(raw);if(e.schema!=='cerebellum-annotations/1'||typeof reference.specimen!=='string'||e.specimen!==reference.specimen||e.coordinate_system!=='original_montage_pixels_xy')throw Error('Incompatible specimen or coordinate system.');
  if(!e.source_hashes||!Array.isArray(e.annotations)||e.annotations.length>2000)throw Error('Invalid annotation bundle format');
  for(const [id,s] of Object.entries(reference.sections))if(e.source_hashes[id]!==s.roi_sha256)throw Error('The source ROI fingerprint does not match.');
  const ids=new Set();return e.annotations.map(a=>{const r=validateRecord(a,reference);if(ids.has(r.id))throw Error('Duplicate IDs are present.');ids.add(r.id);return r;});
 }
 function merge(existing,incoming){const byId=new Map(existing.map(r=>[r.id,r]));for(const r of incoming){if(byId.has(r.id)&&JSON.stringify(byId.get(r.id))!==JSON.stringify(r))throw Error('A revised version with the same ID exists. Export the current work first, then use ‘Replace all’.');byId.set(r.id,r);}return [...byId.values()];}
 // Display-only English labels for Korean strings stored in the hashed source data; the data themselves are unchanged.
 const DATA_LABELS={"명칭 미지정":"Term not assigned","소엽":"Lobule","심부핵":"Deep nucleus","열구":"Fissure","원자료 명칭":"Source-data term","탐색":"Exploratory","원본 ROI 명칭. 별칭 또는 해부학적 대응은 별도 검토.":"Source ROI term. Aliases and anatomical correspondence require separate review.","원본에서 위치만 표시한 탐색 주석":"Exploratory annotation marking only a position on the source","CB 윤곽의 convexity defect; 형태 탐색용 후보이며 도감 정합 결과가 아님.":"Convexity defect of the CB contour; a candidate for morphological exploration, not a result of atlas registration.","CB 외곽의 큰 함몰에서 자동 제안한 점. 열구 여부와 해부학적 명칭은 미확인.":"Point proposed automatically at a large indentation of the CB outline. Whether it is a fissure, and its anatomical term, are unconfirmed.","PL 경로 길이 미확인: 면적형/결측/0 또는 ROI 없음":"PL path length unconfirmed: area type, missing, zero or no ROI","원본 polyline 경로":"Source polyline path","1Cb · 벌레 소엽":"1Cb · vermian lobule","2Cb · 벌레 소엽":"2Cb · vermian lobule","3Cb · 벌레 소엽":"3Cb · vermian lobule","4/5Cb · 벌레 소엽":"4/5Cb · vermian lobule","6Cb · 벌레 소엽":"6Cb · vermian lobule","7Cb · 벌레 소엽":"7Cb · vermian lobule","8Cb · 벌레 소엽":"8Cb · vermian lobule","9Cb · 벌레 소엽":"9Cb · vermian lobule","10Cb · 벌레 소엽":"10Cb · vermian lobule","FI · 원자료 표기":"FI · source-data label","Fl · 원자료 표기":"Fl · source-data label","PFI · 원자료 표기":"PFI · source-data label","icf · 원자료 표기":"icf · source-data label","pcn · 원자료 표기":"pcn · source-data label"};
 function label(s){return typeof s==='string'&&Object.prototype.hasOwnProperty.call(DATA_LABELS,s)?DATA_LABELS[s]:s;}
 function toDisplay(p,section,scale){return [(p[0]-section.centroid_px[0])/scale,-(p[1]-section.centroid_px[1])/scale];}
 scope.AnnotationCore={STATUSES,validateRecord,envelope,parseEnvelope,merge,toDisplay,label};
})(typeof module==='object'?module.exports:window);
