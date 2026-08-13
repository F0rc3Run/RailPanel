import { load, update, SCHEMA_VERSION } from './store.js';

/* What a backup is, and deliberately is not.

   In: inbounds, clients, the node set and its settings, domains — everything
   needed to stand the panel back up somewhere else.

   Out: the admin credentials and the Railway token. Credentials because a
   backup often travels through a chat app, and a stolen file should not also
   be a stolen login. The token because it is sealed with a key derived from
   the password it was set under, so it could not be opened on a fresh
   install anyway. */

export function build() {
  const data = load();
  return {
    kind: 'railpanel-backup',
    version: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    core: data.core,
    nodes: data.nodes,
    domains: data.domains
  };
}

export function filename() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `railpanel-${stamp}.json`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* Rejects anything that is not clearly one of our backups. Restoring is
   destructive, so a wrong file must fail loudly rather than half-apply. */
export function inspect(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, message: 'that file is not valid JSON' };
  }
  if (!isPlainObject(parsed)) return { ok: false, message: 'expected a JSON object' };
  if (parsed.kind !== 'railpanel-backup') {
    return { ok: false, message: 'that is not a RailPanel backup' };
  }
  if (!isPlainObject(parsed.core) || !isPlainObject(parsed.nodes)) {
    return { ok: false, message: 'the backup is missing its inbound or node data' };
  }

  const inbounds = Array.isArray(parsed.core.inbounds) ? parsed.core.inbounds.length : 0;
  const coreClients = Array.isArray(parsed.core.clients) ? parsed.core.clients.length : 0;
  const nodeClients = Array.isArray(parsed.nodes.clients) ? parsed.nodes.clients.length : 0;

  return {
    ok: true,
    parsed,
    summary: {
      createdAt: parsed.createdAt || null,
      inbounds,
      coreClients,
      nodeClients,
      hasRemark: Boolean(parsed.nodes.remark),
      domain: parsed.domains?.node || null
    }
  };
}

export function restore(raw) {
  const checked = inspect(raw);
  if (!checked.ok) return checked;
  const backup = checked.parsed;

  update(data => {
    data.core = {
      inbounds: Array.isArray(backup.core.inbounds) ? backup.core.inbounds : [],
      clients: Array.isArray(backup.core.clients) ? backup.core.clients : []
    };
    /* Generated nodes carry the domain they were built for. Restoring them
       onto a deployment that domain no longer points at would leave a set
       that looks healthy and routes nowhere — so unless the domain is the
       same, the remark is dropped and has to be generated again.

       The node clients stay either way: they keep their uuid and their
       subscription address, and attach to whatever is generated next. That
       is the same rule as deleting a remark by hand. */
    const sameDomain = backup.domains?.node
      && backup.domains.node === data.domains?.node
      && data.domains?.verifiedAt;

    data.nodes = {
      remark: sameDomain ? (backup.nodes.remark || null) : null,
      clients: Array.isArray(backup.nodes.clients) ? backup.nodes.clients : [],
      settings: { ...data.nodes.settings, ...(backup.nodes.settings || {}) }
    };

    if (isPlainObject(backup.domains)) {
      // Verification never travels: the new deployment has to prove the name
      // reaches it before any node built on it is trusted.
      data.domains = sameDomain
        ? { ...backup.domains }
        : { ...backup.domains, verifiedAt: null };
    }
    data.meta.restoredAt = new Date().toISOString();
  });

  const after = load();
  return {
    ok: true,
    summary: checked.summary,
    // Said plainly, because a silently missing node set is worse than a
    // restore that admits what it could not carry over.
    nodesKept: Boolean(after.nodes.remark),
    regenerateNeeded: !after.nodes.remark && (checked.summary.hasRemark || checked.summary.nodeClients > 0)
  };
}
