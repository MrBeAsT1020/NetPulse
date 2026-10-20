'use strict';

// Live demo of the exact engine the GUI uses, against a real target.
// Run: node test/demo.js [target]
//   Phase 1: normal thresholds -> steady-state stats + latency sparkline + traceroute hops
//   Phase 2: low thresholds    -> shows the alert + severity-color path actually firing

const { runPing } = require('../probe/ping');
const { runTracert } = require('../probe/tracert');
const Monitor = require('../probe/monitor');

const target = process.argv[2] || '8.8.8.8';
const ms = (n) => `${n == null ? '—' : n + ' ms'}`;

// ANSI to mirror the UI state colors
const COL = { ok: '\x1b[32m', warn: '\x1b[33m', crit: '\x1b[31m', lost: '\x1b[90m', end: '\x1b[0m' };
function stateOf(v, warn, crit, lost) {
  if (lost) return 'lost';
  if (v == null) return 'lost';
  if (v >= crit) return 'crit';
  if (v >= warn) return 'warn';
  return 'ok';
}
const GLYPH = { ok: '.', warn: '+', crit: '!', lost: 'x' };
function colored(state, text) {
  return COL[state] + text + COL.end;
}

function baseCfg(over) {
  return {
    target,
    pingIntervalMs: 1000,
    pingTimeoutMs: 1000,
    traceIntervalS: 0,
    traceMaxHops: 15,
    resolveHosts: false,
    warnMs: 100,
    critMs: 250,
    lossPct: 25,
    soundAlerts: false,
    historySeconds: 60,
    ...over,
  };
}

async function runPhase(label, cfg, durationMs) {
  const samples = [];
  const alerts = [];
  const mon = new Monitor({
    emit: (ch, p) => {
      if (ch === 'probe:sample') samples.push(p);
      if (ch === 'probe:alert') alerts.push(p);
    },
    logPing: () => {},
    logHop: () => {},
  });
  mon.start(cfg);
  await new Promise((r) => setTimeout(r, durationMs));
  mon.stop();
  return { samples, alerts, mon };
}

function sparkline(samples, cfg) {
  const last = samples.slice(-40);
  const line = last
    .map(({ sample: s }) => {
      const st = stateOf(s.v, cfg.warnMs, cfg.critMs, s.lost);
      return colored(st, GLYPH[st]);
    })
    .join('');
  return line;
}

function printStats(samples, cfg) {
  const ws = samples.map((e) => e.window);
  const lastWin = ws[ws.length - 1] || {};
  const vals = samples.filter((e) => e.sample.v != null).map((e) => e.sample.v);
  const lostN = samples.filter((e) => e.sample.lost).length;
  console.log(`  samples=${samples.length}  lost=${lostN}  vals=[${vals.slice(0, 8).join(', ')}${vals.length > 8 ? ', …' : ''}]`);
  console.log(
    `  window avg/min/max=${ms(lastWin.avgMs)}/${ms(lastWin.minMs)}/${ms(lastWin.maxMs)}  loss=${lastWin.lossPct != null ? lastWin.lossPct + '%' : '—'}`
  );
  console.log('  sparkline (last 40): ' + sparkline(samples, cfg));
}

function printHops(trace, cfg) {
  if (!trace.hops || !trace.hops.length) {
    console.log('  traceroute: no hops returned');
    return;
  }
  console.log('  hop  latency        host');
  for (const h of trace.hops) {
    const st = stateOf(h.avgMs, cfg.warnMs, cfg.critMs, h.avgMs == null);
    const lat = h.avgMs == null ? '— (no reply)' : h.avgMs + ' ms';
    console.log(
      `  ${String(h.index).padStart(3)}  ${colored(st, lat.padEnd(14))} ${h.host}`
    );
  }
}

function printAlerts(alerts) {
  if (!alerts.length) {
    console.log('  alerts: none');
    return;
  }
  for (const a of alerts) {
    const tag = a.severity === 'recovered' ? 'recovered' : a.severity;
    const col = a.severity === 'critical' ? COL.crit : a.severity === 'warning' ? COL.warn : COL.ok;
    console.log(`  ${col}[${tag}]${COL.end} ${a.kind}=${a.value} (thr=${a.threshold})`);
  }
}

async function main() {
  // A quick single ping to prove reachability up front.
  const one = await runPing(target, { count: 1, timeoutMs: 2000 });
  console.log(`\n== NetPulse live probe: ${target} ==`);
  console.log(`single ping -> ${one.ok ? ms(one.timeMs) + ' (TTL ' + one.ttl + ')' : 'no reply'}`);

  // Phase 1: steady state.
  const p1 = baseCfg({ warnMs: 100, critMs: 250 });
  console.log('\n-- Phase 1: normal thresholds (warn 100 / crit 250) --');
  const s1 = await runPhase('steady', p1, 8000);
  printStats(s1.samples, p1);
  printAlerts(s1.alerts);
  const trace = await runTracert(target, { maxHops: p1.traceMaxHops, timeoutMs: 500, resolveHost: false });
  printHops(trace, p1);

  // Phase 2: force the alert + color path by lowering thresholds below 8.8.8.8's latency.
  const p2 = baseCfg({ warnMs: 60, critMs: 90 });
  console.log('\n-- Phase 2: low thresholds (warn 60 / crit 90) to exercise alerts --');
  const s2 = await runPhase('alert', p2, 5000);
  printStats(s2.samples, p2);
  printAlerts(s2.alerts);

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('demo failed:', e);
  process.exit(1);
});
