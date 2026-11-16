/* A made-up study for the atlas-stack checks: one animal whose sections are atlas planes moved, turned and written in pixels. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
module.exports=function fixture(root,indexes){const atlas=JSON.parse(fs.readFileSync(path.join(root,'assets/atlas-open/ccfv3-bbp-25/sagittal-planes.json'),'utf8')),um=5;
 const sections=indexes.map((index,n)=>{const src=atlas.plates[index],angle=(20+25*n)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),comps=src.paths.filter(p=>p.role==='published_compartment'),big=comps.reduce((a,b)=>b.points.length>a.points.length?b:a);
  const moved=points=>points.map(p=>[(p[0]*c-p[1]*s)*.95,(p[0]*s+p[1]*c)*.95]),all=comps.flatMap(p=>moved(p.points)),minX=Math.min(...all.map(p=>p[0])),maxY=Math.max(...all.map(p=>p[1]));
  const px=points=>moved(points).map(p=>[Math.round((p[0]-minX)/um*100)/100+20,Math.round((maxY-p[1])/um*100)/100+20]),width=Math.ceil(Math.max(...all.map(p=>p[0]-minX))/um)+40,height=Math.ceil(Math.max(...all.map(p=>maxY-p[1]))/um)+40;
  return{id:'section-'+(n+1),order:n+1,z_um:null,thickness_um:null,source:{name:'MADE-UP-'+(n+1)+'.tif',sha256:require('node:crypto').createHash('sha256').update('made-up section '+n).digest('hex'),width,height},calibration:{um_per_pixel_x:um,um_per_pixel_y:um},
   rois:[{name:'CB_TOTAL',kind:'area',closed:true,paths:[px(big.points)]},...comps.filter(p=>p!==big).map((p,i)=>({name:'GL_part'+(i+1),kind:'area',closed:true,paths:[px(p.points)]}))],included:true,exclusion_reason:'',model:null,origin:'manual',review:null,layer_selection:{}};});
 return{atlas,figures:indexes.map(i=>atlas.plates[i].figure),study:{schema:'cerebellum-study/1',id:'made-up-atlas-stack',title:'MADE-UP atlas stack',synthetic:true,protocol:{id:'made-up',version:'1',measurement_profile:'pixel-mask/1',boundary_definition:'',maximum_gap_um:null},
  animals:[{id:'MADE-UP-1',group:'WT',split:'test',sections,sex:null,age_days:null,batch:null,coverage:{kind:'observed_span',start_um:null,end_um:null,confirmed:false}}],created_at:'2026-01-01T00:00:00.000Z',history:[]}};};
