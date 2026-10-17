import test from 'node:test';
import assert from 'node:assert/strict';
import { C, S, Mock, X, newRepo } from './helpers.mjs';
const H = 3600e3;

function setup(scenario, start) {
  const { be, repo } = newRepo();
  const clock = { t: start || Date.parse('2026-10-11T00:00:00Z') };
  const epoch = clock.t;
  const mk = (sc) => Mock.create({ epoch, now: () => clock.t, scenario: sc || scenario });
  const run = (sc, extra) => C.run(Object.assign({ repo: repo.collector, transport: mk(sc), now: () => clock.t, owner: 'tab-1', fullCheck: !!(Mock.SCENARIOS[sc || scenario].fullCheck) }, extra || {}));
  return { be, repo, clock, run };
}

test('通常：最後まで取得し、成功時刻と範囲を残し、6 時間は次を始めない', async () => {
  const t = setup('ok');
  const r = await t.run();
  assert.equal(r.outcome, 'complete');
  assert.equal((await t.repo.loadAll()).items.length, 14);
  const st = await t.repo.getSource('mock');
  assert.ok(st.lastSuccessAt);
  assert.equal(st.lastRun.partial, false);
  assert.ok(st.lastRun.range.from < st.lastRun.range.to);
  assert.equal(st.lease, null);
  t.clock.t += 5 * H;
  const r2 = await t.run();
  assert.equal(r2.refused, 'interval');
  t.clock.t += 1 * H;
  const r3 = await t.run();
  assert.equal(r3.outcome, 'complete');
  const st3 = await t.repo.getSource('mock');
  assert.equal(st3.lastRun.added, 3, '差分：新しい 3 件だけ');
  assert.equal(st3.lastRun.pages, 1, '取り込み済みのいいねに届いたら止まる');
});

test('ページ上限：5 ページで止め、続きの位置を覚え、最後の成功は更新しない', async () => {
  const t = setup('many');
  const r = await t.run();
  assert.equal(r.outcome, 'page_limit');
  let st = await t.repo.getSource('mock');
  assert.equal(st.lastRun.pages, S.LIMITS.pagesPerRun);
  assert.ok(st.cursor);
  assert.equal(st.lastSuccessAt, null);
  assert.equal((await t.repo.loadAll()).items.length, 10, '部分取得の分は保存');
  t.clock.t += 6 * H;
  const r2 = await t.run();
  assert.equal(r2.outcome, 'complete');
  st = await t.repo.getSource('mock');
  assert.equal(st.cursor, null);
  assert.ok(st.lastSuccessAt);
  assert.equal((await t.repo.loadAll()).items.length >= 14, true);
});

test('429：Retry-After と指数の待ちの長い方まで次を始めない', async () => {
  const t = setup('r429');
  const r = await t.run();
  assert.equal(r.outcome, 'rate_limited');
  let st = await t.repo.getSource('mock');
  assert.equal(st.consecutive429, 1);
  const wait1 = Date.parse(st.nextAllowedAt) - t.clock.t;
  assert.equal(wait1, Math.max(6 * H, 32400e3), 'Retry-After 9 時間を守る');
  assert.ok(st.cursor, '続きの位置は残す');
  assert.equal(st.lastSuccessAt, null);
  t.clock.t += wait1;
  await t.run();
  st = await t.repo.getSource('mock');
  assert.equal(st.consecutive429, 2);
  assert.equal(Date.parse(st.nextAllowedAt) - t.clock.t, 12 * H, '2 回目は 12 時間');
  assert.equal(C.backoffMs(10, 0), S.LIMITS.backoffCapMs, '上限 48 時間');
  assert.equal(C.parseRetryAfter('120', 0), 120000);
  assert.equal(C.parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('2026-10-21T07:27:00Z')), 60000);
  assert.equal(C.parseRetryAfter('soon', 0), null);
});

test('429（Retry-After なし）：指数の待ち', async () => {
  const t = setup('r429n');
  await t.run();
  const st = await t.repo.getSource('mock');
  assert.equal(Date.parse(st.nextAllowedAt) - t.clock.t, 6 * H);
});

for (const [sc, reason] of [['a401', 'auth_401'], ['f403', 'forbidden_403'], ['chal', 'challenge']]) {
  test(sc + '：その場で止まり、停止スイッチがオンになる。再開は手動', async () => {
    const t = setup(sc);
    const r = await t.run();
    assert.equal(r.outcome, reason);
    const c = await t.repo.getControl();
    assert.equal(c.stopped, true);
    assert.equal(c.reason, reason);
    assert.equal((await t.repo.loadAll()).items.length, 0);
    t.clock.t += 100 * H;
    assert.equal((await t.run('ok')).refused, 'stopped');
    await t.repo.setStopped(false, null, t.clock.t);
    assert.ok(['complete', 'page_limit'].includes((await t.run('ok')).outcome), '手動で再開すれば動く');
  });
}

test('停止スイッチ：実行中にオンになったら次のページを取りに行かない', async () => {
  const t = setup('many');
  let pages = 0;
  const transport = Mock.create({ epoch: t.clock.t, now: () => t.clock.t, scenario: 'many' });
  const wrapped = { id: 'mock', fictional: true, connected: true, fetchPage: async (req) => { pages++; if (pages === 2) await t.repo.setStopped(true, 'manual', t.clock.t); return transport.fetchPage(req); } };
  const r = await C.run({ repo: t.repo.collector, transport: wrapped, now: () => t.clock.t, owner: 'tab-1' });
  assert.equal(r.outcome, 'stopped_midway');
  assert.equal(pages, 2);
  const st = await t.repo.getSource('mock');
  assert.ok(st.cursor, '途中の位置は残す');
});

test('同時実行は 1 つだけ（実行中の印とタブ間ロック）', async () => {
  const t = setup('ok');
  // 実行中の印がある状態を作る
  const b = await t.repo.collector.begin('mock', 'other-tab', t.clock.t);
  assert.equal(b.ok, true);
  const r = await t.run();
  assert.equal(r.refused, 'running');
  // 印は 10 分で切れる（落ちたタブの印が残り続けない）。ただし 6 時間の間隔は守る
  t.clock.t += 11 * 60e3;
  assert.equal((await t.run()).refused, 'interval');
  // ロックが取れないときも断る
  const r2 = await t.run('ok', { withLock: async () => null });
  assert.equal(r2.refused, 'running');
});

test('取得エラー：途中で止め、6 時間後まで次を始めない', async () => {
  const t = setup('err');
  const r = await t.run();
  assert.equal(r.outcome, 'error');
  const st = await t.repo.getSource('mock');
  assert.equal(Date.parse(st.nextAllowedAt) - Date.parse(st.lastAttemptAt), 6 * H);
});

test('全件確認：いいねが外れた投稿には印を付け、あなたの編集は残す', async () => {
  const t = setup('ok');
  await t.run();
  await t.repo.patchUser('x:700000000000000003', { memo: '' }, { memo: '消えても残してね' }, t.clock.t);
  t.clock.t += 18 * H;
  const r = await t.run('full');
  assert.equal(r.outcome, 'page_limit', '全件確認は止まらずに読むので、5 ページで続きへ');
  t.clock.t += 6 * H;
  const r2 = await t.run('full');
  assert.equal(r2.outcome, 'complete');
  const st = await t.repo.getSource('mock');
  assert.equal(st.lastRun.missing, 1);
  const it = (await t.repo.loadAll()).items.find((x) => x.id === 'x:700000000000000003');
  assert.equal(it.meta.missing, true);
  assert.equal(it.user.memo, '消えても残してね');
});

test('再取得で本文が変わっても、あなたの編集は残る', async () => {
  const t = setup('ok');
  await t.run();
  await t.repo.patchUser('x:700000000000000001', { tags: [], read: false }, { tags: ['大事'], read: true }, t.clock.t);
  t.clock.t += 6 * H;
  await t.run();
  const it = (await t.repo.loadAll()).items.find((x) => x.id === 'x:700000000000000001');
  assert.match(it.src.text, /追記/);
  assert.deepEqual(it.user.tags, ['大事']);
  assert.equal(it.user.read, true);
});

test('X の取得元は未接続：実行しない', async () => {
  const t = setup('ok');
  const r = await C.run({ repo: t.repo.collector, transport: X, now: () => t.clock.t, owner: 'tab-1' });
  assert.equal(r.refused, 'not_connected');
  await assert.rejects(X.fetchPage({}), /接続していません/);
  assert.equal(X.connected, false);
});
