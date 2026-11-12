const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const B=require('../src/benchmark_core.js');
const M=require('../src/methods_core.js');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const rectangle=(z,x=0)=>({id:'section-'+z,order:z,z,rois:[{paths:[[[x,0],[x+10,0],[x+10,10],[x,10]]]}]});
const constant={unit:'index',sections:Array.from({length:12},(_,i)=>rectangle(i*2))};
const before=hash(constant),options={gridSize:32,seed:168,randomRepeats:3,budget:3};
const same=B.strategies(constant,options);
assert.equal(hash(constant),before,'Inputs must be immutable.');
assert.equal(hash(same),hash(B.strategies(constant,options)),'Fixed seeds must reproduce all decisions and scores.');
assert.deepEqual(same.split.test_ids,['section-4','section-10','section-16']);
assert.equal(same.runs.length,5);
const testIDs=new Set(same.split.test_ids);
for(const run of same.runs){
  assert.equal(run.rounds.length,4);
  for(const round of run.rounds){
    assert.equal(round.cost,round.added_count);
    assert.equal(round.selected_ids.length,round.cost+2);
    assert.equal(new Set(round.selected_ids).size,round.selected_ids.length);
    assert.ok(round.selected_ids.every(id=>!testIDs.has(id)),'Fixed test planes may never be revealed.');
    assert.deepEqual(round.evaluations.map(e=>e.id),same.split.test_ids,'Every round scores the same test set.');
    for(const evaluation of round.evaluations){
      assert.ok(evaluation.training_ids.every(id=>!testIDs.has(id)));
      for(const metric of Object.values(evaluation.scores)){assert.equal(metric.dice,1);assert.equal(metric.area_error,0);}
    }
    assert.equal(round.summary.complete,true);
  }
}
for(const curve of same.curves)for(const round of curve.rounds)for(const metric of Object.values(round.methods)){
  assert.equal(metric.mean_dice,1);assert.deepEqual(metric.dice_range,[1,1]);
}

// Holdout geometry may change scores but cannot affect selections, prediction
// fingerprints, or training-derived grids at any round.
const changedTruth=structuredClone(constant);
for(const s of changedTruth.sections)if(testIDs.has(s.id))for(const p of s.rois[0].paths[0])p[0]+=1000000;
const changed=B.strategies(changedTruth,options);
for(let i=0;i<same.runs.length;i++)for(let j=0;j<same.runs[i].rounds.length;j++){
  const old=same.runs[i].rounds[j],now=changed.runs[i].rounds[j];
  assert.deepEqual(now.selected_ids,old.selected_ids);
  assert.deepEqual(now.decision,old.decision,'Test geometry must never enter the selector.');
  assert.deepEqual(now.evaluations.map(e=>[e.grid,e.prediction_fingerprint]),old.evaluations.map(e=>[e.grid,e.prediction_fingerprint]));
  assert.equal(now.summary.complete,false);
  assert.equal(now.summary.scored_test_count,0);
  for(const method of Object.values(now.summary.methods))assert.equal(method.mean_dice,null,'Unscorable fixed tests must not silently vanish from the mean.');
}
for(const c of changed.curves)for(const r of c.rounds)for(const m of Object.values(r.methods))assert.equal(m.mean_dice,null);

// Unrevealed candidate shapes are not visible even to the heuristic ranking.
const future=structuredClone(constant),candidateIDs=new Set(same.split.candidate_ids);
for(const s of future.sections)if(candidateIDs.has(s.id))for(const p of s.rois[0].paths[0])p[0]+=s.z/3;
const futureResult=B.strategies(future,options);
for(let i=0;i<same.runs.length;i++)assert.deepEqual(futureResult.runs[i].rounds[1].decision,same.runs[i].rounds[1].decision);

const coverage=same.runs.find(r=>r.strategy==='coverage');
assert.equal(coverage.rounds[1].just_added_id,'section-12','Coverage selects the candidate farthest from the observed endpoints.');
const seven=B.strategies({unit:'index',sections:constant.sections.slice(0,7)},{...options,budget:6});
assert.equal(seven.config.budget,3,'Budget must be clipped equally to the common available pool.');
assert.ok(seven.runs.every(r=>r.rounds.length===4));
const zero=B.strategies(constant,{...options,budget:0});
assert.ok(zero.runs.every(r=>r.rounds.length===1));
assert.throws(()=>B.strategies({unit:'index',sections:constant.sections.slice(0,6)}),/7–24/);
assert.throws(()=>B.strategies(constant,{seed:-1}),/seed/);
assert.throws(()=>B.strategies(constant,{randomRepeats:17}),/1–16/);
assert.throws(()=>B.strategies(constant,{budget:7}),/0–6/);
const uneven=structuredClone(constant);uneven.unit='um';uneven.sections.forEach((s,i)=>s.z=i*i*.2);
const physical=B.strategies(uneven,options);assert.equal(physical.curves.length,3);

// A valid but subpixel-thin revealed contour can invalidate only some
// predictions. Preserve complete competitors and the full fixed denominator.
const thin={unit:'index',sections:Array.from({length:7},(_,z)=>rectangle(z))};
thin.sections[1].rois=[{paths:[[[0,0],[1e-8,0],[1e-8,10],[0,10]]]}];
const thinBefore=hash(thin),oneStep=B.strategies(thin,{gridSize:64,budget:1,randomRepeats:2,seed:168});
const failedFirst=oneStep.runs.find(r=>r.strategy==='heuristic');
assert.equal(failedFirst.rounds[1].just_added_id,'section-1');
assert.equal(failedFirst.rounds[1].summary.complete,false);
assert.equal(failedFirst.rounds[1].summary.methods.affine.mean_dice,null);
assert.ok(failedFirst.rounds[1].evaluations.some(e=>e.reason==='prediction_failed'&&e.scores===null&&e.message));
assert.equal(oneStep.runs.find(r=>r.strategy==='coverage').rounds[1].summary.complete,true);
assert.ok(oneStep.failures.evaluations.length>0);
assert.equal(hash(thin),thinBefore);
const continued=B.strategies(thin,{gridSize:64,budget:3,randomRepeats:2,seed:168});
const stopped=continued.runs.find(r=>r.strategy==='heuristic');
assert.equal(stopped.status,'stopped');assert.equal(stopped.rounds.length,2);
assert.equal(stopped.failure.actual_cost,1);assert.equal(stopped.failure.next_added_count,2);
assert.deepEqual(stopped.failure.visible_ids,stopped.rounds[1].selected_ids);
assert.ok(continued.runs.filter(r=>r.strategy!=='heuristic').every(r=>r.rounds.length===4),'One failed ranking must not abort other strategies.');
for(const point of continued.curves.find(c=>c.strategy==='heuristic').rounds.slice(2)){
  assert.equal(point.status,'incomplete_after_selection_failure');
  assert.equal(point.cost,null);assert.deepEqual(point.actual_costs,[1]);
  assert.equal(point.methods.affine.mean_dice,null);
  assert.equal(point.complete_runs,0);assert.equal(point.reached_runs,0);
}
assert.equal(hash(continued),hash(B.strategies(thin,{gridSize:64,budget:3,randomRepeats:2,seed:168})));

const phantom=B.phantom(168),untouched=hash(phantom);
assert.equal(phantom.sections.length,13);assert.equal(hash(phantom),hash(B.phantom(168)));
assert.notEqual(hash(phantom),hash(B.phantom(169)));
const synthetic=B.synthetic({gridSize:32,seed:168,severity:1});
assert.equal(hash(synthetic),hash(B.synthetic({gridSize:32,seed:168,severity:1})));
assert.equal(hash(phantom),untouched);
assert.deepEqual(synthetic.cases.map(c=>c.id),['clean','missing','translation','rotation','compression','tissue_strip_loss']);
for(const c of synthetic.cases){
  assert.deepEqual(c.evaluations.map(e=>e.id),synthetic.config.fixed_test_ids);
  assert.equal(c.summary.test_count,8);assert.equal(c.summary.scored_test_count,8);
  assert.ok(c.training_ids.every(id=>!synthetic.config.fixed_test_ids.includes(id)));
  assert.equal(c.preview.truth_mask.length,32*32);
  assert.equal(c.preview.masks.affine.length,32*32);
  for(const e of c.evaluations){
    assert.ok(e.training_ids.every(id=>!synthetic.config.fixed_test_ids.includes(id)));
    for(const score of Object.values(e.scores))assert.ok(score.dice>=0&&score.dice<=1&&score.area_error>=0);
  }
}
assert.equal(synthetic.cases[1].training_ids.length,3);
assert.ok(synthetic.cases[1].perturbations.every(p=>p.operation==='remove_observation'));
assert.ok(synthetic.cases[4].perturbations.every(p=>p.axis_scale[0]===.65&&p.axis_scale[1]===1.1));
assert.ok(synthetic.cases[5].perturbations.every(p=>p.width===8));
const noDamage=B.synthetic({gridSize:32,seed:168,severity:0});
for(const c of noDamage.cases)assert.deepEqual(c.summary,noDamage.cases[0].summary,'At zero damage all cases must reduce to the same clean baseline.');
assert.throws(()=>B.synthetic({severity:2}),/0–1.5/);
// Confirm the preview actually contains the known analytic truth, rather than a
// prediction mislabeled as observation.
const clean=synthetic.cases[0];
const pred=M.predict({unit:'index',sections:phantom.sections.filter(s=>s.z%3===0)},5,{gridSize:32});
const truth=M.evaluate(pred,phantom.sections.find(s=>s.z===5),{gridSize:32});
assert.deepEqual(clean.preview.truth_mask,truth.truth_mask);
// Inject a predictor failure in the three-observation missing case only; the
// other cases must remain assessable and the failed tests stay explicit.
const vm=require('node:vm'),fs=require('node:fs');
const context=vm.createContext({MethodsCore:{...M,predict(study,z,opts){if(study.sections.length===3)throw Error('synthetic test prediction failure');return M.predict(study,z,opts);}}});
vm.runInContext(fs.readFileSync(require.resolve('../src/benchmark_core.js'),'utf8'),context);
const isolated=context.BenchmarkCore.synthetic({gridSize:32,seed:168,severity:1});
const missing=isolated.cases.find(c=>c.id==='missing');
assert.equal(missing.summary.complete,false);assert.equal(missing.summary.scored_test_count,0);
assert.equal(missing.summary.methods.affine.mean_dice,null);assert.equal(missing.preview,null);
assert.ok(missing.evaluations.every(e=>e.reason==='prediction_failed'));
assert.ok(isolated.cases.filter(c=>c.id!=='missing').every(c=>c.summary.complete));
console.log(JSON.stringify({pass:true,tests:['fixed-set equal-cost comparison','deterministic seeded sampling','no held-out or unrevealed geometry leakage','unscorable denominators','per-prediction failure isolation','failed ranking actual costs','synthetic case failure isolation','unequal physical z','known-truth synthetic damage','zero-severity identity','immutable inputs'],synthetic_summaries:synthetic.cases.map(c=>({id:c.id,methods:c.summary.methods}))},null,2));
