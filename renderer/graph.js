'use strict';

// Colors (dark pro theme). Severity palette:
const C = {
  bg: 'transparent',
  grid: 'rgba(255,255,255,0.06)',
  axis: 'rgba(255,255,255,0.35)',
  label: 'rgba(255,255,255,0.55)',
  ok: '#3fb950',
  warn: '#e3b341',
  crit: '#f85149',
  lost: '#5a6270',
  lostMark: '#f85149',
};

function severity(v, warn, crit, lost) {
  if (lost) return 'lost';
  if (v == null) return 'lost';
  if (v >= crit) return 'crit';
  if (v >= warn) return 'warn';
  return 'ok';
}
const SEV_COLOR = { ok: C.ok, warn: C.warn, crit: C.crit, lost: C.lost };

function niceCeil(v) {
  if (!isFinite(v) || v <= 0) return 50;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * pow;
}
function niceStep(v) {
  if (!isFinite(v) || v <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * pow;
}

/**
 * Rolling latency plot on a <canvas>. Points are placed by real timestamp
 * across the most recent `historyMs`, so old data scrolls off the left edge.
 */
class LatencyGraph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = { l: 52, r: 18, t: 18, b: 22 };
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.resize();
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas.parentElement);
    } else {
      window.addEventListener('resize', () => this.resize());
    }
  }

  resize() {
    const host = this.canvas.parentElement;
    if (!host || !host.clientWidth) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    this.W = w;
    this.H = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this._lastSamples) this.draw(this._lastSamples, this._lastCfg, this._lastNow);
  }

  setData(samples, cfg, now = Date.now()) {
    this._lastSamples = samples;
    this._lastCfg = cfg;
    this._lastNow = now;
    this.draw(samples, cfg, now);
  }

  draw(samples, cfg, now) {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);

    const { l, t, r, b } = this.pad;
    const plotW = W - l - r;
    const plotH = H - t - b;
    if (plotW <= 0 || plotH <= 0) return;

    const historyMs = (cfg.historySeconds || 120) * 1000;
    const warn = cfg.warnMs, crit = cfg.critMs;
    const t0 = now - historyMs;

    // --- y scale: headroom above the higher of crit and observed max ---
    let observed = 0;
    for (const s of samples) if (s.v != null && s.v > observed) observed = s.v;
    let yMax = niceCeil(Math.max(crit, observed) * 1.08);
    if (yMax <= 0) yMax = 50;

    const xOf = (ts) => l + ((ts - t0) / historyMs) * plotW;
    const yOf = (val) => t + plotH - (val / yMax) * plotH;

    // --- grid + y axis labels ---
    const step = niceStep(yMax / 4);
    ctx.font = '11px ui-monospace, "Cascadia Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let v = 0; v <= yMax + 0.001; v += step) {
      const y = yOf(v);
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(l, y);
      ctx.lineTo(W - r, y);
      ctx.stroke();
      ctx.fillStyle = C.label;
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(v)), l - 8, y);
    }
    ctx.fillStyle = C.label;
    ctx.textAlign = 'left';
    ctx.fillText('ms', 4, t - 4);

    // --- threshold lines ---
    const drawThreshold = (val, color, label) => {
      if (val > yMax) return;
      const y = yOf(val);
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(l, y);
      ctx.lineTo(W - r, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.fillText(label, W - r - 4, y - 7);
    };
    drawThreshold(warn, C.warn, `warn ${warn}`);
    drawThreshold(crit, C.crit, `crit ${crit}`);

    // --- clip to plot area for the data line ---
    ctx.save();
    ctx.beginPath();
    ctx.rect(l, t, plotW, plotH);
    ctx.clip();

    const pts = samples.map((s) => ({
      x: xOf(s.t),
      y: s.v == null ? null : yOf(s.v),
      sev: severity(s.v, warn, crit, s.lost || s.v == null),
      lost: s.lost,
      v: s.v,
      t: s.t,
    }));

    // Subtle gradient area under the value line (behind the line, clipped).
    const valPts = pts.filter((p) => p.y != null);
    if (valPts.length > 1) {
      const grad = ctx.createLinearGradient(0, t, 0, t + plotH);
      grad.addColorStop(0, 'rgba(78,161,255,0.22)');
      grad.addColorStop(1, 'rgba(78,161,255,0.0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(valPts[0].x, t + plotH);
      for (const p of valPts) ctx.lineTo(p.x, p.y);
      ctx.lineTo(valPts[valPts.length - 1].x, t + plotH);
      ctx.closePath();
      ctx.fill();
    }

    // line segments, colored per point severity
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    let prev = null;
    for (const p of pts) {
      if (p.y != null && prev && prev.y != null) {
        ctx.strokeStyle = SEV_COLOR[p.sev];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      if (p.y != null) {
        prev = p;
      } else {
        prev = null; // break the line across a lost point
      }
    }

    // lost markers: a red × pinned near the top of the plot
    for (const p of pts) {
      if (p.lost || p.y == null) {
        const x = p.x;
        const y = t + 12;
        ctx.strokeStyle = C.lostMark;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 5, y - 5);
        ctx.lineTo(x + 5, y + 5);
        ctx.moveTo(x + 5, y - 5);
        ctx.lineTo(x - 5, y + 5);
        ctx.stroke();
      }
    }

    // final data dot + value label
    const last = [...pts].reverse().find((p) => p.y != null);
    if (last) {
      ctx.fillStyle = SEV_COLOR[last.sev];
      ctx.beginPath();
      ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      const label = Math.round(last.v) + ' ms';
      ctx.fillStyle = C.axis;
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.textAlign = last.x > W - 70 ? 'right' : 'left';
      ctx.fillText(label, last.x + (last.x > W - 70 ? -8 : 8), last.y - 2);
    }
    ctx.restore();

    // --- x axis time ticks (every ~5 divisions) ---
    ctx.fillStyle = C.label;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const ts = t0 + (historyMs / ticks) * i;
      const x = xOf(ts);
      const secAgo = Math.round((now - ts) / 1000);
      const label = i === ticks ? 'now' : secAgo >= 60 ? `-${Math.round(secAgo / 60)}m` : `-${secAgo}s`;
      ctx.fillText(label, x, H - b + 12);
    }
  }
}

// Exposed as browser globals (no bundler in the renderer).
window.LatencyGraph = LatencyGraph;
window.graphSEVColor = SEV_COLOR;
