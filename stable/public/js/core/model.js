/*
 * margin core/model — 保存する形と、その形を守る操作
 *
 * 1 件の記録:
 * {
 *   id:   'x:<投稿ID>'           … 重複判定キーをそのまま ID にする（同じ投稿は 1 件にしかならない）
 *   v:    1                      … 形式の版
 *   rev:  <整数>                 … 書き込むたびに +1。複数タブの競合検出に使う
 *   src:  取得元の値（本文・著者・日時・リンク）。再取得で更新してよいのはここだけ
 *   meta: 入手経路と取得の記録（origin: manual | sample | mock | import）
 *   user: あなたの編集（状態・既読・あとでの日時・タグ・メモ）。取得では決して上書きしない
 * }
 */
(function (root, factory) {
  var safe = (typeof require === 'function') ? require('./safe.js') : root.Margin.safe;
  var api = factory(safe);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Margin = root.Margin || {}; root.Margin.model = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S) {
  'use strict';

  var L = S.LIMITS;
  var STATES = { inbox: 1, later: 1, kept: 1, done: 1 };
  var ORIGINS = { manual: 1, sample: 1, mock: 1, import: 1 };
  var FICTIONAL = { sample: 1, mock: 1 };
  var MIN_DATE = Date.UTC(2006, 0, 1);

  function iso(t) { return new Date(t).toISOString(); }
  function cleanDate(v, now) {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    var t = typeof v === 'number' ? v : Date.parse(v);
    if (!isFinite(t) || t < MIN_DATE || t > (now || Date.now()) + 2 * 864e5) return null;
    return iso(t);
  }
  function cleanFutureDate(v) {
    if (typeof v !== 'string') return null;
    var t = Date.parse(v);
    if (!isFinite(t) || t < MIN_DATE || t > Date.UTC(2200, 0, 1)) return null;
    return iso(t);
  }

  function keyOf(postId) { return 'x:' + postId; }

  // 取得元の値を検査して正規化する。信頼しない入力をここで閉じ込める
  var LOCAL_MEDIA = /^\/samples\/media\/[a-z0-9-]{1,40}\.svg$/;

  function cleanMedia(list, opts, notes) {
    var out = [];
    if (!Array.isArray(list)) return out;
    list.slice(0, 10).forEach(function (m) {
      if (out.length >= 4 || !m || typeof m !== 'object') { notes.mediaDropped++; return; }
      var kind = m.kind === 'video' || m.kind === 'gif' ? m.kind : 'image';
      var url = null, local = null;
      if (opts && opts.allowLocalMedia && typeof m.local === 'string' && LOCAL_MEDIA.test(m.local)) local = m.local;
      else url = S.sanitizeUrl(m.url);
      if (!url && !local) { notes.mediaDropped++; return; }
      var w = Number.isInteger(m.w) && m.w > 0 && m.w < 20000 ? m.w : null;
      var h = Number.isInteger(m.h) && m.h > 0 && m.h < 20000 ? m.h : null;
      out.push({ kind: kind, url: url, local: local, alt: S.cleanText(m.alt, 1000), w: w, h: h });
    });
    return out;
  }

  function normalizeSrc(raw, now, opts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
    var notes = { linksDropped: 0, mediaDropped: 0 };
    var postId = null;
    if (typeof raw.postId === 'string') postId = raw.postId.trim();
    else if (typeof raw.postId === 'number') {
      if (!Number.isSafeInteger(raw.postId) || raw.postId < 0) return { ok: false, reason: 'unsafe_id' };
      postId = String(raw.postId);
    }
    if (postId != null && !S.isPostId(postId)) return { ok: false, reason: 'bad_id' };

    var parsed = typeof raw.url === 'string' && raw.url ? S.parseXStatus(raw.url) : null;
    if (raw.url && !parsed && !postId) return { ok: false, reason: 'not_x_post' };
    if (parsed && postId && parsed.postId !== postId) return { ok: false, reason: 'id_mismatch' };
    postId = postId || (parsed && parsed.postId);
    if (!postId) return { ok: false, reason: 'no_id' };

    var a = raw.author && typeof raw.author === 'object' ? raw.author : {};
    var handle = S.isHandle(a.handle) ? a.handle : (parsed ? parsed.handle : '');
    var name = S.cleanText(a.name, L.nameChars) || (handle ? '@' + handle : '');

    var links = [];
    if (Array.isArray(raw.links)) {
      raw.links.slice(0, 20).forEach(function (l) {
        if (links.length >= L.linksPerItem) { notes.linksDropped++; return; }
        var u = l && typeof l === 'object' ? S.sanitizeUrl(l.url) : null;
        if (!u) { notes.linksDropped++; return; }
        var link = { url: u, domain: S.hostOf(u), title: S.cleanText(l.title, L.titleChars) || S.hostOf(u) };
        if (l.description) link.description = S.cleanText(l.description, 300);
        var image = S.sanitizeUrl(l.imageUrl);
        if (image && /^https:\/\//.test(image)) link.imageUrl = image;
        links.push(link);
      });
      if (raw.links.length > 20) notes.linksDropped += raw.links.length - 20;
    }

    var quote = null;
    if (raw.quote && typeof raw.quote === 'object' && !(opts && opts.inQuote)) {
      var q = normalizeSrc(raw.quote, now, { inQuote: true, allowLocalMedia: opts && opts.allowLocalMedia });
      if (q.ok) { quote = q.src; delete quote.quote; delete quote.replyTo; }
    }
    var replyTo = null;
    if (raw.replyTo && typeof raw.replyTo === 'object' && S.isPostId(String(raw.replyTo.postId || ''))) {
      replyTo = { postId: String(raw.replyTo.postId), handle: S.isHandle(raw.replyTo.handle) ? raw.replyTo.handle : '' };
    }

    var src = {
      postId: postId,
      url: handle ? 'https://x.com/' + handle + '/status/' + postId : 'https://x.com/i/web/status/' + postId,
      author: { name: name, handle: handle },
      text: S.cleanText(raw.text, L.textChars),
      postedAt: cleanDate(raw.postedAt, now),
      links: links,
      media: cleanMedia(raw.media, opts, notes),
      quote: quote,
      replyTo: replyTo
    };
    return { ok: true, src: src, notes: notes };
  }

  function defaultUser() {
    return { state: 'inbox', read: false, laterUntil: null, returned: false, tags: [], memo: '', genre: null, links: [], editedAt: null, decidedAt: null };
  }

  function makeItem(src, origin, now, user) {
    if (!ORIGINS[origin]) throw new Error('unknown origin');
    var t = iso(now);
    return {
      id: keyOf(src.postId),
      v: 1,
      rev: 1,
      src: src,
      meta: { origin: origin, firstSeenAt: t, fetchedAt: t, srcUpdatedAt: t, merged: 0, sources: {}, likedAt: null, lastSeenAt: t, missing: false },
      user: user || defaultUser()
    };
  }

  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // 取得元の値を統合する。user には一切触れない
  function mergeSrc(cur, incoming, now) {
    var next = JSON.parse(JSON.stringify(cur));
    var s = next.src;
    var changed = false;
    function set(path, val) {
      if (val == null || val === '' || (Array.isArray(val) && !val.length)) return; // 空の値で既存を消さない
      if (!same(s[path], val)) { s[path] = val; changed = true; }
    }
    set('text', incoming.text);
    set('postedAt', incoming.postedAt);
    set('links', incoming.links);
    set('media', incoming.media);
    set('quote', incoming.quote);
    set('replyTo', incoming.replyTo);
    if (incoming.author) {
      if (incoming.author.name && incoming.author.name !== '@' + incoming.author.handle && s.author.name !== incoming.author.name) { s.author.name = incoming.author.name; changed = true; }
      if (incoming.author.handle && s.author.handle !== incoming.author.handle) { s.author.handle = incoming.author.handle; changed = true; }
    }
    if (s.author.handle) s.url = 'https://x.com/' + s.author.handle + '/status/' + s.postId;
    if (!s.author.name && s.author.handle) s.author.name = '@' + s.author.handle;
    next.meta.fetchedAt = iso(now);
    next.meta.merged = (next.meta.merged || 0) + 1;
    if (changed) next.meta.srcUpdatedAt = iso(now);
    return { record: next, changed: changed };
  }

  var PATCHABLE = ['state', 'read', 'laterUntil', 'returned', 'tags', 'memo', 'genre', 'links', 'decidedAt'];

  // 画面からの変更を検査する
  function sanitizePatch(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('bad patch');
    var out = {};
    Object.keys(patch).forEach(function (k) {
      if (PATCHABLE.indexOf(k) === -1) throw new Error('field not editable: ' + k);
      var v = patch[k];
      if (k === 'state') { if (!STATES[v]) throw new Error('bad state'); out.state = v; }
      else if (k === 'read' || k === 'returned') out[k] = !!v;
      else if (k === 'laterUntil' || k === 'decidedAt') {
        if (v == null) out[k] = null;
        else { var d = cleanFutureDate(v); if (!d) throw new Error('bad date'); out[k] = d; }
      } else if (k === 'tags') {
        if (!Array.isArray(v)) throw new Error('bad tags');
        var tags = [];
        v.forEach(function (t) { var c = S.cleanTag(t); if (c && tags.indexOf(c) === -1) tags.push(c); });
        if (tags.length > L.tagsPerItem) throw new Error('too many tags');
        out.tags = tags;
      } else if (k === 'memo') out.memo = S.cleanText(v, L.memoChars);
      else if (k === 'links') {
        // あなたが貼ったリンク（投稿のリンク先を手で補う）。取得元の値とは別に持つ
        if (!Array.isArray(v) || v.length > L.linksPerItem) throw new Error('bad links');
        out.links = v.map(function (l) {
          var u = S.sanitizeUrl(l && typeof l === 'object' ? l.url : l);
          if (!u) throw new Error('bad link');
          return { url: u, domain: S.hostOf(u), title: S.cleanText(l && l.title, L.titleChars) || S.hostOf(u) };
        });
      }
      else if (k === 'genre') {
        if (v == null || v === '') out.genre = null;
        else { var g = S.cleanText(v, 16).replace(/[\s#]+/g, ''); if (!g) throw new Error('bad genre'); out.genre = g; }
      }
    });
    if (out.state === 'later' && !out.laterUntil) throw new Error('later needs a date');
    return out;
  }

  // base（画面が見ていた値）と現在値が食い違う項目があれば競合として返す
  function applyPatch(cur, base, patch, now) {
    var clean = sanitizePatch(patch);
    var conflicts = [];
    if (base) {
      Object.keys(clean).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(base, k) && !same(cur.user[k], base[k])) conflicts.push(k);
      });
    }
    if (conflicts.length) return { ok: false, conflict: true, fields: conflicts };
    var next = JSON.parse(JSON.stringify(cur));
    Object.keys(clean).forEach(function (k) { next.user[k] = clean[k]; });
    if (next.user.state !== 'later') next.user.laterUntil = null;
    next.user.editedAt = iso(now);
    return { ok: true, record: next };
  }

  // 操作 → 変更内容
  function verbPatch(verb, now, until) {
    var t = iso(now);
    if (verb === 'keep') return { state: 'kept', read: true, laterUntil: null, returned: false, decidedAt: t };
    if (verb === 'done') return { state: 'done', read: true, laterUntil: null, returned: false, decidedAt: t };
    if (verb === 'inbox') return { state: 'inbox', laterUntil: null, returned: false };
    if (verb === 'later') return { state: 'later', laterUntil: until, returned: false };
    throw new Error('unknown verb');
  }

  // あとでの時間が来たら読むに戻す。変えなければ null
  function promote(rec, now) {
    if (rec.user.state !== 'later' || !rec.user.laterUntil) return null;
    if (Date.parse(rec.user.laterUntil) > now) return null;
    var next = JSON.parse(JSON.stringify(rec));
    next.user.state = 'inbox';
    next.user.returned = true;
    next.user.laterUntil = null;
    next.user.editedAt = iso(now);
    return next;
  }

  // バックアップから戻すときの user の検査
  function sanitizeUser(raw) {
    var u = defaultUser();
    if (!raw || typeof raw !== 'object') return u;
    try {
      var p = {};
      PATCHABLE.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(raw, k)) p[k] = raw[k]; });
      if (p.state === 'later' && !p.laterUntil) delete p.state;
      var clean = sanitizePatch(p);
      Object.keys(clean).forEach(function (k) { u[k] = clean[k]; });
    } catch (e) { /* 壊れた user は既定値で受ける */ }
    var e = cleanFutureDate(raw.editedAt);
    u.editedAt = e;
    return u;
  }

  function hasUserEdits(u) {
    return u.state !== 'inbox' || u.read || u.tags.length > 0 || !!u.memo || !!u.laterUntil || !!u.genre || (u.links && u.links.length > 0);
  }

  function parseQuery(q) {
    var tags = [], words = [];
    String(q || '').slice(0, L.queryChars).trim().split(/\s+/).forEach(function (t) {
      if (!t) return;
      if (t.charAt(0) === '#' && t.length > 1) tags.push(t.slice(1).toLowerCase());
      else words.push(t.toLowerCase());
    });
    return { tags: tags, words: words };
  }
  function matches(it, pq) {
    var ok = pq.tags.every(function (t) { return it.user.tags.some(function (x) { return x.toLowerCase() === t; }); });
    if (!ok) return false;
    if (!pq.words.length) return true;
    var hay = [it.src.text, it.src.author.name, it.src.author.handle, it.user.memo, it.user.tags.join(' '), it.user.genre || '', it.src.quote ? it.src.quote.text : '']
      .concat(it.src.links.concat(it.user.links || []).map(function (l) { return l.title + ' ' + l.domain; })).join('\n').toLowerCase();
    return pq.words.every(function (w) { return hay.indexOf(w) !== -1; });
  }

  // 保存済みの記録を読み直すときの検査（壊れた記録で画面が落ちないように）
  function isValidRecord(r) {
    return !!(r && typeof r === 'object' && typeof r.id === 'string' && r.src && r.user && r.meta &&
      S.isPostId(r.src.postId) && r.id === keyOf(r.src.postId) && STATES[r.user.state] && Array.isArray(r.user.tags) &&
      ORIGINS[r.meta.origin] && typeof r.rev === 'number');
  }

  return Object.freeze({
    STATES: STATES, ORIGINS: ORIGINS, FICTIONAL: FICTIONAL, PATCHABLE: PATCHABLE,
    keyOf: keyOf, normalizeSrc: normalizeSrc, makeItem: makeItem, defaultUser: defaultUser,
    mergeSrc: mergeSrc, sanitizePatch: sanitizePatch, applyPatch: applyPatch, verbPatch: verbPatch,
    promote: promote, sanitizeUser: sanitizeUser, hasUserEdits: hasUserEdits,
    parseQuery: parseQuery, matches: matches, isValidRecord: isValidRecord, same: same
  });
});
