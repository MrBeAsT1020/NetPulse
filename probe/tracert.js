'use strict';

const { spawn } = require('child_process');

/**
 * Run Windows `tracert` and resolve with a normalized hop list.
 *
 * Defaults to `-d` (IP only, fast) for reliability; set resolveHost:true to
 * get DNS names at the cost of a slower trace.
 *
 * Resolves to:
 *   {
 *     target, ok, hops: [ { index, host, samples: [ms|null], avgMs } ], raw
 *   }
 */
function runTracert(target, { maxHops = 20, timeoutMs = 1000, resolveHost = false } = {}) {
  return new Promise((resolve) => {
    const args = ['-h', String(maxHops), '-w', String(timeoutMs)];
    if (!resolveHost) args.push('-d');
    args.push(target);

    let stdout = '';
    let stderr = '';
    let child;
    try {
      // tracert can take a while (maxHops * 3 * timeout in the worst case).
      child = spawn('tracert', args, { windowsHide: true });
    } catch (err) {
      return resolve({ target, ok: false, hops: [], error: String(err && err.message || err) });
    }

    const hardKill = setTimeout(() => {
      try { child.kill(); } catch (_) {}
    }, maxHops * 3 * timeoutMs + 5000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(hardKill);
      resolve({ target, ok: false, hops: [], error: String(err && err.message || err) });
    });
    child.on('close', () => {
      clearTimeout(hardKill);
      resolve({ ...parseTracert(stdout, target), target, rawError: stderr ? stderr.slice(0, 200) : '' });
    });
  });
}

/**
 * Parse English Windows `tracert` output into a hop list.
 *
 * A hop line looks like:
 *   "  3    81 ms     *        *     162.158.226.88 "
 * i.e. an index, three latency samples (each "NN ms" or "*"), then the host label.
 */
function parseTracert(text, target) {
  const out = { ok: false, hops: [] };
  if (!text) return out;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    // index + exactly three latency fields (ms or *), then the host.
    const re = /^\s*(\d{1,3})\s+(?:([0-9<]{1,4})\s*ms|\*)\s+(?:([0-9<]{1,4})\s*ms|\*)\s+(?:([0-9<]{1,4})\s*ms|\*)\s+(.+?)\s*$/;
    const m = line.match(re);
    if (!m) continue;
    const idx = Number(m[1]);
    if (idx < 1 || idx > 64) continue;
    const samples = [m[2], m[3], m[4]].map((s) => (s === undefined || s === '' ? null : s === '<' ? 0.4 : Number(s)));
    const host = m[5].trim();
    out.hops.push({ index: idx, host, samples, avgMs: avg(samples) });
    out.ok = true;
  }
  return out;
}

function avg(samples) {
  const nums = (samples || []).filter((s) => s != null);
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

module.exports = { runTracert, parseTracert };
