#!/usr/bin/env python3
"""Stack the ROI outlines that atlas_match placed in the atlas frame into a 3D arrangement per animal, and integrate
section areas over the matched lateral positions.

Each section sits at the lateral position printed on its most similar atlas plate. Sections matched to the same plate
share one position; their areas are averaged there. A volume is the trapezoid integral of area over those positions,
between the smallest and largest matched position of the animal or over a stated common range. It is a volume in the
atlas frame of one side of the cerebellum, built from matches that are themselves estimates; it is not a measured
volume of the animal, and no section thickness enters it.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nissl_lab import file_digest, require  # noqa: E402
from atlas_match import resample  # noqa: E402
from section_profiles import section_values  # noqa: E402

SCHEMA = 'cerebellum-atlas-reconstruction/1'
VALUES = ('Cb', 'GL_TOTAL', 'WM', 'Cb-GL-WM')
VIEW_ROIS = ('Cb', 'GL_TOTAL', 'WM', 'PL_TOTAL')
VIEW_STEP_UM = 60.0
STATEMENT = ('Sections placed at the lateral position of their most similar atlas drawing. Positions are estimates in the frame of a published '
             'composite atlas, one side only; volumes are integrals over those positions, not measured volumes; nothing is approved anatomy.')


def integral(points, low, high):
    """Trapezoid integral of (position, value) between two positions; None unless the positions reach both ends."""
    points = sorted(points)
    if len(points) < 2 or points[0][0] > low or points[-1][0] < high or low >= high:
        return None
    xs = [p for p, _ in points]
    ys = [v for _, v in points]
    grid = [low] + [x for x in xs if low < x < high] + [high]
    values = np.interp(grid, xs, ys)
    return float(sum((values[i] + values[i + 1]) / 2 * (grid[i + 1] - grid[i]) for i in range(len(grid) - 1)))


def sensitivity(entry, plate_positions, common, draws, seed):
    """How much the volumes move when every section's match is off by up to one plate either way, drawn independently and
    evenly from {one plate medial, as matched, one plate lateral}. Returns the 2.5th, 50th and 97.5th percentile in mm3."""
    rng = np.random.default_rng(seed)
    index = {p: i for i, p in enumerate(plate_positions)}
    out = {}
    for name in VALUES:
        sections = [s for s in entry['sections'] if s[name] is not None]
        found = []
        for _ in range(draws):
            moved = {}
            for s in sections:
                i = min(len(plate_positions) - 1, max(0, index[s['lateral_um']] + int(rng.integers(-1, 2))))
                moved.setdefault(plate_positions[i], []).append(s[name])
            points = sorted((p, float(np.mean(v))) for p, v in moved.items())
            low, high = common if common else (points[0][0], points[-1][0])
            value = integral(points, low, high)
            if value is not None:
                found.append(value / 1000)
        out[name] = None if len(found) < draws * 0.9 else {'p2_5': float(np.percentile(found, 2.5)), 'median': float(np.median(found)),
                                                           'p97_5': float(np.percentile(found, 97.5)), 'draws_with_full_range': len(found)}
    return out


def animal_of(sample):
    return sample.rsplit('-', 1)[0]


def arrange(match, values_of, common=None):
    """Per animal: sections ordered by matched position, areas averaged per position, and volumes in mm3."""
    animals = {}
    for row in match['sections']:
        entry = animals.setdefault(animal_of(row['sample']), {'sections': []})
        number = int(row['sample'].rsplit('-', 1)[1])
        entry['sections'].append({'sample': row['sample'], 'number': number, 'figure': row['best']['figure'], 'lateral_um': row['best']['lateral_um'],
                                  'distance_um': row['best']['distance_um'], 'name_score': row['best']['name_score'], 'margin_um': row['margin_um'],
                                  'mirror': row['best']['mirror'], 'scale': row['best']['scale'], **{k: values_of[row['sample']].get(k) for k in VALUES}})
    for entry in animals.values():
        entry['sections'].sort(key=lambda s: (s['lateral_um'], s['number']))
        positions = sorted({s['lateral_um'] for s in entry['sections']})
        entry['positions_um'] = positions
        entry['sections_sharing_a_position'] = len(entry['sections']) - len(positions)
        entry['range_um'] = [positions[0], positions[-1]]
        mean_at = {name: [(p, float(np.mean([s[name] for s in entry['sections'] if s['lateral_um'] == p and s[name] is not None])))
                          for p in positions if any(s['lateral_um'] == p and s[name] is not None for s in entry['sections'])] for name in VALUES}
        entry['volume_mm3_own_range'] = {name: (lambda v: None if v is None else v / 1000)(integral(mean_at[name], positions[0], positions[-1])) for name in VALUES}
        entry['volume_mm3_common_range'] = None if common is None else {name: (lambda v: None if v is None else v / 1000)(integral(mean_at[name], *common)) for name in VALUES}
        ordered = sorted(entry['sections'], key=lambda s: s['number'])
        entry['order_by_number'] = [[s['number'], s['lateral_um']] for s in ordered]
    return animals


def viewer_data(placed, animals):
    out = {}
    for animal, entry in animals.items():
        sections = []
        for s in entry['sections']:
            rois = placed['sections'][s['sample']]['rois']
            lines = {}
            for name in VIEW_ROIS:
                if name in rois:
                    lines[name] = [np.round(resample(p, VIEW_STEP_UM, rois[name]['closed']), 0).astype(int).tolist() + ([] if not rois[name]['closed'] else [])
                                   for p in rois[name]['paths']]
                    lines[name] = [(l + [l[0]]) if rois[name]['closed'] and l else l for l in lines[name]]
            sections.append({'sample': s['sample'], 'z': s['lateral_um'], 'figure': s['figure'], 'rois': lines})
        out[animal] = sections
    return out


VIEWER = """<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>아틀라스 위치로 쌓은 절편</title><style>
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;background:#f6f5f2;color:#1c1b19}
main{max-width:1100px;margin:0 auto;padding:16px}canvas{width:100%;height:auto;background:#fff;border:1px solid #d9d6cf;border-radius:10px;touch-action:none;cursor:grab}
.notice{border:1px solid #d9d6cf;border-left:4px solid #c62828;background:#fff;padding:10px 14px;border-radius:6px}
.bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:10px 0}button,select{font:inherit;padding:5px 10px;border-radius:6px;border:1px solid #d9d6cf;background:#fff}
button.on{background:#1c1b19;color:#fff}table{border-collapse:collapse;margin:10px 0;display:block;overflow-x:auto}th,td{border:1px solid #d9d6cf;padding:3px 9px;text-align:right;white-space:nowrap}
</style></head><body><main><h1>아틀라스 위치로 쌓은 절편</h1>
<p class="notice"><b>측정된 3D 모양이 아닙니다.</b> 절편마다 사람이 그린 ROI와 가장 비슷한 아틀라스 그림을 찾아, 그 그림에 적힌 가쪽 위치에 절편을 놓고 그림에 맞게 돌리고 옮긴 것입니다. 아틀라스는 다른 뇌를 합쳐 그린 출판 그림이고, 왼쪽과 오른쪽은 가리지 않으며, 대조 결과는 추정입니다.</p>
<div class="bar"><label>개체 <select id="animal"></select></label><span id="layers"></span><button type="button" id="reset">처음 보기로</button><span id="info"></span></div>
<canvas id="view" width="1600" height="1000"></canvas>
<p>끌어서 돌리고, 휠이나 두 손가락으로 크기를 바꿉니다. 가로축은 앞뒤(AP), 세로축은 등배(DV), 깊이는 정중선에서 가쪽까지의 거리입니다. 가까운 절편일수록 진하게 그립니다.</p>
<div id="table"></div></main><script>
const DATA=@DATA@,INFO=@INFO@,COL={Cb:'#444444',GL_TOTAL:'#0097a7',WM:'#ef6c00',PL_TOTAL:'#d500a0'},NAME={Cb:'Cb',GL_TOTAL:'GL',WM:'WM',PL_TOTAL:'PL'};
const cv=document.getElementById('view'),cx=cv.getContext('2d'),sel=document.getElementById('animal');let yaw=-0.6,pitch=0.25,zoom=1,on={Cb:true,GL_TOTAL:true,WM:false,PL_TOTAL:true};
Object.keys(DATA).sort().forEach(a=>{const o=document.createElement('option');o.value=a;o.textContent=a+' ('+INFO[a].group+')';sel.appendChild(o)});
const lay=document.getElementById('layers');Object.keys(COL).forEach(k=>{const b=document.createElement('button');b.type='button';b.textContent=NAME[k];b.style.borderColor=COL[k];b.className=on[k]?'on':'';b.onclick=()=>{on[k]=!on[k];b.className=on[k]?'on':'';draw()};lay.appendChild(b);lay.append(' ')});
function draw(){const S=DATA[sel.value];cx.clearRect(0,0,cv.width,cv.height);let xs=[],ys=[],zs=[];S.forEach(s=>{zs.push(s.z);(s.rois.Cb||[]).forEach(l=>l.forEach(p=>{xs.push(p[0]);ys.push(p[1])}))});
 const mx=(Math.min(...xs)+Math.max(...xs))/2,my=(Math.min(...ys)+Math.max(...ys))/2,mz=(Math.min(...zs)+Math.max(...zs))/2,span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys),Math.max(...zs)-Math.min(...zs));
 const k=cv.height*0.8/span*zoom,cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
 const P=(x,y,z)=>{x-=mx;y-=my;z-=mz;const x1=x*cy+z*sy,z1=-x*sy+z*cy,y1=y*cp-z1*sp,z2=y*sp+z1*cp;return[cv.width/2+x1*k,cv.height/2-y1*k,z2]};
 const order=S.map(s=>({s,d:P(mx,my,s.z)[2]})).sort((a,b)=>a.d-b.d),dmin=order[0].d,dmax=order[order.length-1].d;
 order.forEach(({s,d})=>{const near=dmax>dmin?(d-dmin)/(dmax-dmin):1;cx.globalAlpha=0.25+0.75*near;
  Object.keys(COL).forEach(n=>{if(!on[n]||!s.rois[n])return;cx.strokeStyle=COL[n];cx.lineWidth=n==='Cb'?1.6:1.2;s.rois[n].forEach(l=>{cx.beginPath();l.forEach((p,i)=>{const q=P(p[0],p[1],s.z);i?cx.lineTo(q[0],q[1]):cx.moveTo(q[0],q[1])});cx.stroke()})})});
 cx.globalAlpha=1;const I=INFO[sel.value];document.getElementById('info').textContent='절편 '+S.length+'개, 가쪽 '+I.range[0]+'에서 '+I.range[1]+' µm';
 document.getElementById('table').innerHTML='<table><tr><th>절편</th><th>아틀라스 그림</th><th>가쪽 위치 (µm)</th><th>모양 거리 (µm)</th><th>이름 일치</th><th>둘째 후보와의 차이 (µm)</th></tr>'+I.rows.map(r=>'<tr><th>'+r[0]+'</th><td>'+r[1]+'</td><td>'+r[2]+'</td><td>'+r[3]+'</td><td>'+r[4]+'</td><td>'+r[5]+'</td></tr>').join('')+'</table>'}
let drag=null;cv.addEventListener('pointerdown',e=>{drag=[e.clientX,e.clientY,yaw,pitch];cv.setPointerCapture(e.pointerId)});cv.addEventListener('pointermove',e=>{if(!drag)return;yaw=drag[2]+(e.clientX-drag[0])*0.008;pitch=Math.max(-1.5,Math.min(1.5,drag[3]+(e.clientY-drag[1])*0.008));draw()});
cv.addEventListener('pointerup',()=>drag=null);cv.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(0.3,Math.min(6,zoom*(e.deltaY<0?1.1:0.9)));draw()},{passive:false});
document.getElementById('reset').onclick=()=>{yaw=-0.6;pitch=0.25;zoom=1;draw()};sel.onchange=draw;draw();
</script></body></html>
"""


def main(argv=None):
    parser = argparse.ArgumentParser(description='3D arrangement and volumes from atlas-matched sections.')
    parser.add_argument('--match', required=True, type=Path, help='Folder written by atlas_match.')
    parser.add_argument('--manifest', required=True, type=Path, help='reference-manifest.json with the section areas.')
    parser.add_argument('--common-range', metavar='LOW,HIGH', help='Lateral positions in micrometres between which every animal is integrated.')
    parser.add_argument('--output', required=True, type=Path, help='New folder; an existing one is never touched.')
    parser.add_argument('--atlas', type=Path, help='The atlas series; with it the volumes are recomputed with every match moved by up to one plate.')
    parser.add_argument('--draws', type=int, default=2000)
    args = parser.parse_args(argv)
    try:
        output = args.output.resolve()
        require(not output.exists(), 'The output folder already exists.')
        match = json.loads((args.match / 'atlas-match.json').read_text())
        placed = json.loads((args.match / 'placed-outlines.json').read_text())
        require(match.get('schema') == 'cerebellum-atlas-match/1', 'Not an atlas match folder.')
        manifest = json.loads(args.manifest.read_text())
        values_of = {s['section_id']: section_values(s) for s in manifest['sections']}
        groups = {s['animal_id']: s['group'] for s in manifest['sections']}
        require(all(row['sample'] in values_of for row in match['sections']), 'A matched section is not in the manifest.')
        common = None
        if args.common_range:
            low, _, high = args.common_range.partition(',')
            common = (float(low), float(high))
            require(common[0] < common[1], 'Give the common range as LOW,HIGH in micrometres.')
        animals = arrange(match, values_of, common)
        plates = sorted(p['lateral_um'] for p in json.loads(args.atlas.read_text())['plates']) if args.atlas else None
        for animal, entry in animals.items():
            entry['group'] = groups[animal]
            entry['volume_mm3_if_matches_are_off_by_one_plate'] = None if plates is None else sensitivity(entry, plates, common, args.draws, 20261111)
        output.mkdir(parents=True)
        result = {'schema': SCHEMA, 'statement': STATEMENT, 'match_sha256': file_digest(args.match / 'atlas-match.json'),
                  'manifest_sha256': file_digest(args.manifest), 'common_range_um': common, 'animals': animals,
                  'code_sha256': file_digest(Path(__file__).resolve())}
        (output / 'reconstruction.json').write_text(json.dumps(result, indent=1) + '\n', encoding='utf-8')
        with open(output / 'atlas-volumes.csv', 'x', newline='', encoding='utf-8') as handle:
            writer = csv.writer(handle)
            writer.writerow(['Animal', 'Group', 'Sections', 'Positions', 'Lateral_min_um', 'Lateral_max_um'] + [n + '_mm3_own_range' for n in VALUES] + [n + '_mm3_common_range' for n in VALUES])
            for animal in sorted(animals):
                e = animals[animal]
                writer.writerow([animal, e['group'], len(e['sections']), len(e['positions_um']), e['range_um'][0], e['range_um'][1]] +
                                ['' if e['volume_mm3_own_range'][n] is None else '%.3f' % e['volume_mm3_own_range'][n] for n in VALUES] +
                                ['' if not e['volume_mm3_common_range'] or e['volume_mm3_common_range'][n] is None else '%.3f' % e['volume_mm3_common_range'][n] for n in VALUES])
        info = {a: {'group': e['group'], 'range': [int(e['range_um'][0]), int(e['range_um'][1])],
                    'rows': [[s['sample'], s['figure'], int(s['lateral_um']), round(s['distance_um']), '%.2f' % s['name_score'],
                              '' if s['margin_um'] is None else round(s['margin_um'], 1)] for s in sorted(e['sections'], key=lambda s: s['number'])]} for a, e in animals.items()}
        atlas_source = None
        if args.atlas:
            require(file_digest(args.atlas) == match.get('atlas_sha256'), 'The atlas file is not the one the sections were matched to.')
            atlas_source = json.loads(args.atlas.read_text()).get('source', {}).get('sha256')
        stack = {'schema': 'cerebellum-atlas-placed-stack/1', 'unit': 'um', 'coordinate_order': ['AP', 'DV', 'Lateral'], 'statement': STATEMENT,
                 'atlas_source_sha256': atlas_source, 'match_sha256': file_digest(args.match / 'atlas-match.json'),
                 'animals': {a: {'group': animals[a]['group'], 'sections': sections} for a, sections in viewer_data(placed, animals).items()}}
        (output / 'placed-stack.json').write_text(json.dumps(stack, separators=(',', ':')) + '\n', encoding='utf-8')
        (output / 'viewer.html').write_text(VIEWER.replace('@DATA@', json.dumps(viewer_data(placed, animals), separators=(',', ':'))).replace('@INFO@', json.dumps(info, ensure_ascii=False)), encoding='utf-8')
    except (ValueError, OSError, KeyError) as error:
        print('Not reconstructed: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps({'schema': SCHEMA, 'animals': len(animals)}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
