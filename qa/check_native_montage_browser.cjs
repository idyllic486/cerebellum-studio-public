/* Bounded native TIFF windows and real worker inference; synthetic pixels only. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawnSync}=require('node:child_process'),{createHash}=require('node:crypto'),{chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'cerebellum-native-browser-'));
const Core=require('../src/browser_model_core.js'),Images=require('../src/research_image.js');
const report={pass:false,synthetic_data:true,native_mac_verified:false,real_tissue_accuracy_tested:false,checks:[],page_errors:[],external_requests:[]};
const hash=x=>createHash('sha256').update(x).digest('hex'),record=(name,data={})=>{report.checks.push({name,...data});console.log(name);};
const python=process.env.NISSL_LAB_PYTHON||(fs.existsSync('/tmp/cerebellum-locked-env/bin/python')?'/tmp/cerebellum-locked-env/bin/python':'python3');
const PY=String.raw`
import sys,json,hashlib
from pathlib import Path
import numpy as np,tifffile
from sklearn.ensemble import RandomForestClassifier
sys.path.insert(0,sys.argv[2]+'/scripts')
import nissl_lab as lab
out=Path(sys.argv[1]); w=h=7000
p=tifffile.memmap(out/'large.tif',shape=(h,w,3),dtype='uint8',photometric='rgb',metadata=None,rowsperstrip=31)
x=np.arange(w);p[:,:,0]=np.where(x<3500,20,220)[None,:];p[:,:,1]=np.arange(h)[:,None]%256
for y in range(h):p[y,:,2]=(x+y)%256
p.flush();del p
x=np.zeros((4,15),dtype=np.float32);x[:,0]=np.array([20,40,200,220])/255
y=np.array([0,0,1,1]);forest=RandomForestClassifier(n_estimators=1,max_depth=1,max_features=None,bootstrap=False,random_state=17,n_jobs=1).fit(x,y)
t=forest.estimators_[0].tree_;prob=t.value[:,0,:];prob=prob/prob.sum(axis=1,keepdims=True)
model={'schema':'cerebellum-pixel-forest/1','id':'synthetic-native-fitted','version':'1','input':{'channels':'RGB','dtype':'uint8','scale':[255,255,255]},'classes':['background','CB'],'features':'raw+gaussian_mean_std_sigma1_sigma3_reflect_truncate4/1','trees':[{'left':t.children_left.tolist(),'right':t.children_right.tolist(),'feature':t.feature.tolist(),'threshold':t.threshold.tolist(),'probabilities':prob.tolist()}],'training_animals':['synthetic-train'],'training_sources':[{'animal_id':'synthetic-train','section_id':'source-1','source_sha256':'1'*64,'label_sha256':'2'*64}]}
assert set(t.feature.tolist())<=set([-2,0])
(out/'model.json').write_text(json.dumps(model))
layer=json.loads(json.dumps(model));layer['id']='synthetic-layers';layer['classes']=['background','ML','GL','WM'];layer['trees'][0]['probabilities']=[[0,p[0],0,p[1]] for p in prob]
(out/'bundle.json').write_text(json.dumps({'schema':'cerebellum-auto-roi-models/1','primary':'layers','models':{'cb':model,'layers':layer}}))
noise=np.zeros((40,40,3),dtype=np.uint8);noise[::2,::2,0]=220
tifffile.imwrite(out/'noise.tif',noise,photometric='rgb',metadata=None,rowsperstrip=7)
small=np.zeros((35,49,3),dtype=np.uint8);small[:,:,0]=np.where(np.arange(49)<22,20,220);small[:,:,1]=np.arange(35)[:,None];small[:,:,2]=83
tifffile.imwrite(out/'small.tif',small,photometric='rgb',metadata=None,rowsperstrip=7)
# Independent Python reference includes true texture feature thresholds.
texture=json.loads(json.dumps(model));texture['trees'][0]['feature'][0]=3
(out/'texture-model.json').write_text(json.dumps(texture))
lab.forest_predict(texture,small,tile_size=8).tofile(out/'texture-labels.bin')
print((out/'large.tif').stat().st_size)
`;
async function main(){
 const made=spawnSync(python,['-c',PY,temp,ROOT],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
 const bytes=fs.readFileSync(path.join(temp,'large.tif')),originalHash=hash(bytes),reader=Images.openNativeTIFF(bytes);assert.ok(reader);assert.equal(reader.width*reader.height,49000000);assert.ok(bytes.length>128*1024*1024);
 for(const [x,y,w,h]of [[3494,29,23,37],[6990,6990,10,10],[0,0,1,1]]){const patch=reader.readWindow(x,y,w,h);for(let j=0;j<h;j++)for(let i=0;i<w;i++){const at=(j*w+i)*3;assert.equal(patch[at],x+i<3500?20:220);assert.equal(patch[at+1],(y+j)%256);assert.equal(patch[at+2],(x+i+y+j)%256);}}
 assert.throws(()=>reader.readWindow(-1,0,1,1),/window/);assert.throws(()=>reader.readWindow(0,0,7000,7000),/window/);
 const preview=reader.preview(127);assert.equal(preview.width,7000);assert.equal(preview.previewWidth,127);for(let y=0;y<127;y++)for(let x=0;x<127;x++){const sx=Math.floor((x+.5)*7000/127),sy=Math.floor((y+.5)*7000/127),at=(y*127+x)*4;assert.deepEqual(Array.from(preview.rgba.subarray(at,at+4)),[sx<3500?20:220,sy%256,(sx+sy)%256,255]);}assert.equal(hash(bytes),originalHash);
 record('49-million-pixel / >128 MiB RGB TIFF reads exact strip-crossing windows and a coordinate-preserving sparse preview',{pixels:49000000,source_bytes:bytes.length,window_limit:reader.windowBytesLimit});
 const small=Images.openNativeTIFF(fs.readFileSync(path.join(temp,'small.tif'))),model=JSON.parse(fs.readFileSync(path.join(temp,'texture-model.json'))),expected=Uint8Array.from(fs.readFileSync(path.join(temp,'texture-labels.bin')));let largest=0;
 for(const tileSize of [8,17,128]){const wrapped={...small,readWindow(...args){const result=small.readWindow(...args);largest=Math.max(largest,result.byteLength);return result;}};assert.deepEqual(Core.inferNative(model,wrapped,{tileSize}).labels,expected);}
 record('Native window inference including Gaussian texture features agrees with independent Python predictions across tile boundaries',{largest_requested_window_bytes:largest});
 const corrupt=Buffer.from(bytes.subarray(0,1024));assert.throws(()=>Images.openNativeTIFF(corrupt),/range|truncated|metadata/);
 const oversize={width:10001,height:8000,channels:3,dtype:'uint8',readWindow(){throw Error('must not allocate/read');}};assert.throws(()=>Core.inferNative(model,oversize),/grid/);
 record('Truncated source, oversized grid and invalid windows fail before native pixel processing');
 const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname;if(name==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><title>Native montage QA</title>');}const base=name.startsWith('/assets/')?path.join(ROOT,'src'):name.startsWith('/vendor/')?path.join(ROOT,'dist/vendor'):name.startsWith('/fixture/')?temp:null;if(!base)return res.writeHead(404).end();const file=path.resolve(base,name.replace(/^\/(assets|vendor|fixture)\//,''));if(!file.startsWith(base+path.sep)||!fs.existsSync(file))return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'application/octet-stream');fs.createReadStream(file).pipe(res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});const page=await browser.newPage();page.on('pageerror',e=>report.page_errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(origin))report.external_requests.push(r.url());});await page.goto(origin);
 const load=await page.evaluate(async()=>{const buffer=await(await fetch('/fixture/large.tif')).arrayBuffer();return new Promise((resolve,reject)=>{const worker=new Worker('/assets/image_loader_worker.js');worker.onerror=e=>reject(Error(e.message));worker.onmessage=({data})=>{if(data.progress)return;worker.terminate();if(data.error)return reject(Error(data.error));resolve({sha256:data.result.sha256,width:data.result.width,height:data.result.height,previewWidth:data.result.previewWidth,bytes:data.result.bytes});};worker.postMessage({buffer,maxPreview:256,returnBytes:false},[buffer]);});});assert.equal(load.sha256,originalHash);assert.equal(load.width,7000);assert.equal(load.previewWidth,256);assert.equal(load.bytes,null);record('Actual TIFF worker previews a >40-million-pixel source with unchanged source SHA and no full decoded RGB buffer');
 async function predict(image,bundle=false){return page.evaluate(async({image,bundle})=>{const buffer=await(await fetch('/fixture/'+image)).arrayBuffer(),modelBuffer=await(await fetch('/fixture/'+(bundle?'bundle.json':'model.json'))).arrayBuffer();return new Promise((resolve,reject)=>{const worker=new Worker('/assets/browser_model_worker.js');let ticks=0;const timer=setInterval(()=>ticks++,10),timeout=setTimeout(()=>{worker.terminate();clearInterval(timer);reject(Error('Native worker timeout'));},120000);worker.onerror=e=>{clearTimeout(timeout);clearInterval(timer);worker.terminate();reject(Error(e.message));};worker.onmessage=({data})=>{if(data.progress)return;clearTimeout(timeout);clearInterval(timer);worker.terminate();if(data.rasters)data.rasters=data.rasters.map(r=>({metadata:r.metadata,length:r.labels.length,values:Array.from(new Set(r.labels))}));if(data.raster)data.raster={metadata:data.raster.metadata,length:data.raster.labels.length};resolve({...data,ticks});};worker.postMessage({buffer,modelBuffer,sourceName:image},[buffer,modelBuffer]);});},{image,bundle});}
 const predicted=await predict('large.tif');assert.ok(predicted.result,predicted.error);assert.equal(predicted.result.source.sha256,originalHash);assert.equal(predicted.result.processing.pixel_counts.CB,24500000);assert.equal(predicted.result.rois.length,1);assert.deepEqual(predicted.result.rois[0].paths[0].map(p=>p.join(',')).sort(),['3500,0','3500,7000','7000,0','7000,7000'].sort());assert.ok(predicted.ticks>2);record('Actual fitted-model Worker predicts all 49 million native pixels and exact half-image ROI without a preview/resampling shortcut',{predicted_CB_pixels:24500000,ui_ticks:predicted.ticks});
 const both=await predict('small.tif',true);assert.ok(both.result,both.error);assert.ok(both.result.rois.some(r=>r.label==='CB'));assert.ok(both.result.rois.some(r=>r.label==='ML'));assert.ok(both.result.rois.some(r=>r.label==='WM'));assert.equal(both.result.processing.heads.length,2);record('CB and layers run as independent model heads against the same original grid');
 const noise=await predict('noise.tif',true);assert.ok(noise.raster,noise.error);assert.equal(noise.rasters.length,2);assert.deepEqual(noise.rasters.map(r=>r.metadata.head),['cb','layers']);assert.ok(noise.rasters.every(r=>r.length===1600&&r.metadata.failure));record('Contour failure retains BOTH native model maps and explicit failure provenance without dropping islands');
 assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.external_requests,[]);report.pass=true;
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(error=>{report.error=error.stack;console.error(error);process.exitCode=1;}).finally(()=>{fs.rmSync(temp,{recursive:true,force:true});fs.writeFileSync(path.join(__dirname,'native-montage-browser.json'),JSON.stringify(report,null,2)+'\n');});
