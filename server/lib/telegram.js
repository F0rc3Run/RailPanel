import { load, update } from './store.js';

/* Notifications only: the bot never accepts commands. Anyone who learns the
   chat id should not be able to drive the panel through it, and a one-way
   channel has no surface to attack. */

const API = 'https://api.telegram.org/bot';
const TIMEOUT_MS = 10000;

export const PRESETS = {
  '15m': '*/15 * * * *',
  '1h': '0 * * * *',
  '6h': '0 */6 * * *',
  'daily': '0 9 * * *',
  'weekly': '0 9 * * 1'
};

export const EVENTS = [
  { key: 'outboundDown', group: 'outbound' },
  { key: 'outboundUp', group: 'outbound' },
  { key: 'xrayCrash', group: 'xray' },
  { key: 'nodesDown', group: 'nodes' },
  { key: 'nodesUp', group: 'nodes' },
  { key: 'cpuHigh', group: 'system' },
  { key: 'memoryHigh', group: 'system' },
  { key: 'loginSuccess', group: 'security' }
];

export function defaults() {
  return {
    enabled: false,
    botToken: null,
    chatId: null,
    schedule: '1h',            // a preset key, or 'custom'
    cron: PRESETS['1h'],
    sendBackup: true,
    thresholds: { cpu: 85, memory: 85 },
    events: Object.fromEntries(EVENTS.map(e => [e.key, true]))
  };
}

/* The token is sealed at rest with the admin's key, so it is unsealed once
   after sign-in and held in memory for the notifier to use. */
let activeToken = null;
export function useToken(value) { activeToken = value || null; }
export function hasActiveToken() { return Boolean(activeToken); }

export function config() {
  return { ...defaults(), ...(load().telegram || {}) };
}

/* The token is not returned to the browser — only whether one is set. */
export function publicConfig() {
  const c = config();
  const { botToken, ...rest } = c;
  return { ...rest, hasToken: Boolean(botToken) };
}

async function call(method, body, token = null) {
  const useToken = token || activeToken;
  if (!useToken) return { ok: false, message: 'no bot token set' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${useToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await res.json().catch(() => null);
    if (!payload?.ok) {
      return { ok: false, message: payload?.description || `Telegram answered ${res.status}` };
    }
    return { ok: true, result: payload.result };
  } catch (err) {
    return {
      ok: false,
      message: err.name === 'AbortError' ? 'Telegram did not answer in time' : err.message
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function verify(token, chatId) {
  const me = await call('getMe', {}, token);
  if (!me.ok) return me;
  const sent = await call('sendMessage', {
    chat_id: chatId,
    text: 'RailPanel is connected. This chat will receive alerts and reports.'
  }, token);
  if (!sent.ok) return sent;
  return { ok: true, bot: me.result?.username || null };
}

export async function send(text) {
  const c = config();
  if (!c.enabled || !c.chatId || !activeToken) return { ok: false, message: 'notifications are off' };
  return call('sendMessage', { chat_id: c.chatId, text, parse_mode: 'HTML' });
}

/* Multipart by hand, because a file upload is the one thing Telegram will not
   take as JSON and there is no form-data library here. */
export async function sendDocument(buffer, filename, caption) {
  const c = config();
  if (!c.enabled || !c.chatId || !activeToken) return { ok: false, message: 'notifications are off' };

  const boundary = '----RailPanel' + Math.random().toString(36).slice(2);
  const parts = [];
  const field = (name, value) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;

  parts.push(Buffer.from(field('chat_id', c.chatId), 'utf8'));
  if (caption) parts.push(Buffer.from(field('caption', caption), 'utf8'));
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
    'Content-Type: application/json\r\n\r\n', 'utf8'));
  parts.push(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'utf8'));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${API}${activeToken}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(parts),
      signal: controller.signal
    });
    const payload = await res.json().catch(() => null);
    if (!payload?.ok) return { ok: false, message: payload?.description || `Telegram answered ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export function save(input, sealed) {
  return update(data => {
    const current = { ...defaults(), ...(data.telegram || {}) };
    const next = {
      ...current,
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled,
      chatId: input.chatId !== undefined ? String(input.chatId).trim() : current.chatId,
      schedule: input.schedule || current.schedule,
      sendBackup: input.sendBackup !== undefined ? Boolean(input.sendBackup) : current.sendBackup,
      thresholds: {
        cpu: clampPercent(input.thresholds?.cpu, current.thresholds.cpu),
        memory: clampPercent(input.thresholds?.memory, current.thresholds.memory)
      },
      events: { ...current.events, ...(input.events || {}) }
    };
    next.cron = input.schedule === 'custom'
      ? String(input.cron || current.cron).trim()
      : (PRESETS[next.schedule] || PRESETS['1h']);
    if (sealed !== undefined) next.botToken = sealed;
    data.telegram = next;
    return next;
  });
}

function clampPercent(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.round(n)));
}
