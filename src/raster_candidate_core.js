/* Explicit approximate ROI candidates from unchanged native label-map evidence.
 * This is a review aid, not a second inference model or an exact contour export.
 */
(function(root){
'use strict';
const VERSION='1.1.0',LIMITS=Object.freeze({pixels:80000000,dimension:32767,cells:2000000});
const SMALL_PIECE_FRACTION=.01,SMOOTH_SHIFT=.45,SMOOTHING='neighbour-mean/3, max shift 0.45 block, collinear vertices dropped';
const fail=message=>{throw Error(message);};
// Block-majority contours are staircases of whole blocks. Each vertex moves toward the mean of
// its ring neighbours, never more than 0.45 block from where it started. Distinct boundary
// portions are at least one block apart after diagonal bridging, so smoothed contours cannot
// cross or touch, and the vertex count never grows (the 5000/30000 contract still holds).
function smoothRing(ring){
 if(ring.length<8)return ring.map(p=>[p[0],p[1]]);
 const n=ring.length;let pts=ring.map(p=>[p[0],p[1]]);
 for(let pass=0;pass<3;pass++){
  const mean=pts.map((p,i)=>{const a=pts[(i+n-1)%n],b=pts[(i+1)%n];return[(a[0]+2*p[0]+b[0])/4,(a[1]+2*p[1]+b[1])/4];});
  pts=mean.map((p,i)=>{const o=ring[i],dx=p[0]-o[0],dy=p[1]-o[1],d=Math.hypot(dx,dy);return d>SMOOTH_SHIFT?[o[0]+dx*SMOOTH_SHIFT/d,o[1]+dy*SMOOTH_SHIFT/d]:p;});
 }
 const kept=[];
 for(let i=0;i<n;i++){
  const a=kept.length?kept[kept.length-1]:pts[(i+n-1)%n],p=pts[i],b=pts[(i+1)%n],ex=b[0]-a[0],ey=b[1]-a[1],len=Math.hypot(ex,ey)||1;
  if(Math.abs(ex*(p[1]-a[1])-ey*(p[0]-a[0]))/len>.08)kept.push(p);
 }
 return kept.length>=4?kept:pts;
}
function modelCore(){return root.BrowserModelCore||(typeof require==='function'?require('./browser_model_core.js'):null);}
// Small regions join the neighbouring class they touch most, and diagonal contacts are bridged,
// so a smooth map can become editable contours. Every changed pixel is counted by the caller.
function neighbours(at,cols,rows){const x=at%cols,y=(at-x)/cols;return[x?at-1:-1,x+1<cols?at+1:-1,y?at-cols:-1,y+1<rows?at+cols:-1];}
function absorbSmallRegions(grid,cols,rows,classCount,minimumCells){
 const owner=new Int32Array(grid.length).fill(-1),regions=[];
 for(let start=0;start<grid.length;start++){
  if(owner[start]>=0)continue;
  const id=regions.length,cells=[],stack=[start];owner[start]=id;
  while(stack.length){const at=stack.pop();cells.push(at);for(const next of neighbours(at,cols,rows))if(next>=0&&owner[next]<0&&grid[next]===grid[start]){owner[next]=id;stack.push(next);}}
  regions.push({label:grid[start],cells});
 }
 const order=regions.map((_,i)=>i).filter(i=>regions[i].cells.length<minimumCells).sort((a,b)=>regions[a].cells.length-regions[b].cells.length||a-b);let absorbed=0;
 for(const id of order){
  const region=regions[id],votes=new Uint32Array(classCount);
  for(const at of region.cells)for(const next of neighbours(at,cols,rows))if(next>=0&&owner[next]!==id)votes[grid[next]]++;
  let winner=-1;for(let c=0;c<classCount;c++)if(c!==region.label&&votes[c]&&(winner<0||votes[c]>votes[winner]))winner=c;
  if(winner<0)continue;
  for(const at of region.cells){grid[at]=winner;owner[at]=-2;}absorbed++;
 }
 return absorbed;
}
function bridgeDiagonals(grid,cols,rows){
 let bridged=0;
 for(let pass=0;pass<64;pass++){
  let changed=false;
  for(let y=0;y+1<rows;y++)for(let x=0;x+1<cols;x++){
   const a=y*cols+x,b=a+1,c=a+cols,d=c+1;
   if(grid[a]===grid[d]&&grid[b]!==grid[a]&&grid[c]!==grid[a]){grid[b]=grid[a];bridged++;changed=true;}
   else if(grid[b]===grid[c]&&grid[a]!==grid[b]&&grid[d]!==grid[b]){grid[a]=grid[b];bridged++;changed=true;}
  }
  if(!changed)return bridged;
 }
 fail('Diagonal contacts could not be resolved; the native label maps are retained.');
}
function create(labels,width,height,classes,{blockSize=8,minComponentPixels=0,minimumRegionPixels=0,sharedGrid=null,includePL=false,onProgress=()=>{}}={}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>LIMITS.dimension||height>LIMITS.dimension||width*height>LIMITS.pixels||!(labels instanceof Uint8Array)||labels.length!==width*height)fail('Invalid native label grid for candidate conversion.');
 if(![8,16,32].includes(blockSize)||!Number.isSafeInteger(minComponentPixels)||minComponentPixels<0||minComponentPixels>width*height)fail('Choose an 8, 16 or 32 pixel candidate block and a valid minimum component area.');
 if(!Array.isArray(classes)||classes.length<2||classes.length>64||classes[0]!=='background'||classes.some(c=>typeof c!=='string'||!c||c.length>200)||new Set(classes).size!==classes.length)fail('Invalid candidate class mapping.');
 if(typeof includePL!=='boolean'||includePL&&JSON.stringify(classes)!==JSON.stringify(['background','ML','GL','WM']))fail('PL interface candidates require background/ML/GL/WM classes.');
 const cols=Math.ceil(width/blockSize),rows=Math.ceil(height/blockSize),size=cols*rows;
 if(size>LIMITS.cells)fail('Candidate grid is too large. Choose a larger block size.');
 const grid=new Uint8Array(size),sourceCounts=new Array(classes.length).fill(0),candidateCounts=new Array(classes.length).fill(0),votes=new Uint32Array(classes.length);
 const cellPixels=index=>Math.min(blockSize,width-index%cols*blockSize)*Math.min(blockSize,height-Math.floor(index/cols)*blockSize);
 // Ties go to the lowest class index: background first, then declared order.
 // Edge blocks count only real native pixels, never padding outside the image.
 for(let cy=0;cy<rows;cy++){
  const sy=cy*blockSize,ey=Math.min(height,sy+blockSize);
  for(let cx=0;cx<cols;cx++){
   votes.fill(0);const sx=cx*blockSize,ex=Math.min(width,sx+blockSize);
   for(let y=sy;y<ey;y++)for(let x=sx;x<ex;x++){const value=labels[y*width+x];if(value>=classes.length)fail('Unknown native class index. No class is ignored.');votes[value]++;sourceCounts[value]++;}
   let winner=0;for(let c=1;c<classes.length;c++)if(votes[c]>votes[winner])winner=c;
   grid[cy*cols+cx]=winner;
  }
  onProgress({stage:'candidate',message:'Creating approximate block-majority candidates…',completed:cy+1,total:rows});
 }
 if(!Number.isSafeInteger(minimumRegionPixels)||minimumRegionPixels<0||minimumRegionPixels>width*height)fail('Choose a valid minimum region area.');
 if(sharedGrid!==null&&(!(sharedGrid instanceof Uint8Array)||sharedGrid.length!==size||sharedGrid.some(value=>value>=classes.length)))fail('Invalid shared candidate grid.');
 if(sharedGrid)grid.set(sharedGrid);
 let absorbedRegions=0,bridgedCells=0;
 if(minimumRegionPixels>0&&!sharedGrid){
  absorbedRegions=absorbSmallRegions(grid,cols,rows,classes.length,Math.ceil(minimumRegionPixels/(blockSize*blockSize)));
  bridgedCells=bridgeDiagonals(grid,cols,rows);
 }
 // Separate pieces smaller than 1% of the largest piece of the same class are left out of
 // the draft: on the held-out sections the researcher judged them to be non-CB tissue or
 // artefacts (2026-11-07). Their count and pixels are reported; the native maps keep them.
 let removedComponents=0,removedPixels=0,smallComponents=0,smallPixels=0;
 {
  const visited=new Uint8Array(size),queue=new Int32Array(size),found=[],largest=new Array(classes.length).fill(0);
  for(let index=0;index<size;index++){
   const label=grid[index];if(!label||visited[index])continue;
   let read=0,write=1,pixels=0;queue[0]=index;visited[index]=1;
   while(read<write){
    const at=queue[read++],x=at%cols,y=Math.floor(at/cols);pixels+=cellPixels(at);
    for(const next of [x?at-1:-1,x+1<cols?at+1:-1,y?at-cols:-1,y+1<rows?at+cols:-1])if(next>=0&&!visited[next]&&grid[next]===label){visited[next]=1;queue[write++]=next;}
   }
   found.push({label,pixels,cells:Array.from(queue.subarray(0,write))});largest[label]=Math.max(largest[label],pixels);
  }
  for(const component of found){
   const tiny=minComponentPixels>0&&component.pixels<minComponentPixels,relative=component.pixels<largest[component.label]*SMALL_PIECE_FRACTION;
   if(!tiny&&!relative)continue;
   for(const at of component.cells)grid[at]=0;
   if(tiny){removedComponents++;removedPixels+=component.pixels;}else{smallComponents++;smallPixels+=component.pixels;}
  }
 }
 const transitions=classes.map(()=>new Array(classes.length).fill(0));let changedPixels=0;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const original=labels[y*width+x],candidate=grid[Math.floor(y/blockSize)*cols+Math.floor(x/blockSize)];
  transitions[original][candidate]++;candidateCounts[candidate]++;if(candidate!==original)changedPixels++;
 }
 // Geometry limits and topology rules are unchanged. A failure publishes no
 // partial candidate; original native labels remain available to the caller.
 const geometry=modelCore().vectorize(grid,cols,rows,classes,onProgress);
 const scaleROI=(roi,smooth=false)=>({...roi,paths:roi.paths.map(path=>(smooth?smoothRing(path):path).map(([x,y])=>[Math.min(width,x*blockSize),Math.min(height,y*blockSize)])),metadata:{...(roi.metadata||{}),candidate_method:'block-majority/1',candidate_block_size_px:blockSize,candidate_minimum_component_pixels:minComponentPixels,...(smooth?{candidate_contour:SMOOTHING}:{})}});
 const rois=geometry.rois.map(roi=>scaleROI(roi,true));let plCandidate=null;
 if(includePL){
  const nativeInterface=modelCore().plInterface(grid,cols,rows),lines=nativeInterface.rois.map(scaleROI);
  // Clipped edge cells are shorter than a full block: do not multiply a coarse
  // edge count by blockSize and call that a native-coordinate line length.
  const length=lines.reduce((sum,roi)=>sum+roi.paths.reduce((subtotal,path)=>subtotal+path.reduce((n,p,i)=>n+(i?Math.hypot(p[0]-path[i-1][0],p[1]-path[i-1][1]):0),0),0),0);
  plCandidate={...nativeInterface,rois:lines,total_length_px:length,edge_count_unit:'coarse-grid shared pixel edges',block_size_px:blockSize,status:lines.length?'unreviewed candidate':'no ML–GL interface in the candidate map'};
 }
 const named=counts=>Object.fromEntries(classes.map((c,i)=>[c,counts[i]]));
 return {rois,grid,grid_width:cols,grid_height:rows,pl_candidate:plCandidate,counts:Object.fromEntries(classes.slice(1).map((c,i)=>[c,candidateCounts[i+1]])),processing:{
  schema:'cerebellum-roi-candidate-processing/1',version:VERSION,method:sharedGrid?'shared-candidate-grid/1':minimumRegionPixels?'block-majority-then-region-cleanup/1':'block-majority-then-small-component-removal/1',status:'unreviewed',
  block_size_px:blockSize,minimum_component_pixels:minComponentPixels,pl_interface_requested:includePL,grid_width:cols,grid_height:rows,
  tie_break:'Lowest declared class index; background first.',source_pixel_counts:named(sourceCounts),candidate_pixel_counts:named(candidateCounts),
  classes:[...classes],transition_pixel_counts:transitions,changed_pixels:changedPixels,total_pixels:width*height,
  removed_component_count:removedComponents,removed_component_pixels:removedPixels,
  small_piece_fraction:SMALL_PIECE_FRACTION,small_piece_rule:'Separate pieces under 1% of the largest same-class piece are left out of the draft; native maps are unchanged.',small_piece_count:smallComponents,small_piece_pixels:smallPixels,contour_smoothing:SMOOTHING,
  minimum_region_pixels:minimumRegionPixels,absorbed_region_count:absorbedRegions,bridged_diagonal_cells:bridgedCells,shared_grid:!!sharedGrid,
  resolution:'Approximate block-majority candidates in native image coordinates. Original native label maps are unchanged.',
  measurement:'Candidate areas differ from native model pixels; inspect, correct and approve before analysis. No anatomical accuracy or automatic approval claim.'
 }};
}
const api=Object.freeze({VERSION,LIMITS,create});root.RasterCandidateCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
