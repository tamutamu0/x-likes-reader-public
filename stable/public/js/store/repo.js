/*
 * margin store/repo — 保存の窓口
 *
 *  - items：取得元（src）とあなたの編集（user）を分けて持つ。取得・取り込みは src だけを更新する
 *  - 書き込みは 1 回の取引で「全部か何もしないか」。失敗は例外で返し、画面は正直に表示する
 *  - 複数タブ：記録ごとの rev と「画面が見ていた値」で競合を見つける。変更は BroadcastChannel で他タブへ知らせる
 *  - 自動で消すことはない。消すのは「架空データを取り除く」と「取り込みの取り消し」を明示的に選んだときだけ
 */
(function (root, factory) {
  var req = typeof require === 'function';
  var deps = req
    ? { safe: require('../core/safe.js'), model: require('../core/model.js'), collector: require('../core/collector.js'), jsonio: require('../core/jsonio.js'), insight: require('../core/insight.js') }
    : root.Margin;
  var api = factory(deps.safe, deps.model, deps.collector, deps.jsonio, deps.insight);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Margin = root.Margin || {}; root.Margin.repo = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S, M, C, J, I) {
  'use strict';

  var L = S.LIMITS;

  function iso(t) { return new Date(t).toISOString(); }

  function createRepo(backend, opts) {
    opts = opts || {};
    var channel = opts.channel || null;
    var tabId = opts.tabId || ('tab-' + Math.random().toString(36).slice(2, 10));
    var listeners = [];

    function notify(msg) {
      msg.from = tabId;
      if (channel) { try { channel.postMessage(msg); } catch (e) { /* 通知できなくても保存は済んでいる */ } }
    }
    if (channel) channel.onmessage = function (ev) {
      var m = ev && ev.data;
      if (!m || m.from === tabId) return;
      listeners.forEach(function (fn) { fn(m); });
    };

    /* ------------------------------------------------------------ 読み出し */

    async function loadAll() {
      return backend.tx(['items', 'articles'], 'readonly', async function (t) {
        var raw = await t.getAll('items');
        var arts = await t.getAll('articles');
        var items = [], broken = 0;
        raw.forEach(function (r) { if (M.isValidRecord(r)) items.push(upgrade(r)); else broken++; });
        var articles = {};
        arts.forEach(function (a) { if (a && typeof a.key === 'string') articles[a.key] = a; });
        return { items: items, articles: articles, broken: broken };
      });
    }
    function upgrade(r) {
      if (!r.src.media) r.src.media = [];
      if (r.src.quote === undefined) r.src.quote = null;
      if (r.src.replyTo === undefined) r.src.replyTo = null;
      if (r.user.genre === undefined) r.user.genre = null;
      if (!Array.isArray(r.user.links)) r.user.links = [];
      if (!r.meta.sources) r.meta.sources = {};
      return r;
    }

    async function getItems(ids) {
      return backend.tx(['items'], 'readonly', async function (t) {
        var out = [];
        for (var i = 0; i < ids.length; i++) { var r = await t.get('items', ids[i]); if (r && M.isValidRecord(r)) out.push(upgrade(r)); else out.push({ id: ids[i], missing: true }); }
        return out;
      });
    }

    async function getArticles(keys) {
      return backend.tx(['articles'], 'readonly', async function (t) {
        var out = [];
        for (var i = 0; i < keys.length; i++) { var a = await t.get('articles', keys[i]); if (a) out.push(a); }
        return out;
      });
    }

    /* ------------------------------------------------------------ 投稿 */

    async function count(t) { return (await t.getAll('items')).length; }

    // 手で追加（X の投稿 URL）
    async function addManual(rawUrl, now) {
      var p = S.parseXStatus(String(rawUrl || ''));
      if (!p) return { status: 'invalid' };
      var n = M.normalizeSrc({ postId: p.postId, url: p.url, author: { handle: p.handle } }, now);
      if (!n.ok) return { status: 'invalid' };
      var r = await backend.tx(['items'], 'readwrite', async function (t) {
        var cur = await t.get('items', M.keyOf(p.postId));
        if (cur) return { status: 'exists', item: upgrade(cur) };
        if (await count(t) >= L.totalItems) return { status: 'full' };
        var rec = M.makeItem(n.src, 'manual', now);
        rec.meta.sources = { like: true }; // 「あなたがいいねした投稿」としての手動追加
        await t.put('items', rec);
        return { status: 'added', item: rec };
      });
      if (r.status === 'added') notify({ kind: 'items', ids: [r.item.id] });
      return r;
    }

    // 取得したいいねの統合：新しければ追加、既にあれば src と取得の記録だけ更新（user は保持）
    // entries: [{ src, likedAt, via: 'like' | 'bookmark' }]（src だけの配列も受ける）
    async function mergeFetched(entries, origin, now) {
      var r = await backend.tx(['items'], 'readwrite', async function (t) {
        var added = 0, merged = 0, skipped = 0, knownLiked = 0, ids = [];
        var total = await count(t);
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i].src ? entries[i] : { src: entries[i], likedAt: null, via: 'like' };
          var id = M.keyOf(e.src.postId);
          var cur = await t.get('items', id);
          var rec;
          if (cur) {
            cur = upgrade(cur);
            if (cur.meta.sources[e.via]) knownLiked++;
            rec = M.mergeSrc(cur, e.src, now).record;
            rec.rev = (cur.rev || 0) + 1;
            merged++;
          } else {
            if (total >= L.totalItems) { skipped++; continue; }
            rec = M.makeItem(e.src, origin, now);
            total++;
            added++;
          }
          rec.meta.sources = rec.meta.sources || {};
          rec.meta.sources[e.via] = true;
          if (e.likedAt && e.via === 'like') rec.meta.likedAt = e.likedAt;
          rec.meta.lastSeenAt = iso(now);
          rec.meta.missing = false;
          await t.put('items', rec);
          ids.push(id);
        }
        return { added: added, merged: merged, skipped: skipped, knownLiked: knownLiked, ids: ids };
      });
      if (r.ids.length) notify({ kind: 'items', ids: r.ids });
      return r;
    }

    // Server-owned source snapshot. Personal edits stay on this browser.
    async function applyXSnapshot(snapshot, now) {
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.entries) || snapshot.entries.length > L.totalItems) throw new Error('bad snapshot');
      var result = await backend.tx(['items', 'kv', 'media'], 'readwrite', async function (t) {
        var stamp = await t.get('kv', 'sync:x');
        if (stamp && stamp.revision === snapshot.revision) return { added: 0, ids: [] };
        var added = 0, ids = [], total = await count(t);
        for (var i = 0; i < snapshot.entries.length; i++) {
          var e = snapshot.entries[i];
          if (!S.isPostId(e.postId)) throw new Error('bad source');
          var id = M.keyOf(e.postId), cur = await t.get('items', id);
          if (!e.src && !cur) continue;
          if (!e.src && !(cur.meta.sources && cur.meta.sources.xapi)) continue;
          var n = M.normalizeSrc(e.src || { postId: e.postId }, now);
          if (!n.ok || n.src.postId !== e.postId) throw new Error('bad source');
          if (!cur && total >= L.totalItems) throw new Error('full');
          var rec = cur ? upgrade(cur) : M.makeItem(n.src, 'import', now);
          if (!cur) { added++; total++; }
          // Replace the source, including deleted/empty fields; mergeSrc intentionally cannot do this.
          rec.src = n.src; rec.rev = (cur ? cur.rev : 0) + 1;
          rec.meta.sources.like = true; rec.meta.sources.xapi = true;
          rec.meta.sourceStatus = e.sourceStatus === 'pending' ? 'pending' : e.src ? 'available' : e.sourceStatus === 'expired' ? 'expired' : 'removed';
          rec.meta.fetchedAt = M.normalizeSrc({postId:e.postId,postedAt:e.fetchedAt},now).src.postedAt || new Date(now).toISOString();
          rec.meta.lastSeenAt = rec.meta.fetchedAt;
          if (Number.isSafeInteger(e.feedOrder)) rec.meta.xFeedOrder = e.feedOrder;
          if (e.likedAt && Number.isFinite(Date.parse(e.likedAt))) rec.meta.likedAt = e.likedAt;
          if (!e.src) {
            var media = await t.getAll('media');
            for (var j = 0; j < media.length; j++) if ((cur.src.media || []).some(function (m) { return media[j].key === m.url; })) await t.del('media', media[j].key);
          }
          await t.put('items', rec); ids.push(id);
        }
        await t.put('kv', {k:'sync:x',revision:snapshot.revision});
        return {added:added,ids:ids};
      });
      if (result.ids.length) notify({kind:'items',ids:result.ids});
      return result;
    }

    async function expireXSources(now) {
      var ids = await backend.tx(['items', 'media'], 'readwrite', async function(t) {
        var items = await t.getAll('items'), ids = [], media = await t.getAll('media');
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (!M.isValidRecord(it) || !it.meta.sources.xapi || it.meta.sourceStatus !== 'available' || Date.parse(it.meta.fetchedAt) >= now - 7 * 86400000) continue;
          for (var j = 0; j < media.length; j++) if ((it.src.media || []).some(function(m) { return media[j].key === m.url; })) await t.del('media', media[j].key);
          it.src = M.normalizeSrc({postId:it.src.postId},now).src;
          it.meta.sourceStatus = 'expired'; it.rev++;
          await t.put('items',it); ids.push(it.id);
        }
        return ids;
      });
      if (ids.length) notify({kind:'items',ids:ids});
      return ids.length;
    }

    // 全件確認の一巡で見かけなかったいいねに印を付ける（消さない。user も触らない）
    async function markMissing(origin, sweepStartedAt, now) {
      var r = await backend.tx(['items'], 'readwrite', async function (t) {
        var all = await t.getAll('items');
        var ids = [];
        for (var i = 0; i < all.length; i++) {
          var it = all[i];
          if (!M.isValidRecord(it) || it.meta.origin !== origin) continue;
          var m = it.meta;
          if (!m.sources || !m.sources.like || m.missing) continue;
          if (m.lastSeenAt && m.lastSeenAt >= sweepStartedAt) continue;
          m.missing = true;
          m.missingSince = iso(now);
          it.rev = (it.rev || 0) + 1;
          await t.put('items', it);
          ids.push(it.id);
        }
        return ids;
      });
      if (r.length) notify({ kind: 'items', ids: r });
      return r.length;
    }

    /*
     * あなたの編集を保存する。base は画面が見ていた user の値（変更する項目ぶん）。
     * 戻り値: { status: 'ok', item } | { status: 'conflict', item, fields } | { status: 'missing' }
     * 保存そのものに失敗したら例外（code: write_failed / quota など）
     */
    async function patchUser(id, base, patch, now) {
      var r = await backend.tx(['items'], 'readwrite', async function (t) {
        var cur = await t.get('items', id);
        if (!cur) return { status: 'missing' };
        cur = upgrade(cur);
        var res = M.applyPatch(cur, base, patch, now);
        if (!res.ok) return { status: 'conflict', item: cur, fields: res.fields };
        res.record.rev = (cur.rev || 0) + 1;
        await t.put('items', res.record);
        return { status: 'ok', item: res.record };
      });
      if (r.status === 'ok') notify({ kind: 'items', ids: [id] });
      return r;
    }

    // あとでの時間が来たものを読むに戻す（何度呼んでも同じ結果になる）
    async function promoteDue(now) {
      var ids = await backend.tx(['items'], 'readwrite', async function (t) {
        var all = await t.getAll('items');
        var changed = [];
        for (var i = 0; i < all.length; i++) {
          if (!M.isValidRecord(all[i])) continue;
          var next = M.promote(upgrade(all[i]), now);
          if (next) { next.rev = (all[i].rev || 0) + 1; await t.put('items', next); changed.push(next.id); }
        }
        return changed;
      });
      if (ids.length) notify({ kind: 'items', ids: ids });
      return ids;
    }

    // 架空サンプルを入れる（明示操作のときだけ）。同じ ID が既にあれば触らない
    async function insertSample(records) {
      var r = await backend.tx(['items'], 'readwrite', async function (t) {
        var added = 0, skipped = 0, ids = [];
        for (var i = 0; i < records.length; i++) {
          if (records[i].meta.origin !== 'sample') throw new Error('sample only');
          var cur = await t.get('items', records[i].id);
          if (cur) { skipped++; continue; }
          await t.put('items', records[i]); added++; ids.push(records[i].id);
        }
        return { added: added, skipped: skipped, ids: ids };
      });
      if (r.ids.length) notify({ kind: 'items', ids: r.ids });
      return r;
    }

    // 架空データ（サンプルとモック取得分）だけを取り除く。あなたが追加・取り込んだものには触れない
    async function removeFictional() {
      var r = await backend.tx(['items', 'articles'], 'readwrite', async function (t) {
        var all = await t.getAll('items');
        var ids = [];
        for (var i = 0; i < all.length; i++) {
          if (all[i] && all[i].meta && M.FICTIONAL[all[i].meta.origin]) { await t.del('items', all[i].id); ids.push(all[i].id); }
        }
        var arts = await t.getAll('articles');
        for (var j = 0; j < arts.length; j++) if (arts[j].status === 'sample') await t.del('articles', arts[j].key);
        return { removed: ids.length, ids: ids };
      });
      if (r.ids.length) notify({ kind: 'items', ids: r.ids, removed: true });
      return r;
    }

    /* ------------------------------------------------------------ 記事・画像 */

    async function saveArticle(article) {
      if (!article || typeof article.key !== 'string') throw new Error('bad article');
      await backend.tx(['articles'], 'readwrite', async function (t) { await t.put('articles', article); });
      notify({ kind: 'articles', keys: [article.key] });
      return article;
    }
    async function getMedia(key) {
      return backend.tx(['media'], 'readonly', async function (t) { return t.get('media', key); });
    }
    async function saveMedia(rec) {
      await backend.tx(['media'], 'readwrite', async function (t) { await t.put('media', rec); });
      notify({ kind: 'media', keys: [rec.key] });
    }

    /* ------------------------------------------------------------ 収集（collector.js が使う） */

    function srcKey(sid) { return 'source:' + sid; }

    async function getKv(k) { return backend.tx(['kv'], 'readonly', async function (t) { return t.get('kv', k); }); }

    async function getControl() {
      var c = await getKv('control:collect');
      return c || { k: 'control:collect', stopped: false, reason: null, at: null };
    }
    async function setStopped(stopped, reason, now) {
      await backend.tx(['kv'], 'readwrite', async function (t) {
        var c = (await t.get('kv', 'control:collect')) || { k: 'control:collect' };
        c.stopped = !!stopped; c.reason = stopped ? (reason || 'manual') : null; c.at = iso(now);
        await t.put('kv', c);
      });
      notify({ kind: 'kv', keys: ['control:collect'] });
    }
    async function isStopped() { return !!(await getControl()).stopped; }

    async function getSource(sid) {
      var s = await getKv(srcKey(sid));
      return s ? s : Object.assign({ k: srcKey(sid) }, C.emptyState());
    }

    // 開始の判定と「実行中」の印をひとつの取引で行う（同時に 2 つ始まらない）
    async function begin(sid, owner, now) {
      var r = await backend.tx(['kv'], 'readwrite', async function (t) {
        var control = (await t.get('kv', 'control:collect')) || {};
        var st = (await t.get('kv', srcKey(sid))) || Object.assign({ k: srcKey(sid) }, C.emptyState());
        var a = C.admission(control, st, now);
        if (!a.ok) return { ok: false, reason: a.reason, until: a.until, state: st };
        st.lease = { owner: owner, expiresAt: iso(now + L.leaseMs) };
        st.lastAttemptAt = iso(now);
        st.nextAllowedAt = iso(now + L.minIntervalMs);
        await t.put('kv', st);
        return { ok: true, state: st };
      });
      notify({ kind: 'kv', keys: [srcKey(sid)] });
      return r;
    }
    async function progress(sid, owner, patch, now) {
      var ok = await backend.tx(['kv'], 'readwrite', async function (t) {
        var st = await t.get('kv', srcKey(sid));
        if (!st || !st.lease || st.lease.owner !== owner) return false;
        st.cursor = patch.cursor;
        st.sweepStartedAt = patch.sweepStartedAt;
        st.sweepFull = patch.sweepFull;
        st.lease.expiresAt = iso(now + L.leaseMs);
        await t.put('kv', st);
        return true;
      });
      notify({ kind: 'kv', keys: [srcKey(sid)] });
      return ok;
    }
    async function finish(sid, owner, update, now) {
      var r = await backend.tx(['kv'], 'readwrite', async function (t) {
        var st = (await t.get('kv', srcKey(sid))) || Object.assign({ k: srcKey(sid) }, C.emptyState());
        var control = (await t.get('kv', 'control:collect')) || { k: 'control:collect', stopped: false };
        if (st.lease && st.lease.owner !== owner) return st; // 他の実行に引き継がれていたら書かない
        var wasStopped = control.stopped;
        var next = update(st, control);
        next.k = srcKey(sid);
        await t.put('kv', next);
        if (control.stopped !== wasStopped) await t.put('kv', control);
        return next;
      });
      notify({ kind: 'kv', keys: [srcKey(sid), 'control:collect'] });
      return r;
    }
    async function log(sid, kind, text, now) {
      await backend.tx(['kv'], 'readwrite', async function (t) {
        var l = (await t.get('kv', 'log:' + sid)) || { k: 'log:' + sid, entries: [] };
        l.entries.push({ at: iso(now), kind: kind || '', text: S.cleanText(text, 300) });
        if (l.entries.length > L.logEntries) l.entries = l.entries.slice(-L.logEntries);
        await t.put('kv', l);
      });
      notify({ kind: 'kv', keys: ['log:' + sid] });
    }
    async function getLog(sid) { var l = await getKv('log:' + sid); return l ? l.entries : []; }

    // モック専用：モック時計と状況の設定（実際の取得元には存在しない）
    async function getMockSettings() {
      var m = await getKv('mock:settings');
      return m || { k: 'mock:settings', epoch: null, offsetMs: 0, scenario: 'ok' };
    }
    async function setMockSettings(patch) {
      var r = await backend.tx(['kv'], 'readwrite', async function (t) {
        var m = (await t.get('kv', 'mock:settings')) || { k: 'mock:settings', epoch: null, offsetMs: 0, scenario: 'ok' };
        Object.keys(patch).forEach(function (k) { m[k] = patch[k]; });
        await t.put('kv', m);
        return m;
      });
      notify({ kind: 'kv', keys: ['mock:settings'] });
      return r;
    }
    // モックの収集状態だけを初めに戻す（投稿は消さない）
    async function resetMockSource() {
      await backend.tx(['kv'], 'readwrite', async function (t) {
        await t.put('kv', Object.assign({ k: srcKey('mock') }, C.emptyState()));
        await t.put('kv', { k: 'mock:settings', epoch: null, offsetMs: 0, scenario: 'ok' });
        await t.put('kv', { k: 'log:mock', entries: [] });
      });
      notify({ kind: 'kv', keys: [srcKey('mock'), 'mock:settings', 'log:mock'] });
    }

    var collectorRepo = { begin: begin, progress: progress, finish: finish, isStopped: isStopped, mergeFetched: mergeFetched, markMissing: markMissing, log: log };

    /* ------------------------------------------------------------ バックアップ・取り込み（中身の処理） */

    async function buildBackup(now) {
      var all = await backend.tx(['items'], 'readonly', async function (t) { return t.getAll('items'); });
      return J.buildBackup(all.filter(M.isValidRecord).map(upgrade), now);
    }

    async function planImport(parsed, now, batchId) {
      var existing = {};
      var all = await backend.tx(['items'], 'readonly', async function (t) { return t.getAll('items'); });
      all.forEach(function (r) { if (M.isValidRecord(r)) existing[r.id] = upgrade(r); });
      return J.planImport(existing, parsed, now, batchId);
    }

    // 計画どおりに書く。取り消せるように控えを残す。途中で失敗したら何も書かない
    async function applyImport(plan, now) {
      var r = await backend.tx(['items', 'batches'], 'readwrite', async function (t) {
        if (await t.get('batches', plan.batchId)) throw new Error('batch already applied');
        var total = await count(t);
        if (total + plan.add.length > L.totalItems) { var e = new Error('full'); e.code = 'full'; throw e; }
        var updated = [], added = [];
        for (var i = 0; i < plan.add.length; i++) {
          if (await t.get('items', plan.add[i].id)) continue;
          await t.put('items', plan.add[i]);
          added.push(plan.add[i].id);
        }
        for (var j = 0; j < plan.updateSrc.length; j++) {
          var u = plan.updateSrc[j];
          var cur = await t.get('items', u.id);
          if (!cur) continue;
          if (!M.same(cur.src, u.beforeSrc)) {
            var conflict = new Error('確認後に取得元データが更新されました。もう一度取り込み内容を確認してください。');
            conflict.code = 'import_conflict';
            throw conflict;
          }
          if (u.beforeUser && !M.same(cur.user, u.beforeUser)) {
            var userConflict = new Error('確認後に本人の編集が変わりました。もう一度取り込み内容を確認してください。');
            userConflict.code = 'import_conflict'; throw userConflict;
          }
          cur.src = u.afterSrc;
          if (u.sourceChanged !== false) { cur.meta.fetchedAt = iso(now); cur.meta.srcUpdatedAt = iso(now); }
          if (u.afterUser) cur.user = u.afterUser;
          cur.rev = (cur.rev || 0) + 1;
          await t.put('items', cur);
          updated.push({ id: u.id, beforeSrc: u.beforeSrc, afterSrc: u.afterSrc, beforeUser: u.beforeUser, afterUser: u.afterUser });
        }
        var batch = { id: plan.batchId, at: iso(now), added: added, updated: updated, undone: false };
        await t.put('batches', batch);
        return batch;
      });
      notify({ kind: 'items', ids: r.added.concat(r.updated.map(function (u) { return u.id; })) });
      return r;
    }

    // 取り込みの取り消し：追加した投稿は「その後あなたが触っていなければ」取り除き、更新した src は元に戻す
    async function undoImport(batchId, now) {
      var r = await backend.tx(['items', 'batches'], 'readwrite', async function (t) {
        var b = await t.get('batches', batchId);
        if (!b || b.undone) return { status: 'none' };
        var removed = [], keptEdited = [], restored = [];
        for (var i = 0; i < b.added.length; i++) {
          var cur = await t.get('items', b.added[i]);
          if (!cur) continue;
          if (cur.meta.importBatch === batchId && cur.rev === 1) { await t.del('items', cur.id); removed.push(cur.id); }
          else keptEdited.push(cur.id);
        }
        for (var j = 0; j < b.updated.length; j++) {
          var u = b.updated[j];
          var c = await t.get('items', u.id);
          if (c && M.same(c.src, u.afterSrc)) {
            c.src = u.beforeSrc;
            if (u.beforeUser && M.same(c.user, u.afterUser)) c.user = u.beforeUser;
            c.rev = (c.rev || 0) + 1; c.meta.srcUpdatedAt = iso(now); await t.put('items', c); restored.push(c.id);
          }
        }
        b.undone = true; b.undoneAt = iso(now);
        await t.put('batches', b);
        return { status: 'ok', removed: removed, keptEdited: keptEdited, restored: restored };
      });
      if (r.status === 'ok') notify({ kind: 'items', ids: r.removed.concat(r.restored, r.keptEdited), removed: true });
      return r;
    }

    return {
      tabId: tabId,
      backendName: backend.name,
      onChange: function (fn) { listeners.push(fn); },
      loadAll: loadAll, getItems: getItems, getArticles: getArticles,
      addManual: addManual, mergeFetched: mergeFetched, applyXSnapshot: applyXSnapshot, expireXSources: expireXSources, markMissing: markMissing, patchUser: patchUser, promoteDue: promoteDue,
      insertSample: insertSample, removeFictional: removeFictional,
      saveArticle: saveArticle, getMedia: getMedia, saveMedia: saveMedia,
      getControl: getControl, setStopped: setStopped, getSource: getSource, getLog: getLog,
      getMockSettings: getMockSettings, setMockSettings: setMockSettings, resetMockSource: resetMockSource,
      collector: collectorRepo,
      buildBackup: buildBackup, planImport: planImport, applyImport: applyImport, undoImport: undoImport
    };
  }

  return Object.freeze({ createRepo: createRepo });
});
