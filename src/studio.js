(()=>{'use strict';
 const $=id=>document.getElementById(id);
 // Keep the full scientific guidance available without filling the workspace.
 for(const p of document.querySelectorAll('.panelbody > p.mini,.panelbody > small')){
  if(p.textContent.trim().length<145||p.closest('form'))continue;const details=document.createElement('details');details.className='help-detail';const summary=document.createElement('summary');summary.textContent='Interpretation guide';p.before(details);details.append(summary,p);
 }
 $('annExport').textContent='Save to file';document.querySelector('label.filebutton').childNodes[0].textContent='Import';
 document.querySelector('#annotateView .annotation-intro h2').textContent='Naming observations';document.querySelector('#annotateView .annotation-intro p').textContent='View the source and record the evidence.';
 document.querySelector('#sourceView .annotation-intro h2').textContent='Trace every measurement.';document.querySelector('#sourceView .annotation-intro p').textContent='Find a region, see it on the original image, and connect its measurements to your review.';
 $('sourceNext').textContent='Next section to review';$('sourceInspect').textContent='Inspect on image';$('sourceReview').textContent='Add a review';
 $('annShow3D').textContent='View in 3D';$('annCoordinates').textContent='Click on the image to mark a position.';
 for(const n of document.querySelectorAll('#annotateView .legend span')){if(n.textContent.includes('Unverified'))n.style.color='#a86b00';else if(n.textContent.includes('Atlas'))n.style.color='#0071e3';else n.style.color='#087c64';}
 const info=document.createElement('p');info.className='mini';info.textContent='Source-data terms and reviewer judgements are recorded separately.';$('annForm').append(info);
 const conditions=$('conditions'),extras=document.createElement('details');extras.className='help-detail';const extrasTitle=document.createElement('summary');extrasTitle.textContent='Source images and data';extras.append(extrasTitle);let start=$('cutControls').nextSibling;while(start){const next=start.nextSibling;extras.append(start);start=next;}conditions.append(extras);
 document.title='Cerebellum Studio';
})();
