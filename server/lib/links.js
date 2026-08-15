/* Every value a client needs goes into the link, so nothing has to be
   filled in by hand after import. */
export function vlessLink({
  uuid, address, port, tls, sni, host, path,
  network = 'ws', fingerprint = 'chrome', alpn = 'http/1.1', remark = ''
}) {
  const params = new URLSearchParams({
    encryption: 'none',
    type: network,
    host,
    path
  });

  if (tls) {
    params.set('security', 'tls');
    params.set('sni', sni);
    params.set('fp', fingerprint);
    if (alpn) params.set('alpn', alpn);
  } else {
    // A plain port with security=tls fails in a way that is hard to read,
    // so the two are always set together.
    params.set('security', 'none');
  }

  const authority = address.includes(':') && !address.startsWith('[')
    ? `[${address}]`
    : address;

  const tag = remark ? '#' + encodeURIComponent(remark) : '';
  // URLSearchParams writes a space as '+', which some clients read literally.
  const query = params.toString().replace(/\+/g, '%20');
  return `vless://${uuid}@${authority}:${port}?${query}${tag}`;
}

export function linksForClient({ uuid, nodes, path, network, settings }) {
  return nodes.map(node => vlessLink({
    uuid,
    address: node.address,
    port: node.port,
    tls: node.tls,
    sni: node.sni,
    host: node.host,
    path,
    network,
    fingerprint: settings.fingerprint || 'chrome',
    alpn: settings.alpn || 'http/1.1',
    remark: node.remark
  }));
}

/* v2rayNG and friends expect the subscription body to be base64 of the
   newline-joined links. */
export function subscriptionBody(links, format = 'v2ray') {
  const joined = links.join('\n');
  if (format === 'plain') return { body: joined, contentType: 'text/plain; charset=utf-8' };
  return {
    body: Buffer.from(joined, 'utf8').toString('base64'),
    contentType: 'text/plain; charset=utf-8'
  };
}

/* A header value with a control character makes writeHead throw, which
   leaves the request hanging and the client reporting EOF. Names come from
   user input, so they get scrubbed before they reach a header. */
function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
}

export function subscriptionHeaders({ title, total, expiryUnix, usedBytes, limitBytes, ext = 'txt', asAttachment = false }) {
  title = headerSafe(title) || 'subscription';
  const headers = {
    'Profile-Update-Interval': '12',
    'Profile-Title': Buffer.from(title, 'utf8').toString('base64')
  };
  // Proxy clients fetch this as data. Telling them it is an attachment adds
  // nothing and trips some of them up, so it is left to the browser path.
  if (asAttachment) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(title)}.${ext}`;
  }
  // Clients that understand this header show a data and expiry bar without
  // having to ask the panel anything else.
  if (limitBytes || expiryUnix) {
    headers['Subscription-Userinfo'] =
      `upload=0; download=${usedBytes || 0}; total=${limitBytes || 0}; expire=${expiryUnix || 0}`;
  }
  return { ...headers, 'X-Node-Count': String(total) };
}
