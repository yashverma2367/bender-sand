// Cinematic physics, layered on top of the sand grid:
//   - structural collapse: a piece of building that loses its connection to the ground falls as
//     one rigid chunk, crushes what's under it and breaks apart into rubble, chunks and dust
//   - dust: a hanging dust cloud (a density field, 1 value per 4x4 cells) kicked up by impacts;
//     it drifts with the wind, rises a little, slowly settles, and is drawn over everything
//   - shockwaves: expanding pressure rings from big clashes / blasts that shove bodies outward and
//     blow loose stuff away
//   - splashes: heavy impacts into water throw a crown of real water up
//   - glass: shatters into flying shards
import { EL, KIND, Kind, IGNITE_T } from './elements.js';
import { BODY_W as BW, BODY_H as BH } from './sprite.js';
import { emit } from './sfx.js';
import { FIELD } from './grid.js';
import { hitstop } from './juice.js';
import { explode, crackCell } from './abilities.js';

let world = null;
const dirty = [];  // [x, y, r]: spots where solid cells were destroyed (checked for collapse)
const chunks = []; // falling building pieces
const rings = [];  // shockwaves
let mark = null;   // per-cell: id of the falling chunk occupying it (0 = none)
let stamp = null, stampN = 0; // collapse flood-fill visited marks
let chunkId = 0;

export function initPhysics(w) {
  world = w;
  allocPhysics();
}
function allocPhysics() { // per-cell / per-air-block arrays, sized to the current map
  const g = world.grid;
  if (mark && mark.length === g.w * g.h && g.dust && g.dust.length === g.fw * g.fh) return;
  g.dust = new Float32Array(g.fw * g.fh);
  mark = new Uint16Array(g.w * g.h);
  stamp = new Int32Array(g.w * g.h);
  span0 = new Uint16Array(g.w * g.h);
  propMark = new Uint8Array(g.w * g.h);
  const fn = g.fw * g.fh;
  o2 = new Float32Array(fn).fill(1); o2Tmp = new Float32Array(fn); fireN = new Uint16Array(fn); starved = new Uint16Array(fn); sky = new Uint8Array(fn);
}
export function resetPhysics() {
  if (world) allocPhysics();
  pendingBackdraft = null; vacuums.length = 0; dirty.length = 0; chunks.length = 0; rings.length = 0; bursts.length = 0; leaks.length = 0; pipeIdx = null; sags.length = 0;
  props.length = 0;
  if (world) { world.grid.dust.fill(0); mark.fill(0); o2.fill(1); starved.fill(0); propMark.fill(0); }
}

// Something solid was destroyed around (x, y): check that area for things left hanging.
export function noteDamage(x, y, r = 3) { if (dirty.length < 96) dirty.push([x, y, r]); }

// ---------- dust ----------
export function addDust(x, y, r, amount) {
  const g = world && world.grid; if (!g) return;
  const fx = x / FIELD, fy = y / FIELD, R = Math.max(1, r / FIELD);
  for (let j = Math.floor(fy - R); j <= fy + R; j++) for (let i = Math.floor(fx - R); i <= fx + R; i++) {
    if (i < 0 || j < 0 || i >= g.fw || j >= g.fh) continue;
    const d = Math.hypot(i + 0.5 - fx, j + 0.5 - fy) / R;
    if (d > 1) continue;
    const k = j * g.fw + i;
    g.dust[k] = Math.min(1.6, g.dust[k] + amount * (1 - d * 0.7));
  }
}
let dustTmp = null;
function stepDust(g) {
  const { fw, fh, dust, vx, vy } = g;
  if (!dustTmp || dustTmp.length !== dust.length) dustTmp = new Float32Array(dust.length);
  const out = dustTmp; out.fill(0);
  let any = false;
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) {
    const k = j * fw + i, d = dust[k];
    if (d < 0.0008) continue;
    any = true;
    const keep = d * 0.9955; // settles over a few seconds
    // drift: with the wind, a little upward, and spread to the neighbors
    const wx = vx[k] * 0.06, wy = vy[k] * 0.06 - 0.012; // (rises only a little: it billows out, not up)
    const tx = Math.max(0, Math.min(fw - 1, i + Math.sign(wx))), ty = Math.max(0, Math.min(fh - 1, j + Math.sign(wy)));
    const move = Math.min(0.5, Math.abs(wx) + Math.abs(wy));
    const spread = keep * 0.022;
    out[k] += keep * (1 - move) - spread * 4;
    out[ty * fw + tx] += keep * move;
    if (i > 0) out[k - 1] += spread; if (i < fw - 1) out[k + 1] += spread;
    if (j > 0) out[k - fw] += spread; if (j < fh - 1) out[k + fw] += spread;
  }
  if (any) dust.set(out);
}

// ---------- shockwaves ----------
export function shockwave(x, y, strength) {
  if (rings.length > 6) return;
  rings.push({ x, y, t: 0, R: Math.min(90, 20 + strength * 0.9), s: strength, hit: new Set() });
  addDust(x, y, 10, 0.4);
}
function stepRings(g, ps) {
  for (let n = rings.length - 1; n >= 0; n--) {
    const w = rings[n], T = 12;
    w.t++;
    const r = (w.R * w.t) / T, r0 = (w.R * (w.t - 1)) / T, fade = 1 - w.t / T;
    // (no drawn ring: the shockwave is felt, not drawn: it shoves bodies and blows loose stuff away)
    // shove the air, bodies and loose stuff it passes
    for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; g.addWind(w.x + Math.cos(a) * r, w.y + Math.sin(a) * r, 6, Math.cos(a) * w.s * 0.05 * fade, Math.sin(a) * w.s * 0.05 * fade); }
    for (const p of world.players || []) {
      if (p.dead || w.hit.has(p.id)) continue;
      const dx = p.x + BW / 2 - w.x, dy = p.y + BH / 2 - w.y, d = Math.hypot(dx, dy) || 1;
      if (d > r + 3 || d < r0 - 8) continue;
      w.hit.add(p.id);
      const k = Math.min(3.2, w.s * 0.045) * (0.4 + 0.6 * fade) * (p.knockMul ? p.knockMul() : 1);
      p.vx += (dx / d) * k; p.vy += (dy / d) * k - k * 0.4;
    }
    let lifted = 0;
    for (let k = 0; k < 24 && lifted < 10; k++) {
      const a = Math.random() * Math.PI * 2, X = Math.floor(w.x + Math.cos(a) * r), Y = Math.floor(w.y + Math.sin(a) * r);
      if (!g.inBounds(X, Y)) continue;
      const t = g.type[Y * g.w + X], kind = KIND[t];
      if (kind === Kind.POWDER || kind === Kind.LIQUID || t === EL.FIRE) { ps.lift(X, Y, Math.cos(a) * 2.5 * fade, Math.sin(a) * 2.5 * fade - 1, { bounces: 1, dmg: 0 }); lifted++; }
    }
    if (w.t >= T) rings.splice(n, 1);
  }
}

// ---------- anime clash bursts ----------
// Every clash: a short hit-stop, then a white-hot clash sphere at the contact (each half rimmed in
// its side's color) with energy splashing off it in tapered tongues (each side's color); render.js
// drawBursts draws those as light. Two shots meeting hold it for a few ticks; beams / waves that
// keep touching keep it going (every new clash nearby refreshes it). Then it goes off as a real
// explosion (cells, debris, blast, shove) sized by the clash's power.
export const bursts = [];
const hexRGB = (h) => { const n = parseInt((h || '#ffffff').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const BURST_T = 40; // ticks a burst lasts after its release
let lastImpact = -999, burstClock = 0;
export function clashBurst(x, y, ax, ay, power, colA, colB, elA, elB) {
  const g = world.grid;
  // already struggling here? keep that one going instead of starting another
  for (const b of bursts) if (!b.remote && b.rel < 0 && Math.hypot(b.x - x, b.y - y) < 16) {
    b.act = b.t + 6; b.power = Math.max(b.power, power); b.s = Math.max(b.s, sizeOf(power)); b.x += (x - b.x) * 0.3; b.y += (y - b.y) * 0.3;
    return;
  }
  if (bursts.length > 10) bursts.shift();
  const l = Math.hypot(ax, ay) || 1;
  ax /= l; ay /= l;
  if (ax < 0) { ax = -ax; ay = -ay; [colA, colB] = [colB, colA]; [elA, elB] = [elB, elA]; } // left side = attack A
  let gy = -1; // the ground under it (rings and dust sit on it)
  for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(g.h, y + 40); yy++) { const t = g.type[yy * g.w + Math.floor(x)]; if (KIND[t] === Kind.STATIC || KIND[t] === Kind.POWDER) { gy = yy; break; } }
  const big = power >= 50, impact = big && burstClock - lastImpact > 70;
  if (impact) lastImpact = burstClock;
  const b = { x, y, ax, ay, s: sizeOf(power), power, t: 0, act: 4, rel: -1, seed: (Math.random() * 1e9) | 0, ca: hexRGB(colA), cb: hexRGB(colB), ea: elA, eb: elB, gy, big, impact, hit: new Set() };
  bursts.push(b);
  jets(b, 10); // the first gush on contact
  if (power >= 20) hitstop(power >= 80 ? 6 : power >= 40 ? 4 : 2); // the freeze (the impact frame shows during it)
  emit('clash', x, Math.min(3, power / 40));
  if (big && world.fx) world.fx.shake(Math.min(9, power / 12));
}
const sizeOf = (power) => Math.min(1.8, 0.4 + power / 55);
// Online guests: the host sends the active bursts in each snapshot.
export function burstState() { return bursts.map((b) => [Math.round(b.x), Math.round(b.y), +b.ax.toFixed(2), +b.ay.toFixed(2), +b.s.toFixed(2), b.t, b.seed, b.ca, b.cb, b.act, b.rel, b.gy, b.big ? 1 : 0, b.impact ? 1 : 0, b.ea, b.eb]); }
export function setBursts(list) {
  bursts.length = 0;
  for (const [x, y, ax, ay, s, t, seed, ca, cb, act, rel, gy, big, impact, ea, eb] of list || []) bursts.push({ x, y, ax, ay, s, t, seed, ca, cb, act, rel, gy, big: !!big, impact: !!impact, ea, eb, hit: new Set(), remote: true });
}
// > < : each attack's own material is forced back out of the contact in real particles, diagonally:
// A's up-left and down-left ( > ), B's up-right and down-right ( < ). Fire flies as real fire,
// water as water, earth as sand and rubble ... they fall and settle into the world like anything
// else. (Air / lightning / sonic have no material: theirs is drawn as light by render.js.)
export const JET_ANGLE = 0.33, JET_SPREAD = 0.42; // the > < : ~19 degrees off the clash line, fanning about +-12 degrees
const JET_CELL = { fire: [EL.FIRE], water: [EL.WATER], earth: [EL.SAND, EL.EARTH, EL.STONE], sand: [EL.SAND], ice: [EL.ICE, EL.WATER], lava: [EL.LAVA], plant: [EL.PLANT, EL.ASH] };
export const hasJetMaterial = (el) => !!JET_CELL[el];
function jets(b, perJet) {
  const ps = world.particles;
  let U = [-b.ay, b.ax]; if (U[1] > 0) U = [-U[0], -U[1]];
  for (const side of [-1, 1]) {
    const cells = JET_CELL[side < 0 ? b.ea : b.eb];
    if (!cells) continue;
    for (const up of [-1, 1]) for (let k = 0; k < perJet; k++) {
      const ang = JET_ANGLE + (Math.random() - 0.5) * JET_SPREAD, sp = (2.8 + Math.random() * 2.2) * (0.85 + 0.2 * b.s); // a narrow > that fans out
      const va = side * Math.cos(ang) * sp, vu = up * Math.sin(ang) * sp;
      const vx = b.ax * va + U[0] * vu, vy = b.ay * va + U[1] * vu, off = 0.6 + Math.random() * 1.2; // spread along the jet, not across it
      ps.spawn(b.x + vx * off, b.y + vy * off, vx, vy, cells[(Math.random() * cells.length) | 0], { bounces: 1, dmg: 0.1, drag: 0.985, gravity: 0.03 });
    }
  }
}
function stepBursts(g, ps) {
  burstClock++;
  for (let n = bursts.length - 1; n >= 0; n--) {
    const b = bursts[n];
    b.t++;
    if (b.remote) continue;
    if (b.rel < 0) { // struggling: the jets keep streaming
      jets(b, 3); // a dense stream that holds the > < shape
      if (b.t >= b.act) release(g, ps, b);
    } else if (b.t - b.rel >= BURST_T) bursts.splice(n, 1);
  }
}
// The release: the clash goes off as a real explosion (it digs, throws debris, shoves, burns if
// fire was in it), sized by the clash's power.
function release(g, ps, b) {
  b.rel = b.t;
  const r0 = Math.min(6, 1.5 + b.power / 28), fire = b.ca[0] > 200 && b.ca[1] < 160 || b.cb[0] > 200 && b.cb[1] < 160;
  explode(world, b.x, b.y, r0, fire ? EL.FIRE : 0, b.power >= 60, true, -1);
}

// ---------- splashes ----------
// A crown of real water thrown up from around (x, y), plus white foam.
export function splash(x, y, strength) {
  const g = world.grid, ps = world.particles, R = Math.min(10, 3 + strength * 0.4);
  let n = 0, max = Math.min(80, 10 + strength * 5);
  for (let k = 0; k < max * 3 && n < max; k++) {
    const X = Math.floor(x + (Math.random() - 0.5) * 2 * R), Y = Math.floor(y + (Math.random() - 0.5) * 2 * R);
    if (!g.inBounds(X, Y) || g.type[Y * g.w + X] !== EL.WATER) continue;
    const dx = X - x;
    if (ps.lift(X, Y, dx * 0.25 + (Math.random() - 0.5) * 1.2, -(1.5 + Math.random() * (1.5 + strength * 0.25)), { bounces: 0, dmg: 0 }) >= 0) n++;
  }
  if (!n) return;
  for (let k = 0; k < 10 + n / 2; k++) ps.spawn(x + (Math.random() - 0.5) * R * 2, y - 1, (Math.random() - 0.5) * 2.5, -1 - Math.random() * 3, EL.ICE, { ghost: true, gravity: 0.12, life: 12 }); // foam
  emit('splat', x, Math.min(3, strength / 4));
}
// How many water cells are within r of (x, y) (quick sample).
export function waterNear(x, y, r) {
  const g = world.grid; let n = 0;
  for (let k = 0; k < 24; k++) {
    const X = Math.floor(x + (Math.random() - 0.5) * 2 * r), Y = Math.floor(y + (Math.random() - 0.5) * 2 * r);
    if (g.inBounds(X, Y) && g.type[Y * g.w + X] === EL.WATER) n++;
  }
  return n;
}

// ---------- glass ----------
// Shatter glass around (x, y) within r: shards fly outward fast and fall (they can sting).
export function shatterGlass(x, y, r, force = 4) {
  const g = world.grid, ps = world.particles, R = Math.ceil(r);
  let n = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const d = Math.hypot(dx, dy);
    if (d > r) continue;
    const X = Math.floor(x) + dx, Y = Math.floor(y) + dy;
    if (!g.inBounds(X, Y) || g.type[Y * g.w + X] !== EL.GLASS) continue;
    const ux = d ? dx / d : Math.random() - 0.5, uy = d ? dy / d : -0.5, sp = force * (0.6 + Math.random() * 0.8);
    if (ps.lift(X, Y, ux * sp, uy * sp - 1, { bounces: 1, dmg: 0.3 }) >= 0) n++;
    else { g.type[Y * g.w + X] = 0; }
  }
  if (n) { emit('glass', x, Math.min(3, n / 15)); noteDamage(x, y, r); }
  return n;
}

// ---------- structural collapse ----------
const ANCHOR_ROWS = 4, MAX_CLUSTER = 7000;
const isStatic = (t) => KIND[t] === Kind.STATIC;
function checkCollapse(g) {
  if (!dirty.length) return;
  const spots = dirty.splice(0, dirty.length);
  for (const [x, y, r] of spots) findSags(g, x, y, r);
  stampN++;
  for (const [x, y, r] of spots) {
    const R = Math.ceil(r) + 2, x0 = Math.floor(x), y0 = Math.floor(y);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== R && Math.max(Math.abs(dx), Math.abs(dy)) !== R - 1) continue; // ring around the hole
      const X = x0 + dx, Y = y0 + dy;
      if (!g.inBounds(X, Y)) continue;
      const i = Y * g.w + X;
      if (!isStatic(g.type[i]) || stamp[i] === stampN || mark[i] || propMark[i]) continue;
      floodCluster(g, i);
    }
  }
}
// Flood-fill the solid piece containing cell i. Anchored if it reaches the bottom of the map or
// a map edge, rests on loose ground (sand / dirt piles hold things up), or is too big to be a
// "piece" (the street, the ground). Otherwise it starts to fall.
function floodCluster(g, i0) {
  const { w, h, type } = g, list = [i0];
  stamp[i0] = stampN;
  let anchored = false;
  for (let k = 0; k < list.length; k++) {
    const i = list[k], x = i % w, y = (i / w) | 0;
    if (y >= h - ANCHOR_ROWS || x === 0 || x === w - 1) { anchored = true; break; }
    if (y + 1 < h && KIND[type[i + w]] === Kind.POWDER) { anchored = true; break; }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const X = x + dx, Y = y + dy;
      if (X < 0 || X >= w || Y < 0 || Y >= h) continue;
      const j = Y * w + X;
      if (stamp[j] === stampN || !isStatic(type[j]) || mark[j] || propMark[j]) continue;
      stamp[j] = stampN; list.push(j);
    }
    if (list.length > MAX_CLUSTER) { anchored = true; break; }
  }
  if (anchored || list.length < 3) return;
  const id = ++chunkId & 0xffff || 1;
  const types = new Uint8Array(list.length);
  list.forEach((i, k) => { types[k] = type[i]; mark[i] = id; });
  let cx = 0; for (const i of list) cx += i % w;
  chunks.push({ id, cells: Int32Array.from(list), types, vy: 0, acc: 0, fell: 0, cx: cx / list.length, hit: new Set() });
  emit('collapse', cx / list.length, Math.min(3, list.length / 800));
}

function stepChunks(g, ps) {
  const { w, h, type } = g;
  for (let n = chunks.length - 1; n >= 0; n--) {
    const c = chunks[n];
    c.vy = Math.min(4, c.vy + 0.12);
    c.acc += c.vy;
    let landed = false;
    while (c.acc >= 1 && !landed) {
      c.acc -= 1;
      // can every cell move down one row? (into empty / gas / liquid / its own cells)
      for (const i of c.cells) {
        const j = i + w;
        if (j >= w * h) { landed = true; break; }
        const t = type[j];
        if (mark[j] === c.id) continue;
        if (t !== 0 && KIND[t] !== Kind.GAS && KIND[t] !== Kind.LIQUID) { landed = true; break; }
      }
      if (landed) break;
      // liquids underneath are pushed out (splash), then shift the chunk down one row
      for (const i of c.cells) { const j = i + w; if (mark[j] !== c.id && KIND[type[j]] === Kind.LIQUID) ps.lift(j % w, (j / w) | 0, (Math.random() - 0.5) * 3, -1.5 - Math.random() * 2, { bounces: 0, dmg: 0 }); }
      const cr = c.cells.map((i) => g.crack[i]);
      for (const i of c.cells) { type[i] = 0; mark[i] = 0; g.crack[i] = 0; }
      for (let k = 0; k < c.cells.length; k++) { const j = c.cells[k] + w; c.cells[k] = j; type[j] = c.types[k]; g.temp[j] = 20; mark[j] = c.id; g.crack[j] = cr[k]; }
      c.fell++;
      crush(g, c);
    }
    if (landed) { breakChunk(g, ps, c); chunks.splice(n, 1); }
  }
}
// Anyone under a falling chunk gets crushed (once per chunk) and shoved out.
function crush(g, c) {
  if (c.vy < 1.2) return;
  for (const p of world.players || []) {
    if (p.dead || c.hit.has(p.id)) continue;
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    let inside = false;
    for (let y = y0; y < y0 + BH && !inside; y += 2) for (let x = x0; x < x0 + BW && !inside; x++) if (g.inBounds(x, y) && mark[y * g.w + x] === c.id) inside = true;
    if (!inside) continue;
    c.hit.add(p.id);
    p.damage(Math.min(30, 8 + c.cells.length / 60), -1);
    p.vx += Math.sign(p.x + BW / 2 - c.cx || 1) * 2.5; p.vy = Math.max(p.vy, c.vy);
  }
}
// It hits the ground: glass bursts, a share of it flies off as debris, a share crumbles to rubble,
// the rest stays as broken chunks; dust everywhere, the ground shakes.
function breakChunk(g, ps, c) {
  const { w } = g, hard = c.fell >= 3;
  // The impact crushes the bottom of the piece; higher up it mostly holds together (and comes to
  // rest as a broken, slumped structure). Harder falls break more.
  let bottom = 0;
  for (const i of c.cells) bottom = Math.max(bottom, (i / w) | 0);
  const force = Math.min(1, c.fell / 25);
  let sx = 0, sy = 0;
  for (let k = 0; k < c.cells.length; k++) {
    const i = c.cells[k], x = i % w, y = (i / w) | 0, t = c.types[k];
    mark[i] = 0;
    sx += x; sy += y;
    if (!hard) continue;
    const near = Math.exp(-(bottom - y) / 14) * (0.4 + 0.6 * force); // 1 at the impact, fading upward
    const r = Math.random();
    if (t === EL.GLASS && r < 0.3 + near) { ps.lift(x, y, (Math.random() - 0.5) * 3.5, -1 - Math.random() * 3, { bounces: 1, dmg: 0.25 }); continue; }
    if (r < near * 0.18 && ps.n < ps.max - 200) { ps.lift(x, y, (Math.random() - 0.5) * 4, -1.5 - Math.random() * 3, { bounces: 1, dmg: 0.25 }); continue; } // debris thrown out
    if (r < near * 0.7 && t !== EL.STEEL) g.type[i] = t === EL.WOOD || t === EL.PLANT ? EL.ASH : EL.SAND; // crushed to rubble
  }
  if (!hard) return;
  const n = c.cells.length, mx = sx / n, my = sy / n;
  addDust(mx, my, Math.min(60, 10 + Math.sqrt(n) * 1.5), Math.min(1.2, 0.3 + n / 1500));
  if (world.fx) world.fx.shake(Math.min(12, 3 + n / 300));
  emit('boom', mx, Math.min(10, 4 + n / 300));
  noteDamage(mx, my, 6);
}

// ---------- weight: slabs that lose their support sag, then snap ----------
// Every floor / ceiling / bridge span is measured when the map loads (span0). When damage widens
// a span past what the material can carry (much longer than it was built, or longer than a fresh
// unsupported run of that material can hold), the middle of the slab bends down a cell at a
// time over ~2 s, cracking, then snaps; the collapse system drops whatever is left hanging.
let span0 = null;
const sags = [];
const FRESH_SPAN = { [EL.GLASS]: 8, [EL.WOOD]: 14, [EL.BRICK]: 12, [EL.CONCRETE]: 18, [EL.ASPHALT]: 16, [EL.STONE]: 24, [EL.STEEL]: 40, [EL.OBSIDIAN]: 40 };
const isSolid = (t) => KIND[t] === Kind.STATIC;
const holds = (t) => t !== 0 && KIND[t] !== Kind.GAS && KIND[t] !== Kind.LIQUID; // something you can rest on
function overhangRow(g, y, cb) { // every run of solid cells in row y with nothing under it
  const { w, type } = g;
  let x = 0;
  while (x < w) {
    const i = y * w + x;
    if (!(isSolid(type[i]) && !holds(type[i + w]))) { x++; continue; }
    let x1 = x;
    while (x1 < w && isSolid(type[y * w + x1]) && !holds(type[y * w + x1 + w])) x1++;
    // how is it held? a run ends either at a support (the wall it rests on) or in thin air
    const endL = x > 0 && isSolid(type[i - 1]), endR = x1 < w && isSolid(type[y * w + x1]);
    const held = (endL ? 1 : 0) + (endR ? 1 : 0);
    cb(x, x1, held === 2 ? x1 - x : held === 1 ? (x1 - x) * 2.5 : 0); // a cantilever carries far less
    x = x1;
  }
}
function scanSpans(g) {
  span0.fill(0);
  for (let y = 0; y < g.h - 1; y++) overhangRow(g, y, (x0, x1, eff) => { for (let x = x0; x < x1; x++) span0[y * g.w + x] = Math.min(65535, Math.round(eff)); });
}
function thickness(g, x, y) { let n = 0; for (let k = y * g.w + x; k >= 0 && isSolid(g.type[k]) && n < 14; k -= g.w) n++; return n; }
function findSags(g, x, y, r) {
  if (!span0 || sags.length > 6) return;
  const { w, h, type } = g, R = Math.ceil(r);
  for (let Y = Math.max(0, Math.floor(y) - R - 50); Y <= Math.min(h - 2, Math.floor(y) + R + 2); Y++) {
    overhangRow(g, Y, (x0, x1, span) => {
      if (x1 < x - R - 6 || x0 > x + R + 6) return; // not near the damage
      if (x1 - x0 < 6 || !span) return; // tiny, or held by nothing (the collapse system drops it)
      let orig = 0;
      for (let X = x0; X < x1; X++) orig = Math.max(orig, span0[Y * w + X]);
      const mid = (x0 + x1) >> 1, t = type[Y * w + mid], th = thickness(g, mid, Y);
      if (propMark[Y * w + mid]) return; // a car's underside isn't a floor
      const limit = Math.max(orig * 1.35 + 6, (FRESH_SPAN[t] || 16) + th * 2);
      if (span <= limit || mark[Y * w + mid] || sags.some((s) => s.y === Y && Math.abs(s.mid - mid) < 6)) return;
      const ths = new Uint8Array(x1 - x0);
      for (let X = x0; X < x1; X++) ths[X - x0] = thickness(g, X, Y);
      const endL = x0 > 0 && isSolid(type[Y * w + x0 - 1]), endR = x1 < w && isSolid(type[Y * w + x1]);
      // a beam bends most in the middle; a cantilever droops most at its free tip and snaps at the root
      const shape = endL && endR ? 0 : endL ? 1 : -1;
      sags.push({ x0, x1, y: Y, mid: shape === 0 ? mid : shape === 1 ? x0 + 2 : x1 - 3, shape, ths, dro: new Uint8Array(x1 - x0), level: 0, t: 0 });
      if (sags.length > 6) return;
    });
  }
}
function stepSags(g, ps) {
  const { w, h, type } = g;
  for (let n = sags.length - 1; n >= 0; n--) {
    const s = sags[n];
    if (++s.t % 10) continue;
    s.level++;
    const half = (s.x1 - s.x0) / 2, maxD = Math.min(6, 2 + Math.floor((s.x1 - s.x0) / 25));
    let moved = 0, alive = 0;
    for (let X = s.x0; X < s.x1; X++) {
      const k = X - s.x0, u = (X + 0.5 - s.x0 - half) / half;
      const bend = s.shape === 0 ? 1 - u * u : s.shape === 1 ? (u + 1) / 2 : (1 - u) / 2; // 0..1 along the span
      const want = Math.min(maxD, Math.round(s.level * 0.6 * bend));
      while (s.dro[k] < want) {
        const bot = s.y + s.dro[k], th = s.ths[k];
        if (!th || bot + 1 >= h || !isSolid(type[bot * w + X]) || mark[bot * w + X]) break;
        if (holds(type[(bot + 1) * w + X])) break; // came to rest on something
        for (let Y = bot; Y > bot - th && Y >= 0; Y--) { // shift the column down one cell
          const a = Y * w + X, b = a + w;
          type[b] = type[a]; g.shade[b] = g.shade[a]; g.crack[b] = Math.min(255, g.crack[a] + 4); g.temp[b] = g.temp[a];
        }
        const top = (bot - th + 1) * w + X;
        type[top] = 0; g.crack[top] = 0;
        s.dro[k]++; moved++;
      }
      if (s.ths[k] && isSolid(type[(s.y + s.dro[k]) * w + X])) alive++;
    }
    if (!alive) { sags.splice(n, 1); continue; }
    if (moved) emit('collapse', s.mid, 0.25);
    if (s.level >= 10 || (!moved && s.level > 3)) { // it gives: snap at the middle, through the slab
      const by = s.y + s.dro[s.mid - s.x0];
      for (let X = s.mid - 2; X <= s.mid + 2; X++) for (let Y = by; Y > by - 14 && Y >= 0; Y--) {
        const i = Y * w + X;
        if (!isSolid(type[i])) break;
        crackCell(g, ps, i, 255);
      }
      addDust(s.mid, by, 10, 0.4);
      noteDamage(s.mid, by, 4);
      noteDamage(s.x0 + 1, s.y, 3); noteDamage(s.x1 - 2, s.y, 3);
      sags.splice(n, 1);
    }
  }
}

// ---------- real heat ----------
// Fire keeps burning a building: every solid cell hotter than ~500 slowly gains cracks (and heat
// lowers how much it takes to break, see crackCell), so burning floors give way, steel beams
// soften and sag, and the sag system brings the rest down.
// Lava that sits still grows a thin black crust you can stand on: still hot (it burns), and
// brittle (it starts nearly cracked through, so any hit breaks it open again).
function stepHeat(g, ps) {
  const { w, h, type, temp, crack } = g;
  const off = pipeClock % 2; // half the rows each pass
  for (let y = 1 + off; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, t = type[i];
      if (!t) continue;
      if (t === EL.LAVA) {
        const up = type[i - w];
        if ((up === 0 || KIND[up] === Kind.GAS) && (type[i + w] === EL.LAVA || isSolid(type[i + w])) && Math.random() < 0.06) {
          type[i] = EL.OBSIDIAN; crack[i] = 200; g.shade[i] = 3; // crust (keeps the lava's heat)
        }
        continue;
      }
      const T = temp[i];
      if (T < 500 || !isSolid(t) || t === EL.OBSIDIAN) continue; // (crust and volcanic glass are made hot)
      if (crackCell(g, ps, i, Math.ceil((T - 500) / 100))) noteDamage(x, y, 2);
    }
  }
}

// ---------- oxygen and backdraft ----------
// Every air block holds oxygen (1 = fresh). Open sky and the map's sides are fresh air; oxygen
// spreads between open blocks, through doors, windows and holes, never through walls. Fire eats
// it: a fire in a sealed room chokes itself out into smoke (and people inside run out of air).
// A room that's been starved while hot, then suddenly gets fresh air (someone blasts a door or
// window open) goes off as a BACKDRAFT: the whole room re-ignites in one fireball out the hole.
let o2 = null, o2Tmp = null, fireN = null, starved = null, sky = null, lastBackdraft = -999;
export function o2At(x, y) {
  if (!o2) return 1;
  const g = world.grid, fx = Math.floor(x / FIELD), fy = Math.floor(y / FIELD);
  return fx < 0 || fy < 0 || fx >= g.fw || fy >= g.fh ? 1 : o2[fy * g.fw + fx];
}
function stepOxygen(g, ps) {
  const { w, h, fw, fh, type, solidF } = g;
  // where the open sky reaches (straight up to the top without hitting a solid block)
  if (pipeClock % 8 === 0) for (let fx = 0; fx < fw; fx++) { let open = 1; for (let fy = 0; fy < fh; fy++) { const i = fy * fw + fx; if (solidF[i]) open = 0; sky[i] = open; } }
  // count the fire in each block; starved fire dies into smoke
  fireN.fill(0);
  for (let y = 0; y < h; y++) {
    const fy = (y / FIELD) | 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, t = type[i];
      if (t !== EL.FIRE && !(g.life[i] && IGNITE_T[t] !== Infinity)) continue; // flames and burning wood
      const b = fy * fw + ((x / FIELD) | 0);
      fireN[b]++;
      const a = o2[b];
      if (t === EL.FIRE && a < 0.3 && Math.random() < (0.3 - a) * 1.6) g.transform(i, EL.SMOKE);
    }
  }
  // spread + burn
  let boom = -1, boomScore = 0;
  for (let fy = 0; fy < fh; fy++) for (let fx = 0; fx < fw; fx++) {
    const i = fy * fw + fx;
    let sum = 0, n = 0, fresh = 0;
    if (fx > 0 && !solidF[i - 1]) { sum += o2[i - 1]; n++; fresh = Math.max(fresh, o2[i - 1]); }
    if (fx < fw - 1 && !solidF[i + 1]) { sum += o2[i + 1]; n++; fresh = Math.max(fresh, o2[i + 1]); }
    if (fy > 0 && !solidF[i - fw]) { sum += o2[i - fw]; n++; fresh = Math.max(fresh, o2[i - fw]); }
    if (fy < fh - 1 && !solidF[i + fw]) { sum += o2[i + fw]; n++; fresh = Math.max(fresh, o2[i + fw]); }
    if (solidF[i]) { o2Tmp[i] = n ? sum / n : o2[i]; continue; } // solid: takes on the air around it (burnt-away wood doesn't release fresh air)
    if (sky[i] || fx === 0 || fx === fw - 1) { o2Tmp[i] = 1; starved[i] = 0; continue; }
    const prev = o2[i];
    let a = n ? prev + (sum / n - prev) * 0.35 : prev;
    a = Math.max(0, a - fireN[i] * 0.012);
    o2Tmp[i] = a;
    if (prev < 0.4 && a - prev > 0.03 && fresh > 0.6 && starved[i] > 40) { // fresh air rushes into a starved room
      const sc = a - prev;
      if (sc > boomScore) { boomScore = sc; boom = i; }
    }
    starved[i] = a < 0.4 ? Math.min(60000, starved[i] + 1) : 0;
  }
  [o2, o2Tmp] = [o2Tmp, o2];
  if (boom >= 0 && pipeClock - lastBackdraft > 30) backdraft(g, ps, boom);
}
function backdraft(g, ps, b0) {
  const { fw, solidF } = g, list = [b0], seen = new Set(list);
  let fuel = 0;
  for (let k = 0; k < list.length && list.length < 300; k++) { // the starved room
    const b = list[k];
    fuel += fireN[b] + g.heatF[b] * 8;
    for (const nb of [b - 1, b + 1, b - fw, b + fw]) {
      if (nb < 0 || nb >= o2.length || seen.has(nb) || solidF[nb] || starved[nb] < 20) continue;
      seen.add(nb); list.push(nb);
    }
  }
  if (fuel < 4) return; // a cold, dead room just breathes again
  lastBackdraft = pipeClock;
  const bx0 = (b0 % fw) * FIELD + 2, by0 = ((b0 / fw) | 0) * FIELD + 2;
  g.addPressure(bx0, by0, 6 + Math.sqrt(list.length) * FIELD, -5); // the room inhales through the hole...
  emit('collapse', bx0, 0.4);
  pendingBackdraft = { list, b0, t: 14 };                            // ...then goes off
}
let pendingBackdraft = null;
function stepBackdraft(g) {
  if (!pendingBackdraft || --pendingBackdraft.t > 0) return;
  const { list, b0 } = pendingBackdraft, { fw } = g;
  pendingBackdraft = null;
  let sx = 0, sy = 0;
  for (const b of list) {
    const X0 = (b % fw) * FIELD, Y0 = ((b / fw) | 0) * FIELD;
    sx += X0; sy += Y0;
    for (let y = Y0; y < Y0 + FIELD; y++) for (let x = X0; x < X0 + FIELD; x++) if (g.inBounds(x, y) && (g.type[y * g.w + x] === 0 || g.type[y * g.w + x] === EL.SMOKE) && Math.random() < 0.55) g.set(x, y, EL.FIRE);
    o2[b] = 0.7; starved[b] = 0;
  }
  const bx = (b0 % fw) * FIELD + 2, by = ((b0 / fw) | 0) * FIELD + 2;
  const size = Math.min(7, 3.5 + list.length / 25);
  explode(world, bx, by, size, EL.FIRE, true, true, -1);
  g.addPressure(sx / list.length, sy / list.length, 6 + Math.sqrt(list.length) * FIELD, 6);
  if (world.fx) world.fx.shake(10);
  hitstop(4);
}

// ---------- vacuum and implosion ----------
// A blast shoves the air out, and a moment later the low pressure it leaves behind pulls it all
// back in: smoke, dust, debris and people get sucked toward where the explosion was. Tornado cores
// are low pressure too (things drift into them).
const vacuums = [];
export function implode(x, y, r, amount, delay = 8) { if (vacuums.length < 24) vacuums.push({ x, y, r, amount, t: delay }); }
function stepVacuums(g) {
  for (let n = vacuums.length - 1; n >= 0; n--) {
    const v = vacuums[n];
    if (--v.t > 0) continue;
    vacuums.splice(n, 1);
    g.addPressure(v.x, v.y, v.r, -v.amount);
    for (const p of world.players || []) { // the pull back in
      if (p.dead) continue;
      const dx = v.x - (p.x + BW / 2), dy = v.y - (p.y + BH / 2), d = Math.hypot(dx, dy);
      if (d > v.r * 1.6 || d < 3) continue;
      const k = (1 - d / (v.r * 1.6)) * v.amount * 0.13;
      p.vx += (dx / d) * k; p.vy += (dy / d) * k * 0.6;
    }
  }
}

// ---------- city objects: cars, dumpsters, gas barrels ----------
// Loose things standing around the map. They're real cells (you stand on them, shots hit them),
// but they move as one rigid piece: blasts and big wind throw them, they tumble, slam into walls
// (cracking them) and into people (damage by speed). Gas barrels go up in a fireball when they
// take a hard hit.
let propMark = null, propId = 0;
export const props = [];
const PROP_ART = {
  car: { mat: { s: EL.STEEL, g: EL.GLASS, w: EL.OBSIDIAN, c: EL.CONCRETE }, rows: [
    '.....ssssssss.........',
    '....sggggsgggs........',
    '...sgggggsggggs.......',
    'sssssssssssssssssssss.',
    'sssssssssssssssssssssc',
    'ssssssssssssssssssssss',
    '.ssswwwssssssssswwwss.',
    '....www.........www...',
  ] },
  dumpster: { mat: { s: EL.STEEL }, rows: [
    'ssssssssssss',
    's..........s',
    's..........s',
    'ssssssssssss',
    'ssssssssssss',
    'ssssssssssss',
    '.s........s.',
  ] },
  barrel: { mat: { y: EL.GASPIPE }, rows: ['yyyyy', 'yyyyy', 'yyyyy', 'yyyyy', 'yyyyy', 'yyyyy', 'yyyyy'] },
  container: { mat: { s: EL.STEEL }, rows: Array.from({ length: 24 }, (_, y) => (y < 3 || y > 20 ? 's'.repeat(50) : 'sss' + Array.from({ length: 44 }, (_, x) => (x % 7 === 3 ? 's' : '.')).join('') + 'sss')) }, // steel box with ribbed sides
};
// Cars, dumpsters, barrels, containers: where the map's plan puts them (x, and y = the row to start
// looking down for ground), else on random flat ground. Placement is seeded, so online guests that
// build the same map get the same objects.
function spawnProps(g) {
  props.length = 0; propMark.fill(0); propId = 0;
  let seed = (g.w * 7919 + g.h * 104729) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const place = (kind, x0, ystart, flat) => {
    const art = PROP_ART[kind], pw = art.rows[0].length, ph = art.rows.length;
    if (x0 < 1 || x0 + pw >= g.w - 1) return false;
    let y = Math.max(0, ystart | 0); // the first row (from ystart down) where anything under the footprint is solid
    const solidRow = (yy) => { for (let x = x0; x < x0 + pw; x++) { const t = g.type[yy * g.w + x]; if (isStatic(t) || KIND[t] === Kind.POWDER) return true; } return false; };
    while (y < g.h - 2 && !solidRow(y)) y++;
    if (y >= g.h - 2 || y - ph < 0) return false;
    if (flat) for (let x = x0 - 2; x < x0 + pw + 2; x++) {
      if (x < 0 || x >= g.w || !isStatic(g.type[y * g.w + x]) || propMark[y * g.w + x]) return false;
      for (let yy = y - ph - 10; yy < y; yy++) if (yy >= 0 && g.type[yy * g.w + x] !== 0) return false;
    }
    for (let yy = y - ph; yy < y; yy++) for (let x = x0; x < x0 + pw; x++) { const t = g.type[yy * g.w + x]; if (t && KIND[t] !== Kind.GAS) return false; }
    const cells = [];
    art.rows.forEach((row, dy) => [...row].forEach((ch, dx) => { if (art.mat[ch]) cells.push({ dx, dy, t: art.mat[ch], sh: ch === 'c' ? 0 : (dx * 3 + dy) % 3 }); }));
    const p = { id: (++propId % 250) + 1, kind, cells, x: x0, y: y - ph, vx: 0, vy: 0, w: pw, h: ph, hitCd: {}, n0: cells.length };
    stampProp(g, p);
    props.push(p);
    return true;
  };
  if (g.propPlan) { for (const q of g.propPlan) place(q.kind, q.x, q.y || 0, false); return; }
  for (const kind of ['car', 'dumpster', 'barrel', 'barrel', 'car']) for (let tries = 0; tries < 80; tries++) if (place(kind, 20 + Math.floor(rnd() * (g.w - 60)), 0, true)) break;
}
function stampProp(g, p) {
  const X = Math.round(p.x), Y = Math.round(p.y);
  for (const c of p.cells) {
    const x = X + c.dx, y = Y + c.dy;
    if (!g.inBounds(x, y)) continue;
    const i = y * g.w + x;
    g.type[i] = c.t; g.shade[i] = c.sh; g.crack[i] = c.cr || 0; g.temp[i] = c.T || 20; propMark[i] = p.id;
  }
}
function liftProp(g, p) { // take its cells out of the grid (dropping any that were destroyed)
  const X = Math.round(p.x), Y = Math.round(p.y);
  p.cells = p.cells.filter((c) => {
    const x = X + c.dx, y = Y + c.dy;
    if (!g.inBounds(x, y)) return false;
    const i = y * g.w + x;
    if (propMark[i] !== p.id || g.type[i] !== c.t) { if (propMark[i] === p.id) propMark[i] = 0; return false; }
    c.cr = g.crack[i]; c.T = g.temp[i];
    g.type[i] = 0; g.crack[i] = 0; propMark[i] = 0;
    return true;
  });
}
function propFits(g, p, X, Y) {
  for (const c of p.cells) {
    const x = X + c.dx, y = Y + c.dy;
    if (x < 0 || x >= g.w || y >= g.h) return false;
    if (y < 0) continue;
    const t = g.type[y * g.w + x];
    if (t !== 0 && KIND[t] !== Kind.GAS && KIND[t] !== Kind.LIQUID) return false;
  }
  return true;
}
// A blast at (x, y): throw every object in reach away from it.
export function pushProps(x, y, r, force) {
  for (const p of props) {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2, dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy);
    if (d > r + Math.max(p.w, p.h) / 2) continue;
    const f = Math.min(1, d / (r + p.w / 2)), k = force * 1.3 * (1 - f * f) * Math.min(2.5, 90 / Math.max(20, p.cells.length)); // light things fly further
    p.vx += (d ? dx / d : 0) * k; p.vy += (d ? dy / d : -1) * k - k * 0.5;
    p.awake = true;
    if (p.kind === 'barrel' && force > 2.5) p.fuse = Math.max(p.fuse || 0, 1);
  }
}
function stepProps(g, ps) {
  for (let n = props.length - 1; n >= 0; n--) {
    const p = props[n];
    if (!p.cells.length || p.cells.length < p.n0 * 0.35) { // mostly destroyed: what's left is just loose wreckage
      if (p.kind === 'barrel' && !p.blown) { p.blown = true; explode(world, p.x + p.w / 2, p.y + p.h / 2, 6, EL.FIRE, true, true, -1); }
      props.splice(n, 1); continue;
    }
    if (p.kind === 'barrel' && (p.fuse || p.cells.length < p.n0)) { // ruptured: it goes up
      p.blown = true; liftProp(g, p); props.splice(n, 1);
      explode(world, p.x + p.w / 2, p.y + p.h / 2, 6.5, EL.FIRE, true, true, -1);
      for (let k = 0; k < 40; k++) { const X = Math.floor(p.x + Math.random() * 14 - 4), Y = Math.floor(p.y - Math.random() * 10); if (g.inBounds(X, Y) && g.type[Y * g.w + X] === 0) g.set(X, Y, EL.FIRE); }
      continue;
    }
    // wind: strong air (gusts, tornados, pressure waves) pushes on it
    const fx = Math.floor((p.x + p.w / 2) / FIELD), fy = Math.floor((p.y + p.h / 2) / FIELD);
    if (fx >= 0 && fy >= 0 && fx < g.fw && fy < g.fh) {
      const wx = g.vx[fy * g.fw + fx], wy = g.vy[fy * g.fw + fx], m = 30 / Math.max(30, p.cells.length);
      if (Math.abs(wx) > 2.5 || wy < -2.5) { p.vx += wx * 0.02 * m; p.vy += Math.min(0, wy) * 0.02 * m; p.awake = true; }
    }
    if (!p.awake) { // resting: does it still have ground under it?
      if (pipeClock % 10 !== p.id % 10) continue;
      liftProp(g, p);
      if (propFits(g, p, Math.round(p.x), Math.round(p.y) + 1)) p.awake = true;
      stampProp(g, p);
      if (!p.awake) continue;
    }
    liftProp(g, p);
    p.vy = Math.min(5, p.vy + 0.2);
    const sp = Math.hypot(p.vx, p.vy), steps = Math.max(1, Math.ceil(sp));
    let landed = false;
    for (let s = 0; s < steps; s++) {
      const nx = p.x + p.vx / steps, X = Math.round(nx), Y = Math.round(p.y);
      hitBodies(p);
      if (X !== Math.round(p.x) && !propFits(g, p, X, Y)) { // slams sideways into something
        if (propFits(g, p, X, Y - 1)) { p.y -= 1; p.x = nx; } // (rides up over a curb / bump)
        else if (propFits(g, p, X, Y - 2)) { p.y -= 2; p.x = nx; p.vx *= 0.9; }
        else { slam(g, ps, p, Math.sign(p.vx), 0, Math.abs(p.vx)); p.vx *= -0.25; break; }
      } else p.x = nx;
      const ny = p.y + p.vy / steps, Y2 = Math.round(ny);
      if (Y2 !== Math.round(p.y) && !propFits(g, p, Math.round(p.x), Y2)) {
        if (p.vy > 0) { landed = true; if (p.vy > 3) slam(g, ps, p, 0, 1, p.vy); p.vx *= p.vy > 2 ? 0.75 : 0.95; p.vy = p.vy > 3 ? -p.vy * 0.2 : 0; } // (hard landing / scraping along)
        else { if (p.vy < -3) slam(g, ps, p, 0, -1, -p.vy); p.vy = 0; }
        break;
      } else p.y = ny;
    }
    stampProp(g, p);
    if (landed && Math.abs(p.vx) < 0.15 && Math.abs(p.vy) < 0.3) { p.vx = 0; p.vy = 0; p.awake = false; }
  }
}
// It hits something hard: the thing it hit cracks, so does the object, dust, a bang.
function slam(g, ps, p, dx, dy, speed) {
  if (speed < 2.5) return;
  const X = Math.round(p.x), Y = Math.round(p.y), amt = Math.min(200, speed * 22);
  for (const c of p.cells) {
    const x = X + c.dx + dx, y = Y + c.dy + dy;
    if (!g.inBounds(x, y)) continue;
    const i = y * g.w + x;
    if (propMark[i] === p.id || !isStatic(g.type[i])) continue;
    if (crackCell(g, ps, i, amt)) noteDamage(x, y, 2);
    c.cr = Math.min(255, (c.cr || 0) + amt * 0.4);
  }
  if (p.kind === 'barrel' && speed > 4) p.fuse = 1;
  addDust(X + p.w / 2, Y + p.h / 2, 8, Math.min(0.6, speed * 0.08));
  emit('boom', X + p.w / 2, Math.min(5, speed * 0.8), 'smallboom', 60);
  if (world.fx) world.fx.shake(Math.min(6, speed));
}
function hitBodies(p) {
  const sp = Math.hypot(p.vx, p.vy);
  if (sp < 2.2) return;
  for (const pl of world.players || []) {
    if (pl.dead || (p.hitCd[pl.id] || 0) > pipeClock) continue;
    if (pl.x + BW < p.x - 1 || pl.x > p.x + p.w + 1 || pl.y + BH < p.y - 1 || pl.y > p.y + p.h + 1) continue;
    p.hitCd[pl.id] = pipeClock + 20;
    const mass = Math.min(1.5, p.cells.length / 80);
    pl.damage(Math.min(22, sp * (3 + mass * 4)), -1);
    pl.vx += p.vx * (0.5 + mass * 0.4); pl.vy += p.vy * 0.5 - 1.5;
    pl.lastHitAt = pl.constructor.clock;
    hitstop(3);
  }
}

// ---------- pipes and cables ----------
// Every gas line, water main and power cable cell is remembered when the map loads. When one is
// destroyed (blasts, waves, collapses, anything), it bursts where it broke:
//   gas   -> a roaring jet of flame out of the break for 5 s (burns, sets things alight)
//   water -> a geyser of real water for 4 s (shoves people)
//   cable -> a live, sparking end for 6 s (shocks anyone close: 8 + a short stun)
let pipeIdx = null, pipeType = null, pipeDead = null;
export const leaks = [];
export function scanPipes() {
  const g = world.grid, list = [];
  for (let i = 0; i < g.type.length; i++) { const t = g.type[i]; if (t === EL.GASPIPE || t === EL.WATERPIPE || t === EL.CABLE) list.push(i); }
  pipeIdx = Int32Array.from(list); pipeType = new Uint8Array(list.length); pipeDead = new Uint8Array(list.length);
  list.forEach((i, k) => { pipeType[k] = g.type[i]; });
  leaks.length = 0;
  spawnProps(g);
  scanSpans(g);
}
function checkPipes(g) {
  if (!pipeIdx) return;
  for (let k = 0; k < pipeIdx.length; k++) {
    if (pipeDead[k] || g.type[pipeIdx[k]] === pipeType[k]) continue;
    pipeDead[k] = 1;
    const i = pipeIdx[k], x = i % g.w, y = (i / g.w) | 0, t = pipeType[k];
    if (leaks.some((l) => l.type === t && Math.abs(l.x - x) < 10 && Math.abs(l.y - y) < 10) || leaks.length >= 10) continue;
    // the jet points out of the break, toward open air
    let dx = 0, dy = -1, best = -1;
    for (const [ax, ay] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
      let open = 0;
      for (let s = 1; s <= 6; s++) { const X = x + ax * s, Y = y + ay * s; if (g.inBounds(X, Y) && (g.type[Y * g.w + X] === 0 || KIND[g.type[Y * g.w + X]] === Kind.GAS)) open++; }
      if (open > best) { best = open; dx = ax; dy = ay; }
    }
    leaks.push({ type: t, x: x + 0.5, y: y + 0.5, dx, dy, t: 0, life: t === EL.GASPIPE ? 300 : t === EL.WATERPIPE ? 240 : 360, hit: new Map() });
    emit(t === EL.CABLE ? 'zap' : t === EL.GASPIPE ? 'boom' : 'splat', x, 3);
  }
}
function stepLeaks(g, ps) {
  for (let n = leaks.length - 1; n >= 0; n--) {
    const l = leaks[n];
    if (++l.t > l.life) { leaks.splice(n, 1); continue; }
    const fade = l.t > l.life - 40 ? (l.life - l.t) / 40 : 1;
    const jet = (type, count, sp, spread, opts) => {
      for (let k = 0; k < count; k++) {
        const a = Math.atan2(l.dy, l.dx) + (Math.random() - 0.5) * spread, v = sp * (0.7 + Math.random() * 0.6) * fade;
        ps.spawn(l.x + l.dx * 1.5, l.y + l.dy * 1.5, Math.cos(a) * v, Math.sin(a) * v, type, opts);
      }
    };
    const inJet = (p, len, width) => { // a body inside the jet's cone?
      const bx = p.x + BW / 2 - l.x, by = p.y + BH / 2 - l.y, along = bx * l.dx + by * l.dy, across = Math.abs(bx * l.dy - by * l.dx);
      return along > -2 && along < len && across < width + along * 0.25;
    };
    if (l.type === EL.GASPIPE) { // flame jet
      jet(EL.FIRE, 5, 3.4, 0.35, { ghost: true, gravity: -0.03, life: 10 + Math.random() * 8 });
      if (l.t % 3 === 0) jet(EL.FIRE, 1, 2.6, 0.3, { dmg: 0 }); // real fire that lands and catches
      if (l.t % 6 === 0) jet(EL.SMOKE, 1, 1.5, 0.6, { ghost: true, gravity: -0.04, life: 30 });
      for (const p of world.players || []) if (!p.dead && inJet(p, 26 * fade, 3)) { p.damage(0.35 * (p.def.fireMul ?? 1), -1); p.vx += l.dx * 0.15; p.vy += l.dy * 0.15; }
      g.addWind(l.x + l.dx * 8, l.y + l.dy * 8, 5, l.dx * 1.5, l.dy * 1.5);
      if (l.t % 40 === 1) emit('hiss', l.x);
    } else if (l.type === EL.WATERPIPE) { // geyser
      if (l.t % 2 === 0) jet(EL.WATER, 2, 4.5, 0.3, { dmg: 0 });
      jet(EL.ICE, 2, 4, 0.4, { ghost: true, gravity: 0.1, life: 10 }); // white spray
      for (const p of world.players || []) if (!p.dead && inJet(p, 34 * fade, 4)) { p.vx += l.dx * 0.5; p.vy += l.dy * 0.5 - 0.05; }
      if (l.t % 40 === 1) emit('wavewash', l.x);
    } else { // live cable end
      if (Math.random() < 0.6) for (let k = 0; k < 4; k++) ps.spawn(l.x, l.y, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, Math.random() < 0.5 ? EL.ICE : EL.GLASS, { ghost: true, gravity: 0.05, life: 3 + Math.random() * 5 });
      for (const p of world.players || []) {
        if (p.dead || Math.hypot(p.x + BW / 2 - l.x, p.y + BH / 2 - l.y) > 8) continue;
        if (Player_clock() - (l.hit.get(p.id) || -999) < 45) continue;
        l.hit.set(p.id, Player_clock());
        p.damage(8, -1); p.stunT = Math.max(p.stunT || 0, 18);
        for (let k = 0; k < 10; k++) ps.spawn(p.x + Math.random() * BW, p.y + Math.random() * BH, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, EL.ICE, { ghost: true, gravity: 0, life: 5 });
        emit('zap', l.x);
      }
    }
  }
}
// Overpressure bursts windows: glass in a block of air above PANE_PRESSURE shatters, the shards
// flying with the flow (outward from a room a blast went off in).
const PANE_PRESSURE = 0.75;
function overpressure(g) {
  const { fw, fh, rho, vx, vy } = g;
  for (let fy = 0; fy < fh; fy++) for (let fx = 0; fx < fw; fx++) {
    const i = fy * fw + fx, p = rho[i];
    if (p < PANE_PRESSURE) continue;
    // glass in this block or right next to it?
    for (let y = fy * FIELD - 2; y < fy * FIELD + FIELD + 2; y++) for (let x = fx * FIELD - 2; x < fx * FIELD + FIELD + 2; x++) {
      if (!g.inBounds(x, y) || g.type[y * g.w + x] !== EL.GLASS) continue;
      const sp = Math.hypot(vx[i], vy[i]) || 1;
      shatterGlass(x - (vx[i] / sp) * 3, y - (vy[i] / sp) * 3, 5, 2 + p * 0.8); // from upstream: the shards go with the blast
      y = 1e9; break;
    }
  }
}

let pipeClock = 0;
const Player_clock = () => pipeClock;

// ---------- per tick ----------
export function stepPhysics() {
  if (!world) return;
  const g = world.grid, ps = world.particles;
  checkCollapse(g);
  stepChunks(g, ps);
  stepProps(g, ps);
  stepSags(g, ps);
  stepRings(g, ps);
  stepBursts(g, ps);
  pipeClock++;
  if (pipeClock % 3 === 0) checkPipes(g);
  if (pipeClock % 2 === 0) overpressure(g);
  if (pipeClock % 15 === 0) stepHeat(g, ps);
  if (pipeClock % 2 === 1) stepOxygen(g, ps);
  stepVacuums(g);
  stepBackdraft(g);
  stepLeaks(g, ps);
  stepDust(g);
}
