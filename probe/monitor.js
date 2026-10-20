'use strict';

const { runPing } = require('./ping');
const { runTracert } = require('./tracert');

/**
 * The probe engine. Ticks single-packet pings on `pingIntervalMs` and
 * re-runs traceroute on `traceIntervalS`, maintaining rolling history and
 * detecting threshold breaches. Pure logic + child processes; no Electron.
 *
 * `emit(channel, payload)` is how it talks to the UI; `logPing`/`logHop`
 * hand off to the persistent loggers.
 */
class Monitor {
  constructor({ emit, logPing, logHop }) {
    this.emit = emit || (() => {});
    this.logPing = logPing || (() => {});
    this.logHop = logHop || (() => {});

    this.running = false;
    this.cfg = null;
    this.samples = [];          // { t, v, lost, ttl }
    this.pingInFlight = false;
    this._pingTimer = null;
    this._traceTimer = null;
    this._pendingTracert = null;

    this.alerts = { latency: 'none', loss: 'none' };
    this.startSample = null;
  }

  get isRunning() {
    return this.running;
  }

  start(cfg) {
    this.stop();
    this.cfg = cfg;
    this.samples = [];
    this.alerts = { latency: 'none', loss: 'none' };
    this.startSample = Date.now();
    this.running = true;

    // Kick off a traceroute immediately so the hop view isn't empty.
    this._runTracert();
    if (cfg.traceIntervalS > 0) {
      this._traceTimer = setInterval(() => this._runTracert(), cfg.traceIntervalS * 1000);
    }

    this._pingNow();
    this._pingTimer = setInterval(() => this._pingNow(), cfg.pingIntervalMs);

    this.emit('probe:status', { running: true, target: cfg.target });
  }

  stop() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._traceTimer) {
      clearInterval(this._traceTimer);
      this._traceTimer = null;
    }
    this.running = false;
  }

  /** Apply a config change to a running monitor (thresholds, intervals). */
  update(cfg) {
    this.cfg = cfg;
    if (!this.running) return;
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this._pingNow(), cfg.pingIntervalMs);
    }
    if (this._traceTimer) {
      clearInterval(this._traceTimer);
      this._traceTimer = null;
    }
    if (cfg.traceIntervalS > 0) {
      this._traceTimer = setInterval(() => this._runTracert(), cfg.traceIntervalS * 1000);
      this._runTracert();
    }
  }

  async _pingNow() {
    if (!this.running || !this.cfg) return;
    if (this.pingInFlight) return; // never overlap a ping with itself
    this.pingInFlight = true;
    try {
      const res = await runPing(this.cfg.target, {
        count: 1,
        timeoutMs: this.cfg.pingTimeoutMs,
      });
      if (!this.running) return;
      const t = Date.now();
      const sample = {
        t,
        v: res.ok && res.timeMs != null ? res.timeMs : null,
        lost: !res.ok || res.lost,
        ttl: res.ttl || 0,
        resolved: res.resolved,
      };
      this.samples.push(sample);
      this._trimSamples();

      const window = this._windowStats();
      this.logPing(sample, window);
      this._evaluateAlerts(sample, window);
      this.emit('probe:sample', { sample, window, resolved: sample.resolved });

      if (res.error && !res.ok && !res.lost) {
        this.emit('probe:error', { message: res.error });
      }
    } catch (err) {
      this.emit('probe:error', { message: String(err && err.message || err) });
    } finally {
      this.pingInFlight = false;
    }
  }

  async _runTracert() {
    if (!this.running || !this.cfg) return;
    if (this._pendingTracert) return; // one at a time
    this._pendingTracert = true;
    this.emit('probe:hopStatus', { busy: true });
    try {
      const res = await runTracert(this.cfg.target, {
        maxHops: this.cfg.traceMaxHops,
        timeoutMs: 1000,
        resolveHost: this.cfg.resolveHosts,
      });
      if (!this.running) return;
      const t = Date.now();
      this.logHop(res);
      this.emit('probe:hop', { t, hops: res.hops, target: res.target });
    } catch (err) {
      this.emit('probe:error', { message: String(err && err.message || err) });
    } finally {
      this._pendingTracert = false;
      this.emit('probe:hopStatus', { busy: false });
    }
  }

  _trimSamples() {
    if (!this.cfg) return;
    const cutoff = Date.now() - this.cfg.historySeconds * 1000;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  _windowStats() {
    const nums = this.samples.filter((s) => s.v != null).map((s) => s.v);
    const lost = this.samples.filter((s) => s.lost).length;
    const total = this.samples.length;
    if (total === 0) return { avgMs: null, minMs: null, maxMs: null, lossPct: null, total: 0 };
    const lossPct = Math.round((lost / total) * 100);
    return {
      avgMs: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null,
      minMs: nums.length ? Math.min(...nums) : null,
      maxMs: nums.length ? Math.max(...nums) : null,
      lossPct,
      total,
    };
  }

  _evaluateAlerts(sample, window) {
    const c = this.cfg;
    const lookback = this.samples.slice(-10); // ~last 10s at 1s cadence
    const lLost = lookback.filter((s) => s.lost).length;
    const lossPct = lookback.length ? Math.round((lLost / lookback.length) * 100) : 0;

    // Latency level from the current sample.
    let latency = 'none';
    if (sample.v != null) {
      if (sample.v >= c.critMs) latency = 'critical';
      else if (sample.v >= c.warnMs) latency = 'warning';
    }
    if (latency === 'none' && this.alerts.latency !== 'none') {
      this.emit('probe:alert', { kind: 'latency', severity: 'recovered', value: sample.v, t: sample.t });
    }
    if (latency !== 'none' && latency !== this.alerts.latency) {
      const thr = latency === 'critical' ? c.critMs : c.warnMs;
      this.emit('probe:alert', {
        kind: 'latency',
        severity: latency,
        value: sample.v,
        threshold: thr,
        t: sample.t,
      });
    }
    this.alerts.latency = latency;

    // Loss level over the lookback window.
    let loss = 'none';
    if (lossPct >= 50) loss = 'critical';
    else if (lossPct >= c.lossPct) loss = 'warning';
    if (loss === 'none' && this.alerts.loss !== 'none') {
      this.emit('probe:alert', { kind: 'loss', severity: 'recovered', value: lossPct, t: sample.t });
    }
    if (loss !== 'none' && loss !== this.alerts.loss) {
      this.emit('probe:alert', {
        kind: 'loss',
        severity: loss,
        value: lossPct,
        threshold: c.lossPct,
        t: sample.t,
      });
    }
    this.alerts.loss = loss;
  }
}

module.exports = Monitor;
