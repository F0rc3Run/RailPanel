import { spawn, execFile } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BIN = process.env.XRAY_BIN || '/usr/local/xray/xray';
const DATA_DIR = process.env.DATA_DIR || '/data';

/* A binary installed through the panel lives on the volume and takes
   precedence: the image is rebuilt on every deploy and would otherwise
   silently undo the update. */
function binPath() {
  const local = `${DATA_DIR}/xray/xray`;
  try {
    return existsSync(local) ? local : BIN;
  } catch {
    return BIN;
  }
}

export function startedAtMs() { return startedAt; }
const ASSETS = process.env.XRAY_ASSETS || '/usr/local/xray';
const API_PORT = Number(process.env.XRAY_API_PORT || 10085);
const RUN_DIR = '/run/railpanel';
const CONFIG = join(RUN_DIR, 'xray.json');

let child = null;
let startedAt = null;
let versionCache = null;
let restartTimer = null;
let lastError = null;

/* ------------------------------------------------------------------
   Config
   ------------------------------------------------------------------ */

/* One inbound per entry. `clients` carry the UUIDs; `email` is what Xray
   labels traffic counters with, so it has to be unique across inbounds. */
export function buildConfig(inbounds) {
  const live = inbounds.filter(i => i.enabled !== false);

  return {
    log: { loglevel: 'warning' },

    // Local API, used for reading per-user traffic.
    api: { tag: 'api', services: ['StatsService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true }
    },

    inbounds: [
      {
        tag: 'api',
        listen: '127.0.0.1',
        port: API_PORT,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' }
      },
      ...live.map(inbound => ({
        tag: inbound.id,
        listen: '127.0.0.1',           // nginx is the only way in
        port: inbound.port,
        protocol: 'vless',
        settings: {
          decryption: 'none',
          clients: (inbound.clients || [])
            .filter(c => c.enabled !== false)
            .map(c => ({ id: c.uuid, email: `${inbound.id}.${c.id}`, level: 0 }))
        },
        streamSettings: {
          network: inbound.network === 'httpupgrade' ? 'httpupgrade' : 'ws',
          security: 'none',            // TLS is terminated at the edge
          ...(inbound.network === 'httpupgrade'
            ? { httpupgradeSettings: { path: inbound.path, host: inbound.host || '' } }
            : { wsSettings: { path: inbound.path, host: inbound.host || '' } })
        },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] }
      }))
    ],

    outbounds: [
      { tag: 'direct', protocol: 'freedom', settings: {} },
      { tag: 'blocked', protocol: 'blackhole', settings: {} }
    ],

    routing: {
      rules: [
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        // Private ranges are not a proxy destination; blocking them stops
        // a client from reaching other services inside the container.
        { type: 'field', ip: ['geoip:private'], outboundTag: 'blocked' }
      ]
    }
  };
}

export function writeConfig(inbounds) {
  if (!existsSync(RUN_DIR)) mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(buildConfig(inbounds), null, 2));
  return CONFIG;
}

/* ------------------------------------------------------------------
   Process
   ------------------------------------------------------------------ */

export function start(inbounds) {
  writeConfig(inbounds);

  if (child) {
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
    child = null;
  }

  startedAt = Date.now();
  child = spawn(binPath(), ['run', '-c', CONFIG], {
    env: { ...process.env, XRAY_LOCATION_ASSET: ASSETS },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  lastError = null;

  child.stdout.on('data', d => process.stdout.write(`[xray] ${d}`));
  child.stderr.on('data', d => {
    const text = String(d);
    lastError = text.trim().split('\n').slice(-1)[0];
    process.stderr.write(`[xray] ${text}`);
  });

  child.on('exit', (code, signal) => {
    console.error(`xray exited (code=${code} signal=${signal})`);
    child = null;
    // Xray dying should not take the panel with it: the operator still
    // needs a way in to fix whatever caused it.
    if (code !== 0 && !restartTimer) {
      restartTimer = setTimeout(() => { restartTimer = null; start(inbounds); }, 3000);
    }
  });

  return child;
}

/* Xray reads its config once at launch, so any structural change means a
   restart. It comes back in well under a second and clients reconnect on
   their own, but the blip is real — so callers debounce. */
let pending = null;
export function reload(inbounds, delayMs = 400) {
  if (pending) clearTimeout(pending);
  return new Promise(resolve => {
    pending = setTimeout(() => {
      pending = null;
      start(inbounds);
      resolve(true);
    }, delayMs);
  });
}

export function stop() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) { child.removeAllListeners('exit'); child.kill('SIGTERM'); child = null; }
}

export function status() {
  return {
    running: Boolean(child && !child.killed),
    pid: child?.pid ?? null,
    since: startedAt,
    lastError
  };
}

/* ------------------------------------------------------------------
   Traffic
   ------------------------------------------------------------------ */

/* Read counters through Xray's own CLI rather than speaking gRPC, which
   keeps the panel free of dependencies. Returns bytes per client email. */
export async function traffic({ reset = false } = {}) {
  const args = ['api', 'statsquery', `--server=127.0.0.1:${API_PORT}`, '-pattern', 'user>>>'];
  if (reset) args.push('-reset');

  let stdout;
  try {
    ({ stdout } = await run(BIN, args, { timeout: 8000 }));
  } catch (err) {
    return { ok: false, error: err.message, users: {} };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: 'unreadable stats output', users: {} };
  }

  const users = {};
  for (const entry of parsed?.stat || []) {
    // name looks like: user>>>inboundId.clientId>>>traffic>>>uplink
    const parts = String(entry.name || '').split('>>>');
    if (parts.length < 4 || parts[0] !== 'user') continue;
    const email = parts[1];
    const direction = parts[3];
    users[email] = users[email] || { up: 0, down: 0 };
    if (direction === 'uplink') users[email].up = Number(entry.value || 0);
    if (direction === 'downlink') users[email].down = Number(entry.value || 0);
  }
  return { ok: true, users };
}

export function apiPort() { return API_PORT; }
export function configPath() { return CONFIG; }


export function uptimeSec() {
  return startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
}

/* The binary in use may be the one baked into the image or a newer one the
   operator installed onto the volume, so the version is read from whichever
   is actually running rather than assumed. */
export async function version() {
  if (versionCache) return versionCache;
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => {
    execFile(binPath(), ['version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split('\n')[0] || '';
      const match = line.match(/Xray\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
      versionCache = match ? match[1] : line.trim() || null;
      resolve(versionCache);
    });
  });
}

export function clearVersionCache() { versionCache = null; }
