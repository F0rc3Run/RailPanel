import { toSvg } from './qr.js';

/* The page a person sees when they open their subscription link in a
   browser. Clients that ask for the raw list still get it — see the
   content negotiation in index.js — so this never gets in their way. */

const FORMAT_LABEL = {
  v2ray: 'a base64 list of vless links',
  clash: 'a Clash Meta YAML profile',
  singbox: 'a sing-box JSON profile'
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  const v = Number(n || 0);
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, out = v;
  while (out >= 1024 && i < units.length - 1) { out /= 1024; i++; }
  return `${out < 10 ? out.toFixed(1) : Math.round(out)} ${units[i]}`;
}

/* Below two days an answer in days is useless — "0 days left" reads as
   expired when there are still hours to go. */
function timeLeft(expiry) {
  if (!expiry) return null;
  const ms = Math.max(0, new Date(expiry).getTime() - Date.now());
  if (ms >= 2 * 86400000) {
    const days = Math.ceil(ms / 86400000);
    return { value: days, unit: days === 1 ? 'day left' : 'days left', expired: false };
  }
  if (ms >= 3600000) {
    const hours = Math.floor(ms / 3600000);
    return { value: hours, unit: hours === 1 ? 'hour left' : 'hours left', expired: false };
  }
  if (ms > 0) {
    const mins = Math.max(1, Math.floor(ms / 60000));
    return { value: mins, unit: mins === 1 ? 'minute left' : 'minutes left', expired: false };
  }
  return { value: 0, unit: 'expired', expired: true };
}

/* Says the length in whatever unit reads naturally, so half an hour is not
   shown as "0.02 days". */
function spanOf(minutes) {
  if (!minutes) return null;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return { value: days, unit: days === 1 ? 'day' : 'days' };
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return { value: hours, unit: hours === 1 ? 'hour' : 'hours' };
  }
  if (minutes >= 1440) {
    const days = Math.round(minutes / 144) / 10;
    return { value: days, unit: 'days' };
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 6) / 10;
    return { value: hours, unit: 'hours' };
  }
  return { value: minutes, unit: minutes === 1 ? 'minute' : 'minutes' };
}

export function render({ client, remark, subUrl, links, nodeCount, clientApp = 'v2ray', social = {} }) {
  const limit = Number(client.limitBytes || 0);
  const used = Number(client.usedBytes || 0);
  const remaining = limit ? Math.max(0, limit - used) : null;
  const usedPct = limit ? Math.min(100, Math.round(used / limit * 100)) : 0;

  const realExpiry = client.effectiveExpiry || client.expiry;
  const left = timeLeft(realExpiry);
  const durationMinutes = Number(client.durationMinutes
    ?? (client.durationHours || 0) * 60
    ?? (client.durationDays || 0) * 1440) || 0;
  const span = spanOf(durationMinutes);
  /* Only pending if there is actually something to count down. The switch on
     its own, with no duration, means no time limit at all. */
  const pendingStart = !realExpiry && client.startAfterFirstUse && durationMinutes > 0;
  const expired = left ? left.expired : false;
  const overQuota = limit > 0 && used >= limit;

  /* One address for everyone: the panel reads the client's User-Agent and
     serves the matching format. The suffixed form stays available for a
     client that reports itself as something unexpected. */
  const clientUrl = subUrl;
  const explicitUrl = `${subUrl}/${clientApp}`;
  const qr = toSvg(clientUrl, { scale: 5, quiet: 3, dark: 'currentColor' });

  /* Picking a client rewrites the subscription itself, not just a label:
     Clash gets YAML, sing-box gets JSON, the v2ray family gets the base64
     list. The page reloads with ?client= so the QR encodes the right URL. */
  const APPS = [
    { key: 'v2ray', name: 'v2rayNG / v2rayN' },
    { key: 'v2ray', name: 'Streisand', alias: true },
    { key: 'clash', name: 'Clash Meta' },
    { key: 'clash', name: 'Mihomo', alias: true },
    { key: 'singbox', name: 'sing-box' },
    { key: 'singbox', name: 'Hiddify', alias: true }
  ];

  return `<!DOCTYPE html>
<html lang="en" data-theme="default">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${esc(client.tag)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{ --glass-blur:18px; }
:root[data-theme="default"]{
  --bg:#150E26; --bg-deep:#0D0818;
  --surface:rgba(40,28,68,.55); --surface-2:rgba(51,36,85,.6); --surface-3:rgba(58,43,94,.55);
  --solid:#1E1535;
  --line:rgba(160,130,235,.22); --line-soft:rgba(160,130,235,.13);
  --ink:#F0EAFB; --ink-dim:#A294CA; --ink-faint:#6E5F96;
  --hot:#FF4D8D; --cool:#7C5CFF; --ok:#3DDC97; --warn:#FFC24B; --bad:#FF5C5C;
  --track:rgba(120,95,190,.22);
  --glow:0 0 34px -6px rgba(124,92,255,.55);
  --sheen:linear-gradient(140deg,rgba(255,255,255,.09),rgba(255,255,255,0) 46%);
}
:root[data-theme="light"]{
  --bg:#F0F2F5; --bg-deep:#E4E9EF;
  --surface:rgba(255,255,255,.62); --surface-2:rgba(255,255,255,.78); --surface-3:rgba(240,246,250,.7);
  --solid:#FFFFFF;
  --line:rgba(20,80,110,.16); --line-soft:rgba(20,80,110,.09);
  --ink:#0F2733; --ink-dim:#41616F; --ink-faint:#7E96A2;
  --hot:#12B5C4; --cool:#4A93F5; --ok:#0E9F6E; --warn:#B5781A; --bad:#D24A4A;
  --track:rgba(20,80,110,.13);
  --glow:0 10px 34px -14px rgba(74,147,245,.45);
  --sheen:linear-gradient(140deg,rgba(255,255,255,.85),rgba(255,255,255,.2) 46%);
}
:root[data-theme="dark"]{
  --bg:#000000; --bg-deep:#000000;
  --surface:rgba(10,18,70,.5); --surface-2:rgba(0,16,163,.3); --surface-3:rgba(0,25,255,.16);
  --solid:#05070F;
  --line:rgba(0,25,255,.4); --line-soft:rgba(0,25,255,.2);
  --ink:#FFFFFF; --ink-dim:#A9B6FF; --ink-faint:#6472C9;
  --hot:#0019FF; --cool:#5C7BFF; --ok:#2FE08A; --warn:#FFB020; --bad:#FF4D5E;
  --track:rgba(0,25,255,.22);
  --glow:0 0 40px -6px rgba(0,25,255,.7);
  --sheen:linear-gradient(140deg,rgba(90,120,255,.14),rgba(0,0,0,0) 46%);
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:
    radial-gradient(70% 55% at 15% 0%, color-mix(in oklab,var(--cool) 22%,transparent), transparent 60%),
    radial-gradient(60% 50% at 85% 100%, color-mix(in oklab,var(--hot) 18%,transparent), transparent 62%),
    var(--bg);
  background-attachment:fixed;
  color:var(--ink);font-family:"Space Grotesk",system-ui,sans-serif;
  font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased;padding:18px 14px 40px}
.mono{font-family:"JetBrains Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
.wrap{max-width:520px;margin:0 auto;display:grid;gap:12px}
.card{background:var(--surface);border:1px solid var(--line-soft);border-radius:22px;padding:18px;
  position:relative;overflow:hidden;
  backdrop-filter:blur(var(--glass-blur)) saturate(150%);
  -webkit-backdrop-filter:blur(var(--glass-blur)) saturate(150%)}
.card::before{content:"";position:absolute;inset:0;pointer-events:none;background:var(--sheen)}
.card > *{position:relative}
.eyebrow{font-family:"JetBrains Mono",monospace;font-size:9.5px;font-weight:500;
  letter-spacing:.19em;text-transform:uppercase;color:var(--ink-faint)}
.head{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.mark{width:42px;height:42px;border-radius:50%;flex:none;position:relative;
  background:conic-gradient(from 140deg,var(--hot),var(--cool),var(--hot));display:grid;place-items:center}
.mark::after{content:"";position:absolute;inset:2px;border-radius:50%;background:var(--surface)}
.mark b{position:relative;z-index:1;font-size:15px;
  background:linear-gradient(120deg,var(--hot),var(--cool));-webkit-background-clip:text;background-clip:text;color:transparent}
.name{font-size:20px;font-weight:600;letter-spacing:-.03em}
.tag{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:99px;
  font-size:11px;background:var(--surface-2);border:1px solid var(--line);color:var(--ink-dim)}
.tag.ok{color:var(--ok);border-color:color-mix(in oklab,var(--ok) 40%,transparent)}
.tag.bad{color:var(--bad);border-color:color-mix(in oklab,var(--bad) 45%,transparent)}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stat .big{font-size:26px;font-weight:700;letter-spacing:-.04em;line-height:1.1;
  background:linear-gradient(100deg,var(--hot),var(--cool));-webkit-background-clip:text;background-clip:text;color:transparent}
.stat .sub{font-size:11px;color:var(--ink-faint);margin-top:2px}
.bar{height:8px;border-radius:99px;background:var(--track);overflow:hidden;margin-top:12px}
.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--hot),var(--cool))}
.note{margin-top:12px;padding:11px 13px;border-radius:14px;background:var(--surface-2);
  border:1px solid var(--line);font-size:12.5px;color:var(--ink-dim);white-space:pre-wrap}
.qr{display:grid;place-items:center;padding:16px 0 6px;color:var(--ink)}
.qr svg{width:min(232px,64vw);height:auto;background:#fff;padding:10px;border-radius:14px;color:#000}
.row{display:flex;gap:8px;align-items:center;margin-top:10px}
.row input{flex:1;min-width:0;padding:10px 12px;border-radius:13px;background:var(--surface-3);
  border:1px solid var(--line);color:var(--ink);font-family:"JetBrains Mono",monospace;font-size:11px}
.btn{padding:10px 15px;border-radius:13px;border:0;font:inherit;font-size:12.5px;font-weight:600;
  color:#fff;background:linear-gradient(100deg,var(--hot),var(--cool));cursor:pointer;flex:none}
.btn.ghost{background:none;border:1px solid var(--line);color:var(--ink-dim);font-weight:500}
.apps{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:12px}
.apps a{display:block;padding:11px 13px;border-radius:13px;background:var(--surface-2);
  border:1px solid var(--line);color:var(--ink-dim);text-decoration:none;font-size:12.5px;transition:.16s}
.apps a:hover{color:var(--ink);border-color:var(--cool)}
.rows{display:grid;gap:8px;margin-top:12px}
.rows div{display:flex;justify-content:space-between;gap:12px;font-size:12.5px}
.rows span:first-child{color:var(--ink-dim)}
.apps a.on{color:var(--ink);border-color:transparent;
  background:linear-gradient(100deg,var(--hot),var(--cool));color:#fff}
.hint{margin-top:10px;font-size:11.5px;color:var(--ink-faint)}
.hint b{color:var(--ink-dim);font-weight:500}
.hint code{font-family:"JetBrains Mono",monospace;font-size:10.5px;color:var(--ink-dim);
  word-break:break-all;background:var(--surface-2);padding:1px 5px;border-radius:6px}
.social{display:flex;gap:10px;justify-content:center;margin-top:8px}
.social a{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;
  background:var(--surface);border:1px solid var(--line);color:var(--ink-dim);
  text-decoration:none;transition:.2s}
.social a:hover{color:var(--ink);border-color:var(--cool);transform:translateY(-2px)}
.foot{text-align:center;color:var(--ink-faint);font-size:11px;margin-top:6px}
.foot b{font-weight:400;background:linear-gradient(120deg,var(--hot),var(--cool));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.themer{position:fixed;top:12px;inset-inline-end:12px;width:36px;height:36px;border-radius:50%;
  display:grid;place-items:center;background:var(--surface);border:1px solid var(--line);
  color:var(--ink-dim);cursor:pointer}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<button class="themer" id="themer" aria-label="Switch theme">
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" opacity=".55"/></svg>
</button>

<div class="wrap">
  <div class="card">
    <div class="head">
      <div class="mark"><b>rp</b></div>
      <div>
        <div class="name">${esc(client.tag)}</div>
        <div class="eyebrow">${esc(remark.name)}</div>
      </div>
      <div style="margin-inline-start:auto">
        <span class="tag ${expired || overQuota ? 'bad' : 'ok'}">
          ${expired ? 'expired' : overQuota ? 'quota used up' : 'active'}
        </span>
      </div>
    </div>

    <div class="stats" style="margin-top:16px">
      <div class="stat">
        <div class="big mono">${limit ? fmtBytes(remaining) : '∞'}</div>
        <div class="sub">${limit ? `left of ${fmtBytes(limit)}` : 'unlimited traffic'}</div>
      </div>
      <div class="stat">
        <div class="big mono">${left ? left.value : (pendingStart && span ? span.value : '∞')}</div>
        <div class="sub">${left ? left.unit : (pendingStart && span ? `${span.unit}, once you connect` : 'no time limit')}</div>
      </div>
    </div>
    ${limit ? `<div class="bar"><i style="width:${usedPct}%"></i></div>` : ''}
    ${client.comment ? `<div class="note">${esc(client.comment)}</div>` : ''}
  </div>

  <div class="card">
    <div class="eyebrow">Scan to import</div>
    <div class="qr">${qr}</div>
    <div class="row">
      <input id="subUrl" value="${esc(clientUrl)}" readonly onclick="this.select()">
      <button class="btn" data-copy="#subUrl">Copy</button>
    </div>
    <div class="row">
      <button class="btn ghost" id="copyAll" style="flex:1">Copy all ${nodeCount} servers</button>
    </div>
  </div>

  <div class="card">
    <div class="eyebrow">The subscription link is compatible with your selected client</div>
    <div class="apps">
      ${APPS.map(a => `<a class="${a.key === clientApp ? 'on' : ''}" href="?client=${a.key}">${esc(a.name)}</a>`).join('')}
    </div>
    <div class="hint">The one link above works for all of them &mdash; it detects your app and serves <b>${esc(FORMAT_LABEL[clientApp])}</b> to it. If your app gets the wrong one, use <code>${esc(explicitUrl)}</code>.</div>
  </div>

  <div class="card">
    <div class="eyebrow">Details</div>
    <div class="rows">
      <div><span>Servers</span><b class="mono">${nodeCount}</b></div>
      <div><span>Used</span><b class="mono">${fmtBytes(used)}</b></div>
      <div><span>Expires</span><b class="mono"><span data-when="${realExpiry ? esc(realExpiry) : ''}">${realExpiry ? esc(new Date(realExpiry).toISOString().slice(0, 16).replace('T', ' ') + ' UTC') : (pendingStart ? 'on first use' : 'never')}</span></b></div>
      <div><span>Updated</span><b class="mono"><span data-when="${new Date().toISOString()}">${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</span></b></div>
    </div>
  </div>

  <div class="social">
    <a href="${esc(social.github || 'https://github.com/F0rc3Run/RailPanel')}" target="_blank" rel="noopener" aria-label="GitHub" title="GitHub">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.9c-2.78.62-3.37-1.2-3.37-1.2-.46-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.85.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.03 10.03 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"/></svg>
    </a>
    <a href="${esc(social.telegram || 'https://t.me/ForceRunVPN')}" target="_blank" rel="noopener" aria-label="Telegram" title="Telegram">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.8 19c-.23 1.04-.85 1.3-1.72.81l-4.76-3.5-2.3 2.2c-.25.26-.47.48-.96.48l.34-4.85 8.83-7.98c.38-.34-.09-.53-.6-.19L6.72 12.8l-4.7-1.47c-1.02-.32-1.04-1.02.21-1.51l18.38-7.08c.85-.31 1.6.2 1.3 1.56Z"/></svg>
    </a>
  </div>
  <div class="foot">Generated with <b>&#10084;</b> by ForceRun</div>
</div>

<script>
const root = document.documentElement;
const saved = (function(){ try { return localStorage.getItem('rp-theme'); } catch { return null; } })();
if (saved) root.dataset.theme = saved;
var THEMES = ['light', 'default', 'dark'];
document.getElementById('themer').onclick = function () {
  var at = THEMES.indexOf(root.dataset.theme);
  root.dataset.theme = THEMES[(at + 1) % THEMES.length];
  try { localStorage.setItem('rp-theme', root.dataset.theme); } catch {}
};

const ALL_LINKS = ${JSON.stringify(links)};


async function copyText(text, button) {
  const original = button.textContent;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch {
    const area = document.createElement('textarea');
    area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    try { ok = document.execCommand('copy'); } catch {}
    area.remove();
  }
  button.textContent = ok ? 'Copied' : 'Press and hold to copy';
  setTimeout(() => { button.textContent = original; }, 1600);
}

document.querySelectorAll('[data-copy]').forEach(b => {
  b.onclick = () => copyText(document.querySelector(b.dataset.copy).value, b);
});
document.getElementById('copyAll').onclick = e => copyText(ALL_LINKS.join('\\n'), e.currentTarget);


/* Server-rendered timestamps are UTC. Restate them in the reader's own zone.
   Written without template placeholders: this script lives inside one, and
   they would be substituted before it ever reached the browser. */
document.querySelectorAll('[data-when]').forEach(function (el) {
  var d = new Date(el.dataset.when);
  if (isNaN(d.getTime())) return;
  var pad = function (n) { return String(n).padStart(2, '0'); };
  el.textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
});
</script>
</body>
</html>`;
}
