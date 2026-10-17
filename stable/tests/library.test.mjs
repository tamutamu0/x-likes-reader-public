import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {M,I,norm,src} from './helpers.mjs';
const L=createRequire(import.meta.url)('../public/js/core/library.js');
const now=Date.parse('2026-10-12T00:00:00Z');
function item(id,state,read,text='架空の投稿') { const it=M.makeItem(norm(src(id,{text})),'mock',now);Object.assign(it.user,{state,read});return it; }

test('new library keeps old later/kept/done records discoverable without rewriting personal data',()=>{
  const items=[item('1','inbox',false),item('2','later',false),item('3','kept',true),item('4','done',true)];
  const before=JSON.stringify(items);
  assert.equal(L.select(items,{view:'library'}).length,4);
  assert.deepEqual(L.select(items,{view:'likes'}).map(it=>it.id),['x:1','x:2']);
  assert.deepEqual(L.select(items,{view:'library',filter:'read'}).map(it=>it.id),['x:3','x:4']);
  assert.equal(JSON.stringify(items),before);
});
test('search spans all stock and notes, independent of active genre or read filter; feed order stays stable',()=>{
  const items=[item('1','inbox',false,'SQLite のバックアップ'),item('2','kept',true,'UI の余白')];
  items[1].user.memo='SQLite で実装したい';items[0].meta.xFeedOrder=2;items[1].meta.xFeedOrder=1;
  assert.deepEqual(L.select(items,{view:'library',filter:'unread',genre:'AI',genreOf:()=> '開発',query:'SQLite'}).map(it=>it.id),['x:2','x:1']);
  assert.equal(L.select(items,{view:'library',genre:'デザイン',genreOf:id=>id==='x:2' ? 'デザイン':'開発'}).length,1);
});
test('reading leaves one stable row for return navigation; group membership and library filters compose',()=>{
  const items=[item('1','inbox',true),item('2','inbox',false),item('3','kept',true)];
  assert.deepEqual(L.select(items,{view:'likes',sticky:'x:1'}).map(it=>it.id),['x:1','x:2']);
  assert.deepEqual(L.select(items,{view:'library',filter:'read',ids:['x:2','x:3']}).map(it=>it.id),['x:3']);
});
test('concrete topic membership composes with parent genre/read state, while global search still covers all stock',()=>{
  const items=[item('1','inbox',false,'NovelNotebook API'),item('2','kept',true,'NovelNotebook API'),item('3','inbox',false,'AnotherProduct API')];
  const analysis=I.analyze(items,{}),topic=analysis.topics.forGenre('開発').find(t=>t.key==='novelnotebook');
  assert.deepEqual(L.select(items,{view:'library',genre:'開発',genreOf:analysis.genreOf,ids:topic.ids,filter:'read'}).map(it=>it.id),['x:2']);
  assert.deepEqual(L.select(items,{view:'library',genre:'開発',genreOf:analysis.genreOf,ids:topic.ids,query:'AnotherProduct'}).map(it=>it.id),['x:3']);
});
test('X post links do not become article cards or same-article groups; shared articles cannot include merely related posts',()=>{
  const a=item('1','inbox',false,'sqlite wal 開発');const b=item('2','inbox',false,'sqlite wal 開発');const c=item('3','inbox',false,'sqlite wal 開発');
  a.src.links=[{url:'https://blog.example.org/guide',title:'ガイド'},{url:'https://x.com/fictional/status/123',title:'X'},{url:'https://blog.example.org/guide',title:'同じガイド'}];
  b.src.links=[{url:'https://blog.example.org/guide',title:'ガイド'}];c.src.links=[{url:'https://x.com/fictional/status/123',title:'X'}];
  const analysis=I.analyze([a,b,c],{}),articles=analysis.groups.filter(g=>g.kind==='article');
  assert.equal(articles.length,1);assert.deepEqual(articles[0].ids,['x:1','x:2']);
  assert.equal(I.isArticleLink({url:'https://twitter.com/fictional/status/123'}),false);
  assert.equal(I.isArticleLink({url:'https://blog.example.org/guide'}),true);
});
