/* Synthetic byte-preservation, package integrity and bounded capacity checks. */
const assert=require('node:assert/strict');
global.ResearchCore=require('../src/research_core.js');
const C=global.ResearchCore,P=require('../src/research_package.js');
const sha=bytes=>C.sha256(bytes);
(async()=>{
 const bytes=new Uint8Array([0,255,3,99,0,8]),digest=await sha(bytes),ref='originals/'+digest;
 const source={name:'Montage.tif',size:bytes.length,sha256:digest,original_ref:ref};
 const project={schema:C.BINARY_SCHEMA,id:'binary-fixture',title:'Exact originals',created_at:'2026-11-04T00:00:00Z',calibration:{xy_unit:'um',um_per_pixel:.5,z_unit:'index'},sections:[{id:'s1',label:'S1',order:1,z:null,included:true,exclusion_reason:'',files:[source],image:{name:source.name,sha256:digest,width:2,height:3},rois:[],csv:{headers:['zero','missing'],rows:[['0','']],delimiter:',',row_count:1,warnings:[]}}],reviews:[]};
 C.validateBundle(project);
 const written=await P.write(project,new Map([[ref,new Blob([bytes])]])),opened=await P.read(written.blob);
 assert.deepEqual(opened.document,project);assert.deepEqual(new Uint8Array(await opened.originals.get(ref).arrayBuffer()),bytes);assert.equal(opened.manifest.originals_included,true);assert.equal(opened.manifest.originals.length,1);assert.match(opened.manifest.scope,/Observations/);assert.equal(project.calibration.um_per_pixel,.5);
 const duplicate=structuredClone(project);duplicate.sections.push({...structuredClone(project.sections[0]),id:'s2',order:2});const dedup=await P.write(duplicate,new Map([[ref,new Blob([bytes])]]));assert.equal(dedup.manifest.originals.length,1);assert.equal((await P.read(dedup.blob)).document.sections.length,2);
 const missing=structuredClone(project);missing.sections[0].included=false;missing.sections[0].exclusion_reason='Damaged source, retained';missing.sections[0].image=null;missing.sections[0].files=[];const missingOpened=await P.read((await P.write(missing,new Map())).blob);assert.equal(missingOpened.document.sections[0].exclusion_reason,'Damaged source, retained');assert.equal(missingOpened.document.sections[0].csv.rows[0][1],'');
 await assert.rejects(P.write(project,new Map()),/missing/);await assert.rejects(P.write(project,new Map([[ref,new Blob([new Uint8Array(bytes.length)])]])),/SHA-256/);
 const tampered=new Uint8Array(await written.blob.arrayBuffer());const signature=new TextEncoder().encode('"originals_included":true');let at=-1;outer:for(let i=0;i<tampered.length-signature.length;i++){for(let j=0;j<signature.length;j++)if(tampered[i+j]!==signature[j])continue outer;at=i;break;}assert.ok(at>0);tampered[at+signature.length-2]^=1;await assert.rejects(P.read(new Blob([tampered])),/CRC32/);
 const unsafe=structuredClone(project);unsafe.sections[0].files[0].original_ref='originals/../escape';assert.throws(()=>C.validateBundle(unsafe),/reference/);await assert.rejects(P.write(unsafe,new Map()),/reference/);
 const embedded=structuredClone(project);embedded.sections[0].files[0].base64='AAAA';assert.throws(()=>C.validateBundle(embedded),/reference/);
 const tooLarge=structuredClone(project);tooLarge.sections[0].files=[];for(let i=0;i<5;i++){const h=String(i).padStart(64,'0');tooLarge.sections[0].files.push({name:i+'.tif',size:128*1024*1024,sha256:h,original_ref:'originals/'+h});}assert.throws(()=>C.validateBundle(tooLarge),/512 MiB/);
 // A seven-section, 32 MiB-per-source study now clears the metadata preflight (224 MiB > legacy 192 MiB).
 const seven=structuredClone(project);seven.sections=Array.from({length:7},(_,i)=>{const h=String(i+20).padStart(64,'0'),name=i+'.tif';return {...structuredClone(project.sections[0]),id:'section-'+i,order:i,files:[{name,size:32*1024*1024,sha256:h,original_ref:'originals/'+h}],image:{name,sha256:h,width:4096,height:4096}};});C.validateBundle(seven);assert.equal(P.refs(seven).size,7);
 // Budget preflight uses only metadata: do not allocate hundreds of MiB to
 // verify that accepted native inputs fit the preservation container.
 const binary=(name,size,index)=>{const h=Number(index).toString(16).padStart(64,'0');return{name,size,sha256:h,original_ref:'originals/'+h};};
 const nativeBudget={schema:'cerebellum-workspace-backup/1',workspaces:{analysis:{files:[
  binary('native-rgb.tif',80000000*3+65536,100),
  ...['cb','layers','lobules'].map((head,i)=>binary(head+'.uint8',80000000,101+i)),
  binary('auto-roi-models.json',64*1024*1024,104),binary('prediction.json',8*1024*1024,105),binary('review-draft.json',48*1024*1024,106),binary('preview.png',16*1024*1024,107)
 ]}}};
 const nativeRefs=P.refs(nativeBudget);assert.equal(nativeRefs.size,8);assert.ok([...nativeRefs.values()].reduce((sum,r)=>sum+r.size,0)>512*1024*1024);
 const maximum={files:Array.from({length:3},(_,i)=>binary(i+'.tif',256*1024*1024,200+i))};assert.equal(P.refs(maximum).size,3);
 assert.throws(()=>P.refs({files:[...maximum.files,binary('one-extra-byte',1,210)]}),/768 MiB/);
 assert.throws(()=>P.refs({files:[binary('oversized-single-file',256*1024*1024+1,211)]}),/Invalid original-file reference/);
 const workspace={schema:'cerebellum-workspace-backup/1',created_at:'2026-11-04T00:00:00Z',workspaces:{observations:project,analysis:null,study:null},scope:{included:['Observation project'],missing:['Analysis workspace is empty','Study workspace is empty']}};const all=await P.write(workspace,new Map([[ref,new Blob([bytes])]]),'workspace'),allRead=await P.read(all.blob);assert.equal(allRead.manifest.kind,'workspace');assert.deepEqual(allRead.document,workspace);assert.deepEqual(allRead.manifest.not_included,workspace.scope.missing);assert.deepEqual(allRead.manifest.included,workspace.scope.included);await assert.rejects(P.write({...workspace,scope:{}},new Map([[ref,new Blob([bytes])]]),'workspace'),/scope/);
 const tooMany={files:Array.from({length:4999},(_,i)=>({name:i+'.roi',size:0,sha256:i.toString(16).padStart(64,'0'),original_ref:'originals/'+i.toString(16).padStart(64,'0')}))};await assert.rejects(P.write(tooMany,new Map()),/4998 original-file entries/,'Writer rejects entry count before looking up bytes or offering an unreadable archive');
 const coreTooMany=structuredClone(project);coreTooMany.sections[0].image=null;coreTooMany.sections[0].files=tooMany.files;assert.throws(()=>C.validateBundle(coreTooMany),/4998 original files/);
 console.log('Observation packages: binary round-trip, exact bytes, null/zero/exclusions, deduplication, SHA/CRC tampering, reference validation, 224 MiB study preflight and three-head native backup within the 768 MiB package/256 MiB file bounds passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
