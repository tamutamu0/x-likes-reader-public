import type { Bindings } from './types';
import { authenticated } from './session';
import { authAction, authPage, AUTH_STYLE } from './auth';
import { secured, sameOriginWrite } from './security';
import { mcpAuthorized } from './mcp-reader';
// @ts-expect-error Wrangler imports the built browser bundle as text.
import authClient from '../dist/auth-client.txt';

export async function gateway(request:Request,env:Bindings) {
  const url=new URL(request.url);
  // Pin the RP/origin in trusted configuration, never the incoming Host.
  if(!env.AUTH_ORIGIN || url.origin!==env.AUTH_ORIGIN || !env.AUTH_DB)return new Response(null,{status:403});
  // Dedicated read-only lane. Its token never authenticates Web, /api, /v1,
  // owner session issuance, sync controls, or arbitrary service paths.
  if(url.pathname.startsWith('/mcp-read/')) {
    if(!env.MCP_RATE_LIMITER || !(await env.MCP_RATE_LIMITER.limit({key:request.headers.get('CF-Connecting-IP')||'unknown'})).success)return new Response(null,{status:429});
    if(!await mcpAuthorized(request,env))return new Response(null,{status:401});
    if(request.method!=='POST'||!['recent','search','post','status'].includes(url.pathname.slice('/mcp-read/'.length)))return new Response(null,{status:404});
    return env.CORE?env.CORE.fetch(request):new Response(null,{status:503});
  }
  if(url.pathname.startsWith('/auth/')) {
    if(request.method==='GET') {
      if(url.pathname==='/auth/client.js')return new Response(authClient,{headers:{'Content-Type':'text/javascript;charset=UTF-8'}});
      if(url.pathname==='/auth/style.css')return new Response(AUTH_STYLE,{headers:{'Content-Type':'text/css;charset=UTF-8'}});
      if(env.AUTH_MODE==='link' && url.pathname==='/auth/setup')return new Response(null,{status:404});
      if(url.pathname==='/auth/login' || url.pathname==='/auth/setup')return authPage(url.pathname.endsWith('setup'),false,env.AUTH_MODE==='link');
      if(url.pathname==='/auth/security' && await authenticated(request,env))return authPage(false,true);
      return new Response(null,{status:404});
    }
    return authAction(request,env);
  }
  // All data, health and static routes cross one gate BEFORE routing. An
  // unknown API route, alternate HTTP method or spoofed Access header cannot
  // skip it. This Worker has only the auth DB; the data Worker has no URL.
  if(!await authenticated(request,env))return new Response(null,{status:url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') ? 401:302,headers:{Location:'/auth/login'}});
  if(!['GET','HEAD'].includes(request.method) && !sameOriginWrite(request))return new Response(null,{status:403});
  if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
    if(!env.CORE)return new Response(null,{status:503});
    return env.CORE.fetch(request);
  }
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
  if(!env.ASSETS)return new Response(null,{status:503});
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request:Request,env:Bindings) {
    try{return secured(await gateway(request,env));}
    catch{return secured(new Response(null,{status:503}));}
  },
};
