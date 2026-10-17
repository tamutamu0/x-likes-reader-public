import { decode, verifyWithJwks } from 'hono/jwt';

export type AccessBindings = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; ACCESS_OWNER_EMAIL?: string };
type Keys = NonNullable<Parameters<typeof verifyWithJwks>[1]['keys']>;

export function createAccessVerifier(fetchKeys: typeof fetch = fetch) {
  let cached: { issuer: string; expires: number; promise: Promise<Keys> } | undefined;
  async function keys(issuer: string) {
    if (cached?.issuer === issuer && cached.expires > Date.now()) return cached.promise;
    const entry = { issuer, expires: Date.now() + 60000, promise: Promise.resolve([] as Keys) };
    entry.promise = (async () => {
      const response = await fetchKeys(issuer + '/cdn-cgi/access/certs', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('unavailable access keys');
      const text = await response.text(); if (text.length > 65536) throw new Error('invalid access keys');
      const body = JSON.parse(text);
      if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > 10) throw new Error('invalid access keys');
      const result: Keys = body.keys.filter((key: any) => key && key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig' &&
        typeof key.kid === 'string' && key.kid.length <= 128 && typeof key.n === 'string' && key.n.length <= 2048 && typeof key.e === 'string');
      if (!result.length) throw new Error('invalid access keys');
      entry.expires = Date.now() + 600000;
      return result;
    })();
    cached = entry; return entry.promise;
  }
  return async (request: Request, env: AccessBindings) => {
    const issuer = env.ACCESS_TEAM_DOMAIN;
    // The JWKS destination comes only from trusted configuration, never iss,
    // jku or x5u in the supplied token. Failure never grants access.
    if (!issuer || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer) ||
      !env.ACCESS_AUD || !/^[a-f0-9]{64}$/.test(env.ACCESS_AUD) || !env.ACCESS_OWNER_EMAIL) return false;
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 16384) return false;
    try {
      const { header, payload: unverified } = decode(token);
      if (header.alg !== 'RS256' || !header.kid || typeof unverified.exp !== 'number' || !Number.isFinite(unverified.exp)) return false;
      const payload = await verifyWithJwks(token, { keys: await keys(issuer), allowedAlgorithms: ['RS256'], verification: { iss: issuer, aud: env.ACCESS_AUD } });
      return typeof payload.email === 'string' && payload.email.toLowerCase() === env.ACCESS_OWNER_EMAIL.toLowerCase();
    } catch { return false; }
  };
}

export const validAccess = createAccessVerifier();
