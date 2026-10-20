'use strict';

const fs = require('fs');
const path = require('path');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class PingLog {
  constructor(dir, target) {
    this.dir = dir;
    this.target = target;
    this.file = path.join(dir, `ping-${stamp()}-${sanitize(target)}.csv`);
    this.rows = 0;
    this._writeHeader();
  }

  _writeHeader() {
    const cols = ['timestamp_iso', 'ts_ms', 'target', 'latency_ms', 'lost', 'ttl', 'window_avg_ms', 'window_min_ms', 'window_max_ms', 'window_loss_pct'];
    fs.writeFileSync(this.file, cols.join(',') + '\n');
  }

  write(sample, windowStats) {
    const iso = new Date(sample.t).toISOString();
    const w = windowStats || {};
    const line = [
      iso,
      sample.t,
      quote(this.target),
      sample.v == null ? '' : sample.v,
      sample.lost ? 1 : 0,
      sample.ttl || 0,
      w.avgMs != null ? w.avgMs : '',
      w.minMs != null ? w.minMs : '',
      w.maxMs != null ? w.maxMs : '',
      w.lossPct != null ? w.lossPct : '',
    ].join(',');
    fs.appendFileSync(this.file, line + '\n');
    this.rows += 1;
  }

  path() {
    return this.file;
  }

  /** Snapshot the accumulated CSV to a caller-chosen path (export). */
  copyTo(dest) {
    fs.copyFileSync(this.file, dest);
  }
}

class HopLog {
  constructor(dir, target) {
    this.file = path.join(dir, `tracert-${stamp()}-${sanitize(target)}.log`);
    fs.writeFileSync(this.file, `# NetPulse traceroute snapshots for ${target}\n`);
  }

  write(hops) {
    const when = new Date().toISOString();
    let text = `\n[${when}] ${hops.target}\n`;
    for (const h of hops.hops) {
      const s = (h.samples || []).map((x) => (x == null ? '*' : `${x}ms`)).join(' ');
      text += `  ${h.index}\t${s}\thost=${h.host}\n`;
    }
    fs.appendFileSync(this.file, text);
  }

  path() {
    return this.file;
  }
}

function sanitize(s) {
  return String(s).replace(/[^\w.-]/g, '_').slice(0, 40);
}
function quote(s) {
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

module.exports = { PingLog, HopLog };
