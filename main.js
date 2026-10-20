'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { ConfigStore } = require('./config-store');
const { PingLog, HopLog } = require('./logger');
const Monitor = require('./probe/monitor');
const { runPing } = require('./probe/ping');
const { runTracert } = require('./probe/tracert');
const { SpeedTester } = require('./probe/speedtest');
const { ReliabilityTest } = require('./probe/reliability');

let win = null;
let config = null;
let monitor = null;
let pingLog = null;
let hopLog = null;
let speedTester = null;
let reliability = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) (win.isMinimized() ? win.restore() : win.focus());
  });

  app.whenReady().then(() => {
    config = new ConfigStore(app);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (monitor) monitor.stop();
  if (process.platform !== 'darwin') app.quit();
});

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'NetPulse',
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function buildMonitor() {
  return new Monitor({
    emit: send,
    logPing: (sample, window) => {
      if (pingLog) pingLog.write(sample, window);
    },
    logHop: (hops) => {
      if (hopLog) hopLog.write(hops);
    },
  });
}

function rotateLogsIfNeeded(target) {
  const changed = !pingLog || pingLog.target !== target;
  const dir = config.logsDir();
  if (changed) {
    pingLog = new PingLog(dir, target);
    hopLog = new HopLog(dir, target);
  }
  return pingLog.path();
}

function buildAux() {
  if (!speedTester) {
    speedTester = new SpeedTester({ emit: send });
    reliability = new ReliabilityTest({
      emit: (channel, payload) => {
        if (channel === 'reliability:done') {
          const files = writeReliabilityReport(payload.report, payload.results);
          payload = { ...payload, reportFile: files };
        }
        send(channel, payload);
      },
    });
  }
  return { speedTester, reliability };
}

function writeReliabilityReport(report, results) {
  try {
    const dir = config.logsDir();
    const d = new Date(report.startISO);
    const p = (n) => String(n).padStart(2, '0');
    const base = `reliability-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${sanitizeName(report.target)}`;
    const jsonFile = path.join(dir, base + '.json');
    const csvFile = path.join(dir, base + '.csv');
    const slim = (results || []).map((r) => ({
      t: r.t,
      iso: new Date(r.t).toISOString(),
      ok: r.ok,
      latency_ms: r.timeMs,
      lost: r.lost,
    }));
    fs.writeFileSync(jsonFile, JSON.stringify({ report, samples: slim }, null, 2));
    let csv = 'timestamp_iso,t_ms,ok,latency_ms,lost\n';
    for (const r of slim) {
      csv += [r.iso, r.t, r.ok ? 1 : 0, r.latency_ms == null ? '' : r.latency_ms, r.lost ? 1 : 0].join(',') + '\n';
    }
    fs.writeFileSync(csvFile, csv);
    return { jsonFile, csvFile };
  } catch (err) {
    console.error('[reliability] report write failed', err);
    return null;
  }
}

function sanitizeName(s) {
  return String(s).replace(/[^\w.-]/g, '_').slice(0, 40);
}

// ---------------------------------------------------------------------------
// IPC: renderer -> main
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('monitor:start', (e, cfg) => {
    const full = config.save(cfg);
    const logFile = rotateLogsIfNeeded(full.target);
    if (!monitor) monitor = buildMonitor();
    monitor.start(full);
    return { ok: true, logFile, config: full };
  });

  ipcMain.handle('monitor:stop', () => {
    if (monitor) monitor.stop();
    return { ok: true };
  });

  ipcMain.handle('monitor:update', (e, cfg) => {
    const full = config.save(cfg);
    const logFile = rotateLogsIfNeeded(full.target);
    if (monitor) monitor.update(full);
    send('probe:config', full);
    return { ok: true, config: full, logFile };
  });

  ipcMain.handle('config:load', () => config.load());

  ipcMain.handle('config:save', (e, cfg) => config.save(cfg));

  ipcMain.handle('probe:pingNow', async () => {
    const cfg = config.load();
    return runPing(cfg.target, { count: 1, timeoutMs: cfg.pingTimeoutMs });
  });

  ipcMain.handle('probe:traceNow', async () => {
    const cfg = config.load();
    const res = await runTracert(cfg.target, {
      maxHops: cfg.traceMaxHops,
      timeoutMs: 1000,
      resolveHost: cfg.resolveHosts,
    });
    if (hopLog) hopLog.write(res);
    return res;
  });

  ipcMain.handle('log:export', async (e, kind) => {
    const log = kind === 'hops' ? hopLog : pingLog;
    if (!log) return { ok: false, error: 'No active log yet. Start monitoring first.' };
    const isHop = kind === 'hops';
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.basename(log.path()),
      filters: isHop
        ? [{ name: 'Text Log', extensions: ['log', 'txt'] }]
        : [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    log.copyTo(filePath);
    return { ok: true, filePath };
  });

  ipcMain.handle('log:reveal', () => {
    const dir = config.logsDir();
    shell.openPath(dir);
    return { ok: true, dir };
  });

  // --- Speed test ---
  ipcMain.handle('speed:start', (e) => {
    const { speedTester } = buildAux();
    const c = config.load();
    speedTester.run({
      server: c.speedServer,
      downSeconds: c.speedTestSeconds,
      uploadBytes: c.speedUploadMB * 1024 * 1024,
      pingCount: 8,
    });
    return { ok: true, running: speedTester.isRunning };
  });

  ipcMain.handle('speed:stop', () => {
    if (speedTester) speedTester.stop();
    return { ok: true };
  });

  ipcMain.handle('speed:last', () => (speedTester ? speedTester.lastResult : null));

  // --- Reliability test ---
  ipcMain.handle('reliability:start', (e, opts) => {
    const { reliability: rel } = buildAux();
    const c = config.load();
    let durationSec = Math.round(Number(opts && opts.durationSec) || 0);
    durationSec = Math.max(30, Math.min(86400, durationSec));
    const target = (opts && String(opts.target).trim()) || c.target;
    const res = rel.start({
      target,
      durationSec,
      pingIntervalMs: c.pingIntervalMs,
      pingTimeoutMs: c.pingTimeoutMs,
      critMs: c.critMs,
    });
    return res;
  });

  ipcMain.handle('reliability:stop', () => {
    if (reliability) reliability.stop();
    return { ok: true };
  });

  ipcMain.handle('reliability:running', () => (reliability ? reliability.isRunning : false));

  ipcMain.handle('app:version', () => app.getVersion());
}

app.on('ready', registerIpc);
