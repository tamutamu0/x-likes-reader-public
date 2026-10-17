// Official X API only. Credentials and source cache stay on this Mac.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../public/js/core/model.js');
const DAY = 86400000;
const SCOPES = 'tweet.read users.read like.read offline.access';
const random = () => crypto.randomBytes(32).toString('base64url');

export function normalizePosts(data, users = []) {
  const authors = new Map(users.map(u => [u.id, u]));
  return (data || []).flatMap(p => {
    if (!p || typeof p.id !== 'string' || p.withheld) return [];
    const a = authors.get(p.author_id) || {};
    const note = p.note_post || p.note_tweet;
    const entities = note?.entities || p.entities;
    const n = M.normalizeSrc({ postId: p.id, text: note?.text || p.text,
      postedAt: p.created_at, author: {name: a.name || 'X の投稿', handle: a.username || p.username},
      links: (entities?.urls || []).map(l => ({url: l.unwound_url || l.expanded_url || l.url, title: l.title})),
    }, Date.now());
    return n.ok ? [{src: n.src, authorId: p.author_id || null}] : [];
  });
}

export class XService {
  constructor({directory, clientId = '', clientSecret = '', ownerHandle = '', freeStopAt = process.env.X_FREE_STOP_AT || '', fetchImpl = fetch, now = Date.now}) {
    this.clientId = clientId; this.clientSecret = clientSecret; this.ownerHandle = ownerHandle; this.fetch = fetchImpl; this.now = now;
    const deadline=Date.parse(freeStopAt);
    this.freeEnd=Number.isFinite(deadline) && deadline>0 ? deadline : 0;
    this.busy = false; this.transactions = new Map();
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const keyFile = path.join(directory, 'vault.key');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), {mode: 0o600, flag: 'wx'});
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('invalid vault');
    this.db = new DatabaseSync(path.join(directory, 'x.sqlite'));
    fs.chmodSync(path.join(directory, 'x.sqlite'), 0o600);
    this.db.exec(`PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, source TEXT, author_id TEXT, fetched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS viewed (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS authors (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, units INTEGER NOT NULL, kind TEXT NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(posts)').all().some(c => c.name === 'source_status')) this.db.exec("ALTER TABLE posts ADD COLUMN source_status TEXT NOT NULL DEFAULT 'available'");
    if (!this.db.prepare('PRAGMA table_info(posts)').all().some(c => c.name === 'feed_order')) this.db.exec('ALTER TABLE posts ADD COLUMN feed_order INTEGER; UPDATE posts SET feed_order=rowid');
    if (!this.get('budgetVersion')) { this.db.exec("UPDATE ledger SET kind='bootstrap_' || kind WHERE kind IN ('identity','likes_and_authors')"); this.set('budgetVersion',2); }
    if (this.get('budgetVersion') < 3) {
      // One-time migration: continue the user-authorized initial import after removing profile lookup cost.
      if (!this.get('bootstrapDone') && this.get('reason') === 'budget') { this.set('paused',false); this.set('reason',null); this.set('nextAllowedAt',null); }
      this.set('budgetVersion',3);
    }
  }
  get(k, fallback = null) { const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(k); return r ? JSON.parse(r.value) : fallback; }
  set(k, value) { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(value)); }
  seal(v) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv); const body = Buffer.concat([cipher.update(JSON.stringify(v)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'); }
  unseal(v) { const b = Buffer.from(v, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', this.key, b.subarray(0,12)); cipher.setAuthTag(b.subarray(12,28)); return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString()); }
  tokens() { const v = this.get('tokens'); return v ? this.unseal(v) : null; }
  status() {
    return {status:'ok', configured: !!this.clientId, connected: !!this.get('tokens'), account: this.get('account'),
      paused: this.get('paused', false), reason: this.get('reason'), running: this.busy,
      lastSuccessAt: this.get('lastSuccessAt'), nextAllowedAt: this.get('nextAllowedAt'), lastResult: this.get('lastResult'),
      bootstrapTarget: 1000, bootstrapImported: this.get('bootstrapImported',0),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,
      availableCount: this.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE source IS NOT NULL').get().n,
      budget: {reservedUsd: this.used()/1000000, monthReservedUsd: this.used(true)/1000000, totalCapUsd: 8, monthCapUsd: 1, bootstrapCapUsd: 5, bootstrapReservedUsd: this.used(false,true)/1000000, stopsAt: this.freeEnd ? new Date(this.freeEnd).toISOString() : null},
      automatic: 'local_server_24h', backfillAvailable: !!this.get('backfillCursor')};
  }
  used(month = false, bootstrap = false) { const d = new Date(this.now()), start = month ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) : 0; const clause = bootstrap ? " AND kind LIKE 'bootstrap_%'" : month ? " AND kind NOT LIKE 'bootstrap_%'" : ''; return this.db.prepare('SELECT COALESCE(SUM(units),0) AS n FROM ledger WHERE at>=?'+clause).get(start).n; }
  reserve(units, kind) {
    // Reserve a conservative upper bound BEFORE any network request; failed/ambiguous calls keep the reservation.
    const bootstrap = kind.startsWith('bootstrap_');
    if (this.now() >= this.freeEnd || this.used() + units > 8000000 || (bootstrap ? this.used(false,true) + units > 5000000 : this.used(true) + units > 1000000)) throw Object.assign(new Error('budget'), {code:'budget'});
    return this.db.prepare('INSERT INTO ledger(at,units,kind) VALUES (?,?,?)').run(this.now(), units, kind).lastInsertRowid;
  }
  startAuth(redirectUri) {
    if (!this.clientId) throw new Error('not_configured');
    for (const [k,v] of this.transactions) if (v.expires < this.now()) this.transactions.delete(k);
    if (this.transactions.size >= 5) throw new Error('auth_busy');
    const state = random(), verifier = random(), cookie = random();
    this.transactions.set(state, {verifier, cookie, redirectUri, expires:this.now()+300000});
    const u = new URL('https://x.com/i/oauth2/authorize');
    u.search = new URLSearchParams({response_type:'code',client_id:this.clientId,redirect_uri:redirectUri,scope:SCOPES,state,
      code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
    return {url:u.href, cookie};
  }
  async tokenRequest(params) {
    const headers = {'Content-Type':'application/x-www-form-urlencoded'};
    if (this.clientSecret) headers.Authorization = 'Basic ' + Buffer.from(this.clientId+':'+this.clientSecret).toString('base64');
    else params.client_id = this.clientId;
    const r = await this.fetch('https://api.x.com/2/oauth2/token', {method:'POST',headers,body:new URLSearchParams(params),redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!r.ok) throw Object.assign(new Error('oauth_failed'), {code:'auth'});
    const t = await r.json();
    if (typeof t.access_token !== 'string' || !Number.isFinite(t.expires_in)) throw new Error('bad_token');
    return {...t, expiresAt:this.now()+t.expires_in*1000};
  }
  async finishAuth(state, code, cookie) {
    const t = this.transactions.get(state);
    if (!t || t.expires < this.now() || !cookie || cookie !== t.cookie || !code || code.length > 1024) throw new Error('invalid_state');
    this.transactions.delete(state);
    if (this.busy) throw new Error('busy');
    this.busy = true;
    try {
      const tokens = await this.tokenRequest({grant_type:'authorization_code',code,redirect_uri:t.redirectUri,code_verifier:t.verifier});
      const granted = new Set((tokens.scope || '').split(' '));
      if (!SCOPES.split(' ').every(s => granted.has(s)) || !tokens.refresh_token) throw new Error('missing_scope');
      this.reserve(10000, 'bootstrap_identity');
      const me = await this.api('/2/users/me', tokens.access_token);
      if (!/^\d{1,19}$/.test(me.data?.id || '') || !me.data?.username) throw new Error('bad_identity');
      const previous = this.get('account');
      if (previous && previous.id !== me.data.id) throw new Error('different_account');
      this.set('tokens', this.seal(tokens)); this.set('account', {id:me.data.id,handle:me.data.username,name:me.data.name});
      this.set('paused',false); this.set('reason',null);
      return this.status();
    } finally { this.busy = false; }
  }
  async accessToken() {
    let t = this.tokens();
    if (!t) throw Object.assign(new Error('auth'), {code:'auth'});
    if (t.expiresAt <= this.now()+60000) {
      try { t = await this.tokenRequest({grant_type:'refresh_token',refresh_token:t.refresh_token}); this.set('tokens',this.seal(t)); }
      catch { this.set('tokens',null); throw Object.assign(new Error('auth'), {code:'auth'}); }
    }
    return t.access_token;
  }
  async api(endpoint, token) {
    const r = await this.fetch('https://api.x.com'+endpoint, {headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});
    if (!r.ok) {
      const reset = Number(r.headers.get('x-rate-limit-reset'))*1000;
      throw Object.assign(new Error('x_request_failed'), {code: r.status === 429 ? 'rate_limit' : [401,403].includes(r.status) ? 'auth' : r.status === 402 ? 'credits' : 'request', retryAt:Number.isFinite(reset) ? reset : null});
    }
    return r.json();
  }
  async authorsFor(posts) {
    // Names are optional. Reuse previous local data, never pay for profile lookup.
    const ids = [...new Set(posts.map(p=>p.author_id).filter(id=>/^\d{1,19}$/.test(id || '')))];
    return ids.flatMap(id => { const a = this.db.prepare('SELECT value FROM authors WHERE id=?').get(id); return a ? [JSON.parse(a.value)] : []; });
  }
  save(posts, users, orderBase = null) {
    const n = normalizePosts(posts,users), time = this.now();
    let order = orderBase ?? this.db.prepare('SELECT COALESCE(MAX(feed_order),0)+1 AS n FROM posts').get().n;
    for (const p of n) this.db.prepare("INSERT INTO posts(id,source,author_id,fetched,source_status,feed_order) VALUES (?,?,?,?,'available',?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,author_id=excluded.author_id,fetched=excluded.fetched,source_status='available'").run(p.src.postId,JSON.stringify(p.src),p.authorId,time,order++);
    this.bump(); return n.length;
  }
  bump() { this.set('revision',this.get('revision',0)+1); }
  async refreshStale(token) {
    const stale = this.db.prepare('SELECT posts.id FROM posts JOIN viewed ON viewed.id=posts.id WHERE source IS NOT NULL AND fetched<? AND viewed.at>? ORDER BY fetched LIMIT 20').all(this.now()-6*DAY,this.now()-7*DAY).map(r=>r.id);
    if (!stale.length || this.get('paused')) return;
    this.reserve(stale.length*5000,'content_refresh');
    const r = await this.api('/2/tweets?'+new URLSearchParams({ids:stale.join(','),'tweet.fields':'author_id,created_at,entities,note_tweet'}),token);
    const data = r.data || [];
    this.save(data,await this.authorsFor(data,token));
    for (const e of r.errors || []) { const id = e.resource_id || e.value; if (stale.includes(id) && (e.type?.includes('resource-not-found') || e.status === 403 || e.status === 404)) this.db.prepare("UPDATE posts SET source=NULL,source_status='removed' WHERE id=?").run(id); }
    for (const p of data) if (p.withheld && stale.includes(p.id)) this.db.prepare("UPDATE posts SET source=NULL,source_status='removed' WHERE id=?").run(p.id);
    this.bump();
  }
  async readPost(id) {
    const p = this.db.prepare('SELECT * FROM posts WHERE id=?').get(id);
    if (!p) return {status:'failed',reason:'unknown_post'};
    this.db.prepare('INSERT INTO viewed VALUES (?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at').run(id,this.now());
    if (p.source && p.fetched >= this.now()-6*DAY) return {status:'ok',cached:true};
    if (this.busy || this.get('paused') || !this.get('tokens')) return {status:'waiting',reason:'not_available'};
    const last = this.get('readAttempt:'+id,0);
    if (last > this.now()-DAY) return {status:'waiting',reason:'interval'};
    this.busy=true; this.set('readAttempt:'+id,this.now());
    try {
      this.reserve(5000,'read_post');
      const token=await this.accessToken();
      const r=await this.api('/2/tweets?'+new URLSearchParams({ids:id,'tweet.fields':'author_id,created_at,entities,note_tweet'}),token);
      this.save(r.data || [],await this.authorsFor(r.data || [],token,true));
      for (const e of r.errors || []) if ((e.resource_id || e.value) === id && (e.type?.includes('resource-not-found') || [403,404].includes(e.status))) this.db.prepare("UPDATE posts SET source=NULL,source_status='removed' WHERE id=?").run(id);
      for (const p of r.data || []) if (p.id === id && p.withheld) this.db.prepare("UPDATE posts SET source=NULL,source_status='removed' WHERE id=?").run(id);
      this.bump();return {status:'ok'};
    } catch(e) { return {status:'failed',reason:e.code || 'network'}; }
    finally {this.busy=false;}
  }
  expire() {
    // Stop displaying unverified source after seven days; personal notes remain in IndexedDB.
    const r = this.db.prepare("UPDATE posts SET source=NULL,source_status='expired' WHERE source IS NOT NULL AND fetched<?").run(this.now()-7*DAY);
    this.db.prepare("DELETE FROM authors WHERE CAST(json_extract(value, '$.cachedAt') AS INTEGER)<?").run(this.now()-7*DAY);
    if (r.changes) this.bump();
  }
  snapshot() { this.expire(); return {status:'ok', revision:this.get('revision',0), entries:this.db.prepare('SELECT id,source,fetched,source_status,feed_order FROM posts ORDER BY feed_order,id').all().map(r=>({postId:r.id,feedOrder:r.feed_order,sourceStatus:r.source_status,src:r.source ? JSON.parse(r.source) : null,fetchedAt:new Date(r.fetched).toISOString()}))}; }
  pause(paused) { this.set('paused',paused); this.set('reason',paused?'manual':null); return this.status(); }
  async disconnect() {
    const t = this.tokens();
    if (t) {
      const headers = {'Content-Type':'application/x-www-form-urlencoded'};
      if (this.clientSecret) headers.Authorization = 'Basic '+Buffer.from(this.clientId+':'+this.clientSecret).toString('base64');
      const r = await this.fetch('https://api.x.com/2/oauth2/revoke',{method:'POST',headers,body:new URLSearchParams({token:t.access_token,client_id:this.clientId}),redirect:'error',signal:AbortSignal.timeout(15000)});
      if (!r.ok) throw new Error('revoke_failed');
    }
    this.set('tokens',null); this.set('paused',true); this.set('reason','disconnected');
    this.db.exec("UPDATE posts SET source=NULL,source_status='removed'; DELETE FROM authors;"); this.bump(); return this.status();
  }
  async sync({backfill=false}={}) {
    if (this.busy) return {status:'waiting',reason:'running'};
    if (this.get('paused')) return {status:'waiting',reason:this.get('reason')};
    if (!this.get('tokens')) return {status:'waiting',reason:'not_connected'};
    const now = this.now(), next = this.get(backfill?'nextBackfillAt':'nextAllowedAt');
    if (next && Date.parse(next)>now) return {status:'waiting',reason:'interval'};
    this.busy = true;
    // Persist admission before network, including failed attempts/restarts.
    this.set(backfill?'nextBackfillAt':'nextAllowedAt',new Date(now+DAY).toISOString());
    let added = 0, pages = 0;
    try {
      if (this.now() >= this.freeEnd) throw Object.assign(new Error('budget'),{code:'budget'});
      const token = await this.accessToken(), account = this.get('account');
      const initial = !this.get('bootstrapDone',false);
      let cursor = initial ? this.get('bootstrapCursor') : backfill ? this.get('backfillCursor') : this.get('recentCursor');
      if (backfill && !cursor) return {status:'waiting',reason:'no_backfill'};
      const owned = this.ownerHandle && account.handle.toLowerCase() === this.ownerHandle.toLowerCase();
      const postUnit = owned ? 1000 : 5000;
      const newOrder = this.db.prepare('SELECT COALESCE(MIN(feed_order),0)-20 AS n FROM posts').get().n;
      for (let page = 0; page < (initial ? 10 : backfill ? 1 : 4); page++) {
        if (this.get('paused')) break;
        const remaining = 1000 - this.get('bootstrapImported',0);
        if (initial && remaining <= 0) { this.set('bootstrapDone',true); break; }
        const size = initial ? Math.max(5, Math.min(100,remaining)) : backfill ? 100 : 5;
        // Post resources only. Author/profile lookups and related-post expansions are intentionally disabled.
        const reservation = this.reserve(size*postUnit,initial ? 'bootstrap_likes':'likes');
        const q = new URLSearchParams({max_results:String(size),'tweet.fields':'author_id,created_at,entities,note_tweet'});
        if (cursor) q.set('pagination_token',cursor);
        const r = await this.api('/2/users/'+account.id+'/liked_tweets?'+q,token);
        pages++;
        const data = r.data || [];
        if (!Array.isArray(data) || data.length > size) throw new Error('bad_page');
        // This adjusts our local budget reservation, not X billing. Failed calls retain the upper bound.
        const users = await this.authorsFor(data,token,true);
        this.db.prepare('UPDATE ledger SET units=? WHERE id=?').run(data.length*postUnit,reservation);
        const known = data.some(p=>this.db.prepare('SELECT id FROM posts WHERE id=?').get(p.id));
        const before = this.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
        this.save(data,users,initial || backfill ? null : newOrder+page*5); added += this.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n-before;
        cursor = r.meta?.next_token || null;
        if (initial) {
          this.set('bootstrapImported',this.get('bootstrapImported',0)+data.length);
          this.set('bootstrapCursor',cursor); this.set('backfillCursor',cursor);
          if (!cursor || this.get('bootstrapImported') >= 1000) this.set('bootstrapDone',true);
        } else if (backfill) this.set('backfillCursor',cursor);
        else this.set('recentCursor',known ? null : cursor);
        if (backfill || (!initial && known) || !cursor) break;
      }
      if (!backfill) await this.refreshStale(token);
      this.set('lastSuccessAt',new Date(this.now()).toISOString());
      const result = {status:'ok',added,pages}; this.set('lastResult',result); this.set('reason',null); return result;
    } catch(e) {
      const reason = ['auth','rate_limit','credits','budget','request'].includes(e.code) ? e.code : 'network';
      this.set('reason',reason);
      if (['auth','credits','budget'].includes(reason)) this.set('paused',true);
      if (reason === 'rate_limit' && e.retryAt) this.set('nextAllowedAt',new Date(Math.max(now+DAY,e.retryAt)).toISOString());
      const result = {status:'failed',reason,added,pages}; this.set('lastResult',result); return result;
    } finally { this.busy = false; this.expire(); }
  }
  startTimer() { this.timer = setInterval(()=>{this.sync().catch(()=>{});this.expire();},60000); this.timer.unref(); this.sync().catch(()=>{}); }
  close() { clearInterval(this.timer); this.db.close(); }
}
