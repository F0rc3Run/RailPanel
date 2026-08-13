import { execFile } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { uptime } from 'node:os';

const BIN = process.env.XRAY_BIN || '/usr/local/xray/xray';
const DATA_DIR = process.env.DATA_DIR || '/data';
const UPDATE_DIR = join(DATA_DIR, 'xray');

/* An updated Xray is written to the volume, not over the image. The image is
   rebuilt on every deploy and would throw the update away; the volume
   survives, so start.sh prefers a newer binary there if one exists. */
export function installedPath() {
  const local = join(UPDATE_DIR, 'xray');
  return existsSync(local) ? local : BIN;
}

function run(bin, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim() });
      resolve({ ok: true, stdout: String(stdout) });
    });
  });
}

export async function xrayVersion() {
  const result = await run(installedPath(), ['version'], 5000);
  if (!result.ok) return { ok: false, error: result.error };
  // First line looks like: Xray 25.6.8 (Xray, Penetrates Everything.) ...
  const match = result.stdout.match(/Xray\s+v?(\d+\.\d+\.\d+)/i);
  return {
    ok: true,
    version: match ? match[1] : null,
    raw: result.stdout.split('\n')[0].trim(),
    fromVolume: installedPath() !== BIN
  };
}

/* The newest published release, asked of GitHub directly. Failure here is not
   an error state — it only means the panel cannot say whether an update
   exists, which is different from saying there is none. */
let releaseCache = { at: 0, value: null };

export async function latestRelease() {
  /* GitHub rate-limits unauthenticated calls hard, and the dashboard polls
     every fifteen seconds. A release does not appear more than once a week,
     so the answer is held for an hour. */
  if (releaseCache.value && Date.now() - releaseCache.at < 60 * 60 * 1000) {
    return releaseCache.value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.github.com/repos/XTLS/Xray-core/releases/latest', {
      headers: { 'User-Agent': 'RailPanel', Accept: 'application/vnd.github+json' },
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, error: `GitHub answered ${res.status}` };
    const data = await res.json();
    const tag = String(data.tag_name || '').replace(/^v/, '');
    releaseCache = { at: Date.now(), value: { ok: true, version: tag || null, url: data.html_url || null } };
    return releaseCache.value;
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'GitHub did not answer in time' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function compare(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function isNewer(candidate, current) {
  return compare(candidate, current) > 0;
}

/* Downloads a release into the volume and swaps it in atomically. The running
   process is left alone; the caller restarts Xray once this returns. */
async function assetUrl(tag) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.github.com/repos/XTLS/Xray-core/releases/tags/${tag}`, {
      headers: { 'User-Agent': 'RailPanel', Accept: 'application/vnd.github+json' },
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, message: `GitHub answered ${res.status} for release ${tag}` };
    const data = await res.json();
    const names = (data.assets || []).map(a => a.name);
    const wanted = (data.assets || []).find(a =>
      /^Xray-linux-(64|amd64)\.zip$/i.test(a.name));
    if (!wanted) {
      return { ok: false, message: `no linux amd64 archive in ${tag} (saw: ${names.slice(0, 6).join(', ')})` };
    }
    return { ok: true, url: wanted.browser_download_url, name: wanted.name };
  } catch (err) {
    return { ok: false, message: err.name === 'AbortError' ? 'GitHub did not answer in time' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function installVersion(version) {
  const tag = 'v' + String(version).replace(/^v/, '');

  /* The asset name has not been stable across releases, so rather than
     hard-coding one guess the release is asked which files it actually has
     and the matching Linux amd64 archive is taken from the answer. */
  const asset = await assetUrl(tag);
  if (!asset.ok) return { ok: false, message: asset.message };
  const url = asset.url;

  if (!existsSync(UPDATE_DIR)) mkdirSync(UPDATE_DIR, { recursive: true });
  const zip = join(UPDATE_DIR, 'download.zip');
  const staging = join(UPDATE_DIR, 'staging');

  const fetched = await run('/bin/sh', ['-c',
    `curl -fsSL --max-time 120 "${url}" -o "${zip}"`], 130000);
  if (!fetched.ok) return { ok: false, message: `download failed: ${fetched.error}` };

  const unpacked = await run('/bin/sh', ['-c',
    `rm -rf "${staging}" && mkdir -p "${staging}" && unzip -oq "${zip}" -d "${staging}" && rm -f "${zip}"`], 60000);
  if (!unpacked.ok) return { ok: false, message: `could not unpack: ${unpacked.error}` };

  const fresh = join(staging, 'xray');
  if (!existsSync(fresh)) return { ok: false, message: 'the archive did not contain an xray binary' };
  chmodSync(fresh, 0o755);

  // Confirm it runs before it becomes the one in use.
  const check = await run(fresh, ['version'], 8000);
  if (!check.ok) return { ok: false, message: `the downloaded binary did not run: ${check.error}` };

  renameSync(fresh, join(UPDATE_DIR, 'xray'));
  return { ok: true, version: String(version).replace(/^v/, '') };
}

/* ---- uptime ---- */

export function osUptimeSec() {
  return Math.floor(uptime());
}

export function xrayUptimeSec(startedAt) {
  if (!startedAt) return null;
  return Math.floor((Date.now() - startedAt) / 1000);
}

/* ---- the address the outside world sees ---- */

let cachedIp = { at: 0, value: null };

export async function publicAddress() {
  // Cached: this is a fixed property of the deployment, not a live metric,
  // and the dashboard asks every fifteen seconds.
  if (cachedIp.value && Date.now() - cachedIp.at < 30 * 60 * 1000) return cachedIp.value;

  const sources = ['https://api.ipify.org?format=json', 'https://ifconfig.co/json'];
  for (const url of sources) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'RailPanel' }, signal: controller.signal });
      if (!res.ok) continue;
      const data = await res.json();
      const ip = data.ip || data.address || null;
      if (ip) {
        cachedIp = { at: Date.now(), value: { ip, source: new URL(url).host } };
        return cachedIp.value;
      }
    } catch { /* try the next source */ } finally { clearTimeout(timer); }
  }
  return null;
}
