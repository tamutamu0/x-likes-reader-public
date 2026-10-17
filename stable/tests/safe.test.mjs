import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from './helpers.mjs';

test('危険な URL は捨てる', () => {
  const bad = ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://a.com/x', 'ftp://a.com/', 'https://user:pass@a.com/', 'https://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://printer/', 'https://a.com/\u0000x', 'https://a .com/', 'https://a.com/' + 'x'.repeat(3000)];
  for (const u of bad) assert.equal(S.sanitizeUrl(u), null, u);
});

test('認証値・追跡値のクエリは取り除き、ほかは残す', () => {
  const u = S.sanitizeUrl('https://news.example.org/a?id=3&auth_token=SECRET&session=abc&utm_source=x&apiKey=k&access_token=t&q=ok#access_token=zzz');
  assert.ok(u);
  assert.ok(!/SECRET|session|utm_source|apiKey|access_token|zzz/i.test(u), u);
  assert.match(u, /id=3/);
  assert.match(u, /q=ok/);
});

test('秘密に見えるキーの判定（author は対象外）', () => {
  for (const k of ['token', 'auth_token', 'authToken', 'Authorization', 'cookie', 'set-cookie', 'ct0', 'csrf_token', 'apiKey', 'api_key', 'password', 'client_secret', 'sessionid']) assert.equal(S.isSecretKey(k), true, k);
  for (const k of ['author', 'authorName', 'text', 'postId', 'tags', 'keyword', 'monkey', 'url']) assert.equal(S.isSecretKey(k), false, k);
});

test('X の投稿 URL だけを読み取り、正規化する', () => {
  assert.deepEqual(S.parseXStatus('https://twitter.com/abc_1/status/123?s=20&t=xyz'), { handle: 'abc_1', postId: '123', url: 'https://x.com/abc_1/status/123' });
  assert.equal(S.parseXStatus('https://mobile.twitter.com/abc/status/9').postId, '9');
  assert.equal(S.parseXStatus('https://x.com.evil.example/abc/status/1'), null);
  assert.equal(S.parseXStatus('https://evilx.com/abc/status/1'), null);
  assert.equal(S.parseXStatus('https://x.com/abc/likes'), null);
  assert.equal(S.parseXStatus('https://x.com/abc/status/1x'), null);
});

test('文字の掃除：制御文字・双方向制御文字を除き、長さを制限する', () => {
  assert.equal(S.cleanText('a‮b\u0000c‏d'), 'abcd');
  assert.equal(S.cleanText('<script>alert(1)</script>'), '<script>alert(1)</script>', 'HTML は文字のまま（実行はしない）');
  assert.equal(Array.from(S.cleanText('あ'.repeat(5000))).length, S.LIMITS.textChars + 1);
  assert.equal(S.cleanText({ toString() { return 'x'; } }), '');
});
