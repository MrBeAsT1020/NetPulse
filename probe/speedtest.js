'use strict';

// HTTP-based speed test against a no-key public endpoint (Cloudflare by default).
// Phases: warm-up, ping (+jitter), download (streaming, live Mbps), upload.
// Emits progress so the UI can animate; resolves with the final result.

const https = require('https');

const DEFAULT_SERVER = 'https://speed.cloudflare.com';

function now() { return Date.now(); }

function mbps(bytes, secs) {
  if (!bytes || !secs || secs <= 0) return null;
  return Math.round((bytes * 8) / secs / 1e6 * 100) / 100;
}

// Throttle a callback to at most once every `ms`.
function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const t = Date.now();
    if (t - last >= ms) {
      last = t;
      fn(...args);
    }
  };
}

function httpGet(url, agent, expectBytes) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent }, (res) => {
      let got = 0;
      res.on('data', (d) => {
        got += d.length;
        if (expectBytes > 0 && got >= expectBytes) {
          try { res.destroy(); } catch (_) {}
        }
      });
      res.on('end', () => resolve(got));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function httpMeasureDownload(url, agent, totalBytes, onProgress) {
  return new Promise((resolve, reject) => {
    let dataStart = now();
    let received = 0;
    let settled = false;
    const settle = (bytes) => {
      if (settled) return;
      settled = true;
      resolve({ bytes, secs: Math.max(0.001, (now() - dataStart) / 1000) });
    };
    const req = https.get(url, { agent }, (res) => {
      dataStart = now();
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received >= totalBytes) {
          try { res.destroy(); } catch (_) {}
        }
        if (onProgress) {
          const secs = (now() - dataStart) / 1000;
          onProgress(Math.min(1, received / totalBytes), secs > 0 ? mbps(received, secs) : null);
        }
      });
      res.on('end', () => settle(received));
      res.on('close', () => settle(received));
      res.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

function httpMeasureUpload(url, agent, totalBytes, onProgress) {
  return new Promise((resolve, reject) => {
    if (totalBytes <= 0) return resolve({ bytes: 0, secs: 0 });
    const body = Buffer.alloc(totalBytes, 1);
    const t0 = now();
    let settled = false;
    const req = https.request(
      url,
      { agent, method: 'POST', headers: { 'Content-Length': totalBytes } },
      (res) => {
        res.resume();
        const secs = Math.max(0.001, (now() - t0) / 1000);
        if (onProgress) onProgress(1, mbps(totalBytes, secs));
        if (!settled) {
          settled = true;
          resolve({ bytes: totalBytes, secs });
        }
      }
    );
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    req.end(body);
  });
}

class SpeedTester {
  constructor({ emit }) {
    this.emit = emit || (() => {});
    this.agent = null;
    this.active = false;
    this.cancelled = false;
    this.last = null;
  }

  get isRunning() {
    return this.active;
  }

  get lastResult() {
    return this.last;
  }

  run({ server = DEFAULT_SERVER, downloadBytes, uploadBytes, pingCount = 8 } = {}) {
    if (this.active) return Promise.resolve({ ok: false, error: 'a speed test is already running' });
    this.cancelled = false;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 4, family: 4 });
    this.active = true;
    const job = this._run({ server, downloadBytes, uploadBytes, pingCount })
      .catch((e) => this._emit('speed:error', { message: String(e && e.message || e) }))
      .finally(() => {
        this.active = false;
        if (this.agent) {
          try { this.agent.destroy(); } catch (_) {}
          this.agent = null;
        }
      });
    return job;
  }

  stop() {
    this.cancelled = true;
    if (this.agent) {
      try { this.agent.destroy(); } catch (_) {}
    }
  }

  _emit(channel, payload) {
    if (!this.cancelled) this.emit(channel, payload);
  }

  async _run(opts) {
    const server = opts.server;
    const result = {
      server,
      start: now(),
      pingMs: null,
      jitterMs: null,
      downloadMbps: null,
      uploadMbps: null,
      downloadBytes: 0,
      uploadBytes: 0,
    };

    // warm up the keep-alive connection so pings measure RTT, not handshake
    await httpGet(`${server}/__ping?bytes=0`, this.agent, 0).catch(() => {});

    // --- ping + jitter ---
    if (!this.cancelled && opts.pingCount > 0) {
      const rtt = [];
      for (let i = 0; i < opts.pingCount; i++) {
        const t0 = now();
        await httpGet(`${server}/__ping?bytes=0`, this.agent, 0).catch(() => {});
        rtt.push(now() - t0);
        if (this.cancelled) break;
      }
      const arr = (rtt.slice(1).length ? rtt.slice(1) : rtt).filter((x) => Number.isFinite(x));
      if (arr.length) {
        result.pingMs = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
        let jsum = 0;
        for (let i = 1; i < arr.length; i++) jsum += Math.abs(arr[i] - arr[i - 1]);
        result.jitterMs = arr.length > 1 ? Math.round(jsum / (arr.length - 1)) : 0;
      }
    }

    // --- download ---
    if (!this.cancelled && opts.downloadBytes > 0) {
      this._emit('speed:progress', { phase: 'download', fraction: 0, mbps: null });
      const dlProgress = throttle(
        (frac, m) => this._emit('speed:progress', { phase: 'download', fraction: frac, mbps: m }),
        150
      );
      try {
        const dl = await httpMeasureDownload(
          `${server}/__down?bytes=${opts.downloadBytes}`,
          this.agent,
          opts.downloadBytes,
          (frac, m) => {
            dlProgress(frac, m);
            if (frac >= 1) this._emit('speed:progress', { phase: 'download', fraction: 1, mbps: m });
          }
        );
        result.downloadMbps = mbps(dl.bytes, dl.secs);
        result.downloadBytes = dl.bytes;
      } catch (e) {
        result.downloadError = String(e && e.message || e);
      }
    }

    // --- upload ---
    if (!this.cancelled && opts.uploadBytes > 0) {
      this._emit('speed:progress', { phase: 'upload', fraction: 0, mbps: null });
      try {
        const up = await httpMeasureUpload(
          `${server}/__up`,
          this.agent,
          opts.uploadBytes,
          (frac, m) => this._emit('speed:progress', { phase: 'upload', fraction: frac, mbps: m })
        );
        result.uploadMbps = mbps(up.bytes, up.secs);
        result.uploadBytes = up.bytes;
      } catch (e) {
        result.uploadError = String(e && e.message || e);
      }
    }

    result.end = now();
    result.ok = !this.cancelled;
    if (this.cancelled) result.cancelled = true;
    this.last = result;
    this._emit('speed:done', { result });
    return result;
  }
}

module.exports = { SpeedTester, DEFAULT_SERVER, mbps };
