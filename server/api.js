import { send, clientIp, isSecure } from './lib/http.js';
import { load, update } from './lib/store.js';
import {
  signIn, signOut, setCredentials, hash, cookieHeader, clearCookieHeader,
  throttled, kekFor
} from './lib/auth.js';
import { snapshot } from './lib/sysstat.js';
import * as xray from './lib/xray.js';
import * as nginx from './lib/nginx.js';
import * as nodeset from './lib/nodeset.js';
import * as core from './lib/core.js';
import * as backup from './lib/backup.js';
import * as railway from './lib/railway.js';
import { sealSecret, openSecret } from './lib/store.js';
import * as selftest from './lib/selftest.js';
import * as sysinfo from './lib/sysinfo.js';
import * as telegram from './lib/telegram.js';
import * as notify from './lib/notify.js';
import { effectiveExpiry } from './lib/enforce.js';
import { answerChallenge } from './lib/verify.js';
import { CF_HTTPS_PORTS, CF_HTTP_PORTS } from './lib/nodes.js';

function publicClient(client) {
  const { uuid, ...rest } = client;      // the UUID only leaves through links
  // With "start after first use" the real expiry is derived, not stored.
  return { ...rest, effectiveExpiry: effectiveExpiry(client) };
}

const routes = {

  /* ---------------- session ---------------- */

  'POST /api/session': async (req, res, { body }) => {
    const ip = clientIp(req);
    if (throttled(ip)) {
      return send(res, 429, { error: 'too many attempts, wait a few minutes' });
    }
    const { username = '', password = '', railwayToken = '' } = body || {};
    const before = load();
    const needsSetup = !before.setup?.complete;

    /* On the very first sign-in the Railway token is part of the credentials:
       it is checked against Railway before anyone gets in, so a mistyped token
       is caught here rather than turning into a dashboard card that silently
       shows nothing. */
    if (needsSetup) {
      const trimmed = String(railwayToken).trim();

      /* Required, and checked with Railway before anyone is let in. Setup is
         only marked done once a working token is stored, so removing it later
         puts the panel back on this screen rather than leaving a dashboard
         card that can never fill in. */
      if (!trimmed) {
        return send(res, 400, { error: 'a Railway token is required to set the panel up', needsSetup: true });
      }
      const checked = await railway.verifyToken(trimmed);
      if (!checked.ok) {
        return send(res, 400, { error: checked.message, needsSetup: true });
      }

      const session = signIn(String(username), String(password), ip);
      if (!session) return send(res, 401, { error: 'wrong username or password', needsSetup: true });

      update(d => {
        d.railway.token = sealSecret(trimmed, kekFor(session));
        d.railway.checkedAt = new Date().toISOString();
        d.railway.account = checked.account || null;
        d.setup = { complete: true, at: new Date().toISOString() };
      });

      const stored = load().telegram?.botToken;
      if (stored) telegram.useToken(openSecret(stored, kekFor(session)));

      const data = load();
      return send(res, 200, {
        ok: true,
        setupCompleted: true,
        railwayLinked: Boolean(trimmed),
        mustChangeCredentials: data.admin.user === 'railpanel'
          && data.admin.hash === hash('railpanel', data.admin.salt)
      }, { 'Set-Cookie': cookieHeader(session, isSecure(req)) });
    }

    const token = signIn(String(username), String(password), ip);
    if (!token) return send(res, 401, { error: 'wrong username or password' });

    /* Unsealed once, here, because the notifier runs on a timer with no
       session of its own to borrow a key from. */
    const stored = load().telegram?.botToken;
    if (stored) telegram.useToken(openSecret(stored, kekFor(token)));

    notify.loginSucceeded(String(username), ip).catch(() => {});

    const data = load();
    send(res, 200, {
      ok: true,
      mustChangeCredentials: data.admin.user === 'railpanel'
        && data.admin.hash === hash('railpanel', data.admin.salt)
    }, { 'Set-Cookie': cookieHeader(token, isSecure(req)) });
  },

  'DELETE /api/session': (req, res) => {
    signOut(req);
    send(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
  },

  'GET /api/me': (req, res, { session }) => {
    const data = load();
    send(res, 200, {
      user: session.user,
      domains: data.domains,
      railwayLinked: Boolean(data.railway.token),
      coreSlots: { used: data.core.inbounds.length, total: 2 },
      remark: data.nodes.remark ? {
        name: data.nodes.remark.name,
        summary: data.nodes.remark.summary,
        truncated: data.nodes.remark.truncated,
        createdAt: data.nodes.remark.createdAt
      } : null,
      nodeClients: data.nodes.clients.length
    });
  },

  'POST /api/account': (req, res, { body, session }) => {
    const { currentPassword = '', username, password } = body || {};
    const data = load();

    if (hash(String(currentPassword), data.admin.salt) !== data.admin.hash) {
      return send(res, 403, { error: 'current password is wrong' });
    }
    if (password && String(password).length < 8) {
      return send(res, 400, { error: 'password must be at least 8 characters' });
    }

    const nextUser = username ? String(username).trim() : data.admin.user;
    const nextPass = password ? String(password) : String(currentPassword);
    if (!nextUser) return send(res, 400, { error: 'username cannot be empty' });

    /* Stored secrets are sealed with a key derived from the password, so a
       new password would leave them unopenable. Both keys exist right here —
       the old session can still open them, the new one can seal them again —
       so they are carried across instead of thrown away. Discarding them
       used to send the operator back to the first-run screen. */
    const oldKek = session?.kek;
    const secrets = {
      railway: data.railway.token ? openSecret(data.railway.token, oldKek) : null,
      telegram: data.telegram?.botToken ? openSecret(data.telegram.botToken, oldKek) : null
    };

    setCredentials(nextUser, nextPass);

    /* Signing back in after every password change is friction with no
       benefit: the person doing it is the one already holding the session.
       A fresh session is issued under the new key so sealed secrets keep
       opening, and the old one is discarded. */
    signOut(req);
    const fresh = signIn(nextUser, nextPass, clientIp(req));

    let carried = false;
    if (fresh) {
      const newKek = kekFor(fresh);
      update(d => {
        if (secrets.railway) { d.railway.token = sealSecret(secrets.railway, newKek); carried = true; }
        if (secrets.telegram) { d.telegram.botToken = sealSecret(secrets.telegram, newKek); }
      });
      if (secrets.telegram) telegram.useToken(secrets.telegram);
    }

    send(res, 200, {
      ok: true,
      railwayTokenCleared: Boolean(data.railway.token) && !carried,
      stillSignedIn: Boolean(fresh)
    }, fresh
      ? { 'Set-Cookie': cookieHeader(fresh, isSecure(req)) }
      : { 'Set-Cookie': clearCookieHeader() });
  },

  /* ---------------- system ---------------- */

  'GET /api/stats': async (req, res) => {
    const data = load();
    send(res, 200, {
      ...snapshot(),
      xray: xray.status(),
      xrayVersion: await xray.version(),
      nodes: data.nodes.remark?.summary || { total: 0, addresses: 0, ports: 0 },
      nodeClients: data.nodes.clients.length,
      coreClients: data.core.clients.length
    });
  },

  /* ---------------- domain ---------------- */

  'POST /api/domain': async (req, res, { body }) => {
    const kind = body?.kind === 'panel' ? 'panel' : 'node';
    const result = await nodeset.setDomain(kind, body?.domain);
    if (!result.ok) return send(res, 400, { error: result.message, code: result.code });
    send(res, 200, result);
  },

  /* ---------------- node set ---------------- */

  'GET /api/nodes': (req, res) => {
    const data = load();
    send(res, 200, {
      remark: data.nodes.remark,
      settings: data.nodes.settings,
      clients: data.nodes.clients.map(publicClient),
      availablePorts: { https: CF_HTTPS_PORTS, http: CF_HTTP_PORTS }
    });
  },

  'POST /api/nodes/settings': (req, res, { body }) => {
    send(res, 200, { ok: true, settings: nodeset.updateSettings(body || {}) });
  },

  'POST /api/nodes/generate': async (req, res) => {
    /* Generation touches DNS, nginx and Xray in turn. A generic 500 here
       hides which of them objected, so the real message is passed through. */
    const result = await nodeset.generateNodes();
    if (!result.ok) return send(res, 400, { error: result.message, code: result.code });
    send(res, 200, result);
  },

  'POST /api/nodes/remark': (req, res, { body }) => {
    const result = nodeset.renameRemark(body?.name);
    if (!result.ok) return send(res, 400, { error: result.message });
    send(res, 200, result);
  },

  'DELETE /api/nodes/remark': async (req, res) => {
    const result = await nodeset.deleteRemark();
    if (!result.ok) return send(res, 400, { error: result.message });
    send(res, 200, result);
  },

  /* ---------------- node clients ---------------- */

  'PATCH /api/nodes/clients': async (req, res, { url, body }) => {
    const id = url.searchParams.get('id');
    const client = await nodeset.updateClient(id, body || {});
    if (!client) return send(res, 404, { error: 'no such client' });
    send(res, 200, publicClient(client));
  },

  'POST /api/nodes/clients': async (req, res, { body }) => {
    const client = await nodeset.addClient(body || {});
    send(res, 201, publicClient(client));
  },

  'DELETE /api/nodes/clients': async (req, res, { url }) => {
    const result = await nodeset.removeClient(url.searchParams.get('id'));
    if (!result.ok) return send(res, 404, { error: result.message });
    send(res, 200, result);
  },

  'POST /api/nodes/clients/reset': async (req, res, { body }) => {
    const result = await nodeset.resetClientTraffic(body?.id);
    if (!result.ok) return send(res, 404, { error: result.message });
    send(res, 200, result);
  },

  /* Facts about the running system, so a broken node can be diagnosed from
     the panel instead of by guessing at logs. */
  /* ---- core inbounds ---- */
  'GET /api/core': (req, res) => {
    const data = load();
    send(res, 200, {
      inbounds: (data.core.inbounds || []).map(i => core.publicInbound(i, data)),
      clients: (data.core.clients || []).map(core.publicClient),
      slots: { used: (data.core.inbounds || []).length, total: core.MAX_INBOUNDS }
    });
  },

  'POST /api/core/inbounds': async (req, res, { body }) => {
    const result = core.addInbound(body || {});
    if (!result.ok) return send(res, 400, { error: result.message });
    await nodeset.applyRuntime();
    send(res, 201, result.inbound);
  },

  'PATCH /api/core/inbounds': async (req, res, { url, body }) => {
    const result = core.updateInbound(url.searchParams.get('id'), body || {});
    if (!result.ok) return send(res, 404, { error: result.message });
    await nodeset.applyRuntime();
    send(res, 200, result.inbound);
  },

  'DELETE /api/core/inbounds': async (req, res, { url }) => {
    const result = core.removeInbound(url.searchParams.get('id'));
    if (!result.ok) return send(res, 404, { error: result.message });
    await nodeset.applyRuntime();
    send(res, 200, result);
  },

  'GET /api/core/inbounds/json': (req, res, { url }) => {
    const json = core.inboundJson(url.searchParams.get('id'));
    if (!json) return send(res, 404, { error: 'no such inbound' });
    send(res, 200, json);
  },

  'POST /api/core/inbounds/json': async (req, res, { url, body }) => {
    const result = core.applyInboundJson(url.searchParams.get('id'), body?.json);
    if (!result.ok) return send(res, 400, { error: result.message });
    await nodeset.applyRuntime();
    send(res, 200, result);
  },

  /* ---- core clients ---- */
  'POST /api/core/clients': async (req, res, { body }) => {
    const result = core.addClient(body || {});
    if (!result.ok) return send(res, 400, { error: result.message });
    await nodeset.applyRuntime();
    send(res, 201, core.publicClient(result.client));
  },

  'PATCH /api/core/clients': async (req, res, { url, body }) => {
    const result = core.updateClient(url.searchParams.get('id'), body || {});
    if (!result.ok) return send(res, 404, { error: result.message });
    await nodeset.applyRuntime();
    send(res, 200, core.publicClient(result.client));
  },

  'DELETE /api/core/clients': async (req, res, { url }) => {
    const result = core.removeClient(url.searchParams.get('id'));
    if (!result.ok) return send(res, 404, { error: result.message });
    await nodeset.applyRuntime();
    send(res, 200, result);
  },

  'POST /api/core/clients/reset': async (req, res, { body }) => {
    const result = await core.resetClientTraffic(body?.id);
    if (!result.ok) return send(res, 404, { error: result.message });
    if (result.needsApply) await nodeset.applyRuntime();
    send(res, 200, result);
  },

  'GET /api/core/clients/link': (req, res, { url }) => {
    const id = url.searchParams.get('id');
    const link = core.clientLink(id);
    if (!link) return send(res, 404, { error: 'no such client' });
    const subId = core.ensureSubId(id);
    send(res, 200, { link, subscription: subId ? `/sub/${subId}` : null });
  },

  'GET /api/backup': (req, res) => {
    const body = JSON.stringify(backup.build(), null, 2);
    send(res, 200, body, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${backup.filename()}"`,
      'Cache-Control': 'no-store'
    });
  },

  'POST /api/backup/inspect': (req, res, { body }) => {
    const result = backup.inspect(body?.data);
    if (!result.ok) return send(res, 400, { error: result.message });
    send(res, 200, { ok: true, summary: result.summary });
  },

  'POST /api/backup/restore': async (req, res, { body }) => {
    const result = backup.restore(body?.data);
    if (!result.ok) return send(res, 400, { error: result.message });
    await nodeset.applyRuntime();
    send(res, 200, result);
  },

  'GET /api/railway': async (req, res, { session }) => {
    const data = load();

    /* Traffic through the panel is something we count ourselves, so this part
       works on every plan. It is the number the operator actually wants —
       what the month is costing — even when Railway will not hand out a
       token to confirm it. */
    const clients = [...(data.core.clients || []), ...(data.nodes.clients || [])];
    const usedBytes = clients.reduce((sum, c) => sum + Number(c.usedBytes || 0), 0);
    const since = data.meta?.cycleStart || data.meta?.createdAt || null;
    const days = since ? Math.max(1, (Date.now() - new Date(since)) / 86400000) : 1;
    const traffic = {
      usedBytes,
      perDayBytes: Math.round(usedBytes / days),
      since,
      clients: clients.length
    };

    if (!data.railway.token) return send(res, 200, { linked: false, traffic });
    const token = openSecret(data.railway.token, session.kek);
    if (!token) {
      // Sealed under a password that has since changed.
      return send(res, 200, { linked: false, needsToken: true, traffic });
    }
    const result = await railway.usage(token);

    /* What the credit is worth in traffic — the number the dashboard cannot
       tell you, because only this panel knows the egress rate matters more
       than anything else here. Railway's published egress price sits between
       five and ten cents a gigabyte, so it is given as a range. */
    let affordable = null;
    if (result.credit && typeof result.credit.remaining === 'number') {
      affordable = {
        maxGB: result.credit.remaining / 0.05,
        minGB: result.credit.remaining / 0.10
      };
    }
    if (!result.credit) {
      console.warn('railway credit unavailable:', result.note || result.message || 'no reason given');
    }
    send(res, 200, { linked: result.ok !== false, traffic, affordable, ...result });
  },

  'POST /api/railway': async (req, res, { body, session }) => {
    const token = String(body?.token || '').trim();
    if (!token) {
      // Setup is defined by having a working token, so clearing it sends the
      // panel back to the first-run screen on the next sign-in.
      update(d => {
        d.railway.token = null;
        d.railway.checkedAt = null;
        d.railway.account = null;
        d.setup = { complete: false, at: null };
      });
      return send(res, 200, { linked: false, setupReopened: true });
    }
    const checked = await railway.verifyToken(token);
    if (!checked.ok) return send(res, 400, { error: checked.message });
    update(d => {
      d.railway.token = sealSecret(token, session.kek);
      d.railway.checkedAt = new Date().toISOString();
      d.railway.account = checked.account || null;
    });
    send(res, 200, { linked: true, account: checked.account });
  },

  /* Everything the uptime panel shows, in one call. */
  'GET /api/system': async (req, res) => {
    const [version, latest, ip] = await Promise.all([
      xray.version(),
      sysinfo.latestRelease(),
      sysinfo.publicAddress()
    ]);
    const current = String(version || '').replace(/^v/, '');
    send(res, 200, {
      xray: {
        running: typeof xray.running === 'function' ? xray.running() : Boolean(version),
        version: current || null,
        uptimeSec: sysinfo.xrayUptimeSec(xray.startedAtMs()),
        latest: latest.ok ? latest.version : null,
        updateAvailable: Boolean(latest.ok && current && sysinfo.isNewer(latest.version, current)),
        latestError: latest.ok ? null : latest.error
      },
      os: { uptimeSec: sysinfo.osUptimeSec() },
      ip: ip || null
    });
  },

  'POST /api/system/xray/update': async (req, res, { body }) => {
    const target = String(body?.version || '').trim();
    if (!target) return send(res, 400, { error: 'which version?' });
    const result = await sysinfo.installVersion(target);
    if (!result.ok) return send(res, 400, { error: result.message });
    if (typeof xray.clearVersionCache === 'function') xray.clearVersionCache();
    await nodeset.applyRuntime();
    send(res, 200, { ok: true, version: result.version });
  },

  'GET /api/telegram': (req, res) => {
    send(res, 200, { ...telegram.publicConfig(), presets: telegram.PRESETS, events: telegram.publicConfig().events });
  },

  'POST /api/telegram': async (req, res, { body, session }) => {
    const token = String(body?.botToken || '').trim();
    const chatId = String(body?.chatId || '').trim();

    if (body?.schedule === 'custom' && !notify.cronValid(body?.cron)) {
      return send(res, 400, { error: 'that crontab expression is not valid' });
    }

    /* A token is only stored once Telegram has accepted it and delivered a
       message to the chat. Saving one that was never proven would mean
       discovering it later, from alerts that never arrived. */
    let sealed;
    if (token) {
      const checked = await telegram.verify(token, chatId);
      if (!checked.ok) return send(res, 400, { error: checked.message });
      sealed = sealSecret(token, session.kek);
      telegram.useToken(token);
    }

    const saved = telegram.save(body || {}, sealed);
    send(res, 200, { ok: true, config: { ...saved, botToken: undefined, hasToken: Boolean(saved.botToken) } });
  },

  'POST /api/telegram/test': async (req, res) => {
    const result = await notify.sendReport();
    send(res, 200, { ok: true, ...(result || {}) });
  },

  /* Reports what Railway's own schema offers for billing, so the credit
     query can be written from fact rather than guessed at. */
  'GET /api/railway/schema': async (req, res, { session }) => {
    const data = load();
    if (!data.railway.token) return send(res, 400, { error: 'no Railway token stored' });
    const token = openSecret(data.railway.token, session.kek);
    if (!token) return send(res, 400, { error: 'the stored token could not be unsealed' });
    const result = await railway.explore(token);
    if (!result.ok) return send(res, 400, { error: result.message });
    send(res, 200, result);
  },

  'GET /api/diag': (req, res) => {
    const data = load();
    const remark = data.nodes.remark;
    const wanted = remark ? String(remark.path).split('?')[0] : null;
    const live = nginx.liveRoutes();
    send(res, 200, {
      publicPort: process.env.NGINX_PORT || process.env.PORT || null,
      panelPort: process.env.PANEL_PORT || 8090,
      domain: data.domains.node,
      proxied: data.domains.proxied === true,
      nodePath: wanted,
      nginx: {
        confPath: nginx.confPath(),
        lastApply: nginx.lastApply(),
        liveLocations: live,
        pathIsRouted: Boolean(wanted && live && live.includes(wanted))
      },
      xray: xray.status()
    });
  },

  'GET /api/nodes/remark/json': (req, res) => {
    const json = nodeset.remarkJson();
    if (!json) return send(res, 404, { error: 'no node set exists yet' });
    send(res, 200, json);
  },

  'POST /api/nodes/remark/json': async (req, res, { body }) => {
    const result = await nodeset.applyRemarkJson(body?.json);
    if (!result.ok) return send(res, 400, { error: result.message });
    send(res, 200, result);
  },

  'GET /api/nodes/selftest': async (req, res) => {
    const data = load();
    const remark = data.nodes.remark;
    const settings = data.nodes.settings;
    const ports = [...(settings.httpsPorts || []), ...(settings.httpPorts || [])];
    const out = await selftest.runAll({
      domain: data.domains.node,
      path: remark && remark.path,
      ports
    });
    if (!out.ok) return send(res, 400, { error: out.error });
    send(res, 200, out);
  },

  'GET /api/nodes/clients/links': (req, res, { url }) => {
    const result = nodeset.clientLinks(url.searchParams.get('id'));
    if (!result.ok) return send(res, 400, { error: result.message });
    const data = load();
    const host = data.domains.panel || data.domains.node || '';
    send(res, 200, {
      links: result.links,
      subscription: host ? `https://${host}/sub/${result.client.subId}` : null
    });
  }
};

const PUBLIC = new Set(['POST /api/session', 'DELETE /api/session']);

export async function handle(req, res, ctx) {
  // Verification callback: answered before any session check, because the
  // whole point is that an outside request reaches it.
  if (req.method === 'GET' && ctx.path === '/__railpanel/verify') {
    const token = ctx.url.searchParams.get('token') || '';
    if (!answerChallenge(token)) return send(res, 403, { error: 'unknown token' });
    return send(res, 200, { token });
  }

  const key = `${req.method} ${ctx.path}`;
  const route = routes[key];
  if (!route) return send(res, 404, { error: 'no such endpoint' });
  if (!PUBLIC.has(key) && !ctx.session) {
    return send(res, 401, { error: 'sign in first' });
  }
  return route(req, res, ctx);
}
