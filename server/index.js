import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { send, isSecure } from './lib/http.js';
import { load } from './lib/store.js';
import { hasAdmin, setCredentials, sessionOf } from './lib/auth.js';
import { handle as handleApi } from './api.js';
import * as subpage from './lib/subpage.js';
import { BUILD } from './lib/railway.js';
import { clientFromUserAgent } from './lib/profiles.js';
import * as enforce from './lib/enforce.js';
import * as notify from './lib/notify.js';
import * as nodesetLib from './lib/nodeset.js';
import * as xray from './lib/xray.js';
import * as nginx from './lib/nginx.js';
import { allInbounds, subscriptionFor } from './lib/nodeset.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const HOST = process.env.PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.PANEL_PORT || 8090);
const MAX_BODY = 8 * 1024 * 1024;

/* The panel can be tucked behind a path of the operator's choosing, so the
   root of the domain gives nothing away to anyone scanning it. Kept in an
   environment variable rather than in the panel's own settings: a typo saved
   through the interface would lock the operator out with no way back. */
const BASE = (() => {
  const raw = String(process.env.PANEL_PATH || '').trim();
  if (!raw || raw === '/') return '';
  return '/' + raw.replace(/^\/+|\/+$/g, '');
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // Resolve inside WEB and confirm it stayed there, so no crafted path
  // can walk out of the directory.
  const file = join(WEB, rel);
  if (!file.startsWith(WEB) || !existsSync(file)) return false;

  let body = readFileSync(file);

  /* The page used to work out its own base from the address bar, which meant
     a stale bookmark or a changed PANEL_PATH produced a panel that loaded
     perfectly and then answered 404 to every button. The server knows where
     it is serving from, so it says so. */
  if (rel === '/index.html') {
    body = Buffer.from(
      String(body).replace('<head>', `<head><script>window.__RP_BASE=${JSON.stringify(BASE)};</script>`),
      'utf8'
    );
  }

  send(res, 200, body, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Cache-Control': rel === '/index.html' ? 'no-store' : 'public, max-age=3600'
  });
  return true;
}

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    // An unanswered request looks like EOF to a proxy client, which is far
    // harder to diagnose than a plain 500.
    console.error('request failed:', req.method, req.url, err);
    // The message is far more useful than the word "internal": it is the one
    // thing that says which step objected.
    // Never an empty message: a thrown string, or an error without one,
    // used to surface as the word "internal" and nothing else.
    const detail = err?.message || (typeof err === 'string' ? err : null) || String(err);
    if (!res.headersSent) send(res, 500, { error: detail });
    else res.end();
  }
});

async function route(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  let path = url.pathname;

  /* Subscription links stay on the root: they are handed to other people and
     should not carry the panel's whereabouts. */
  /* The verification callback is reached from outside, at the root of the
     domain, so it has to stay there whatever path the panel itself hides
     behind — otherwise verifying a domain always fails once PANEL_PATH is
     set. It reveals nothing: without the one-time token it answers 403. */
  const isPublic = path === '/healthz'
    || path === '/__railpanel/verify'
    || path.startsWith('/sub/');

  if (BASE && !isPublic) {
    if (path === BASE) {
      // A trailing slash keeps relative asset paths resolving correctly.
      res.writeHead(302, { Location: BASE + '/' });
      return res.end();
    }
    if (path.startsWith(BASE + '/')) {
      path = path.slice(BASE.length) || '/';
    } else {
      /* Anything outside the base is answered as if nothing is here: no
         redirect, no error text, nothing to tell a scanner it guessed near. */
      return send(res, 200, '', { 'Content-Type': 'text/html; charset=utf-8' });
    }
  }

  if (path === '/healthz') {
    const data = load();
    return send(res, 200, {
      ok: true,
      build: BUILD,
      configured: hasAdmin(),
      needsSetup: !data.setup?.complete
    });
  }

  // Subscriptions are fetched by proxy clients, which carry no session.
  // The random subId is the credential.
  if (req.method === 'GET' && path.startsWith('/sub/')) {
    /* Two shapes for the same thing: /sub/<id>?client=clash and
       /sub/<id>/clash. Some clients mishandle a query string on a
       subscription URL, so the path form is offered as well. */
    let rest = path.slice('/sub/'.length);
    let client = url.searchParams.get('client');
    const slash = rest.indexOf('/');
    if (slash !== -1) {
      client = client || rest.slice(slash + 1);
      rest = rest.slice(0, slash);
    }
    // An explicit choice wins; otherwise work it out from the User-Agent so a
    // plain /sub/<id> link serves the right format to whatever asked for it.
    const result = subscriptionFor(rest, client || clientFromUserAgent(req.headers['user-agent']));
    if (!result || result.missing) {
      const why = !result ? 'unknown subscription' : result.missing === 'client'
        ? 'this subscription no longer exists — the client was deleted, or the panel data was reset because no volume is mounted at /data'
        : 'no node set has been generated yet — open the panel and press Generate';
      console.warn('sub 404: %s (%s)', rest, why);
      return send(res, 404, `# RailPanel\n# ${why}\n`, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      });
    }

    /* Same URL, two audiences. A proxy client fetches it and wants the raw
       list; a person opens it and wants to see what they have left. Decide
       from what the caller asks for, so neither has to be told a different
       address. ?raw=1 forces the list for anything that guesses wrong. */
    const wantsList = url.searchParams.has('raw')
      || !String(req.headers.accept || '').includes('text/html');

    if (wantsList) {
      console.log('sub %s -> %s (%d nodes, %d bytes)', result.clientApp, String(result.client.tag).replace(/[^\x20-\x7e]/g, '?'), result.links.length, result.body.length);
      return send(res, 200, result.body, {
        ...result.headers,
        // Keeps Cloudflare from re-encoding the body, which would drop the
        // Content-Length again.
        'Cache-Control': 'no-store, no-transform'
      });
    }

    const html = subpage.render({
      client: result.client,
      remark: result.remark,
      links: result.links,
      nodeCount: result.links.length,
      clientApp: result.clientApp,
      subUrl: `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}/sub/${rest}`,
      base: BASE
    });
    return send(res, 200, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  }

  if (path === '/__railpanel/verify' || path.startsWith('/api/')) {
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try {
        const raw = await readBody(req);
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch (err) {
        return send(res, 400, { error: 'invalid body' });
      }
    }
    try {
      return await handleApi(req, res, { url, path, body, session: sessionOf(req) });
    } catch (err) {
      console.error('api error:', err);
      return send(res, 500, { error: 'internal error' });
    }
  }

  if (req.method === 'GET' && serveStatic(res, path)) return;

  /* Only the panel's own address gets the shell. Serving it for any path
     produced a page that looked entirely healthy while every request it made
     came back 404 — far harder to diagnose than a plain not-found. */
  if (req.method === 'GET' && path === '/' && !extname(path)) {
    return serveStatic(res, '/index.html') || send(res, 404, { error: 'not found' });
  }

  send(res, 404, { error: 'not found' });
}

async function bootstrap() {
  const data = load();
  if (!hasAdmin()) {
    setCredentials('railpanel', 'railpanel');
    console.log('first run: signing in with railpanel / railpanel — change it right away');
  }

  const inbounds = allInbounds(data);
  try {
    const web = await nginx.apply(inbounds);
    if (!web.ok) {
      // The bootstrap config from start.sh is still in place, so the panel
      // stays reachable and the operator can see what went wrong.
      console.error('nginx config rejected, keeping the previous one:', web.error);
    } else {
      console.log(`nginx serving ${web.routes} inbound route(s)`);
    }
  } catch (err) {
    console.error('nginx step failed, continuing without it:', err.message);
  }

  const version = await xray.version();
  console.log(version ? `xray ${version}` : 'xray binary not responding');
  xray.start(inbounds);
}

bootstrap()
  .then(() => {
    /* Limits are only real if something applies them. This is what turns the
       traffic and expiry fields from stored numbers into enforced ones. */
    enforce.start(() => nodesetLib.applyRuntime());
    notify.start();
  })
  .catch(err => console.error('bootstrap failed:', err));

server.listen(PORT, HOST, () => {
  console.log(`railpanel build ${BUILD} listening on ${HOST}:${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    xray.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
