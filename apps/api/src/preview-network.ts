// Pure validation. Workers fetch cannot pin DNS with verified hostname TLS.
// Fetch only trusted public services; arbitrary personal domains are refused.
// @ts-expect-error Shared, existing JavaScript network guard.
import { checkHostname, isPublicAddress } from '../../../stable/server/netguard.mjs';
export const IMAGE_LIMIT = 256 * 1024;
export const HTML_LIMIT = 256 * 1024;
const TRUSTED = ['github.com','githubusercontent.com','githubassets.com','gitlab.com','youtube.com','youtu.be','ytimg.com',
  'note.com','st-note.com','qiita.com','qiitausercontent.com','zenn.dev','zenn.studio','medium.com','mediumusercontent.com',
  'dev.to','hashnode.com','hashnode.dev','substack.com','substackcdn.com','arxiv.org','wikipedia.org','wikimedia.org',
  'python.org','pypi.org','docs.rs','crates.io','rust-lang.org','npmjs.com','openai.com','google.com','googleusercontent.com',
  'gstatic.com','developers.cloudflare.com','cloudflare.com','vercel.com','nextjs.org','react.dev','mozilla.org',
  'microsoft.com','apple.com','aws.amazon.com','amazonaws.com','cloudfront.net','huggingface.co','hf.co','pbs.twimg.com','res.cloudinary.com'];
export function trustedHost(host:string) {return TRUSTED.some(root=>host===root || host.endsWith('.'+root));}
const decoder = new TextDecoder();
const secretKey = /(?:token|signature|secret|password|authorization|credential|session|apikey|api_key|key-pair-id|x-amz-|x-goog-)/i;
export function previewUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) throw Error('bad_url');
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !checkHostname(u.hostname).ok) throw Error('bad_url');
  // No X pages, owner app, developer consoles, or signed/login links fetched.
  if (/(^|\.)(x\.com|twitter\.com|t\.co|workers\.dev|cloudflareaccess\.com)$/.test(u.hostname) ||
    ['dash.cloudflare.com','api.cloudflare.com','accounts.google.com','console.cloud.google.com'].includes(u.hostname)) throw Error('bad_url');
  for (const [key] of u.searchParams) if (secretKey.test(key)) throw Error('secret_url');
  if (/(?:^|\/)(?:login|signin|logout|oauth|authorize|callback|auth)(?:\/|$)/i.test(u.pathname)) throw Error('auth_url');
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key);
  return u;
}
export type WireResponse = { status: number; headers: Record<string, string>; body: Uint8Array };
export type PreviewTransport = (u: URL, ip: string, deadline: number, limit: number) => Promise<WireResponse>;
export type Resolver = (host: string, deadline: number) => Promise<string[]>;
export async function publicDns(host: string, deadline: number): Promise<string[]> {
  const responses = await Promise.all(['A', 'AAAA'].map(async type => {
    const res = await fetch('https://cloudflare-dns.com/dns-query?' + new URLSearchParams({ name: host, type }), {
      headers: { Accept: 'application/dns-json' }, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!res.ok) throw Error('dns');
    const raw = await res.text(); if (raw.length > 16384) throw Error('dns');
    const data = JSON.parse(raw);
    if (data.Status !== 0) throw Error('dns');
    if (!Array.isArray(data.Answer)) return [];
    return data.Answer.filter((a: any) => a.type === 1 || a.type === 28).map((a: any) => a.data);
  }));
  return responses.flat();
}
export async function externalResource(raw: string, kind: 'html' | 'image', transport: PreviewTransport, resolve: Resolver = publicDns, allowedHost=trustedHost, deadline=Date.now()+10000) {
  const limit = kind === 'html' ? HTML_LIMIT : IMAGE_LIMIT;
  let u = previewUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    if(!allowedHost(u.hostname))throw Error('unsupported_host');
    const addresses = await resolve(u.hostname, deadline);
    if (!addresses.length || addresses.length > 32 || addresses.some(ip => !isPublicAddress(ip))) throw Error('private_address');
    // Every hop is limited to the trusted service DNS namespace. The check
    // does not claim IP pinning: DNS and public service administration remain
    // trust boundaries. Worker has no VPC, private bindings, DB or credentials.
    const res = await transport(u, addresses[0], deadline, limit);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop === 3 || !res.headers.location) throw Error('redirect');
      u = previewUrl(new URL(res.headers.location, u).href); continue;
    }
    if (res.status !== 200 && res.status !== 206) throw Error('unavailable');
    if (res.body.byteLength > limit || !res.body.byteLength) throw Error('size');
    const type = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (kind === 'html' && !['text/html', 'application/xhtml+xml'].includes(type)) throw Error('type');
    if (kind === 'image' && (imageType(res.body) !== type || !type)) throw Error('type');
    if (kind === 'image' && res.status === 206 && !new RegExp('^bytes 0-'+(res.body.length-1)+'/'+res.body.length+'$').test(res.headers['content-range'] ?? '')) throw Error('partial_image');
    return { ...res, type, finalUrl: u.href };
  }
  throw Error('redirect');
}
export function imageType(b: Uint8Array) {
  if (b.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => b[i] === v)) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 12 && decoder.decode(b.slice(0,4)) === 'RIFF' && decoder.decode(b.slice(8,12)) === 'WEBP') return 'image/webp';
  // SVG, HTML, animated GIF and arbitrary content are never served as images.
  return '';
}
