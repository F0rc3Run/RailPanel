import { load, update } from './store.js';
import { readCounters, applyCounters } from './stats.js';

const INTERVAL_MS = 30_000;

/* Why a client is switched off matters: the panel and the subscription page
   both show it, and auto-renew only applies to one of them. */
export const REASONS = { QUOTA: 'quota', EXPIRED: 'expired' };

/* Stored as minutes. Records written before that used hours or days, so
   those are converted on read rather than migrated. */
export function durationMinutesOf(client) {
  if (client.durationMinutes !== undefined && client.durationMinutes !== null) {
    return Math.max(0, Math.round(Number(client.durationMinutes) || 0));
  }
  if (client.durationHours !== undefined && client.durationHours !== null) {
    return Math.max(0, Math.round(Number(client.durationHours) * 60));
  }
  return Math.max(0, Math.round(Number(client.durationDays || 0) * 1440));
}

function expiryOf(client) {
  /* With "start after first use" the clock does not run until the client
     actually connects, so a link handed out early is not quietly burning
     its own validity. */
  if (client.startAfterFirstUse) {
    const minutes = durationMinutesOf(client);
    if (!client.firstUseAt || !minutes) return null;
    return new Date(new Date(client.firstUseAt).getTime()
      + minutes * 60000).toISOString();
  }
  return client.expiry || null;
}

function renew(client, now) {
  client.expiry = new Date(now.getTime() + client.autoRenewDays * 86400000).toISOString();
  client.usedBytes = 0;
  client.firstUseAt = null;
  client.enabled = true;
  client.disabledReason = null;
  client.renewedAt = now.toISOString();
}

/* Decides each client's state from its own limits. Pure, so it can be tested
   without Xray or a clock. */
export function evaluate(clients, now = new Date()) {
  let changed = false;

  for (const client of clients) {
    const limit = Number(client.limitBytes || 0);
    const used = Number(client.usedBytes || 0);
    const expiry = expiryOf(client);

    const overQuota = limit > 0 && used >= limit;
    const pastDate = expiry && new Date(expiry).getTime() <= now.getTime();

    if (!overQuota && !pastDate) {
      // Back within limits — most often after a manual traffic reset.
      if (client.enabled === false && client.disabledReason) {
        client.enabled = true;
        client.disabledReason = null;
        changed = true;
      }
      continue;
    }

    if (client.autoRenewDays > 0) {
      renew(client, now);
      changed = true;
      continue;
    }

    const reason = overQuota ? REASONS.QUOTA : REASONS.EXPIRED;
    if (client.enabled !== false || client.disabledReason !== reason) {
      client.enabled = false;
      client.disabledReason = reason;
      client.disabledAt = now.toISOString();
      changed = true;
    }
  }

  return changed;
}

/* A date picker offers a day, not an instant. Read plainly, "2026-08-20"
   becomes midnight UTC — the very start of that day — so a client picked for
   the 20th stopped working in the small hours of the 20th and the whole day
   was lost. A chosen day means service through the end of it.

   The offset comes from the browser, so the day ends when it ends for
   whoever set it, not at whatever the server's clock happens to be. */
export function expiryFrom(value, offsetMinutes = 0) {
  if (!value) return null;
  const text = String(value).trim();

  // A full timestamp is already precise; only a bare date needs interpreting.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  if (!dateOnly) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const offset = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 0;
  /* The last instant of that day where the person is, expressed in UTC. An
     offset ahead of UTC means the day ends earlier in UTC terms, so it is
     subtracted. */
  const endOfDayUtc = new Date(`${text}T23:59:59.999Z`).getTime();
  return new Date(endOfDayUtc - offset * 60000).toISOString();
}

export function effectiveExpiry(client) {
  return expiryOf(client);
}

let timer = null;
let applyFn = async () => {};

async function tick() {
  const data = load();
  const nodeClients = data.nodes.clients || [];
  const coreClients = data.core.clients || [];
  if (!nodeClients.length && !coreClients.length) return;

  const { ok, counters, error } = await readCounters();
  if (!ok) {
    // Xray may still be starting. Enforcement continues on stored totals so
    // an expiry is never missed just because stats were unavailable.
    if (error) console.warn('stats unavailable:', error);
  }

  let touched = false;
  update(d => {
    const nodes = d.nodes.clients || [];
    const core = d.core.clients || [];
    if (ok) {
      // Xray names users "<inboundId>.<clientId>"; the node set is one
      // inbound, core clients each carry their own.
      touched = applyCounters(nodes, counters, c => `nodeset.${c.id}`) || touched;
      touched = applyCounters(core, counters, c => `${c.inboundId}.${c.id}`) || touched;
    }
    touched = evaluate(nodes) || touched;
    touched = evaluate(core) || touched;
  });

  // Only rebuild Xray when the set of usable clients actually changed;
  // counting traffic must not restart the tunnel every half minute.
  const after = load();
  const disabled = [...(after.nodes.clients || []), ...(after.core.clients || [])]
    .filter(c => c.enabled === false).length;
  if (touched && disabled !== tick.lastDisabled) {
    tick.lastDisabled = disabled;
    await applyFn();
  }
}
tick.lastDisabled = null;

export function start(apply) {
  if (timer) return;
  applyFn = apply || applyFn;
  const initial = load();
  tick.lastDisabled = [...(initial.nodes.clients || []), ...(initial.core.clients || [])]
    .filter(c => c.enabled === false).length;
  timer = setInterval(() => { tick().catch(err => console.error('enforcement:', err)); }, INTERVAL_MS);
  timer.unref?.();
}

export function stop() {
  clearInterval(timer);
  timer = null;
}

export { tick as runOnce };
