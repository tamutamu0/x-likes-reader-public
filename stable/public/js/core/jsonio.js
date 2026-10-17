/*
 * margin core/jsonio — JSON の読み込み（解析・検査・計画）とバックアップの組み立て
 *
 * ここは「中身の処理」だけを持つ。ファイルを選ぶ・読む・保存する操作は
 * Mac での承認が済むまで画面から呼べない（approvals.js と app.js のゲートで止める）。
 * テストは架空の fixture だけで行う。
 *
 * 受け付ける形式（どちらも margin 自身の形式。旧版の形式は推測しない）
 *   { "format": "margin-backup", "version": 1, "items": [ { "src": {...}, "user": {...}, "meta": {...} } ] }
 *   { "format": "margin-items",  "version": 1, "items": [ { "postId": "...", "url": "...", ... } ] }
 */
(function (root, factory) {
  var req = typeof require === 'function';
  var safe = req ? require('./safe.js') : root.Margin.safe;
  var model = req ? require('./model.js') : root.Margin.model;
  var api = factory(safe, model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Margin = root.Margin || {}; root.Margin.jsonio = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S, M) {
  'use strict';

  var L = S.LIMITS;

  function ImportError(code, detail) {
    var e = new Error(code + (detail ? ': ' + detail : ''));
    e.code = code;
    return e;
  }

  function yieldNow() {
    return new Promise(function (r) { (typeof setImmediate === 'function' ? setImmediate : setTimeout)(r, 0); });
  }

  function checkAbort(signal) {
    if (signal && signal.aborted) { var e = new Error('aborted'); e.name = 'AbortError'; e.code = 'aborted'; throw e; }
  }

  /*
   * 解析して、取り込める候補と弾いた理由を返す。ここでは何も保存しない。
   * opts: { signal, now, maxBytes, maxItems, onProgress(done,total) }
   */
  async function parseImport(text, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var maxBytes = opts.maxBytes || L.jsonBytes;
    var maxItems = opts.maxItems || L.items;
    checkAbort(opts.signal);
    if (typeof text !== 'string') throw ImportError('not_text');
    // 大きさは解析の前に確かめる（巨大な入力を JSON.parse に渡さない）
    if (text.length > maxBytes || S.byteLength(text) > maxBytes) throw ImportError('too_large', String(maxBytes));

    var data;
    try { data = JSON.parse(text); } catch (e) { throw ImportError('invalid_json'); }
    checkAbort(opts.signal);

    if (!data || typeof data !== 'object' || Array.isArray(data)) throw ImportError('unknown_format');
    var format = data.format;
    if ((format !== 'margin-backup' && format !== 'margin-items') || data.version !== 1) throw ImportError('unknown_format');
    if (!Array.isArray(data.items)) throw ImportError('unknown_format');
    if (data.items.length > maxItems) throw ImportError('too_many', String(maxItems));

    var stats = { total: data.items.length, accepted: 0, rejected: 0, secretKeys: S.countSecretKeys(data), linksDropped: 0 };
    var entries = [];
    var rejected = [];
    var seen = {};

    for (var i = 0; i < data.items.length; i++) {
      if (i % 250 === 0) {
        checkAbort(opts.signal);
        if (i) { if (opts.onProgress) opts.onProgress(i, data.items.length); await yieldNow(); checkAbort(opts.signal); }
      }
      var raw = data.items[i];
      var rawSrc = format === 'margin-backup' ? (raw && raw.src) : raw;
      var n = M.normalizeSrc(rawSrc, now);
      if (!n.ok) { rejected.push({ index: i, reason: n.reason }); continue; }
      var id = M.keyOf(n.src.postId);
      if (seen[id]) { rejected.push({ index: i, reason: 'duplicate_in_file' }); continue; }
      seen[id] = 1;
      stats.linksDropped += n.notes.linksDropped;
      var entry = { id: id, src: n.src, user: null, origin: 'import' };
      if (format === 'margin-backup') {
        entry.user = M.sanitizeUser(raw.user);
        var o = raw.meta && raw.meta.origin;
        if (o === 'sample' || o === 'mock' || o === 'manual' || o === 'import') entry.origin = o;
      }
      entries.push(entry);
    }
    checkAbort(opts.signal);
    if (opts.onProgress) opts.onProgress(data.items.length, data.items.length);
    stats.accepted = entries.length;
    stats.rejected = rejected.length;
    return { format: format, entries: entries, rejected: rejected, stats: stats };
  }

  /*
   * 取り込みの計画（プレビュー用）。既存のあなたの編集は上書きしない。
   * existing: { id: record }
   */
  function planImport(existing, parsed, now, batchId) {
    var plan = { batchId: batchId, add: [], updateSrc: [], unchanged: [], userKept: 0, userRestored: 0 };
    parsed.entries.forEach(function (e) {
      var cur = existing[e.id];
      if (!cur) {
        var rec = M.makeItem(e.src, e.origin, now, e.user || M.defaultUser());
        rec.meta.importBatch = batchId;
        plan.add.push(rec);
        return;
      }
      var m = M.mergeSrc(cur, e.src, now);
      var restoreUser = e.user && !cur.user.editedAt && !M.hasUserEdits(cur.user) && !M.same(e.user, cur.user);
      if (restoreUser) plan.userRestored++;
      else if (e.user && !M.same(e.user, cur.user)) plan.userKept++;
      if (m.changed || restoreUser) plan.updateSrc.push({ id: e.id, beforeSrc: cur.src, afterSrc: m.record.src,
        sourceChanged: m.changed, beforeUser: restoreUser ? cur.user : null, afterUser: restoreUser ? e.user : null });
      else plan.unchanged.push(e.id);
    });
    return plan;
  }

  function buildBackup(records, now) {
    var items = records
      .slice()
      .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
      .map(function (r) {
        return { src: r.src, user: r.user, meta: { origin: r.meta.origin, firstSeenAt: r.meta.firstSeenAt } };
      });
    return { format: 'margin-backup', version: 1, exportedAt: new Date(now).toISOString(), count: items.length, items: items };
  }

  function serialize(obj) { return JSON.stringify(obj, null, 2) + '\n'; }

  var MESSAGES = {
    not_text: '文字のデータではありません',
    too_large: '大きすぎます（上限 20MB）',
    invalid_json: 'JSON として読めません',
    unknown_format: 'margin の形式ではありません（旧版の形式は、変換手順の承認後に対応します）',
    too_many: '件数が多すぎます（1 回 5,000 件まで）',
    aborted: '中止しました。何も保存していません'
  };

  return Object.freeze({
    parseImport: parseImport,
    planImport: planImport,
    buildBackup: buildBackup,
    serialize: serialize,
    MESSAGES: MESSAGES
  });
});
