/* Browser-local validation experiments. Never writes to observation data. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
  const fmt = v => typeof v === 'number' && Number.isFinite(v)
    ? (v !== 0 && Math.abs(v) < .001 || Math.abs(v) >= 1e7 ? v.toExponential(3) : v.toLocaleString('en-GB', {maximumFractionDigits: 4})) : '—';
  const names = {sdf: 'Reference distance field', affine: 'Centroid and scale correction', heuristic: 'Spacing × method disagreement', coverage: 'Space-filling search', random: 'Random'};
  const descriptions = {
    sensitivity: [
      'Uses the dataset, tissue, exclusions and grid selected above. The depth-to-check input is not used in this experiment.',
      'Areas are computed on observed planes and on midplanes between them, then integrated with the trapezoidal rule over the same depth range. Compares the effect of excluding each interior observation in turn, the difference between the two reconstruction methods and the effect of ±1 grid pixel at boundaries.',
      'Area integral over the input coordinates. Conversion to physical volume units is made only when both XY and Z are calibrated. Both end observations are fixed. The selected change threshold is a review criterion, not statistical significance or a biological conclusion.'
    ],
    strategies: [
      'Some sections of the dataset above are held out for evaluation throughout. Selection starts from the two end sections and compares equal numbers of additional observations within the number of selectable sections.',
      'Compares the spacing × method-disagreement rule, a space-filling search (maximin) that selects the depth farthest from current observations, and seeded random selection. The shapes of evaluation sections are not used for selection.',
      'Each observation is assigned an equal cost of 1. The range across random repetitions is not a confidence interval. All strategies use the same evaluation sections; rounds containing unevaluable results leave the overall mean blank. A simulation within a single dataset does not demonstrate real-world observation efficiency.'
    ],
    synthetic: [
      'Neither the example nor your data are modified. A separate ground truth generated from synthetic contours and synthetic perturbations are used. Only the computation grid selected above is applied.',
      'For the same synthetic ground truth, compares clean input, missing observations, translation, rotation, axis compression and partial tissue loss. Perturbation strength and seed are recorded in the report.',
      'This experiment identifies failure conditions of the two current interpolation methods. It does not validate restoration of real tears, nonlinear registration or biological accuracy.'
    ]
  };
  let worker = null, timer = null, generation = 0, current = null;
  function status(text, state = 'ready') { $('labStatus').textContent = text; $('labStatus').dataset.state = state; }
  function stop(message) {
    generation++; worker?.terminate(); worker = null; clearTimeout(timer);
    $('labRun').disabled = false; $('labCancel').disabled = true;
    if (message) status(message);
  }
  function invalidate(message = 'Conditions have changed. Run the experiment with the new conditions.') {
    stop(); current = null; $('labExport').disabled = true; $('labResult').replaceChildren(); status(message);
  }
  function modeChanged() {
    const mode = $('labMode').value;
    document.querySelectorAll('[data-lab-mode]').forEach(n => n.classList.toggle('hidden', !n.dataset.labMode.split(' ').includes(mode)));
    $('labScope').textContent = descriptions[mode][0];
    $('labHelp').replaceChildren(...descriptions[mode].slice(1).map(t => el('p', t)));
    invalidate('Check the conditions, then run the experiment. Results are stored separately from the source data.');
  }
  function number(id, min, max, integer = false) {
    const raw = $(id).value.trim(), value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw Error('Check the numerical ranges of the computation conditions: ' + $(id).parentElement.firstChild.textContent.trim());
    return value;
  }
  async function run() {
    invalidate(); const id = ++generation, mode = $('labMode').value;
    try {
      const source = mode === 'synthetic' ? {study: null, provenance: {source: 'synthetic', id: 'analytic-phantom'}, notes: ['Synthetic-contour validation; example data are not used.']}
        : window.CerebellumMethods.input();
      const options = {gridSize: Number($('methodsGrid').value), padding: .25};
      if (mode === 'sensitivity') options.thresholdPercent = number('labThreshold', .1, 100);
      else {
        options.seed = number('labSeed', 0, 4294967295, true);
        if (mode === 'strategies') { options.budget = number('labBudget', 1, 6, true); options.randomRepeats = number('labRepeats', 2, 16, true); }
        else options.severity = number('labSeverity', .5, 1.5);
      }
      const {study, provenance, notes} = source;
      $('labRun').disabled = true; $('labCancel').disabled = false;
      status('Validating with fixed conditions. You may browse other views or stop…', 'busy');
      const input_sha256 = await ResearchCore.sha256(JSON.stringify({mode, study, options, provenance}));
      if (id !== generation) return;
      worker = new Worker('./assets/lab_worker.js');
      timer = setTimeout(() => stop('Computation exceeded 120 seconds. Reduce the grid to 64 or reduce the number of observations or repetitions.'), 120000);
      worker.onerror = e => { if (id !== generation) return; stop(); status('Experiment error: ' + e.message, 'error'); };
      worker.onmessage = ({data}) => {
        if (id !== generation) return;
        stop();
        if (data.error) return status('Computation failed: ' + data.error, 'error');
        current = {schema: 'cerebellum-lab/1', created_at: new Date().toISOString(), mode, input_sha256, study, provenance, notes, options, result: data.result};
        try { render(); $('labExport').disabled = false; status('Validation complete · inputs, conditions, split lists and results can be saved as a report.'); }
        catch (e) { current = null; $('labResult').replaceChildren(); status('Result display error: ' + e.message, 'error'); }
      };
      worker.postMessage({mode, study, options});
    } catch (e) { stop(); status(e.message, 'error'); }
  }
  function table(headings, rows) {
    const wrap = el('div'); wrap.className = 'methods-table-wrap'; wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', headings.join(' · ') + ' results table');
    const t = el('table'), h = el('thead'), tr = el('tr'), body = el('tbody');
    headings.forEach(v => tr.append(el('th', v))); h.append(tr); t.append(h, body);
    for (const row of rows) { const r = el('tr'); row.forEach(v => r.append(el('td', v))); body.append(r); }
    wrap.append(t); return wrap;
  }
  function detail(title, paragraphs) {
    const d = el('details'); d.append(el('summary', title), ...paragraphs.map(p => el('p', p))); return d;
  }
  function metrics(pairs) {
    const host = el('div'); host.className = 'lab-metrics';
    for (const [label, value] of pairs) { const box = el('div'); box.className = 'lab-metric'; box.append(el('span', label), el('strong', value)); host.append(box); }
    return host;
  }
  function chart(series, yLabel, fixedRange) {
    const ns = 'http://www.w3.org/2000/svg', make = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text !== undefined) n.textContent = text; return n;
    };
    const values = series.flatMap(s => s.points).filter(p => Number.isFinite(p.y));
    if (!values.length) return el('p', 'Not all evaluation points could be computed; the graph is not shown');
    let ymin = fixedRange?.[0] ?? Math.min(0, ...values.map(p => p.y)), ymax = fixedRange?.[1] ?? Math.max(...values.map(p => p.y));
    if (ymax === ymin) ymax = ymin + 1;
    const xmax = Math.max(1, ...values.map(p => p.x)), x = n => 62 + n / xmax * 540, y = n => 214 - (n - ymin) / (ymax - ymin) * 174;
    const svg = make('svg', {viewBox: '0 0 640 265', class: 'lab-chart', role: 'img', 'aria-label': yLabel + '. Values and denominators are available in the results table below.'});
    svg.append(make('text', {x: 20, y: 21}, yLabel));
    for (let i = 0; i <= 4; i++) { const v = ymin + (ymax - ymin) * i / 4; svg.append(make('line', {x1: 62, y1: y(v), x2: 602, y2: y(v), stroke: '#e0e4e8'}), make('text', {x: 54, y: y(v) + 4, 'text-anchor': 'end'}, v.toFixed(2))); }
    for (let i = 0; i <= xmax; i++) svg.append(make('text', {x: x(i), y: 237, 'text-anchor': 'middle'}, String(i)));
    svg.append(make('text', {x: 332, y: 258, 'text-anchor': 'middle'}, 'Additional observations · equal cost'));
    const colors = ['#368d7b', '#8170ad', '#b58139'], legend = el('div'); legend.className = 'lab-legend';
    series.forEach((s, i) => {
      let path = '', connected = false;
      for (const p of s.points) { if (!Number.isFinite(p.y)) { connected = false; continue; } path += `${connected ? 'L' : 'M'}${x(p.x)} ${y(p.y)} `; connected = true; svg.append(make('circle', {cx: x(p.x), cy: y(p.y), r: 3, fill: colors[i]})); }
      svg.append(make('path', {d: path, fill: 'none', stroke: colors[i], 'stroke-width': 2}));
      const label = el('span'), swatch = el('i'); swatch.style.backgroundColor = colors[i]; label.append(swatch, document.createTextNode(s.name)); legend.append(label);
    });
    const host = el('div'); host.append(svg, legend); return host;
  }
  function renderSensitivity(host, r) {
    const c = current.provenance.calibration, physical = c?.xy_unit === 'um' && c?.z_unit === 'um';
    const factor = physical ? c.um_per_pixel ** 2 : 1;
    const units = physical ? 'µm³' : (current.provenance.source === 'imported' ? 'px² × ' + (current.study.unit === 'um' ? 'µm' : 'Order') : 'Display coordinates² × section number');
    const value = n => Number.isFinite(n) ? fmt(n * factor) : '—';
    host.append(el('h3', 'Changes in measurements over the same range'), el('p', 'Unit of area integral: ' + units + '. Values include interpolation between observations and do not replace the original example measurement table.'));
    host.append(metrics(['sdf', 'affine'].map(k => [names[k] + ' · reference integral', value(r.baseline[k])])));
    const empty = r.profile.filter(p => p.flags?.includes('empty_prediction')).length;
    const unavailable = r.profile.filter(p => p.status !== 'scored').length;
    if (empty || unavailable || r.baseline_status !== 'scored') {
      const warning = el('p', 'Computation status: empty predictions ' + empty + ' · unevaluable ' + unavailable + '' + (r.baseline_status !== 'scored' ? ' · reference integral unevaluable' : '') + '. Distinguish 0 for empty predictions from — for unevaluable results. Locations and reasons are given in the report.');
      warning.className = 'lab-review'; host.append(warning);
    }
    host.append(el('p', 'Change when the method is switched: ' + fmt(r.method_difference_percent) + '% · review threshold: ' + fmt(current.options.thresholdPercent) + '%'));
    host.append(table(['Boundary sensitivity · not a confidence interval', '1-pixel erosion', '1-pixel dilation'], ['sdf', 'affine'].map(k => [names[k], value(r.boundary[k].lower), value(r.boundary[k].upper)])));
    host.append(el('h3', 'Which observations influence the result?'));
    const rows = r.influence.filter(row => row.status === 'scored').slice().sort((a, b) => Math.max(...Object.values(b.methods).map(m => Math.abs(m.delta_percent ?? 0))) - Math.max(...Object.values(a.methods).map(m => Math.abs(m.delta_percent ?? 0))));
    const reviewed = rows.filter(row => Object.values(row.methods).some(m => m.threshold_crossed));
    const note = el('p', !rows.length ? 'The influence of interior observations cannot be computed. Check the unevaluable reasons and input coordinates in the report.' : reviewed.length ? reviewed.length + ' observations exceed the specified change threshold. Review the source data and exclusion rationale for these observations first.' : 'No computable interior observation exceeds the specified change threshold. This does not guarantee accuracy.');
    if (reviewed.length) note.className = 'lab-review'; host.append(note);
    host.append(table(['Excluded observation', 'Depth', 'Reference integral change %', 'Corrected integral change %', 'Review'], [...rows, ...r.influence.filter(row => row.status !== 'scored')].map(row => [row.id, fmt(row.z), fmt(row.methods?.sdf?.delta_percent), fmt(row.methods?.affine?.delta_percent), row.status !== 'scored' ? (row.status === 'endpoint' || row.status === 'excluded_from_influence' ? 'End plane fixed' : 'Excluded from computation · see report') : Object.values(row.methods).some(m => m.threshold_crossed) ? 'Exceeds change threshold' : 'Within threshold'])));
    host.append(detail('Fixed evaluation positions, calibration and limits', [
      'Both ends are fixed to avoid the range reduction caused by excluding end planes. All interior-exclusion experiments are computed at the same depth positions.',
      physical ? 'Displayed value = input pixel area integral × (' + fmt(c.um_per_pixel) + ' µm/px)². The report retains the unconverted values and calibration.' : 'Results cannot be interpreted as physical volumes until both the measured scale and depth have been confirmed.',
      'Empty predictions are retained as algorithm-derived areas of 0 and flagged in the report. Cases where an input observation vanishes on the grid or computation fails are recorded as unevaluable rather than 0.',
      'One boundary pixel is one cell of each computation grid, not an image pixel. The actual grid spacing and area at each position are recorded in the report.',
      ...(r.limitations || [])
    ]));
  }
  function renderStrategies(host, r) {
    host.append(el('h3', 'Comparison at equal cost with identical evaluation sections'));
    host.append(el('p', 'Initial observations: ' + r.split.initial_ids.length + ' · fixed evaluation: ' + r.split.test_ids.length + ' · selectable: ' + r.split.candidate_ids.length + '. Evaluation sections are not eligible as additional observations.'));
    host.append(el('p', 'Requested additional observations: ' + current.options.budget + ' · upper limit of additional observations compared: ' + r.curves[0].rounds.at(-1).added_count + '. Requests exceeding the selectable number are capped at that limit.'));
    if (r.failures) {
      const warning = el('p', 'Evaluation failures: ' + r.failures.evaluations.length + ' · selections stopped: ' + r.failures.stopped_runs.length + '. Means for failed paths are shown as —, and observation costs after a stop are not counted as incurred.');
      warning.className = 'lab-review'; host.append(warning);
      host.append(detail('Reasons for evaluation failures and stopped selections', [...r.failures.stopped_runs, ...r.failures.evaluations].map(f => JSON.stringify(f))));
    }
    host.append(chart(r.curves.map(c => ({name: names[c.strategy], points: c.rounds.map(row => ({x: row.added_count, y: row.methods.affine.mean_dice}))})), 'Centroid and scale correction · mean Dice', [0, 1]));
    host.append(el('p', 'Higher Dice indicates more similar shapes. Check the area error as well. Random curves are means over repetitions; the range across repetitions is recorded in the report and table.'));
    const rows = r.curves.flatMap(c => c.rounds.map(row => [names[c.strategy], String(row.added_count), fmt(row.cost), fmt(row.methods.sdf.mean_dice), fmt(row.methods.affine.mean_dice), fmt(row.methods.sdf.mean_area_error), fmt(row.methods.affine.mean_area_error), (row.methods.affine.dice_range || []).map(fmt).join(' ~ ') || '—', row.complete_runs + '/' + row.total_runs]));
    host.append(table(['Strategy', 'Additional observations', 'Additional cost', 'Reference Dice', 'Corrected Dice', 'Reference area error', 'Corrected area error', 'Corrected Dice range across repetitions', 'Fully evaluated repetitions'], rows));
    host.append(detail('Split observation lists and selection rules', ['Initial: ' + r.split.initial_ids.join(', '), 'Evaluation only: ' + r.split.test_ids.join(', '), 'Observation candidates: ' + r.split.candidate_ids.join(', '), 'The space-filling search is a maximin rule that sequentially selects the candidate farthest from current observations. It differs from a rule that preselects fixed, evenly spaced sections.', 'Scores, observation IDs used, evaluation denominators and per-repetition seeds at each selection step are retained in the report.', ...(r.warnings || [])]));
  }
  function renderSynthetic(host, r) {
    host.append(el('h3', 'Identifying failure conditions with synthetic data of known ground truth'), el('p', 'The values below are results for synthetic contours. Do not interpret them as accuracy or damage-restoration performance on the actual example data.'));
    host.append(table(['Input condition', 'Observations used', 'Reference Dice', 'Corrected Dice', 'Reference area error', 'Corrected area error', 'Ground truths evaluated'], r.cases.map(c => [c.label, String(c.training_ids.length), fmt(c.summary.methods.sdf.mean_dice), fmt(c.summary.methods.affine.mean_dice), fmt(c.summary.methods.sdf.mean_area_error), fmt(c.summary.methods.affine.mean_area_error), c.summary.scored_test_count + '/' + c.summary.test_count])));
    const selector = el('select'); selector.id = 'labCase'; selector.setAttribute('aria-label', 'Synthetic perturbation to compare'); r.cases.forEach((c, i) => selector.append(new Option(c.label, i)));
    const figures = el('div'); figures.className = 'methods-canvases'; const canvases = {};
    for (const [key, title] of [['truth', 'Ground truth before perturbation'], ['sdf', 'Reference interpolation'], ['affine', 'Centroid and scale correction']]) {
      const figure = el('figure'), caption = el('figcaption'), canvas = el('canvas'); caption.append(el('strong', title)); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', title); canvas.id = 'labPreview-' + key; figure.append(caption, canvas); figures.append(figure); canvases[key] = canvas;
    }
    const note = el('p'); note.className = 'methods-result-note';
    const draw = () => {
      const c = r.cases[Number(selector.value)], p = c.preview;
      note.textContent = p ? c.label + ' · held-out depth ' + fmt(p.z) + ' · ground truth outside the displayed range is included in scoring.' : 'A preview cannot be computed for this condition. Check the exclusion reason in the report.';
      for (const key of Object.keys(canvases)) {
        const canvas = canvases[key], mask = key === 'truth' ? p?.truth_mask : p?.masks?.[key]; canvas.width = canvas.height = p?.grid?.size || 64;
        const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(canvas.width, canvas.height), color = key === 'truth' ? [76,100,119] : key === 'sdf' ? [77,159,143] : [145,132,197];
        for (let i = 0; i < canvas.width * canvas.height; i++) pixels.data.set(mask?.[i] ? [...color, 255] : [247,248,250,255], i * 4);
        ctx.putImageData(pixels, 0, 0);
      }
    };
    selector.onchange = draw; host.append(el('h3', 'Prediction and ground truth by perturbation condition'), selector, note, figures); draw();
    host.append(detail('Perturbation generation and validation scope', ['Transformation magnitudes, lost regions and observation IDs used in each experiment are retained in the report. The original ground truth is not perturbed.', ...(r.warnings || [])]));
  }
  function render() {
    const host = $('labResult'); host.replaceChildren();
    if (current.mode === 'sensitivity') renderSensitivity(host, current.result);
    else if (current.mode === 'strategies') renderStrategies(host, current.result);
    else renderSynthetic(host, current.result);
    host.append(detail('Input data and reproducibility information', [...current.notes, 'Grid: ' + current.options.gridSize + ' × ' + current.options.gridSize, 'Input SHA-256: ' + current.input_sha256, 'Experimental conditions can be verified from the source data, parameters and algorithm versions in the report. A fingerprint does not guarantee the accuracy of the data.']));
  }
  $('labMode').onchange = modeChanged;
  for (const id of ['labThreshold', 'labBudget', 'labRepeats', 'labSeverity', 'labSeed']) $(id).addEventListener('input', () => invalidate());
  window.addEventListener('methods-settings-changed', () => invalidate());
  window.addEventListener('research-project-changed', () => { if ($('methodsSource').value === 'mine' && $('labMode').value !== 'synthetic') invalidate('The project has changed. Run the experiment with the new data.'); });
  $('labRun').onclick = run; $('labCancel').onclick = () => stop('Experiment stopped. Source data are unchanged.');
  $('labExport').onclick = () => {
    if (!current) return;
    const link = el('a'), url = URL.createObjectURL(new Blob([JSON.stringify(current)], {type: 'application/json'}));
    link.href = url; link.download = 'cerebellum-lab-' + current.mode + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  };
  modeChanged();
})();
