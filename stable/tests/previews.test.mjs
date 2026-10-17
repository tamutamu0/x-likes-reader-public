import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('visible X API cards fetch once per URL; manual/sample cards never trigger requests',async()=>{
  let visible,calls=0;const observed=[];
  const context={Map,WeakMap,Promise,requestAnimationFrame:fn=>fn(),addEventListener(){},document:{body:{}},
    IntersectionObserver:class {constructor(fn){visible=fn;}observe(el){observed.push(el);}unobserve(){}},
    Margin:{dom:{h(){}},net:{async fetchPreview(id,url){calls++;assert.equal(id,'123');assert.equal(url,'https://www.python.org/fixture');return {title:'安全な見出し',description:'<script>文字として表示</script>'};}}}};
  vm.runInNewContext(readFileSync(new URL('../public/js/ui/previews.js',import.meta.url),'utf8'),context);
  const title={textContent:''},description={textContent:''};
  const card=()=>({isConnected:true,querySelector:s=>s==='.c-title'?title:description,setAttribute(key,value){this[key]=value;}});
  const A={state:{server:{linkPreview:true}}},link={url:'https://www.python.org/fixture'},it={src:{postId:'123'},meta:{origin:'import',sources:{xapi:true}}};
  const a=card(),b=card();context.Margin.previews.attach(a,A,it,link);context.Margin.previews.attach(b,A,it,link);
  context.Margin.previews.attach(card(),A,{...it,meta:{origin:'manual',sources:{like:true}}},link);
  assert.equal(observed.length,2);assert.equal(calls,0);
  visible(observed.map(target=>({target,isIntersecting:true})));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);assert.equal(title.textContent,'安全な見出し');assert.equal(description.textContent,'<script>文字として表示</script>');
  assert.equal(a['aria-label'],'リンク：安全な見出し');
});
