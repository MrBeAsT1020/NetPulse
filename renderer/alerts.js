'use strict';

// Alert presentation: a top banner + an optional audible beep via Web Audio.
// The event feed is managed by app.js; this module only *shows* an alert.

let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  return audioCtx;
}

// A short two-note beep; critical is louder/higher and doubled.
function beep(severity) {
  const ac = ctx();
  if (!ac) return;
  const now = ac.currentTime;
  const seq = severity === 'critical' ? [1568, 1568, 1880] : [1047, 1319];
  const dur = 0.12;
  seq.forEach((freq, i) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    const start = now + i * (dur + 0.03);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  });
}

class AlertBanner {
  constructor(el) {
    this.el = el;
  }

  show({ kind, severity, value, threshold, message }) {
    if (!this.el) return;
    if (severity === 'recovered') {
      this.el.hidden = true;
      return;
    }
    this.el.className = 'alert-banner ' + severity;
    this.el.querySelector('.alert-kind').textContent = kind === 'loss' ? 'Packet loss' : 'Latency';
    this.el.querySelector('.alert-msg').textContent = message || alertMessage(kind, severity, value, threshold);
    this.el.hidden = false;
    if (navigator.vibrate && severity === 'critical') navigator.vibrate([80, 40, 80]);
  }

  clear() {
    if (this.el) this.el.hidden = true;
  }
}

function alertMessage(kind, severity, value, threshold) {
  const s = severity === 'critical' ? 'Critical' : 'Warning';
  if (kind === 'loss') {
    return `${s}: packet loss ${value}% (threshold ${threshold}%)`;
  }
  return `${s}: latency ${value} ms at/over the ${threshold} ms threshold`;
}

// Exposed as browser globals (no bundler in the renderer).
window.AlertBanner = AlertBanner;
window.alertBeep = beep;
window.alertMessage = alertMessage;
