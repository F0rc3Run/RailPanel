import { Resolver } from 'node:dns/promises';

/* Ports Cloudflare proxies. A node is only valid if its port and its TLS
   setting agree, so the two lists are kept apart rather than merged. */
export const CF_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
export const CF_HTTP_PORTS = [80, 8080, 2052, 2082, 2086, 2095, 8880];

export function portIsTls(port) {
  return CF_HTTPS_PORTS.includes(Number(port));
}

function isIPv4(value) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value)
    && value.split('.').every(n => Number(n) >= 0 && Number(n) <= 255);
}

function isIPv6(value) {
  return value.includes(':') && /^[0-9a-fA-F:]+$/.test(value);
}

export function parseAddressList(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map(v => v.trim())
    .filter(Boolean)
    .filter(v => isIPv4(v) || isIPv6(v) || v.includes('.'));
}

/* With no hand-picked addresses, the domain's own records already point at
   several distinct Cloudflare edges — enough for the list to mean something. */
export async function resolveDomain(domain, { includeIPv6 = false } = {}) {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  const out = { v4: [], v6: [], error: null };
  try {
    out.v4 = await resolver.resolve4(domain);
  } catch (err) {
    out.error = err.code || err.message;
  }
  if (includeIPv6) {
    try { out.v6 = await resolver.resolve6(domain); } catch { /* often absent */ }
  }
  return out;
}

export async function collectAddresses(domain, settings) {
  const manual = parseAddressList(settings.cleanIPs);
  const addresses = [domain, ...manual];

  if (manual.length === 0) {
    const resolved = await resolveDomain(domain, { includeIPv6: settings.includeIPv6 });
    if (resolved.error && resolved.v4.length === 0) {
      // Silently falling back to a single-address list would look like
      // diversity while providing none. Say what went wrong instead.
      return { addresses: [domain], resolved, warning: 'dns-failed' };
    }
    addresses.push(...resolved.v4);
    if (settings.includeIPv6) addresses.push(...resolved.v6.map(ip => `[${ip}]`));
    return { addresses: dedupe(addresses), resolved, warning: null };
  }

  return { addresses: dedupe(addresses), resolved: null, warning: null };
}

function dedupe(list) {
  return [...new Set(list.map(v => v.trim()).filter(Boolean))];
}

/* nodes = addresses x ports. Order matters for readability: all ports of
   one address stay together so the client list is easy to scan. */
export function generate({ domain, settings, addresses }) {
  const httpsPorts = (settings.httpsPorts || []).filter(p => CF_HTTPS_PORTS.includes(Number(p)));
  const httpPorts = (settings.httpPorts || []).filter(p => CF_HTTP_PORTS.includes(Number(p)));
  const ports = [
    ...httpsPorts.map(port => ({ port: Number(port), tls: true })),
    ...httpPorts.map(port => ({ port: Number(port), tls: false }))
  ];

  if (!ports.length) return { nodes: [], truncated: false, reason: 'no-ports' };
  if (!addresses.length) return { nodes: [], truncated: false, reason: 'no-addresses' };

  const cap = Number(settings.maxNodes || 150);
  const prefix = (settings.prefix || 'RP').trim() || 'RP';
  const nodes = [];

  for (const address of addresses) {
    for (const { port, tls } of ports) {
      if (nodes.length >= cap) {
        return { nodes, truncated: true, reason: null };
      }
      nodes.push({
        address,
        port,
        tls,
        sni: domain,
        host: domain,
        remark: `${prefix}-${String(nodes.length + 1).padStart(2, '0')}`
      });
    }
  }

  return { nodes, truncated: false, reason: null };
}

export function summarise(nodes) {
  return {
    total: nodes.length,
    addresses: new Set(nodes.map(n => n.address)).size,
    ports: new Set(nodes.map(n => n.port)).size
  };
}
