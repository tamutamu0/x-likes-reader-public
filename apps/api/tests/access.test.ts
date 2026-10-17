import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'hono/jwt';
import { createAccessVerifier } from '../src/access';

const issuer = 'https://synthetic-test.cloudflareaccess.com', aud = 'a'.repeat(64), email = 'owner@example.test';
const env = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: aud, ACCESS_OWNER_EMAIL: email };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateJwk = { ...privateKey.export({ format: 'jwk' }), kty: 'RSA', alg: 'RS256' as const, kid: 'synthetic-key' };
const publicJwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid: 'synthetic-key', use: 'sig' };
const claims = () => ({ iss: issuer, aud: [aud], exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), email });
const request = (token: string) => new Request('https://reader.example.test/v1/items', { headers: { 'Cf-Access-Jwt-Assertion': token, 'Cf-Access-Authenticated-User-Email': email } });

test('only a signed owner token for this Access application authenticates; keys cached across requests', async () => {
  let calls = 0;
  const verify = createAccessVerifier(async (input, options) => {
    calls++; assert.equal(input, issuer + '/cdn-cgi/access/certs'); assert.equal(options!.redirect, 'error');
    return Response.json({ keys: [publicJwk] });
  });
  const token = await sign(claims(), privateJwk, 'RS256');
  assert.equal(await verify(request(token), env), true); assert.equal(await verify(request(token), env), true); assert.equal(calls, 1);
  for (const patch of [{ email: 'stranger@example.test' }, { iss: 'https://attacker.example' }, { aud: ['b'.repeat(64)] }, { exp: 1 }, { exp: undefined }, { nbf: Math.floor(Date.now() / 1000) + 3600 }])
    assert.equal(await verify(request(await sign({ ...claims(), ...patch }, privateJwk, 'RS256')), env), false);
  assert.equal(await verify(request(token.slice(0, -4) + 'AAAA'), env), false);
  assert.equal(await verify(request(await sign(claims(), 'synthetic-shared-secret', 'HS256')), env), false);
  assert.equal(calls, 1);
});

test('missing config, spoofed email, malformed token and untrusted JWKS addresses fail closed without network requests', async () => {
  let calls = 0; const verify = createAccessVerifier(async () => { calls++; throw new Error('must not fetch'); });
  const token = await sign(claims(), privateJwk, 'RS256');
  for (const overrides of [{ ACCESS_TEAM_DOMAIN: '' }, { ACCESS_TEAM_DOMAIN: 'http://127.0.0.1' }, { ACCESS_TEAM_DOMAIN: issuer + '/extra' }, { ACCESS_AUD: '' }, { ACCESS_OWNER_EMAIL: '' }])
    assert.equal(await verify(request(token), { ...env, ...overrides }), false);
  for (const bad of ['', 'not.a.token', 'a'.repeat(16385)]) assert.equal(await verify(request(bad), env), false);
  assert.equal(calls, 0);
});

test('JWKS failure or unknown signing key denies access; repeated failures do not storm the key endpoint', async () => {
  let calls = 0; const verify = createAccessVerifier(async () => { calls++; return new Response('unavailable', { status: 503 }); });
  const token = await sign(claims(), privateJwk, 'RS256');
  assert.equal(await verify(request(token), env), false); assert.equal(await verify(request(token), env), false); assert.equal(calls, 1);
  const rotated = createAccessVerifier(async () => Response.json({ keys: [{ ...publicJwk, kid: 'other-key' }] }));
  assert.equal(await rotated(request(token), env), false);
});
