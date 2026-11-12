/* Fixed-domain measurement sensitivity, not statistical or biological inference. */
(function(root){'use strict';
const M=typeof module==='object'&&module.exports?require('./methods_core.js'):root.MethodsCore;
const VERSION='cerebellum-sensitivity/1', METHODS=['sdf','affine'];
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const fail=m=>{throw Error(m);};
function sectionsOf(study){
  if(!study||!['index','um'].includes(study.unit)||!Array.isArray(study.sections)||study.sections.length<3||study.sections.length>24)fail('Sensitivity analysis requires 3–24 observed planes in the same coordinate system.');
  const ids=new Set(),orders=new Set(),zs=new Set();let vertices=0;
  const sections=study.sections.map(s=>{
    if(!s||typeof s.id!=='string'||!s.id||ids.has(s.id)||!Number.isSafeInteger(s.order)||s.order<0||orders.has(s.order))fail('Section IDs and orders must be unique.');
    const z=study.unit==='index'&&(s.z===null||s.z===undefined)?s.order:s.z;
    if(!finite(z)||Math.abs(z)>1e9||zs.has(z)||(study.unit==='index'&&!Number.isSafeInteger(z)))fail('Check the depth coordinates and missing values.');
    ids.add(s.id);orders.add(s.order);zs.add(z);
    const rois=s.rois===undefined?[{paths:s.paths}]:s.rois;
    if(!Array.isArray(rois)||!rois.length)fail(s.id+': no area ROI.');
    for(const r of rois){if(!r||!Array.isArray(r.paths))fail(s.id+': a valid region contour is required.');for(const p of r.paths){if(!Array.isArray(p))fail(s.id+': a valid array of boundary points is required.');vertices+=p.length;if(vertices>100000)fail('Total contours are limited to 100,000 points.');}}
    return {id:s.id,order:s.order,z,rois};
  }).sort((a,b)=>a.order-b.order);
  for(let i=1;i<sections.length;i++)if(sections[i].z<=sections[i-1].z)fail('Depth must increase with section order.');
  return sections;
}
function maskMeasure(mask,grid){
  const n=grid.size,cell=grid.spacing**2;let count=0,lower=0,upper=0,touches=false;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const v=mask[y*n+x];count+=v;
    if(v&&(x===0||y===0||x===n-1||y===n-1))touches=true;
    let any=false,all=true;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const xx=x+dx,yy=y+dy,inside=xx>=0&&xx<n&&yy>=0&&yy<n&&mask[yy*n+xx]===1;
      any=any||inside;all=all&&inside;
    }
    lower+=all?1:0;upper+=any?1:0;
  }
  return {area:count*cell,lower:touches?null:lower*cell,upper:touches?null:upper*cell};
}
function integral(profile,method,part='area'){
  const values=profile.map(p=>part==='area'?p.area[method]:p.boundary[method][part]);
  if(values.some(v=>!finite(v)))return null;
  let value=0;for(let i=1;i<profile.length;i++){
    const areaSum=values[i]+values[i-1],width=profile[i].z-profile[i-1].z,term=width*areaSum/2;
    if(!finite(term)||(width>0&&areaSum>0&&term===0)){
      const flag=finite(term)?'integral_numeric_underflow':'integral_numeric_overflow';
      if(!profile[i].flags.includes(flag))profile[i].flags.push(flag);
      return null;
    }
    value+=term;
  }
  return finite(value)?value:null;
}
const delta=(value,base)=>{if(!finite(value)||!finite(base)||base===0)return null;const change=(value-base)/base*100;return finite(change)?change:null;};
function run(study,options={}){
  const sections=sectionsOf(study),gridSize=options.gridSize===undefined?64:options.gridSize,padding=options.padding===undefined?.25:options.padding,thresholdPercent=options.thresholdPercent===undefined?5:options.thresholdPercent;
  if(![64,96].includes(gridSize))fail('The sensitivity grid is 64 or 96.');
  if(!finite(padding)||padding<.1||padding>1)fail('Grid margin is in the range 0.1–1.');
  if(!finite(thresholdPercent)||thresholdPercent<=0||thresholdPercent>1000)fail('The review threshold is a percentage greater than 0 and no more than 1,000.');
  const opts={gridSize,padding,unit:study.unit};
  // Local observed masks never change when another observation is omitted.
  const measured=new Map(sections.map(s=>[s.id,M.observe(s,opts)]));
  const mesh=sections.map(s=>s.z);
  for(let i=1;i<sections.length;i++){
    const a=sections[i-1].z,b=sections[i].z,z=study.unit==='index'?Math.floor((a+b)/2):(a+b)/2;
    if(z>a&&z<b)mesh.push(z);
  }
  mesh.sort((a,b)=>a-b);
  function profileFor(training){
    return mesh.map(z=>{
      const s=training.find(s=>s.z===z);
      if(s){const o=measured.get(s.id),valid=!o.flags.includes('observation_empty_at_grid_resolution');
        return {z,kind:'observed',id:s.id,status:valid?'scored':'unscorable',grid:o.grid,area:{sdf:valid?o.area:null,affine:valid?o.area:null},boundary:{sdf:{lower:valid?o.area_interval[0]:null,upper:valid?o.area_interval[1]:null},affine:{lower:valid?o.area_interval[0]:null,upper:valid?o.area_interval[1]:null}},flags:[...o.flags]};
      }
      try{
        const p=M.predict({unit:study.unit,sections:training},z,opts),clipped=p.flags.some(f=>['aligned_source_outside_prediction_grid','prediction_reaches_grid_boundary'].includes(f)),area={},boundary={};
        for(const method of METHODS){const v=maskMeasure(p.masks[method],p.grid);area[method]=clipped?null:v.area;boundary[method]={lower:clipped?null:v.lower,upper:clipped?null:v.upper};}
        return {z,kind:'predicted',status:clipped?'unscorable':'scored',left:p.left,right:p.right,grid:p.grid,training_ids:p.training_ids,prediction_fingerprint:p.prediction_fingerprint,area,boundary,flags:p.flags};
      }catch(e){return {z,kind:'predicted',status:'unscorable',area:{sdf:null,affine:null},boundary:{sdf:{lower:null,upper:null},affine:{lower:null,upper:null}},flags:['prediction_failed'],reason:e.message};}
    });
  }
  const profile=profileFor(sections),baseline={},boundary={};
  for(const method of METHODS){baseline[method]=integral(profile,method);const lower=integral(profile,method,'lower'),upper=integral(profile,method,'upper');boundary[method]={lower,upper,lower_delta_percent:delta(lower,baseline[method]),upper_delta_percent:delta(upper,baseline[method])};}
  const influence=sections.map((s,i)=>{
    if(i===0||i===sections.length-1)return {id:s.id,z:s.z,status:'excluded_from_influence',reason:'endpoint_removal_would_change_fixed_domain',methods:{sdf:{value:null,delta_percent:null,threshold_crossed:null},affine:{value:null,delta_percent:null,threshold_crossed:null}},flags:['fixed_span_endpoint'],rank:null};
    const trial=profileFor(sections.filter(t=>t.id!==s.id)),methods={};
    for(const method of METHODS){const value=integral(trial,method),d=delta(value,baseline[method]);methods[method]={value,delta_percent:d,threshold_crossed:d===null?null:Math.abs(d)>=thresholdPercent};}
    return {id:s.id,z:s.z,status:METHODS.every(m=>methods[m].delta_percent!==null)?'scored':'unscorable',methods,flags:[...new Set(trial.flatMap(p=>p.flags))],profile:trial,rank:null};
  });
  influence.filter(r=>r.status==='scored').sort((a,b)=>Math.max(...METHODS.map(m=>Math.abs(b.methods[m].delta_percent)))-Math.max(...METHODS.map(m=>Math.abs(a.methods[m].delta_percent)))||a.z-b.z).forEach((r,i)=>r.rank=i+1);
  return {version:VERSION,config:{grid_size:gridSize,padding,threshold_percent:thresholdPercent,threshold_interpretation:'user_selected_review_tolerance_not_biological_significance',depth_unit:study.unit,integral_unit:'input_XY_squared_times_'+study.unit,fixed_span:[mesh[0],mesh[mesh.length-1]],fixed_z_mesh:mesh,interval_widths:mesh.slice(1).map((z,i)=>z-mesh[i]),integration:'trapezoidal_observations_plus_one_interior_midpoint_per_gap',observed_grid:'per_observation_fixed_across_trials',predicted_grid:'training_bounds_per_trial',boundary_perturbation:{radius_cells:1,neighborhood:8,physical_width:'grid.spacing varies by sample; see profile',interpretation:'parameter_sensitivity_not_confidence_interval'}},baseline_status:METHODS.every(m=>finite(baseline[m]))?'scored':'unscorable',baseline,boundary,influence,method_difference_percent:delta(baseline.affine,baseline.sdf),profile,limitations:[
    'The integral is over the sampled z span only. It is not total organ volume or a biological conclusion.',
    'Units are squared input XY coordinates times the stated depth coordinate. Index depth is not physical distance.',
    'The fixed mesh contains original observed depths and at most one midpoint per gap; index gaps without an interior integer have no midpoint. This is a discretized sensitivity experiment, not a converged volume estimate.',
    'Internal exclusions replace that observation with interpolation on the same z mesh. Endpoints are not removed because extrapolation would be required.',
    'Observed samples use unchanged local grids. Predicted grids depend on remaining training bounds; sensitivity includes the resulting rasterization effect.',
    'Boundary ranges perturb output masks by one 8-neighbor grid cell at every sample. They are neither annotation uncertainty estimates nor statistical confidence intervals, and do not rerun a perturbed-contour reconstruction.',
    'An observed polygon that vanishes on its raster is unscorable. An empty prediction remains a zero-area algorithm output with an empty_prediction flag; it is not converted into a missing observation or evidence of absent tissue.',
    'Clipped predictions, failed computations, or floating-point integral underflow/overflow produce null integrals. Null is not zero and is not omitted from aggregation.',
    'Threshold crossings identify changes larger than a selected review tolerance, not statistical significance or a changed biological conclusion.'
  ]};
}
const api=Object.freeze({VERSION,run});root.SensitivityCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
