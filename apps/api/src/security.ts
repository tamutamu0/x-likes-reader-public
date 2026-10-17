export const WEB_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
export function secured(response: Response) {
  const r = new Response(response.body, response);
  r.headers.set('Cache-Control','no-store');
  r.headers.set('Content-Security-Policy',WEB_CSP);
  r.headers.set('Referrer-Policy','no-referrer');
  r.headers.set('X-Frame-Options','DENY');
  r.headers.set('X-Content-Type-Options','nosniff');
  r.headers.set('Strict-Transport-Security','max-age=31536000');
  r.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  r.headers.set('Cross-Origin-Opener-Policy','same-origin');
  r.headers.set('Cross-Origin-Resource-Policy','same-origin');
  return r;
}
export function sameOriginWrite(request: Request) {
  return request.headers.get('Origin')===new URL(request.url).origin && request.headers.get('X-Margin-Request')==='1' &&
    (!request.headers.has('Sec-Fetch-Site') || request.headers.get('Sec-Fetch-Site')==='same-origin');
}
