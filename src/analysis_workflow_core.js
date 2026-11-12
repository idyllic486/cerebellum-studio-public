/* Read-only work suggestions and opt-in timing, independent of scientific state. */
(function(root){'use strict';
const IDLE_MS=60000;
function suggestions(context={}){
 const c=context,blocked=!!c.busy||!!c.pending,approved=!!c.approved&&!blocked;
 const card=(id,title,detail,target,available=true)=>({id,title,detail,target,available:available&&!c.busy});
 if(!c.hasSource)return[card('source','Open a section','Choose one original section TIFF to see the available next steps.','analysisImage')];
 if(!c.hasReview)return[
  card('boundaries','Reuse reviewed boundaries','Existing ImageJ ROIs can be connected to this original image without redrawing them.','analysisROIImport'),
  ...(c.modelReady?[card('model','Generate a model draft','A compatible model is selected. Its output still needs review; model accuracy is not established here.','analysisGenerate',!blocked)]:[card('model','Open your trained ROI models','Use the automatic ROI tools on My research to train from reviewed sources, then open auto-roi-models.json here.','analysisModel',!blocked)]),
  card('manual','Start a manual review','Draw or import boundaries when a model is unavailable or its draft needs correction.','analysisManual',!blocked)
 ];
 const cards=[card('review',c.roiCount?'Inspect boundaries and exclusions':'Add or import boundaries',c.roiCount?'Inspect the image, area boundaries, open lines and points before approving measurements.':'No ROI is available yet. Import existing boundaries or begin a manual boundary.','analysisROIImport',!blocked)];
 if(c.roiCount)cards[0].target='analysisROI';
 if(!c.calibrated)cards.push(card('calibration','Confirm physical scale','Physical area and length require measured X and Y scales. Leave unknown values blank; pixel measurements remain available.','analysisScaleX',!c.busy));
 if(c.roiCount)cards.push(card('measurements','Inspect section measurements',c.calibrated?'Inspect area, line length or point coordinates according to each ROI type. Draft measurements still need approval.':'Inspect pixel area, pixel line length or point coordinates. Physical values remain unavailable until calibration is supplied.','analysisMeasurement',!c.busy));
 if(c.hasCSV)cards.push(card('reference','Compare original measurements','Inspect the retained source CSV and the comparison before interpreting differences in measurement definitions.','analysisCSVFile',!blocked));
 cards.push(approved?card('archive','Retain approved results','Download ImageJ ROIs, measurement CSV and original evidence. Check that the archive was saved.','analysisExport'):card('approval','Complete the section review',c.pending?'Apply or discard pending edits before completing the review.':'Confirm the source alignment, metadata and review checks. Approval records your review, not independent model validation.','analysisReviewer',!blocked&&c.roiCount>0));
 cards.push(card('study','Continue to a multi-section study',!approved?'Approve the current section before continuing. A study requires a fresh review of its copied inputs.':!c.calibrated||!c.hasZ?'The study can retain this section. Physical reconstruction still requires measured XY, actual Z and additional reviewed sections.':'Add other reviewed sections and confirm their shared coordinates in Study. One section does not establish volume or a WT-KO comparison.','analysisContinueStudy',approved));
 return cards;
}
function createClock(now=()=>performance.now()){
 let total=0,running=false,blocked=false,last=now(),activity=last;
 function tick(){const time=now();if(running&&!blocked)total+=Math.max(0,Math.min(time,activity+IDLE_MS)-last);last=time;return total;}
 return Object.freeze({
  start(){tick();running=true;activity=last;},
  pause(){tick();running=false;},
  activity(){tick();if(!blocked)activity=last;},
  block(value){tick();if(blocked&&!value)activity=last-IDLE_MS;blocked=!!value;},
  reset(){tick();total=0;running=false;activity=last;},
  snapshot(){tick();return{elapsed_ms:Math.round(total),recording:running,active:running&&!blocked&&last<activity+IDLE_MS,blocked,idle_limit_ms:IDLE_MS};}
 });
}
const api=Object.freeze({suggestions,createClock,IDLE_MS});root.AnalysisWorkflowCore=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
