'use strict';

// Traceroute hop table with a per-hop latency sparkline.
// `history` is { hopIndex: [{ t, v }] } kept by app.js; `hops` is the latest
// snapshot from tracert.

const HOP_COLOR = { ok: '#3fb950', warn: '#e3b341', crit: '#f85149', lost: '#5a6270' };

function hopSeverity(v, warn, crit, lost) {
  if (lost) return 'lost';
  if (v == null) return 'lost';
  if (v >= crit) return 'crit';
  if (v >= warn) return 'warn';
  return 'ok';
}

function statusChip(avgMs, warn, crit) {
  if (avgMs == null) return { cls: 'lost', text: 'no reply' };
  const sev = hopSeverity(avgMs, warn, crit, false);
  if (sev === 'ok') return { cls: 'ok', text: 'ok' };
  if (sev === 'warn') return { cls: 'warn', text: 'slow' };
  return { cls: 'crit', text: 'high' };
}

function drawSparkline(canvas, series, cfg) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 28;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const vals = series.map((s) => s.v).filter((v) => v != null);
  if (vals.length === 0) {
    ctx.strokeStyle = HOP_COLOR.lost;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    return;
  }
  const yMax = Math.max(cfg.critMs, ...vals, 10) * 1.1;
  const n = series.length;
  const step = n > 1 ? w / (n - 1) : 0;
  ctx.strokeStyle = HOP_COLOR[hopSeverity(vals[vals.length - 1], cfg.warnMs, cfg.critMs, false)];
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  series.forEach((s, i) => {
    if (s.v == null) {
      started = false;
      return;
    }
    const x = i * step;
    const y = h - (s.v / yMax) * (h - 4) - 2;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/**
 * Render the hop table into `container`. Rebuilds each refresh (tracert runs
 * every ~30s, so the cost is negligible) and redraws each sparkline from the
 * accumulated `history`.
 */
function renderHops(container, { hops, history, cfg }) {
  container.innerHTML = '';
  if (!hops || hops.length === 0) {
    container.innerHTML =
      '<div class="hops-empty">No hops yet. Start monitoring, or run a traceroute.</div>';
    return;
  }

  const table = document.createElement('div');
  table.className = 'hop-table';

  const head = document.createElement('div');
  head.className = 'hop-row head';
  head.innerHTML =
    '<span class="c-idx">#</span><span class="c-host">Host</span><span class="c-lat">Latency</span><span class="c-spark">Trend</span><span class="c-status">Status</span>';
  table.appendChild(head);

  for (const hop of hops) {
    const row = document.createElement('div');
    row.className = 'hop-row';

    const avg = hop.avgMs;
    const chip = statusChip(avg, cfg.warnMs, cfg.critMs);
    const lat = avg == null ? '—' : avg + ' ms';
    const series = (history[hop.index] || []).slice(-40);

    row.innerHTML =
      `<span class="c-idx">${hop.index}</span>` +
      `<span class="c-host" title="${escapeHtml(hop.host)}">${escapeHtml(hop.host)}</span>` +
      `<span class="c-lat mono">${lat}</span>` +
      '<span class="c-spark"><canvas class="spark" width="120" height="28"></canvas></span>' +
      `<span class="c-status"><span class="chip ${chip.cls}">${chip.text}</span></span>`;

    table.appendChild(row);
    const canvas = row.querySelector('.spark');
    requestAnimationFrame(() => drawSparkline(canvas, series, cfg));
  }

  container.innerHTML = '';
  container.appendChild(table);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Exposed as a browser global (no bundler in the renderer).
window.renderHops = renderHops;
