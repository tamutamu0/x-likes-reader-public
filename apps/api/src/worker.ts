import { WorkerEntrypoint } from 'cloudflare:workers';
import { app } from './index';
import type { Bindings } from './types';
import { processInbox, expireSources } from './x-inbox';
import { authenticated, loginPage, exchangeBootstrap } from './session';
import { reconcileSubscription } from './x-control';
import { budget, MONTH_CAP, TOTAL_CAP, setRuntime } from './x-runtime';
import { webApp } from './web-compat';
import { readPost } from './x-lookup';
import { webhookApp } from './x-webhook';
import { expirePreviews } from './link-preview';
import { mcpRead } from './mcp-reader';

// Named RPC entrypoint: only the configured Worker service binding can invoke
// it. No /process or admin HTTP endpoint is added to the reader or receiver.
export class InboxProcessor extends WorkerEntrypoint<Bindings> {
  async receive(raw:Uint8Array,signature:string) {
    if(raw.byteLength>262144 || !this.env.DB)return 413;
    // Reverify the original X signature in the private service. The public
    // receiver has no DB binding and cannot read any stored source/token.
    const response=await webhookApp.fetch(new Request('https://internal.invalid/webhooks/x',{method:'POST',headers:{'Content-Type':'application/json','X-Twitter-Webhooks-Signature-OAuth2':signature},body:raw}),{...this.env,X_WEBHOOK_ENABLED:'true'},this.ctx);
    if(response.status===200)this.ctx.waitUntil(this.process().catch(()=>undefined));
    return response.status;
  }
  async process() {
    if (this.env.X_INBOX_PROCESSING_ENABLED !== 'true' || !this.env.DB) return { scanned: 0, hasMore: false };
    const result = await processInbox(this.env.DB);
    if (this.env.X_SYNC_ENABLED === 'true') {
      const b = await budget(this.env.DB, Date.now());
      if (b.month >= MONTH_CAP || b.total >= TOTAL_CAP) await reconcileSubscription(this.env, Date.now(), fetch, true);
    }
    return result;
  }
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if(url.pathname.startsWith('/mcp-read/'))return mcpRead(request,env);
    if (env.APP_ENV === 'local' && url.pathname === '/auth/login' && request.method === 'GET') return loginPage();
    if (env.APP_ENV === 'local' && url.pathname === '/auth/session') return exchangeBootstrap(request, env);
    if (url.pathname.startsWith('/api/')) return webApp.fetch(request,env,ctx);
    if (url.pathname.startsWith('/v1/') || !env.ASSETS) return app.fetch(request, env, ctx);
    const local = env.APP_ENV === 'local' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!local && !await authenticated(request, env)) return new Response(null, { status: 302, headers: { Location: '/auth/login', 'Cache-Control': 'no-store' } });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const asset=await env.ASSETS.fetch(request);
    const response=new Response(asset.body,asset);
    response.headers.set('Cache-Control','private, no-cache');
    response.headers.set('Referrer-Policy','no-referrer');
    response.headers.set('X-Frame-Options','DENY');
    response.headers.set('X-Content-Type-Options','nosniff');
    return response;
  },
  async scheduled(_event: ScheduledController, env: Bindings) {
    if (env.X_INBOX_PROCESSING_ENABLED !== 'true' || !env.DB) return;
    const at=new Date().toISOString();
    try {
      await expireSources(env.DB);
      await expirePreviews(env.DB);
      const result=await processInbox(env.DB);
      await reconcileSubscription(env);
      const pending = await env.DB.prepare(`SELECT items.id FROM items LEFT JOIN x_lookup_attempts a ON a.post_id=substr(items.id,3)
        WHERE json_extract(metadata_json,'$.sourceStatus')='pending' AND json_extract(metadata_json,'$.fetchedAt')>?
          AND (a.attempted_at IS NULL OR a.attempted_at<?) ORDER BY updated_at LIMIT 2`)
        .bind(new Date(Date.now()-7*86400000).toISOString(),new Date(Date.now()-86400000).toISOString()).all<{id:string}>();
      for (const row of pending.results) await readPost(env,row.id.slice(2));
      await env.DB.prepare('DELETE FROM browser_bootstrap WHERE consumed=1 OR expires_at<?').bind(at).run();
      await setRuntime(env.DB,'cronHealth',{at,ok:true,processed:result.scanned,lookupCandidates:pending.results.length});
    } catch {
      await setRuntime(env.DB,'cronHealth',{at,ok:false});
    }
  },
};
