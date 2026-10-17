import type { Bindings } from './types';
import { validAccess } from './access';
import { ReaderStore } from './store';
export const COOKIE = '__Host-margin-session';
const opaque = /^[A-Za-z0-9_-]{43,128}$/;
export async function hashToken(token: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2,'0')).join('');
}
export async function authenticated(request: Request, env: Bindings) {
  // Owner sessions have a separate store. Link mode must be explicit; legacy
  // Bearer/Access alternatives cannot silently bypass either owner mode.
  if (env.AUTH_DB) {
    if (request.headers.has('Authorization')) return false;
    const cookies = request.headers.get('Cookie')?.split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));
    if (cookies?.length !== 1 || !opaque.test(cookies[0].slice(COOKIE.length+1))) return false;
    const ownerRequired=env.AUTH_MODE==='link' ? '' : ' AND EXISTS(SELECT 1 FROM owner_passkey)';
    return !!await env.AUTH_DB.prepare(`SELECT token_hash FROM device_sessions WHERE token_hash=? AND kind='web' AND revoked=0 AND expires_at>?${ownerRequired}`)
      .bind(await hashToken(cookies[0].slice(COOKIE.length+1)),new Date().toISOString()).first();
  }
  if(env.APP_ENV==='production')return false;
  if (!env.DB) return false;
  const authorization = request.headers.get('Authorization');
  if (authorization !== null) {
    if (!/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization)) return false;
    return new ReaderStore(env.DB).validSession(await hashToken(authorization.slice(7)), new Date().toISOString());
  }
  const cookie = request.headers.get('Cookie')?.split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
  if (cookie?.length === 1) {
    const token = cookie[0].slice(COOKIE.length + 1);
    if (opaque.test(token) && await new ReaderStore(env.DB).validSession(await hashToken(token), new Date().toISOString())) return true;
  }
  return validAccess(request, env);
}
export function loginPage() {
  // A fragment never goes to server logs or Referer. Its short-lived, single
  // use bootstrap is exchanged for a Secure, HttpOnly cookie. No X secrets.
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>margin ログイン</title><body><h1>margin</h1><p id="message">本人専用のページです。Macで作成したログインリンクを開くと、この端末で使えます。</p><script nonce="${nonce}">const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(token){document.getElementById('message').textContent='端末を接続しています…';fetch('/auth/session',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json','X-Margin-Request':'1'},body:JSON.stringify({token})}).then(r=>{if(!r.ok)throw Error();location.replace('/')}).catch(()=>document.getElementById('message').textContent='ログインリンクの期限が切れたか、使用済みです。Macで新しいリンクを作成してください。')}</script></body></html>`, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, 'X-Content-Type-Options':'nosniff' },
  });
}
export async function exchangeBootstrap(request: Request, env: Bindings, now = Date.now()) {
  if (!env.DB || request.method !== 'POST' || request.headers.get('Origin') !== new URL(request.url).origin ||
      request.headers.get('X-Margin-Request') !== '1' || !request.headers.get('Content-Type')?.startsWith('application/json')) return new Response(null, {status:403});
  const reader=request.body?.getReader();
  if(!reader)return new Response(null,{status:400});
  let size=0;const chunks:Uint8Array[]=[];
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>256){await reader.cancel();return new Response(null,{status:413});}chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let token;
  try { token = JSON.parse(new TextDecoder().decode(bytes)).token; } catch { return new Response(null, {status:400}); }
  if (typeof token !== 'string' || !opaque.test(token)) return new Response(null, {status:401});
  const session = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  const hash = await hashToken(token), sessionHash = await hashToken(session), time = new Date(now).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO device_sessions(token_hash,expires_at,revoked)
      SELECT ?,?,0 FROM browser_bootstrap WHERE token_hash=? AND consumed=0 AND expires_at>?
      RETURNING token_hash`).bind(sessionHash, new Date(now + 90 * 86400000).toISOString(), hash, time),
    env.DB.prepare('UPDATE browser_bootstrap SET consumed=1 WHERE token_hash=? AND consumed=0 AND expires_at>?').bind(hash,time),
  ]);
  if (!results[0].results.length) return new Response(null, {status:401});
  return new Response(null, {status:204,headers:{'Cache-Control':'no-store','Set-Cookie':`${COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${90*86400}`}});
}
