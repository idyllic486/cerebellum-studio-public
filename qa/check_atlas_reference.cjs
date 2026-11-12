/* Synthetic fixtures verify geometry/provenance behavior, not atlas or lobule accuracy. */
'use strict';
const assert = require('node:assert/strict');
const A = require('../src/atlas_reference_core.js');
const C = require('../src/reconstruction_core.js');
const clone = value => JSON.parse(JSON.stringify(value));
const identity = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], scale: 1 };
const square = (r, x = 0, y = 0) => [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
function frustum(bottom = 1, top = 3, z0 = 0, z1 = 10) {
  return { positions: [...square(bottom).flatMap(p => [...p, z0]), ...square(top).flatMap(p => [...p, z1])],
    indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] };
}
const whole = frustum();
const reference = { schema: 'cerebellum-atlas/1', unit: 'um',
  source: { name: 'SYNTHETIC frustum QA fixture; not anatomy', sha256: 'c'.repeat(64), license_note: 'Synthetic test data only' },
  mesh: whole, regions: [
    { id: 'CB', name: 'Synthetic named region', mesh: whole },
    { id: 'missing', name: 'Explicitly unavailable region' },
    { id: 'plate', name: 'Synthetic calibrated plate region', contours: [{ id: 'plate-5', z_um: 5, paths: [square(2)] }] }
  ] };
const original = clone(reference), checks = [];
let cut = A.cutReference(reference, 5, { transform: identity, regionIds: ['CB', 'missing', 'not-provided'] });
assert.equal(cut.regions[0].status, 'available'); assert.equal(cut.regions[0].paths.length, 1);
assert(cut.regions[0].paths[0].every(([x, y]) => Math.abs(x) <= 2 && Math.abs(y) <= 2));
assert.equal(cut.regions[0].name, 'Synthetic named region'); assert.equal(cut.regions[1].reason, 'geometry_not_supplied');
assert.equal(cut.regions[2].reason, 'label_not_supplied'); assert.equal(cut.regions[2].name, null);
assert.equal(A.cutReference(reference, 11, { transform: identity, regionIds: ['CB'] }).regions[0].status, 'empty');
assert.equal(A.cutReference(reference, 0, { transform: identity, regionIds: ['CB'] }).regions[0].status, 'available');
assert.equal(A.cutReference(reference, 10, { transform: identity, regionIds: ['CB'] }).regions[0].status, 'available');
checks.push('Physical mesh cuts retain supplied names; absent labels/geometry stay unavailable and end-plane cuts remain closed');

const observed = { unit: 'um', z_um: 5, rois: [{ kind: 'area', closed: true, paths: [square(2)] }] };
const candidates = [{ id: 'lower', z_um: 0 }, { id: 'match', z_um: 5 }, { id: 'upper', z_um: 10 }, { id: 'outside', z_um: 15 }];
const options = { transform: identity, regionId: 'CB', grid: { origin: [-4, -4], spacing_um: .125, width: 64, height: 64 } };
const rank = A.rankCandidateCuts(reference, observed, candidates, options);
assert.equal(rank.proposed_candidate_id, 'match'); assert.equal(rank.proposal_status, 'candidate_only');
assert.equal(rank.candidates[1].dice, 1); assert.equal(rank.candidates[1].iou, 1); assert.equal(rank.probability, null);
assert.equal(rank.candidates[0].dice, .4); assert.equal(rank.candidates[0].iou, .25);
assert.equal(rank.candidates[3].status, 'unscored'); assert.equal(rank.settings.alignment_search, false);
assert.deepEqual(rank.settings.grid.extent, [-4, -4, 4, 4]);
assert.equal(rank.observed.foreground_pixels, 1024);
checks.push('Candidate ranking uses full declared physical grid, exact Dice/IoU counts and an explicitly non-probabilistic proposal');

const landmarks = [[0, 0, 0], [3, 0, 0], [0, 4, 0], [0, 0, 5]], target = landmarks.map(([x, y, z]) => [-y + 30, x - 10, z + 5]);
const transform = C.fitRigid(landmarks, target);
cut = A.cutReference(reference, 10, { transform, regionIds: ['CB'] });
assert.equal(cut.regions[0].status, 'available');
assert(cut.regions[0].paths[0].every(([x, y]) => x >= 28 && x <= 32 && y >= -12 && y <= -8));
const shifted = A.rankCandidateCuts(reference, { unit: 'um', z_um: 10, rois: [{ kind: 'area', paths: [square(2, 30, -10)] }] },
  [{ id: 'known', z_um: 10 }], { ...options, transform, grid: { origin: [26, -14], spacing_um: .125, width: 64, height: 64 } });
assert.equal(shifted.candidates[0].dice, 1); assert.deepEqual(shifted.transform.translation, [30, -10, 5]);
assert.deepEqual(reference, original);
checks.push('Known rigid atlas-to-specimen rotation and translation preserve physical cut position and immutable original data');

cut = A.cutReference(reference, 5, { transform: identity, regionIds: ['plate'] });
assert.equal(cut.regions[0].status, 'available'); assert.equal(cut.regions[0].contour_id, 'plate-5');
assert.equal(A.cutReference(reference, 5.001, { transform: identity, regionIds: ['plate'] }).regions[0].status, 'unavailable');
const contourOnly = { ...reference, mesh: null, regions: [reference.regions[2]] };
assert.equal(A.cutReference(contourOnly, 5, { transform: identity, regionIds: ['plate'] }).regions[0].status, 'available');
assert.equal(A.cutReference(contourOnly, 5, { transform: identity, regionIds: ['__reference__'] }).regions[0].reason, 'geometry_not_supplied');
const tilted = { rotation: [[1, 0, 0], [0, 0, -1], [0, 1, 0]], translation: [0, 0, 0], scale: 1 };
assert.equal(A.cutReference(reference, 0, { transform: tilted, regionIds: ['plate'] }).regions[0].reason, 'no_calibrated_contour_on_cut_plane');
checks.push('Calibrated contour plates are available only on their actual transformed plane; no contour extrapolation or fabricated tilted sections');

const outer = frustum(3, 3), inner = frustum(1, 1), shell = { positions: [...outer.positions, ...inner.positions], indices: [...outer.indices, ...inner.indices.map(i => i + 8)] };
const holeReference = { ...reference, regions: [{ id: 'shell', name: 'Synthetic hollow cross-section', mesh: shell }] };
const holeObserved = { unit: 'um', z_um: 5, rois: [{ kind: 'area', paths: [square(3), square(1)] }] };
const holes = A.rankCandidateCuts(holeReference, holeObserved, [{ id: 'hole', z_um: 5 }], { ...options, regionId: 'shell' });
assert.equal(holes.candidates[0].cut.paths.length, 2); assert.equal(holes.candidates[0].dice, 1);
assert.equal(holes.candidates[0].reference_pixels, (36 - 4) / (.125 * .125));
const openMesh = clone(whole); openMesh.indices = openMesh.indices.slice(0, 6);
const openReference = { ...reference, regions: [{ id: 'open', name: 'Synthetic open sheet', mesh: openMesh }] };
const openRank = A.rankCandidateCuts(openReference, observed, [{ id: 'coplanar', z_um: 0 }], { ...options, regionId: 'open' });
assert.equal(openRank.candidates[0].status, 'unscored'); assert.equal(openRank.candidates[0].reason, 'coplanar_surface_without_closed_boundary');
const broken = clone(whole); broken.indices = broken.indices.slice(0, -6);
const brokenReference = { ...reference, regions: [{ id: 'broken', name: 'Missing side', mesh: broken }] };
assert.equal(A.cutReference(brokenReference, 5, { transform: identity, regionIds: ['broken'] }).regions[0].reason, 'mesh_cut_open_or_branched');
checks.push('Nested cut loops preserve holes; incomplete or branched mesh cuts are unscored rather than silently closed');

const tie = A.rankCandidateCuts(reference, observed, [{ id: 'a', z_um: 5 }, { id: 'b', z_um: 5 }], options);
assert.equal(tie.proposal_status, 'ambiguous'); assert.equal(tie.proposed_candidate_id, null); assert.deepEqual(tie.best_candidate_ids, ['a', 'b']);
const missing = A.rankCandidateCuts(reference, { unit: 'um', z_um: 5, rois: [] }, candidates, options);
assert.equal(missing.proposal_status, 'no_comparable_candidate'); assert(missing.candidates.every(c => c.dice === null));
const missingLabel = A.rankCandidateCuts(reference, observed, candidates, { ...options, regionId: 'unknown' });
assert(missingLabel.candidates.every(c => c.reason === 'label_not_supplied' && c.dice === null));
const cropped = A.rankCandidateCuts(reference, observed, candidates, { ...options, grid: { origin: [-1, -1], spacing_um: .125, width: 16, height: 16 } });
assert(cropped.candidates.every(c => c.reason === 'observed_outside_declared_grid' && c.dice === null));
const referenceCropped = A.rankCandidateCuts(reference, observed, [{ id: 'wide', z_um: 10 }], { ...options, grid: { origin: [-2, -2], spacing_um: .125, width: 32, height: 32 } });
assert.equal(referenceCropped.candidates[0].reason, 'reference_outside_declared_grid');
const nearCropped = A.rankCandidateCuts(reference, observed, [{ id: 'small-excess', z_um: 5.001 }], { ...options, tolerance_um: .001, grid: { origin: [-2, -2], spacing_um: .125, width: 32, height: 32 } });
assert.equal(nearCropped.candidates[0].reason, 'reference_outside_declared_grid');
const displaced = A.rankCandidateCuts(reference, { unit: 'um', z_um: 5, rois: [{ kind: 'area', paths: [square(.25, 3.5, 3.5)] }] }, [{ id: 'none', z_um: 5 }], options);
assert.equal(displaced.candidates[0].dice, 0); assert.equal(displaced.proposal_status, 'no_overlap'); assert.equal(displaced.proposed_candidate_id, null);
checks.push('Missingness, cropped fields, absent labels, exact ties and zero overlap do not produce false confident matches');

assert.throws(() => A.validateReference({ ...reference, unit: 'mm' }), /µm/);
assert.throws(() => A.validateReference({ ...reference, source: { ...reference.source, sha256: 'missing' } }), /SHA/);
assert.throws(() => A.validateReference({ ...reference, regions: [{ id: 'r', name: '' }] }), /names/);
assert.throws(() => A.validateReference({ ...reference, regions: [reference.regions[0], reference.regions[0]] }), /unique/);
const invalidMesh = clone(reference); invalidMesh.regions[0].mesh.indices[0] = 9999;
assert.throws(() => A.validateReference(invalidMesh), /indices/);
const nonfinite = clone(reference); nonfinite.regions[0].mesh.positions[0] = NaN;
assert.throws(() => A.validateReference(nonfinite), /mesh/);
assert.throws(() => A.cutReference(reference, 5), /explicit/);
assert.throws(() => A.cutReference(reference, 5, { transform: { ...identity, scale: 2 } }), /scale/);
assert.throws(() => A.cutReference(reference, 5, { transform: { ...identity, rotation: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]] } }), /reflection/);
assert.throws(() => A.rankCandidateCuts(reference, { ...observed, unit: 'pixel' }, candidates, options), /unit/);
assert.throws(() => A.rankCandidateCuts(reference, observed, candidates, { ...options, grid: { ...options.grid, width: 513 } }), /grid/);
assert.throws(() => A.rankCandidateCuts(reference, observed, Array.from({ length: 65 }, (_, i) => ({ id: String(i), z_um: i })), options), /1–64/);
const expensiveObserved = { unit: 'um', z_um: 5, rois: [{ kind: 'area', paths: [Array.from({ length: 80000 }, (_, i) => square(2)[i % 4])] }] };
assert.throws(() => A.rankCandidateCuts(reference, expensiveObserved, [{ id: 'bounded', z_um: 5 }], { ...options, grid: { origin: [-4, -4], spacing_um: .015625, width: 512, height: 512 } }), /scanline checks/);
assert.deepEqual(reference, original);
checks.push('Invalid units, source identity, names, indices, nonfinite coordinates, transforms and resource limits are rejected');

console.log(JSON.stringify({ pass: true, scope: 'Synthetic geometry and provenance regression tests only; not biological atlas recognition or lobule-label validation.', checks,
  exact_match_dice: rank.candidates[1].dice, known_smaller_cut_dice: rank.candidates[0].dice, rigid_match_dice: shifted.candidates[0].dice, hollow_cut_paths: holes.candidates[0].cut.paths.length }, null, 2));
