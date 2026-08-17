import { randomUUID, randomBytes } from 'node:crypto';
import { load, update, NODE_PORT } from './store.js';
import * as nodes from './nodes.js';
import { buildProfile, normaliseClient } from './profiles.js';
import { effectiveExpiry, expiryFrom } from './enforce.js';
import { readCounters } from './stats.js';
import { coreInbounds, findBySubId, subNode } from './core.js';
import * as verifyLib from './verify.js';
import * as xray from './xray.js';
import * as nginx from './nginx.js';
import { linksForClient, subscriptionBody, subscriptionHeaders } from './links.js';
import * as links_ from './links.js';

/* The node set is one Xray inbound. It lives outside the two core slots on
   purpose, so generating nodes never costs the user an inbound. */
export function nodeInbound(data) {
  const remark = data.nodes.remark;
  if (!remark) return null;
  return {
    id: 'nodeset',
    port: NODE_PORT,
    network: remark.network || 'ws',
    path: remark.path,
    host: data.domains.node || '',
    clients: data.nodes.clients
  };
}

export function allInbounds(data) {
  const list = coreInbounds(data).filter(i => i.enabled !== false);
  const node = nodeInbound(data);
  if (node) list.push(node);
  return list;
}

/* Applying means: rewrite both configs and reload both processes. Callers
   do this after any change that alters routing or client lists. */
export async function applyRuntime() {
  const data = load();
  const inbounds = allInbounds(data);
  const web = await nginx.apply(inbounds);
  await xray.reload(inbounds);
  return { nginx: web, xray: xray.status() };
}

/* ---------------- domain ---------------- */

export async function setDomain(kind, raw) {
  const result = await verifyLib.verify(raw);
  if (!result.ok) return result;

  update(data => {
    data.domains[kind] = result.domain;
    data.domains.verifiedAt = new Date().toISOString();
    if (kind === 'node') data.domains.proxied = result.proxied === true;
  });
  return result;
}

/* ---------------- remark and generation ---------------- */

/* Cloudflare's alternate ports only answer for a proxied hostname. When the
   orange cloud is off, everything except 443/80 is a dead address, so those
   ports are dropped instead of being generated and silently failing. */
function usablePorts(settings, proxied) {
  if (proxied) return { https: settings.httpsPorts || [], http: settings.httpPorts || [] };
  return {
    https: (settings.httpsPorts || []).includes(443) ? [443] : [],
    http: (settings.httpPorts || []).includes(80) ? [80] : []
  };
}

/* Generation walks through DNS, then nginx, then Xray. Any one of them can
   fail, and a bare throw arrives at the browser as "internal error" with
   nothing to act on — so each step names itself. */
export async function generateNodes() {
  try {
    return await generateNodesInner();
  } catch (err) {
    console.error('node generation failed:', err);
    return {
      ok: false,
      code: 'exception',
      message: `${err?.step || 'generation'} failed: ${err?.message || String(err)}`
    };
  }
}

async function generateNodesInner() {
  const data = load();
  const domain = data.domains.node;
  if (!domain) {
    return { ok: false, code: 'no-domain', message: 'verify a domain first' };
  }
  if (data.nodes.remark) {
    return {
      ok: false, code: 'exists',
      message: 'a remark already exists — delete it before generating a new set'
    };
  }

  const settings = data.nodes.settings;
  let collected;
  try {
    collected = await nodes.collectAddresses(domain, settings);
  } catch (err) { err.step = 'address lookup'; throw err; }
  if (collected.warning === 'dns-failed') {
    return {
      ok: false, code: 'dns',
      message: `could not resolve ${domain}, so every node would share one address`
    };
  }

  const proxied = data.domains.proxied === true;
  const ports = usablePorts(settings, proxied);
  const built = nodes.generate({
    domain,
    settings: { ...settings, httpsPorts: ports.https, httpPorts: ports.http },
    addresses: collected.addresses
  });
  if (!built.nodes.length) {
    const why = built.reason === 'no-ports'
      ? 'no ports are selected'
      : 'no addresses are available';
    return { ok: false, code: built.reason, message: why };
  }

  // A fresh path each time makes an old, deleted set unreachable even if
  // someone kept the links.
  const path = '/' + randomBytes(9).toString('base64url');

  update(d => {
    d.nodes.remark = {
      id: randomUUID(),
      name: d.nodes.remark?.name || 'node-set',
      network: 'ws',
      path,
      createdAt: new Date().toISOString(),
      nodes: built.nodes,
      summary: nodes.summarise(built.nodes),
      truncated: built.truncated
    };
  });

  let runtime;
  try {
    runtime = await applyRuntime();
  } catch (err) { err.step = 'applying the config'; throw err; }
  return {
    ok: true,
    routing: runtime.nginx,
    summary: nodes.summarise(built.nodes),
    truncated: built.truncated,
    addresses: collected.addresses.length,
    proxied,
    warning: proxied ? null : 'not-proxied'
  };
}

export function renameRemark(name) {
  const clean = String(name || '').trim().slice(0, 48);
  if (!clean) return { ok: false, message: 'name cannot be empty' };
  return update(data => {
    if (!data.nodes.remark) return { ok: false, message: 'nothing to rename' };
    data.nodes.remark.name = clean;
    return { ok: true, name: clean };
  });
}

/* Deleting the remark drops the servers but keeps the clients, so the next
   generation picks them straight back up. */
export async function deleteRemark() {
  const had = Boolean(load().nodes.remark);
  if (!had) return { ok: false, message: 'nothing to delete' };
  update(data => { data.nodes.remark = null; });
  await applyRuntime();
  return { ok: true, clientsKept: load().nodes.clients.length };
}

export function updateSettings(patch) {
  return update(data => {
    const s = data.nodes.settings;
    if (Array.isArray(patch.httpsPorts)) {
      s.httpsPorts = patch.httpsPorts.filter(p => nodes.CF_HTTPS_PORTS.includes(Number(p)));
    }
    if (Array.isArray(patch.httpPorts)) {
      s.httpPorts = patch.httpPorts.filter(p => nodes.CF_HTTP_PORTS.includes(Number(p)));
    }
    if (typeof patch.cleanIPs === 'string' || Array.isArray(patch.cleanIPs)) {
      s.cleanIPs = nodes.parseAddressList(
        Array.isArray(patch.cleanIPs) ? patch.cleanIPs.join('\n') : patch.cleanIPs
      );
    }
    for (const key of ['fingerprint', 'prefix']) {
      if (typeof patch[key] === 'string') s[key] = patch[key].trim();
    }
    /* h2 and h3 negotiate a protocol that cannot carry a WebSocket upgrade,
       so anything other than http/1.1 is pinned rather than stored. */
    if (typeof patch.alpn === 'string') {
      s.alpn = /^http\/1\.1$/.test(patch.alpn.trim()) ? patch.alpn.trim() : 'http/1.1';
    }
    for (const key of ['includeIPv6', 'fragment']) {
      if (typeof patch[key] === 'boolean') s[key] = patch[key];
    }
    return s;
  });
}

/* ---------------- clients ---------------- */

/* The field is labelled in gigabytes, but asking someone to type 0.02 for a
   20 MB test is silly. A plain number is still gigabytes; a number with a
   unit means what it says. */
export function parseSize(input) {
  if (input === null || input === undefined || input === '') return 0;
  const text = String(input).trim().toLowerCase().replace(/\s+/g, '');
  const match = text.match(/^([0-9]*\.?[0-9]+)(kb|k|mb|m|gb|g|tb|t)?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return 0;
  const unit = match[2] || 'gb';
  const scale = { k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2,
                  g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 };
  return Math.round(value * scale[unit]);
}

/* Duration is entered the way traffic is: one number, decimals allowed.
   0.5 means half a day, 0.02 means about half an hour. It is kept in whole
   minutes so nothing rounds away. */
function minutesFrom(input, fallback = 0) {
  if (input.durationMinutes !== undefined) {
    return Math.max(0, Math.round(Number(input.durationMinutes) || 0));
  }
  if (input.durationDays !== undefined) {
    return Math.max(0, Math.round((Number(input.durationDays) || 0) * 1440));
  }
  if (input.durationHours !== undefined) {
    return Math.max(0, Math.round((Number(input.durationHours) || 0) * 60));
  }
  return fallback;
}

export async function updateClient(id, input) {
  const data = load();
  const client = data.nodes.clients.find(c => c.id === id);
  if (!client) return null;

  /* Only the fields the edit form owns. The uuid and subId stay put, so a
     link already handed out keeps working after an edit. */
  update(d => {
    const target = d.nodes.clients.find(c => c.id === id);
    if (input.tag !== undefined) target.tag = String(input.tag).trim().slice(0, 48) || target.tag;
    if (input.comment !== undefined) target.comment = String(input.comment).trim().slice(0, 200);
    if (input.limitGB !== undefined) target.limitBytes = parseSize(input.limitGB);
    if (input.startAfterFirstUse !== undefined) target.startAfterFirstUse = Boolean(input.startAfterFirstUse);
    if (input.durationMinutes !== undefined || input.durationDays !== undefined || input.durationHours !== undefined) {
      target.durationMinutes = minutesFrom(input, target.durationMinutes || 0);
      delete target.durationDays;
      delete target.durationHours;
    }
    if (input.expiry !== undefined) target.expiry = expiryFrom(input.expiry, input.tzOffset);
    if (input.autoRenewDays !== undefined) target.autoRenewDays = Math.max(0, Number(input.autoRenewDays || 0));
    if (input.enabled !== undefined) target.enabled = Boolean(input.enabled);
    if (input.resetTraffic) {
      target.usedBytes = 0;
      /* The baseline is left where it is. Zeroing it made the next reading
         look like the whole previous total had just arrived, which undid the
         reset within half a minute. */
      if (target.disabledReason === 'quota') {
        target.enabled = true;
        target.disabledReason = null;
      }
    }
    target.updatedAt = new Date().toISOString();
  });

  await applyRuntime();
  return load().nodes.clients.find(c => c.id === id);
}

export async function addClient(input) {
  const client = {
    id: randomBytes(6).toString('hex'),
    uuid: randomUUID(),
    tag: String(input.tag || '').trim().slice(0, 48) || 'client',
    comment: String(input.comment || '').trim().slice(0, 200),
    limitBytes: parseSize(input.limitGB),
    startAfterFirstUse: Boolean(input.startAfterFirstUse),
    durationMinutes: minutesFrom(input),
    expiry: expiryFrom(input.expiry, input.tzOffset),
    autoRenewDays: Math.max(0, Number(input.autoRenewDays || 0)),
    subId: randomBytes(12).toString('base64url'),
    enabled: true,
    usedBytes: 0,
    firstUseAt: null,
    createdAt: new Date().toISOString()
  };

  update(data => { data.nodes.clients.push(client); });
  await applyRuntime();
  return client;
}

export async function removeClient(id) {
  const before = load().nodes.clients.length;
  update(data => {
    data.nodes.clients = data.nodes.clients.filter(c => c.id !== id);
  });
  if (load().nodes.clients.length === before) return { ok: false, message: 'no such client' };
  await applyRuntime();
  return { ok: true };
}

export async function resetClientTraffic(id) {
  /* Xray's own counter keeps climbing — the panel only restarts it when the
     client list changes. Zeroing our baseline as well would make the next
     reading look like the whole amount arrived at once, undoing the reset.
     The baseline is therefore moved up to wherever Xray is right now. */
  let current = 0;
  const { ok, counters } = await readCounters();
  if (ok) {
    const seen = counters[`nodeset.${id}`];
    if (seen) current = seen.up + seen.down;
  }

  const result = update(data => {
    const client = data.nodes.clients.find(c => c.id === id);
    if (!client) return { ok: false, message: 'no such client' };
    const wasBlocked = client.enabled === false;
    client.usedBytes = 0;
    client.counterAt = current;
    // Time already served is not traffic; a traffic reset leaves it alone.
    if (client.disabledReason === 'quota') {
      client.enabled = true;
      client.disabledReason = null;
    }
    return { ok: true, counterAt: current, wasBlocked };
  });

  /* Re-enabling a client in the store is only half of it: one that ran out
     of traffic was taken out of Xray's config, and until that is rebuilt it
     stays unable to connect no matter what the panel shows. The enforcement
     loop will not do it either — it rebuilds on a change, and after a reset
     there is nothing left for it to change. */
  if (result.ok && result.wasBlocked) await applyRuntime();
  return result;
}

/* ---------------- links ---------------- */

export function clientLinks(clientId) {
  const data = load();
  const remark = data.nodes.remark;
  const client = data.nodes.clients.find(c => c.id === clientId);
  if (!remark) return { ok: false, message: 'no nodes generated yet' };
  if (!client) return { ok: false, message: 'no such client' };

  return {
    ok: true,
    client,
    links: linksForClient({
      uuid: client.uuid,
      nodes: remark.nodes,
      path: remark.path,
      network: remark.network,
      settings: data.nodes.settings
    })
  };
}

export function subscriptionFor(subId, clientApp = 'v2ray') {
  const data = load();
  const client = data.nodes.clients.find(c => c.subId === subId);

  // A core client uses the same address space, with one server behind it.
  if (!client) {
    const core = findBySubId(subId);
    if (core) return coreSubscription(core, clientApp, data);
  }

  /* Two very different situations used to look identical from outside, which
     sent us chasing the wrong bug for hours. Say which one it is. */
  if (!client) return { missing: 'client' };
  if (!data.nodes.remark) return { missing: 'remark' };

  const remarkRef = data.nodes.remark;
  const { links } = clientLinks(client.id);
  const kind = normaliseClient(clientApp);
  const { body, type: contentType, ext } = buildProfile({
    client: kind,
    uuid: client.uuid,
    nodes: remarkRef.nodes || [],
    path: remarkRef.path,
    settings: data.nodes.settings,
    title: `${remarkRef.name} · ${client.tag}`,
    links
  });
  /* With "start after first use" nothing is stored until the client
     connects, so the real date has to be derived — otherwise every client
     app is told the subscription never expires. */
  const realExpiry = effectiveExpiry(client);
  const expiryUnix = realExpiry ? Math.floor(new Date(realExpiry).getTime() / 1000) : 0;

  return {
    body,
    client: { ...client, effectiveExpiry: realExpiry },
    remark: data.nodes.remark,
    links,
    clientApp: kind,
    ext,
    headers: {
      'Content-Type': contentType,
      ...subscriptionHeaders({
        title: `${remarkRef.name} · ${client.tag}`,
        total: links.length,
        expiryUnix,
        usedBytes: client.usedBytes,
        limitBytes: client.limitBytes,
        ext
      })
    }
  };
}


/* Same output as the node path, assembled from a single inbound. */
function coreSubscription({ client, inbound }, clientApp, data) {
  if (!inbound) return { missing: 'remark' };

  const node = subNode(client, inbound, data);
  const settings = {
    fingerprint: client.fingerprint || 'chrome',
    alpn: client.alpn || 'http/1.1'
  };
  const links = [links_.vlessLink({
    uuid: client.uuid,
    address: node.address,
    port: node.port,
    tls: node.tls,
    sni: node.sni,
    host: node.host,
    path: inbound.path,
    network: inbound.network || 'ws',
    fingerprint: settings.fingerprint,
    alpn: settings.alpn,
    remark: client.tag
  })];

  const kind = normaliseClient(clientApp);
  const title = `${inbound.remark} · ${client.tag}`;
  const { body, type: contentType, ext } = buildProfile({
    client: kind,
    uuid: client.uuid,
    nodes: [node],
    path: inbound.path,
    settings,
    title,
    links
  });

  const realExpiry = effectiveExpiry(client);
  const expiryUnix = realExpiry ? Math.floor(new Date(realExpiry).getTime() / 1000) : 0;

  return {
    body,
    client: { ...client, effectiveExpiry: realExpiry },
    remark: { name: inbound.remark },
    links,
    clientApp: kind,
    ext,
    headers: {
      'Content-Type': contentType,
      ...subscriptionHeaders({
        title,
        total: links.length,
        expiryUnix,
        usedBytes: client.usedBytes,
        limitBytes: client.limitBytes,
        ext
      })
    }
  };
}


/* ------------------------------------------------------------------
   Raw editing

   The same escape hatch the core inbounds have. The generator covers the
   ordinary case; this is for the address or hostname it had no way to know
   about, without forcing a regeneration that would rewrite the path and
   invalidate nothing but still churn.
   ------------------------------------------------------------------ */

export function remarkJson() {
  const data = load();
  const remark = data.nodes.remark;
  if (!remark) return null;
  return {
    name: remark.name,
    path: remark.path,
    network: remark.network || 'ws',
    port: NODE_PORT,
    nodes: (remark.nodes || []).map(n => ({
      remark: n.remark,
      address: n.address,
      port: n.port,
      tls: n.tls !== false,
      sni: n.sni,
      host: n.host
    }))
  };
}

/* Port and listen address are the panel's to decide — a node pointing at a
   port nginx does not route to would fail in a way that looks like a network
   problem rather than a typo. */
const LOCKED_REMARK = ['port', 'listen', 'id'];

export async function applyRemarkJson(raw) {
  const data = load();
  if (!data.nodes.remark) return { ok: false, message: 'no node set exists yet' };

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, message: 'that is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'expected a JSON object' };
  }

  let nodes = null;
  if (parsed.nodes !== undefined) {
    if (!Array.isArray(parsed.nodes)) return { ok: false, message: 'nodes must be a list' };
    if (!parsed.nodes.length) return { ok: false, message: 'the node list cannot be empty' };

    nodes = [];
    for (const [i, entry] of parsed.nodes.entries()) {
      if (!entry || typeof entry !== 'object') {
        return { ok: false, message: `node ${i + 1} is not an object` };
      }
      const address = String(entry.address || '').trim();
      if (!address) return { ok: false, message: `node ${i + 1} has no address` };
      const port = Number(entry.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, message: `node ${i + 1} has an invalid port` };
      }
      nodes.push({
        remark: String(entry.remark || `node-${i + 1}`).slice(0, 64),
        address,
        port,
        tls: entry.tls !== false,
        sni: String(entry.sni || '').trim() || address,
        host: String(entry.host || '').trim() || address
      });
    }
  }

  const ignored = LOCKED_REMARK.filter(key => parsed[key] !== undefined);

  update(d => {
    const r = d.nodes.remark;
    if (typeof parsed.name === 'string' && parsed.name.trim()) r.name = parsed.name.trim().slice(0, 48);
    if (typeof parsed.path === 'string' && parsed.path.trim()) r.path = parsed.path.trim();
    if (parsed.network === 'ws' || parsed.network === 'httpupgrade') r.network = parsed.network;
    if (nodes) {
      r.nodes = nodes;
      r.summary = {
        total: nodes.length,
        addresses: new Set(nodes.map(n => n.address)).size,
        ports: new Set(nodes.map(n => n.port)).size
      };
    }
    r.editedAt = new Date().toISOString();
  });

  await applyRuntime();
  return { ok: true, ignored, summary: load().nodes.remark.summary };
}
