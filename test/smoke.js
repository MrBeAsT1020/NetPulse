'use strict';

// Headless smoke test for the probe layer (no Electron, no display needed).
// Run: node test/smoke.js 8.8.8.8
// Verifies ping/tracert parsing and that the Monitor engine ticks + emits.

const assert = require('assert');
const { runPing, parsePing } = require('../probe/ping');
const { runTracert, parseTracert } = require('../probe/tracert');
const Monitor = require('../probe/monitor');

const target = process.argv[2] || '8.8.8.8';

async function main() {
  // --- ping parser against a canned sample ---
  const canned = `Pinging 8.8.8.8 with 32 bytes of data:\nReply from 8.8.8.8: bytes=32 time=68ms TTL=118\n\nPing statistics for 8.8.8.8:\n    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),\nApproximate round trip times in milli-seconds:\n    Minimum = 68ms, Maximum = 68ms, Average = 68ms\n`;
  const parsed = parsePing(canned, target);
  assert.ok(parsed.ok, 'canned ping should be ok');
  assert.strictEqual(parsed.timeMs, 68, 'canned ping timeMs');
  assert.strictEqual(parsed.ttl, 118, 'canned ping ttl');
  console.log('ok  canned ping parse ->', parsed);

  const lostCanned = `Pinging 1.2.3.4 with 32 bytes of data:\nRequest timed out.\n\nPing statistics:\n    Packets: Sent = 1, Received = 0, Lost = 1 (100% loss),\n`;
  const lp = parsePing(lostCanned, '1.2.3.4');
  assert.strictEqual(lp.lost, true, 'canned lost ping');
  console.log('ok  canned loss parse ->', { lost: lp.lost, ok: lp.ok });

  // --- live ping ---
  const live = await runPing(target, { count: 1, timeoutMs: 2000 });
  console.log('ok  live ping ->', live);
  assert.ok('ok' in live && 'lost' in live, 'live ping shape');

  // --- live tracert (few hops) ---
  const trace = await runTracert(target, { maxHops: 4, timeoutMs: 800, resolveHost: false });
  console.log('ok  live tracert hops =', trace.hops.length);
  assert.ok(Array.isArray(trace.hops), 'tracert hops is array');
  if (trace.hops.length) {
    assert.ok(trace.hops[0].index === 1, 'first hop index is 1');
  }

  // --- canned tracert parse ---
  const traceCanned = `Tracing route to 8.8.8.8 over a maximum of 5 hops\n\n  1    57 ms    68 ms    72 ms  104.28.0.0\n  2    55 ms    62 ms    69 ms  172.70.217.1\n  3    81 ms     *        *     162.158.226.88\nTrace complete.\n`;
  const tp = parseTracert(traceCanned, target);
  assert.strictEqual(tp.hops.length, 3, 'canned tracert hop count');
  assert.strictEqual(tp.hops[2].samples[0], 81, 'hop3 sample0');
  assert.strictEqual(tp.hops[2].samples[1], null, 'hop3 sample1 is *');
  console.log('ok  canned tracert parse ->', tp.hops.map((h) => `${h.index}:${h.avgMs}`));

  // --- Monitor engine: tick a few times and capture events ---
  const cfg = {
    target,
    pingIntervalMs: 300,
    pingTimeoutMs: 1000,
    traceIntervalS: 0,
    traceMaxHops: 4,
    resolveHosts: false,
    warnMs: 100,
    critMs: 250,
    lossPct: 25,
    soundAlerts: false,
    historySeconds: 60,
  };
  const events = [];
  const mon = new Monitor({
    emit: (ch, p) => events.push([ch, p]),
    logPing: () => {},
    logHop: () => {},
  });
  mon.start(cfg);
  await new Promise((r) => setTimeout(r, 1500));
  mon.stop();

  const samples = events.filter(([c]) => c === 'probe:sample').length;
  const statuses = events.filter(([c]) => c === 'probe:status');
  console.log(`ok  monitor ticks: samples=${samples} statusEvents=${statuses.length}`);
  assert.ok(samples >= 2, 'monitor should emit a few sample events');
  assert.ok(statuses.some(([, p]) => p.running === true), 'monitor emits running status');

  console.log('\nAll smoke checks passed ✔  (target=' + target + ')');
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
