import { randomBytes } from 'node:crypto';
import { request } from 'node:https';

/* Probes the panel's own public address the way a client would.

   A plain HTTPS fetch only proves nginx answered. What we need to know is
   whether a WebSocket upgrade reaches the Xray inbound, so this performs the
   real handshake: 101 back means Cloudflare, Railway, nginx and Xray are all
   wired correctly. Xray answers the upgrade before it checks the UUID, so a
   101 tells us about the path, not about any particular client. */

const TIMEOUT_MS = 8000;

export function probe(domain, port, path) {
  return new Promise(resolve => {
    const started = Date.now();
    const key = randomBytes(16).toString('base64');
    const pathOnly = String(path || '/').split('?')[0];

    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ port, ms: Date.now() - started, ...result });
    };

    let req;
    try {
      req = request({
        host: domain,
        port,
        path: pathOnly,
        method: 'GET',
        servername: domain,              // SNI is what Cloudflare routes on
        headers: {
          Host: domain,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          'User-Agent': 'RailPanel-selftest'
        },
        timeout: TIMEOUT_MS,
        ALPNProtocols: ['http/1.1']      // h2 would break the upgrade
      });
    } catch (err) {
      return finish({ ok: false, error: err.message });
    }

    req.on('upgrade', (res, socket) => {
      socket.destroy();
      finish({ ok: true, status: res.statusCode });
    });

    // No upgrade means something answered but it was not the Xray inbound.
    req.on('response', res => {
      res.resume();
      finish({
        ok: false,
        status: res.statusCode,
        error: res.statusCode === 404
          ? 'path not routed to xray'
          : `answered ${res.statusCode} instead of upgrading`
      });
    });

    req.on('timeout', () => { req.destroy(); finish({ ok: false, error: 'timed out' }); });
    req.on('error', err => finish({ ok: false, error: err.message }));
    req.end();
  });
}

export async function runAll({ domain, path, ports }) {
  if (!domain) return { ok: false, error: 'no domain set' };
  if (!path) return { ok: false, error: 'no node set generated yet' };

  const unique = [...new Set(ports)].sort((a, b) => a - b);
  const results = [];
  // Sequential on purpose: a dozen simultaneous TLS handshakes from a small
  // container skews the timings and tells us less than clean ones.
  for (const port of unique) {
    results.push(await probe(domain, port, path));
  }

  const working = results.filter(r => r.ok);
  return {
    ok: true,
    domain,
    path,
    results,
    workingPorts: working.map(r => r.port),
    verdict: working.length === 0 ? 'none'
      : working.length === results.length ? 'all'
      : 'partial'
  };
}
