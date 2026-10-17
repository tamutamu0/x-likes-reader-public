// margin server/fetcher — 公開 URL を 1 件だけ安全に取りに行く
//
//  - http/https のみ。ポートは 80/443 のみ。資格情報入り URL と秘密に見えるクエリは送らない
//  - 名前解決した全アドレスを検査し、1 つでも公開でないものがあれば拒否
//  - 検査したアドレスに接続先を固定する（接続時の再解決・DNS リバインドで別の宛先へ行かない）
//  - 接続後、実際の相手アドレスももう一度検査する
//  - 転送（リダイレクト）は 1 回ごとに同じ検査をやり直す。最大 5 回。https → http の格下げは拒否
//  - Cookie・認証ヘッダー・Referer は送らない。受け取った Set-Cookie は捨てる
//  - 大きさ（展開後も数える）・時間・種類（Content-Type）に上限
//  - ログイン・確認画面・有料の壁は「読めなかった」として返す。迂回しない
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import dns from 'node:dns';
import net from 'node:net';
import { createRequire } from 'node:module';
import { isPublicAddress, checkHostname } from './netguard.mjs';

const require = createRequire(import.meta.url);
const S = require('../public/js/core/safe.js');

export const KINDS = {
  article: {
    maxBytes: 3 * 1024 * 1024,
    accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5',
    types: ['text/html', 'application/xhtml+xml', 'text/plain']
  },
  image: {
    maxBytes: 8 * 1024 * 1024,
    accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9',
    types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  }
};

const UA = 'margin-local-reader/1.0 (personal reader; fetches one URL when the user asks)';

function fail(status, code, reason, extra) { return Object.assign({ ok: false, status, code, reason }, extra || {}); }

async function defaultResolve(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

/*
 * opts:
 *   kind: 'article' | 'image'
 *   timeoutMs, maxRedirects, signal
 *   resolve(host) -> [{address, family}]       （テストで差し替え）
 *   isAllowedAddress(ip) -> bool                 （既定：公開アドレスのみ）
 *   checkHost(host) -> {ok, code, reason}        （既定：netguard.checkHostname）
 *   allowedPorts: [80, 443]                       （テストで差し替え）
 *
 * 中継（プロキシ）経由の取得は持たない。名前解決の検査と接続先の固定ができなくなるため。
 * upstreamProxy などの指定があれば、取りに行かずに失敗として返す（fail-closed）。
 */
export async function safeFetch(rawUrl, opts = {}) {
  if (opts.upstreamProxy || opts.proxy || opts.agent) return fail('refused', 'proxy_not_supported', '中継経由の取得はしません（宛先の検査ができないため）');
  const kind = KINDS[opts.kind || 'article'];
  if (!kind) return fail('refused', 'bad_kind', '種類が不正です');
  const timeoutMs = opts.timeoutMs || 15000;
  const maxRedirects = opts.maxRedirects == null ? 5 : opts.maxRedirects;
  const resolve = opts.resolve || defaultResolve;
  const allowed = opts.isAllowedAddress || isPublicAddress;
  const checkHost = opts.checkHost || checkHostname;
  const deadline = Date.now() + timeoutMs;
  const redirects = [];

  let url = S.sanitizeUrl(String(rawUrl || ''));
  if (!url) return fail('refused', 'bad_url', 'http(s) の公開 URL ではありません（または安全でない形です）');

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return fail('refused', 'bad_scheme', 'http(s) だけを読み込みます');
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    if ((opts.allowedPorts || [80, 443]).indexOf(port) === -1) return fail('refused', 'bad_port', '80 / 443 以外のポートは読み込みません');
    const hc = checkHost(u.hostname);
    if (!hc.ok) return fail('refused', hc.code, hc.reason);

    const literal = u.hostname.replace(/^\[|\]$/g, '');
    let addrs;
    if (net.isIP(literal)) addrs = [{ address: literal, family: net.isIP(literal) }];
    else {
      try { addrs = await withDeadline(resolve(u.hostname), deadline); }
      catch (e) { return fail('failed', e && e.code === 'timeout' ? 'timeout' : 'dns_failed', e && e.code === 'timeout' ? '時間内に応答がありませんでした' : 'ホスト名を解決できませんでした'); }
    }
    if (!Array.isArray(addrs) || !addrs.length) return fail('failed', 'dns_failed', 'ホスト名を解決できませんでした');
    // 1 つでも公開でないアドレスが混ざっていれば拒否（DNS リバインドで内側を指させない）
    for (const a of addrs) if (!allowed(a.address)) return fail('refused', 'private_address', '公開されていないアドレスに解決されました');
    const target = addrs[0];

    let res;
    try { res = await request(u, port, target, kind, opts, deadline, allowed); }
    catch (e) { return fail(e.status || 'failed', e.code || 'network', e.reason || '接続できませんでした'); }

    const st = res.statusCode;
    if (st >= 300 && st < 400 && res.headers.location) {
      res.destroy();
      if (hop === maxRedirects) return fail('failed', 'too_many_redirects', '転送が多すぎます（' + maxRedirects + ' 回まで）');
      let next;
      try { next = new URL(String(res.headers.location), url).toString(); } catch (e) { return fail('failed', 'bad_redirect', '転送先の URL が不正です'); }
      const safe = S.sanitizeUrl(next);
      if (!safe) return fail('refused', 'bad_redirect', '転送先が安全な公開 URL ではありません');
      if (u.protocol === 'https:' && new URL(safe).protocol === 'http:') return fail('refused', 'downgrade', 'https から http への転送は読み込みません');
      redirects.push(safe);
      url = safe;
      continue;
    }
    if (st !== 200) {
      res.destroy();
      if (st === 401 || st === 407) return fail('blocked', 'login_required', 'ログインが必要なページです（迂回しません）');
      if (st === 402) return fail('blocked', 'paywall', '有料のページです（迂回しません）');
      if (st === 403) return fail('blocked', 'forbidden', 'アクセスが拒否されました（迂回しません）');
      if (st === 429) return fail('blocked', 'rate_limited', '相手のサイトが混雑・制限中です。時間をおいてください', { retryAfter: String(res.headers['retry-after'] || '').slice(0, 40) });
      if (st === 451) return fail('blocked', 'legal', '法的な理由で公開されていません');
      if (st === 404 || st === 410) return fail('failed', 'not_found', 'ページが見つかりません（' + st + '）');
      return fail('failed', 'http_' + st, '相手のサイトが ' + st + ' を返しました');
    }

    const ctRaw = String(res.headers['content-type'] || '').toLowerCase();
    const ct = ctRaw.split(';')[0].trim();
    if (kind.types.indexOf(ct) === -1) { res.destroy(); return fail('refused', 'content_type', '読み込まない種類です（' + (ct || '不明') + '）'); }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > kind.maxBytes) { res.destroy(); return fail('refused', 'too_large', '大きすぎます（上限 ' + Math.round(kind.maxBytes / 1048576) + 'MB）'); }

    let body;
    try { body = await readBody(res, kind.maxBytes, deadline, opts.signal); }
    catch (e) { return fail(e.status || 'failed', e.code || 'read_failed', e.reason || '読み込み中に失敗しました'); }
    const cm = /charset\s*=\s*"?([\w.:-]+)/i.exec(ctRaw);
    return { ok: true, finalUrl: url, redirects, contentType: ct, charset: cm ? cm[1].toLowerCase() : null, body, bytes: body.length };
  }
  return fail('failed', 'too_many_redirects', '転送が多すぎます');
}

function withDeadline(p, deadline) {
  const ms = Math.max(1, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { const e = new Error('timeout'); e.code = 'timeout'; reject(e); }, ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function err(status, code, reason) { const e = new Error(code); e.status = status; e.code = code; e.reason = reason; return e; }

function request(u, port, target, kind, opts, deadline, allowed) {
  return new Promise((resolve, reject) => {
    const headers = {
      'user-agent': UA,
      accept: kind.accept,
      'accept-language': 'ja,en;q=0.7',
      'accept-encoding': 'gzip, deflate, br',
      connection: 'close'
      // Cookie / Authorization / Referer は付けない
    };
    const path = u.pathname + u.search;
    const isHttps = u.protocol === 'https:';
    let done = false;
    const timer = setTimeout(() => { finish(err('failed', 'timeout', '時間内に応答がありませんでした')); }, Math.max(1, deadline - Date.now()));
    function finish(e, res) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e) { try { req && req.destroy(); } catch (x) { /* noop */ } reject(e); }
      else resolve(res);
    }
    if (opts.signal) opts.signal.addEventListener('abort', () => finish(err('failed', 'aborted', '中止しました')), { once: true });

    let req;
    const pinned = (hostname, options, cb) => {
      if (typeof options === 'function') { cb = options; options = {}; }
      if (options && options.all) cb(null, [{ address: target.address, family: target.family }]);
      else cb(null, target.address, target.family);
    };
    req = (isHttps ? https : http).request({
      host: u.hostname, port, path, method: 'GET', headers, agent: false,
      lookup: pinned, servername: net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? undefined : u.hostname
    });
    req.on('socket', (sock) => {
      sock.once('connect', () => {
        // 実際につながった相手をもう一度確かめる
        if (!allowed(sock.remoteAddress)) finish(err('refused', 'private_address', '接続先が公開アドレスではありませんでした'));
      });
    });
    wire(req);
    req.end();

    function wire(r) {
      r.on('response', (res) => {
        delete res.headers['set-cookie']; // 受け取った Cookie は保存しない
        finish(null, res);
      });
      r.on('error', (e) => {
        const code = e && e.code;
        if (code === 'ECONNREFUSED') finish(err('failed', 'refused_conn', '接続を拒否されました'));
        else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') finish(err('failed', 'dns_failed', 'ホスト名を解決できませんでした'));
        else if (code && String(code).indexOf('CERT') !== -1) finish(err('failed', 'tls', '証明書を確認できませんでした'));
        else finish(err('failed', 'network', '接続できませんでした'));
      });
    }
  });
}

function readBody(res, max, deadline, signal) {
  return new Promise((resolve, reject) => {
    const enc = String(res.headers['content-encoding'] || 'identity').toLowerCase().trim();
    let stream = res;
    if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
    else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
    else if (enc !== 'identity' && enc !== '') { res.destroy(); reject(err('refused', 'encoding', '読めない圧縮形式です')); return; }
    const chunks = [];
    let raw = 0, total = 0, over = false;
    res.on('data', (c) => { raw += c.length; if (raw > max) stop(err('refused', 'too_large', '大きすぎます')); });
    const timer = setTimeout(() => stop(err('failed', 'timeout', '時間内に読み終わりませんでした')), Math.max(1, deadline - Date.now()));
    if (signal) signal.addEventListener('abort', () => stop(err('failed', 'aborted', '中止しました')), { once: true });
    function stop(e) {
      if (over) return;
      over = true;
      clearTimeout(timer);
      try { res.destroy(); } catch (x) { /* noop */ }
      try { if (stream !== res) stream.destroy(); } catch (x) { /* noop */ }
      reject(e);
    }
    stream.on('data', (c) => {
      total += c.length;
      if (total > max) { stop(err('refused', 'too_large', '展開後の大きさが上限を超えました')); return; }
      chunks.push(c);
    });
    stream.on('end', () => { if (over) return; clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    stream.on('error', () => stop(err('failed', 'decode', '受け取ったデータを展開できませんでした')));
    res.on('error', () => stop(err('failed', 'network', '読み込み中に接続が切れました')));
  });
}

// 画像の中身が宣言どおりの形式か（先頭のバイト列で確かめる）
export function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.slice(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
