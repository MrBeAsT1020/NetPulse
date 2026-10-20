'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Persistent settings + log-file bookkeeping.
 * Everything lives under Electron's userData dir (%APPDATA%/netpulse).
 */

const DEFAULTS = {
  target: '8.8.8.8',

  // Ping engine (single packet per tick, ticked on an interval)
  pingIntervalMs: 1000,      // how often a sample is taken
  pingTimeoutMs: 1000,       // -w per-packet timeout

  // Traceroute engine
  traceIntervalS: 30,        // how often to re-run tracert (0 = off)
  traceMaxHops: 20,
  resolveHosts: false,       // true => drop -d and resolve DNS (slower)

  // Thresholds for color-coding & alerts
  warnMs: 100,
  critMs: 250,
  lossPct: 25,               // alert when window loss >= this %

  // Behavior
  soundAlerts: true,
  historySeconds: 120,        // how much rolling history the graph keeps

  // Speed test (Cloudflare public endpoint, no API key needed)
  speedDownloadMB: 25,
  speedUploadMB: 10,
  speedServer: 'https://speed.cloudflare.com'
};

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalize(cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  c.pingIntervalMs = clampInt(c.pingIntervalMs, 500, 60000, DEFAULTS.pingIntervalMs);
  c.pingTimeoutMs = clampInt(c.pingTimeoutMs, 200, 30000, DEFAULTS.pingTimeoutMs);
  c.traceIntervalS = clampInt(c.traceIntervalS, 0, 600, DEFAULTS.traceIntervalS);
  c.traceMaxHops = clampInt(c.traceMaxHops, 1, 30, DEFAULTS.traceMaxHops);
  c.warnMs = clampInt(c.warnMs, 1, 100000, DEFAULTS.warnMs);
  c.critMs = clampInt(c.critMs, 1, 1000000, DEFAULTS.critMs);
  if (c.critMs < c.warnMs) c.critMs = c.warnMs;
  c.lossPct = clampInt(c.lossPct, 1, 100, DEFAULTS.lossPct);
  c.historySeconds = clampInt(c.historySeconds, 15, 3600, DEFAULTS.historySeconds);
  c.target = String(c.target || DEFAULTS.target).trim() || DEFAULTS.target;
  c.resolveHosts = !!c.resolveHosts;
  c.soundAlerts = c.soundAlerts !== false;
  c.speedDownloadMB = clampInt(c.speedDownloadMB, 1, 500, DEFAULTS.speedDownloadMB);
  c.speedUploadMB = clampInt(c.speedUploadMB, 0, 250, DEFAULTS.speedUploadMB);
  c.speedServer = String(c.speedServer || DEFAULTS.speedServer).replace(/\/+$/, '');
  return c;
}

class ConfigStore {
  constructor(app) {
    this.app = app;
    this.file = path.join(app.getPath('userData'), 'config.json');
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return normalize(JSON.parse(raw));
    } catch (_) {
      return normalize({});
    }
  }

  save(cfg) {
    const clean = normalize(cfg);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(clean, null, 2));
    } catch (err) {
      console.error('[config] save failed', err);
    }
    return clean;
  }

  logsDir() {
    const dir = path.join(this.app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

module.exports = { ConfigStore, DEFAULTS, normalize };
