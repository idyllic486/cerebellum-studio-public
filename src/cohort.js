(()=>{'use strict';
 const $=id=>document.getElementById(id);const retry=document.createElement('button');retry.type='button';retry.textContent='Retry comparison data';retry.hidden=true;retry.onclick=load;$('cohortError').after(retry);
 const names={CB:'Whole cerebellum',ML:'Molecular layer',GL:'Granular layer',WM:'White matter',PL:'Purkinje layer path'};
 const datasets={original66_manual:'Original 66 sections · manual',matched64_manual:'Common 64 sections · manual',matched64_model:'Common 64 sections · AI'};
 let data=null;
 const n=(v,d=3)=>v==null?'—':Number(v).toFixed(d),percent=v=>v==null?'—':`${v>0?'+':''}${n(v,2)}%`;
 function cell(row,value){const td=document.createElement('td');td.textContent=String(value);row.append(td);}
 function selected(){const animal=$('cohortAnimal').value,filter=$('cohortFilter').value;return data.sections.filter(s=>(animal==='all'||s.mouse===animal)&&(filter==='all'||(filter==='paired'?s.received:!s.received)));}
 function render(){if(!data)return;const key=$('cohortMetric').value,rows=selected(),valid=rows.filter(s=>s.metrics[key]?.percent!=null);const body=$('cohortRows');body.replaceChildren();
  for(const s of rows){const tr=document.createElement('tr'),m=s.metrics[key];cell(tr,s.id);cell(tr,s.group);cell(tr,m?n(m.manual):'—');cell(tr,m?n(m.model):'—');cell(tr,m?percent(m.percent):'—');cell(tr,!s.received?'AI CSV missing':m.manual==null?'Manual length missing':'Linked · labelled training');body.append(tr);}
  if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.textContent='No sections meet these criteria.';tr.append(td);body.append(tr);}
  const mean=valid.length?valid.reduce((sum,s)=>sum+Math.abs(s.metrics[key].percent),0)/valid.length:null;
  $('cohortStatus').textContent=`${names[key]} · displayed ${rows.length} sections · valid comparisons ${valid.length} sections · mean absolute percentage difference ${mean==null?'—':n(mean,2)+'%'}. This is not a measure of accuracy.`;
  const plot=$('cohortPlot');plot.replaceChildren();const title=document.createElement('h3');title.textContent='8 sections with the largest absolute difference';plot.append(title);
  const top=[...valid].sort((a,b)=>Math.abs(b.metrics[key].percent)-Math.abs(a.metrics[key].percent)).slice(0,8);
  if(!top.length){const p=document.createElement('p');p.textContent='No comparable values.';plot.append(p);return;}
  const scale=Math.max(...top.map(s=>Math.abs(s.metrics[key].percent)),1e-9);
  const hint=document.createElement('p');hint.className='mini';hint.textContent='Left − / centre 0 / right + · relative difference between measurements';plot.append(hint);
  for(const s of top){const v=s.metrics[key].percent,row=document.createElement('div');row.className='difference-row';const label=document.createElement('span');label.textContent=s.id;const track=document.createElement('div');track.className='difference-track';const mark=document.createElement('i');mark.className='difference-mark '+(v<0?'negative':'positive');mark.style.width=(Math.abs(v)/scale*48)+'%';track.append(mark);const value=document.createElement('span');value.className='difference-value';value.textContent=percent(v);row.append(label,track,value);plot.append(row);}
 }
 function groups(){if(!data)return;const aggregation=$('cohortAggregation').value,metric=$('cohortGroupMetric').value,root=$('cohortContrasts');root.replaceChildren();
  for(const r of data.contrasts.filter(r=>r.within_mouse_aggregation===aggregation&&r.metric===metric)){const tr=document.createElement('tr');cell(tr,datasets[r.dataset]||r.dataset);cell(tr,n(r.WT));cell(tr,n(r.KO));cell(tr,percent(r.percent));root.append(tr);}
  const animals=$('cohortAnimals');animals.replaceChildren();for(const r of data.aggregates.filter(r=>r.aggregation===aggregation&&r.metric===metric)){const tr=document.createElement('tr');cell(tr,datasets[r.dataset]||r.dataset);cell(tr,r.mouse);cell(tr,r.group);cell(tr,n(r.value));animals.append(tr);}
 }
 async function load(){retry.disabled=true;try{const value=JSON.parse(await window.CerebellumBoot.readText('./data/cohort.json'));data=value;if(data.schema!=='cerebellum-cohort/1')throw Error('Unsupported comparison data format.');
   $('cohortError').classList.add('hidden');retry.hidden=true;$('cohortOverview').replaceChildren();for(const a of data.animals){const option=document.createElement('option');option.value=a.id;option.textContent=`${a.id} · ${a.group}`;$('cohortAnimal').append(option);const item=document.createElement('div');const title=document.createElement('strong');title.textContent=`${a.id} · ${a.group}`;const count=document.createElement('span');count.textContent=`Manual ${a.sections} · AI linked ${a.matched}`;item.append(title,count);$('cohortOverview').append(item);}
   for(const id of ['cohortMetric','cohortAnimal','cohortFilter'])$(id).onchange=render;for(const id of ['cohortAggregation','cohortGroupMetric'])$(id).onchange=groups;render();groups();
  }catch(e){$('cohortError').textContent=e.message;$('cohortError').classList.remove('hidden');$('cohortStatus').textContent='Comparison data could not be read.';retry.hidden=false;}finally{retry.disabled=false;}}
 load();
})();
