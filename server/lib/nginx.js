import { writeFileSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CONF = process.env.NGINX_CONF || '/etc/nginx/nginx.conf';

const PANEL_PORT = Number(process.env.PANEL_PORT || 8090);

/* Kept so the panel can show why a reload failed instead of leaving the
   operator to guess from a node that silently does not work. */
let lastResult = { ok: null, at: null, error: null, routes: 0 };
export function lastApply() { return lastResult; }
export function liveRoutes() {
  try {
    const live = readFileSync(CONF, 'utf8');
    return [...live.matchAll(/location (\/[^\s{]*)/g)].map(m => m[1]);
  } catch (err) {
    return null;
  }
}

/* nginx picks the longest matching prefix regardless of order, so an
   inbound path always wins over the catch-all that feeds the panel. */
function locationFor(inbound) {
  return `
        location ${inbound.path.split('?')[0]} {
            proxy_pass http://127.0.0.1:${inbound.port};
            proxy_set_header Upgrade    $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host            $host;
            proxy_set_header X-Real-IP       $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }`;
}

export function render(inbounds, publicPort) {
  const routes = inbounds
    .filter(i => i.enabled !== false && i.path)
    .map(locationFor)
    .join('\n');

  return `# Written by RailPanel. Manual edits are overwritten on the next change.
worker_processes auto;
worker_rlimit_nofile 65535;
pid /run/nginx/nginx.pid;

events { worker_connections 4096; }

http {
    access_log off;
    error_log stderr warn;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    # Cloudflare and Railway both terminate TLS, so $scheme is always http
    # here. Pass through whatever the edge reported instead.
    map $http_x_forwarded_proto $forwarded_proto {
        default $http_x_forwarded_proto;
        ''      $scheme;
    }

    sendfile on;
    tcp_nodelay on;
    server_tokens off;
    client_max_body_size 64m;

    proxy_http_version 1.1;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 15s;
    # Off by default because a tunnelled WebSocket must not be buffered.
    # The panel location turns it back on: a buffered response keeps its
    # Content-Length, and without one the edge switches to chunked, which
    # some proxy clients read as a premature EOF.
    proxy_buffering off;
    proxy_socket_keepalive on;

    server {
        listen ${publicPort};
        listen [::]:${publicPort};
${routes}

        location / {
            proxy_pass http://127.0.0.1:${PANEL_PORT};
            proxy_set_header Upgrade    $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host              $host;
            proxy_set_header X-Real-IP         $remote_addr;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $forwarded_proto;
            proxy_buffering on;
            # The panel is one large file. Without room for it, nginx spills
            # every response to a temporary file on disk.
            proxy_buffer_size 32k;
            proxy_buffers 8 64k;
            proxy_busy_buffers_size 128k;
        }
    }
}
`;
}

/* Write, test, reload. If the new config does not pass `nginx -t` the old
   one is put back, because a broken proxy takes the whole service down. */
export async function apply(inbounds, publicPort = Number(process.env.NGINX_PORT || process.env.PORT || 3000)) {
  let previous = null;
  try { previous = readFileSync(CONF, 'utf8'); } catch { /* first run */ }

  // A failure here must be reported, not thrown: the caller still has to
  // get Xray up, and the bootstrap config is already serving the panel.
  try {
    writeFileSync(CONF, render(inbounds, publicPort));
  } catch (err) {
    lastResult = { ok: false, at: new Date().toISOString(), error: `could not write ${CONF}: ${err.message}`, routes: 0 };
    return lastResult;
  }

  try {
    await run('nginx', ['-t'], { timeout: 8000, env: { ...process.env } });
  } catch (err) {
    if (previous) writeFileSync(CONF, previous);
    lastResult = { ok: false, at: new Date().toISOString(), error: 'nginx -t rejected: ' + (err.stderr || err.message).trim(), routes: 0 };
    return lastResult;
  }

  try {
    await run('nginx', ['-s', 'reload'], { timeout: 8000 });
  } catch (err) {
    lastResult = { ok: false, at: new Date().toISOString(), error: 'reload failed: ' + (err.stderr || err.message).trim(), routes: 0 };
    return lastResult;
  }
  lastResult = { ok: true, at: new Date().toISOString(), error: null, routes: inbounds.filter(i => i.path).length };
  return lastResult;
}

export function confPath() { return CONF; }
