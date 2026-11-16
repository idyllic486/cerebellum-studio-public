/* Most similar atlas plane for one section, from its outlines alone. A port of scripts/atlas_match.py: the same
   sampling, the same search over mirror, scale and rotation, the same closest-point refinement and the same two-way
   truncated distance, so that both give the same answer for the same outlines.

   What a match is: the atlas plane a section's outline resembles most. It is not a measured position, the atlas is an
   average of other brains, and left and right are not told apart. Parameters are proposed values, not validated ones. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasMatchCore=api;})(typeof self!=='undefined'?self:this,function(){'use strict';
const SCHEMA='cerebellum-atlas-match/1';
const PARAMETERS=Object.freeze({status:'proposed',sample_step_um:60,truncate_um:400,name_margin:.15,rotation_step_deg:15,scale_range:[.75,1.3],scale_factors:[.88,.92,.96,1,1.04,1.08,1.12],refine_iterations:12,max_candidates:8});
const ALIASES={'4-5Cb':'4/5Cb',FI:'Fl',Fl:'Fl',PFI:'PFl',PFl:'PFl'},NOT_LOBULES=new Set(['Med','IntA','IntP','Lat','IntDL','IntPPC','MedDL','LatPC']),LOBULE_ROI=/^(?:ML|GL|PL)_(.+?)_part\d+$/;
const STATEMENT='Most similar atlas plane per section, from outlines. Not a measured position; the atlas is an average of other brains; left and right are not distinguished.';
const lobule=name=>ALIASES[name]||name;
function sectionLobules(rois){const out=new Set();for(const r of rois){const m=LOBULE_ROI.exec(r.name||'');if(m)out.add(lobule(m[1]));}return[...out].sort();}
function plateLobules(plate){const out=new Set();for(const l of plate.labels||[]){const t=String(l.text||''),c=t.charAt(0);if((c>='A'&&c<='Z')||(c>='0'&&c<='9')){const n=lobule(t);if(!NOT_LOBULES.has(n))out.add(n);}}return[...out].sort();}
function jaccard(a,b){const A=new Set(a),B=new Set(b);let both=0;for(const x of A)if(B.has(x))both++;const either=A.size+B.size-both;return either?both/either:0;}

/* Points every `step` along a polyline, as flat [x0,y0,x1,y1,...]. */
function resample(points,step,closed){const pts=points.map(p=>[+p[0],+p[1]]);if(closed)pts.push(pts[0].slice());const cum=[0];for(let i=1;i<pts.length;i++)cum.push(cum[i-1]+Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]));
 const total=cum[cum.length-1];if(!(total>0))return[pts[0][0],pts[0][1]];const out=[];let k=0;
 for(let j=0,at=0;at<total;at=++j*step){while(k<cum.length-2&&cum[k+1]<at)k++;const span=cum[k+1]-cum[k],f=span>0?(at-cum[k])/span:0;out.push(pts[k][0]+(pts[k+1][0]-pts[k][0])*f,pts[k][1]+(pts[k+1][1]-pts[k][1])*f);}
 return out;}

/* Outlines of one section in micrometres with y up, sampled evenly.
   `outlines` is a list of {name, closed, paths:[[[x,y],...],...]} in source pixels. Names follow the laboratory ROI files
   (Cb, GL+WM, GL_TOTAL, WM, ...) or the review labels (CB, GL, WM), which are read as Cb, GL_TOTAL and WM. */
const REVIEW_NAMES={CB:'Cb',GL:'GL_TOTAL',WM:'WM',ML:'ML_TOTAL',PL:'PL_TOTAL'};
function sectionPoints(outlines,umPerPixel,parameters){const step=parameters.sample_step_um,named=new Map();
 for(const o of outlines){const name=REVIEW_NAMES[o.name]||o.name;if(!named.has(name))named.set(name,[]);named.get(name).push(o);}
 if(!named.has('Cb'))throw Error('The section has no whole-cerebellum outline (Cb).');
 const out=[],kept={};
 for(const name of['Cb','GL+WM','GL_TOTAL','WM','ML_TOTAL','PL_TOTAL']){const group=named.get(name)||[],closed=group.length>0&&group[0].closed!==false,paths=[];
  for(const o of group)for(const p of o.paths)paths.push(p.map(q=>[q[0]*umPerPixel,-q[1]*umPerPixel]));
  if(paths.length)kept[name]={closed,paths};
  if(name==='Cb'||name==='GL+WM'||((name==='GL_TOTAL'||name==='WM')&&!named.has('GL+WM')))for(const p of paths){const s=resample(p,step,closed);for(let i=0;i<s.length;i++)out.push(s[i]);}}
 return{points:Float64Array.from(out),kept};}
function platePoints(plate,parameters){const out=[];for(const p of plate.paths)if(p.role==='boundary_ink'||p.role==='published_compartment'){const s=resample(p.points,parameters.sample_step_um,p.closed);for(let i=0;i<s.length;i++)out.push(s[i]);}return Float64Array.from(out);}

/* Nearest neighbour within a radius, on a uniform grid. Beyond the radius the distance is reported as the radius, which is
   all the truncated distance needs. */
function grid(points,radius){const n=points.length/2,cell=radius/4;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(let i=0;i<n;i++){const x=points[2*i],y=points[2*i+1];if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
 const cols=Math.max(1,Math.floor((maxX-minX)/cell)+1),rows=Math.max(1,Math.floor((maxY-minY)/cell)+1),count=new Int32Array(cols*rows+1);
 const cellOf=new Int32Array(n);for(let i=0;i<n;i++){const c=Math.floor((points[2*i]-minX)/cell)+cols*Math.floor((points[2*i+1]-minY)/cell);cellOf[i]=c;count[c+1]++;}
 for(let c=0;c<cols*rows;c++)count[c+1]+=count[c];const fill=count.slice(0,cols*rows),order=new Int32Array(n);for(let i=0;i<n;i++)order[fill[cellOf[i]]++]=i;
 return{points,radius,cell,minX,minY,cols,rows,start:count,order};}
/* Returns the distance (capped at the radius) and writes the index of the nearest point, or -1, to out[0]. */
function nearest(g,x,y,out){const{points,cell,cols,rows,start,order}=g,r2=g.radius*g.radius;let best=r2,index=-1;
 const cx=Math.floor((x-g.minX)/cell),cy=Math.floor((y-g.minY)/cell),reach=Math.ceil(g.radius/cell);
 for(let ring=0;ring<=reach;ring++){// stop once nothing in a farther ring can be closer
  if(index>=0&&(ring-1)*cell>Math.sqrt(best))break;
  const x0=cx-ring,x1=cx+ring,y0=cy-ring,y1=cy+ring;
  for(let gy=y0;gy<=y1;gy++){if(gy<0||gy>=rows)continue;const edge=gy===y0||gy===y1;
   for(let gx=x0;gx<=x1;gx+=edge?1:Math.max(1,x1-x0)){if(gx<0||gx>=cols)continue;const c=gx+cols*gy;
    for(let k=start[c];k<start[c+1];k++){const i=order[k],dx=points[2*i]-x,dy=points[2*i+1]-y,d=dx*dx+dy*dy;if(d<best){best=d;index=i;}}}}}
 if(out)out[0]=index;return Math.sqrt(best);}
function meanCapped(g,moved){const n=moved.length/2;let sum=0;for(let i=0;i<n;i++)sum+=nearest(g,moved[2*i],moved[2*i+1],null);return sum/n;}

/* Best similarity transform of the section points onto the plate points. Rotation and shift come from closest-point
   refinement at a fixed scale; the scale is chosen from a grid by the two-way distance, because letting closest points set
   the scale shrinks the section onto the plate. Points are row vectors: moved = (base · matrix) · scale + shift. */
function fit(points,fixed,parameters){const truncate=parameters.truncate_um,lo=parameters.scale_range[0],hi=parameters.scale_range[1],n=points.length/2,m=fixed.length/2,tree=grid(fixed,truncate);
 const centre=p=>{let x=0,y=0;const k=p.length/2;for(let i=0;i<k;i++){x+=p[2*i];y+=p[2*i+1];}return[x/k,y/k];};
 const spread=(p,c)=>{let s=0;const k=p.length/2;for(let i=0;i<k;i++){const dx=p[2*i]-c[0],dy=p[2*i+1]-c[1];s+=dx*dx+dy*dy;}return Math.sqrt(s/k);};
 const cf=centre(fixed),sf=spread(fixed,cf),base=new Float64Array(points.length),moved=new Float64Array(points.length),hit=[0];let best=null;
 for(const mirror of[false,true]){for(let i=0;i<n;i++){base[2*i]=mirror?-points[2*i]:points[2*i];base[2*i+1]=points[2*i+1];}
  const cb=centre(base),sb=spread(base,cb),scales=[...new Set(parameters.scale_factors.map(f=>Math.min(hi,Math.max(lo,sf/sb*f))))].sort((a,b)=>a-b);
  for(const scale of scales)for(let degrees=0;degrees<360;degrees+=parameters.rotation_step_deg){const rotation=degrees*Math.PI/180;
   // matrix = [[c,s],[-s,c]] for row vectors
   let c=Math.cos(rotation),s=Math.sin(rotation),tx=cf[0]-(cb[0]*c-cb[1]*s)*scale,ty=cf[1]-(cb[0]*s+cb[1]*c)*scale;
   const apply=()=>{for(let i=0;i<n;i++){const x=base[2*i],y=base[2*i+1];moved[2*i]=(x*c-y*s)*scale+tx;moved[2*i+1]=(x*s+y*c)*scale+ty;}};
   for(let iteration=0;iteration<parameters.refine_iterations;iteration++){apply();let kept=0,ax=0,ay=0,bx=0,by=0;const pairs=[];
    for(let i=0;i<n;i++){const gap=nearest(tree,moved[2*i],moved[2*i+1],hit);if(gap<truncate&&hit[0]>=0){kept++;const px=base[2*i]*scale,py=base[2*i+1]*scale,qx=fixed[2*hit[0]],qy=fixed[2*hit[0]+1];pairs.push(px,py,qx,qy);ax+=px;ay+=py;bx+=qx;by+=qy;}}
    if(kept<10)break;ax/=kept;ay/=kept;bx/=kept;by/=kept;let dot=0,cross=0;
    for(let k=0;k<pairs.length;k+=4){const px=pairs[k]-ax,py=pairs[k+1]-ay,qx=pairs[k+2]-bx,qy=pairs[k+3]-by;dot+=px*qx+py*qy;cross+=px*qy-py*qx;}
    // the proper rotation that best carries the kept points onto their neighbours (what the SVD with its sign fix returns)
    const angle=Math.atan2(cross,dot);c=Math.cos(angle);s=Math.sin(angle);tx=bx-(ax*c-ay*s);ty=by-(ax*s+ay*c);}
   apply();const forward=meanCapped(tree,moved);
   if(best&&forward>2*best.distance_um)continue; // the two-way distance cannot beat the best when one way alone is already twice as large
   const back=grid(moved.slice(),truncate);let sum=0;for(let j=0;j<m;j++)sum+=nearest(back,fixed[2*j],fixed[2*j+1],null);const backward=sum/m,both=(forward+backward)/2;
   if(!best||both<best.distance_um)best={distance_um:both,section_to_plate_um:forward,plate_to_section_um:backward,mirror,rotation:Math.atan2(s,c),scale,shift:[tx,ty]};}}
 return best;}

/* Mirror about the y axis, rotate, scale, then shift: the same order as the search. */
function transform(path,t){const c=Math.cos(t.rotation),s=Math.sin(t.rotation);return path.map(p=>{const x=t.mirror?-p[0]:p[0],y=p[1];return[(x*c-y*s)*t.scale+t.shift[0],(x*s+y*c)*t.scale+t.shift[1]];});}
function placed(kept,t){const out={};for(const[name,v]of Object.entries(kept))out[name]={closed:v.closed,paths:v.paths.map(p=>transform(p,t).map(q=>[Math.round(q[0]*10)/10,Math.round(q[1]*10)/10]))};return out;}

/* The match of one section: ranked candidates and the kept outlines. `outlines` as for sectionPoints. Without lobule names
   every plane is a candidate and only the shape decides. `onProgress(done,total)` is called after each plane. */
function match(outlines,umPerPixel,atlas,options={}){const parameters=Object.assign({},PARAMETERS,options.parameters||{});
 if(!(umPerPixel>0)||!Number.isFinite(umPerPixel))throw Error('The pixel size of the section is needed, in micrometres per pixel.');
 if(!atlas||!Array.isArray(atlas.plates)||atlas.unit!=='um')throw Error('Not a sagittal atlas series in micrometres.');
 const{points,kept}=sectionPoints(outlines,umPerPixel,parameters);if(points.length<20)throw Error('The outlines are too small to compare.');
 const names=options.useNames===false?[]:sectionLobules(outlines);
 const scored=atlas.plates.map((p,i)=>[jaccard(names,plateLobules(p)),i]).sort((a,b)=>b[0]-a[0]||a[1]-b[1]),top=scored[0][0];
 let candidates=names.length?scored.filter(t=>t[0]>=top-parameters.name_margin).map(t=>t[1]):atlas.plates.map((_,i)=>i);
 if(names.length&&parameters.max_candidates)candidates=candidates.slice(0,parameters.max_candidates);
 const rows=[];candidates.forEach((i,done)=>{const plate=atlas.plates[i],fixed=platePoints(plate,parameters);
  if(fixed.length>=20){const found=fit(points,fixed,parameters);if(found)rows.push(Object.assign(found,{figure:plate.figure,lateral_um:plate.lateral_um,plate_index:i,name_score:jaccard(names,plateLobules(plate)),plate_lobules:plateLobules(plate)}));}
  if(options.onProgress)options.onProgress(done+1,candidates.length);});
 if(!rows.length)throw Error('No atlas plane could be compared with this section.');
 rows.sort((a,b)=>a.distance_um-b.distance_um||a.figure-b.figure);
 return{schema:SCHEMA,statement:STATEMENT,parameters,section_lobules:names,names_used:names.length>0,candidates_tried:rows.length,best:rows[0],runner_up:rows[1]||null,
  margin_um:rows.length>1?rows[1].distance_um-rows[0].distance_um:null,all:rows.map(r=>({figure:r.figure,lateral_um:r.lateral_um,name_score:r.name_score,distance_um:r.distance_um})),placed:placed(kept,rows[0])};}

return Object.freeze({SCHEMA,PARAMETERS,STATEMENT,sectionLobules,plateLobules,jaccard,resample,sectionPoints,platePoints,fit,transform,placed,match});
});
