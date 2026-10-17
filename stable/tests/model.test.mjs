import test from 'node:test';
import assert from 'node:assert/strict';
import { M, src, norm } from './helpers.mjs';
const NOW = Date.parse('2026-10-11T00:00:00Z');
test('リンクプレビュー用の見出し・説明を保ち、危険な画像 URL は落とす',()=>{
  const n=M.normalizeSrc(src('90',{links:[{url:'https://example.org/article',title:'記事',description:'説明',imageUrl:'javascript:bad'}]}),NOW);
  assert.equal(n.src.links[0].description,'説明');assert.equal(n.src.links[0].imageUrl,undefined);
});

test('取得元の値の検査：ID の不一致・危険な画像 URL・引用・返信先', () => {
  assert.equal(M.normalizeSrc(src('1', { url: 'https://x.com/a/status/2' }), NOW).reason, 'id_mismatch');
  assert.equal(M.normalizeSrc({ postId: 12345678901234567890 }, NOW).reason, 'unsafe_id');
  assert.equal(M.normalizeSrc({ url: 'https://example.org/a' }, NOW).reason, 'not_x_post');
  const n = M.normalizeSrc(src('5', { media: [{ url: 'javascript:1' }, { url: 'https://pbs.twimg.com/media/a.jpg', w: 10, h: 10 }, { local: '/samples/media/desk.svg' }], quote: src('6'), replyTo: { postId: '4', handle: 'fic_user' } }), NOW);
  assert.equal(n.ok, true);
  assert.equal(n.src.media.length, 1, 'javascript: と、許可のない local は落とす');
  assert.equal(n.src.quote.postId, '6');
  assert.equal(n.src.replyTo.postId, '4');
  const withLocal = M.normalizeSrc(src('7', { media: [{ local: '/samples/media/desk.svg' }, { local: '/samples/../server.mjs' }] }), NOW, { allowLocalMedia: true });
  assert.equal(withLocal.src.media.length, 1);
});

test('再取得の統合は src だけを変え、user には触れない', () => {
  const rec = M.makeItem(norm(src('10')), 'mock', NOW);
  rec.user = Object.assign(rec.user, { state: 'kept', read: true, tags: ['開発'], memo: '大事', genre: 'AI' });
  const before = JSON.stringify(rec.user);
  const m = M.mergeSrc(rec, norm(src('10', { text: '追記された本文' })), NOW + 1000);
  assert.equal(m.changed, true);
  assert.equal(m.record.src.text, '追記された本文');
  assert.equal(JSON.stringify(m.record.user), before);
  assert.equal(m.record.meta.merged, 1);
  const m2 = M.mergeSrc(m.record, norm(src('10', { text: '' })), NOW + 2000);
  assert.equal(m2.record.src.text, '追記された本文', '空の値で既存を消さない');
});

test('競合の検出：画面が見ていた値と違えば競合', () => {
  const rec = M.makeItem(norm(src('11')), 'manual', NOW);
  const a = M.applyPatch(rec, { memo: '' }, { memo: 'A' }, NOW);
  assert.equal(a.ok, true);
  const b = M.applyPatch(a.record, { memo: '' }, { memo: 'B' }, NOW);
  assert.equal(b.conflict, true);
  assert.deepEqual(b.fields, ['memo']);
  const c = M.applyPatch(a.record, { read: false }, { read: true }, NOW);
  assert.equal(c.ok, true, '別の項目なら競合しない');
  assert.equal(c.record.user.memo, 'A');
});

test('編集の検査：変えてよい項目だけ・値の形', () => {
  const rec = M.makeItem(norm(src('12')), 'manual', NOW);
  assert.throws(() => M.applyPatch(rec, null, { src: {} }, NOW));
  assert.throws(() => M.applyPatch(rec, null, { state: 'deleted' }, NOW));
  assert.throws(() => M.applyPatch(rec, null, { state: 'later' }, NOW), /date/);
  assert.throws(() => M.applyPatch(rec, null, { tags: Array.from({ length: 13 }, (_, i) => 't' + i) }, NOW));
  const r = M.applyPatch(rec, null, { tags: ['#開発', '開発', ' a b '], genre: ' 自作 ジャンル ' }, NOW);
  assert.deepEqual(r.record.user.tags, ['開発', 'ab']);
  assert.equal(r.record.user.genre, '自作ジャンル');
});

test('あとでの期限：来たら読むに戻し、印を付ける', () => {
  const rec = M.makeItem(norm(src('13')), 'manual', NOW);
  const later = M.applyPatch(rec, null, M.verbPatch('later', NOW, new Date(NOW + 1000).toISOString()), NOW).record;
  assert.equal(M.promote(later, NOW), null);
  const p = M.promote(later, NOW + 1000);
  assert.equal(p.user.state, 'inbox');
  assert.equal(p.user.returned, true);
  assert.equal(p.user.laterUntil, null);
});

test('済み（done）は戻せる（読むにも残すにも）', () => {
  const rec = M.makeItem(norm(src('14')), 'manual', NOW);
  const done = M.applyPatch(rec, null, M.verbPatch('done', NOW), NOW).record;
  assert.equal(done.user.state, 'done');
  assert.equal(M.applyPatch(done, null, M.verbPatch('inbox', NOW), NOW).record.user.state, 'inbox');
  assert.equal(M.applyPatch(done, null, M.verbPatch('keep', NOW), NOW).record.user.state, 'kept');
});

test('検索：本文・タグ・メモ・引用・@', () => {
  const rec = M.makeItem(norm(src('15', { text: 'SQLite の話', quote: src('16', { text: '引用の中身' }) })), 'manual', NOW);
  rec.user.tags = ['開発']; rec.user.memo = 'あとで試す';
  assert.equal(M.matches(rec, M.parseQuery('sqlite')), true);
  assert.equal(M.matches(rec, M.parseQuery('#開発')), true);
  assert.equal(M.matches(rec, M.parseQuery('#デザイン')), false);
  assert.equal(M.matches(rec, M.parseQuery('試す')), true);
  assert.equal(M.matches(rec, M.parseQuery('引用の中身')), true);
});
