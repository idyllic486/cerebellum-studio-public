/* The built-in model loads through the ordinary model path; work screens show counts, the details window shows names. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createHash}=require('node:crypto'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist');
const report={pass:false,checks:[],page_errors:[],external_requests:[]},record=(name,details={})=>{report.checks.push({name,pass:true,...details});console.log(name);};
(async()=>{
 record('The served build is in step with the sources',require('./dist_fresh.cjs')(root));
 const profile=JSON.parse(fs.readFileSync(path.join(dist,'index.html'),'utf8').match(/<script id="deployment-profile" type="application\/json">(.*?)<\/script>/)[1]);
 assert.ok(profile.built_in_model,'The build publishes a built-in model');
 const file=path.join(dist,profile.built_in_model.url),bytes=fs.readFileSync(file),model=JSON.parse(bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),profile.built_in_model.sha256);assert.equal(bytes.length,profile.built_in_model.bytes);assert.equal(model.id,profile.built_in_model.id);
 const names=[...model.training_animals,...model.evaluation.evaluation_animals];assert.ok(names.length>=2&&names.every(n=>typeof n==='string'&&n.length>1));
 record('The published model file matches the fingerprint the page carries',{model:model.id,bytes:bytes.length});
 let tamper=false;
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost'),target=path.resolve(dist,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));if(!target.startsWith(dist+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile())return res.writeHead(404).end();res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[path.extname(target)]||'application/octet-stream');if(tamper&&target===file){const changed=Buffer.from(bytes);changed[changed.length-20]^=1;return res.end(changed);}fs.createReadStream(target).pipe(res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>report.page_errors.push(e.message));page.on('request',r=>{if(![origin,'data:','blob:'].some(p=>r.url().startsWith(p)))report.external_requests.push(r.url());});
  await page.goto(origin+'/?nodemo');await page.locator('body.ready').waitFor({timeout:60000});await page.evaluate(()=>CerebellumWorkspace.open('image'));
  const info=page.locator('#analysisModelInfo'),details=page.locator('#analysisModelDetails'),dialog=page.locator('#analysisModelDialog'),status=page.locator('#analysisStatus');
  await page.locator('#analysisAdvanced > summary').click();await page.locator('#analysisBuiltInModel').waitFor({state:'visible'});
  assert.ok(await page.locator('#analysisBuiltInModel').isVisible());assert.ok(await details.isHidden());assert.match(await info.innerText(),/built-in model/);
  record('The built-in model is offered before any model is chosen');

  // A changed file is refused and nothing is selected.
  tamper=true;await page.locator('#analysisBuiltInModel').click();await page.waitForFunction(()=>document.getElementById('analysisStatus').dataset.state==='error',null,{timeout:60000});
  assert.match(await status.innerText(),/does not match its recorded fingerprint/);assert.ok(await details.isHidden());assert.equal(await page.evaluate(()=>document.getElementById('analysisModel').files.length),0);
  record('A model file that differs from its recorded fingerprint is refused');

  tamper=false;await page.locator('#analysisBuiltInModel').click();await page.waitForFunction(id=>document.getElementById('analysisModelInfo').textContent.includes(id),model.id,{timeout:120000});
  assert.match(await status.innerText(),/Model ready/);assert.equal(await page.evaluate(()=>document.getElementById('analysisModel').files[0]?.name),path.basename(file));
  assert.ok(await page.locator('#analysisIncludePL').isChecked());assert.ok(await details.isVisible());
  record('The built-in model is selected through the ordinary model path',{model:model.id});

  // Work screens: counts only. The names appear nowhere on the page until the details window opens.
  const visible=await page.evaluate(()=>document.body.innerText);
  for(const name of names)assert.ok(!new RegExp('(?<![A-Za-z0-9])'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9])').test(visible),'A work screen names an animal: '+name);
  assert.match(await info.innerText(),new RegExp('Evaluation animals: '+model.evaluation.evaluation_animals.length+'(?![0-9])'));
  record('Work screens show how many animals, not which');

  await details.click();await dialog.locator('dl').waitFor({state:'visible'});const text=await dialog.innerText();
  for(const name of names)assert.ok(text.includes(name),'The details window lists '+name);
  assert.ok(text.includes(model.id));assert.ok(text.includes(String(model.training_sources.length)));assert.ok(text.includes(model.training_sources[0].section_id));
  for(const layer of ['CB','ML','GL','WM'])assert.ok(text.includes(layer+': '+(100*model.evaluation.dice[layer]).toFixed(1)+'%'));
  assert.match(text,/does not verify training history/);
  await page.locator('#analysisModelDialogClose').click();assert.equal(await dialog.evaluate(n=>n.open),false);
  record('The details window lists the declared animals, sections and scores');

  await page.locator('#analysisClearModel').click();assert.ok(await details.isHidden());assert.match(await info.innerText(),/built-in model/);
  record('Clearing the model hides its details');

  // The Start guide carries no model button; the guided entry in Image analysis starts the same path.
  await page.keyboard.press('Escape');await page.evaluate(()=>CerebellumWorkspace.open('home'));assert.equal(await page.locator('#workspaceHome #startGuide button').count(),0);
  await page.evaluate(()=>CerebellumWorkspace.open('image',{focus:false}));await page.locator('#autoROIAnalysisStart').click();await page.locator('#analysisBuiltInModel').click();await page.waitForFunction(id=>document.getElementById('analysisModelInfo').textContent.includes(id),model.id,{timeout:120000});
  assert.equal(await page.evaluate(()=>CerebellumWorkspace.snapshot().mode),'image');assert.ok(await page.locator('#analysisAutoGenerate').isChecked());
  record('The guided entry in Image analysis loads the built-in model and turns on automatic drafts');

  assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.external_requests,[]);record('No browser errors or external requests');report.pass=true;
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(__dirname,'builtin-model-browser.json'),JSON.stringify(report,null,2)+'\n');}
})().catch(e=>{console.error(e);process.exitCode=1;});
