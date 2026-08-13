import { randomBytes, randomUUID } from 'node:crypto';
import { load, update, CORE_PORTS } from './store.js';
import { effectiveExpiry } from './enforce.js';
import { readCounters } from './stats.js';

export const MAX_INBOUNDS = CORE_PORTS.length;

/* The core side is the hand-made half of the panel: up to two inbounds the
   user configures themselves, each with its own clients. It shares the Xray
   config builder, the nginx routing and the quota engine with the node set —
   only the shape of the links differs, since a core client gets one address
   rather than a generated spread of them. */

function randomPath() {
  return '/' + randomBytes(6).toString('base64url');
}

function freePort(data) {
  const taken = new Set((data.core.inbounds || []).map(i => i.port));
  return CORE_PORTS.find(p => !taken.has(p)) || null;
}

export function coreInbounds(data) {
  return (data.core.inbounds || []).map(inbound => ({
    id: inbound.id,
    port: inbound.port,
    network: inbound.network || 'ws',
    path: inbound.path,
    host: inbound.host || '',
    enabled: inbound.enabled !== false,
    clients: (data.core.clients || []).filter(c => c.inboundId === inbound.id)
  }));
}

export function addInbound(input) {
  const data = load();
  if ((data.core.inbounds || []).length >= MAX_INBOUNDS) {
    return { ok: false, message: `only ${MAX_INBOUNDS} core inbounds are allowed` };
  }
  const port = freePort(data);
  if (!port) return { ok: false, message: 'no free port left' };

  const network = input.network === 'httpupgrade' ? 'httpupgrade' : 'ws';

  /* Paths become nginx location blocks, and two blocks for the same path
     make nginx reject the entire config — which would take the tunnel down,
     not just this inbound. */
  const wanted = String(input.path || '').trim();
  if (wanted) {
    const taken = [
      ...(data.core.inbounds || []).map(i => String(i.path).split('?')[0]),
      data.nodes.remark ? String(data.nodes.remark.path).split('?')[0] : null
    ].filter(Boolean);
    if (taken.includes(wanted.split('?')[0])) {
      return { ok: false, message: 'that path is already used by another inbound' };
    }
  }
  const inbound = {
    id: randomBytes(5).toString('hex'),
    remark: String(input.remark || '').trim().slice(0, 48) || 'inbound',
    network,
    port,                                  // assigned, never chosen
    path: String(input.path || '').trim() || randomPath(),
    host: String(input.host || '').trim(),
    address: String(input.address || '').trim(),
    enabled: true,
    createdAt: new Date().toISOString()
  };

  update(d => { d.core.inbounds.push(inbound); });
  return { ok: true, inbound };
}

export function updateInbound(id, input) {
  const data = load();
  if (!(data.core.inbounds || []).some(i => i.id === id)) {
    return { ok: false, message: 'no such inbound' };
  }
  update(d => {
    const target = d.core.inbounds.find(i => i.id === id);
    if (input.remark !== undefined) target.remark = String(input.remark).trim().slice(0, 48) || target.remark;
    if (input.network !== undefined) target.network = input.network === 'httpupgrade' ? 'httpupgrade' : 'ws';
    if (input.path !== undefined) target.path = String(input.path).trim() || target.path;
    if (input.host !== undefined) target.host = String(input.host).trim();
    if (input.address !== undefined) target.address = String(input.address).trim();
    if (input.enabled !== undefined) target.enabled = Boolean(input.enabled);
    target.updatedAt = new Date().toISOString();
  });
  return { ok: true, inbound: load().core.inbounds.find(i => i.id === id) };
}

export function removeInbound(id) {
  const data = load();
  if (!(data.core.inbounds || []).some(i => i.id === id)) {
    return { ok: false, message: 'no such inbound' };
  }
  const attached = (data.core.clients || []).filter(c => c.inboundId === id).length;
  update(d => {
    d.core.inbounds = d.core.inbounds.filter(i => i.id !== id);
    // Unlike the node remark, a core inbound owns its clients: without it
    // their links point at a path that no longer exists.
    d.core.clients = d.core.clients.filter(c => c.inboundId !== id);
  });
  return { ok: true, clientsRemoved: attached };
}

/* ---- the raw JSON view ---- */

export function inboundJson(id) {
  const data = load();
  const inbound = (data.core.inbounds || []).find(i => i.id === id);
  if (!inbound) return null;
  return {
    remark: inbound.remark,
    protocol: 'vless',
    port: inbound.port,
    listen: '127.0.0.1',
    network: inbound.network,
    path: inbound.path,
    host: inbound.host,
    address: inbound.address,
    clients: (data.core.clients || [])
      .filter(c => c.inboundId === id)
      .map(c => ({ tag: c.tag, id: c.uuid, enabled: c.enabled !== false }))
  };
}

/* Anything may be edited except the two fields the deployment depends on.
   Letting those through would let one bad edit open a port to the internet
   or detach the inbound from its nginx route. */
const LOCKED = ['port', 'listen', 'protocol'];

export function applyInboundJson(id, raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return { ok: false, message: 'that is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, message: 'expected a JSON object' };
  }

  const ignored = LOCKED.filter(key => parsed[key] !== undefined);
  const result = updateInbound(id, {
    remark: parsed.remark,
    network: parsed.network,
    path: parsed.path,
    host: parsed.host,
    address: parsed.address
  });
  if (!result.ok) return result;
  return { ok: true, inbound: result.inbound, ignored };
}

/* ---- clients ---- */

export function addClient(input) {
  const data = load();
  const inbound = (data.core.inbounds || []).find(i => i.id === input.inboundId);
  if (!inbound) return { ok: false, message: 'pick an inbound first' };

  const client = {
    id: randomBytes(6).toString('hex'),
    inboundId: inbound.id,
    uuid: randomUUID(),
    tag: String(input.tag || '').trim().slice(0, 48) || 'client',
    comment: String(input.comment || '').trim().slice(0, 200),
    subId: randomBytes(12).toString('base64url'),

    // Link presentation. Empty means "use whatever the inbound says".
    proxyAddress: String(input.proxyAddress || '').trim(),
    port: Math.max(1, Math.min(65535, Number(input.port || 443))),
    tls: input.tls === undefined ? true : Boolean(input.tls),
    sni: String(input.sni || '').trim(),
    fingerprint: String(input.fingerprint || 'chrome').trim(),
    alpn: String(input.alpn || 'http/1.1').trim(),

    // Limits, enforced by the same loop the node clients use.
    limitBytes: Math.max(0, Number(input.limitGB || 0)) * 1024 ** 3,
    startAfterFirstUse: Boolean(input.startAfterFirstUse),
    durationMinutes: Math.max(0, Math.round(Number(input.durationDays || 0) * 1440)),
    expiry: input.expiry ? new Date(input.expiry).toISOString() : null,
    autoRenewDays: Math.max(0, Number(input.autoRenewDays || 0)),

    enabled: true,
    usedBytes: 0,
    counterAt: 0,
    firstUseAt: null,
    createdAt: new Date().toISOString()
  };

  update(d => { d.core.clients.push(client); });
  return { ok: true, client };
}

export function updateClient(id, input) {
  const data = load();
  if (!(data.core.clients || []).some(c => c.id === id)) {
    return { ok: false, message: 'no such client' };
  }
  update(d => {
    const t = d.core.clients.find(c => c.id === id);
    if (input.tag !== undefined) t.tag = String(input.tag).trim().slice(0, 48) || t.tag;
    if (input.comment !== undefined) t.comment = String(input.comment).trim().slice(0, 200);
    if (input.inboundId !== undefined && d.core.inbounds.some(i => i.id === input.inboundId)) {
      t.inboundId = input.inboundId;
    }
    if (input.proxyAddress !== undefined) t.proxyAddress = String(input.proxyAddress).trim();
    if (input.port !== undefined) t.port = Math.max(1, Math.min(65535, Number(input.port) || 443));
    if (input.tls !== undefined) t.tls = Boolean(input.tls);
    if (input.sni !== undefined) t.sni = String(input.sni).trim();
    if (input.fingerprint !== undefined) t.fingerprint = String(input.fingerprint).trim();
    if (input.alpn !== undefined) t.alpn = String(input.alpn).trim();
    if (input.limitGB !== undefined) t.limitBytes = Math.max(0, Number(input.limitGB || 0)) * 1024 ** 3;
    if (input.startAfterFirstUse !== undefined) t.startAfterFirstUse = Boolean(input.startAfterFirstUse);
    if (input.durationDays !== undefined) {
      t.durationMinutes = Math.max(0, Math.round(Number(input.durationDays || 0) * 1440));
    }
    if (input.expiry !== undefined) t.expiry = input.expiry ? new Date(input.expiry).toISOString() : null;
    if (input.autoRenewDays !== undefined) t.autoRenewDays = Math.max(0, Number(input.autoRenewDays || 0));
    if (input.enabled !== undefined) t.enabled = Boolean(input.enabled);
    t.updatedAt = new Date().toISOString();
  });
  return { ok: true, client: load().core.clients.find(c => c.id === id) };
}

export function removeClient(id) {
  const data = load();
  if (!(data.core.clients || []).some(c => c.id === id)) {
    return { ok: false, message: 'no such client' };
  }
  update(d => { d.core.clients = d.core.clients.filter(c => c.id !== id); });
  return { ok: true };
}

export async function resetClientTraffic(id) {
  const client = (load().core.clients || []).find(c => c.id === id);
  let current = 0;
  const { ok, counters } = await readCounters();
  // Xray names each user "<inboundId>.<clientId>", so the baseline has to be
  // looked up under the inbound this client belongs to.
  if (ok && client) {
    const seen = counters[`${client.inboundId}.${id}`];
    if (seen) current = seen.up + seen.down;
  }
  return update(d => {
    const client = d.core.clients.find(c => c.id === id);
    if (!client) return { ok: false, message: 'no such client' };
    client.usedBytes = 0;
    client.counterAt = current;
    if (client.disabledReason === 'quota') {
      client.enabled = true;
      client.disabledReason = null;
    }
    return { ok: true };
  });
}

/* ---- the link a core client hands out ---- */

export function clientLink(id) {
  const data = load();
  const client = (data.core.clients || []).find(c => c.id === id);
  if (!client) return null;
  const inbound = (data.core.inbounds || []).find(i => i.id === client.inboundId);
  if (!inbound) return null;

  /* The inbound's address is the default; a client only overrides it when
     that field has actually been filled in. */
  const address = client.proxyAddress || inbound.address || inbound.host || data.domains.node || '';
  const host = inbound.host || address;
  const sni = client.sni || host;

  const params = new URLSearchParams({ encryption: 'none', type: inbound.network });
  if (host) params.set('host', host);
  params.set('path', inbound.path);
  if (client.tls) {
    params.set('security', 'tls');
    if (sni) params.set('sni', sni);
    if (client.fingerprint) params.set('fp', client.fingerprint);
    if (client.alpn) params.set('alpn', client.alpn);
  } else {
    params.set('security', 'none');
  }

  const authority = address.includes(':') && !address.startsWith('[')
    ? `[${address}]` : address;
  const query = params.toString().replace(/\+/g, '%20');
  return `vless://${client.uuid}@${authority}:${client.port}?${query}#${encodeURIComponent(client.tag)}`;
}

export function publicInbound(inbound, data = load()) {
  return {
    ...inbound,
    clientCount: (data.core.clients || []).filter(c => c.inboundId === inbound.id).length
  };
}

export function publicClient(client) {
  const { uuid, ...rest } = client;
  return { ...rest, effectiveExpiry: effectiveExpiry(client) };
}


/* ------------------------------------------------------------------
   Subscription

   A core client gets the same permanent address a node client does. The
   difference is only what it contains: one server instead of a generated
   spread of them. That makes the address survive edits — changing an
   inbound's path or host no longer strands links already handed out.
   ------------------------------------------------------------------ */

/* Clients created before subscriptions existed have no id yet; give them one
   the first time it is needed rather than forcing a migration. */
export function ensureSubId(clientId) {
  const client = (load().core.clients || []).find(c => c.id === clientId);
  if (!client) return null;
  if (client.subId) return client.subId;
  const subId = randomBytes(12).toString('base64url');
  update(d => {
    const target = d.core.clients.find(c => c.id === clientId);
    if (target) target.subId = subId;
  });
  return subId;
}

export function findBySubId(subId) {
  const data = load();
  const client = (data.core.clients || []).find(c => c.subId === subId);
  if (!client) return null;
  const inbound = (data.core.inbounds || []).find(i => i.id === client.inboundId);
  if (!inbound) return { client, inbound: null };
  return { client, inbound };
}

/* The one server this client points at, in the same shape the node generator
   produces, so the profile builders need no special case. */
export function subNode(client, inbound, data = load()) {
  const address = client.proxyAddress || inbound.address || inbound.host || data.domains.node || '';
  const host = inbound.host || address;
  return {
    address,
    port: client.port || 443,
    tls: client.tls !== false,
    sni: client.sni || host,
    host,
    remark: client.tag
  };
}
