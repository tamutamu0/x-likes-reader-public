import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {I,M,norm,src} from './helpers.mjs';
const T=createRequire(import.meta.url)('../public/js/core/topics.js');
function item(id,text,user={},extra={}) {
  const it=M.makeItem(norm(src(id,{text,...extra})),'mock',Date.parse('2026-10-12T00:00:00Z'));
  Object.assign(it.user,user);return it;
}

test('unknown names are discovered under their parent genre without adding a product dictionary',()=>{
  for (const name of ['Colab','OrbitNotebook','新星ノート']) {
    const items=[item('1',`${name} でモデルを評価する。`),item('2',`${name} のモデルを試した。`)];
    const before=JSON.stringify(items),a=I.analyze(items,{});
    const topic=a.topics.forGenre('AI').find(t=>t.key===T.keyOf(name));
    assert.ok(topic,name);assert.deepEqual(topic.ids,['x:1','x:2']);assert.equal(topic.count,2);
    assert.ok(topic.evidence('x:1').includes(name));assert.equal(JSON.stringify(items),before);
  }
});
test('topics are parent scoped, permit several concrete topics per post, and respect manual genres',()=>{
  const items=[item('1','NebulaDB と OrbitNotebook の API', {genre:'開発'}),item('2','NebulaDB のレイアウト',{genre:'デザイン'}),item('3','OrbitNotebook と NebulaDB の API',{genre:'開発'}),item('4','NebulaDB の行間',{genre:'デザイン'})];
  const a=I.analyze(items,{}),dev=a.topics.forGenre('開発').find(t=>t.key==='nebuladb'),design=a.topics.forGenre('デザイン').find(t=>t.key==='nebuladb');
  assert.ok(dev && design);assert.notEqual(dev.id,design.id);assert.deepEqual(dev.ids,['x:1','x:3']);assert.deepEqual(design.ids,['x:2','x:4']);
  assert.ok(a.topics.forItem('x:1').some(t=>t.key==='orbitnotebook'));
});
test('case and width variants coalesce, repeated text counts once, and related spellings do not match substrings',()=>{
  const items=[item('1','Colab Colab Colab モデル'),item('2','Ｃｏｌａｂ モデル'),item('3','Collaborate のモデル')];
  const a=I.analyze(items,{}),topic=a.topics.forGenre('AI').find(t=>t.key==='colab');
  assert.equal(topic.count,2);assert.deepEqual(topic.ids,['x:1','x:2']);assert.equal(topic.label,'Colab');
  const again=I.analyze(items.slice().reverse(),{}).topics.forGenre('AI').find(t=>t.key==='colab');
  assert.equal(topic.id,again.id);assert.equal(topic.label,again.label);
});
test('topic labels are concrete phrases; URLs, handles, category labels, and filler do not become topics',()=>{
  const a=I.analyze([item('1','Nimbus Studio。AIのモデル。今日これを紹介 https://unknown.example.org/SecretProduct @InvisibleAuthor'),item('2','Nimbus Studio。AIのモデル。今日これを紹介')],{});
  const topics=a.topics.forGenre('AI'),phrase=topics.find(t=>t.key==='nimbus studio');
  assert.ok(phrase);assert.equal(phrase.count,2);
  assert.ok(!topics.some(t=>['ai','モデル','今日','これ','紹介','secretproduct','invisibleauthor','nimbus'].includes(t.key)));
});
test('explicit Japanese tags and compounds form topics, while an isolated ordinary word is not a category',()=>{
  const items=[item('1','画像生成のモデル',{tags:['検索拡張生成']}),item('2','画像生成のモデル'),item('3','solitary のモデル')];
  const a=I.analyze(items,{}),topics=a.topics.forGenre('AI');
  assert.ok(topics.some(t=>t.key==='画像生成' && t.count===2));
  assert.ok(topics.some(t=>t.key==='検索拡張生成' && t.count===1));
  assert.ok(!topics.some(t=>t.key==='solitary'));
});
test('cached article titles may provide topics but failed articles and absent source do not; personal notes survive',()=>{
  const it=item('1','モデル',{memo:'OrbitNotebook の評価',links:[{url:'https://fixture.example.org/article',title:''}]});
  const other=item('2','モデル',{memo:'OrbitNotebook の評価',links:[{url:'https://fixture.example.org/article',title:''}]});
  const url='fixture.example.org/article',before=JSON.stringify(it);
  let a=I.analyze([it,other],{[url]:{status:'failed',title:'PrivateProduct'}});
  assert.ok(!a.topics.forItem(it.id).some(t=>t.key==='privateproduct'));
  a=I.analyze([it,other],{[url]:{status:'ok',title:'NebulaDB',text:''}});
  assert.ok(a.topics.forItem(it.id).some(t=>t.key==='nebuladb'));assert.equal(JSON.stringify(it),before);
  it.src.text='';it.user.genre='AI';
  assert.ok(I.analyze([it,other],{}).topics.forItem(it.id).some(t=>t.key==='orbitnotebook'));
});
test('stable IDs persist as the stock grows; stale memberships are recomputed rather than retained',()=>{
  const one=item('1','NebulaDB の API'),two=item('2','NebulaDB の API'),three=item('3','NebulaDB の API');
  const first=I.analyze([one,two],{}).topics.forGenre('開発').find(t=>t.key==='nebuladb');
  const updated=I.analyze([one,two,three],{}).topics.forGenre('開発').find(t=>t.key==='nebuladb');
  assert.equal(first.id,updated.id);assert.equal(updated.count,3);
  one.src.text='';const current=I.analyze([one,two,three],{}).topics.get(updated.id);
  assert.deepEqual(current.ids,['x:2','x:3']);assert.equal(current.evidence('x:1'),'');
});
