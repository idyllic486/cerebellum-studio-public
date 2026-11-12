/* Guided navigation uses existing analysis actions; it never edits or approves ROIs. */
(function(){'use strict';
const $=id=>document.getElementById(id),host=$('autoROIWorkflow');if(!host)return;
let state={hasSource:false,hasModel:false,busy:false,hasDraft:false,hasRaster:false,approved:false};
function update(){
 const current=window.CerebellumAnalysis?.automationState?.();
 if(current)state={...state,...current};
 const text=state.busy?'Processing image or model…':state.approved?(state.hasRaster?'Reviewed ROIs are available. A separate model label map remains unreviewed.':'Reviewed result ready. Export measurements or continue to Study.'):state.hasDraft?(state.hasRaster?'An ROI draft and a separate model label map are available. Inspect them before approval.':'ROI draft ready. Inspect boundaries before approving measurements.'):state.hasRaster?'Native model labels are ready. Inspect the map; editable ROI conversion still needs review.':!state.hasModel?'Train once, then open your model file.':!state.hasSource?'Model ready. Open a new montage to generate a draft.':'Image and model ready. Generate a draft in Image analysis.';
 const status=$('autoROIReadiness');if(status.dataset.message!==text){status.textContent=text;status.dataset.message=text;}
 status.dataset.state=state.busy?'processing':state.approved?'approved':state.hasDraft?'draft':state.hasRaster?'labels':state.hasModel?'model':'empty';
 for(const id of ['autoROIOpenModel','autoROIBuiltInModel','autoROIOpenImage','autoROIAnalysisStart'])$(id).disabled=!!state.busy;
 $('autoROIReview').disabled=!!state.busy||!(state.hasDraft||state.hasRaster);
 $('autoROIMeasurements').disabled=!!state.busy||!state.hasDraft;
}
function open(id,{automatic=false,roiOnly=false}={}){
 update();if(state.busy||roiOnly&&!(state.hasDraft||state.hasRaster))return;
 const trigger=document.activeElement;
 window.CerebellumWorkspace?.open('image',{focus:false,scroll:false});
 const target=$(id);if(!target||target.disabled)return;
 const detail=target.parentElement?.closest('details');
 for(let p=target.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS'&&p!==detail)p.open=true;
 if(automatic){const checkbox=$('analysisAutoGenerate');if(checkbox&&!checkbox.disabled&&!checkbox.checked){checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));}}
 if(roiOnly){target.value='roi';target.dispatchEvent(new Event('change',{bubbles:true}));}
 if(!target.matches('button,input,select,textarea,a[href]'))target.tabIndex=-1;
 if(detail)window.CerebellumFocusCards.openDetails(detail,trigger);
 window.CerebellumMotion.focusAfterReveal(target,{isCurrent:()=>window.CerebellumWorkspace?.snapshot().mode==='image',scroll:true,block:'center'});
}
$('autoROIOpenModel').addEventListener('click',()=>open('analysisModel',{automatic:true}));
// The built-in model is offered only where the build publishes one; the analysis panel loads and checks it.
if(window.CerebellumBoot?.profile.built_in_model){$('autoROIBuiltInModel').hidden=false;$('autoROIBuiltInModel').addEventListener('click',()=>{open('analysisBuiltInModel',{automatic:true});$('analysisBuiltInModel').click();});}
$('autoROIOpenImage').addEventListener('click',()=>open('analysisImage',{automatic:true}));
$('autoROIReview').addEventListener('click',()=>open('analysisViewMode',{roiOnly:true}));
$('autoROIMeasurements').addEventListener('click',()=>open('analysisWorkflow'));
$('autoROIAnalysisStart').addEventListener('click',()=>open('analysisModel',{automatic:true}));
window.addEventListener('cerebellum-analysis-state',update);
window.addEventListener('cerebellum-workspace-open',update);
window.CerebellumAutoROIWorkflow=Object.freeze({snapshot:()=>({...state})});update();
})();
