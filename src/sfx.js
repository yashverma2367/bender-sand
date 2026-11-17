// Sound effects, synthesized live with Web Audio (no audio files). Retro / chunky, to match the
// pixel art. The simulation only calls emit(name, x, size); main.js drains the queue each frame,
// plays it, and (when hosting) forwards the same events to guests inside snapshots.
// Held moves (charges, streams) are continuous loops driven by each player's channel state.
// Sounds are panned left/right by where they happen relative to the camera, and sounds far
// off-screen are dropped (the map is much bigger than the view).

const MAP_W = 1200;
let listenX = MAP_W / 2, listenW = MAP_W; // camera center / width (cells)
export function setListener(x, w) { listenX = x; listenW = w; }
const GLOBAL = new Set(['train', 'ultcine', 'ko', 'win', 'countdown', 'go']); // heard everywhere
let ctx = null, master = null, noiseBuf = null;
let bus = null, impactBus = null, shaper = null; // normal sounds / explosions (bypass ducking + compression)
let muted = false;
try { muted = localStorage.getItem('bs-mute') === '1'; } catch { /* private mode */ }

const queue = [];          // [name, x, size]
const lastAt = new Map();  // throttle key -> time (ms)

// ---------- emit (simulation side) ----------
// throttleMs: drop repeats of the same key within this window (streams hit many times a second).
export function emit(name, x = listenX, size = 1, key = null, throttleMs = 0) {
  if (key) {
    const now = performance.now();
    if (now - (lastAt.get(key) || 0) < throttleMs) return;
    lastAt.set(key, now);
  }
  if (queue.length < 64) queue.push([name, Math.round(x), Math.round(size * 10) / 10]);
}
export function drain() { return queue.splice(0, queue.length); }

// ---------- audio graph ----------
function init() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 6;
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.55;
  master.connect(ctx.destination);
  bus = ctx.createGain();            // everything except impacts: compressed, ducked by big booms
  bus.connect(comp).connect(master);
  impactBus = ctx.createGain();      // impacts: light limiting only, so the transient stays sharp
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -4; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.15;
  impactBus.gain.value = 1.1;
  impactBus.connect(lim).connect(master);
  // Soft-clip distortion: turns a deep kick into harmonics that laptop / phone speakers can play.
  shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 3.5) / Math.tanh(3.5); }
  shaper.curve = curve; shaper.oversample = '4x';
  shaper.connect(impactBus);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}
// Browsers only allow audio after a user gesture.
export function unlock() {
  if (!init()) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (!boomBufs) setTimeout(initBooms, 0); // build the explosion sounds now, not mid-fight
}
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'click']) window.addEventListener(ev, unlock, { passive: true });

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('bs-mute', m ? '1' : '0'); } catch { /* private mode */ }
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.55, ctx.currentTime, 0.02);
  if (m) stopAllLoops();
}

const panOf = (x) => Math.max(-0.85, Math.min(0.85, ((x - listenX) / (listenW / 2)) * 0.85));
let voices = 0;
const MAX_VOICES = 48;

function out(pan, dest = bus) {
  const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(dest); return p;
}
// Duck the normal sounds for a moment so a big impact stands out.
function duck(amount, time) {
  const t = ctx.currentTime;
  bus.gain.cancelScheduledValues(t);
  bus.gain.setValueAtTime(bus.gain.value, t);
  bus.gain.linearRampToValueAtTime(1 - amount, t + 0.01);
  bus.gain.linearRampToValueAtTime(1, t + time);
}
function envelope(g, t, a, d, vol) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
// One oscillator sweep f -> f2.
function tone(pan, { f, f2 = f, dur = 0.15, type = 'sine', vol = 0.3, at = 0, a = 0.004, curve = 'exp', dest }) {
  if (voices >= MAX_VOICES) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + dur);
  else o.frequency.linearRampToValueAtTime(f2, t + dur);
  envelope(g, t, a, dur, vol);
  o.connect(g).connect(out(pan, dest));
  voices++; o.onended = () => voices--;
  o.start(t); o.stop(t + a + dur + 0.05);
}
// Filtered noise burst, filter sweeping f -> f2.
function noise(pan, { dur = 0.2, ft = 'lowpass', f = 1000, f2 = f, q = 1, vol = 0.3, at = 0, a = 0.004, dest }) {
  if (voices >= MAX_VOICES) return;
  const t = ctx.currentTime + at;
  const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; s.loop = true;
  s.playbackRate.value = 0.8 + Math.random() * 0.4;
  fl.type = ft; fl.Q.value = q;
  fl.frequency.setValueAtTime(f, t); fl.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + a + dur);
  envelope(g, t, a, dur, vol);
  s.connect(fl).connect(g).connect(out(pan, dest));
  voices++; s.onended = () => voices--;
  s.start(t, Math.random()); s.stop(t + a + dur + 0.05);
}
const rnd = (a, b) => a + Math.random() * (b - a);

// ---------- explosions ----------
// Real explosion sounds are generated once (sample by sample) instead of built from a few
// oscillators: deep brown-noise rumble + a bright blast whose brightness collapses as it decays
// (that "boom from a distance" darkening), a second swell of roar, random debris crackle, and
// tanh saturation for grit. 3 sizes x 3 random variants, played at slightly random speeds.
const BOOM_SIZES = [
  { len: 0.9, decay: 0.6, swell: 0.3, crackle: 0.6 },  // small: short and sharp
  { len: 2.0, decay: 1.2, swell: 0.6, crackle: 0.9 },  // medium
  { len: 3.6, decay: 2.2, swell: 0.9, crackle: 1.3 },  // huge: long rolling roar
];
let boomBufs = null, reverb = null, reverbSend = null;

function makeExplosion(sr, { len, decay, swell, crackle }) {
  const n = Math.floor(len * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const out = buf.getChannelData(ch);
    let brown = 0, lp = 0, lp2 = 0, peak = 0;
    const swellAt = 0.08 + Math.random() * 0.1;
    for (let i = 0; i < n; i++) {
      const t = i / sr, w = Math.random() * 2 - 1;
      brown = (brown + 0.02 * w) / 1.02;                      // deep rumble
      const fc = 250 + 9000 * Math.exp(-t * 9 / decay);       // bright -> dark
      lp += (1 - Math.exp((-2 * Math.PI * fc) / sr)) * (w - lp);
      lp2 += (1 - Math.exp((-2 * Math.PI * 120) / sr)) * (brown * 3.5 - lp2);
      const attack = Math.min(1, t / 0.004);
      const fast = Math.exp((-t * 6) / decay), slow = Math.exp((-t * 1.8) / decay);
      const bump = 1 + swell * Math.exp(-((t - swellAt) ** 2) / 0.004); // second swell of roar
      let v = (lp * 1.1 * fast + brown * 3.2 * (0.7 * fast + 0.6 * slow) + lp2 * 0.8 * slow) * bump * attack;
      if (Math.random() < 0.012 * crackle * Math.exp((-t * 2.5) / decay)) v += (Math.random() * 2 - 1) * 1.4 * slow; // debris
      out[i] = Math.tanh(v * 2.4);
      peak = Math.max(peak, Math.abs(out[i]));
    }
    for (let i = 0; i < n; i++) out[i] *= 0.95 / peak;
    for (let i = 0; i < 64; i++) out[n - 1 - i] *= i / 64; // no click at the end
  }
  return buf;
}

function initBooms() {
  if (boomBufs) return;
  const sr = ctx.sampleRate;
  boomBufs = BOOM_SIZES.map((sz) => [0, 1, 2].map(() => makeExplosion(sr, sz)));
  // Arena reverb: stereo decaying noise impulse.
  const L = Math.floor(sr * 2.2), ir = ctx.createBuffer(2, L, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < L; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / L, 3.2);
  }
  reverb = ctx.createConvolver(); reverb.buffer = ir;
  reverbSend = ctx.createGain(); reverbSend.gain.value = 0.45;
  reverbSend.connect(reverb).connect(impactBus);
}

// k = 0 (pop) .. 1 (huge).
function impact(p, k, { crack = 1, tail = 1 } = {}) {
  initBooms();
  if (voices >= MAX_VOICES) return;
  const size = k < 0.35 ? 0 : k < 0.7 ? 1 : 2;
  const s = ctx.createBufferSource();
  s.buffer = boomBufs[size][(Math.random() * 3) | 0];
  s.playbackRate.value = (1.15 - k * 0.3) * (0.93 + Math.random() * 0.14); // bigger = deeper
  const g = ctx.createGain(); g.gain.value = (0.55 + k * 0.55) * (tail ? 1 : 0.8);
  const pan = out(p, impactBus);
  s.connect(g).connect(pan);
  if (k > 0.3 && tail) { const send = ctx.createGain(); send.gain.value = k * tail; g.connect(send).connect(reverbSend); }
  voices++; s.onended = () => voices--;
  s.start();
  // Weight underneath + a snap on top.
  tone(p, { f: 150 - k * 40, f2: 35, dur: 0.15 + k * 0.25, vol: 0.25 + k * 0.25, dest: shaper });
  noise(p, { dur: 0.03, ft: 'highpass', f: 3000, vol: 0.25 * crack, dest: impactBus });
  if (k > 0.3) duck(0.35 + k * 0.4, 0.3 + k * 0.6);
}

// ---------- one-shot recipes ----------
// size: explosions = radius, hits = damage, otherwise 1.
const RECIPES = {
  // general
  boom: (p, s) => {
    const k = Math.min(1, Math.max(0, (s - 2) / 12)); // radius 2 -> pop, 14+ -> huge
    if (k < 0.12) { // tiny spray pops: a short burst, no tail
      noise(p, { dur: 0.15, f: 2500, f2: 150, vol: 0.22, dest: impactBus });
      tone(p, { f: 120, f2: 45, dur: 0.08, vol: 0.2, dest: shaper });
      return;
    }
    impact(p, k);
  },
  hit: (p, s) => {
    const k = Math.min(1, s / 15);
    tone(p, { f: 260, f2: 70, dur: 0.07 + k * 0.08, type: 'square', vol: 0.1 + k * 0.15 });
    noise(p, { dur: 0.05, ft: 'bandpass', f: 1800, q: 1.5, vol: 0.18 + k * 0.15 });
  },
  ko: (p) => {
    impact(p, 0.6, { tail: 0.7 });
    tone(p, { f: 700, f2: 50, dur: 0.6, type: 'sawtooth', vol: 0.2 });
  },
  jump: (p) => tone(p, { f: 220, f2: 420, dur: 0.07, type: 'triangle', vol: 0.07 }),
  jump2: (p) => { noise(p, { dur: 0.14, ft: 'bandpass', f: 600, f2: 2400, q: 1, vol: 0.12 }); tone(p, { f: 330, f2: 660, dur: 0.08, type: 'triangle', vol: 0.06 }); },
  land: (p, s) => noise(p, { dur: 0.06 + Math.min(0.1, s * 0.03), f: 500, f2: 80, vol: 0.06 + Math.min(0.12, s * 0.04) }),
  thunder: (p) => {
    noise(p, { dur: 0.15, ft: 'highpass', f: 3000, vol: 0.4 });
    noise(p, { dur: 1.8, f: 600, f2: 50, vol: 0.55, at: 0.05, a: 0.05 });
  },
  bullet: (p) => { noise(p, { dur: 0.08, ft: 'bandpass', f: 1800, f2: 900, q: 1.5, vol: 0.18 }); tone(p, { f: 500, f2: 900, dur: 0.05, vol: 0.06 }); },
  'water.special': (p) => { noise(p, { dur: 0.9, ft: 'lowpass', f: 300, f2: 1400, vol: 0.4, a: 0.15 }); noise(p, { dur: 0.6, ft: 'highpass', f: 2500, f2: 4000, vol: 0.12, at: 0.2 }); },
  wavewash: (p) => noise(p, { dur: 0.5, ft: 'bandpass', f: 600, f2: 300, q: 0.7, vol: 0.15 }),
  orbs: (p) => { tone(p, { f: 330, f2: 660, dur: 0.12, type: 'triangle', vol: 0.07 }); noise(p, { dur: 0.18, ft: 'bandpass', f: 900, f2: 2000, q: 1.2, vol: 0.12 }); },
  ultcine: () => { noise(0, { dur: 0.5, ft: 'bandpass', f: 300, f2: 4000, q: 0.7, vol: 0.35, a: 0.05 }); tone(0, { f: 110, f2: 55, dur: 0.6, type: 'sawtooth', vol: 0.12 }); tone(0, { f: 880, f2: 1760, dur: 0.25, type: 'square', vol: 0.05, at: 0.08 }); },
  clash: (p) => { noise(p, { dur: 0.12, ft: 'bandpass', f: 1800, f2: 600, q: 1, vol: 0.3 }); tone(p, { f: 300, f2: 120, dur: 0.1, type: 'square', vol: 0.08 }); },
  hiss: (p) => noise(p, { dur: 0.7, ft: 'highpass', f: 3000, f2: 1500, vol: 0.28, a: 0.02 }),
  sizzle: (p) => { noise(p, { dur: 0.5, ft: 'bandpass', f: 2500, f2: 800, q: 0.8, vol: 0.3 }); tone(p, { f: 90, f2: 50, dur: 0.3, vol: 0.2 }); },
  splat: (p) => { noise(p, { dur: 0.25, f: 600, f2: 120, vol: 0.35 }); tone(p, { f: 160, f2: 70, dur: 0.12, vol: 0.15 }); },
  freezeclash: (p) => { noise(p, { dur: 0.4, ft: 'highpass', f: 5000, f2: 2000, vol: 0.3 }); tone(p, { f: 1800, f2: 1200, dur: 0.3, type: 'triangle', vol: 0.07 }); },
  zap: (p) => { noise(p, { dur: 0.15, ft: 'highpass', f: 4000, vol: 0.35 }); for (let k = 0; k < 4; k++) tone(p, { f: 1500 + k * 400, f2: 200, dur: 0.05, type: 'square', vol: 0.07, at: k * 0.03 }); },
  whoosh: (p) => noise(p, { dur: 0.35, ft: 'bandpass', f: 400, f2: 2400, q: 0.8, vol: 0.3 }),
  fizzle: (p) => { tone(p, { f: 500, f2: 90, dur: 0.25, type: 'square', vol: 0.08 }); noise(p, { dur: 0.25, ft: 'highpass', f: 4000, f2: 1500, vol: 0.08 }); },

  // countdown / UI
  beep: () => tone(0, { f: 660, dur: 0.12, type: 'square', vol: 0.1 }),
  fight: () => { tone(0, { f: 880, dur: 0.35, type: 'square', vol: 0.12 }); tone(0, { f: 1320, dur: 0.35, type: 'square', vol: 0.06, at: 0.02 }); },
  game: () => { [523, 659, 784, 1046].forEach((f, k) => tone(0, { f, dur: 0.22, type: 'square', vol: 0.09, at: k * 0.11 })); },
  click: () => tone(0, { f: 1400, f2: 900, dur: 0.03, type: 'square', vol: 0.04 }),
  ultready: (p) => { tone(p, { f: 880, dur: 0.1, type: 'triangle', vol: 0.1 }); tone(p, { f: 1320, dur: 0.18, type: 'triangle', vol: 0.1, at: 0.08 }); },

  // ---- fire ----
  'fire.defense': (p) => { // lightning
    noise(p, { dur: 0.12, ft: 'highpass', f: 5000, f2: 2000, vol: 0.35 });
    for (let k = 0; k < 6; k++) tone(p, { f: rnd(900, 2400), f2: rnd(80, 300), dur: 0.05, type: 'square', vol: 0.08, at: k * 0.025 });
    noise(p, { dur: 1.1, f: 900, f2: 60, vol: 0.45, at: 0.06, a: 0.02 });
  },
  'fire.heavy.release': (p) => { noise(p, { dur: 0.25, ft: 'bandpass', f: 500, f2: 2500, q: 0.8, vol: 0.3 }); tone(p, { f: 160, f2: 60, dur: 0.2, type: 'sawtooth', vol: 0.12 }); },
  ram: (p) => { impact(p, 0.5, { crack: 0.4, tail: 0 }); noise(p, { dur: 0.5, ft: 'bandpass', f: 200, f2: 900, q: 0.6, vol: 0.35 }); },
  stomp: (p) => { // flame stomp: a heavy thud + a rushing roar along the ground
    impact(p, 0.45, { crack: 0.6, tail: 0 });
    noise(p, { dur: 0.6, ft: 'bandpass', f: 300, f2: 1200, q: 0.6, vol: 0.3, at: 0.04 });
  },
  'fire.special': (p) => { // flame wall roaring up
    noise(p, { dur: 0.8, ft: 'bandpass', f: 250, f2: 1400, q: 0.5, vol: 0.4, a: 0.05 });
    tone(p, { f: 70, f2: 110, dur: 0.6, type: 'sawtooth', vol: 0.1, a: 0.05 });
  },
  'fire.mobility': (p) => { noise(p, { dur: 0.35, ft: 'bandpass', f: 400, f2: 1800, q: 0.6, vol: 0.35 }); tone(p, { f: 90, f2: 50, dur: 0.3, type: 'sawtooth', vol: 0.1 }); },
  'fire.ultimate': (p) => { // power-up scream, the explosion comes from boom
    tone(p, { f: 60, f2: 700, dur: 1.6, type: 'sawtooth', vol: 0.16, a: 0.2, curve: 'lin' });
    tone(p, { f: 90, f2: 1050, dur: 1.6, type: 'square', vol: 0.06, a: 0.2, curve: 'lin' });
    noise(p, { dur: 1.7, ft: 'bandpass', f: 300, f2: 3000, q: 0.5, vol: 0.3, a: 0.3 });
  },

  train: () => { // subway horn: two-tone, then the rumble of the train
    for (const [f, at] of [[311, 0], [370, 0], [311, 0.55], [370, 0.55]]) tone(0, { f, f2: f * 0.98, dur: 0.45, type: 'sawtooth', vol: 0.08, at });
    noise(0, { dur: 2.6, f: 160, f2: 90, vol: 0.35, a: 0.8, at: 0.9 });
  },

  // ---- earth ----
  'earth.basic': (p) => { // earth grip: ground cracks, a stone hand grinds up
    impact(p, 0.25, { crack: 0.6, tail: 0 });
    noise(p, { dur: 0.3, ft: 'bandpass', f: 500, f2: 1400, q: 0.9, vol: 0.3 });
    tone(p, { f: 70, f2: 110, dur: 0.25, vol: 0.2 });
  },
  'earth.heavy.release': (p) => { noise(p, { dur: 0.3, ft: 'bandpass', f: 250, f2: 900, q: 0.8, vol: 0.3 }); tone(p, { f: 120, f2: 45, dur: 0.25, vol: 0.3 }); },
  'earth.special': (p) => { impact(p, 0.4, { crack: 0.5, tail: 0 }); noise(p, { dur: 0.35, f: 700, f2: 90, vol: 0.35 }); },
  'earth.defense': (p) => { // rock parry: a slab slams up
    impact(p, 0.2, { crack: 0.7, tail: 0 });
    tone(p, { f: 160, f2: 90, dur: 0.12, vol: 0.2 });
  },
  'earth.mobility': (p) => noise(p, { dur: 0.55, ft: 'bandpass', f: 1500, f2: 600, q: 0.5, vol: 0.25, a: 0.05 }),
  'earth.ultimate': (p) => {
    noise(p, { dur: 2.2, f: 200, f2: 40, vol: 0.7, a: 0.15 });
    tone(p, { f: 48, f2: 30, dur: 2, vol: 0.5, a: 0.2 });
    for (let k = 0; k < 6; k++) noise(p, { dur: 0.2, f: 1200, f2: 150, vol: 0.3, at: 0.2 + k * 0.22 });
  },

  // ---- water ----
  'water.heavy.release': (p) => { // ice spear
    tone(p, { f: 2400, f2: 1500, dur: 0.18, type: 'triangle', vol: 0.15 });
    tone(p, { f: 3600, f2: 2200, dur: 0.12, type: 'triangle', vol: 0.07 });
    noise(p, { dur: 0.2, ft: 'highpass', f: 2500, f2: 6000, vol: 0.18 });
  },
  'water.mobility': (p) => noise(p, { dur: 0.4, ft: 'bandpass', f: 1200, f2: 300, q: 0.9, vol: 0.35 }),
  'water.ultimate': (p) => {
    noise(p, { dur: 2.4, ft: 'bandpass', f: 200, f2: 1600, q: 0.4, vol: 0.55, a: 0.6 });
    noise(p, { dur: 0.8, ft: 'highpass', f: 5000, f2: 2000, vol: 0.3, at: 1.6 }); // freezes
  },

  // ---- air ----
  'air.basic': (p) => { noise(p, { dur: 0.18, ft: 'bandpass', f: 2500, f2: 700, q: 1.2, vol: 0.3 }); noise(p, { dur: 0.05, ft: 'highpass', f: 5000, vol: 0.15 }); }, // wind blade: a sharp swish
  'air.defense': (p) => noise(p, { dur: 0.28, ft: 'bandpass', f: 300, f2: 2600, q: 1.2, vol: 0.3, a: 0.2 }), // sonic boom wind-up (rising rush)
  'air.heavy.release': (p) => { impact(p, 0.35, { tail: 0 }); noise(p, { dur: 0.25, f: 1200, f2: 100, vol: 0.3 }); },
  'air.special': (p) => noise(p, { dur: 1.0, ft: 'bandpass', f: 400, f2: 1600, q: 2, vol: 0.35, a: 0.1 }),
  'air.defense.release': (p) => { // sonic boom
    impact(p, 0.8, { crack: 1.4, tail: 0.5 });
    noise(p, { dur: 0.06, ft: 'highpass', f: 2000, vol: 0.6 });
    tone(p, { f: 160, f2: 30, dur: 0.6, vol: 0.55 });
    noise(p, { dur: 0.9, f: 1500, f2: 60, vol: 0.45, at: 0.02 });
  },
  'air.mobility': (p) => noise(p, { dur: 0.16, ft: 'bandpass', f: 800, f2: 3500, q: 1, vol: 0.25 }),
  'air.ultimate': (p) => { // wind dragon roar
    tone(p, { f: 85, f2: 60, dur: 1.4, type: 'sawtooth', vol: 0.2, a: 0.15 });
    tone(p, { f: 128, f2: 90, dur: 1.4, type: 'sawtooth', vol: 0.1, a: 0.15 });
    noise(p, { dur: 1.8, ft: 'bandpass', f: 300, f2: 2200, q: 0.8, vol: 0.4, a: 0.3 });
  },
};

export const stats = { played: {}, missing: {} }; // debug counters
export function play(name, x = listenX, size = 1) {
  if (muted || !ctx || ctx.state !== 'running') return;
  if (!GLOBAL.has(name) && !name.startsWith('cine') && Math.abs(x - listenX) > listenW * 1.1) return; // far off-screen
  const r = RECIPES[name];
  if (r) { r(panOf(x), size); stats.played[name] = (stats.played[name] || 0) + 1; }
  else stats.missing[name] = (stats.missing[name] || 0) + 1;
}
export const activeLoops = () => [...loops.keys()];

// ---------- loops for held moves ----------
// spec: noise or oscillator source, filter / pitch moving with charge progress (0..1).
const LOOPS = {
  'fire.heavy': { osc: 'square', f: [80, 260], ft: 'lowpass', ff: [400, 1400], vol: 0.07 },
  'earth.heavy': { noise: true, ft: 'lowpass', ff: [160, 320], vol: 0.35, trem: 7 },
  'water.heavy': { osc: 'triangle', f: [500, 1300], vol: 0.06 },
  'water.defense': { noise: true, ft: 'bandpass', ff: [2600, 2600], q: 1, vol: 0.28, trem: 30 }, // erosion jet hiss
  'air.heavy': { noise: true, ft: 'bandpass', ff: [300, 1500], q: 2, vol: 0.25 },
  'fire.mobility': { noise: true, ft: 'bandpass', ff: [550, 550], q: 0.6, vol: 0.28, trem: 15 },
  'water.mobility': { noise: true, ft: 'bandpass', ff: [1900, 1900], q: 1.1, vol: 0.2 },
  'earth.mobility': { noise: true, ft: 'bandpass', ff: [1300, 1300], q: 0.5, vol: 0.18, trem: 9 },
  'air.mobility': { noise: true, ft: 'bandpass', ff: [700, 700], q: 1.4, vol: 0.22, trem: 4 },
  'air.defense': { osc: 'triangle', f: [180, 1200], ft: 'lowpass', ff: [800, 4000], vol: 0.07, trem: 11, noise2: true },
};
const loops = new Map(); // player key -> { key, nodes, gain, pan, ... }

function startLoop(spec) {
  const g = ctx.createGain(); g.gain.value = 0;
  const pan = ctx.createStereoPanner();
  let src, fl = null, osc = null;
  if (spec.noise) { src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true; }
  else { osc = src = ctx.createOscillator(); src.type = spec.osc; src.frequency.value = spec.f[0]; }
  let node = src;
  if (spec.ft) { fl = ctx.createBiquadFilter(); fl.type = spec.ft; fl.Q.value = spec.q || 1; fl.frequency.value = spec.ff[0]; node.connect(fl); node = fl; }
  const amp = ctx.createGain(); amp.gain.value = 1;
  node.connect(amp).connect(g).connect(pan).connect(bus);
  const srcs = [src];
  if (spec.trem) { // tremolo / flutter
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = spec.trem; depth.gain.value = 0.35;
    lfo.connect(depth).connect(amp.gain); srcs.push(lfo);
  }
  if (spec.noise2) { // breathy layer
    const n = ctx.createBufferSource(), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    n.buffer = noiseBuf; n.loop = true; nf.type = 'bandpass'; nf.frequency.value = 1500; ng.gain.value = 0.6;
    n.connect(nf).connect(ng).connect(g); srcs.push(n);
  }
  srcs.forEach((s) => s.start());
  g.gain.setTargetAtTime(spec.vol, ctx.currentTime, 0.03);
  return { spec, g, pan, osc, fl, srcs };
}
function stopLoop(l) {
  l.g.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
  const t = ctx.currentTime + 0.25;
  l.srcs.forEach((s) => { try { s.stop(t); } catch { /* stopped */ } });
}
function stopAllLoops() { for (const l of loops.values()) stopLoop(l); loops.clear(); }

// list: [{ id, key: 'fire.defense' | null, prog: 0..1, x }] for every player, every frame.
export function updateLoops(list) {
  if (muted || !ctx || ctx.state !== 'running') { if (loops.size && ctx) stopAllLoops(); return; }
  const seen = new Set();
  for (const e of list) {
    if (!e.key || !LOOPS[e.key]) continue;
    const id = `${e.id}:${e.key}`;
    seen.add(id);
    let l = loops.get(id);
    if (!l) { l = startLoop(LOOPS[e.key]); loops.set(id, l); }
    const s = l.spec, k = Math.max(0, Math.min(1, e.prog));
    const now = ctx.currentTime;
    l.pan.pan.setTargetAtTime(panOf(e.x), now, 0.05);
    if (l.osc) l.osc.frequency.setTargetAtTime(s.f[0] + (s.f[1] - s.f[0]) * k, now, 0.03);
    if (l.fl) l.fl.frequency.setTargetAtTime(s.ff[0] + (s.ff[1] - s.ff[0]) * k, now, 0.03);
  }
  for (const [id, l] of loops) if (!seen.has(id)) { stopLoop(l); loops.delete(id); }
}

// ---------- shared audio access (music.js) ----------
export function audioOut() { return ctx && ctx.state === 'running' && !muted ? { ctx, master, noiseBuf } : null; }

// ---------- map ambience ----------
const AMBIENT = {
  city: { noise: true, ft: 'lowpass', ff: [260, 260], vol: 0.12, trem: 0.18 }, // distant traffic hum
};
let ambId = null, amb = null;
// Call every frame with the current map id (or null): starts / swaps / stops the ambient loop.
export const ambientId = () => ambId; // (debug / tests)
export function ambient(id) {
  if (muted || !ctx || ctx.state !== 'running') id = null;
  if (id === ambId) return;
  if (amb) { stopLoop(amb); amb = null; }
  ambId = id;
  if (id && AMBIENT[id]) amb = startLoop(AMBIENT[id]);
}
