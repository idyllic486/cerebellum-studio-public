/* A focused (public) edition offers three workspaces and no entry points to the ones it leaves out. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const dist=process.env.WORKSPACE_TEST_DIST||path.resolve(__dirname,'../dist');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
async function main(){
  const found=fs.readFileSync(path.join(dist,'index.html'),'utf8').match(/<script[^>]*id="deployment-profile"[^>]*>([\s\S]*?)<\/script>/);assert.ok(found,'The page carries its deployment profile');const profile=JSON.parse(found[1]);
  if(!profile.focused_edition){console.log('Focused edition check skipped: this build offers every workspace.');return;}
  const server=http.createServer((req,res)=>{const file=path.join(dist,decodeURIComponent(new URL(req.url,'http://x').pathname).replace(/\/$/,'/index.html'));if(!file.startsWith(dist)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
  try{
    const errors=[];
    for(const width of [1280,360]){
      const page=await browser.newPage({viewport:{width,height:900}});page.on('pageerror',e=>errors.push(String(e)));
      await page.goto('http://127.0.0.1:'+server.address().port+'/');await page.locator('body.ready').waitFor({timeout:60000});
      assert.equal(await page.evaluate(()=>document.body.dataset.edition),'focused');
      await page.locator('.site-header [data-tab="research"]').click();
      const shown=await page.locator('#workspaceNav [data-workspace-mode]').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width>0).map(n=>n.dataset.workspaceMode));
      assert.deepEqual(shown,['home','image','study'],'The menu offers Start, Image analysis and Study & 3D');
      for(const mode of shown){await page.locator('#workspaceNav [data-workspace-mode="'+mode+'"]').click();await page.waitForFunction(m=>document.getElementById('researchView').dataset.workspaceMode===m,mode);const w=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(w<=width+1,mode+' fits '+width+'px: '+w);}
      const stages=await page.locator('#studySteps > button').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width>0).length);assert.equal(stages,5,'Five study stages are offered');
      if(width>=1000){const tops=await page.locator('#studySteps > button').evaluateAll(nodes=>[...new Set(nodes.filter(n=>n.getBoundingClientRect().width>0).map(n=>Math.round(n.getBoundingClientRect().top)))]);assert.equal(tops.length,1,'The study stages sit on one line');}
      const stray=await page.evaluate(()=>[...document.querySelectorAll('[data-workspace-open="observations"],[data-workspace-open="tools"],#privateCollaboration,#workspaceToolsNav')].filter(n=>n.getBoundingClientRect().width>0).map(n=>n.id||n.className||n.textContent.trim()));
      assert.deepEqual(stray,[],'Nothing on screen leads to a workspace this edition leaves out');
      // Many sections at once are registered inside Study & 3D
      await page.locator('#workspaceNav [data-workspace-mode="study"]').click();const toggle=page.locator('#studyRegisterToggle');assert.ok(await toggle.isVisible());assert.ok(await page.locator('#studyRegisterBody').isHidden());
      await toggle.click();for(const id of ['researchInputTitle','researchRows','studyResearchAnimalID','studyFromResearch'])assert.ok(await page.locator('#'+id).isVisible(),id+' is offered in the register');
      assert.equal(await toggle.getAttribute('aria-expanded'),'true');const wide=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(wide<=width+1,'The open register fits '+width+'px: '+wide);
      await toggle.click();assert.ok(await page.locator('#studyRegisterBody').isHidden());
      await page.locator('.site-header [data-tab="explore"]').click();
      const hero=await page.locator('#heroBar :is(button,a)').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width>0).map(n=>Math.round(n.getBoundingClientRect().top)));
      assert.ok(hero.length>=3&&new Set(hero).size===1,'Opening actions sit on one line: '+JSON.stringify(hero));
      await page.close();
    }
    assert.deepEqual(errors,[]);
    {const page=await browser.newPage({viewport:{width:1280,height:900}});await page.goto('http://127.0.0.1:'+server.address().port+'/?edition=full');await page.locator('body.ready').waitFor({timeout:60000});assert.equal(await page.evaluate(()=>document.body.dataset.edition),undefined);await page.locator('.site-header [data-tab="research"]').click();const all=await page.locator('#workspaceNav [data-workspace-mode]').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width>0).length);assert.equal(all,5,'?edition=full offers every workspace');await page.close();}
    console.log('Focused edition: three workspaces, five study stages, no stray entry points, at 1280 and 360 px.');
  }finally{await browser.close();server.close();}
}
main().catch(e=>{console.error(e);process.exit(1);});
