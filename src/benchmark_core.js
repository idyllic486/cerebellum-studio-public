/* Reproducible research experiments. No selection routine receives hidden shapes. */
(function(root) {
'use strict';
const M = typeof module === 'object' && module.exports ? require('./methods_core.js') : root.MethodsCore;
const VERSION = 'cerebellum-benchmark/1';
const METHODS = ['sdf', 'affine'];
const fail = message => { throw Error(message); };
const mean = values => values.reduce((sum, n) => sum + n, 0) / values.length;
const clone = value => JSON.parse(JSON.stringify(value));

function config(options) {
  const gridSize = options.gridSize ?? 64, padding = options.padding ?? .25;
  const seed = options.seed ?? 168;
  if (![32,64,96].includes(gridSize)) fail('Select a validation grid of 32, 64 or 96.');
  if (!Number.isFinite(padding) || padding < .1 || padding > 1) fail('Grid margin must lie within 0.1–1.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) fail('The random seed must be an integer in the range 0–4294967295.');
  const evaluationCellLimit = options.evaluationCellLimit ?? 1000000;
  if (!Number.isSafeInteger(evaluationCellLimit) || evaluationCellLimit < 1024 || evaluationCellLimit > 1000000) fail('The evaluation grid limit must lie within 1,024–1,000,000 cells.');
  return {gridSize,padding,seed,evaluationCellLimit};
}

// Mulberry32 is a deterministic simulation generator, not a cryptographic RNG.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function metadata(study) {
  if (!study || !['index','um'].includes(study.unit) || !Array.isArray(study.sections) || study.sections.length < 7 || study.sections.length > 24) fail('Comparing observation strategies requires 7–24 observed planes with depth.');
  const ids = new Set(), orders = new Set(), zs = new Set();
  const sections = study.sections.map(s => {
    if (!s || typeof s.id !== 'string' || !s.id || ids.has(s.id) || !Number.isSafeInteger(s.order) || s.order < 0 || orders.has(s.order)) fail('Section IDs and orders must be unique.');
    const z = study.unit === 'index' && s.z == null ? s.order : s.z;
    if (!Number.isFinite(z) || Math.abs(z) > 1e9 || zs.has(z) || (study.unit === 'index' && !Number.isSafeInteger(z))) fail('Depths must be unique, finite coordinates without missing values.');
    ids.add(s.id); orders.add(s.order); zs.add(z);
    return {...s,z};
  }).sort((a,b) => a.order-b.order);
  for (let i=1; i<sections.length; i++) if (sections[i].z <= sections[i-1].z) fail('Depth must increase with section order.');
  return sections;
}

function summary(evaluations) {
  const scored = evaluations.filter(e => e.status === 'scored');
  const complete = scored.length === evaluations.length && evaluations.length > 0;
  const methods = {};
  for (const method of METHODS) methods[method] = {
    mean_dice: complete ? mean(scored.map(e=>e.scores[method].dice)) : null,
    mean_iou: complete ? mean(scored.map(e=>e.scores[method].iou)) : null,
    mean_area_error: complete ? mean(scored.map(e=>e.scores[method].area_error)) : null
  };
  return {test_count:evaluations.length,scored_test_count:scored.length,unscorable_test_count:evaluations.length-scored.length,complete,methods};
}

function compactEvaluation(prediction, truth, options) {
  const evaluated = M.evaluate(prediction,truth,options);
  return {
    id:truth.id,z:truth.z,status:evaluated.status,reason:evaluated.reason || null,
    scores:evaluated.scores,training_ids:prediction.training_ids,
    prediction_fingerprint:prediction.prediction_fingerprint,
    grid:prediction.grid,evaluation_grid:evaluated.evaluation_grid,
    truth_outside_count:evaluated.truth_outside_count,
    flags:[...prediction.flags,...evaluated.flags]
  };
}

function safeEvaluation(makePrediction, truth, options, training) {
  let prediction=null;
  try {
    prediction=makePrediction();
    return {record:compactEvaluation(prediction,truth,options),prediction};
  } catch (error) {
    const reason=prediction?'evaluation_failed':'prediction_failed';
    return {prediction:null,record:{id:truth.id,z:truth.z,status:'unscorable',reason,
      message:String(error.message || error),scores:null,
      training_ids:prediction?.training_ids || [...training].sort((a,b)=>a.order-b.order).map(s=>s.id),
      prediction_fingerprint:prediction?.prediction_fingerprint || null,
      grid:prediction?.grid || null,evaluation_grid:null,truth_outside_count:null,
      flags:[...(prediction?.flags || []),reason]}};
  }
}

// This function's arguments contain only revealed contours and candidate metadata.
// Test geometry and unrevealed candidate geometry cannot affect the decision.
function choose(strategy, revealed, candidates, unit, options, random, predict) {
  const ranked = candidates.map(c => {
    const nearest = Math.min(...revealed.map(s=>Math.abs(s.z-c.z)));
    if (strategy === 'coverage') return {id:c.id,z:c.z,score:nearest};
    if (strategy === 'random') return {id:c.id,z:c.z,score:random()};
    let p;
    try { p=predict(revealed,c.z); }
    catch (error) { const failure=Error(c.id+': '+String(error.message || error)); failure.candidate_id=c.id; failure.candidate_z=c.z; throw failure; }
    return {id:c.id,z:c.z,score:p.gap*(.25+p.disagreement),gap:p.gap,
      disagreement:p.disagreement,prediction_fingerprint:p.prediction_fingerprint,flags:p.flags};
  }).sort((a,b)=>b.score-a.score || a.z-b.z || a.id.localeCompare(b.id));
  return {id:ranked[0].id,ranking:ranked,visible_ids:revealed.map(s=>s.id),
    rule:strategy==='heuristic'?'gap * (0.25 + disagreement)':strategy==='coverage'?'max min(abs(candidate_z - observed_z))':'largest seeded independent uniform draw'};
}

function strategies(study, options={}) {
  const settings=config(options), sections=metadata(study);
  const randomRepeats=options.randomRepeats ?? 8, requestedBudget=options.budget ?? 3;
  if (!Number.isInteger(randomRepeats) || randomRepeats<1 || randomRepeats>16) fail('Random-strategy repetitions are limited to 1–16.');
  if (!Number.isInteger(requestedBudget) || requestedBudget<0 || requestedBudget>6) fail('The additional observation budget is limited to 0–6.');
  const initial=[sections[0],sections[sections.length-1]];
  const tests=sections.filter((s,i)=>i>0 && i<sections.length-1 && i%3===2);
  const testIDs=new Set(tests.map(s=>s.id)), initialIDs=new Set(initial.map(s=>s.id));
  const pool=sections.filter(s=>!testIDs.has(s.id)&&!initialIDs.has(s.id));
  const candidateMetadata=pool.map(({id,z})=>({id,z}));
  const budget=Math.min(requestedBudget,pool.length);
  // Caches are keyed only by revealed IDs. Inputs are immutable during a run.
  // Store compact candidate predictions only until their evaluation completes.
  const predictionCache=new Map(), evaluationCache=new Map();
  const predict=(revealed,z)=>{
    const sorted=[...revealed].sort((a,b)=>a.order-b.order);
    const key=JSON.stringify([sorted.map(s=>s.id),z]);
    if (!predictionCache.has(key)) {
      if (predictionCache.size>=128) predictionCache.delete(predictionCache.keys().next().value);
      predictionCache.set(key,M.predict({unit:study.unit,sections:sorted},z,settings));
    }
    return predictionCache.get(key);
  };
  const evaluate=revealed=>{
    const key=JSON.stringify([...revealed].sort((a,b)=>a.order-b.order).map(s=>s.id));
    if (!evaluationCache.has(key)) evaluationCache.set(key,tests.map(t=>safeEvaluation(()=>predict(revealed,t.z),t,settings,revealed).record));
    return evaluationCache.get(key);
  };
  const runs=[];
  for (const strategy of ['heuristic','coverage','random']) {
    const repeats=strategy==='random'?randomRepeats:1;
    for(let repeat=0;repeat<repeats;repeat++) {
      const seed=(settings.seed+Math.imul(repeat,2654435761))>>>0;
      const random=rng(seed), revealed=initial.slice(), rounds=[];
      let decision=null,justAdded=null,stopped=null;
      for(let step=0;step<=budget;step++) {
        const evaluations=evaluate(revealed);
        rounds.push({added_count:step,cost:step,total_observations:revealed.length,
          selected_ids:revealed.map(s=>s.id),just_added_id:justAdded,decision,
          evaluations,summary:summary(evaluations)});
        if(step===budget)break;
        const selected=new Set(revealed.map(s=>s.id));
        try { decision=choose(strategy,revealed,candidateMetadata.filter(c=>!selected.has(c.id)),study.unit,settings,random,predict); }
        catch(error) {
          stopped={phase:'selection',reason:'candidate_prediction_failed',message:String(error.message || error),
            candidate_id:error.candidate_id || null,candidate_z:error.candidate_z ?? null,
            at_added_count:step,next_added_count:step+1,actual_cost:step,visible_ids:revealed.map(s=>s.id)};
          break; // No fallback ranking and no observation is revealed after failure.
        }
        // Reveal only the selected candidate after the decision was recorded.
        justAdded=decision.id;revealed.push(pool.find(s=>s.id===justAdded));
      }
      const run={strategy,repeat,seed:strategy==='random'?seed:null,rounds};
      if(stopped){run.status='stopped';run.failure=stopped;}
      else if(rounds.some(r=>!r.summary.complete))run.status='completed_with_unscorable_tests';
      runs.push(run);
    }
  }
  const curves=['heuristic','coverage','random'].map(strategy=>{
    const same=runs.filter(r=>r.strategy===strategy);
    return {strategy,repeats:same.length,rounds:Array.from({length:budget+1},(_,step)=>{
      const rounds=same.map(r=>r.rounds[step] || null),results=rounds.map(r=>r?.summary || null);
      const complete=results.every(r=>r?.complete),allReached=rounds.every(Boolean),methods={};
      for(const method of METHODS){const dices=results.map(r=>r?.methods[method].mean_dice ?? null),areas=results.map(r=>r?.methods[method].mean_area_error ?? null);methods[method]={
        mean_dice:complete?mean(dices):null,mean_area_error:complete?mean(areas):null,
        dice_range:complete?[Math.min(...dices),Math.max(...dices)]:null,
        area_error_range:complete?[Math.min(...areas),Math.max(...areas)]:null};}
      const row={added_count:step,cost:allReached?step:null,total_observations:allReached?initial.length+step:null,
        complete_runs:results.filter(r=>r?.complete).length,total_runs:results.length,methods};
      if(!allReached){row.status='incomplete_after_selection_failure';row.requested_cost=step;
        row.reached_runs=rounds.filter(Boolean).length;
        row.actual_costs=same.map(r=>(r.rounds[step] || r.rounds.at(-1)).cost);}
      return row;
    })};
  });
  const result={version:VERSION,experiment:'retrospective_selection',config:{...settings,
    random_repeats:randomRepeats,requested_budget:requestedBudget,budget,cost_per_added_observation:1,
    initial_observation_cost:0,cost_interpretation:'additional annotations; initial endpoints already available',
    random_generator:'mulberry32',split_rule:'sorted internal section index modulo 3 equals 2 is fixed test; endpoints initially visible',
    geometry_visibility:'selection sees revealed contours and candidate id/z only',
    complete_test_set_required_for_mean:true,grid_rule:'training-derived bounds at every step; fixed gridSize and padding'},
    split:{initial_ids:initial.map(s=>s.id),test_ids:tests.map(s=>s.id),candidate_ids:pool.map(s=>s.id)},runs,curves,
    warnings:[
      'Retrospective within-study simulation; not prospective efficiency or independent-animal validation.',
      'Every strategy has identical fixed test IDs, initial observations, candidate pool, and equal unit annotation cost.',
      'Coverage uses greedy maximum minimum depth distance, not a predetermined equally spaced physical sampling grid.',
      'Random ranges describe repeated selection paths, not statistical confidence intervals.',
      'Prediction grids are derived only from currently revealed contours; changing extent changes pixel spacing and introduces discretization sensitivity.',
      'A mean is null if any fixed test plane is unscorable; never compare averages over different available test subsets.',
      'The existing gap/disagreement heuristic is evaluated without optimizing its weights on these test results.'
    ]};
  const stoppedRuns=runs.filter(r=>r.status==='stopped');
  const failedEvaluations=runs.flatMap(run=>run.rounds.flatMap(round=>round.evaluations.filter(e=>e.reason==='prediction_failed'||e.reason==='evaluation_failed')
    .map(e=>({strategy:run.strategy,repeat:run.repeat,added_count:round.added_count,id:e.id,reason:e.reason,message:e.message}))));
  if(stoppedRuns.length || failedEvaluations.length){
    result.failures={stopped_runs:stoppedRuns.map(r=>({strategy:r.strategy,repeat:r.repeat,...r.failure})),evaluations:failedEvaluations};
    result.warnings.push('Prediction failures are recorded as unscorable fixed tests. A failed candidate ranking stops only that strategy run; future requested budgets have null means and actual costs are retained. No fallback selection or score substitution is performed.');
  }
  return result;
}

function phantom(seed=168) {
  const random=rng(seed),phase=random()*Math.PI*2;
  const sections=Array.from({length:13},(_,z)=>{
    const t=(z-6)/6,cx=4*Math.sin(.7*Math.PI*t),cy=2*Math.cos(Math.PI*t);
    const a=32*(1-.25*t*t),b=22*(1-.18*t*t);
    const path=Array.from({length:96},(_,j)=>{
      const theta=2*Math.PI*j/96,r=1+.08*Math.cos(5*theta+.3*t+phase);
      return [cx+a*r*Math.cos(theta),cy+b*r*Math.sin(theta)];
    });
    return {id:'phantom-'+String(z).padStart(2,'0'),order:z,z,rois:[{paths:[path]}]};
  });
  return {unit:'index',sections,definition:{id:'lobed-ellipse-13-v1',seed,phase,
    coordinates:'artificial XY units; depth index 0..12',vertices_per_contour:96,
    formula:'t=(z-6)/6; cx=4*sin(0.7*pi*t); cy=2*cos(pi*t); a=32*(1-0.25*t^2); b=22*(1-0.18*t^2); r=1+0.08*cos(5*theta+0.3*t+phase); x=cx+a*r*cos(theta); y=cy+b*r*sin(theta)',
    interpretation:'Analytic synthetic contour sampled as a polygon; not an anatomical or histological reference.'}};
}

// Clip a convex/locally lobed closed polygon by a half-plane. The cut removes
// an explicit central strip; this does not model the biomechanics of a tear.
function clipX(path,threshold,keepLeft) {
  const out=[],inside=p=>keepLeft?p[0]<=threshold:p[0]>=threshold;
  for(let i=0;i<path.length;i++) {
    const a=path[i],b=path[(i+1)%path.length],ia=inside(a),ib=inside(b);
    if(ia)out.push(a.slice());
    if(ia!==ib){const t=(threshold-a[0])/(b[0]-a[0]);out.push([threshold,a[1]+t*(b[1]-a[1])]);}
  }
  return out;
}

function synthetic(options={}) {
  const settings=config(options),severity=options.severity??1;
  if(!Number.isFinite(severity)||severity<0||severity>1.5)fail('Synthetic perturbation strength must lie within 0–1.5.');
  const reference=phantom(settings.seed),base=reference.sections.filter(s=>s.z%3===0);
  const tests=reference.sections.filter(s=>s.z%3!==0),random=rng(settings.seed^0x9e3779b9);
  const directions=Object.fromEntries(base.filter(s=>s.z>0&&s.z<12).map(s=>[s.id,random()<.5?-1:1]));
  const specifications=[['clean','No perturbation'],['missing','Missing observed section'],['translation','Translation'],['rotation','Rotation'],['compression','Axis-wise compression'],['tissue_strip_loss','Central-band tissue loss']];
  const cases=specifications.map(([id,label])=>{
    let training=clone(base);const perturbations=[];
    if(id==='missing') {
      const removed=[3,9,6].slice(0,Math.min(3,Math.ceil(2*severity)));
      training=training.filter(s=>!removed.includes(s.z));
      for(const z of removed)perturbations.push({id:base.find(s=>s.z===z).id,operation:'remove_observation',z});
    } else if(id!=='clean') {
      for(const s of training)if(s.z>0&&s.z<12){
        const t=(s.z-6)/6,cx=4*Math.sin(.7*Math.PI*t),cy=2*Math.cos(Math.PI*t),sign=directions[s.id];
        if(id==='tissue_strip_loss') {
          const width=8*severity,path=s.rois[0].paths[0];
          if(width>0)s.rois=[{paths:[clipX(path,cx-width/2,true)]},{paths:[clipX(path,cx+width/2,false)]}];
          perturbations.push({id:s.id,operation:'remove_central_x_strip',center_x:cx,width,description:'two retained polygon pieces; explicit tissue loss, not mechanical tearing'});
        }else{
          const dx=id==='translation'?sign*10*severity:0,dy=id==='translation'?sign*6*severity:0;
          const angle=id==='rotation'?sign*20*severity*Math.PI/180:0;
          const sx=id==='compression'?1-.35*severity:1,sy=id==='compression'?1+.1*severity:1;
          s.rois=s.rois.map(r=>({paths:r.paths.map(p=>p.map(([x,y])=>{
            const xx=(x-cx)*sx,yy=(y-cy)*sy;
            return [cx+Math.cos(angle)*xx-Math.sin(angle)*yy+dx,cy+Math.sin(angle)*xx+Math.cos(angle)*yy+dy];
          }))}));
          perturbations.push({id:s.id,operation:id,center:[cx,cy],translation:[dx,dy],rotation_radians:angle,axis_scale:[sx,sy]});
        }
      }
    }
    const evaluations=[];let preview=null;
    for(const truth of tests){
      const {record,prediction}=safeEvaluation(()=>M.predict({unit:'index',sections:training},truth.z,settings),truth,settings,training);
      evaluations.push(record);
      if(truth.z===5 && prediction){const evaluation=M.evaluate(prediction,truth,settings);preview={z:truth.z,grid:prediction.grid,masks:prediction.masks,truth_mask:evaluation.truth_mask,
        truth_outside_count:evaluation.truth_outside_count,flags:[...prediction.flags,...evaluation.flags]};}
    }
    return {id,label,training_ids:training.map(s=>s.id),perturbations,evaluations,summary:summary(evaluations),preview};
  });
  return {version:VERSION,experiment:'synthetic_damage',config:{...settings,severity,
    initial_training_ids:base.map(s=>s.id),fixed_test_ids:tests.map(s=>s.id),perturbed_sections:'internal training planes only',
    truth:'untouched analytic phantom contours, never used as training or for prediction grids'},phantom:reference.definition,cases,
    warnings:[
      'Controlled synthetic stress test with known undamaged truth; not a validated model of cerebellar anatomy or histological damage.',
      'Existing translation/axis-scale interpolation is tested without restoring actual rotation or nonlinear deformation.',
      'Missing observations and removed tissue are not recovered source data.',
      'The tissue-loss case removes a central strip; it does not simulate physical tearing mechanics.',
      'Fixed test IDs and scoring rules are identical in all cases; each prediction grid uses training geometry only.',
      'Area error and Dice measure polygon-mask agreement, not biological or clinical validity.'
    ]};
}

const api=Object.freeze({VERSION,strategies,synthetic,phantom});
root.BenchmarkCore=api;
if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
