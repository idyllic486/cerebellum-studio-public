/* The figure export draws what is under review, at fixed line weights, and never invents a scale. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),dist=process.env.WORKSPACE_TEST_DIST||path.join(root,'dist'),example=path.join(root,'examples','synthetic-section');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
async function main(){
  const server=http.createServer((req,res)=>{const file=path.join(dist,decodeURIComponent(new URL(req.url,'http://x').pathname).replace(/\/$/,'/index.html'));if(!file.startsWith(dist)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cerebellum-figure-'));
  try{
    const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true}),errors=[],outside=[];
    await page.addInitScript(()=>{window.CerebellumEdition='full';});
    page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:')&&!/^(blob|data):/.test(r.url()))outside.push(r.url());});
    await page.goto('http://127.0.0.1:'+server.address().port+'/?nodemo=1');await page.locator('body.ready').waitFor({timeout:60000});await page.evaluate(()=>CerebellumWorkspace.open('image',{focus:false,scroll:false}));
    await page.locator('#analysisImage').setInputFiles(path.join(example,'synthetic-section.tif'));await page.waitForFunction(()=>!document.getElementById('analysisManual').disabled);
    assert.ok(await page.locator('#analysisFigureSVG').isDisabled(),'No figure before there are outlines');
    await page.locator('#analysisROIImport').setInputFiles(path.join(example,'synthetic-section_ROIs.zip'));await page.waitForFunction(()=>CerebellumAnalysis.snapshot()?.rois?.length>0);
    await page.waitForFunction(()=>!document.getElementById('analysisFigureSVG').disabled);
    const state=await page.evaluate(()=>CerebellumAnalysis.snapshot()),before=JSON.stringify(state);
    const take=async(id,name)=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);const file=path.join(scratch,name);await d.saveAs(file);return{file,name:d.suggestedFilename()};};
    // Vector figure, pixel size unknown
    let svg=await take('analysisFigureSVG','unknown.svg');assert.equal(svg.name,'synthetic-section-figure.svg');let text=fs.readFileSync(svg.file,'utf8');
    assert.equal((text.match(/<path /g)||[]).length,state.rois.filter(r=>r.included!==false).length,'One path for each outline shown');
    assert.ok(!/id="scale-bar"/.test(text),'No scale bar without a pixel size');assert.match(text,/Pixel size unknown; no scale bar\./);assert.match(text,/Draft outlines, not approved\./);
    assert.ok(!/blob:|vector-effect|127\.0\.0\.1/.test(text),'The file stands alone and its line weights are fixed');assert.match(text,/<image [^>]*href="data:image\/png;base64,/,'The section image is embedded');
    const first=state.rois.find(r=>r.included!==false).paths[0][0];assert.ok(text.includes('M'+(Math.round(first[0]*100)/100)+','+(Math.round(first[1]*100)/100)),'Coordinates are the source pixels');
    for(const label of new Set(state.rois.map(r=>r.label)))assert.ok(text.includes('>'+label),'Legend names '+label);
    assert.match(await page.locator('#analysisFigureNote').innerText(),/draft/i);
    // Outlines only: no picture inside
    await page.locator('#analysisViewMode').selectOption('roi');svg=await take('analysisFigureSVG','roi.svg');text=fs.readFileSync(svg.file,'utf8');assert.ok(!/<image /.test(text),'Outlines-only view exports no image');
    // One structure: only what is shown
    await page.locator('#analysisLabelChips [data-label="GL"]').click();await page.waitForFunction(()=>document.querySelectorAll('#analysisContours [data-roi]').length===1);svg=await take('analysisFigureSVG','gl.svg');text=fs.readFileSync(svg.file,'utf8');
    assert.equal((text.match(/<path /g)||[]).length,1);assert.match(text,/data-label="GL"/);await page.locator('#analysisLabelChips [data-label=""]').click();
    // Known pixel size: a round scale bar of the right length
    await page.locator('#analysisMetadata > summary').click();for(const[id,value]of[['analysisScaleX','2'],['analysisScaleY','2']])await page.locator('#'+id).fill(value);await page.locator('#analysisApplyMetadata').click();
    await page.waitForFunction(()=>CerebellumAnalysis.snapshot().metadata.um_per_pixel_x===2);await page.keyboard.press('Escape');
    svg=await take('analysisFigureSVG','scaled.svg');text=fs.readFileSync(svg.file,'utf8');const um=Number(text.match(/data-um="(\d+)"/)[1]),line=text.match(/<line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)"/);
    assert.ok([1,2,5].includes(Number(String(um)[0]))&&/^[125]0*$/.test(String(um)),'The bar is a round length: '+um);assert.ok(Math.abs((Number(line[2])-Number(line[1]))*2-um)<.1,'The bar is as long as it says');assert.match(text,/Pixel size 2 µm\./);
    // Picture file
    const png=await take('analysisFigurePNG','figure.png'),bytes=fs.readFileSync(png.file);assert.equal(png.name,'synthetic-section-figure.png');assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),3000,'The picture is 3000 px wide');
    assert.equal(JSON.stringify(await page.evaluate(()=>{const s=CerebellumAnalysis.snapshot();s.metadata.um_per_pixel_x=null;s.metadata.um_per_pixel_y=null;return s.rois;})),JSON.stringify(state.rois),'Exporting changes nothing in the review');
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[],'Nothing leaves this computer');void before;
    console.log('Figure export: vector and picture files, embedded image, shown outlines only, scale bar only with a known pixel size, review untouched.');
  }finally{await browser.close();server.close();fs.rmSync(scratch,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exit(1);});
