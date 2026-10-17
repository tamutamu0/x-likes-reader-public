/*
 * margin core/safe — 信頼しない入力の安全処理
 *
 *  - 投稿テキスト・JSON・URL はすべて信頼しない入力として扱う
 *  - HTML として解釈しない（画面は textContent のみで描画する）
 *  - http/https 以外、資格情報入り、ローカル/プライベート宛ての URL は捨てる
 *  - 認証値・セッション・署名に見えるクエリ、追跡用クエリは取り除く
 *  - 上限値はここに集約する
 *
 * ブラウザ（classic script）と Node（CommonJS）の両方で読み込める。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Margin = root.Margin || {}; root.Margin.safe = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LIMITS = Object.freeze({
    jsonBytes: 20 * 1024 * 1024,  // 取り込む JSON の最大バイト数
    items: 5000,                  // 1 回の取り込みの最大件数（超えたら全体を拒否）
    totalItems: 50000,            // 保存できる最大件数
    textChars: 4000,              // 投稿本文
    nameChars: 60,
    titleChars: 200,
    urlChars: 2048,
    linksPerItem: 4,
    tagsPerItem: 12,
    tagChars: 24,
    memoChars: 2000,
    queryChars: 120,
    pagesPerRun: 5,               // 収集 1 回のページ上限
    postsPerPage: 100,            // 1 ページから受け取る最大件数
    minIntervalMs: 6 * 3600e3,    // 収集の最短間隔
    backoffCapMs: 48 * 3600e3,    // 混雑時の待ちの上限
    leaseMs: 10 * 60e3,           // 実行中の印の有効期限（落ちたタブの印を残さない）
    logEntries: 200
  });

  // 秘密に見えるキー（単語単位で判定。author や authorName は対象外）
  var SECRET_WORDS = {
    token: 1, tokens: 1, cookie: 1, cookies: 1, session: 1, sessionid: 1, sid: 1, csrf: 1, xsrf: 1,
    bearer: 1, oauth: 1, oauth2: 1, password: 1, passwd: 1, pwd: 1, secret: 1, secrets: 1, apikey: 1,
    signature: 1, sig: 1, authorization: 1, auth: 1, credential: 1, credentials: 1, ct0: 1, kdt: 1,
    twid: 1, jwt: 1, otp: 1, mfa: 1, pin: 1, privatekey: 1
  };
  var SECRET_WHOLE = { auth_token: 1, access_token: 1, refresh_token: 1, api_key: 1, x_csrf_token: 1, guest_id: 1, set_cookie: 1, private_key: 1, client_secret: 1 };

  var SECRET_FLAT = {};
  Object.keys(SECRET_WHOLE).forEach(function (k) { SECRET_FLAT[k.replace(/_/g, '')] = 1; });

  function keyWords(key) {
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }
  function isSecretKey(key) {
    if (typeof key !== 'string' || !key) return false;
    var norm = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (SECRET_WHOLE[norm]) return true;
    var flat = norm.replace(/_/g, '');
    if (SECRET_WORDS[flat] || SECRET_FLAT[flat]) return true;   // apiKey, authToken など
    var words = keyWords(key);
    for (var i = 0; i < words.length; i++) if (SECRET_WORDS[words[i]]) return true;
    return false;
  }

  var TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|ref_src|ref_url|igshid|yclid)$/i;

  // 制御文字（改行・タブ以外）、双方向制御文字、ゼロ幅の一部を除去
  var CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩﻿]/g;

  function cleanText(value, max) {
    if (value == null) return '';
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    var s = String(value).replace(/\r\n?/g, '\n').replace(CONTROL, '');
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    var limit = max || LIMITS.textChars;
    if (s.length > limit) s = Array.from(s).slice(0, limit).join('') + '…';
    return s;
  }

  function isPrivateHost(host) {
    var h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || /\.localhost$/.test(h) || h === '0.0.0.0' || h === '::' || h === '::1') return true;
    if (/\.(local|internal|lan|home|arpa)$/.test(h)) return true;
    var m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      var a = +m[1], b = +m[2];
      if (a === 10 || a === 127 || a === 0) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
      return false;
    }
    if (/^(fc|fd|fe8|fe9|fea|feb)/.test(h) && h.indexOf(':') !== -1) return true;
    if (h.indexOf('.') === -1) return true; // 単一ラベルのホスト名は社内向けとみなす
    return false;
  }

  // 安全な http(s) URL 文字列か null を返す
  function sanitizeUrl(raw) {
    if (typeof raw !== 'string') return null;
    var trimmed = raw.trim();
    if (!trimmed || trimmed.length > LIMITS.urlChars) return null;
    if (/[\u0000-\u001F\u007F\s]/.test(trimmed)) return null;   // 途中の空白・改行・制御文字で細工した URL を拒否
    var u;
    try { u = new URL(trimmed); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    if (!u.hostname || isPrivateHost(u.hostname)) return null;
    var drop = [];
    u.searchParams.forEach(function (_v, k) { if (isSecretKey(k) || TRACKING_PARAM.test(k)) drop.push(k); });
    drop.forEach(function (k) { u.searchParams.delete(k); });
    if (u.hash && /(token|auth|session|code|key)=/i.test(u.hash)) u.hash = '';
    return u.toString();
  }

  var X_HOSTS = { 'x.com': 1, 'www.x.com': 1, 'mobile.x.com': 1, 'twitter.com': 1, 'www.twitter.com': 1, 'mobile.twitter.com': 1 };

  function isHandle(h) { return typeof h === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(h); }
  function isPostId(id) { return typeof id === 'string' && /^\d{1,25}$/.test(id); }

  // X の投稿 URL → { handle, postId, url }（正規化した x.com の URL）。該当しなければ null
  function parseXStatus(raw) {
    var safe = sanitizeUrl(raw);
    if (!safe) return null;
    var u = new URL(safe);
    if (!X_HOSTS[u.hostname.toLowerCase()]) return null;
    var m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/(?:photo|video)\/\d+)?\/?$/);
    if (!m) return null;
    return { handle: m[1], postId: m[2], url: 'https://x.com/' + m[1] + '/status/' + m[2] };
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function cleanTag(value) {
    return cleanText(value, LIMITS.tagChars).replace(/^#+/, '').replace(/[\s#,]+/g, '');
  }

  // オブジェクト中の秘密キーを数える（取り込み時の報告用）。値は読まない
  function countSecretKeys(obj, depthLimit) {
    var n = 0;
    var stack = [{ v: obj, d: 0 }];
    var seen = 0;
    while (stack.length) {
      var cur = stack.pop();
      if (!cur.v || typeof cur.v !== 'object' || cur.d > (depthLimit || 8)) continue;
      if (++seen > 200000) break;
      var keys = Object.keys(cur.v);
      for (var i = 0; i < keys.length; i++) {
        if (isSecretKey(keys[i])) { n++; continue; }
        stack.push({ v: cur.v[keys[i]], d: cur.d + 1 });
      }
    }
    return n;
  }

  // 文字列の UTF-8 バイト数
  function byteLength(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
    return Buffer.byteLength(str, 'utf8');
  }

  return Object.freeze({
    LIMITS: LIMITS,
    cleanText: cleanText,
    sanitizeUrl: sanitizeUrl,
    parseXStatus: parseXStatus,
    isSecretKey: isSecretKey,
    countSecretKeys: countSecretKeys,
    isHandle: isHandle,
    isPostId: isPostId,
    isPrivateHost: isPrivateHost,
    cleanTag: cleanTag,
    hostOf: hostOf,
    byteLength: byteLength
  });
});
