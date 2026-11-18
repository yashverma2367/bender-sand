// Cinematic physics, layered on top of the sand grid:
//   - structural collapse: a piece of building that loses its connection to the ground falls as
//     one rigid chunk, crushes what's under it and breaks apart into rubble, chunks and dust
//   - dust: a hanging dust cloud (a density field, 1 value per 4x4 cells) kicked up by impacts;
//     it drifts with the wind, rises a little, slowly settles, and is drawn over everything
//   - shockwaves: expanding pressure rings from big clashes / blasts that shove bodies outward and
//     blow loose stuff away
//   - splashes: heavy impacts into water throw a crown of real water up
//   - glass: shatters into flying shards
import { EL, KIND, Kind } from './elements.js';
import { BODY_W as BW, BODY_H as BH } from './sprite.js';
import { emit } from './sfx.js';
import { FIELD } from './grid.js';
import { hitstop } from './juice.js';
import { explode } from './abilities.js';

let world = null;
const dirty = [];  // [x, y, r]: spots where solid cells were destroyed (checked for collapse)
const chunks = []; // falling building pieces
const rings = [];  // shockwaves
let mark = null;   // per-cell: id of the falling chunk occupying it (0 = none)
let stamp = null, stampN = 0; // collapse flood-fill visited marks
let chunkId = 0;

export function initPhysics(w) {
  world = w;
  const g = w.grid;
  g.dust = new Float32Array(g.fw * g.fh);
  mark = new Uint16Array(g.w * g.h);
  stamp = new Int32Array(g.w * g.h);
}
export function resetPhysics() {
  dirty.length = 0; chunks.length = 0; rings.length = 0; bursts.length = 0;
  if (world) { world.grid.dust.fill(0); mark.fill(0); }
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
      const k = Math.min(3.2, w.s * 0.045) * (0.4 + 0.6 * fade);
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
  stampN++;
  for (const [x, y, r] of spots) {
    const R = Math.ceil(r) + 2, x0 = Math.floor(x), y0 = Math.floor(y);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== R && Math.max(Math.abs(dx), Math.abs(dy)) !== R - 1) continue; // ring around the hole
      const X = x0 + dx, Y = y0 + dy;
      if (!g.inBounds(X, Y)) continue;
      const i = Y * g.w + X;
      if (!isStatic(g.type[i]) || stamp[i] === stampN || mark[i]) continue;
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
      if (stamp[j] === stampN || !isStatic(type[j]) || mark[j]) continue;
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
      for (const i of c.cells) { type[i] = 0; mark[i] = 0; }
      for (let k = 0; k < c.cells.length; k++) { const j = c.cells[k] + w; c.cells[k] = j; type[j] = c.types[k]; g.temp[j] = 20; mark[j] = c.id; }
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

// ---------- per tick ----------
export function stepPhysics() {
  if (!world) return;
  const g = world.grid, ps = world.particles;
  checkCollapse(g);
  stepChunks(g, ps);
  stepRings(g, ps);
  stepBursts(g, ps);
  stepDust(g);
}
