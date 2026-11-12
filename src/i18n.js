/* Interface-only localization. Source text and input values are never rewritten. */
(() => {
  'use strict';
  if (window.CerebellumI18n) return;
  const LOCALES = Object.freeze(['en', 'ko', 'ja', 'zh-Hant-TW', 'zh-Hans-CN']);
  const STORAGE_KEY = 'cerebellum-studio.locale';
  const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt', 'label'];
  const PROTECTED = '[translate="no"],[data-i18n-skip],[contenteditable]:not([contenteditable="false"])';
  const TEXT_BLOCKED = 'script,style,noscript,code,pre,textarea,svg,canvas,math';
  const CHILDREN_BLOCKED = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','SVG','CANVAS','MATH','INPUT']);
  const picker = document.getElementById('studioLocale');
  const status = document.getElementById('studioLocaleStatus');
  const textRecords = new WeakMap(), attributeRecords = new WeakMap();
  const catalogs = new Map([['en', new Map()]]), origins = new Map(), protectedValues = new Set();
  const missing = new Set(), pendingNodes = new Set(), renderedCache = new Map();
  let locale = 'en', dictionary = catalogs.get('en'), templates = [], templateSource = null, supplementalSource = null;
  let request = 0, controller = null, scheduled = false, fragmentPattern = null, lastError = null;
  const normalize = value => String(value).replace(/\s+/g, ' ').trim();
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function remember(map, key, value, limit = 2500) {
    if (map.size >= limit && !map.has(key)) map.delete(map.keys().next().value);
    map.set(key, value);
  }
  function preserveSpace(source, translated) {
    return (source.match(/^\s*/)?.[0] || '') + translated + (source.match(/\s*$/)?.[0] || '');
  }
  function exact(source) {
    if (locale === 'en') return source;
    const translated = dictionary.get(normalize(source));
    return typeof translated === 'string' ? preserveSpace(source, translated) : source;
  }
  function protect(value) {
    if (value instanceof Element) { value.setAttribute('translate','no'); collectProtected(value); return value; }
    const text = String(value ?? '');
    if (text.trim() && text.length <= 2000) {
      if (protectedValues.size >= 5000) protectedValues.delete(protectedValues.values().next().value);
      protectedValues.add(text.trim());
    }
    return text;
  }
  function collectProtected(root) {
    if (!root) return;
    const roots = root instanceof Element && root.matches(PROTECTED) ? [root] : [];
    if (root.querySelectorAll) roots.push(...root.querySelectorAll(PROTECTED));
    for (const element of roots) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest('script,style')) protect(node.data);
      }
    }
    const inputs = root instanceof HTMLInputElement ? [root] : [...(root.querySelectorAll?.('input') || [])];
    for (const input of inputs) {
      if (['text','search','email','url','tel'].includes(input.type)) protect(input.value);
      for (const file of input.files || []) protect(file.name);
    }
  }
  function compileTemplates(rows) {
    if (!Array.isArray(rows)) throw new Error('Invalid interface templates.');
    return rows.filter(row => row && typeof row.source === 'string').map(row => {
      const ids = [], literals = [], expression = /\{(\d{1,2})\}/g; let cursor = 0, match;
      while ((match = expression.exec(row.source))) { literals.push(row.source.slice(cursor,match.index)); ids.push(Number(match[1])); cursor=expression.lastIndex; }
      literals.push(row.source.slice(cursor));
      if (!ids.length || ids.length > 10 || literals.join('').replace(/[^A-Za-z]/g,'').length < 3) return null;
      const literalPattern = literal => literal.split(/(\s+)/).map(part => /^\s+$/.test(part) ? '\\s+' : escapeRegex(part)).join('');
      const pattern = '^' + literals.map((literal,index) => literalPattern(literal)+(index<ids.length?'([\\s\\S]*?)':'')).join('') + '$';
      return {source:row.source, ids, literals, ui:new Set(Array.isArray(row.ui)?row.ui:[]), regex:new RegExp(pattern), weight:literals.join('').length};
    }).filter(Boolean).sort((a,b) => b.weight-a.weight);
  }
  function fromTemplate(source, depth = 0) {
    if (source.length > 12000 || depth > 3) return null;
    for (const template of templates) {
      const match = template.regex.exec(source.trim()); if (!match) continue;
      const captures = new Map(); let consistent = true;
      template.ids.forEach((id,index) => {if(captures.has(id)&&captures.get(id)!==match[index+1])consistent=false;captures.set(id,match[index+1]);});
      if (!consistent) continue;
      const value = id => {
        const captured = captures.get(id) || '';
        if (!template.ui.has(id)) return captured;
        if (dictionary.has(normalize(captured))) return exact(captured);
        return fromTemplate(captured, depth + 1) ?? fragments(captured) ?? captured;
      };
      const full = dictionary.get(normalize(template.source));
      const translated = typeof full === 'string'
        ? full.replace(/\{(\d{1,2})\}/g, (_,id) => value(Number(id)))
        : template.literals.map((literal,index) => exact(literal)+(index<template.ids.length?value(template.ids[index]):'')).join('');
      return preserveSpace(source, translated.trim());
    }
    return null;
  }
  function fragments(source) {
    // Only numeric/punctuation combinations may be assembled from translated UI phrases.
    // Unknown words, protected names and filenames never undergo substring replacement.
    if (!fragmentPattern || source.length > 1000 || !/\d/.test(source)) return null;
    const protectedRanges = [];
    for (const value of protectedValues) {
      if (value.length < 2) continue;
      let at = source.indexOf(value);
      while (at >= 0) {protectedRanges.push([at,at+value.length]);at=source.indexOf(value,at+value.length);}
    }
    fragmentPattern.lastIndex = 0;
    const parts = []; let cursor = 0, matched = false, match;
    while ((match = fragmentPattern.exec(source))) {
      const at = match.index, end = at + match[0].length;
      if (/[\p{L}\p{N}_]/u.test(source[at-1] || '') || /[\p{L}\p{N}_]/u.test(source[end] || '')) continue;
      if (protectedRanges.some(([a,b]) => at < b && end > a)) continue;
      const gap = source.slice(cursor,at);
      if (!/^[\s\p{N}\p{P}\p{S}]*$/u.test(gap)) return null;
      parts.push(gap, exact(match[0])); cursor=end; matched=true;
    }
    const tail = source.slice(cursor);
    return matched && /^[\s\p{N}\p{P}\p{S}]*$/u.test(tail) ? parts.join('')+tail : null;
  }
  function translate(source) {
    source = String(source ?? '');
    if (locale === 'en' || !source.trim()) return source;
    if (renderedCache.has(source)) return renderedCache.get(source);
    let translated = exact(source);
    if (translated === source && !dictionary.has(normalize(source))) translated = fromTemplate(source) ?? fragments(source) ?? source;
    if (translated === source && !dictionary.has(normalize(source)) && missing.size < 500) missing.add(normalize(source));
    if (translated !== source) remember(origins,translated,source);
    remember(renderedCache,source,translated);
    return translated;
  }
  function format(template, ...values) {
    const original = String(template).replace(/\{(\d{1,2})\}/g, (_,id) => String(values[Number(id)] ?? ''));
    const translatedTemplate = dictionary.get(normalize(template));
    const translated = typeof translatedTemplate === 'string' && locale !== 'en'
      ? translatedTemplate.replace(/\{(\d{1,2})\}/g, (_,id) => String(values[Number(id)] ?? ''))
      : translate(original);
    if (translated !== original) remember(origins,translated,original);
    return translated;
  }
  const isProtected = element => !!element?.closest(PROTECTED);
  function textNode(node) {
    const parent = node.parentElement;
    if (!parent || isProtected(parent) || parent.closest(TEXT_BLOCKED) || !node.data.trim()) return;
    let record = textRecords.get(node);
    if (!record || node.data !== record.last) record = {original:origins.get(node.data) || node.data, last:node.data};
    const translated = translate(record.original);
    record.last=translated; textRecords.set(node,record);
    if (node.data !== translated) node.data=translated;
  }
  function attributes(element) {
    if (isProtected(element)) return;
    let records = attributeRecords.get(element);
    if (!records) {records=new Map();attributeRecords.set(element,records);}
    for (const name of ATTRIBUTES) {
      if (name === 'label' && element.tagName !== 'OPTGROUP') continue;
      if (!element.hasAttribute(name)) {records.delete(name);continue;}
      const value=element.getAttribute(name); let record=records.get(name);
      if (!record || value!==record.last) record={original:origins.get(value)||value,last:value};
      const translated=translate(record.original);record.last=translated;records.set(name,record);
      if (value!==translated) element.setAttribute(name,translated);
    }
  }
  function walk(root) {
    if (!root) return;
    const stack=[root];
    while (stack.length) {
      const node=stack.pop();
      if (node.nodeType===Node.TEXT_NODE) {textNode(node);continue;}
      if (node.nodeType!==Node.ELEMENT_NODE && node.nodeType!==Node.DOCUMENT_FRAGMENT_NODE && node.nodeType!==Node.DOCUMENT_NODE) continue;
      if (node instanceof Element) {
        if(isProtected(node)) continue;
        // Translation must never change the implicit value of a select option.
        if(node.tagName==='OPTION'&&!node.hasAttribute('value'))node.setAttribute('value',node.value);
        attributes(node);
        if(CHILDREN_BLOCKED.has(node.tagName))continue;
      }
      for(let i=node.childNodes.length-1;i>=0;i--)stack.push(node.childNodes[i]);
    }
  }
  function restoreProtected(root) {
    const stack=[root];
    while(stack.length){const node=stack.pop();
      if(node.nodeType===Node.TEXT_NODE){const record=textRecords.get(node);if(record&&node.data===record.last){node.data=record.original;record.last=record.original;}continue;}
      if(node instanceof Element){const records=attributeRecords.get(node);for(const [name,record] of records||[]){if(node.getAttribute(name)===record.last){node.setAttribute(name,record.original);record.last=record.original;}}}
      for(const child of node.childNodes||[])stack.push(child);
    }
  }
  function flush() {
    scheduled=false;const nodes=[...pendingNodes];pendingNodes.clear();
    for(const node of nodes){if(!node.isConnected)continue;if(nodes.some(parent=>parent!==node&&parent.contains?.(node)))continue;walk(node);}
  }
  function queue(node) {pendingNodes.add(node);if(!scheduled){scheduled=true;queueMicrotask(flush);}}
  const observer=new MutationObserver(changes=>{
    for(const change of changes){
      if(change.type==='characterData') {const record=textRecords.get(change.target);if(!record||change.target.data!==record.last)queue(change.target);}
      else if(change.type==='childList')for(const node of change.addedNodes){collectProtected(node);queue(node);}
      else if(change.attributeName==='translate'||change.attributeName==='data-i18n-skip'){
        if(isProtected(change.target)){restoreProtected(change.target);collectProtected(change.target);}else queue(change.target);
      }else{const record=attributeRecords.get(change.target)?.get(change.attributeName);if(!record||change.target.getAttribute(change.attributeName)!==record.last)queue(change.target);}
    }
  });
  function refresh(root=document.body) {collectProtected(root);renderedCache.clear();walk(root);}
  function reportError() {
    if(!status)return;
    status.textContent='Language could not be loaded. Try again.';status.hidden=false;walk(status);
  }
  async function json(url,signal) {
    const response=await fetch(url,{signal,cache:'no-cache'});
    if(!response.ok)throw new Error('Interface language file could not be loaded.');
    const text=await response.text();if(text.length>5*1024*1024)throw new Error('Interface language file is too large.');
    return JSON.parse(text);
  }
  async function setLocale(next, options = {}) {
    if(!LOCALES.includes(next))return false;
    const mine=++request;controller?.abort();controller=new AbortController();lastError=null;
    const activeController=controller, timeout=setTimeout(()=>activeController.abort(),12000);
    if(status){status.hidden=true;status.textContent='';}picker?.setAttribute('aria-busy','true');
    try{
      let catalog=catalogs.get(next), rows=templateSource, supplemental=supplementalSource;
      if(next!=='en'){
        const loaded=await Promise.all([catalog?catalog:json('./assets/locales/'+next+'.json',activeController.signal),rows||json('./assets/locales/templates.json',activeController.signal),supplemental||json('./assets/locales/supplemental.json',activeController.signal)]);
        supplemental=loaded[2];
        if(!supplemental||typeof supplemental!=='object'||Array.isArray(supplemental)||!supplemental[next]||typeof supplemental[next]!=='object'||Array.isArray(supplemental[next]))throw new Error('Invalid interface language supplement.');
        if(!(loaded[0] instanceof Map)){
          if(!loaded[0]||typeof loaded[0]!=='object'||Array.isArray(loaded[0]))throw new Error('Invalid interface language file.');
          catalog=new Map();for(const [key,value] of Object.entries(loaded[0]))if(typeof value==='string')catalog.set(normalize(key),value);
          if(!catalog.size)throw new Error('Empty interface language file.');
          for(const [key,value] of Object.entries(supplemental[next]))if(typeof value==='string')catalog.set(normalize(key),value);
        }else catalog=loaded[0];
        rows=loaded[1];
      }
      const compiled=next==='en'?[]:compileTemplates(rows);
      if(mine!==request)return false;
      if(next!=='en'){catalogs.set(next,catalog);templateSource=rows;supplementalSource=supplemental;}
      locale=next;dictionary=catalog||catalogs.get('en');templates=compiled;missing.clear();renderedCache.clear();
      const keys=[...dictionary.keys()].filter(key=>key.length>=3&&/[A-Za-z]/.test(key)&&!key.includes('{')).sort((a,b)=>b.length-a.length);
      fragmentPattern=keys.length?new RegExp(keys.map(escapeRegex).join('|'),'g'):null;
      document.documentElement.lang=locale;if(picker)picker.value=locale;
      if(options.persist!==false)try{localStorage.setItem(STORAGE_KEY,locale);}catch{}
      refresh();
      window.dispatchEvent(new CustomEvent('cerebellum-locale-change',{detail:{locale}}));
      return true;
    }catch(error){
      if(mine!==request)return false;
      lastError=error instanceof Error?error.message:String(error);if(picker)picker.value=locale;reportError();
      return false;
    }finally{clearTimeout(timeout);if(mine===request)picker?.removeAttribute('aria-busy');}
  }
  observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:[...ATTRIBUTES,'translate','data-i18n-skip']});
  document.addEventListener('input',event=>{if(event.target instanceof HTMLInputElement){collectProtected(event.target);renderedCache.clear();}},{passive:true});
  document.addEventListener('change',event=>{if(event.target instanceof HTMLInputElement){collectProtected(event.target);renderedCache.clear();}},{passive:true});
  picker?.addEventListener('change',()=>{void setLocale(picker.value);});
  let preference='en';try{const saved=localStorage.getItem(STORAGE_KEY);if(LOCALES.includes(saved))preference=saved;}catch{}
  // Loaded by boot.js only after English-dependent application initialization.
  const ready=Promise.resolve().then(()=>setLocale(preference,{persist:false}));
  window.CerebellumI18n=Object.freeze({setLocale,t:translate,format,protect,refresh,locales:LOCALES,storageKey:STORAGE_KEY,get locale(){return locale;},get ready(){return ready;},get lastError(){return lastError;},missing:()=>[...missing]});
  ready.then(()=>window.dispatchEvent(new CustomEvent('cerebellum-i18n-ready',{detail:{locale}})));
})();
