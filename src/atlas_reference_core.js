/* Optional reference geometry comparison. Scores are shape overlap, not anatomical confidence. */
(function (root) {
  'use strict';
  const VERSION = 'cerebellum-atlas-reference/1';
  const LIMITS = Object.freeze({ regions: 128, regionTriangles: 600000, regionVertices: 300000,
    contours: 512, contourVertices: 2000000, candidates: 64, gridAxis: 512, triangleTests: 40000000, rasterEdgeTests: 40000000 });
  const fail = message => { throw Error(message); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const coordinate = value => finite(value) && Math.abs(value) <= 1e8;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  function core() {
    const value = root.ReconstructionCore || (typeof require === 'function' ? require('./reconstruction_core.js') : null);
    if (!value) fail('Load ReconstructionCore before AtlasReferenceCore.');
    return value;
  }
  function source(value) {
    if (!value || !text(value.name, 1024) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256) || !text(value.license_note, 4000)) {
      fail('Reference provenance requires a source name, SHA-256 and licence note.');
    }
    return clone(value);
  }
  function paths(value, budget) {
    if (!Array.isArray(value) || !value.length) fail('Reference area contours require nonempty paths.');
    return value.map(path => {
      if (!Array.isArray(path) || path.length < 3) fail('A closed contour needs at least three points.');
      budget.count += path.length;
      if (budget.count > LIMITS.contourVertices) fail('Reference contours exceed two million vertices.');
      return path.map(point => {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(coordinate)) fail('Contour coordinates must be finite physical XY values in µm.');
        return point.slice();
      });
    });
  }
  function validateReference(atlas) {
    const C = core();
    if (!atlas || atlas.schema !== 'cerebellum-atlas/1' || atlas.unit !== 'um') fail('Reference must use cerebellum-atlas/1 and physical µm coordinates.');
    let base;
    if (atlas.mesh !== undefined && atlas.mesh !== null) base = C.validateAtlas(atlas);
    else {
      const landmarks = atlas.landmarks === undefined ? [] : atlas.landmarks, ids = new Set();
      if (!Array.isArray(landmarks) || landmarks.length > 100) fail('At most 100 reference landmarks are supported.');
      for (const landmark of landmarks) {
        if (!landmark || !text(landmark.id, 200) || ids.has(landmark.id) || !Array.isArray(landmark.position) || landmark.position.length !== 3 || !landmark.position.every(coordinate)) fail('Invalid reference landmark.');
        ids.add(landmark.id);
      }
      base = { schema: atlas.schema, unit: 'um', source: source(atlas.source), mesh: null, landmarks: clone(landmarks) };
    }
    const regions = atlas.regions === undefined ? [] : atlas.regions;
    if (!Array.isArray(regions) || regions.length > LIMITS.regions) fail('Reference supports at most 128 named regions.');
    let meshVertices = 0, meshTriangles = 0;
    const ids = new Set(), budget = { count: 0 };
    base.regions = regions.map(region => {
      if (!region || !text(region.id, 200) || region.id === '__reference__' || ids.has(region.id) || !text(region.name, 400)) fail('Region IDs must be unique and names must be explicit.');
      ids.add(region.id);
      const result = { id: region.id, name: region.name, source: region.source ? source(region.source) : clone(base.source), mesh: null, contours: [] };
      if (region.mesh !== undefined && region.mesh !== null) {
        const m = region.mesh;
        if (!Array.isArray(m.positions) || !Array.isArray(m.indices)) fail('Invalid regional mesh.');
        meshVertices += m.positions.length / 3; meshTriangles += m.indices.length / 3;
        if (meshVertices > LIMITS.regionVertices || meshTriangles > LIMITS.regionTriangles) fail('Combined regional meshes exceed 300,000 vertices or 600,000 triangles.');
        result.mesh = C.validateAtlas({ ...base, source: result.source, mesh: m, landmarks: [] }).mesh;
      }
      const contours = region.contours === undefined ? [] : region.contours;
      if (!Array.isArray(contours) || contours.length > LIMITS.contours) fail('A region supports at most 512 calibrated contour plates.');
      const contourIds = new Set(), depths = new Set();
      result.contours = contours.map(contour => {
        if (!contour || !text(contour.id, 200) || contourIds.has(contour.id) || !coordinate(contour.z_um) || depths.has(contour.z_um)) fail('Contour plates need unique IDs and unique finite Z values in µm.');
        contourIds.add(contour.id); depths.add(contour.z_um);
        return { id: contour.id, z_um: contour.z_um, paths: paths(contour.paths, budget), source: contour.source ? source(contour.source) : clone(result.source) };
      });
      return result;
    });
    return base;
  }
  function rigid(value) {
    if (!value || value.scale !== 1 || !Array.isArray(value.rotation) || value.rotation.length !== 3 || value.rotation.some(row => !Array.isArray(row) || row.length !== 3 || !row.every(finite)) || !Array.isArray(value.translation) || value.translation.length !== 3 || !value.translation.every(coordinate)) fail('Supply an explicit atlas-to-specimen rigid transform with scale 1.');
    const r = value.rotation;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(dot(r[i], r[j]) - (i === j ? 1 : 0)) > 1e-8) fail('Atlas rotation must be orthonormal.');
    if (Math.abs(dot(r[0], cross(r[1], r[2])) - 1) > 1e-8) fail('Atlas comparison does not accept reflection or scale changes.');
    const result = { rotation: clone(r), translation: value.translation.slice(), scale: 1 };
    for (const key of ['version', 'rms_error_um', 'max_error_um', 'flags', 'source_landmarks', 'target_landmarks']) if (value[key] !== undefined) result[key] = clone(value[key]);
    return result;
  }
  function prepareReference(atlas, options = {}) {
    const reference = validateReference(atlas), transform = rigid(options.transform);
    const tolerance = options.tolerance_um === undefined ? 1e-6 : options.tolerance_um;
    if (!finite(tolerance) || tolerance < 1e-7 || tolerance > 1) fail('Cut tolerance must be between 0.0000001 and 1 µm.');
    const apply = point => {
      const result = transform.rotation.map((row, i) => dot(row, point) + transform.translation[i]);
      if (!result.every(coordinate)) fail('Transformed reference coordinates exceed supported physical bounds.');
      return result;
    };
    function mesh(value) {
      if (!value) return null;
      const positions = value.positions.slice();
      for (let i = 0; i < positions.length; i += 3) {
        const point = apply(positions.slice(i, i + 3));
        positions[i] = point[0]; positions[i + 1] = point[1]; positions[i + 2] = point[2];
      }
      return { positions, indices: value.indices.slice() };
    }
    const regions = [{ id: '__reference__', name: 'Whole supplied reference mesh', source: clone(reference.source), mesh: reference.mesh, contours: [] }, ...reference.regions].map(region => ({
      id: region.id, name: region.name, source: clone(region.source), mesh: mesh(region.mesh),
      contours: region.contours.map(contour => ({ id: contour.id, source: clone(contour.source), atlas_z_um: contour.z_um,
        paths3d: contour.paths.map(path => path.map(([x, y]) => apply([x, y, contour.z_um]))) }))
    }));
    return { version: VERSION, unit: 'um', coordinate_frame: 'specimen', source: clone(reference.source), transform, tolerance_um: tolerance, regions };
  }
  function stitch(segments, tolerance) {
    const nodes = new Map(), edges = new Map();
    const key = point => point.map(v => Math.round(v / tolerance)).join(':');
    function node(point) { const id = key(point); if (!nodes.has(id)) nodes.set(id, { point: point.slice(), adjacent: [] }); return id; }
    for (const [a, b] of segments) {
      const x = node(a), y = node(b); if (x === y) continue;
      const id = x < y ? x + '|' + y : y + '|' + x;
      if (edges.has(id)) continue;
      edges.set(id, [x, y]); nodes.get(x).adjacent.push({ id, next: y }); nodes.get(y).adjacent.push({ id, next: x });
    }
    const output = [...edges.values()].map(([a, b]) => [nodes.get(a).point.slice(), nodes.get(b).point.slice()]);
    const used = new Set(), loops = [];
    const invalid = [...nodes.values()].filter(n => n.adjacent.length !== 2).length;
    if (invalid) return { segments: output, paths: [], topology: 'open_or_branched', irregular_nodes: invalid };
    for (const [edgeId, ends] of edges) {
      if (used.has(edgeId)) continue;
      const start = ends[0], loop = []; let current = start, previousEdge = null;
      do {
        loop.push(nodes.get(current).point.slice());
        const next = nodes.get(current).adjacent.find(e => e.id !== previousEdge && !used.has(e.id));
        if (!next) return { segments: output, paths: [], topology: 'open_or_branched', irregular_nodes: 1 };
        used.add(next.id); previousEdge = next.id; current = next.next;
      } while (current !== start && loop.length <= edges.size);
      if (loop.length < 3 || current !== start) return { segments: output, paths: [], topology: 'open_or_branched', irregular_nodes: 1 };
      loops.push(loop);
    }
    return { segments: output, paths: loops, topology: 'closed', irregular_nodes: 0 };
  }
  function cutMesh(mesh, z, tolerance) {
    const segments = []; let coplanar = 0;
    const at = index => mesh.positions.slice(index * 3, index * 3 + 3);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const points = mesh.indices.slice(i, i + 3).map(at), d = points.map(p => Math.abs(p[2] - z) <= tolerance ? 0 : p[2] - z);
      if (d.every(v => v > 0) || d.every(v => v < 0)) continue;
      if (d.every(v => v === 0)) { coplanar++; continue; }
      const crossings = [];
      for (let k = 0; k < 3; k++) {
        const j = (k + 1) % 3;
        if (d[k] === 0) crossings.push(points[k].slice(0, 2));
        if (d[k] * d[j] < 0) {
          const t = d[k] / (d[k] - d[j]);
          crossings.push([points[k][0] + t * (points[j][0] - points[k][0]), points[k][1] + t * (points[j][1] - points[k][1])]);
        }
      }
      if (crossings.length === 2 && Math.hypot(crossings[0][0] - crossings[1][0], crossings[0][1] - crossings[1][1]) > tolerance) segments.push(crossings);
    }
    const result = stitch(segments, tolerance);
    return { ...result, coplanar_triangles: coplanar };
  }
  function selectedRegions(prepared, ids) {
    if (ids === undefined) return prepared.regions;
    if (!Array.isArray(ids) || !ids.length || ids.length > LIMITS.regions + 1 || new Set(ids).size !== ids.length || ids.some(id => !text(id, 200))) fail('Select distinct region IDs.');
    return ids.map(id => prepared.regions.find(r => r.id === id) || { id, name: null, source: null, mesh: null, contours: [], missing_label: true });
  }
  function cutPrepared(prepared, z_um, options = {}) {
    if (!coordinate(z_um)) fail('Reference cut depth must be a finite specimen Z in µm.');
    const tolerance = prepared.tolerance_um;
    const regions = selectedRegions(prepared, options.regionIds).map(region => {
      const base = { id: region.id, name: region.name, source: clone(region.source), paths: [], segments: [], status: 'unavailable', reason: null };
      if (region.missing_label) return { ...base, reason: 'label_not_supplied' };
      if (region.mesh) {
        const cut = cutMesh(region.mesh, z_um, tolerance);
        if (cut.topology !== 'closed') return { ...base, ...cut, reason: 'mesh_cut_open_or_branched', geometry_source: 'mesh' };
        if (!cut.paths.length) return { ...base, ...cut, status: cut.coplanar_triangles ? 'unavailable' : 'empty', reason: cut.coplanar_triangles ? 'coplanar_surface_without_closed_boundary' : 'no_mesh_intersection', geometry_source: 'mesh' };
        return { ...base, ...cut, status: 'available', geometry_source: 'mesh', reason: null };
      }
      if (!region.contours.length) return { ...base, reason: 'geometry_not_supplied' };
      const matches = region.contours.filter(contour => contour.paths3d.every(path => path.every(point => Math.abs(point[2] - z_um) <= tolerance)));
      if (matches.length !== 1) return { ...base, reason: matches.length ? 'multiple_contour_planes_within_tolerance' : 'no_calibrated_contour_on_cut_plane', geometry_source: 'calibrated_contour' };
      const contour = matches[0], result = contour.paths3d.map(path => path.map(p => p.slice(0, 2)));
      return { ...base, status: 'available', paths: result, segments: result.flatMap(path => path.map((p, i) => [p.slice(), path[(i + 1) % path.length].slice()])),
        geometry_source: 'calibrated_contour', contour_id: contour.id, atlas_z_um: contour.atlas_z_um, source: clone(contour.source) };
    });
    return { version: VERSION, unit: 'um', coordinate_frame: 'specimen', z_um, regions, transform: clone(prepared.transform), tolerance_um: tolerance,
      source: clone(prepared.source), interpretation: 'Cuts of a supplied atlas reference; region names are supplied labels, not confirmed identities in the specimen.' };
  }
  function cutReference(atlas, z_um, options = {}) { return cutPrepared(prepareReference(atlas, options), z_um, options); }
  function gridSettings(value) {
    if (!value || !Array.isArray(value.origin) || value.origin.length !== 2 || !value.origin.every(coordinate) || !finite(value.spacing_um) || value.spacing_um <= 0 || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > LIMITS.gridAxis || value.height > LIMITS.gridAxis) fail('Declare a complete physical XY grid: origin, positive spacing_um, width and height up to 512.');
    const end = [value.origin[0] + value.width * value.spacing_um, value.origin[1] + value.height * value.spacing_um];
    if (!end.every(coordinate) || end.some((v, i) => v <= value.origin[i])) fail('Comparison grid is outside supported physical precision/bounds.');
    return { origin: value.origin.slice(), spacing_um: value.spacing_um, width: value.width, height: value.height, sampling: 'pixel_centers', extent: [...value.origin, ...end] };
  }
  function fits(rois, grid) {
    // Plane-stitch tolerance must not license cropping outside the declared XY field.
    const tolerance = Math.max(1e-10, ...grid.extent.map(v => Math.abs(v) * Number.EPSILON * 16));
    return rois.every(roi => roi.paths.every(path => path.every(([x, y]) => x >= grid.extent[0] - tolerance && x <= grid.extent[2] + tolerance && y >= grid.extent[1] - tolerance && y <= grid.extent[3] + tolerance)));
  }
  function raster(rois, grid) {
    const mask = new Uint8Array(grid.width * grid.height);
    for (const roi of rois) for (let row = 0; row < grid.height; row++) {
      const y = grid.origin[1] + (row + .5) * grid.spacing_um, xs = [];
      for (const path of roi.paths) for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const a = path[j], b = path[i];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const start = Math.max(0, Math.ceil((xs[i] - grid.origin[0]) / grid.spacing_um - .5));
        const stop = Math.min(grid.width, Math.ceil((xs[i + 1] - grid.origin[0]) / grid.spacing_um - .5));
        for (let col = start; col < stop; col++) mask[row * grid.width + col] = 1;
      }
    }
    return mask;
  }
  function observedInput(value) {
    if (!value || value.unit !== 'um' || !coordinate(value.z_um)) fail('Observed contours require unit um and actual Z in µm.');
    if (value.rois === undefined || value.rois === null || (Array.isArray(value.rois) && !value.rois.length)) return { z_um: value.z_um, rois: [], status: 'missing_observed_geometry' };
    if (!Array.isArray(value.rois)) fail('Observed ROIs must be an array.');
    const budget = { count: 0 }, rois = value.rois.map(roi => {
      if (!roi || roi.kind !== 'area' || roi.closed === false) fail('Only closed observed area ROIs can be compared.');
      return { paths: paths(roi.paths, budget) };
    });
    return { z_um: value.z_um, rois, status: 'available' };
  }
  function rankCandidateCuts(atlas, observed, candidates, options = {}) {
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > LIMITS.candidates) fail('Supply 1–64 explicitly calibrated candidate cut depths.');
    if (!text(options.regionId, 200)) fail('Select an explicit reference region ID, or __reference__ for the unlabelled whole reference.');
    const ids = new Set();
    for (const candidate of candidates) {
      if (!candidate || !text(candidate.id, 200) || ids.has(candidate.id) || !coordinate(candidate.z_um) || (candidate.name !== undefined && !text(candidate.name, 400))) fail('Candidate IDs must be unique with finite physical depths and optional explicit names.');
      if(candidate.source_page!==undefined&&candidate.source_page!==null&&!(Number.isSafeInteger(candidate.source_page)&&candidate.source_page>=1)&&!text(candidate.source_page,1024))fail('Candidate source page must be an explicit page number or label.');
      ids.add(candidate.id);
    }
    const prepared = prepareReference(atlas, options), grid = gridSettings(options.grid), obs = observedInput(observed), region = selectedRegions(prepared, [options.regionId])[0];
    if ((region.mesh?.indices.length || 0) / 3 * candidates.length > LIMITS.triangleTests) fail('Comparison exceeds 40 million triangle-plane checks; reduce the candidate set or explicitly prepare a coarser reference.');
    let rasterWork = 0;
    function boundedRaster(rois) {
      rasterWork += rois.reduce((sum, roi) => sum + roi.paths.reduce((n, path) => n + path.length, 0), 0) * grid.height;
      if (rasterWork > LIMITS.rasterEdgeTests) fail('Comparison exceeds 40 million contour-edge scanline checks; reduce candidates or grid resolution. Source geometry has not been simplified.');
      return raster(rois, grid);
    }
    if (obs.status === 'available' && !fits(obs.rois, grid)) obs.status = 'observed_outside_declared_grid';
    const mask = obs.status === 'available' ? boundedRaster(obs.rois) : null, count = mask ? mask.reduce((sum, v) => sum + v, 0) : null;
    if (count === 0) obs.status = 'observed_below_grid_resolution';
    const results = candidates.map((candidate, input_order) => {
      const cut = cutPrepared(prepared, candidate.z_um, { regionIds: [options.regionId] }).regions[0];
      const result = { id: candidate.id, name: candidate.name ?? null, source_page: candidate.source_page ?? null, z_um: candidate.z_um, input_order, cut, status: 'unscored', reason: null, dice: null, iou: null,
        observed_pixels: count, reference_pixels: null, intersection_pixels: null, union_pixels: null };
      if (obs.status !== 'available') return { ...result, reason: obs.status };
      if (cut.status !== 'available') return { ...result, reason: cut.reason || 'reference_cut_unavailable' };
      const rois = [{ paths: cut.paths }];
      if (!fits(rois, grid)) return { ...result, reason: 'reference_outside_declared_grid' };
      const referenceMask = boundedRaster(rois); let intersection = 0, referenceCount = 0;
      for (let i = 0; i < mask.length; i++) { referenceCount += referenceMask[i]; if (referenceMask[i] && mask[i]) intersection++; }
      if (!referenceCount) return { ...result, reason: 'reference_below_grid_resolution', reference_pixels: 0 };
      const union = count + referenceCount - intersection;
      return { ...result, status: 'scored', dice: 2 * intersection / (count + referenceCount), iou: intersection / union,
        reference_pixels: referenceCount, intersection_pixels: intersection, union_pixels: union };
    });
    const ranked = results.filter(r => r.status === 'scored').sort((a, b) => b.dice - a.dice || a.input_order - b.input_order);
    const best = ranked.filter(r => Math.abs(r.dice - ranked[0].dice) <= 1e-12).map(r => r.id);
    const status = !ranked.length ? 'no_comparable_candidate' : ranked[0].dice === 0 ? 'no_overlap' : best.length > 1 ? 'ambiguous' : 'candidate_only';
    return { version: VERSION, unit: 'um', coordinate_frame: 'specimen', source: clone(prepared.source), transform: clone(prepared.transform),
      observed: { z_um: obs.z_um, status: obs.status, foreground_pixels: count }, settings: { region_id: options.regionId, grid, tolerance_um: prepared.tolerance_um,
        metric: 'Dice and IoU on the same full declared XY grid', fill: 'even-odd within ROI; union across observed ROIs', alignment_search: false },
      candidates: results, ranked_candidate_ids: ranked.map(r => r.id), best_candidate_ids: best, proposal_status: status,
      proposed_candidate_id: status === 'candidate_only' ? best[0] : null, probability: null,
      interpretation: 'A shape-overlap proposal among the supplied cuts only. It does not identify a biological lobule, establish atlas accuracy, or alter observed contours and native measurements.' };
  }
  const api = Object.freeze({ VERSION, LIMITS, validateReference, prepareReference, cutPrepared, cutReference, rankCandidateCuts });
  root.AtlasReferenceCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
