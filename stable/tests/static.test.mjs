// コード全体の決まりごとを機械的に確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const pub = walk(path.join(ROOT, 'public'));
const js = pub.filter((f) => f.endsWith('.js'));

test('画面のコードは外へ通信しない（fetch はローカル API の net.js だけ）', () => {
  for (const f of js) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    for (const bad of [/XMLHttpRequest/, /new WebSocket/, /EventSource\(/, /sendBeacon/, /importScripts/, /\beval\(/, /new Function\(/]) assert.doesNotMatch(s, bad, rel + ' ' + bad);
    if (!rel.endsWith(path.join('ui', 'net.js'))) assert.doesNotMatch(s, /\bfetch\(/, rel);
  }
  const net = fs.readFileSync(path.join(ROOT, 'public/js/ui/net.js'), 'utf8');
  for (const m of net.matchAll(/fetch\(([^,]+),/g)) assert.match(m[1].trim(), /^(path|'\/api\/health')$/, 'net.js の宛先はローカル API だけ');
});

test('外部の CDN・フォント・画像を読み込まない', () => {
  for (const f of pub.filter((x) => /\.(html|css)$/.test(x))) {
    const s = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /(src|href)\s*=\s*["']https?:/i, f);
    assert.doesNotMatch(s, /@import|url\(\s*["']?https?:/i, f);
  }
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
});

test('innerHTML に入るのは固定のアイコン定数だけ', () => {
  for (const f of js) {
    const s = fs.readFileSync(f, 'utf8');
    const n = (s.match(/\.innerHTML\s*=/g) || []).length;
    if (f.endsWith(path.join('ui', 'dom.js'))) assert.equal(n, 2, 'icon() と brand() のテンプレートだけ');
    else assert.equal(n, 0, f);
    assert.doesNotMatch(s, /insertAdjacentHTML|outerHTML\s*=|document\.write/, f);
  }
});

test('本人の記録を自動で消さない。取得元削除時は対応するメディアだけを除去', () => {
  const repo = fs.readFileSync(path.join(ROOT, 'public/js/store/repo.js'), 'utf8');
  const dels = repo.match(/t\.del\(/g) || [];
  assert.equal(dels.length, 5, '明示操作の3箇所と、Xの取得元削除・期限切れに伴うメディア削除だけ');
  assert.equal((repo.match(/t\.del\('items'/g) || []).length, 2, '本人の投稿記録を自動削除しない');
  const app = fs.readFileSync(path.join(ROOT, 'public/js/ui/app.js'), 'utf8');
  assert.doesNotMatch(app, /removeFictional|undoImport|deleteDatabase/, '画面本体から勝手に呼ばない');
});

test('旧版やブラウザ内の平文認証値に触れるコードがない', () => {
  for (const f of walk(ROOT).filter((x) => /\.(m?js)$/.test(x) && !x.includes(path.sep + 'tests' + path.sep))) {
    const s = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /document\.cookie/, f);
    assert.doesNotMatch(s, /localStorage\.setItem\(['"](token|auth|cookie)/i, f);
    assert.doesNotMatch(s, /\.\.\/\.\.\/(old|legacy)|legacy\.db|old\.db/i, f);
  }
});

test('公開記事の取得層に中継（CONNECT）経路がない', () => {
  const f = fs.readFileSync(path.join(ROOT, 'server/fetcher.mjs'), 'utf8');
  assert.doesNotMatch(f, /'CONNECT'|method:\s*'CONNECT'|createConnection|node:tls/);
  assert.match(f, /lookup: pinned/, '接続先は検査済みのアドレスに固定');
});
