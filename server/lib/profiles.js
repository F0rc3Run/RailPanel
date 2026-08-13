/* A subscription is not one thing. v2ray-family clients want a base64 list of
   vless:// URIs, Clash wants a YAML profile, sing-box wants a JSON one. These
   build the actual document each expects rather than handing everyone the same
   list and hoping. */

export const CLIENTS = {
  v2ray:  { label: 'v2rayNG / v2rayN / Streisand', ext: 'txt',  type: 'text/plain; charset=utf-8' },
  clash:  { label: 'Clash Meta / Mihomo',          ext: 'yaml', type: 'text/yaml; charset=utf-8' },
  singbox:{ label: 'sing-box / Hiddify',           ext: 'json', type: 'application/json; charset=utf-8' }
};

/* Which format a client wants can be read from what it calls itself. This is
   how the field-proven panels do it: one plain URL that works everywhere,
   with no query string or suffix for the user to get wrong. */
export function clientFromUserAgent(ua = '') {
  const s = String(ua).toLowerCase();
  if (!s) return null;

  /* Order matters more than the patterns do. Several apps advertise the
     engines they are compatible with — Hiddify calls itself something like
     "HiddifyNext/2.0 (android; like ClashMeta; like sing-box)" — so a match
     on a generic engine name would claim them before their own name is even
     reached. Specific applications are therefore tested first. */
  if (/hiddify|exclave|sfa\/|sfi\/|sfm\/|husi/.test(s)) return 'singbox';
  if (/v2rayng|v2rayn\/|nekobox|nekoray|streisand|shadowrocket|v2box|foxray|sagernet|karing/.test(s)) return 'v2ray';

  // Then the engines themselves, for anything that only names one.
  if (/sing-?box/.test(s)) return 'singbox';
  if (/clash|mihomo|meta|stash/.test(s)) return 'clash';
  if (/v2ray|xray/.test(s)) return 'v2ray';
  return null;
}

export function normaliseClient(value) {
  const key = String(value || '').toLowerCase();
  if (key === 'clash' || key === 'mihomo') return 'clash';
  if (key === 'singbox' || key === 'sing-box' || key === 'hiddify') return 'singbox';
  return 'v2ray';
}

/* ---- YAML, written by hand so there is no serialiser to pull in ---- */
function yamlString(value) {
  const s = String(value ?? '');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function clashProfile({ uuid, nodes, path, settings, title }) {
  const fp = settings.fingerprint || 'chrome';
  const alpn = (settings.alpn || 'http/1.1').split(',').map(a => a.trim()).filter(Boolean);

  const proxies = nodes.map(node => {
    const lines = [
      `  - name: ${yamlString(node.remark)}`,
      `    type: vless`,
      `    server: ${yamlString(node.address)}`,
      `    port: ${node.port}`,
      `    uuid: ${yamlString(uuid)}`,
      `    udp: true`,
      `    tls: ${node.tls ? 'true' : 'false'}`
    ];
    if (node.tls) {
      lines.push(`    servername: ${yamlString(node.sni)}`);
      lines.push(`    client-fingerprint: ${yamlString(fp)}`);
      if (alpn.length) lines.push(`    alpn: [${alpn.map(yamlString).join(', ')}]`);
    }
    lines.push(`    network: ws`);
    lines.push(`    ws-opts:`);
    lines.push(`      path: ${yamlString(path)}`);
    lines.push(`      headers:`);
    lines.push(`        Host: ${yamlString(node.host)}`);
    return lines.join('\n');
  });

  const names = nodes.map(n => yamlString(n.remark));
  return `# ${title}
# ${nodes.length} servers

mixed-port: 7890
allow-lan: false
mode: rule
log-level: warning

proxies:
${proxies.join('\n')}

proxy-groups:
  - name: "RailPanel"
    type: select
    proxies:
      - "Auto"
${names.map(n => `      - ${n}`).join('\n')}
  - name: "Auto"
    type: url-test
    url: "http://www.gstatic.com/generate_204"
    interval: 300
    tolerance: 50
    proxies:
${names.map(n => `      - ${n}`).join('\n')}

rules:
  - GEOIP,PRIVATE,DIRECT,no-resolve
  - MATCH,RailPanel
`;
}

function singboxProfile({ uuid, nodes, path, settings, title }) {
  const fp = settings.fingerprint || 'chrome';
  const alpn = (settings.alpn || 'http/1.1').split(',').map(a => a.trim()).filter(Boolean);

  const outbounds = nodes.map(node => {
    const out = {
      type: 'vless',
      tag: node.remark,
      server: node.address,
      server_port: node.port,
      uuid,
      packet_encoding: 'xudp',
      transport: {
        type: 'ws',
        path: String(path).split('?')[0],
        headers: { Host: node.host },
        early_data_header_name: 'Sec-WebSocket-Protocol'
      }
    };
    if (node.tls) {
      out.tls = {
        enabled: true,
        server_name: node.sni,
        utls: { enabled: true, fingerprint: fp },
        ...(alpn.length ? { alpn } : {})
      };
    }
    return out;
  });

  const tags = nodes.map(n => n.remark);
  const config = {
    log: { level: 'warn' },
    dns: {
      servers: [
        { tag: 'remote', address: 'https://1.1.1.1/dns-query', detour: 'RailPanel' },
        { tag: 'local', address: 'local', detour: 'direct' }
      ],
      final: 'remote',
      strategy: 'prefer_ipv4'
    },
    inbounds: [
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }
    ],
    outbounds: [
      { type: 'selector', tag: 'RailPanel', outbounds: ['Auto', ...tags], default: 'Auto' },
      { type: 'urltest', tag: 'Auto', outbounds: tags, url: 'http://www.gstatic.com/generate_204', interval: '5m' },
      ...outbounds,
      { type: 'direct', tag: 'direct' }
    ],
    route: {
      rules: [
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' }
      ],
      final: 'RailPanel',
      auto_detect_interface: true
    }
  };
  /* Strictly valid JSON, with no leading comment. sing-box and Hiddify
     tolerate one; a client using a standard parser fails on the first line. */
  return JSON.stringify(config, null, 2);
}

export function buildProfile({ client, uuid, nodes, path, settings, title, links }) {
  const kind = normaliseClient(client);
  if (kind === 'clash') {
    return { body: clashProfile({ uuid, nodes, path, settings, title }), ...CLIENTS.clash };
  }
  if (kind === 'singbox') {
    return { body: singboxProfile({ uuid, nodes, path, settings, title }), ...CLIENTS.singbox };
  }
  return {
    body: Buffer.from(links.join('\n'), 'utf8').toString('base64'),
    ...CLIENTS.v2ray
  };
}
