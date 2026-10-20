'use strict';

// HTTP-based speed test against a no-key public endpoint (Cloudflare by default).
//
// Phases:
//   1. warm-up the keep-alive connection so pings measure RTT, not handshake
//   2. ping + jitter (short RTT samples)
//   3. download  — stream for a fixed *duration* (like a real speed test),
//                  sampling live throughput, then stop. More stable than a
//                  fixed byte burst: a fast link still gets the full window.
//   4. upload    — send a fixed byte amount, streamed in chunks (no giant
//                  buffer), timed end-to-end.
//
// Every request has an explicit timeout so a stalled link can never hang the
// test "at a certain time"; each phase is individually guarded so one failed
// phase degrades to a partial result instead of throwing.

const https = require('https');

const DEFAULT_SERVER = 'https://speed.cloudflare.com';

function now() { return Date.now(); }

// bits/s -> Mbps, rounded to 2 decimals
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

// Plain GET used for warm-up + RTT sampling. Resolves on headers-in + drain.
function httpsGet(url, agent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent }, (res) => {
      res.resume();
      resolve();
    });
    req.setTimeout(timeoutMs || 5000, () => {
      try { req.destroy(new Error('request timeout')); } catch (_) {}
    });
    req.on('error', reject);
  });
}

// Cloudflare (and similar public endpoints) cap a single __down request —
// observed ~50 MB, above which the server replies 403. Stay under it, and to
// saturate a fast link for the whole window, issue sequential requests back
// to back instead of one oversized request.
const MAX_DOWNLOAD_CHUNK = 50 * 1024 * 1024;

// Fetch exactly `bytes` (or whatever the server sends) and resolve with the
// byte count received. Bails after `timeoutMs` so a stall can't hang us.
function fetchBytes(url, agent, bytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let got = 0;
    const req = https.get(url, { agent }, (res) => {
      res.on('data', (d) => {
        got += d.length;
        if (bytes > 0 && got >= bytes) {
          try { res.destroy(); } catch (_) {}
        }
      });
      res.on('end', () => resolve(got));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs || 5000, () => {
      try { req.destroy(new Error('download timeout')); } catch (_) {}
    });
    req.on('error', reject);
  });
}

// Download: keep the pipe busy for `durationMs` by issuing sequential __down
// requests (each <= MAX_DOWNLOAD_CHUNK). Resolves with { bytes, secs }.
function httpMeasureDownload(server, agent, durationMs, onProgress, isCancelled) {
  return new Promise((resolve, reject) => {
    const start = now();
    const deadline = start + durationMs;
    const durSec = durationMs / 1000;
    let total = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ bytes: total, secs: Math.max(0.001, Math.min(durSec, (now() - start) / 1000)) });
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };

    const loop = () => {
      if (isCancelled() || settled) return;
      const remaining = deadline - now();
      if (remaining <= 0) return finish();
      // One bounded chunk; a slow link simply doesn't finish it in the window.
      const want = MAX_DOWNLOAD_CHUNK;
      const reqTimeout = Math.max(5000, remaining + 2000); // bail if it stalls
      fetchBytes(`${server}/__down?bytes=${want}`, agent, want, reqTimeout)
        .then((got) => {
          total += got;
          const secs = (now() - start) / 1000;
          if (onProgress) onProgress(Math.min(1, secs / durSec), secs > 0 ? mbps(total, secs) : null);
          if (isCancelled() || now() >= deadline) return finish();
          loop();
        })
        .catch((e) => {
          if (total === 0) fail(e); // nothing received yet -> surface the error
          else finish();           // already have data -> report the partial
        });
    };
    loop();
  });
}

// Push a fixed byte count, chunked with back-pressure so we never allocate one
// huge buffer. Resolves with { bytes, secs } once the server acks the upload.
function httpMeasureUpload(url, agent, totalBytes, onProgress) {
  return new Promise((resolve, reject) => {
    if (totalBytes <= 0) return resolve({ bytes: 0, secs: 0 });
    const t0 = now();
    let settled = false;

    const settle = (bytes, secs) => {
      if (settled) return;
      settled = true;
      resolve({ bytes, secs: Math.max(0.001, secs) });
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };

    const req = https.request(
      url,
      { agent, method: 'POST', headers: { 'Content-Length': totalBytes } },
      (res) => {
        res.resume();
        const secs = (now() - t0) / 1000;
        if (onProgress) onProgress(1, mbps(totalBytes, secs));
        settle(totalBytes, secs);
      }
    );
    req.on('error', fail);
    // Generous stall guard — sized to the payload so slow uplinks don't trip it.
    req.setTimeout(Math.max(60000, totalBytes / (1024 * 1024) * 3000), () => {
      try { req.destroy(new Error('upload stall')); } catch (_) {}
    });

    const CHUNK = 256 * 1024;
    let sent = 0;
    const pump = () => {
      while (sent < totalBytes && !settled) {
        const n = Math.min(CHUNK, totalBytes - sent);
        const chunk = Buffer.alloc(n, 1);
        sent += n;
        const ok = req.write(chunk);
        if (!ok) {
          req.once('drain', pump);
          return;
        }
      }
      if (sent >= totalBytes) req.end();
    };
    pump();
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

  // `downSeconds` drives the download window; `uploadBytes` drives the upload.
  run({ server = DEFAULT_SERVER, downSeconds = 10, uploadBytes, pingCount = 8 } = {}) {
    if (this.active) return Promise.resolve({ ok: false, error: 'a speed test is already running' });
    this.cancelled = false;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 8, family: 4 });
    this.active = true;
    const job = this._run({ server, downSeconds, uploadBytes, pingCount })
      .catch((e) => this._emit('speed:error', { message: String((e && e.message) || e) }))
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
    const downSeconds = Math.max(3, Math.min(60, Number(opts.downSeconds) || 10));
    const result = {
      server,
      downSeconds,
      start: now(),
      pingMs: null,
      jitterMs: null,
      downloadMbps: null,
      uploadMbps: null,
      downloadBytes: 0,
      uploadBytes: 0,
    };

    // warm up the keep-alive connection so pings measure RTT, not handshake
    await httpsGet(`${server}/__ping?bytes=0`, this.agent, 5000).catch(() => {});

    // --- ping + jitter ---
    if (!this.cancelled && opts.pingCount > 0) {
      const rtt = [];
      for (let i = 0; i < opts.pingCount; i++) {
        const t0 = now();
        await httpsGet(`${server}/__ping?bytes=0`, this.agent, 5000).catch(() => {});
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

    // --- download (fixed window, chunked under the server's cap) ---
    if (!this.cancelled) {
      this._emit('speed:progress', { phase: 'download', fraction: 0, mbps: null });
      const dlProgress = throttle(
        (frac, m) => this._emit('speed:progress', { phase: 'download', fraction: frac, mbps: m }),
        150
      );
      try {
        const dl = await httpMeasureDownload(
          server,
          this.agent,
          downSeconds * 1000,
          (frac, m) => {
            dlProgress(frac, m);
            if (frac >= 1) this._emit('speed:progress', { phase: 'download', fraction: 1, mbps: m });
          },
          () => this.cancelled
        );
        result.downloadMbps = mbps(dl.bytes, dl.secs);
        result.downloadBytes = dl.bytes;
      } catch (e) {
        result.downloadError = String((e && e.message) || e);
      }
    }

    // --- upload (fixed bytes, streamed) ---
    if (!this.cancelled) {
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
        result.uploadError = String((e && e.message) || e);
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
