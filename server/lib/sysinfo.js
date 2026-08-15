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
  /* api.github.com allows 60 unauthenticated calls an hour per address, and
     Railway's egress addresses are shared with everyone else on the
     platform — that budget is usually already spent, which is what produced
     the 403. The plain /releases/latest page redirects to the tag instead,
     and carries no such limit. */
  if (releaseCache.value && Date.now() - releaseCache.at < 60 * 60 * 1000) {
    return releaseCache.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://github.com/XTLS/Xray-core/releases/latest', {
      redirect: 'follow',
      headers: { 'User-Agent': 'RailPanel' },
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, error: `GitHub answered ${res.status}` };

    // The final address looks like .../releases/tag/v25.6.8
    const match = String(res.url || '').match(/\/releases\/tag\/v?([\d.]+)/);
    if (!match) return { ok: false, error: 'could not read the latest version from GitHub' };

    releaseCache = {
      at: Date.now(),
      value: { ok: true, version: match[1], url: res.url }
    };
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
/* Both names the project has published under. The archive is fetched from
   github.com rather than looked up through the API, so an exhausted rate
   limit cannot stop an update. */
const ASSET_NAMES = ['Xray-linux-64.zip', 'Xray-linux-amd64.zip'];

export async function installVersion(version) {
  const tag = 'v' + String(version).replace(/^v/, '');

  const base = `https://github.com/XTLS/Xray-core/releases/download/${tag}`;

  if (!existsSync(UPDATE_DIR)) mkdirSync(UPDATE_DIR, { recursive: true });
  const zip = join(UPDATE_DIR, 'download.zip');
  const staging = join(UPDATE_DIR, 'staging');

  let fetched = null;
  for (const name of ASSET_NAMES) {
    fetched = await run('/bin/sh', ['-c',
      `curl -fsSL --max-time 120 "${base}/${name}" -o "${zip}"`], 130000);
    if (fetched.ok) break;
  }
  if (!fetched || !fetched.ok) {
    return { ok: false, message: `could not download ${tag} from GitHub` };
  }

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
