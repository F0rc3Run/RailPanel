import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = join(DATA_DIR, 'railpanel.json');
const TMP = FILE + '.tmp';

export const SCHEMA_VERSION = 1;

/* Ports the panel hands out to inbounds. Two core slots plus one for the
   node set, which deliberately sits outside the core limit. */
export const CORE_PORTS = [10086, 10087];
export const NODE_PORT = 10088;

function blank() {
  return {
    version: SCHEMA_VERSION,
    admin: null,                       // { user, salt, hash } — set on first run
    core: { inbounds: [], clients: [] },
    nodes: {
      remark: null,                    // { id, name, createdAt, addresses, ports }
      clients: [],
      settings: {
        // Left empty on purpose. With no hand-picked addresses the generator
        // resolves the domain's own A and AAAA records, which already yields
        // several distinct Cloudflare edges.
        cleanIPs: [],
        includeIPv6: false,   // Iranian mobile carriers handle v6 poorly
        // Cloudflare proxies six HTTPS ports, but many mobile networks only
        // let 443 through. Starting with 443 alone means every generated node
        // has a real chance; the rest are one tap away for networks that
        // allow them.
        httpsPorts: [443],
        httpPorts: [],
        fingerprint: 'chrome',
        alpn: 'http/1.1',
        fragment: true,
        prefix: 'RP',
        maxNodes: 150          // soft cap: v2rayNG gets sluggish past a point
      }
    },
    domains: { node: null, panel: null, verifiedAt: null },
    railway: { token: null, checkedAt: null, account: null },
    setup: { complete: false, at: null },
    meta: { createdAt: null, lastBackupAt: null }
  };
}

let cache = null;

export function load() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  if (!existsSync(FILE)) {
    cache = blank();
    cache.meta.createdAt = new Date().toISOString();
    persist();
    return cache;
  }

  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    cache = migrate(parsed);
  } catch (err) {
    // A corrupt file must not take the panel down, and must not be
    // silently overwritten either.
    const rescued = FILE + '.corrupt-' + Date.now();
    try { renameSync(FILE, rescued); } catch {}
    console.error(`data file unreadable (${err.message}); moved to ${rescued}`);
    cache = blank();
    cache.meta.createdAt = new Date().toISOString();
    persist();
  }
  return cache;
}

function migrate(data) {
  const fresh = blank();
  const merged = { ...fresh, ...data };
  // Fill in any object the file predates, without dropping what it has.
  for (const key of ['core', 'nodes', 'domains', 'railway', 'meta', 'setup']) {
    merged[key] = { ...fresh[key], ...(data[key] || {}) };
  }
  merged.nodes.settings = { ...fresh.nodes.settings, ...(data.nodes?.settings || {}) };
  merged.version = SCHEMA_VERSION;
  return merged;
}

export function persist() {
  if (!cache) return;
  writeFileSync(TMP, JSON.stringify(cache, null, 2), { mode: 0o600 });
  renameSync(TMP, FILE);          // rename is atomic, so a crash mid-write
}                                  // can never leave a half-written file

export function update(fn) {
  const data = load();
  const result = fn(data);
  persist();
  return result;
}

/* ------------------------------------------------------------------
   Secrets at rest.

   The Railway token is encrypted with a key derived from the admin
   password, which the panel only holds while someone is signed in.
   Lifting the data file off the volume therefore does not reveal it.
   ------------------------------------------------------------------ */
export function sealSecret(plaintext, kek) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  };
}

export function openSecret(sealed, kek) {
  if (!sealed?.ct) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    // Wrong key, or the file was tampered with. Either way there is no
    // usable token — say so rather than guessing.
    return null;
  }
}

export function dataFile() { return FILE; }
