/* Response helpers, kept separate so routes and the server do not have to
   import each other. */

export function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

  /* Without a length the response goes out chunked, and some proxy clients
     read a chunked body over a renegotiated TLS connection as a premature
     EOF. The body is always small enough to measure up front. */
  res.writeHead(status, {
    'Content-Length': String(payload.length),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(payload);
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/* Railway and Cloudflare both terminate TLS, so what reaches us is plain
   HTTP. The forwarded scheme is what decides the cookie's Secure flag. */
export function isSecure(req) {
  const forwarded = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwarded) return forwarded === 'https';

  // Cloudflare also states it here, which survives a proxy that drops the
  // header above.
  const visitor = req.headers['cf-visitor'];
  if (visitor && visitor.includes('"https"')) return true;

  // Nothing said. Anything reached under a real hostname arrived over TLS in
  // this deployment, and guessing http would hand out subscription links that
  // clients refuse — so only a local address is treated as plain.
  const host = String(req.headers.host || '').split(':')[0];
  return !(host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '');
}
