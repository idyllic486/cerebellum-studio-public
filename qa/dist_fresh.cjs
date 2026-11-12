// Browser checks serve dist/, which build_site.py makes from src/. A check run on its own after a source edit
// would otherwise test the old build without saying so. This compares every single-source file of the build
// manifest with its source and with the built copy, and stops the check when they differ.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
module.exports=function assertDistFresh(root,dist=path.join(root,'dist')){
  const manifest=JSON.parse(fs.readFileSync(path.join(dist,'build-manifest.json'),'utf8')),stale=[];let compared=0;
  for(const entry of manifest.files){
    const built=path.join(dist,entry.path);
    if(!fs.existsSync(built)||sha(built)!==entry.sha256){stale.push(entry.path+' (built file differs from the manifest)');continue;}
    if(entry.sources.length!==1)continue;
    const source=path.join(root,entry.sources[0]);if(!fs.existsSync(source))continue;
    compared++;if(sha(source)!==entry.sha256)stale.push(entry.path+' (source '+entry.sources[0]+' changed after the build)');
  }
  if(stale.length)throw new Error('dist/ is not in step with the sources; run python3 build_site.py first. '+stale.slice(0,8).join('; ')+(stale.length>8?' and '+(stale.length-8)+' more':''));
  return {files:manifest.files.length,sources_compared:compared};
};
