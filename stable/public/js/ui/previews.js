/* Visible cards only. Same-origin owner API; external images never loaded by browser. */
(function(root){
  'use strict';
  var G=root.Margin, h=G.dom.h, cache=new Map(), images=new Map(), jobs=[], active=0;
  var targets=new WeakMap();
  function draw(el,link,r){
    if(!el.isConnected)return;
    var title=el.querySelector('.c-title'),description=el.querySelector('.c-desc');
    if(r.title){title.textContent=r.title;el.setAttribute('aria-label','リンク：'+r.title);}
    description.textContent=r.description || link.description || '';
    description.hidden=!description.textContent;
    if(r.imagePath && /^\/api\/link-preview\/[a-f0-9]{64}\/image$/.test(r.imagePath)) {
      var promise=images.get(r.imagePath);
      if(!promise){promise=G.net.previewImage(r.imagePath).then(function(blob){return blob?URL.createObjectURL(blob):null;}).catch(function(){return null;});images.set(r.imagePath,promise);
        if(images.size>80){var first=images.keys().next().value;images.get(first).then(function(u){if(u)URL.revokeObjectURL(u);});images.delete(first);}}
      promise.then(function(src){if(!src || !el.isConnected)return;
        var thumb=el.querySelector('.thumb'),img=h('img',{src:src,alt:'',decoding:'async',loading:'lazy'});thumb.textContent='';
        img.addEventListener('error',function(){thumb.textContent=(link.domain.charAt(0)||'·').toUpperCase();el.classList.remove('has-image');},{once:true});
        thumb.appendChild(img);
        el.classList.add('has-image');
      });
    }
  }
  function pump(){
    if(active>=2 || !jobs.length)return;
    var job=jobs.shift();
    if(!job.el.isConnected){pump();return;}
    active++;
    var promise=cache.get(job.link.url);
    if(!promise){promise=G.net.fetchPreview(job.it.src.postId,job.link.url).catch(function(){return {};});cache.set(job.link.url,promise);if(cache.size>80)cache.delete(cache.keys().next().value);}
    promise.then(function(r){draw(job.el,job.link,r);}).finally(function(){active--;pump();});pump();
  }
  var observer=typeof IntersectionObserver==='function'?new IntersectionObserver(function(entries){
    entries.forEach(function(e){if(!e.isIntersecting)return;observer.unobserve(e.target);var job=targets.get(e.target);if(job){jobs.push(job);pump();}});
  },{rootMargin:'80px'}):null;
  function attach(el,A,it,link){
    // Local/sample mode keeps its existing explicit-fetch behavior.
    if(!A.state.server || !A.state.server.linkPreview || !(it.meta.sources && it.meta.sources.xapi))return;
    var job={el:el,it:it,link:link};targets.set(el,job);
    requestAnimationFrame(function(){if(!el.isConnected)return;if(observer)observer.observe(el);else{jobs.push(job);pump();}});
  }
  // Render replaces cards, so stop observing detached nodes after each render.
  if(typeof MutationObserver==='function')new MutationObserver(function(changes){
    if(!observer)return;changes.forEach(function(c){c.removedNodes.forEach(function(n){
      if(n.nodeType!==1)return;if(n.matches('.card'))observer.unobserve(n);
      n.querySelectorAll('.card').forEach(function(card){observer.unobserve(card);});
    });});
  }).observe(document.body,{childList:true,subtree:true});
  root.addEventListener('pagehide',function(e){if(!e.persisted)images.forEach(function(p){p.then(function(u){if(u)URL.revokeObjectURL(u);});});});
  G.previews={attach:attach};
})(typeof globalThis!=='undefined'?globalThis:this);
