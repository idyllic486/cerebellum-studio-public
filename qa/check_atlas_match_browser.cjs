/* Atlas view: the section open in Image analysis is matched to its closest plane, in this browser only. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright'),M=require('../src/atlas_match_core.js');
const root=path.resolve(__dirname,'..'),dist=process.env.WORKSPACE_TEST_DIST||path.join(root,'dist'),example=path.join(root,'examples','synthetic-section');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
async function main(){
  const server=http.createServer((req,res)=>{const file=path.join(dist,decodeURIComponent(new URL(req.url,'http://x').pathname).replace(/\/$/,'/index.html'));if(!file.startsWith(dist)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cerebellum-atlas-match-'));
  try{
    const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true}),errors=[],outside=[];
    await page.addInitScript(()=>{window.CerebellumEdition='full';});
    page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:')&&!/^(blob|data):/.test(r.url()))outside.push(r.url());});
    await page.goto('http://127.0.0.1:'+server.address().port+'/?nodemo=1');await page.locator('body.ready').waitFor({timeout:60000});
    const profile=await page.evaluate(()=>JSON.parse(document.getElementById('deployment-profile').textContent));
    if(!profile.atlas_reference_available){console.log('Atlas match check skipped: this build carries no atlas.');return;}
    await page.locator('#atlasExplorer').scrollIntoViewIfNeeded();await page.waitForFunction(()=>window.CerebellumAtlasExplorer?.atlas?.(),null,{timeout:90000});
    const run=page.locator('#atlasMatchRun'),status=page.locator('#atlasMatchStatus');
    await run.click();assert.match(await status.innerText(),/Open a section in Image analysis/);assert.ok(await page.locator('#atlasMatchResult').isHidden());
    await page.evaluate(()=>CerebellumWorkspace.open('image',{focus:false,scroll:false}));await page.locator('#analysisImage').setInputFiles(path.join(example,'synthetic-section.tif'));await page.waitForFunction(()=>!document.getElementById('analysisManual').disabled);
    await page.locator('#analysisROIImport').setInputFiles(path.join(example,'synthetic-section_ROIs.zip'));await page.waitForFunction(()=>CerebellumAnalysis.snapshot()?.rois?.length>0);
    await page.locator('.site-header [data-tab="explore"]').click();await run.click();assert.match(await status.innerText(),/pixel size/);
    await page.evaluate(()=>CerebellumWorkspace.open('image',{focus:false,scroll:false}));await page.locator('#analysisMetadata > summary').click();for(const id of['analysisScaleX','analysisScaleY'])await page.locator('#'+id).fill('8');await page.locator('#analysisApplyMetadata').click();
    await page.waitForFunction(()=>CerebellumAnalysis.snapshot().metadata.um_per_pixel_x===8);await page.keyboard.press('Escape');const review=await page.evaluate(()=>CerebellumAnalysis.snapshot());
    await page.locator('.site-header [data-tab="explore"]').click();
    // Stopping leaves everything as it was
    await run.click();await page.locator('#atlasMatchStop').waitFor({state:'visible'});assert.ok(await run.isDisabled());await page.locator('#atlasMatchStop').click();assert.match(await status.innerText(),/stopped/);assert.equal(await page.evaluate(()=>CerebellumAtlasMatch.snapshot()),null);assert.ok(await run.isEnabled());
    await run.click();await page.waitForFunction(()=>window.CerebellumAtlasMatch.snapshot(),null,{timeout:240000});
    const made=await page.evaluate(()=>CerebellumAtlasMatch.snapshot()),atlas=JSON.parse(fs.readFileSync(path.join(root,'assets/atlas-open/ccfv3-bbp-25/sagittal-planes.json'),'utf8'));
    // The page reports what the matching core computes for the same outlines
    const E=require('../src/editable_roi_core.js'),outlines=review.rois.filter(r=>r.included!==false&&['CB','GL','WM'].includes(r.label)).map(r=>({name:r.label,closed:true,paths:r.paths})),W=review.source.width,H=review.source.height,mask=new Uint8Array(W*H);
    // GL and WM are compared as one outline, traced from the two layers together, as the page does
    for(const o of outlines)if(o.name!=='CB')E.rasterInto(mask,W,H,o.paths,1);const own=M.match(outlines.concat([{name:'GL+WM',closed:true,paths:E.traceRings(mask,W,H,1)}]),8,atlas,{useNames:false});assert.equal(made.granular_outline,'GL and WM together');
    const near=made.all.filter(r=>r.distance_um<=made.best.distance_um+5).map(r=>r.lateral_um);assert.deepEqual(made.planes_about_as_close,{within_um:5,lateral_um:[Math.min(...near),Math.max(...near)],planes:near.length});assert.equal(made.cautions.includes('uncertain'),Math.max(...near)-Math.min(...near)>500);assert.equal(made.caution_rules.status,'proposed');
    assert.equal(made.best.figure,own.best.figure);assert.ok(Math.abs(made.best.distance_um-own.best.distance_um)<1e-6);assert.equal(made.candidates_tried,atlas.plates.length);assert.equal(made.outlines_approved,false);assert.equal(made.made_in,'browser');assert.equal(made.names_used,false);
    assert.equal(await page.locator('#atlasRefPlate').inputValue(),String(made.best.plate_index),'The closest plane is the one shown');
    assert.match(await page.locator('#atlasMatchPlane').innerText(),new RegExp('^'+(made.best.plate_index+1)+' / '+atlas.plates.length+'$'));assert.match(await status.innerText(),/draft and are not approved/);assert.match(await status.innerText(),/not a measured position/);
    const explorer=await page.evaluate(()=>CerebellumAtlasExplorer.snapshot());assert.ok(explorer.placed&&explorer.placed.sections===1&&explorer.placed.lines_shown>0,'The section is laid on the atlas');
    assert.equal(await page.locator('#atlasMatchUncertain').isVisible(),made.cautions.includes('uncertain'));assert.equal(await page.locator('#atlasMatchSize').isVisible(),made.cautions.includes('size'));
    const[download]=await Promise.all([page.waitForEvent('download'),page.locator('#atlasMatchSave').click()]),file=path.join(scratch,'match.json');await download.saveAs(file);const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(download.suggestedFilename(),'synthetic-section-atlas-match.json');assert.equal(saved.schema,'cerebellum-atlas-match/1');assert.equal(saved.parameters.status,'proposed');assert.equal(saved.all.length,atlas.plates.length);assert.ok(!JSON.stringify(saved).includes('/Users/'));
    assert.deepEqual(await page.evaluate(()=>CerebellumAnalysis.snapshot().rois),review.rois,'Matching changes nothing in the review');
    assert.deepEqual(errors,[]);assert.deepEqual(outside,[],'Nothing leaves this computer');
    console.log('Atlas match in the browser: refusals, stop, every plane compared, closest plane shown with the section on it, cautions, saved record, review untouched.');
  }finally{await browser.close();server.close();fs.rmSync(scratch,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exit(1);});
