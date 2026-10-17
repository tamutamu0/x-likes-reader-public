import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { J, S, M, newRepo, norm, src } from './helpers.mjs';
// ここで読むのはこのフォルダの架空 fixture だけ（実データ・旧版のファイルは使わない）
const items = fs.readFileSync(new URL('./fixtures/margin-items.fictional.json', import.meta.url), 'utf8');
const backup = fs.readFileSync(new URL('./fixtures/backup.fictional.json', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-11T00:00:00Z');

test('バックアップは未編集の取得済み投稿へ既読とメモを復元し、確認後の編集と取り消し後の編集を保護する', async () => {
  const {repo} = newRepo();
  const source = norm(src('987001'));
  await repo.mergeFetched([{src:source,via:'like'}],'mock',NOW);
  const record = (await repo.loadAll()).items[0];
  const restored = {...M.defaultUser(),read:true,memo:'架空の移行メモ',editedAt:new Date(NOW-1000).toISOString()};
  const parsed = await J.parseImport(J.serialize({format:'margin-backup',version:1,items:[{src:source,user:restored,meta:{origin:'mock'}}]}),{now:NOW});
  const stale = await repo.planImport(parsed,NOW,'stale-user');
  assert.equal(stale.userRestored,1);
  await repo.patchUser(record.id,{memo:''},{memo:'移行先で書いたメモ'},NOW+1);
  await assert.rejects(repo.applyImport(stale,NOW+2),e=>e.code==='import_conflict');
  const preserved = await repo.planImport(parsed,NOW+3,'keep-user');
  assert.equal(preserved.userRestored,0); assert.equal(preserved.userKept,1);
  const fresh = newRepo().repo;
  await fresh.mergeFetched([{src:source,via:'like'}],'mock',NOW);
  const before=(await fresh.loadAll()).items[0];
  const plan=await fresh.planImport(parsed,NOW+4,'restore-user');
  await fresh.applyImport(plan,NOW+4);
  const after=(await fresh.loadAll()).items[0];
  assert.equal(after.user.memo,restored.memo);assert.equal(after.user.read,true);
  assert.equal(after.meta.fetchedAt,before.meta.fetchedAt,'編集だけの復元で本文の有効期限を延ばさない');
  await fresh.patchUser(after.id,{memo:restored.memo},{memo:'復元後の本人編集'},NOW+5);
  await fresh.undoImport('restore-user',NOW+6);
  assert.equal((await fresh.loadAll()).items[0].user.memo,'復元後の本人編集');
});

test('取り込み：危険な URL・秘密のキー・重複・壊れた ID を弾き、理由を返す', async () => {
  const r = await J.parseImport(items, { now: NOW });
  assert.equal(r.format, 'margin-items');
  assert.equal(r.stats.total, 6);
  assert.equal(r.stats.accepted, 3);
  assert.deepEqual(r.rejected.map((x) => x.reason).sort(), ['duplicate_in_file', 'not_x_post', 'unsafe_id']);
  assert.ok(r.stats.secretKeys >= 2, '秘密のキーを数える');
  const a = r.entries[0];
  assert.equal(a.src.links.length, 1, 'javascript: のリンクは落とす');
  assert.ok(!/SECRET|auth_token/.test(a.src.links[0].url));
  assert.match(a.src.text, /<img src=x onerror=alert\(1\)>/, 'HTML は文字として残る（画面では textContent で表示）');
  const b = r.entries[1];
  assert.ok(!('cookie' in b.src) && !('authorization' in b.src) && !JSON.stringify(b).includes('SECRET'), '秘密の値は運ばない');
  assert.match(b.src.text, /無視して/, '注入文はただの文字');
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).polluted2, undefined);
});

test('取り込み：大きさ・件数・形式・JSON の誤り', async () => {
  await assert.rejects(J.parseImport('x'.repeat(2000), { maxBytes: 1000 }), (e) => e.code === 'too_large');
  await assert.rejects(J.parseImport('{', {}), (e) => e.code === 'invalid_json');
  await assert.rejects(J.parseImport('[1,2]', {}), (e) => e.code === 'unknown_format');
  await assert.rejects(J.parseImport(JSON.stringify({ format: 'old-app', version: 1, items: [] })), (e) => e.code === 'unknown_format', '旧版の形式は推測しない');
  const many = JSON.stringify({ format: 'margin-items', version: 1, items: Array.from({ length: 11 }, (_, i) => ({ postId: String(i + 1) })) });
  await assert.rejects(J.parseImport(many, { maxItems: 10 }), (e) => e.code === 'too_many');
  // 多バイト文字はバイト数で数える
  await assert.rejects(J.parseImport('"' + 'あ'.repeat(400) + '"', { maxBytes: 1000 }), (e) => e.code === 'too_large');
});

test('取り込み：途中で中止できる（何も返さない）', async () => {
  const big = JSON.stringify({ format: 'margin-items', version: 1, items: Array.from({ length: 3000 }, (_, i) => ({ postId: String(i + 1), text: 't' })) });
  const ac = new AbortController();
  const p = J.parseImport(big, { signal: ac.signal, onProgress: (d) => { if (d >= 500) ac.abort(); } });
  await assert.rejects(p, (e) => e.code === 'aborted');
  const ac2 = new AbortController(); ac2.abort();
  await assert.rejects(J.parseImport(items, { signal: ac2.signal }), (e) => e.code === 'aborted');
});

test('バックアップ：書き出して読み戻すと、あなたの編集がそのまま戻る（架空データで検証）', async () => {
  const { repo } = newRepo();
  await repo.mergeFetched([{ src: norm(src('900')), likedAt: '2026-10-01T00:00:00Z', via: 'like' }], 'mock', NOW);
  await repo.patchUser('x:900', { tags: [], memo: '' }, { tags: ['保存'], memo: '戻ってくる？' }, NOW);
  const b = await repo.buildBackup(NOW);
  const text = J.serialize(b);
  assert.equal(b.format, 'margin-backup');
  assert.equal(b.count, 1);
  const parsed = await J.parseImport(text, { now: NOW });
  assert.deepEqual(parsed.entries[0].user.tags, ['保存']);
  assert.equal(parsed.entries[0].user.memo, '戻ってくる？');
  assert.equal(parsed.entries[0].origin, 'mock', '架空データは架空のまま戻る');
});

test('取り込みの計画・反映・取り消し：既存の編集は上書きしない', async () => {
  const { repo } = newRepo();
  // 既存の 1 件（あなたの編集あり）と同じ ID をバックアップが持っている
  await repo.mergeFetched([{ src: norm(src('8100000000000000001', { author: { name: '架空ガンマ', handle: 'fic_gamma' }, text: '古い本文' })), via: 'like' }], 'mock', NOW);
  await repo.patchUser('x:8100000000000000001', { memo: '' }, { memo: '手元のメモ' }, NOW);
  const parsed = await J.parseImport(backup, { now: NOW });
  assert.equal(parsed.entries[1].user.state, 'inbox', '壊れた user は既定値で受ける');
  assert.deepEqual(parsed.entries[1].user.tags, []);
  assert.equal(parsed.entries[1].origin, 'import', '知らない origin は import として扱う');
  const plan = await repo.planImport(parsed, NOW, 'batch-1');
  assert.equal(plan.add.length, 1);
  assert.equal(plan.updateSrc.length, 1);
  assert.equal(plan.userKept, 1);
  const batch = await repo.applyImport(plan, NOW);
  let all = (await repo.loadAll()).items;
  const kept = all.find((x) => x.id === 'x:8100000000000000001');
  assert.equal(kept.user.memo, '手元のメモ', 'あなたの編集はそのまま');
  assert.equal(kept.src.text, 'バックアップの架空データ');
  await assert.rejects(repo.applyImport(plan, NOW), /already/);
  const u = await repo.undoImport(batch.id, NOW);
  assert.equal(u.status, 'ok');
  all = (await repo.loadAll()).items;
  assert.equal(all.length, 1, '追加分は取り消しで取り除く');
  assert.equal(all[0].src.text, '古い本文', '更新した本文は元に戻す');
  assert.equal(all[0].user.memo, '手元のメモ');
});

test('取り消し：取り込み後にあなたが触った投稿は残す', async () => {
  const { repo } = newRepo();
  const parsed = await J.parseImport(items, { now: NOW });
  const plan = await repo.planImport(parsed, NOW, 'b2');
  await repo.applyImport(plan, NOW);
  await repo.patchUser('x:8000000000000000002', { read: false }, { read: true }, NOW);
  const u = await repo.undoImport('b2', NOW);
  assert.deepEqual(u.keptEdited, ['x:8000000000000000002']);
  assert.equal(u.removed.length, 2);
});

test('明示承認済みのローカルJSONゲートは固定設定から有効になる', async () => {
  const { Approvals } = await import('./helpers.mjs');
  assert.equal(Approvals.jsonFileIO, true);
  assert.equal(Object.isFrozen(Approvals), true);
});

test('取り込み確認後に元投稿が更新されても新しい内容を上書きせず、追加もロールバックする', async () => {
  const { repo } = newRepo();
  const id = '8600000000000000001';
  await repo.mergeFetched([{ src: norm(src(id, { text: '確認前' })), via: 'like' }], 'mock', NOW);
  const parsed = await J.parseImport(JSON.stringify({ format: 'margin-items', version: 1, items: [src(id, { text: 'ファイルの内容' }), src('8600000000000000002')] }), { now: NOW });
  const plan = await repo.planImport(parsed, NOW, 'concurrent-source');
  await repo.mergeFetched([{ src: norm(src(id, { text: '確認後の新しい内容' })), via: 'like' }], 'mock', NOW + 1);
  await assert.rejects(repo.applyImport(plan, NOW + 2), (e) => e.code === 'import_conflict');
  const all = (await repo.loadAll()).items;
  assert.equal(all.length, 1);
  assert.equal(all[0].src.text, '確認後の新しい内容');
});

test('確認後のメモ編集は保持して反映し、別タブが追加した投稿を取り消し対象に含めない', async () => {
  const { repo } = newRepo();
  const id = '8700000000000000001', other = '8700000000000000002';
  await repo.mergeFetched([{ src: norm(src(id, { text: '確認前' })), via: 'like' }], 'mock', NOW);
  const parsed = await J.parseImport(JSON.stringify({ format: 'margin-items', version: 1, items: [src(id, { text: 'ファイルの内容' }), src(other)] }), { now: NOW });
  const plan = await repo.planImport(parsed, NOW, 'concurrent-user');
  await repo.patchUser('x:' + id, { memo: '' }, { memo: '確認後のメモ' }, NOW + 1);
  await repo.addManual('https://x.com/fic_user/status/' + other, NOW + 1);
  const applied = await repo.applyImport(plan, NOW + 2);
  assert.deepEqual(applied.added, []);
  assert.equal((await repo.getItems(['x:' + id]))[0].user.memo, '確認後のメモ');
  const undone = await repo.undoImport(applied.id, NOW + 3);
  assert.deepEqual(undone.removed, []);
  assert.deepEqual(undone.keptEdited, []);
  assert.equal((await repo.loadAll()).items.length, 2);
});
