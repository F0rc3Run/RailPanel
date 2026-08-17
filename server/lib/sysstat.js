import { readFileSync, statfsSync, statSync, readdirSync } from 'node:fs';
import { cpus, totalmem, freemem, uptime } from 'node:os';

let lastCpu = null;

/* CPU load has to be measured between two samples; a single read of
   /proc/stat only gives totals since boot. */
function readCpuTotals() {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

export function cpuPercent() {
  const now = readCpuTotals();
  if (!now) return null;
  if (!lastCpu) { lastCpu = now; return null; }

  const idleDelta = now.idle - lastCpu.idle;
  const totalDelta = now.total - lastCpu.total;
  lastCpu = now;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

/* Inside a container the cgroup limit is the number that matters, not the
   host's total memory. Try the cgroup first and fall back to the host. */
function cgroupMemory() {
  const pairs = [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes']
  ];
  for (const [limitPath, usagePath] of pairs) {
    try {
      const raw = readFileSync(limitPath, 'utf8').trim();
      if (raw === 'max') continue;
      const limit = Number(raw);
      const used = Number(readFileSync(usagePath, 'utf8').trim());
      if (limit > 0 && limit < Number.MAX_SAFE_INTEGER && used >= 0) {
        return { total: limit, used };
      }
    } catch { /* try the next layout */ }
  }
  return null;
}

export function memory() {
  const cg = cgroupMemory();
  if (cg) return cg;
  const total = totalmem();
  return { total, used: total - freemem() };
}

/* Inside a container, cpus() reports the host's processors — Railway's
   machines have dozens, and none of them are yours. The cgroup quota is the
   real allowance, so it is read first and the host count only stands in when
   no quota is set. */
export function cores() {
  const pairs = [
    ['/sys/fs/cgroup/cpu.max', null],
    ['/sys/fs/cgroup/cpu/cpu.cfs_quota_us', '/sys/fs/cgroup/cpu/cpu.cfs_period_us']
  ];
  for (const [quotaPath, periodPath] of pairs) {
    try {
      const raw = readFileSync(quotaPath, 'utf8').trim();
      let quota, period;
      if (periodPath) {
        quota = Number(raw);
        period = Number(readFileSync(periodPath, 'utf8').trim());
      } else {
        const [q, p] = raw.split(/\s+/);
        if (q === 'max') continue;
        quota = Number(q); period = Number(p);
      }
      if (quota > 0 && period > 0) {
        const allowed = quota / period;
        return { count: Math.max(0.1, Math.round(allowed * 10) / 10), limited: true };
      }
    } catch { /* try the next layout */ }
  }
  return { count: cpus().length, limited: false };
}

/* Where the volume's space has gone, rather than a fixed guess. The panel
   knows what it wrote; the rest is whatever else lives on the mount. */
export function diskBreakdown(path = process.env.DATA_DIR || '/data') {
  const totals = disk(path);
  const sizeOf = file => {
    try { return statSync(join(path, file)).size; } catch { return 0; }
  };
  const panelData = sizeOf('railpanel.json');

  let xrayBytes = 0;
  try {
    const dir = join(path, 'xray');
    for (const name of readdirSync(dir)) {
      try { xrayBytes += statSync(join(dir, name)).size; } catch {}
    }
  } catch { /* no downloaded core yet */ }

  const other = Math.max(0, totals.used - panelData - xrayBytes);
  return {
    total: totals.total,
    used: totals.used,
    free: Math.max(0, totals.total - totals.used),
    panel: panelData,
    xray: xrayBytes,
    other
  };
}

export function disk(path = process.env.DATA_DIR || '/data') {
  try {
    const st = statfsSync(path);
    const total = st.blocks * st.bsize;
    return { total, used: total - st.bfree * st.bsize };
  } catch {
    return { total: 0, used: 0 };
  }
}

export function snapshot() {
  const mem = memory();
  const dsk = diskBreakdown();
  return {
    cpu: cpuPercent(),
    cores: cores(),
    memory: mem,
    disk: dsk,
    uptimeSec: Math.floor(uptime()),
    processUptimeSec: Math.floor(process.uptime())
  };
}

// Prime the CPU sampler so the first request returns a real number.
readCpuTotals();
lastCpu = readCpuTotals();
