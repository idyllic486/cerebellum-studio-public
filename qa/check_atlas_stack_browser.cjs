/* Atlas view: every section of one study animal is matched and the sections are stacked at their closest planes. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),dist=process.env.WORKSPACE_TEST_DIST||path.join(root,'dist'),fixture=require('./atlas_stack_fixture.cjs');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
async function main(){
  const server=http.createServer((req,res)=>{const file=path.join(dist,decodeURIComponent(new URL(req.url,'http://x').pathname).replace(/\/$/,'/index.html'));if(!file.startsWith(dist)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cerebellum-atlas-stack-'));
  try{
    const made=fixture(root,[6,18,30]);made.study.animals[0].sections.push({...JSON.parse(JSON.stringify(made.study.animals[0].sections[0])),id:'section-no-scale',order:4,calibration:{um_per_pixel_x:null,um_per_pixel_y:null}},{...JSON.parse(JSON.stringify(made.study.animals[0].sections[1])),id:'section-excluded',order:5,included:false,exclusion_reason:'made-up exclusion'});
    const file=path.join(scratch,'study.json');fs.writeFileSync(file,JSON.stringify(made.study));
    const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true}),errors=[],outside=[];
    await page.addInitScript(()=>{window.CerebellumEdition='full';});
    page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:')&&!/^(blob|data):/.test(r.url()))outside.push(r.url());});
    await page.goto('http://127.0.0.1:'+server.address().port+'/?nodemo=1');await page.locator('body.ready').waitFor({timeout:60000});
    if(!(await page.evaluate(()=>JSON.parse(document.getElementById('deployment-profile').textContent))).atlas_reference_available){console.log('Atlas stack check skipped: this build carries no atlas.');return;}
    await page.locator('#atlasExplorer').scrollIntoViewIfNeeded();await page.waitForFunction(()=>window.CerebellumAtlasExplorer?.atlas?.(),null,{timeout:90000});
    assert.ok(await page.locator('#atlasMatchStackRun').isDisabled(),'Nothing to stack before a study is open');
    await page.evaluate(()=>CerebellumWorkspace.open('study',{focus:false,scroll:false}));await page.locator('#studyImport').setInputFiles(file);await page.waitForFunction(()=>window.CerebellumStudy.snapshot()?.animals?.length===1);const before=await page.evaluate(()=>CerebellumStudy.snapshot());
    await page.locator('.site-header [data-tab="explore"]').click();await page.evaluate(()=>CerebellumAtlasMatch.refreshAnimals());assert.deepEqual(await page.locator('#atlasMatchAnimal option').evaluateAll(n=>n.map(o=>o.value)),['MADE-UP-1']);
    await page.locator('#atlasMatchStackRun').click();await page.waitForFunction(()=>window.CerebellumAtlasMatch.snapshot()?.sections,null,{timeout:300000});
    const result=await page.evaluate(()=>CerebellumAtlasMatch.snapshot());
    assert.equal(result.animal,'MADE-UP-1');assert.equal(result.sections_matched,3);assert.deepEqual(result.sections_skipped,['section-no-scale'],'A section without a pixel size is left out and named; an excluded one is not considered');
    assert.deepEqual(result.sections.map(s=>s.best.figure),made.figures,'Each section lands on the plane it was made from');for(const s of result.sections){assert.ok(s.best.distance_um<25);assert.ok(Math.abs(s.best.scale-1/.95)<.03);assert.equal(s.um_per_pixel,5);assert.equal(s.granular_outline,'GL and WM together');assert.ok(s.planes_about_as_close.lateral_um[0]<=s.best.lateral_um&&s.best.lateral_um<=s.planes_about_as_close.lateral_um[1]);}assert.equal(result.caution_rules.status,'proposed');
    const shown=await page.evaluate(()=>CerebellumAtlasExplorer.snapshot().placed);assert.deepEqual(shown.animals,['MADE-UP-1']);assert.equal(shown.sections,3);assert.ok(shown.lines_shown>=6);
    const rows=await page.locator('#atlasMatchStackList tr').evaluateAll(n=>n.map(r=>[...r.cells].map(c=>c.textContent)));assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r[0]),['section-1','section-2','section-3']);assert.deepEqual(rows.map(r=>r[1]),['7','19','31']);
    assert.equal(await page.locator('#atlasMatchStackCount').innerText(),'3 · 3 · 1');assert.match(await page.locator('#atlasMatchStatus').innerText(),/not measured positions/);
    const[download]=await Promise.all([page.waitForEvent('download'),page.locator('#atlasMatchSave').click()]);assert.equal(download.suggestedFilename(),'MADE-UP-1-atlas-match.json');const out=path.join(scratch,'saved.json');await download.saveAs(out);const saved=JSON.parse(fs.readFileSync(out,'utf8'));assert.equal(saved.sections.length,3);assert.ok(!('placed' in saved.sections[0]));assert.equal(saved.parameters.status,'proposed');
    // Volumes between the matched positions: section areas counted on the section's own pixels, integrated as the core does
    const V=require('../src/atlas_volume_core.js'),shoelace=p=>Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-b[0]*a[1];},0)/2),stackedSections=made.study.animals[0].sections;
    result.sections.forEach((s,i)=>{const want=shoelace(stackedSections[i].rois[0].paths[0])*25/1e6;assert.ok(Math.abs(s.area_mm2.Cb-want)/want<.01,'Section area is the outline area: '+s.area_mm2.Cb+' vs '+want);assert.ok(s.area_mm2.GL_TOTAL>0);assert.equal(s.area_mm2.WM,null,'No white-matter outline, no white-matter area');});
    const own=V.arrange(result.sections.map(s=>({sample:s.section,lateral_um:s.best.lateral_um,values:s.area_mm2})),null);assert.ok(Math.abs(result.volumes.volume_mm3_own_range.Cb-own.volume_mm3_own_range.Cb)<1e-12);assert.ok(own.volume_mm3_own_range.Cb>0);assert.equal(result.volumes.volume_mm3_own_range.WM,null);assert.match(result.volumes.statement,/not measured volumes/);
    assert.ok(await page.locator('#atlasMatchVolumes').isVisible());const shownCb=()=>page.locator('#atlasMatchVolumeCb').innerText();assert.equal(await shownCb(),own.volume_mm3_own_range.Cb.toFixed(2)+' mm³');assert.equal(await page.locator('#atlasMatchVolumeWM').innerText(),'–');assert.ok(await page.locator('#atlasMatchVolumeNote').isHidden());
    const lo=result.sections[0].best.lateral_um+100,hi=result.sections[2].best.lateral_um-100,part=V.arrange(result.sections.map(s=>({sample:s.section,lateral_um:s.best.lateral_um,values:s.area_mm2})),[lo,hi]);
    await page.locator('#atlasMatchRangeLow').fill(String(lo));assert.ok(await page.locator('#atlasMatchVolumeNote').isVisible(),'Half a range is said to be incomplete');assert.equal(await shownCb(),own.volume_mm3_own_range.Cb.toFixed(2)+' mm³');
    await page.locator('#atlasMatchRangeHigh').fill(String(hi));assert.equal(await shownCb(),part.volume_mm3_common_range.Cb.toFixed(2)+' mm³');assert.ok(part.volume_mm3_common_range.Cb<own.volume_mm3_own_range.Cb);assert.ok(await page.locator('#atlasMatchVolumeNote').isHidden());assert.deepEqual((await page.evaluate(()=>CerebellumAtlasMatch.snapshot())).volumes.common_range_um,[lo,hi]);
    await page.locator('#atlasMatchRangeHigh').fill(String(hi+5000));assert.match(await page.locator('#atlasMatchVolumeNote').innerText(),/do not reach both ends/);assert.equal(await shownCb(),own.volume_mm3_own_range.Cb.toFixed(2)+' mm³','Beyond the sections the animal\'s own span is shown again');await page.locator('#atlasMatchRangeLow').fill('');await page.locator('#atlasMatchRangeHigh').fill('');
    assert.deepEqual(await page.evaluate(()=>CerebellumStudy.snapshot()),before,'Stacking changes nothing in the study');assert.deepEqual(errors,[]);assert.deepEqual(outside,[],'Nothing leaves this computer');
    console.log('Atlas stack in the browser: three sections matched side by side to their own planes, one left out for want of a pixel size, table, volumes between the matched positions over the animal\'s span and a stated range, saved record, study untouched.');
  }finally{await browser.close();server.close();fs.rmSync(scratch,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exit(1);});
