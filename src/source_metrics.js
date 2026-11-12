/* CPU and GPU audits of original ROI geometry. No anatomical inference. */
((scope)=>{'use strict';
 function pathMeasure(path,kind){let value=0;const c=path[0];if(kind==='polyline'){for(let i=1;i<path.length;i++)value+=Math.hypot(path[i][0]-path[i-1][0],path[i][1]-path[i-1][1]);}else{for(let i=0;i<path.length;i++){const p=path[i],q=path[(i+1)%path.length];value+=(p[0]-c[0])*(q[1]-c[1])-(q[0]-c[0])*(p[1]-c[1]);}value/=2;}return value;}
 function cpu(features){return features.map(f=>{const sum=f.paths_px.reduce((n,p)=>n+pathMeasure(p,f.kind),0);return f.kind==='polyline'?sum:Math.abs(sum);});}
 function compare(features,values){let max=0,failed=0;for(let i=0;i<features.length;i++){const f=features[i],expected=f.kind==='polyline'?f.path_length_um*f.pixels_per_um:f.area_um2*f.pixels_per_um*f.pixels_per_um;const diff=Math.abs(values[i]-expected);const relative=diff/Math.max(1,Math.abs(expected))*100;max=Math.max(max,relative);if(!Number.isFinite(values[i])||relative>.05)failed++;}return {passed:failed===0,failed,max_relative_error_pct:max,features:features.length};}
 async function worker(features){const started=performance.now();const code=`const pathMeasure=${pathMeasure.toString()};const cpu=${cpu.toString()};onmessage=e=>{const values=cpu(e.data);postMessage(values);};`;const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));let w;try{w=new Worker(url);const values=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker verification timed out')),15000);w.onmessage=e=>{clearTimeout(timer);resolve(e.data);};w.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'Worker error'));};w.postMessage(features);});return {...compare(features,values),engine:'Web Worker / Float64',elapsed_ms:performance.now()-started};}finally{w?.terminate();URL.revokeObjectURL(url);}}
 const shader=`
struct Job {start:u32, count:u32, line:u32, pad:u32};
@group(0) @binding(0) var<storage,read> points:array<vec2f>;
@group(0) @binding(1) var<storage,read> jobs:array<Job>;
@group(0) @binding(2) var<storage,read_write> output:array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){
 let k=gid.x;if(k>=arrayLength(&jobs)){return;}let job=jobs[k];var result=0.0;
 if(job.line==1u){for(var i=1u;i<job.count;i++){result+=distance(points[job.start+i],points[job.start+i-1u]);}}
 else{for(var i=0u;i<job.count;i++){let p=points[job.start+i];let q=points[job.start+(i+1u)%job.count];result+=p.x*q.y-q.x*p.y;}result*=0.5;}
 output[k]=result;
}`;
 async function gpu(features){if(!navigator.gpu)throw Error('WebGPU is not available in this browser. Use Worker verification.');const start=performance.now(),adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU device is available.');const device=await adapter.requestDevice();let buffers=[];try{const pts=[],jobs=[],owners=[];for(let fi=0;fi<features.length;fi++)for(const path of features[fi].paths_px){const offset=pts.length/2,c=path[0];for(const p of path)pts.push(p[0]-c[0],p[1]-c[1]);jobs.push(offset,path.length,features[fi].kind==='polyline'?1:0,0);owners.push(fi);}
 const input=new Float32Array(pts),meta=new Uint32Array(jobs),bytes=owners.length*4;
 function buffer(data,usage){const b=device.createBuffer({size:Math.max(4,data.byteLength),usage,mappedAtCreation:true});new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));b.unmap();buffers.push(b);return b;}
 device.pushErrorScope('validation');const pbuf=buffer(input,GPUBufferUsage.STORAGE),jbuf=buffer(meta,GPUBufferUsage.STORAGE),out=device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(out,read);
 const module=device.createShaderModule({code:shader}),compilation=await module.getCompilationInfo();const errors=compilation.messages.filter(m=>m.type==='error');if(errors.length)throw Error(errors.map(e=>e.message).join('; '));
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}}),group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:pbuf}},{binding:1,resource:{buffer:jbuf}},{binding:2,resource:{buffer:out}}]});
 const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(owners.length/64));pass.end();encoder.copyBufferToBuffer(out,0,read,0,bytes);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const result=new Float32Array(read.getMappedRange().slice(0));read.unmap();const validation=await device.popErrorScope();if(validation)throw Error(validation.message);const values=new Array(features.length).fill(0);for(let i=0;i<owners.length;i++)values[owners[i]]+=result[i];for(let i=0;i<features.length;i++)if(features[i].kind!=='polyline')values[i]=Math.abs(values[i]);return {...compare(features,values),engine:'WebGPU / WGSL Float32',elapsed_ms:performance.now()-start};
 }finally{for(const b of buffers)b.destroy();device.destroy();}}
 scope.SourceMetrics={cpu,compare,worker,gpu};
})(typeof module==='object'?module.exports:window);
