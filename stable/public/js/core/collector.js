/*
 * margin core/collector — 収集ジョブの規則（取得元に依存しない）
 *
 * いまつながっている取得元は「収集モック（架空データ）」だけ。X への接続はない。
 * 将来のアダプタも同じ規則の下で動かす。
 *
 * 規則
 *  - 前回の試行開始から 6 時間たつまで始めない（成功・失敗にかかわらず）
 *  - 同時に動くのは 1 つだけ（タブ間ロック＋保存した実行中の印。印は 10 分で失効）
 *  - 1 回 5 ページまで。続きは cursor に残して次回そこから
 *  - 対象は「いいね」。並びはいいねした順なので、差分は「既に取り込んだいいねに届いたらそのページで止める」
 *  - 全件確認モード：止まらずに最後まで読み、見つからなくなったいいねに「取得元で見つからない」印を付ける
 *    （いいねが外れた・投稿が消えた可能性。あなたの既読・メモ・分類・状態は消さない）
 *  - 重複は投稿 ID でまとめ、取得元の値だけ更新する（あなたの編集は保持）
 *  - 429：Retry-After と「6時間×2^(連続回数-1)、上限48時間」の長い方まで待つ
 *  - 401 / 403 / 確認要求：その場で止まり、停止スイッチをオンにする（再開は手動）
 *  - 停止スイッチ：ページごとに確かめ、オンなら次のページを取りに行かない
 *  - 最後まで読み切ったときだけ「最後の成功」を更新。途中で終わったら取得範囲と理由を残す
 */
(function (root, factory) {
  var req = typeof require === 'function';
  var safe = req ? require('./safe.js') : root.Margin.safe;
  var model = req ? require('./model.js') : root.Margin.model;
  var api = factory(safe, model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Margin = root.Margin || {}; root.Margin.collector = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S, M) {
  'use strict';

  var L = S.LIMITS;

  function emptyState() {
    return {
      lastAttemptAt: null, lastSuccessAt: null, nextAllowedAt: null,
      consecutive429: 0, cursor: null, sweepStartedAt: null, sweepFull: false,
      lease: null, lastRun: null
    };
  }

  // Retry-After：秒数か HTTP 日付。読めなければ null
  function parseRetryAfter(v, now) {
    if (v == null) return null;
    var s = String(v).trim();
    if (/^\d{1,9}$/.test(s)) return Number(s) * 1000;
    var t = Date.parse(s);
    if (isFinite(t)) return Math.max(0, t - now);
    return null;
  }

  function backoffMs(n, retryAfterMs) {
    var exp = Math.min(L.minIntervalMs * Math.pow(2, Math.max(0, n - 1)), L.backoffCapMs);
    return Math.max(exp, retryAfterMs || 0);
  }

  // 開始してよいか（読み取りだけ。書き込みは repo.begin がトランザクション内で同じ判定をする）
  function admission(control, st, now) {
    if (control && control.stopped) return { ok: false, reason: 'stopped' };
    if (st.lease && Date.parse(st.lease.expiresAt) > now) return { ok: false, reason: 'running' };
    if (st.nextAllowedAt && Date.parse(st.nextAllowedAt) > now) return { ok: false, reason: 'interval', until: st.nextAllowedAt };
    return { ok: true };
  }

  var OUTCOME_TEXT = {
    complete: '最後まで取得',
    page_limit: 'ページ上限で中断（続きは次回）',
    rate_limited: '429 混雑で中断',
    auth_401: '401 認証エラーで停止',
    forbidden_403: '403 拒否で停止',
    challenge: '確認要求で停止',
    stopped_midway: '停止スイッチで中断',
    error: '取得エラーで中断',
    lost_lease: '別の実行に引き継がれたため中断'
  };
  var REFUSAL_TEXT = {
    stopped: '停止スイッチがオンのため実行しません',
    running: 'ほかの実行が動いているため実行しません',
    interval: '前回の試行から 6 時間たっていないため実行しません',
    not_connected: '取得元が未接続です'
  };

  /*
   * opts: {
   *   repo:      { begin, progress, finish, isStopped, mergeFetched, log }（store.js が実装）
   *   transport: { id, fictional, connected, fetchPage({cursor, page}) }
   *   now():     現在時刻（モックはモック時計）
   *   owner:     実行者の識別子
   *   signal:    AbortSignal（任意）
   *   withLock:  (fn) => fn() をタブ間で排他して実行。取れなければ null を返す（任意）
   * }
   */
  async function run(opts) {
    var t = opts.transport;
    if (!t || !t.connected) return { refused: 'not_connected', text: REFUSAL_TEXT.not_connected };
    var lockRun = opts.withLock || function (fn) { return fn(); };
    var res = await lockRun(function () { return runLocked(opts); });
    if (res == null) {
      await opts.repo.log(t.id, 'warn', REFUSAL_TEXT.running, opts.now());
      return { refused: 'running', text: REFUSAL_TEXT.running };
    }
    return res;
  }

  async function runLocked(opts) {
    var repo = opts.repo, t = opts.transport, sid = t.id;
    var startAt = opts.now();
    var b = await repo.begin(sid, opts.owner, startAt);
    if (!b.ok) {
      var msg = REFUSAL_TEXT[b.reason] + (b.until ? '（次は ' + b.until + ' 以降）' : '');
      await repo.log(sid, 'warn', msg, startAt);
      return { refused: b.reason, until: b.until || null, text: msg };
    }
    var st = b.state;
    await repo.log(sid, '', '開始：同時実行なし・間隔 OK・続きの位置 ' + (st.cursor ? 'あり' : 'なし'), startAt);

    var cursor = st.cursor;
    // 新しい一巡の始まり（続きがないとき）。全件確認かどうかは一巡ごとに決める
    var sweepStartedAt = cursor && st.sweepStartedAt ? st.sweepStartedAt : new Date(startAt).toISOString();
    var sweepFull = cursor ? !!st.sweepFull : !!opts.fullCheck;
    var missing = 0;
    var pages = 0, added = 0, merged = 0, from = null, to = null;
    var outcome = null, retryAfterMs = null;

    for (var page = 1; page <= L.pagesPerRun; page++) {
      if ((opts.signal && opts.signal.aborted) || await repo.isStopped()) { outcome = 'stopped_midway'; break; }
      var resp;
      try { resp = await t.fetchPage({ cursor: cursor, page: page }); }
      catch (e) { outcome = 'error'; await repo.log(sid, 'err', page + 'ページ目：取得エラー', opts.now()); break; }
      if (!resp || typeof resp !== 'object') { outcome = 'error'; break; }

      if (resp.status === 200 && Array.isArray(resp.posts)) {
        var posts = resp.posts.slice(0, L.postsPerPage);
        var entries = [];
        posts.forEach(function (p) {
          var n = M.normalizeSrc(p, opts.now());
          if (!n.ok) return;
          var likedAt = typeof p.likedAt === 'string' && isFinite(Date.parse(p.likedAt)) ? new Date(Date.parse(p.likedAt)).toISOString() : null;
          var key = likedAt || n.src.postedAt;
          if (key) {
            if (!from || key < from) from = key;
            if (!to || key > to) to = key;
          }
          entries.push({ src: n.src, likedAt: likedAt, via: 'like' });
        });
        var m = await repo.mergeFetched(entries, t.fictional ? 'mock' : 'import', opts.now());
        added += m.added; merged += m.merged;
        var reachedKnown = !sweepFull && m.knownLiked > 0;
        pages++;
        cursor = typeof resp.nextCursor === 'string' && resp.nextCursor ? resp.nextCursor.slice(0, 200) : null;
        var ok = await repo.progress(sid, opts.owner, { cursor: cursor, sweepStartedAt: sweepStartedAt, sweepFull: sweepFull }, opts.now());
        await repo.log(sid, m.added ? 'ok' : '', page + 'ページ目：' + posts.length + '件 → 新規' + m.added + '・重複' + m.merged + (reachedKnown ? '・取り込み済みのいいねに到達' : ''), opts.now());
        if (!ok) { outcome = 'lost_lease'; break; }
        if (reachedKnown || !cursor) {
          outcome = 'complete';
          if (sweepFull && !cursor && repo.markMissing) {
            missing = await repo.markMissing(t.fictional ? 'mock' : 'import', sweepStartedAt, opts.now());
            await repo.log(sid, missing ? 'warn' : '', '全件確認：取得元で見つからないいいね ' + missing + '件（あなたの編集は残しています）', opts.now());
          }
          break;
        }
        continue;
      }
      if (resp.status === 429) {
        outcome = 'rate_limited';
        retryAfterMs = parseRetryAfter(resp.retryAfter, opts.now());
        await repo.log(sid, 'warn', page + 'ページ目：429 混雑' + (retryAfterMs != null ? '（Retry-After ' + Math.round(retryAfterMs / 1000) + '秒）' : '（Retry-After なし）'), opts.now());
        break;
      }
      if (resp.status === 401) { outcome = 'auth_401'; break; }
      if (resp.status === 403) { outcome = 'forbidden_403'; break; }
      if (resp.status === 'challenge') { outcome = 'challenge'; break; }
      outcome = 'error';
      break;
    }
    if (!outcome) outcome = 'page_limit';

    var endAt = opts.now();
    var result = await repo.finish(sid, opts.owner, function (cur, control) {
      var s = JSON.parse(JSON.stringify(cur));
      s.lease = null;
      s.cursor = cursor;
      s.sweepStartedAt = cursor ? sweepStartedAt : null;
      s.sweepFull = cursor ? sweepFull : false;
      var base = Date.parse(s.lastAttemptAt || new Date(startAt).toISOString());
      s.nextAllowedAt = new Date(base + L.minIntervalMs).toISOString();
      if (outcome === 'complete') {
        s.lastSuccessAt = new Date(endAt).toISOString();
        s.consecutive429 = 0;
        s.cursor = null;
      } else if (outcome === 'rate_limited') {
        s.consecutive429 = (s.consecutive429 || 0) + 1;
        s.nextAllowedAt = new Date(endAt + backoffMs(s.consecutive429, retryAfterMs)).toISOString();
      } else if (outcome === 'auth_401' || outcome === 'forbidden_403' || outcome === 'challenge') {
        control.stopped = true;
        control.reason = outcome;
        control.at = new Date(endAt).toISOString();
      }
      s.lastRun = {
        startedAt: new Date(startAt).toISOString(),
        endedAt: new Date(endAt).toISOString(),
        outcome: outcome,
        partial: outcome !== 'complete',
        pages: pages, added: added, merged: merged, missing: missing, full: sweepFull,
        range: from ? { from: from, to: to } : null,
        hasMore: !!s.cursor,
        nextAllowedAt: s.nextAllowedAt
      };
      return s;
    }, endAt);

    var kind = outcome === 'complete' ? 'ok' : (outcome === 'auth_401' || outcome === 'forbidden_403' || outcome === 'challenge' || outcome === 'error') ? 'err' : 'warn';
    await repo.log(sid, kind, '結果：' + OUTCOME_TEXT[outcome] + '・' + pages + 'ページ・新規' + added + '・重複' + merged +
      (outcome === 'auth_401' || outcome === 'forbidden_403' || outcome === 'challenge' ? '。停止スイッチをオンにしました' : ''), endAt);
    return { outcome: outcome, text: OUTCOME_TEXT[outcome], state: result };
  }

  return Object.freeze({
    run: run, emptyState: emptyState, admission: admission, parseRetryAfter: parseRetryAfter,
    backoffMs: backoffMs, OUTCOME_TEXT: OUTCOME_TEXT, REFUSAL_TEXT: REFUSAL_TEXT
  });
});
