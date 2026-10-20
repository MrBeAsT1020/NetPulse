'use strict';

// A controlled soak test: ping a target on a fixed interval for a set duration
// (30 min / 1 hr presets, or custom), collect every sample, then produce a
// reliability report (availability, loss, latency percentiles, jitter,
// incidents). Runs its own pings so it can coexist with the live monitor.

const { runPing } = require('./ping');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(results) {
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const lost = total - ok;
  const lat = results.filter((r) => r.timeMs != null).map((r) => r.timeMs);
  return {
    total,
    ok,
    lost,
    lossPct: total ? Math.round((lost / total) * 1000) / 10 : null,
    avgMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    minMs: lat.length ? Math.min(...lat) : null,
    maxMs: lat.length ? Math.max(...lat) : null,
  };
}

function buildReport(session, partial) {
  const s = summarize(session.results);
  const lat = session.results
    .filter((r) => r.timeMs != null)
    .map((r) => r.timeMs)
    .sort((a, b) => a - b);

  // Jitter: mean absolute difference between consecutive samples that replied.
  let jitter = null;
  const seq = session.results.filter((r) => r.timeMs != null).map((r) => r.timeMs);
  if (seq.length > 1) {
    let sum = 0;
    for (let i = 1; i < seq.length; i++) sum += Math.abs(seq[i] - seq[i - 1]);
    jitter = Math.round(sum / (seq.length - 1));
  }

  // Incidents: a run of consecutive samples that were lost OR above critical.
  const crit = session.cfg.critMs;
  let incidents = [];
  let cur = null;
  for (const r of session.results) {
    const bad = r.lost || (r.timeMs != null && r.timeMs >= crit);
    if (bad) {
      if (!cur) cur = { startT: r.t, endT: r.t, samples: 1, loss: r.lost ? 1 : 0, maxMs: r.timeMs };
      else {
        cur.endT = r.t;
        cur.samples += 1;
        if (r.lost) cur.loss += 1;
        if (r.timeMs != null && (cur.maxMs == null || r.timeMs > cur.maxMs)) cur.maxMs = r.timeMs;
      }
    } else if (cur) {
      cur.durationSec = Math.round((cur.endT - cur.startT) / 1000);
      incidents.push(cur);
      cur = null;
    }
  }
  if (cur) {
    cur.durationSec = Math.round((cur.endT - cur.startT) / 1000);
    incidents.push(cur);
  }

  const availabilityPct = s.total ? Math.round(((s.ok / s.total) * 100) * 100) / 100 : null;

  return {
    target: session.cfg.target,
    startISO: new Date(session.start).toISOString(),
    endISO: new Date(now()).toISOString(),
    requestedSec: session.cfg.durationSec,
    elapsedSec: Math.round((now() - session.start) / 1000),
    partial: !!partial,
    packets: { sent: s.total, received: s.ok, lost: s.lost, lossPct: s.lossPct },
    availabilityPct,
    latency: {
      avgMs: s.avgMs,
      minMs: s.minMs,
      maxMs: s.maxMs,
      p50Ms: round1(percentile(lat, 0.5)),
      p95Ms: round1(percentile(lat, 0.95)),
      p99Ms: round1(percentile(lat, 0.99)),
      jitterMs: jitter,
    },
    incidents,
  };
}

function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}
function now() {
  return Date.now();
}

class ReliabilityTest {
  constructor({ emit }) {
    this.emit = emit || (() => {});
    this.session = null;
  }

  get isRunning() {
    return !!this.session;
  }

  /**
   * cfg: { target, durationSec, pingIntervalMs, pingTimeoutMs, critMs }
   */
  start(cfg) {
    this.stop(); // cancel any in-flight test
    const session = {
      cfg,
      start: now(),
      durationMs: Math.max(5, cfg.durationSec) * 1000,
      results: [],
      timer: null,
      progressTimer: null,
      _doneSent: false,
    };
    this.session = session;
    this.emit('reliability:start', { cfg, start: session.start });
    this._tick(session);
    session.timer = setInterval(() => this._tick(session), cfg.pingIntervalMs);
    session.progressTimer = setInterval(() => this._progress(session), 5000);
    return { ok: true, durationSec: cfg.durationSec };
  }

  async _tick(session) {
    if (this.session !== session) return;
    const res = await runPing(session.cfg.target, {
      count: 1,
      timeoutMs: session.cfg.pingTimeoutMs,
    });
    if (this.session !== session) return; // cancelled
    session.results.push({
      t: now(),
      ok: res.ok,
      timeMs: res.ok && res.timeMs != null ? res.timeMs : null,
      lost: !res.ok || res.lost,
    });
    if (now() - session.start >= session.durationMs) this._finish(session, false);
  }

  _progress(session) {
    if (this.session !== session || session._doneSent) return;
    const s = summarize(session.results);
    this.emit('reliability:progress', {
      elapsedSec: Math.floor((now() - session.start) / 1000),
      durationSec: session.cfg.durationSec,
      lossPct: s.lossPct,
      avgMs: s.avgMs,
      total: s.total,
    });
  }

  _finish(session, partial) {
    if (this.session !== session || session._doneSent) return;
    session._doneSent = true;
    clearInterval(session.timer);
    clearInterval(session.progressTimer);
    if (this.session === session) this.session = null;
    const report = buildReport(session, partial);
    this.emit('reliability:done', { report, results: session.results });
  }

  stop() {
    const s = this.session;
    if (!s) return;
    // Mark so the in-flight tick drops out, then emit a partial report if not done.
    this.session = null;
    clearInterval(s.timer);
    clearInterval(s.progressTimer);
    if (!s._doneSent) {
      s._doneSent = true;
      const report = buildReport(s, true);
      this.emit('reliability:done', { report, results: s.results, partial: true });
    }
  }
}

module.exports = { ReliabilityTest, buildReport, summarize, percentile };
