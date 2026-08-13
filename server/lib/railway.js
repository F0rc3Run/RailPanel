/* Talks to Railway's GraphQL API with a personal token.

   Used for two things: proving at setup time that the token the operator
   pasted actually works, and reading account usage for the dashboard card.
   Read-only — the panel never changes anything in a Railway account. */

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
export const BUILD = '20260811-2056';
const TIMEOUT_MS = 10000;

async function query(token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'unauthorised', message: 'Railway rejected that token' };
    }

    /* A GraphQL error usually arrives as 400 with the reason in the body.
       Reporting only the status throws away the one thing that would say
       what is wrong, so the body is read either way. */
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, code: 'http', message: `Railway answered ${res.status}` };
    }
    if (!res.ok && !payload?.errors) {
      return { ok: false, code: 'http', message: `Railway answered ${res.status}` };
    }
    if (payload.errors?.length) {
      const first = payload.errors[0]?.message || 'unknown error';
      const denied = /not authorized|unauthorized|forbidden/i.test(first);
      return {
        ok: false,
        code: denied ? 'unauthorised' : 'graphql',
        message: denied ? 'that token does not have access' : first
      };
    }
    return { ok: true, data: payload.data };
  } catch (err) {
    const aborted = err.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'timeout' : 'network',
      message: aborted ? 'Railway did not answer in time' : `could not reach Railway: ${err.message}`
    };
  } finally {
    clearTimeout(timer);
  }
}

/* A token is only accepted if Railway answers for it. Storing one that was
   never checked would mean discovering the mistake much later, from a card
   that quietly shows nothing. */
export async function verifyToken(token) {
  if (!token || String(token).trim().length < 20) {
    return { ok: false, code: 'format', message: 'that does not look like a Railway token' };
  }
  const result = await query(String(token).trim(), {
    query: '{ me { id name email } }'
  });
  if (!result.ok) return result;

  const me = result.data?.me;
  if (!me?.id) {
    return { ok: false, code: 'unauthorised', message: 'Railway did not recognise that token' };
  }
  return { ok: true, account: { name: me.name || null, email: me.email || null } };
}

/* Current-cycle spend.

   Railway bills per workspace and reports it through estimatedUsage, broken
   down by measurement. The schema here is not versioned, so every failure is
   returned with the message Railway gave rather than swallowed — if it moves,
   the panel says exactly what it said, instead of showing an empty card. */
const MEASUREMENT_UNITS = {
  cpu: 'vCPU-hours',
  memory: 'GB-hours',
  egress: 'GB',
  disk: 'GB-hours'
};

const MEASUREMENTS = {
  CPU_USAGE: 'cpu',
  MEMORY_USAGE_GB: 'memory',
  NETWORK_TX_GB: 'egress',
  DISK_USAGE_GB: 'disk'
};

/* Railway's schema is not versioned and estimatedUsage has changed shape
   more than once, so rather than hard-coding one guess the field is asked
   about first and the query is built from what it actually accepts. */
async function usageSignature(token) {
  const result = await query(token, {
    query: `{
      __schema {
        queryType {
          fields {
            name
            args { name type { name kind ofType { name kind } } }
          }
        }
      }
    }`
  });
  if (!result.ok) return null;
  const fields = result.data?.__schema?.queryType?.fields || [];
  const field = fields.find(f => f.name === 'estimatedUsage');
  if (!field) return null;
  return field.args.map(a => ({
    name: a.name,
    type: a.type?.name || a.type?.ofType?.name || a.type?.kind,
    required: a.type?.kind === 'NON_NULL'
  }));
}

export async function usage(token) {
  const who = await query(token, {
    query: `{
      me {
        id
        name
        email
        workspaces { id name plan }
      }
    }`
  });
  if (!who.ok) return who;

  const me = who.data?.me;
  if (!me?.id) {
    return { ok: false, code: 'unauthorised', message: 'Railway did not recognise that token' };
  }
  const account = { name: me.name || null, email: me.email || null };
  const workspaces = me.workspaces || [];
  if (!workspaces.length) {
    return { ok: true, account, credit: null, note: 'no workspace is visible to this token' };
  }
  /* An account can hold several workspaces, and reading the first one would
     quietly report a balance belonging to somewhere else. The one that owns
     this deployment is the one to ask about; RAILWAY_WORKSPACE_ID names it
     when Railway does not make it obvious. */
  const preferred = process.env.RAILWAY_WORKSPACE_ID || null;
  const workspace = (preferred && workspaces.find(w => w.id === preferred)) || workspaces[0];
  const ambiguous = workspaces.length > 1 && !preferred;

  /* SubscriptionPlanLimit is a single JSON value, not an object with
     selectable fields — asking for subfields is rejected outright. */
  const balance = await query(token, {
    query: `query Balance($workspaceId: String!) {
      workspace(workspaceId: $workspaceId) {
        subscriptionPlanLimit
        customer {
          remainingUsageCreditBalance
          creditBalance
          currentUsage
          trialDaysRemaining
          isTrialing
          hasExhaustedFreePlan
        }
      }
    }`,
    variables: { workspaceId: workspace.id }
  });

  const usageRows = await query(token, {
    query: `query Usage($workspaceId: String!, $measurements: [MetricMeasurement!]!) {
      estimatedUsage(workspaceId: $workspaceId, measurements: $measurements) {
        measurement
        estimatedValue
      }
    }`,
    variables: { workspaceId: workspace.id, measurements: Object.keys(MEASUREMENTS) }
  });

  const parts = {};
  if (usageRows.ok) {
    for (const row of usageRows.data?.estimatedUsage || []) {
      const key = MEASUREMENTS[row.measurement] || String(row.measurement || '').toLowerCase();
      parts[key] = (parts[key] || 0) + Number(row.estimatedValue || 0);
    }
  }

  if (!balance.ok) {
    return {
      ok: true, account, workspace: workspace.name, plan: workspace.plan,
      credit: null, usage: parts, note: balance.message
    };
  }

  /* Kept in the reply so a wrong figure can be traced to what Railway
     actually said, instead of being argued about from a screenshot. */
  const raw = balance.data?.workspace?.customer || null;

  const ws = balance.data?.workspace || {};
  const customer = ws.customer || {};
  const limit = ws.subscriptionPlanLimit || {};
  const included = typeof limit === 'object' ? (limit.includedUsageDollars ?? null) : null;

  /* Railway keeps three related figures, and they do reconcile:

       creditBalance                what the account holds
       currentUsage                 what this cycle has cost so far
       remainingUsageCreditBalance  the first minus the second

     The mistake worth avoiding is treating the plan's included amount as the
     starting point. It is not — the balance is, and it may already be below
     that. Everything shown is therefore anchored to creditBalance. */
  const balanceHeld = typeof customer.creditBalance === 'number' ? customer.creditBalance : null;
  const spent = typeof customer.currentUsage === 'number' ? customer.currentUsage : null;
  const remaining = typeof customer.remainingUsageCreditBalance === 'number'
    ? customer.remainingUsageCreditBalance
    : (balanceHeld !== null && spent !== null ? balanceHeld - spent : null);

  return {
    ok: true,
    account,
    workspace: workspace.name,
    plan: workspace.plan,
    credit: {
      remaining,
      // What the bar fills against: the balance actually held, not the
      // plan's nominal allowance.
      balance: balanceHeld,
      included,
      spent,
      daysRemaining: customer.trialDaysRemaining ?? null,
      trialing: customer.isTrialing ?? null,
      exhausted: customer.hasExhaustedFreePlan ?? null
    },
    usage: parts,
    raw,
    /* Stamped so a figure on screen can be traced to the build that produced
       it. Two deployments answering at once looks exactly like one deployment
       being unstable. */
    source: { build: BUILD, field: 'remainingUsageCreditBalance' },
    workspaces: workspaces.map(w => ({ id: w.id, name: w.name })),
    note: ambiguous
      ? `this account has ${workspaces.length} workspaces; showing "${workspace.name}". Set RAILWAY_WORKSPACE_ID to pick another.`
      : null
  };
}

/* ------------------------------------------------------------------
   Schema explorer

   Railway's API is introspectable but its billing fields are not documented,
   and their names have changed between versions. Rather than guessing from
   the outside, this asks the account's own schema what it offers, so the
   right query can be written once from fact instead of three times from
   assumption.
   ------------------------------------------------------------------ */
const BILLING_WORDS = /credit|balance|billing|invoice|subscription|plan|trial|usage|limit|spend|cost|estimate/i;

function typeName(t) {
  if (!t) return null;
  return t.name || typeName(t.ofType);
}

export async function explore(token) {
  const result = await query(token, {
    query: `{
      __schema {
        queryType { name }
        types {
          name
          kind
          fields {
            name
            args { name type { name kind ofType { name kind } } }
            type { name kind ofType { name kind ofType { name kind } } }
          }
        }
      }
    }`
  });
  if (!result.ok) return result;

  const types = result.data?.__schema?.types || [];
  const queryTypeName = result.data?.__schema?.queryType?.name || 'Query';
  const byName = Object.fromEntries(types.map(t => [t.name, t]));

  const describe = field => ({
    name: field.name,
    returns: typeName(field.type),
    args: (field.args || []).map(a => ({
      name: a.name,
      type: typeName(a.type),
      required: a.type?.kind === 'NON_NULL'
    }))
  });

  const root = (byName[queryTypeName]?.fields || [])
    .filter(f => BILLING_WORDS.test(f.name))
    .map(describe);

  /* Where the interesting numbers usually live: on the account and on the
     workspace, not at the root. */
  const nested = {};
  for (const holder of ['User', 'Me', 'Workspace', 'Team', 'Customer', 'Project']) {
    const t = byName[holder];
    if (!t?.fields) continue;
    const hits = t.fields.filter(f => BILLING_WORDS.test(f.name)).map(describe);
    if (hits.length) nested[holder] = hits;
  }

  return { ok: true, queryType: queryTypeName, root, nested };
}
