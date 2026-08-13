import { load } from './store.js';
import * as telegram from './telegram.js';
import * as backup from './backup.js';
import * as sysstat from './sysstat.js';
import * as sysinfo from './sysinfo.js';
import * as xray from './xray.js';

/* ------------------------------------------------------------------
   Cron

   Five fields, with the usual wildcards, steps, ranges and lists. Written here
   rather than pulled in, and matched to the minute — the scheduler runs once
   a minute and asks whether this expression is due.
   ------------------------------------------------------------------ */
function fieldMatches(field, value, min, max) {
  for (const part of String(field).split(',')) {
    const piece = part.trim();
    if (piece === '*') return true;

    const step = piece.includes('/') ? Number(piece.split('/')[1]) : 1;
    const range = piece.split('/')[0];
    if (!Number.isFinite(step) || step < 1) continue;

    let from = min, to = max;
    if (range !== '*') {
      if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number);
        from = a; to = b;
      } else {
        from = to = Number(range);
      }
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (value < from || value > to) continue;
    if ((value - from) % step === 0) return true;
  }
  return false;
}

export function cronMatches(expr, date = new Date()) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, mon, dow] = fields;
  return fieldMatches(min, date.getMinutes(), 0, 59)
    && fieldMatches(hour, date.getHours(), 0, 23)
    && fieldMatches(dom, date.getDate(), 1, 31)
    && fieldMatches(mon, date.getMonth() + 1, 1, 12)
    && fieldMatches(dow, date.getDay(), 0, 6);
}

export function cronValid(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return false;
  // A valid expression matches something within a day of minutes.
  const probe = new Date();
  for (let i = 0; i < 1440; i++) {
    if (cronMatches(expr, new Date(probe.getTime() + i * 60000))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------
   Event detection

   Alerts fire on a change of state, never on the state itself. A tunnel that
   is down stays down, and repeating that every thirty seconds would train
   anyone to ignore the channel.
   ------------------------------------------------------------------ */
const seen = {
  outbound: null,
  nodes: null,
  cpuHigh: false,
  memoryHigh: false,
  xrayRunning: null
};

function enabled(key) {
  const c = telegram.config();
  return c.enabled && c.events?.[key] !== false;
}

async function reachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return res.ok || res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkOutbound() {
  const up = await reachable('https://www.gstatic.com/generate_204');
  if (seen.outbound === null) { seen.outbound = up; return; }
  if (up === seen.outbound) return;
  seen.outbound = up;
  if (up && enabled('outboundUp')) {
    await telegram.send('🟢 <b>Outbound is back</b>\nThe server can reach the internet again.');
  } else if (!up && enabled('outboundDown')) {
    await telegram.send('🔴 <b>Outbound is down</b>\nThe server cannot reach the internet.');
  }
}

export async function checkNodes() {
  const data = load();
  const domain = data.domains?.node;
  const remark = data.nodes?.remark;
  if (!domain || !remark) return;

  const up = await reachable(`https://${domain}/`);
  if (seen.nodes === null) { seen.nodes = up; return; }
  if (up === seen.nodes) return;
  seen.nodes = up;
  if (up && enabled('nodesUp')) {
    await telegram.send(`🟢 <b>Nodes are back</b>\n${domain} is answering again.`);
  } else if (!up && enabled('nodesDown')) {
    await telegram.send(`🔴 <b>Nodes are down</b>\n${domain} is not answering.`);
  }
}

export function checkXray() {
  const running = typeof xray.running === 'function' ? xray.running() : true;
  if (seen.xrayRunning === null) { seen.xrayRunning = running; return; }
  if (running === seen.xrayRunning) return;
  const wasRunning = seen.xrayRunning;
  seen.xrayRunning = running;
  if (wasRunning && !running && enabled('xrayCrash')) {
    telegram.send('🔴 <b>Xray stopped</b>\nThe core exited and is being restarted.');
  }
}

export async function checkSystem() {
  const c = telegram.config();
  const stats = sysstat.snapshot();

  if (stats.cpu !== null && stats.cpu !== undefined) {
    const high = stats.cpu >= (c.thresholds?.cpu ?? 85);
    if (high && !seen.cpuHigh && enabled('cpuHigh')) {
      await telegram.send(`⚠️ <b>CPU high</b>\n${stats.cpu}% (threshold ${c.thresholds.cpu}%)`);
    }
    seen.cpuHigh = high;
  }

  if (stats.memory?.total) {
    const pct = Math.round(stats.memory.used / stats.memory.total * 100);
    const high = pct >= (c.thresholds?.memory ?? 85);
    if (high && !seen.memoryHigh && enabled('memoryHigh')) {
      await telegram.send(`⚠️ <b>Memory high</b>\n${pct}% (threshold ${c.thresholds.memory}%)`);
    }
    seen.memoryHigh = high;
  }
}

export async function loginSucceeded(user, ip) {
  if (!enabled('loginSuccess')) return;
  await telegram.send(
    `🔑 <b>Signed in</b>\nUser: ${escapeHtml(user)}\nFrom: ${escapeHtml(ip)}\n${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
  );
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ------------------------------------------------------------------
   Periodic report
   ------------------------------------------------------------------ */
function fmtBytes(n) {
  const v = Number(n || 0);
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, out = v;
  while (out >= 1024 && i < units.length - 1) { out /= 1024; i++; }
  return `${out < 10 ? out.toFixed(1) : Math.round(out)} ${units[i]}`;
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export async function sendReport() {
  const data = load();
  const stats = sysstat.snapshot();
  const clients = [...(data.core.clients || []), ...(data.nodes.clients || [])];
  const used = clients.reduce((sum, c) => sum + Number(c.usedBytes || 0), 0);
  const blocked = clients.filter(c => c.enabled === false);

  const lines = [
    '📊 <b>RailPanel report</b>',
    '',
    `Traffic: <b>${fmtBytes(used)}</b> across ${clients.length} clients`,
    `Inbounds: ${(data.core.inbounds || []).length} core${data.nodes.remark ? ' + node set' : ''}`,
    `CPU ${stats.cpu ?? '—'}%  ·  Memory ${stats.memory?.total ? Math.round(stats.memory.used / stats.memory.total * 100) : '—'}%`,
    `Xray up ${fmtDuration(sysinfo.xrayUptimeSec(xray.startedAtMs()))}  ·  OS up ${fmtDuration(stats.uptimeSec)}`
  ];

  if (blocked.length) {
    lines.push('', `⚠️ ${blocked.length} client${blocked.length > 1 ? 's' : ''} blocked:`);
    for (const c of blocked.slice(0, 10)) {
      lines.push(`• ${escapeHtml(c.tag)} — ${c.disabledReason === 'quota' ? 'out of data' : 'expired'}`);
    }
  }

  await telegram.send(lines.join('\n'));

  /* The backup rides along with the report, so the most recent copy is
     always sitting in the chat — restoring never depends on remembering to
     download one. */
  const c = telegram.config();
  if (c.sendBackup) {
    const body = Buffer.from(JSON.stringify(backup.build(), null, 2), 'utf8');
    await telegram.sendDocument(body, backup.filename(),
      'Latest backup — upload this file under Backup → Restore to bring a panel back to this state.');
  }
}

/* ------------------------------------------------------------------
   Scheduler
   ------------------------------------------------------------------ */
let timer = null;
let lastReportMinute = null;

async function tick() {
  const c = telegram.config();
  if (!c.enabled || !c.chatId) return;

  checkXray();
  await checkSystem();
  await checkOutbound();
  await checkNodes();

  const now = new Date();
  const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (minute === lastReportMinute) return;       // one report per minute at most
  if (cronMatches(c.cron, now)) {
    lastReportMinute = minute;
    await sendReport();
  }
}

export function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(err => console.error('telegram:', err)); }, 60000);
  timer.unref?.();
}

export function stop() {
  clearInterval(timer);
  timer = null;
}

export { tick as runOnce };
