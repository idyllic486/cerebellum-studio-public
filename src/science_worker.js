'use strict';
importScripts('./analysis_core.js','./study_core.js','./validation_core.js','./reconstruction_core.js','./atlas_reference_core.js');
self.onmessage=async({data})=>{
  try {
    let result;
    if(data.operation==='prepare_pairs')result=await ValidationCore.prepareStudyPairs(data.prediction,data.reference,data.options);
    else if(data.operation==='atlas_candidates')result=AtlasReferenceCore.rankCandidateCuts(data.atlas,data.observed,data.candidates,data.options);
    else if(data.operation==='volume_sensitivity')result=await StudyCore.volumeSensitivity(data.study,data.animalId,data.layer,data.options);
    else if(data.operation==='resolution_sensitivity')result=ValidationCore.evaluateResolutionSensitivity(data.pair,data.options);
    else throw Error('Unsupported evidence calculation.');
    self.postMessage({result});
  }catch(error){self.postMessage({error:error.message});}
};
