'use strict';

/* global LatencyGraph, renderHops, AlertBanner, alertBeep, netpulse */

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  running: false,
  samples: [],
  cap: 60,
  hops: [],
  hopHistory: {},
  feedCount: 0,
};

let graph = null;
let banner = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  graph = new LatencyGraph($('graph'));
  banner = new AlertBanner($('alertBanner'));

  state.config = await netpulse.loadConfig();
  applyConfigToForm(state.config);
  $('version').textContent = 'v' + (await netpulse.version());
  computeCap();
  setRunningUI(false);
  renderHops($('hops'), { hops: state.hops, history: state.hopHistory, cfg: state.config });

  // One-time: draw the empty graph so the panel isn't blank.
  graph.setData(state.samples, state.config);

  wire();
  subscribe();
});

function wire() {
  $('startBtn').addEventListener('click', start);
  $('stopBtn').addEventListener('click', stop);
  $('settingsBtn').addEventListener('click', openSettings);
  $('applySettings').addEventListener('click', applySettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('pingNowBtn').addEventListener('click', pingNow);
  $('traceNowBtn').addEventListener('click', traceNow);
  $('exportPing').addEventListener('click', () => doExport('ping'));
  $('exportHops').addEventListener('click', () => doExport('hops'));
  $('revealLogs').addEventListener('click', revealLogs);

  // Speed test
  $('speedRun').addEventListener('click', runSpeedTest);
  $('speedStop').addEventListener('click', stopSpeedTest);
  // Reliability test
  $('rel30').addEventListener('click', () => startReliability(1800));
  $('rel60').addEventListener('click', () => startReliability(3600));
  $('relStop').addEventListener('click', stopReliability);

  // Re-draw the graph if the window resizes while idle.
  window.addEventListener('resize', () => graph && graph.setData(state.samples, state.config));
}

function subscribe() {
  netpulse.on('probe:sample', onSample);
  netpulse.on('probe:hop', onHop);
  netpulse.on('probe:hopStatus', onHopStatus);
  netpulse.on('probe:alert', onAlert);
  netpulse.on('probe:error', onError);
  netpulse.on('probe:status', onStatus);
  netpulse.on('probe:config', onConfig);
  // Speed test
  netpulse.on('speed:progress', onSpeedProgress);
  netpulse.on('speed:done', onSpeedDone);
  netpulse.on('speed:error', onSpeedError);
  // Reliability test
  netpulse.on('reliability:progress', onRelProgress);
  netpulse.on('reliability:done', onRelDone);
  netpulse.on('reliability:error', onRelError);
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------
async function start() {
  const cfg = readForm();
  const res = await netpulse.start(cfg);
  state.config = res.config;
  state.samples = [];
  state.hopHistory = {};
  clearFeed();
  setRunningUI(true);
  applyConfigToForm(state.config);
}

async function stop() {
  await netpulse.stop();
  setRunningUI(false);
}

function setRunningUI(running) {
  state.running = running;
  $('startBtn').classList.toggle('disabled', running);
  $('stopBtn').classList.toggle('disabled', !running);
  const pill = $('statusPill');
  pill.className = 'pill ' + (running ? 'live' : 'idle');
  pill.textContent = running ? 'Monitoring' : 'Idle';
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------
function onSample(evt) {
  state.samples.push(evt.sample);
  while (state.samples.length > state.cap) state.samples.shift();

  // Readouts
  const w = evt.window;
  $('ro-avg').textContent = w.avgMs != null ? w.avgMs + ' ms' : '—';
  $('ro-min').textContent = w.minMs != null ? w.minMs + ' ms' : '—';
  $('ro-max').textContent = w.maxMs != null ? w.maxMs + ' ms' : '—';
  $('ro-loss').textContent = w.lossPct != null ? w.lossPct + '%' : '—';
  $('ro-count').textContent = String(w.total || 0);
  colorReadoutLoss($('ro-loss'), w.lossPct);

  graph.setData(state.samples, state.config, evt.sample.t);
}

function onHop(evt) {
  state.hops = evt.hops;
  for (const hop of evt.hops) {
    const arr = (state.hopHistory[hop.index] = state.hopHistory[hop.index] || []);
    arr.push({ t: evt.t, v: hop.avgMs });
    if (arr.length > 120) arr.shift();
  }
  renderHops($('hops'), { hops: state.hops, history: state.hopHistory, cfg: state.config });
  $('hopsUpdated').textContent = 'updated ' + new Date(evt.t).toLocaleTimeString();
}

function onHopStatus(evt) {
  $('traceStatus').textContent = evt.busy ? 'tracing…' : '';
  $('traceNowBtn').classList.toggle('disabled', evt.busy);
}

function onAlert(evt) {
  const c = state.config;
  if (evt.severity === 'recovered') {
    banner.clear();
    addFeed('recovered', `${evt.kind} back to normal`);
    return;
  }
  const message = alertMessage(evt.kind, evt.severity, evt.value, evt.threshold);
  banner.show(evt);
  if (c.soundAlerts) alertBeep(evt.severity === 'critical' ? 'critical' : 'warning');
  addFeed(evt.severity, message);
}

function onError(evt) {
  // Transient errors (e.g. a spawn hiccup) — surface without stopping.
  const errEl = $('errorLine');
  if (errEl) errEl.textContent = evt.message || 'probe error';
}

function onStatus(evt) {
  setRunningUI(evt.running);
}

function onConfig(cfg) {
  state.config = cfg;
  computeCap();
  applyConfigToForm(cfg);
  graph.setData(state.samples, cfg);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function openSettings() {
  applyConfigToForm(state.config);
  $('settingsDrawer').hidden = false;
}
function closeSettings() {
  $('settingsDrawer').hidden = true;
}

function applyConfigToForm(cfg) {
  if (!cfg) return;
  setVal('f-pingInterval', cfg.pingIntervalMs);
  setVal('f-pingTimeout', cfg.pingTimeoutMs);
  setVal('f-traceInterval', cfg.traceIntervalS);
  setVal('f-traceMaxHops', cfg.traceMaxHops);
  setVal('f-warnMs', cfg.warnMs);
  setVal('f-critMs', cfg.critMs);
  setVal('f-lossPct', cfg.lossPct);
  setVal('f-historySeconds', cfg.historySeconds);
  $('f-resolveHosts').checked = !!cfg.resolveHosts;
  $('f-soundAlerts').checked = !!cfg.soundAlerts;
}

function setVal(id, v) {
  const el = $(id);
  if (el) el.value = v;
}

function readForm() {
  const num = (id, fallback) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  const base = state.config || {};
  return {
    ...base,
    target: $('target').value.trim() || base.target || '8.8.8.8',
    pingIntervalMs: num('f-pingInterval', base.pingIntervalMs ?? 1000),
    pingTimeoutMs: num('f-pingTimeout', base.pingTimeoutMs ?? 1000),
    traceIntervalS: num('f-traceInterval', base.traceIntervalS ?? 30),
    traceMaxHops: num('f-traceMaxHops', base.traceMaxHops ?? 20),
    resolveHosts: $('f-resolveHosts').checked,
    warnMs: num('f-warnMs', base.warnMs ?? 100),
    critMs: num('f-critMs', base.critMs ?? 250),
    lossPct: num('f-lossPct', base.lossPct ?? 25),
    soundAlerts: $('f-soundAlerts').checked,
    historySeconds: num('f-historySeconds', base.historySeconds ?? 120),
  };
}

async function applySettings() {
  const cfg = readForm();
  // If running, push a live update (this also persists + may rotate the log).
  const res = await netpulse.update(cfg);
  state.config = res.config;
  computeCap();
  closeSettings();
}

function computeCap() {
  const c = state.config;
  if (!c) return;
  const perSec = 1000 / (c.pingIntervalMs || 1000);
  const cap = Math.ceil((c.historySeconds || 120) * perSec) + 5;
  state.cap = Math.max(60, Math.min(4000, cap));
}

// ---------------------------------------------------------------------------
// One-off probes
// ---------------------------------------------------------------------------
async function pingNow() {
  const btn = $('pingNowBtn');
  btn.classList.add('disabled');
  const res = await netpulse.pingNow();
  btn.classList.remove('disabled');
  const el = $('pingNowResult');
  if (res.ok) {
    el.textContent = `${res.target} → ${res.timeMs} ms (TTL ${res.ttl || '?'})`;
    el.className = 'probe-result ok';
  } else if (res.lost) {
    el.textContent = `${res.target} → no reply (timeout)`;
    el.className = 'probe-result lost';
  } else {
    el.textContent = `${res.target} → error: ${res.error || 'unknown'}`;
    el.className = 'probe-result err';
  }
}

async function traceNow() {
  onHopStatus({ busy: true });
  const res = await netpulse.traceNow();
  onHopStatus({ busy: false });
  if (res && res.hops && res.hops.length) {
    const evt = { t: Date.now(), hops: res.hops };
    for (const hop of res.hops) {
      const arr = (state.hopHistory[hop.index] = state.hopHistory[hop.index] || []);
      arr.push({ t: evt.t, v: hop.avgMs });
      if (arr.length > 120) arr.shift();
    }
    state.hops = res.hops;
    renderHops($('hops'), { hops: state.hops, history: state.hopHistory, cfg: state.config });
  } else {
    $('errorLine').textContent = 'traceroute returned no hops';
  }
}

// ---------------------------------------------------------------------------
// Export / logs
// ---------------------------------------------------------------------------
async function doExport(kind) {
  const res = await netpulse.exportLog(kind);
  const target = kind === 'ping' ? $('exportPing') : $('exportHops');
  if (res.ok) {
    flash(target, 'Saved ✓');
  } else if (!res.canceled) {
    target.title = res.error || 'Could not export';
    flash(target, 'No log yet');
  }
}

function revealLogs() {
  netpulse.revealLogs();
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1500);
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------
function clearFeed() {
  const feed = $('alertFeed');
  feed.innerHTML = '';
  state.feedCount = 0;
}

function addFeed(severity, text) {
  const feed = $('alertFeed');
  const li = document.createElement('li');
  li.className = 'feed-item ' + severity;
  const when = new Date().toLocaleTimeString();
  li.innerHTML = `<span class="feed-time">${when}</span> <span class="feed-text"></span>`;
  li.querySelector('.feed-text').textContent = text;
  feed.prepend(li);
  while (feed.children.length > 60) feed.lastChild.remove();
  state.feedCount++;
}

function colorReadoutLoss(el, lossPct) {
  if (lossPct == null) return;
  el.classList.remove('warn', 'crit');
  if (lossPct >= 50) el.classList.add('crit');
  else if (lossPct >= (state.config ? state.config.lossPct : 25)) el.classList.add('warn');
}

// ---------------------------------------------------------------------------
// Speed test
// ---------------------------------------------------------------------------
let speedMax = 0;

function setSpeedNum(id, v) {
  $(id).textContent = v == null ? '—' : v;
}
function setBar(id, frac) {
  $(id).style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
}

async function runSpeedTest() {
  const run = $('speedRun');
  const stopb = $('speedStop');
  run.classList.add('disabled');
  stopb.classList.remove('disabled');
  speedMax = 0;
  setSpeedNum('spDl', null);
  setBar('spDlBar', 0);
  setSpeedNum('spUl', null);
  setBar('spUlBar', 0);
  $('spPing').textContent = '…';
  $('spJitter').textContent = '…';
  $('spNote').textContent = 'testing…';
  addFeed('info', 'Speed test started');
  await netpulse.speedStart();
}

function stopSpeedTest() {
  $('spNote').textContent = 'cancelling…';
  netpulse.speedStop();
}

function onSpeedProgress(p) {
  if (p.mbps != null) speedMax = Math.max(speedMax, p.mbps, 100);
  if (p.phase === 'download' && p.mbps != null) {
    setSpeedNum('spDl', p.mbps);
    setBar('spDlBar', p.mbps / speedMax);
    $('spNote').textContent = 'downloading…';
  } else if (p.phase === 'upload' && p.mbps != null) {
    setSpeedNum('spUl', p.mbps);
    setBar('spUlBar', p.mbps / speedMax);
    $('spNote').textContent = 'uploading…';
  }
}

function onSpeedDone(p) {
  const r = p.result;
  $('speedRun').classList.remove('disabled');
  $('speedStop').classList.add('disabled');
  const maxm = Math.max(r.downloadMbps || 0, r.uploadMbps || 0, 100);
  setSpeedNum('spDl', r.downloadMbps);
  setBar('spDlBar', (r.downloadMbps || 0) / maxm);
  setSpeedNum('spUl', r.uploadMbps);
  setBar('spUlBar', (r.uploadMbps || 0) / maxm);
  $('spPing').textContent = r.pingMs != null ? r.pingMs + ' ms' : '—';
  $('spJitter').textContent = r.jitterMs != null ? r.jitterMs + ' ms' : '—';

  let msg = `Speed ↓ ${r.downloadMbps ?? '—'} / ↑ ${r.uploadMbps ?? '—'} Mbps`;
  if (r.pingMs != null) msg += ` · ${r.pingMs} ms ping`;
  if (r.cancelled) {
    $('spNote').textContent = 'cancelled';
    return;
  }
  if (r.downloadError || r.uploadError) {
    $('spNote').textContent = (r.downloadError ? 'download failed' : 'upload failed') + ': ' + (r.downloadError || r.uploadError);
    addFeed('warning', msg + ' (partial)');
    return;
  }
  $('spNote').textContent = 'vs ' + r.server.replace('https://', '');
  addFeed('info', msg);
}

function onSpeedError(p) {
  $('spNote').textContent = 'error: ' + (p.message || '');
  $('speedRun').classList.remove('disabled');
  $('speedStop').classList.add('disabled');
}

// ---------------------------------------------------------------------------
// Reliability (soak) test
// ---------------------------------------------------------------------------
let relRunning = false;

function setRelButtons(running) {
  $('rel30').classList.toggle('disabled', running);
  $('rel60').classList.toggle('disabled', running);
  $('relStop').classList.toggle('disabled', !running);
}

async function startReliability(sec) {
  if (relRunning) return;
  const target = $('target').value.trim() || (state.config && state.config.target);
  const res = await netpulse.reliabilityStart({ durationSec: sec, target });
  if (!res || !res.ok) return;
  relRunning = true;
  setRelButtons(true);
  const label = sec === 1800 ? '30 min' : sec === 3600 ? '1 hour' : sec + ' s';
  $('relStatus').innerHTML =
    'Running <b>' + label + '</b> against <b>' + escHtml(target) + '</b> · pings every ' +
    ((state.config ? state.config.pingIntervalMs : 1000) / 1000) + ' s…';
  $('relBar').hidden = false;
  $('relBarFill').style.width = '0%';
  $('relReport').hidden = true;
  addFeed('info', 'Reliability test started (' + label + ', ' + escHtml(target) + ')');
}

function stopReliability() {
  addFeed('info', 'Reliability test stopping…');
  netpulse.reliabilityStop();
}

function onRelProgress(p) {
  const frac = Math.min(1, p.elapsedSec / p.durationSec);
  $('relBarFill').style.width = (frac * 100).toFixed(1) + '%';
  const mm = Math.floor(p.elapsedSec / 60);
  const ss = String(p.elapsedSec % 60).padStart(2, '0');
  $('relStatus').innerHTML =
    'Running… <b>' + mm + ':' + ss + '</b> · loss <b>' + (p.lossPct != null ? p.lossPct + '%' : '—') +
    '</b> · avg <b>' + (p.avgMs != null ? p.avgMs + ' ms' : '—') + '</b> · ' + p.total + ' pings';
}

function onRelDone(p) {
  relRunning = false;
  setRelButtons(false);
  renderRelReport(p.report, p.reportFile, p.partial);
  const lvl = p.report.packets.lossPct >= (state.config ? state.config.lossPct : 25) ? 'warning' : 'info';
  addFeed(
    lvl,
    'Reliability ' + (p.partial ? 'stopped early — ' : '') +
      'availability ' + (p.report.availabilityPct != null ? p.report.availabilityPct + '%' : '—') +
      ', loss ' + p.report.packets.lossPct + '%, ' + p.report.incidents.length + ' incident(s)'
  );
}

function onRelError(p) {
  relRunning = false;
  setRelButtons(false);
  $('relStatus').textContent = 'Reliability error: ' + (p.message || '');
}

function renderRelReport(r, files, partial) {
  const el = $('relReport');
  const availCls = r.availabilityPct == null ? '' : r.availabilityPct >= 99.9 ? 'good' : r.availabilityPct >= 99 ? 'warn' : 'bad';
  const cells = [
    ['Availability', r.availabilityPct != null ? r.availabilityPct + '%' : '—', availCls],
    ['Loss', r.packets.lossPct != null ? r.packets.lossPct + '%' : '—', r.packets.lossPct > 0 ? 'bad' : 'good'],
    ['Packets', r.packets.sent + ' (' + r.packets.received + ' ok)', ''],
    ['Avg', r.latency.avgMs != null ? r.latency.avgMs + ' ms' : '—', ''],
    ['P95', r.latency.p95Ms != null ? r.latency.p95Ms + ' ms' : '—', ''],
    ['Jitter', r.latency.jitterMs != null ? r.latency.jitterMs + ' ms' : '—', ''],
  ];
  let html = '<div class="rr-grid">';
  for (const [lbl, val, cl] of cells) {
    html += `<div class="rr-cell"><div class="rr-lbl">${lbl}</div><div class="rr-val ${cl}">${val}</div></div>`;
  }
  html += '</div>';
  let foot = 'Target <b>' + escHtml(r.target) + '</b> · ' + (partial ? 'partial · ' : '') + fmtDur(r.elapsedSec) +
    ' · <b>' + r.incidents.length + '</b> incident' + (r.incidents.length === 1 ? '' : 's');
  if (files && files.jsonFile) foot += ' · saved <b>' + files.jsonFile.split('\\').pop() + '</b>';
  html += `<div class="rr-foot">${foot}</div>`;
  el.innerHTML = html;
  el.hidden = false;
}

function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(h + 'h');
  if (m || h) parts.push(m + 'm');
  parts.push(s + 's');
  return parts.join(' ');
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
