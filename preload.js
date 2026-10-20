'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Channels main -> renderer that we allow the UI to subscribe to.
const EVENT_CHANNELS = [
  'probe:sample',
  'probe:hop',
  'probe:hopStatus',
  'probe:alert',
  'probe:error',
  'probe:status',
  'probe:config',
  'speed:progress',
  'speed:done',
  'speed:error',
  'reliability:start',
  'reliability:progress',
  'reliability:done',
  'reliability:error',
];

const netpulse = {
  // Monitoring
  start: (cfg) => ipcRenderer.invoke('monitor:start', cfg),
  stop: () => ipcRenderer.invoke('monitor:stop'),
  update: (cfg) => ipcRenderer.invoke('monitor:update', cfg),

  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // One-off diagnostics
  pingNow: () => ipcRenderer.invoke('probe:pingNow'),
  traceNow: () => ipcRenderer.invoke('probe:traceNow'),

  // Speed test
  speedStart: () => ipcRenderer.invoke('speed:start'),
  speedStop: () => ipcRenderer.invoke('speed:stop'),
  speedLast: () => ipcRenderer.invoke('speed:last'),

  // Reliability (soak) test
  reliabilityStart: (opts) => ipcRenderer.invoke('reliability:start', opts),
  reliabilityStop: () => ipcRenderer.invoke('reliability:stop'),
  reliabilityRunning: () => ipcRenderer.invoke('reliability:running'),

  // Logs / export
  exportLog: (kind) => ipcRenderer.invoke('log:export', kind),
  revealLogs: () => ipcRenderer.invoke('log:reveal',),

  // App
  version: () => ipcRenderer.invoke('app:version'),

  // Subscribe to a main->renderer event channel. Returns an unsubscribe fn.
  on(channel, listener) {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error('Not an allowed event channel: ' + channel);
    const wrapped = (_e, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('netpulse', netpulse);
