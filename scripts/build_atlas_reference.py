#!/usr/bin/env python3
"""Prepare a source-bound sagittal drawing series for reference inspection.

This serializes published ink, not approved tissue ROIs. It does not infer missing
anatomy, mirror a hemisphere, create endcaps, or measure biological volumes.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import fitz

SOURCE_SHA = 'c4f3a08f4130dac67c543c7d30aecc68cc11bd6f13c487c53637d2788a427afa'
BLUE = (0.667, 0.882, 0.980)
PALE = (0.882, 0.957, 0.992)
CYAN = (0.0, 0.682, 0.937)
LABELS = {'1Cb','2Cb','3Cb','4/5Cb','6Cb','7Cb','8Cb','9Cb','10Cb','Sim','Crus1','Crus2','PM','Cop','Fl','PFl','prf','pcuf','psf','icf','apmf','ppf','sf','plf','pcnf','Lat','Med','IntA','IntP'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')


def serial(value):
    if isinstance(value, (fitz.Point, fitz.Rect, fitz.Quad, tuple, list)):
        return [serial(x) for x in value]
    if isinstance(value, dict):
        return {k: serial(v) for k, v in value.items()}
    return value


def near(color, expected):
    return color is not None and len(color) == 3 and max(abs(a-b) for a,b in zip(color, expected)) < 0.002


def fit(observations):
    xs = [v['page_position_points'] for v in observations]
    ys = [v['printed_value_mm'] for v in observations]
    mx, my = sum(xs)/len(xs), sum(ys)/len(ys)
    a = sum((x-mx)*(y-my) for x,y in zip(xs,ys))/sum((x-mx)**2 for x in xs)
    b = my-a*mx
    residuals = [(a*x+b-y)*1000 for x,y in zip(xs,ys)]
    return {'slope_mm_per_pdf_point':a,'intercept_mm':b,
            'rms_grid_residual_um':math.sqrt(sum(v*v for v in residuals)/len(residuals)),
            'max_absolute_grid_residual_um':max(abs(v) for v in residuals),
            'observations':observations,'residuals_um':residuals}


def grid_fit(page, drawings):
    words = page.get_text('words')
    xlabels = [w for w in words if w[1] < 58 and re.fullmatch(r'-?\d+',w[4])]
    ylabels = [w for w in words if 951<w[0]<980 and 60<w[1]<490 and re.fullmatch(r'\d+',w[4])]
    xgrid,ygrid = [],[]
    for index,d in enumerate(drawings):
        if len(d['items']) != 1 or d['items'][0][0] != 'l':
            continue
        p,q = d['items'][0][1:]
        if abs(p.x-q.x)<0.001 and abs(p.y-q.y)>400 and min(p.y,q.y)<60:
            xgrid.append((index,p.x))
        if abs(p.y-q.y)<0.001 and abs(p.x-q.x)>880 and 100<p.y<470:
            ygrid.append((index,p.y))
    all_obs = []
    for labels,grid,axis in [(xlabels,xgrid,0),(ylabels,ygrid,1)]:
        require(bool(grid),'No published grid lines for a required axis')
        obs = []
        for word in labels:
            center = (word[axis]+word[axis+2])/2
            index,position = min(grid,key=lambda it:abs(it[1]-center))
            require(abs(position-center)<1,'Numeric grid label is not aligned to its source grid line')
            obs.append({'page_position_points':position,'printed_value_mm':float(word[4]),
                        'grid_path_index':index,'label_bbox_points':list(word[:4]),
                        'label_to_grid_offset_points':center-position})
        require(len({o['grid_path_index'] for o in obs}) == len(obs),'Duplicate grid correspondence')
        all_obs.append(sorted(obs,key=lambda x:x['page_position_points']))
    require([len(x) for x in all_obs] == [14,7],'Expected 14 AP and seven depth grid labels')
    result = {'AP_Bregma_mm_from_x':fit(all_obs[0]),'depth_below_Bregma_mm_from_y':fit(all_obs[1]),
              'status':'published_grid_fit_unreviewed','source_method_pdf_page':10,
              'histology_pixel_calibration':None,
              'residual_scope':'Published grid only, not specimen registration or anatomical accuracy.'}
    require(result['AP_Bregma_mm_from_x']['max_absolute_grid_residual_um']<30,'Unexpected AP grid residual')
    require(result['depth_below_Bregma_mm_from_y']['max_absolute_grid_residual_um']<30,'Unexpected depth grid residual')
    return result


def coordinate(point, calibration):
    x,y = point
    ap = calibration['AP_Bregma_mm_from_x']; dv = calibration['depth_below_Bregma_mm_from_y']
    return [round(1000*(ap['slope_mm_per_pdf_point']*x+ap['intercept_mm']),6),
            round(-1000*(dv['slope_mm_per_pdf_point']*y+dv['intercept_mm']),6)]


def proper_crossings(points):
    """Flag proper crossings without editing the published even-odd path."""
    pts=points[:-1] if math.dist(points[0],points[-1])<0.002 else points
    def side(a,b,c):
        return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    result=[];n=len(pts)
    for i in range(n):
        a,b=pts[i],pts[(i+1)%n]
        for j in range(i+2,n):
            if i==0 and j==n-1:
                continue
            c,d=pts[j],pts[(j+1)%n]
            if max(a[0],b[0])<min(c[0],d[0]) or max(c[0],d[0])<min(a[0],b[0]) or max(a[1],b[1])<min(c[1],d[1]) or max(c[1],d[1])<min(a[1],b[1]):
                continue
            if side(a,b,c)*side(a,b,d)<0 and side(c,d,a)*side(c,d,b)<0:
                result.append([i,j])
    return result


def flatten_cubic(points, tolerance, depth=0):
    a,b,c,d = points
    # A Bezier is contained by its control hull. The hull-to-segment bound also
    # handles controls that overshoot an endpoint, unlike a line-distance test.
    def segment_distance(p):
        vx,vy=d[0]-a[0],d[1]-a[1];den=vx*vx+vy*vy
        t=max(0,min(1,((p[0]-a[0])*vx+(p[1]-a[1])*vy)/den)) if den else 0
        return math.dist(p,(a[0]+t*vx,a[1]+t*vy))
    if max(segment_distance(b),segment_distance(c)) <= tolerance:
        return [d]
    require(depth<20,'Cubic subdivision depth exceeded; no silent coarse fallback')
    mid=lambda p,q:((p[0]+q[0])/2,(p[1]+q[1])/2)
    ab,bc,cd=mid(a,b),mid(b,c),mid(c,d);abc,bcd=mid(ab,bc),mid(bc,cd);m=mid(abc,bcd)
    return flatten_cubic((a,ab,abc,m),tolerance,depth+1)+flatten_cubic((m,bcd,cd,d),tolerance,depth+1)


def split_paths(drawing, calibration, tolerance_um):
    paths=[];current=[]
    def finish():
        nonlocal current
        if current:
            paths.append(current);current=[]
    for item in drawing['items']:
        tag=item[0]
        require(tag in ('l','c'),'Selected source ink contains an unsupported primitive')
        points=[coordinate(tuple(p),calibration) for p in item[1:]]
        if current and math.dist(current[-1],points[0])>0.002:
            finish()
        if not current:
            current=[points[0]]
        current.extend([points[-1]] if tag=='l' else flatten_cubic(points,tolerance_um))
    finish()
    return paths


def choose_paths(drawings, page_number):
    selected=[]
    for index,d in enumerate(drawings):
        r=d['rect'];color=d['fill'];role=None
        # Source-specific posterior coordinate window, not a global color-to-tissue
        # mapping. The same blue exists in hippocampus outside this window.
        posterior = r.x0>680 and r.y0>110 and r.x1<945 and r.y1<450
        if posterior and near(color,BLUE):
            role='published_compartment'
        elif r.x0>630 and r.y0>110 and r.x1<945 and r.y1<450 and near(color,PALE) and r.x1>800:
            role='inner_paint'
        elif posterior and color and min(color)>0.94:
            # White/near-white overpaint stays separate: not an anatomical hole.
            role='source_overpaint'
        if role:
            selected.append((index,role,d))
        elif posterior and near(d['color'],CYAN) and (d['width'] or 0)>=0.7 and d['dashes']=='[] 0' and d['fill'] is None:
            if page_number==129 and index==206:
                continue # Reviewed brainstem outline, outside pilot cerebellar selection.
            selected.append((index,'boundary_ink',d))
    require(any(role=='published_compartment' for _,role,_ in selected),'No published cerebellar fill candidate found')
    return selected


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--tolerance-um',type=float,default=3.0)
    args=parser.parse_args();root=args.input_dir.expanduser().resolve();out=args.output.expanduser().resolve()
    require(not out.exists(),'Output already exists; no existing files are overwritten')
    require(fitz.VersionBind=='1.26.6','Use PyMuPDF 1.26.6 for reviewed path selection')
    require(0.1<=args.tolerance_um<=5,'Subdivision tolerance must be 0.1–5 µm')
    report=json.loads((root/'preparation-report.json').read_text())
    require(report['source']['sha256']==SOURCE_SHA,'Source atlas identity differs')
    manifest=json.loads((root/'pack-manifest.json').read_text())
    require(manifest['source']==report['source'],'Manifest source mismatch')
    entries={e['path']:e for e in manifest['files']}
    for number in range(128,160):
        name=f'pages/page-{number:06d}.pdf';record=entries[name]
        require((root/name).stat().st_size==record['bytes'] and sha(root/name)==record['sha256'],'Extracted page checksum mismatch')
    out.mkdir(parents=True)
    plates=[];native=[]
    for number in range(128,160):
        pdf=root/'pages'/f'page-{number:06d}.pdf'
        with fitz.open(pdf) as doc:
            page=doc[0];drawings=page.get_drawings();text=page.get_text()
            lateral=re.findall(r'\bLateral\s+(-?\d+\.\d+)\s+mm',text)
            require(len(lateral)==1,'Missing or ambiguous lateral coordinate')
            require(re.findall(r'\bFigure\s+(\d+)',text)==[str(number-27)],'Figure/page correspondence mismatch')
            calibration=grid_fit(page,drawings);selected=choose_paths(drawings,number)
            paths=[];native_paths=[]
            for index,role,drawing in selected:
                subpaths=split_paths(drawing,calibration,args.tolerance_um)
                group=f'page-{number}-path-{index}'
                native_paths.append({'source_path_index':index,'role':role,'ink':serial(drawing)})
                for sub_index,points in enumerate(subpaths):
                    filled=role!='boundary_ink'
                    explicit_closed=math.dist(points[0],points[-1])<0.002
                    closed=filled or explicit_closed or bool(drawing['closePath'])
                    crossings=proper_crossings(points) if filled else []
                    paths.append({'id':f'{group}-sub-{sub_index}','group_id':group,
                        'kind':'fill' if filled else 'stroke','role':role,'points':points,'closed':closed,
                        'closing_basis':'PDF fill implicitly closes subpaths' if filled else 'source endpoint/close flag' if closed else None,
                        'source_path_index':index,'source_subpath_index':sub_index,'source_subpath_count':len(subpaths),
                        'source_seqno':drawing['seqno'],'source_fill_rgb':serial(drawing['fill']),
                        'source_end_gap_um':math.dist(points[0],points[-1]),'source_close_path_flag':drawing['closePath'],
                        'source_stroke_rgb':serial(drawing['color']),'source_stroke_width_points':drawing['width'],
                        'source_dashes':drawing['dashes'],'fill_rule':'evenodd' if drawing['even_odd'] else 'nonzero',
                        'proper_edge_crossings':crossings,'fill_tessellation_safe':None if not filled else not crossings,
                        'fill_check_scope':'Proper edge crossings only; not a proof of anatomically valid topology. Use the original PDF fill rule, not a generic simple-polygon triangulator.',
                        'anatomical_label':None,'review_status':'unreviewed_published_ink'})
            labels=[]
            for word in page.get_text('words'):
                if word[4] in LABELS and word[0]>680 and 100<word[1]<450:
                    labels.append({'text':word[4],'position':coordinate(((word[0]+word[2])/2,(word[1]+word[3])/2),calibration),
                                   'source_bbox_points':list(word[:4]),'anatomical_assignment':None})
            note='Unreviewed published ink; source regions and annotations are not approved specimen tissue.'
            if number==159:
                note+=' Crus2 boundary remains present without blue fill; PFl blue fill remains. Missing fill is not absence of tissue or a zero-area endpoint.'
            plate={'id':f'atlas-figure-{number-27}','figure':number-27,'pdf_page':number,
                'lateral_um':float(lateral[0])*1000,'source_pdf_sha256':sha(pdf),'paths':paths,'labels':labels,
                'diagram_grid_fit':calibration,'complete_tissue_coverage':None,'approved_tissue_roi':False,'note':note}
            plates.append(plate);native.append({'pdf_page':number,'source_pdf_sha256':sha(pdf),'selected_paths':native_paths})
    require(all(a['lateral_um']<b['lateral_um'] for a,b in zip(plates,plates[1:])),'Non-monotone lateral coordinates')
    result={'schema':'cerebellum-atlas-drawing-series/1','unit':'um',
        'source':{**report['source'],'title':'The Mouse Brain in Stereotaxic Coordinates, 3rd edition (2007)',
                  'authors':'Franklin & Paxinos','license_note':'User-supplied reference for private research inspection; redistribution rights not established.'},
        'series':{'plane':'sagittal','axis':'ML','coordinate_frame':{'path_x':'Bregma AP, positive anterior','path_y':'Bregma DV, positive dorsal','plane_z':'printed Lateral from midline'},'bilateral_coverage':False},
        'status':'source-derived-unreviewed','plates':plates,
        'geometry':{'curve_flattening_max_deviation_um':args.tolerance_um,'method':'Adaptive cubic control-hull subdivision; native source curves retained in separate audit',
                    'rounding_decimals_um':6,'mirrored':False,'centroid_aligned':False,'endcaps_added':False},
        'limitations':['Published blue filled compartments are not whole cerebellum, GL, ML or WM segmentations.',
          'Pale and white paint are separate source operations, including underpaint and overpaint by source_seqno; they do not automatically denote holes or tissue classes.',
          'Some selected boundary ink may include adjoining reference context; no closed total-CB ROI is inferred.',
          'Source atlas is composite and includes repaired/mirrored drawings; this is not a measured individual brain.',
          'The series covers near midline to one lateral side only; final-plane tissue is present, no zero endpoint.',
          'Drawing-grid fit is not histology calibration, specimen registration or biological accuracy.',
          'Lobule labels and annotation strokes have zero anatomical volume.'],
        'whole_organ_volume':None,'histology_registration':None,'biological_validation':None}
    write_json(out/'sagittal-reference.json',result)
    write_json(out/'native-selected-paths.json',{'source_sha256':SOURCE_SHA,'pymupdf_version':fitz.VersionBind,'plates':native})
    audit={'source_sha256':SOURCE_SHA,'verified_planes':len(plates),'figure_range':[101,132],
        'lateral_range_um':[plates[0]['lateral_um'],plates[-1]['lateral_um']],
        'selected_source_path_groups':sum(len(p['selected_paths']) for p in native),
        'serialized_subpaths':sum(len(p['paths']) for p in plates),
        'serialized_points':sum(len(path['points']) for p in plates for path in p['paths']),
        'reference_sha256':sha(out/'sagittal-reference.json'),'source_geometry_sha256':sha(out/'native-selected-paths.json'),
        'published_fill_counts':[{ 'pdf_page':p['pdf_page'],'count':sum(q['role']=='published_compartment' for q in p['paths'])} for p in plates],
        'automatic_tissue_labels':False,'zero_endpoints_established':False,'complete_bilateral_atlas':False}
    write_json(out/'reference-audit.json',audit)
    print(json.dumps(audit,indent=2))


if __name__=='__main__':
    main()
