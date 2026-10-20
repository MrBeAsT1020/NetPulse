'use strict';

const { spawn } = require('child_process');

/**
 * Run a single-shot ping (one packet) and resolve with a normalized sample.
 *
 * Uses `ping -n 1 -w <timeout> <target>` so each call is one discrete sample,
 * which the monitor ticks on an interval to build the rolling latency plot.
 *
 * Resolves to:
 *   {
 *     target, ok, lost, timeMs, minMs, maxMs, ttl, error
 *   }
 * - ok:   true when a reply was received
 * - timeMs: the reply latency in ms (null when lost/unresolved)
 * - ttl:  time-to-live from the reply (0 when unknown)
 */
function runPing(target, { count = 1, timeoutMs = 1000, resolveHost = true } = {}) {
  return new Promise((resolve) => {
    const args = ['-n', String(count), '-w', String(timeoutMs)];
    if (count === 1 && resolveHost === false) args.push('-n', '1');
    args.push(target);

    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn('ping', args, { windowsHide: true });
    } catch (err) {
      return resolve({ target, ok: false, lost: true, timeMs: null, minMs: null, maxMs: null, ttl: 0, error: String(err && err.message || err) });
    }

    const killTimer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
    }, timeoutMs * count + 2000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ target, ok: false, lost: true, timeMs: null, minMs: null, maxMs: null, ttl: 0, error: String(err && err.message || err) });
    });

    child.on('close', () => {
      clearTimeout(killTimer);
      resolve({ ...parsePing(stdout, target), target, rawError: stderr ? stderr.slice(0, 200) : '' });
    });
  });
}

/**
 * Parse English Windows `ping` output into a normalized sample.
 * Tolerant of non-English labels by keying on the numeric shapes.
 */
function parsePing(text, target) {
  const out = { ok: false, lost: false, timeMs: null, minMs: null, maxMs: null, ttl: 0 };
  if (!text) return out;

  // Per-reply times: "Reply from X: bytes=32 time=68ms TTL=118"
  const times = [];
  const replyRe = /time=(\d+|<1)\s*ms(?:\s*TTL=(\d+))?/gi;
  let m;
  let ttl = 0;
  while ((m = replyRe.exec(text)) !== null) {
    times.push(m[1] === '<1' ? 0.4 : Number(m[1]));
    if (m[2]) ttl = Number(m[2]);
  }

  // Loss from "Lost = 0 (0% loss)" or "(100% loss)"
  const lostMatch = text.match(/Lost\s*=\s*(\d+)\s*\((\d+)%\s*loss/i);
  const lostCount = lostMatch ? Number(lostMatch[1]) : null;

  // Min / Max / Average (works even if labels are localized)
  const statRe = /(Minimum|Average|Maximum)\s*=\s*(\d+|<1)\s*ms/gi;
  const stats = {};
  while ((m = statRe.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    stats[key] = m[2] === '<1' ? 0.4 : Number(m[2]);
  }

  if (stats.average != null) out.timeMs = stats.average;
  if (stats.minimum != null) out.minMs = stats.minimum;
  if (stats.maximum != null) out.maxMs = stats.maximum;
  out.ttl = ttl;

  const isTimedOut = /Request timed out|timed out/i.test(text) && times.length === 0;
  const anyReply = times.length > 0;

  if (anyReply) {
    out.ok = true;
    out.lost = false;
    if (out.timeMs == null) out.timeMs = avg(times);
  } else if (isTimedOut || (lostCount != null && lostCount > 0)) {
    out.ok = false;
    out.lost = true;
  } else {
    // No reply and no explicit timeout text -> treat as lost (e.g. unreachable/filtered)
    out.ok = false;
    out.lost = true;
  }
  return out;
}

function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

module.exports = { runPing, parsePing };
