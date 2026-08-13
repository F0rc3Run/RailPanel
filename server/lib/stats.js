import { execFile } from 'node:child_process';

const BIN = process.env.XRAY_BIN || '/usr/local/xray/xray';
const API = `127.0.0.1:${process.env.XRAY_API_PORT || 10085}`;

/* Xray keeps its counters in memory, so they start again from zero every time
   it restarts — and the panel restarts it whenever a client is added. Reading
   raw values would therefore lose traffic on every change. What gets stored is
   the running total, grown by the difference since the last read. */

/* Kept short: a real Xray answers in milliseconds, and a reset that waits on
   a stopped one should fail fast rather than leave the panel spinning. */
function run(args) {
  return new Promise(resolve => {
    execFile(BIN, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim() });
      resolve({ ok: true, stdout });
    });
  });
}

/* Returns { 'nodeset.c1': { up, down }, ... } as reported right now. */
export async function readCounters() {
  const result = await run(['api', 'statsquery', `--server=${API}`, 'user>>>']);
  if (!result.ok) return { ok: false, error: result.error, counters: {} };

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: 'could not parse the stats output', counters: {} };
  }

  const counters = {};
  for (const entry of parsed.stat || []) {
    // name looks like: user>>>nodeset.c1>>>traffic>>>downlink
    const parts = String(entry.name || '').split('>>>');
    if (parts.length < 4 || parts[0] !== 'user') continue;
    const email = parts[1];
    const direction = parts[3];
    const value = Number(entry.value || 0);
    if (!counters[email]) counters[email] = { up: 0, down: 0 };
    if (direction === 'uplink') counters[email].up = value;
    if (direction === 'downlink') counters[email].down = value;
  }
  return { ok: true, counters };
}

/* Grows each client's stored total by whatever Xray has counted since the
   last look. A counter that went backwards means Xray restarted, so the
   current value is itself the new traffic. */
export function applyCounters(clients, counters, keyFor) {
  let changed = false;

  for (const client of clients) {
    const key = keyFor(client);
    const now = counters[key];
    if (!now) continue;

    const total = now.up + now.down;
    const previous = Number(client.counterAt || 0);
    const delta = total < previous ? total : total - previous;

    if (delta > 0) {
      client.usedBytes = Number(client.usedBytes || 0) + delta;
      if (!client.firstUseAt) client.firstUseAt = new Date().toISOString();
      changed = true;
    }
    if (total !== previous) {
      client.counterAt = total;
      changed = true;
    }
  }

  return changed;
}
