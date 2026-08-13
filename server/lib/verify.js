import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';

/* A domain counts as verified only when a request to it comes back to this
   process. Checking DNS alone would pass for any domain pointed anywhere
   on Cloudflare, including someone else's. */

const challenges = new Map();          // token -> expiry
const TTL_MS = 2 * 60 * 1000;

export function issueChallenge() {
  const token = randomBytes(24).toString('base64url');
  challenges.set(token, Date.now() + TTL_MS);
  return token;
}

export function answerChallenge(token) {
  const expiry = challenges.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { challenges.delete(token); return false; }
  return true;
}

function sweep() {
  const now = Date.now();
  for (const [token, expiry] of challenges) if (now > expiry) challenges.delete(token);
}

export function normalise(input) {
  let value = String(input || '').trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return value;
}

export function looksLikeDomain(value) {
  return /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(value) && !/\s/.test(value);
}

export async function verify(rawDomain) {
  sweep();
  const domain = normalise(rawDomain);

  if (!looksLikeDomain(domain)) {
    return { ok: false, code: 'invalid', message: 'that does not look like a domain name' };
  }

  // 1. It has to resolve at all.
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  let v4 = [];
  try {
    v4 = await resolver.resolve4(domain);
  } catch (err) {
    return {
      ok: false, code: 'dns',
      message: `no A record found for ${domain} (${err.code || err.message})`
    };
  }

  // 2. A request to it has to arrive here, at this process.
  const token = issueChallenge();
  let response;
  try {
    response = await fetch(`https://${domain}/__railpanel/verify?token=${token}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'RailPanel-verify' }
    });
  } catch (err) {
    return {
      ok: false, code: 'unreachable',
      message: `${domain} resolves but did not answer over HTTPS (${err.message})`,
      addresses: v4
    };
  }

  if (!response.ok) {
    return {
      ok: false, code: 'status',
      message: `${domain} answered with ${response.status}; it is not pointing at this panel yet`,
      addresses: v4
    };
  }

  let payload;
  try { payload = await response.json(); } catch { payload = null; }

  if (payload?.token !== token) {
    return {
      ok: false, code: 'mismatch',
      message: `${domain} reached a different service, not this panel`,
      addresses: v4
    };
  }

  // 3. Cloudflare in front is what makes the node list worth generating,
  //    so its absence is reported rather than treated as failure.
  const proxied = response.headers.has('cf-ray');

  challenges.delete(token);
  return {
    ok: true,
    domain,
    addresses: v4,
    proxied,
    warning: proxied ? null : 'not-proxied'
  };
}
