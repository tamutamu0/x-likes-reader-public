import test from 'node:test';
import assert from 'node:assert/strict';
import { M, B, R, newRepo, norm, src } from './helpers.mjs';
const NOW = Date.parse('2026-10-11T00:00:00Z');

test('再取得・重複統合：あなたの既読・あとで・タグ・メモ・ジャンルを保つ', async () => {
  const { repo } = newRepo();
  await repo.mergeFetched([{ src: norm(src('1')), likedAt: '2026-10-10T00:00:00Z', via: 'like' }], 'mock', NOW);
  await repo.patchUser('x:1', { read: false, tags: [], memo: '', genre: null }, { read: true, tags: ['残'], memo: 'メモ', genre: '開発' }, NOW);
  await repo.patchUser('x:1', { state: 'inbox', laterUntil: null }, M.verbPatch('later', NOW, '2026-10-12T08:00:00Z'), NOW);
  const r = await repo.mergeFetched([{ src: norm(src('1', { text: '本文が更新された' })), likedAt: '2026-10-10T00:00:00Z', via: 'like' }], 'mock', NOW + 1);
  assert.equal(r.merged, 1);
  assert.equal(r.knownLiked, 1);
  const it = (await repo.loadAll()).items[0];
  assert.equal(it.src.text, '本文が更新された');
  assert.deepEqual([it.user.read, it.user.tags, it.user.memo, it.user.genre, it.user.state, it.user.laterUntil], [true, ['残'], 'メモ', '開発', 'later', '2026-10-12T08:00:00.000Z']);
  assert.equal(it.meta.merged, 1);
});

test('手で追加：同じ投稿は 2 回入らない（twitter.com と x.com も同じ）', async () => {
  const { repo } = newRepo();
  assert.equal((await repo.addManual('https://twitter.com/fic/status/77?s=20', NOW)).status, 'added');
  assert.equal((await repo.addManual('https://x.com/fic/status/77', NOW)).status, 'exists');
  assert.equal((await repo.addManual('https://example.org/fic/status/77', NOW)).status, 'invalid');
  assert.equal((await repo.addManual('javascript:alert(1)', NOW)).status, 'invalid');
  const it = (await repo.loadAll()).items[0];
  assert.equal(it.meta.sources.like, true);
});

test('複数タブ：同じ項目を別々に変えると、あとから来た方は競合になる', async () => {
  const be = B.memoryBackend();
  const msgs = [];
  const chan = { postMessage: (m) => msgs.push(m) };
  const tabA = R.createRepo(be, { channel: chan, tabId: 'A' });
  const tabB = R.createRepo(be, { channel: chan, tabId: 'B' });
  await tabA.mergeFetched([{ src: norm(src('2')), via: 'like' }], 'mock', NOW);
  const a = await tabA.patchUser('x:2', { memo: '' }, { memo: 'A のメモ' }, NOW);
  assert.equal(a.status, 'ok');
  const b = await tabB.patchUser('x:2', { memo: '' }, { memo: 'B のメモ' }, NOW);
  assert.equal(b.status, 'conflict');
  assert.equal(b.item.user.memo, 'A のメモ', '最新の内容を返す');
  const c = await tabB.patchUser('x:2', { read: false }, { read: true }, NOW);
  assert.equal(c.status, 'ok', '違う項目なら通る');
  assert.equal(c.item.user.memo, 'A のメモ');
  assert.ok(msgs.some((m) => m.kind === 'items' && m.from === 'A' && m.ids.includes('x:2')), '他のタブへ知らせる');
  assert.ok(c.item.rev > a.item.rev);
});

test('保存の失敗：例外として返り、何も書かれない', async () => {
  const { be, repo } = newRepo();
  await repo.mergeFetched([{ src: norm(src('3')), via: 'like' }], 'mock', NOW);
  be.failNext = 1;
  await assert.rejects(repo.patchUser('x:3', { memo: '' }, { memo: '失敗するはず' }, NOW), (e) => e.code === 'write_failed');
  const it = (await repo.loadAll()).items[0];
  assert.equal(it.user.memo, '');
  be.failNext = 1;
  await assert.rejects(repo.mergeFetched([{ src: norm(src('4')), via: 'like' }, { src: norm(src('5')), via: 'like' }], 'mock', NOW));
  assert.equal((await repo.loadAll()).items.length, 1, '途中まで書かれたりしない');
});

test('あとでの期限：何度呼んでも 1 回だけ戻す', async () => {
  const { repo } = newRepo();
  await repo.mergeFetched([{ src: norm(src('6')), via: 'like' }], 'mock', NOW);
  await repo.patchUser('x:6', null, M.verbPatch('later', NOW, new Date(NOW + 60000).toISOString()), NOW);
  assert.deepEqual(await repo.promoteDue(NOW), []);
  assert.deepEqual(await repo.promoteDue(NOW + 60000), ['x:6']);
  assert.deepEqual(await repo.promoteDue(NOW + 120000), []);
  const it = (await repo.loadAll()).items[0];
  assert.equal(it.user.state, 'inbox');
  assert.equal(it.user.returned, true);
});

test('自動で消さない：取得元で見つからないいいねは印を付けるだけ', async () => {
  const { repo } = newRepo();
  await repo.mergeFetched([{ src: norm(src('7')), via: 'like' }, { src: norm(src('8')), via: 'like' }], 'mock', NOW);
  await repo.patchUser('x:7', { memo: '' }, { memo: '残してほしい' }, NOW);
  await repo.mergeFetched([{ src: norm(src('8')), via: 'like' }], 'mock', NOW + 10000);
  const n = await repo.markMissing('mock', new Date(NOW + 5000).toISOString(), NOW + 20000);
  assert.equal(n, 1);
  const all = (await repo.loadAll()).items;
  assert.equal(all.length, 2);
  const seven = all.find((x) => x.id === 'x:7');
  assert.equal(seven.meta.missing, true);
  assert.equal(seven.user.memo, '残してほしい');
  await repo.mergeFetched([{ src: norm(src('7')), via: 'like' }], 'mock', NOW + 30000);
  assert.equal((await repo.loadAll()).items.find((x) => x.id === 'x:7').meta.missing, false, 'また見つかれば印を外す');
});

test('架空データを取り除く：サンプルとモックだけ。手で追加したものは残る', async () => {
  const { repo } = newRepo();
  await repo.mergeFetched([{ src: norm(src('9')), via: 'like' }], 'mock', NOW);
  await repo.addManual('https://x.com/fic/status/10', NOW);
  const s = M.makeItem(norm(src('11')), 'sample', NOW);
  await repo.insertSample([s]);
  await repo.saveArticle({ key: 'dev.example/a', status: 'sample', title: 't' });
  await repo.saveArticle({ key: 'real.example.org/a', status: 'ok', title: 't' });
  const r = await repo.removeFictional();
  assert.equal(r.removed, 2);
  const left = await repo.loadAll();
  assert.deepEqual(left.items.map((x) => x.id), ['x:10']);
  assert.deepEqual(Object.keys(left.articles), ['real.example.org/a']);
  await assert.rejects(repo.insertSample([M.makeItem(norm(src('12')), 'manual', NOW)]), /sample only/);
});

test('壊れた記録があっても読み込みは止まらない（消さずに数える）', async () => {
  const { be, repo } = newRepo();
  await repo.mergeFetched([{ src: norm(src('13')), via: 'like' }], 'mock', NOW);
  be.data.items.set('broken', { id: 'broken', src: null });
  const r = await repo.loadAll();
  assert.equal(r.items.length, 1);
  assert.equal(r.broken, 1);
  assert.ok(be.data.items.has('broken'), '読めないものも勝手に消さない');
});
