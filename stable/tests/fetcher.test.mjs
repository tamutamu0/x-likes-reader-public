// 公開記事の取得層のテスト。
// 実際のインターネットには出ず、127.0.0.1 の試験用サーバーと「試験用の宛先規則」で動きを確かめる。
// 本番の規則（公開アドレスだけ）が 127.0.0.1 を拒否することも、同じファイルで確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { safeFetch, sniffImage } from '../server/fetcher.mjs';

function serve(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const s = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res); });
    s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port, seen }));
  });
}
// 試験用：*.fic を 127.0.0.1 に、evil.fic を 10.0.0.1 に解決する
function testOpts(port, extra) {
  return Object.assign({
    kind: 'article',
    allowedPorts: [port],
    checkHost: (h) => (/\.fic$/.test(h) ? { ok: true } : { ok: false, code: 'reserved_domain', reason: 'x' }),
    resolve: async (h) => (h === 'evil.fic' ? [{ address: '10.0.0.1', family: 4 }] : h === 'mixed.fic' ? [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]),
    isAllowedAddress: (ip) => ip === '127.0.0.1' || ip === '::ffff:127.0.0.1',
    timeoutMs: 3000
  }, extra || {});
}
const HTML = '<!doctype html><html lang="ja"><head><title>架空の記事</title></head><body><p>本文です</p></body></html>';

test('本番の規則：127.0.0.1・内部名・メタデータは取りに行かない', async () => {
  const { s, port } = await serve((req, res) => res.end('ng'));
  try {
    for (const u of ['http://127.0.0.1:' + port + '/', 'http://localhost:' + port + '/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/', 'http://printer/', 'file:///etc/passwd', 'https://user:pw@example.com/']) {
      const r = await safeFetch(u, { allowedPorts: [80, 443, port] });
      assert.equal(r.ok, false, u);
      assert.equal(r.status, 'refused', u);
    }
    const r2 = await safeFetch('https://example.com:8443/', {});
    assert.equal(r2.code, 'bad_port');
  } finally { s.close(); }
});

test('解決結果に非公開アドレスが 1 つでも混ざれば拒否（DNS リバインド対策）', async () => {
  const { s, port, seen } = await serve((req, res) => res.end('ng'));
  try {
    const r = await safeFetch('http://mixed.fic:' + port + '/', testOpts(port, { isAllowedAddress: (ip) => ip === '127.0.0.1' }));
    assert.equal(r.code, 'private_address');
    assert.equal(seen.length, 0, '1 回も接続しない');
  } finally { s.close(); }
});

test('検査したアドレスに接続を固定し、接続後の相手も確かめる', async () => {
  const { s, port, seen } = await serve((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('set-cookie', 'track=1'); res.end(HTML); });
  try {
    const ok = await safeFetch('http://pub.fic:' + port + '/a?id=1&session=SECRET', testOpts(port));
    assert.equal(ok.ok, true);
    assert.equal(seen[0].headers.host, 'pub.fic:' + port, '名前は保ったまま、接続先は検査済みのアドレス');
    assert.equal(seen[0].url, '/a?id=1', '秘密に見えるクエリは送らない');
    for (const h of ['cookie', 'authorization', 'referer', 'proxy-authorization']) assert.equal(seen[0].headers[h], undefined, h);
    // 解決時は許可、接続後は不許可（=接続の時点で別の宛先になった）を再現
    let calls = 0;
    const r = await safeFetch('http://pub.fic:' + port + '/', testOpts(port, { isAllowedAddress: () => (++calls === 1) }));
    assert.equal(r.code, 'private_address');
  } finally { s.close(); }
});

test('転送は 1 回ごとに検査し直す・上限・格下げなし・危険な転送先なし', async () => {
  const { s, port } = await serve((req, res) => {
    if (req.url === '/to-evil') { res.writeHead(302, { location: 'http://evil.fic:' + port + '/' }); return res.end(); }
    if (req.url === '/to-js') { res.writeHead(302, { location: 'javascript:alert(1)' }); return res.end(); }
    if (req.url === '/to-meta') { res.writeHead(301, { location: 'http://169.254.169.254/' }); return res.end(); }
    if (req.url.startsWith('/loop')) { res.writeHead(302, { location: '/loop' + (Number(req.url.slice(5) || 0) + 1) }); return res.end(); }
    if (req.url === '/to-ok') { res.writeHead(307, { location: '/final' }); return res.end(); }
    res.setHeader('content-type', 'text/html'); res.end(HTML);
  });
  try {
    assert.equal((await safeFetch('http://pub.fic:' + port + '/to-evil', testOpts(port))).code, 'private_address');
    assert.equal((await safeFetch('http://pub.fic:' + port + '/to-js', testOpts(port))).code, 'bad_redirect');
    assert.equal((await safeFetch('http://pub.fic:' + port + '/to-meta', testOpts(port))).status, 'refused');
    assert.equal((await safeFetch('http://pub.fic:' + port + '/loop', testOpts(port))).code, 'too_many_redirects');
    const ok = await safeFetch('http://pub.fic:' + port + '/to-ok', testOpts(port));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.redirects, ['http://pub.fic:' + port + '/final']);
  } finally { s.close(); }
});

test('種類・大きさ（展開後も）・時間の上限', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024));
  const { s, port } = await serve((req, res) => {
    if (req.url === '/json') { res.setHeader('content-type', 'application/json'); return res.end('{}'); }
    if (req.url === '/svg') { res.setHeader('content-type', 'image/svg+xml'); return res.end('<svg onload=alert(1)>'); }
    if (req.url === '/big') { res.setHeader('content-type', 'text/html'); res.setHeader('content-length', String(10 * 1024 * 1024)); return res.end(); }
    if (req.url === '/chunked') { res.setHeader('content-type', 'text/html'); const c = Buffer.alloc(512 * 1024, 97); let n = 0; const t = setInterval(() => { if (res.destroyed || n++ > 20) { clearInterval(t); res.end(); return; } res.write(c); }, 1); return; }
    if (req.url === '/bomb') { res.setHeader('content-type', 'text/html'); res.setHeader('content-encoding', 'gzip'); return res.end(bomb); }
    if (req.url === '/hang') return; // 返事をしない
    res.end();
  });
  try {
    assert.equal((await safeFetch('http://pub.fic:' + port + '/json', testOpts(port))).code, 'content_type');
    assert.equal((await safeFetch('http://pub.fic:' + port + '/svg', testOpts(port, { kind: 'image' }))).code, 'content_type', 'SVG 画像は受け取らない');
    assert.equal((await safeFetch('http://pub.fic:' + port + '/big', testOpts(port))).code, 'too_large');
    assert.equal((await safeFetch('http://pub.fic:' + port + '/chunked', testOpts(port))).code, 'too_large');
    assert.equal((await safeFetch('http://pub.fic:' + port + '/bomb', testOpts(port))).code, 'too_large', '圧縮爆弾');
    const t0 = Date.now();
    const r = await safeFetch('http://pub.fic:' + port + '/hang', testOpts(port, { timeoutMs: 400 }));
    assert.equal(r.code, 'timeout');
    assert.ok(Date.now() - t0 < 2000);
  } finally { s.closeAllConnections && s.closeAllConnections(); s.close(); }
});

test('ログイン・有料・拒否・混雑は「読めなかった」として返す（迂回しない）', async () => {
  const { s, port, seen } = await serve((req, res) => { res.writeHead(Number(req.url.slice(1)), { 'retry-after': '120' }); res.end(); });
  try {
    const exp = { 401: 'login_required', 402: 'paywall', 403: 'forbidden', 429: 'rate_limited', 451: 'legal', 404: 'not_found', 500: 'http_500' };
    for (const code of Object.keys(exp)) {
      const r = await safeFetch('http://pub.fic:' + port + '/' + code, testOpts(port));
      assert.equal(r.code, exp[code]);
    }
    assert.equal(seen.length, 7, '1 件につき 1 回だけ。再試行で押し切らない');
  } finally { s.close(); }
});

test('中止できる', async () => {
  const { s, port } = await serve(() => {});
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await safeFetch('http://pub.fic:' + port + '/', testOpts(port, { signal: ac.signal }));
    assert.equal(r.code, 'aborted');
  } finally { s.closeAllConnections && s.closeAllConnections(); s.close(); }
});

test('画像は中身の先頭バイトで形式を確かめる', () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('<svg></svg>')), null);
});

test('中継（プロキシ）経由の取得はしない：指定されたら取りに行かずに失敗（fail-closed）', async () => {
  for (const o of [{ upstreamProxy: { host: '127.0.0.1', port: 8080 } }, { proxy: 'http://127.0.0.1:8080' }, { agent: {} }]) {
    const r = await safeFetch('https://example.com/', o);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'proxy_not_supported');
  }
});
