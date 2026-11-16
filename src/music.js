// Procedural music: a tiny step sequencer on Web Audio, no audio files.
//   fight - 132 BPM, A minor (Am F C G): kick / snare / hats, driving bass, arpeggio lead, pad
//   menu  - 84 BPM, same chords: soft pad + slow arpeggio, no drums
// Patterns vary every few bars and the drums fill at the end of each 8-bar phrase.
import { audioOut } from './sfx.js';

let enabled = true;
try { enabled = localStorage.getItem('bs-music') !== '0'; } catch { /* private mode */ }
let track = null;          // wanted track: 'fight' | 'menu' | null
let bus = null, busCtx = null;
let next = 0, step = 0, playing = null, timer = null;

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// Chords as MIDI notes (root, third, fifth): Am, F, C, G
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const ARPS = [[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3], [2, 1, 0, 1]]; // index 3 = octave root

export const musicEnabled = () => enabled;
export function setMusic(on) {
  enabled = on;
  try { localStorage.setItem('bs-music', on ? '1' : '0'); } catch { /* private mode */ }
  if (!on) stopNow();
}
export function setTrack(name) { track = name; }

function stopNow() {
  if (bus && busCtx) { bus.gain.setTargetAtTime(0, busCtx.currentTime, 0.1); }
  bus = null; playing = null;
}

function out() {
  const a = audioOut();
  if (!a) return null;
  if (!bus || busCtx !== a.ctx) {
    busCtx = a.ctx;
    bus = a.ctx.createGain(); bus.gain.value = 0;
    bus.connect(a.master);
  }
  return a;
}

function note(a, t, f, dur, { type = 'square', vol = 0.1, cutoff = 2000, attack = 0.005 } = {}) {
  const o = a.ctx.createOscillator(), g = a.ctx.createGain(), fl = a.ctx.createBiquadFilter();
  o.type = type; o.frequency.value = f;
  fl.type = 'lowpass'; fl.frequency.value = cutoff;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(fl).connect(g).connect(bus);
  o.start(t); o.stop(t + dur + 0.05);
}
function hit(a, t, { f = 8000, ft = 'highpass', dur = 0.04, vol = 0.05 } = {}) {
  const s = a.ctx.createBufferSource(), fl = a.ctx.createBiquadFilter(), g = a.ctx.createGain();
  s.buffer = a.noiseBuf; fl.type = ft; fl.frequency.value = f;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(fl).connect(g).connect(bus);
  s.start(t, Math.random()); s.stop(t + dur + 0.02);
}
function kick(a, t, vol = 0.5) {
  const o = a.ctx.createOscillator(), g = a.ctx.createGain();
  o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g).connect(bus); o.start(t); o.stop(t + 0.25);
}

// One 16th-note step of the current track.
function playStep(a, t, s, name) {
  const bar = Math.floor(s / 16), pos = s % 16, chord = CHORDS[bar % 4], phrase = Math.floor(bar / 8);
  const arp = ARPS[(phrase + (bar % 8 >= 4 ? 1 : 0)) % ARPS.length];
  const fill = bar % 8 === 7 && pos >= 12;
  if (name === 'fight') {
    const spb = 60 / 132 / 4;
    if (pos % 8 === 0 || pos === 10) kick(a, t, pos === 10 ? 0.35 : 0.5);
    if (pos === 4 || pos === 12 || (fill && pos % 2 === 1)) hit(a, t, { f: 1800, ft: 'bandpass', dur: 0.12, vol: fill ? 0.14 : 0.18 });
    if (pos % 2 === 0) hit(a, t, { vol: pos % 4 === 2 ? 0.05 : 0.03 });
    if (pos % 2 === 0) note(a, t, midi(chord[0] - 12), spb * 1.6, { type: 'sawtooth', vol: 0.09, cutoff: 500 + (pos % 4) * 150 });
    if (bar % 2 === 1 || phrase % 2 === 1) { // lead arpeggio on alternate bars
      const k = arp[pos % 4], n = k === 3 ? chord[0] + 12 : chord[k];
      note(a, t, midi(n + 12), spb * 0.9, { type: 'square', vol: 0.035, cutoff: 3000 });
    }
    if (pos === 0) for (const n of chord) note(a, t, midi(n), spb * 15, { type: 'sawtooth', vol: 0.018, cutoff: 900, attack: 0.08 });
  } else {
    const spb = 60 / 84 / 4;
    if (pos === 0) for (const n of chord) note(a, t, midi(n), spb * 16, { type: 'triangle', vol: 0.05, cutoff: 1200, attack: 0.4 });
    if (pos % 4 === 0) {
      const k = arp[(pos / 4) % 4], n = k === 3 ? chord[0] + 12 : chord[k];
      note(a, t, midi(n + 12), spb * 3, { type: 'triangle', vol: 0.04, cutoff: 2500, attack: 0.02 });
    }
    if (pos === 0 && bar % 2 === 0) kick(a, t, 0.12);
  }
}

// Scheduler: queue notes ~150 ms ahead.
function tick() {
  const want = enabled ? track : null;
  if (!want) { if (playing) stopNow(); return; }
  const a = out();
  if (!a) return;
  if (playing !== want) { // (re)start: fade in from the top of a bar
    playing = want; step = 0; next = a.ctx.currentTime + 0.1;
    bus.gain.cancelScheduledValues(a.ctx.currentTime);
    bus.gain.setTargetAtTime(want === 'fight' ? 0.55 : 0.5, a.ctx.currentTime, 0.4);
  }
  const spb = 60 / (want === 'fight' ? 132 : 84) / 4;
  while (next < a.ctx.currentTime + 0.15) { playStep(a, next, step++, want); next += spb; }
}
if (typeof window !== 'undefined') timer = setInterval(tick, 40);
export const musicState = () => ({ playing, step }); // (debug / tests)
