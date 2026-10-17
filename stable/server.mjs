// margin — ローカルサーバー（127.0.0.1 専用）
//
//   node server.mjs            → http://127.0.0.1:47321 を開く
//   MARGIN_PORT=47400 node server.mjs  でポートを変更
//
// 役割
//   1. public/ の画面を配る（外部の CDN・フォント・画像は使わない）
//   2. あなたが「記事を読み込む」「画像を読み込む」を押したときだけ、公開 URL を 1 件安全に取りに行く
//      （/api/article, /api/image。この画面からの依頼しか受け付けない）
//
// X の公式 API は server/x-service.mjs が担当。秘密を画面へ返さない。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { safeFetch, sniffImage } from './server/fetcher.mjs';
import { extractArticle, extractPlain, decodeBody } from './server/extract.mjs';
import { XService } from './server/x-service.mjs';

const require = createRequire(import.meta.url);
const S = require('./public/js/core/safe.js');
const APPROVALS = require('./public/js/approvals.js');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
export const VERSION = '2.0.0';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json'
};

function baseHeaders(extra) {
  return Object.assign({
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'cache-control': 'no-store'
  }, extra || {});
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, baseHeaders(Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }, code >= 400 ? { connection: 'close' } : {})));
  res.end(body);
}

// 公開記事の取得は、続けて大量に投げられないよう控えめにする
function makeLimiter() {
  let active = 0;
  const recent = [];
  const perHost = new Map();
  return {
    take(host) {
      const now = Date.now();
      while (recent.length && now - recent[0] > 60000) recent.shift();
      if (active >= 2) return '同時に読み込めるのは 2 件までです';
      if (recent.length >= 30) return '1 分あたりの読み込み回数の上限です。少し待ってください';
      const last = perHost.get(host) || 0;
      if (now - last < 2000) return '同じサイトへは 2 秒あけて読み込みます';
      active++; recent.push(now); perHost.set(host, now);
      return null;
    },
    release() { active = Math.max(0, active - 1); }
  };
}

export function createServer(opts = {}) {
  const port = opts.port;
  const fetchOpts = opts.fetchOpts || {};
  const limiter = makeLimiter();
  const x = opts.xService || null;
  const origin = () => 'http://127.0.0.1:' + server.address().port;

  async function readJson(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let over = false;
      // 上限を超えたら中身は捨てて読み流し、返事は 400 で返す（接続はその後閉じる）
      req.on('data', (c) => { size += c.length; if (size > max) { if (!over) { over = true; reject(new Error('too_large')); } } else chunks.push(c); });
      req.on('end', () => { if (over) return; try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(v && typeof v === 'object' ? v : {}); } catch (e) { reject(new Error('bad_json')); } });
      req.on('error', reject);
    });
  }

  // この画面（同じオリジン）からの依頼だけを受ける
  function apiAllowed(req) {
    if (req.headers['x-margin-request'] !== '1') return '画面からの依頼ではありません';
    const o = req.headers.origin;
    if (req.method === 'POST' && o !== origin()) return '別のサイトからの依頼は受け付けません';
    const sfs = req.headers['sec-fetch-site'];
    if (sfs && sfs !== 'same-origin') return '別のサイトからの依頼は受け付けません';
    return null;
  }

  async function handleArticle(req, res) {
    let body;
    try { body = await readJson(req, 4096); } catch (e) { return sendJson(res, 400, { status: 'refused', code: 'bad_request', reason: '依頼の形が不正です' }); }
    const url = S.sanitizeUrl(typeof body.url === 'string' ? body.url : '');
    if (!url) return sendJson(res, 200, { status: 'refused', code: 'bad_url', reason: 'http(s) の公開 URL ではありません' });
    const host = new URL(url).hostname;
    const busy = limiter.take(host);
    if (busy) return sendJson(res, 200, { status: 'refused', code: 'rate', reason: busy });
    try {
      const r = await safeFetch(url, Object.assign({ kind: 'article' }, fetchOpts));
      if (!r.ok) return sendJson(res, 200, { status: r.status, code: r.code, reason: r.reason });
      const text = decodeBody(r.body, r.charset);
      const a = r.contentType === 'text/plain' ? extractPlain(text) : extractArticle(text, r.finalUrl);
      if (a.wall && a.text.length < 600) {
        const why = { captcha: '確認画面（CAPTCHA）が表示されるページです', paywall: '有料の壁があるページです', login: 'ログインが必要なページです' }[a.wall];
        return sendJson(res, 200, { status: 'blocked', code: a.wall, reason: why + '（迂回しません）' });
      }
      if (!a.text) return sendJson(res, 200, { status: 'failed', code: 'no_text', reason: '本文の文字を取り出せませんでした' });
      return sendJson(res, 200, {
        status: 'ok', finalUrl: r.finalUrl, redirects: r.redirects, contentType: r.contentType, bytes: r.bytes,
        title: a.title, siteName: a.siteName, byline: a.byline, publishedAt: a.publishedAt, lang: a.lang,
        excerpt: a.excerpt, text: a.text, notes: a.notes
      });
    } finally { limiter.release(); }
  }

  async function handleImage(req, res) {
    let body;
    try { body = await readJson(req, 4096); } catch (e) { return sendJson(res, 400, { status: 'refused', code: 'bad_request', reason: '依頼の形が不正です' }); }
    const url = S.sanitizeUrl(typeof body.url === 'string' ? body.url : '');
    if (!url) return sendJson(res, 200, { status: 'refused', code: 'bad_url', reason: 'http(s) の公開 URL ではありません' });
    const busy = limiter.take(new URL(url).hostname);
    if (busy) return sendJson(res, 200, { status: 'refused', code: 'rate', reason: busy });
    try {
      const r = await safeFetch(url, Object.assign({ kind: 'image' }, fetchOpts));
      if (!r.ok) return sendJson(res, 200, { status: r.status, code: r.code, reason: r.reason });
      const real = sniffImage(r.body);
      if (!real || real !== r.contentType) return sendJson(res, 200, { status: 'refused', code: 'not_image', reason: '中身が宣言どおりの画像ではありません' });
      return sendJson(res, 200, { status: 'ok', contentType: real, bytes: r.bytes, data: r.body.toString('base64') });
    } finally { limiter.release(); }
  }

  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400, baseHeaders()); return res.end('bad path'); }
    if (rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) { res.writeHead(400, baseHeaders()); return res.end('bad path'); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403, baseHeaders()); return res.end('forbidden'); }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext];
    if (!type) { res.writeHead(404, baseHeaders({ 'content-type': 'text/plain; charset=utf-8' })); return res.end('not found'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, baseHeaders({ 'content-type': 'text/plain; charset=utf-8' })); return res.end('not found'); }
      res.writeHead(200, baseHeaders({ 'content-type': type, 'content-length': st.size }));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const p = server.address().port;
      const host = String(req.headers.host || '');
      // 名前で入ってきた場合は 127.0.0.1 に寄せる（保存先がオリジンごとに分かれるため。DNS リバインド対策も兼ねる）
      if (host === 'localhost:' + p) { res.writeHead(308, baseHeaders({ location: 'http://127.0.0.1:' + p + (req.url || '/') })); return res.end(); }
      if (host !== '127.0.0.1:' + p) { res.writeHead(403, baseHeaders({ 'content-type': 'text/plain; charset=utf-8' })); return res.end('forbidden host'); }
      const u = new URL(req.url || '/', 'http://127.0.0.1:' + p);
      if (u.pathname === '/oauth/x/callback' && req.method === 'GET') {
        try {
          const cookie = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('margin-x-state='))?.slice('margin-x-state='.length);
          if (!x) throw new Error('unconfigured');
          await x.finishAuth(u.searchParams.get('state'), u.searchParams.get('code'), cookie);
          res.writeHead(303, baseHeaders({location:'/?x=connected', 'set-cookie':'margin-x-state=; Max-Age=0; Path=/oauth/x; HttpOnly; SameSite=Lax'})); res.end();
          x.sync().catch(() => {});
        } catch {
          res.writeHead(303, baseHeaders({location:'/?x=auth_failed', 'set-cookie':'margin-x-state=; Max-Age=0; Path=/oauth/x; HttpOnly; SameSite=Lax'})); res.end();
        }
        return;
      }
      if (u.pathname.startsWith('/api/')) {
        const bad = apiAllowed(req);
        if (bad) return sendJson(res, 403, { status: 'refused', code: 'forbidden', reason: bad });
        if (u.pathname === '/api/health' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, app: 'margin', version: VERSION, xLikes: x?.status().connected ? 'connected' : 'not_connected', jsonFileIO: APPROVALS.jsonFileIO ? 'approved_local' : 'awaiting_approval', fetchMode: 'direct' });
        }
        if (u.pathname === '/api/x/status' && req.method === 'GET') return sendJson(res, 200, x ? x.status() : {status:'ok', configured:false, connected:false});
        if (u.pathname === '/api/x/items' && req.method === 'GET') return sendJson(res, 200, x ? x.snapshot() : {status:'ok',revision:0,entries:[]});
        if (req.method !== 'POST') return sendJson(res, 405, { status: 'refused', code: 'method', reason: 'POST だけを受け付けます' });
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return sendJson(res, 415, { status: 'refused', code: 'type', reason: 'JSON だけを受け付けます' });
        if (u.pathname.startsWith('/api/x/')) {
          if (!x) return sendJson(res, 503, {status:'failed',reason:'not_configured'});
          if (u.pathname === '/api/x/connect') {
            const auth = x.startAuth(origin() + '/oauth/x/callback');
            res.setHeader('set-cookie', 'margin-x-state='+auth.cookie+'; Max-Age=300; Path=/oauth/x; HttpOnly; SameSite=Lax');
            return sendJson(res, 200, {status:'ok',url:auth.url});
          }
          if (u.pathname === '/api/x/sync') return sendJson(res,200,await x.sync());
          if (u.pathname === '/api/x/backfill') return sendJson(res,200,await x.sync({backfill:true}));
          if (u.pathname === '/api/x/pause') {
            const body = await readJson(req,1024);
            if (typeof body.paused !== 'boolean') return sendJson(res,400,{status:'failed',reason:'bad_request'});
            return sendJson(res,200,x.pause(body.paused));
          }
          if (u.pathname === '/api/x/post') {
            const body = await readJson(req,1024);
            if (!S.isPostId(body.postId)) return sendJson(res,400,{status:'failed',reason:'bad_request'});
            return sendJson(res,200,await x.readPost(body.postId));
          }
          if (u.pathname === '/api/x/disconnect') return sendJson(res,200,await x.disconnect());
        }
        if (u.pathname === '/api/article') return handleArticle(req, res);
        if (u.pathname === '/api/image') return handleImage(req, res);
        return sendJson(res, 404, { status: 'refused', code: 'not_found', reason: 'ありません' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, baseHeaders({ allow: 'GET, HEAD' })); return res.end(); }
      return serveStatic(req, res, u.pathname);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { status: 'failed', code: 'internal', reason: 'サーバー内部のエラー' });
      else res.destroy();
    }
  });
  server.listen(port == null ? 47321 : port, '127.0.0.1');
  if (x) { x.startTimer(); server.on('close', () => x.close()); }
  return server;
}

// 直接起動されたとき
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MARGIN_PORT || 47321);
  const fetchOpts = {};
  // 中継（プロキシ）経由の取得は廃止。宛先の検査（DNS・接続先の固定）が効かなくなるため、指定されたら起動しない
  for (const k of ['MARGIN_UPSTREAM_PROXY', 'MARGIN_UPSTREAM_CA', 'NODE_USE_ENV_PROXY']) {
    if (process.env[k]) { console.error(k + ' は使えません（中継経由の取得は廃止しました）。指定を外して起動してください。'); process.exit(1); }
  }
  // Optional, ignored configuration. Never read credentials from public files.
  const configFile = path.join(ROOT,'.env.x.local');
  if (fs.existsSync(configFile)) process.loadEnvFile(configFile);
  const xService = process.env.X_CLIENT_ID ? new XService({directory:path.join(ROOT,'data','x'), clientId:process.env.X_CLIENT_ID,clientSecret:process.env.X_CLIENT_SECRET || '', ownerHandle:process.env.X_OWNER_HANDLE || ''}) : null;
  const server = createServer({ port, fetchOpts, xService });
  server.on('listening', () => {
    console.log('margin を起動しました：http://127.0.0.1:' + server.address().port);
    console.log('（この端末の中だけで動きます。止めるときは Ctrl+C）');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error('ポート ' + port + ' は使用中です。MARGIN_PORT=47400 node server.mjs のように別のポートで起動してください（保存先はポートごとに別になります）');
    else console.error(e.message);
    process.exit(1);
  });
}
