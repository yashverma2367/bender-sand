// Attack interaction engine. Every attack in flight is an entry with an element, a form and a
// power. Each tick, overlapping attacks from opponents clash:
//   effective power = power x ADVANTAGE (2 when your element beats theirs, else 1)
//   the higher effective power wins and continues weakened; within 15 % both are destroyed.
// On top of that, element pairs have special outcomes (water + fire = steam cloud, fire melts
// rock into lava, earth soaks up water into mud, air hijacks fire, ...). See PAIR_RULES.
//
// Two kinds of entries:
//   native projectiles (fireballs, stones, ice spears) live here in `projectiles`
//   adapters: other systems (air cannons, kick crescents, bubbles, whips, tornados, beams)
//   register an entry every tick with callbacks (kill / set) that act on their own objects.
import { EL, KIND, Kind } from './elements.js';
import { BODY_W as BW, BODY_H as BH } from './sprite.js';
import { explode, bodyAt } from './abilities.js';
import { emit } from './sfx.js';

// ---------- element advantages ----------
// ADV[a][b] = 2: a's element beats b's (doubles a's power in that clash).
const ADV = {
  water: { fire: 2, lava: 2 },
  fire: { earth: 2, air: 2, ice: 2 },
  earth: { water: 2, air: 2, lightning: 2 },
  air: { water: 2, sand: 2 },
  sand: { fire: 2 },
  ice: { water: 2 },
  lava: { ice: 2, earth: 2 },
  lightning: { water: 2 },
  sonic: { earth: 2, sand: 2 },
};
export const advantage = (a, b) => (ADV[a] && ADV[a][b]) || 1;
export const ELEMENT_COLORS = { sand: '#e8c070', fire: '#ff7a2a', water: '#4ea8ff', earth: '#b08850', air: '#cfe8ff', ice: '#bfefff', lava: '#ff4a1a', lightning: '#f5f07a', sonic: '#e0d0ff' };

const PROJ_SCALE = 1.4;

// ---------- registry ----------
export const projectiles = []; // native projectile objects
export const walls = [];       // standing walls (Flame Wall)
let entries = [];              // all attacks this tick (natives + adapters)
const listeners = [];
export const onClash = (fn) => listeners.push(fn);
export function clearClash() { projectiles.length = 0; walls.length = 0; entries = []; }

// Adapter registration (call during a tick, before resolveClashes).
// e: { el, form, pow, x, y, r, vx, vy, owner, team, name, kill(), set({ el, owner, team, vx, vy, pow }) }
// Beams also give x2, y2 (a segment) and are never moved / killed by clashes.
export function register(e) { entries.push(e); return e; }

// ---------- native projectiles ----------
const STYLE = {
  fire: { cell: EL.FIRE, boom: EL.FIRE },
  earth: { cell: EL.STONE, boom: EL.STONE },
  ice: { cell: EL.ICE, boom: EL.ICE },
  lava: { cell: EL.LAVA, boom: EL.LAVA },
  water: { cell: EL.WATER, boom: EL.WATER },
  air: { cell: EL.STEAM, boom: 0 },
  sand: { cell: EL.SAND, boom: EL.SAND },
};
// o: { el, x, y, vx, vy, pow, r, boomR, gravity, owner, team, name, life, cells (earth), dmgScale }
export function spawnProjectile(o) {
  const p = { gravity: 0, life: 120, r: 3, boomR: 4.5, name: o.el, ...o, alive: true, age: 0 };
  p.r *= PROJ_SCALE; // bigger shots for the big map (collision + look)
  p.pow0 = p.pow;
  projectiles.push(p);
  return p;
}

function nativeEntry(p) {
  return register({
    el: p.el, form: 'projectile', pow: p.pow, x: p.x, y: p.y, r: p.r, vx: p.vx, vy: p.vy, owner: p.owner, team: p.team, name: p.name, native: p,
    kill: () => { p.alive = false; },
    set: (q) => Object.assign(p, q),
  });
}

function impact(world, p, x, y) {
  p.alive = false;
  const k = 0.45 + 0.55 * Math.max(0, Math.min(1, p.pow / p.pow0)); // weakened shots hit smaller
  const st = STYLE[p.el] || STYLE.fire;
  if (p.dmg !== undefined && p.el !== 'water') { // small shots (shards ...): a direct hit + a cosmetic burst, no explosion
    const v = bodyAt(world, x, y, p.owner, p.r + 2);
    if (v) v.damage(p.dmg * k, p.owner);
    const cell = (STYLE[p.el] || STYLE.earth).cell;
    for (let n = 0; n < 6; n++) world.particles.spawn(x, y, (Math.random() - 0.5) * 2.5, -Math.random() * 2, cell, { ghost: true, gravity: 0.12, life: 10 });
    if (p.cells && Math.random() < 0.5) world.particles.spawn(x, y, (Math.random() - 0.5) * 2, -1, p.cells[0], { bounces: 1, dmg: 0 }); // a bit of real rubble
    return;
  }
  if (p.el === 'water') { // a water ball just splashes: real water + a hit
    for (let n = 0; n < (p.dmg && p.dmg < 6 ? 3 : 10); n++) world.particles.spawn(x, y, (Math.random() - 0.5) * 3, -Math.random() * 2, EL.WATER, { bounces: 0, dmg: 0 });
    const v = bodyAt(world, x, y, p.owner, p.r + 2);
    if (v) v.damage((p.dmg ?? 10) * k, p.owner);
    return;
  }
  explode(world, x, y, p.boomR * k, st.boom, false, true, p.owner);
  if (p.el === 'lava') for (let n = 0; n < 8; n++) world.particles.spawn(x, y, (Math.random() - 0.5) * 3, -Math.random() * 2.5, EL.LAVA, { bounces: 0, dmg: 0.3 });
  if (p.shape === 'ram') for (let n = 0; n < 14; n++) world.particles.spawn(x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 3, -Math.random() * 2, EL.STONE, { bounces: 1, dmg: 0 }); // rubble
  if (p.el === 'earth' && p.cells) for (const t of p.cells.slice(0, 6)) world.particles.spawn(x, y, (Math.random() - 0.5) * 3, -1 - Math.random() * 2, t, { bounces: 1, dmg: 0.25 });
}

function drawProjectile(ps, p) {
  const st = STYLE[p.el] || STYLE.fire, sp = Math.hypot(p.vx, p.vy) || 1, dx = p.vx / sp, dy = p.vy / sp;
  const R = Math.max(1, p.r * (0.6 + 0.4 * p.pow / p.pow0));
  if (p.shape === 'ram') { // battering ram: a tall slab of stone flying flat
    const hh = Math.max(4, (p.h || 20) / 2 * (0.6 + 0.4 * p.pow / p.pow0));
    for (let y = -hh; y <= hh; y += 1) for (let x = -2.5; x <= 2.5; x += 1) {
      const cell = p.cells ? p.cells[((y * 7 + x * 3) | 0) & 1 ? 0 : 2] : EL.STONE;
      ps.spawn(p.x + x, p.y + y, 0, 0, cell, { ghost: true, gravity: 0, life: 1 });
    }
    for (let k = 0; k < 3; k++) ps.spawn(p.x - dx * 4, p.y + (Math.random() - 0.5) * hh * 2, -dx, -0.2, EL.SAND, { ghost: true, gravity: 0.08, life: 6 });
    return;
  }
  if (p.el === 'ice') { // spear along the flight
    for (let k = -3; k <= 3; k++) ps.spawn(p.x - dx * k * 1.2, p.y - dy * k * 1.2, 0, 0, k <= -2 ? EL.WATER : EL.ICE, { ghost: true, gravity: 0, life: 1 });
    ps.spawn(p.x - dx * 2 + dy, p.y - dy * 2 - dx, 0, 0, EL.ICE, { ghost: true, gravity: 0, life: 1 });
  } else {
    for (let k = 0; k < 6 + R * 3; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * R;
      const t = p.el === 'earth' && p.cells ? p.cells[k % p.cells.length] : st.cell;
      ps.spawn(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 0, 0, t, { ghost: true, gravity: 0, life: 1 });
    }
    if (p.el === 'lava' || p.el === 'fire') ps.spawn(p.x, p.y, 0, 0, EL.FIRE, { ghost: true, gravity: 0, life: 1 });
  }
  // trail
  for (let k = 1; k < 4; k++) if (Math.random() < 0.6) ps.spawn(p.x - dx * k * 2.2, p.y - dy * k * 2.2, -dx * 0.3, -dy * 0.3 - (p.el === 'fire' ? 0.2 : 0), p.el === 'earth' ? EL.SAND : st.cell, { ghost: true, gravity: 0, life: 3 });
}

// ---------- walls ----------
// A standing wall of an element: a vertical segment from (x, base) up `h` cells. It clashes like
// any attack (soaking up shots, losing power, shrinking), burns / hurts enemies standing in it, and
// is gone when its power runs out or its time is up.
// o: { el, x, base, h, pow, owner, team, life, name }
export function spawnWall(o) {
  const w = { life: 180, name: 'Wall', ...o, pow0: o.pow, age: 0, alive: true };
  walls.push(w);
  return w;
}
function stepWalls(world) {
  for (const w of walls) {
    if (!w.alive) continue;
    w.age++;
    if (w.age > w.life || w.pow <= 3) { w.alive = false; continue; }
    const k = Math.max(0.25, w.pow / w.pow0), h = w.h * k, top = w.base - h;
    const rise = Math.min(1, w.age / 6), ht = h * rise; // bursts up over 6 ticks
    for (let y = w.base; y > w.base - ht; y -= 1) { // a wall of roaring flame, 5 wide, licking taller in places
      for (let o = -2; o <= 2; o++) {
        const lick = Math.sin(y * 0.5 + w.age * 0.4 + o * 1.7) * 3; // tongues of flame along the top edge
        if (y < w.base - ht + lick + 2 || Math.random() > 0.85) continue;
        world.particles.spawn(w.x + o + (Math.random() - 0.5) * 0.8, y, 0, -0.3, EL.FIRE, { ghost: true, gravity: -0.02, life: 2 });
      }
    }
    for (let k = 0; k < 3; k++) world.particles.spawn(w.x + (Math.random() - 0.5) * 6, w.base - ht + Math.random() * 6, (Math.random() - 0.5) * 0.5, -1 - Math.random(), EL.FIRE, { ghost: true, gravity: -0.03, life: 6 }); // flames leaping off the top
    if (Math.random() < 0.5) world.particles.spawn(w.x + (Math.random() - 0.5) * 3, w.base - ht, (Math.random() - 0.5) * 0.6, -0.8, EL.SMOKE, { ghost: true, gravity: -0.02, life: 18 });
    for (const pl of world.players || []) { // enemies inside the flames burn
      if (pl.dead || pl.id === w.owner || (w.team !== null && w.team !== undefined && pl.team === w.team)) continue;
      if (Math.abs(pl.x + BW / 2 - w.x) < 3 + BW / 2 && pl.y < w.base && pl.y + BH > w.base - ht) pl.damage(0.3 * pl.def.fireMul, w.owner); // ~18 per second inside the flames
    }
    if (rise < 1) continue;
    register({ el: w.el, form: 'wall', name: w.name, pow: w.pow, x: w.x, y: w.base, x2: w.x, y2: top, r: 3.5, owner: w.owner, team: w.team,
      kill: () => { w.alive = false; }, set: (q) => { if (q.pow !== undefined) w.pow = q.pow; } });
  }
  for (let i = walls.length - 1; i >= 0; i--) if (!walls[i].alive) walls.splice(i, 1);
}

// Move every native projectile (sub-stepped), hit bodies (proximity fuse) and terrain.
export function stepProjectiles(world) {
  stepWalls(world);
  const g = world.grid;
  for (const p of projectiles) {
    if (!p.alive) continue;
    p.age++;
    if (p.age > p.life) { impact(world, p, p.x, p.y); continue; }
    p.vy += p.gravity;
    const sp = Math.hypot(p.vx, p.vy), n = Math.max(1, Math.ceil(sp));
    for (let s = 0; s < n && p.alive; s++) {
      p.x += p.vx / n; p.y += p.vy / n;
      const X = Math.floor(p.x), Y = Math.floor(p.y);
      if (X < -5 || X >= g.w + 5 || Y >= g.h || Y < -80) { p.alive = false; break; }
      const v = bodyAt(world, p.x, p.y, p.owner, p.r + 4);
      if (v) { impact(world, p, p.x + (v.x + BW / 2 - p.x) * 0.5, p.y + (v.y + BH / 2 - p.y) * 0.5); break; }
      if (Y >= 0 && X >= 0 && X < g.w) {
        const t = g.type[Y * g.w + X];
        if (t !== 0 && KIND[t] !== Kind.GAS && !(p.el === 'water' && t === EL.WATER)) { impact(world, p, p.x - p.vx / n, p.y - p.vy / n); break; }
      }
    }
    if (p.alive) { drawProjectile(world.particles, p); nativeEntry(p); }
  }
  for (let i = projectiles.length - 1; i >= 0; i--) if (!projectiles[i].alive) projectiles.splice(i, 1);
}

// ---------- clash resolution ----------
const touching = (a, b) => {
  if (a.x2 !== undefined && b.x2 !== undefined) { // two segments (beams / walls): do they cross or nearly touch?
    const segDist = (p, q, r, s) => { // min distance between segments pq and rs
      const d = (px, py, ax, ay, bx, by) => { const ex = bx - ax, ey = by - ay, l = ex * ex + ey * ey || 1, t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l)); return Math.hypot(ax + ex * t - px, ay + ey * t - py); };
      const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const d1 = cross(r[0], r[1], s[0], s[1], p[0], p[1]), d2 = cross(r[0], r[1], s[0], s[1], q[0], q[1]);
      const d3 = cross(p[0], p[1], q[0], q[1], r[0], r[1]), d4 = cross(p[0], p[1], q[0], q[1], s[0], s[1]);
      if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
      return Math.min(d(p[0], p[1], r[0], r[1], s[0], s[1]), d(q[0], q[1], r[0], r[1], s[0], s[1]), d(r[0], r[1], p[0], p[1], q[0], q[1]), d(s[0], s[1], p[0], p[1], q[0], q[1]));
    };
    return segDist([a.x, a.y], [a.x2, a.y2], [b.x, b.y], [b.x2, b.y2]) < a.r + b.r;
  }
  const beam = a.x2 !== undefined ? a : b.x2 !== undefined ? b : null;
  if (beam) {
    const o = beam === a ? b : a;
    const sx = beam.x2 - beam.x, sy = beam.y2 - beam.y, l2 = sx * sx + sy * sy || 1;
    const t = Math.max(0, Math.min(1, ((o.x - beam.x) * sx + (o.y - beam.y) * sy) / l2));
    return Math.hypot(beam.x + sx * t - o.x, beam.y + sy * t - o.y) < o.r + beam.r;
  }
  // Swept: closest approach of the two over this tick's movement (fast shots can't skip past each
  // other). Relative position goes from d0 (start of tick) to d1 (now).
  const d1x = a.x - b.x, d1y = a.y - b.y;
  const d0x = d1x - ((a.vx || 0) - (b.vx || 0)), d0y = d1y - ((a.vy || 0) - (b.vy || 0));
  const ex = d1x - d0x, ey = d1y - d0y, l2 = ex * ex + ey * ey;
  const t = l2 ? Math.max(0, Math.min(1, -(d0x * ex + d0y * ey) / l2)) : 1;
  return Math.hypot(d0x + ex * t, d0y + ey * t) < a.r + b.r;
};
const enemies = (a, b) => a.owner !== b.owner && !(a.team !== null && a.team !== undefined && a.team === b.team);

export let lastEntries = []; // the attacks from the last tick (Clash Lab power labels)
export function resolveClashes(world) {
  const list = entries;
  lastEntries = list;
  entries = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.dead || b.dead || !enemies(a, b) || !touching(a, b)) continue;
      clash(world, a, b);
    }
  }
}

function contact(a, b) {
  if (a.x2 !== undefined && b.x2 !== undefined) { // two segments: the point on a closest to b
    let best = [a.x, a.y], bd = Infinity;
    for (let k = 0; k <= 24; k++) {
      const x = a.x + ((a.x2 - a.x) * k) / 24, y = a.y + ((a.y2 - a.y) * k) / 24;
      const ex = b.x2 - b.x, ey = b.y2 - b.y, l = ex * ex + ey * ey || 1, t = Math.max(0, Math.min(1, ((x - b.x) * ex + (y - b.y) * ey) / l));
      const d = Math.hypot(b.x + ex * t - x, b.y + ey * t - y);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    return best;
  }
  if (a.x2 !== undefined) return [b.x, b.y];
  if (b.x2 !== undefined) return [a.x, a.y];
  const t = a.r / (a.r + b.r || 1);
  return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
}

function clash(world, a, b) {
  a.pow0 = a.pow; b.pow0 = b.pow; // power going into this clash (for the Clash Lab log)
  if (a.parry || b.parry) { // Earth's rock parry: absorbs anything, and counters its owner
    const pr = a.parry ? a : b, o = pr === a ? b : a;
    if (o.parry) return;
    kill(o); pr.parry(o.owner);
    const res = { a, b, ea: a.pow, eb: b.pow, cancel: false, winner: pr, at: contact(a, b), text: 'parried! a pillar erupts under the attacker' };
    burst(world, res.at, o.el, 'earth', 0.6);
    for (const fn of listeners) fn(res);
    return;
  }
  const ea = a.pow * advantage(a.el, b.el), eb = b.pow * advantage(b.el, a.el);
  const cancel = Math.abs(ea - eb) <= 0.15 * Math.max(ea, eb);
  const win = ea >= eb ? a : b, lose = win === a ? b : a;
  const ew = Math.max(ea, eb), el = Math.min(ea, eb);
  const res = { a, b, ea, eb, cancel, winner: cancel ? null : win, at: contact(a, b), text: '' };
  const key = [a.el, b.el].sort().join('+');
  const rule = PAIR_RULES[key] || genericRule;
  rule(world, res, a, b);
  if (!res.handled) { // standard power outcome
    if (cancel) { kill(a); kill(b); burst(world, res.at, a.el, b.el); res.text ||= 'they cancel out'; }
    else {
      kill(lose);
      weaken(win, (ew - el) / advantage(win.el, lose.el));
      burst(world, res.at, lose.el, win.el, 0.6); emit('clash', res.at[0]);
      res.text ||= `${win.name} wins`;
    }
  }
  const gone = (e) => e.dead || e.form === 'beam'; // beams always 'end' at the clash
  if (res.cancel && gone(a) && gone(b) && !(a.form === 'beam' && b.form === 'beam')) cancelBlast(world, res, a, b); // (two beams just grind)
  for (const fn of listeners) fn(res);
}

// Two attacks that destroy each other blow up where they met: size from their combined power,
// type from the most volatile element involved. Hurts anyone close, including both throwers.
const BLAST_TYPE = [['fire', EL.FIRE], ['lava', EL.FIRE], ['lightning', EL.FIRE], ['earth', EL.STONE], ['ice', EL.ICE], ['water', EL.WATER], ['air', 0]];
function cancelBlast(world, res, a, b) {
  const els = [a.el, b.el], type = (BLAST_TYPE.find(([e]) => els.includes(e)) || [0, 0])[1];
  const r = Math.min(12, 4 + ((a.pow0 || 0) + (b.pow0 || 0)) / 10);
  explode(world, res.at[0], res.at[1], r, type, r >= 8, true, -1);
  emit('boom', res.at[0], r);
  res.text = (res.text ? res.text + ' and ' : '') + 'explode';
}

// Change who owns an attack (air hijacking fire, deflecting a stone). Natives just switch owner;
// adapters that can't (crescents, bubbles, whips ...) are replaced by a native projectile.
function takeOver(e, props) {
  if (e.native || e.canOwn) { Object.assign(e, props); e.set && e.set(props); return; }
  kill(e);
  spawnProjectile({ el: props.el || e.el, x: e.x, y: e.y, vx: props.vx ?? e.vx ?? 0, vy: props.vy ?? e.vy ?? 0, pow: props.pow ?? e.pow,
    r: Math.max(2.5, props.r || e.r || 3), boomR: 4.5, owner: props.owner, team: props.team, name: props.name || e.name, life: 90 });
}

const kill = (e) => { if (e.form === 'beam') return; e.dead = true; e.kill && e.kill(); };
const weaken = (e, pow) => { if (e.form === 'beam') return; e.pow = pow; e.set && e.set({ pow }); };

// ---------- effects ----------
function burst(world, [x, y], e1, e2, scale = 1) {
  const cells = [STYLE[e1]?.cell ?? EL.STEAM, STYLE[e2]?.cell ?? EL.STEAM];
  for (let k = 0; k < 18 * scale; k++) {
    const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 2.5;
    world.particles.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, cells[k & 1], { ghost: true, gravity: 0.05, life: 10 + Math.random() * 8 });
  }
  if (world.fx) world.fx.shake(1.5 * scale);
}
function fillCells(world, x, y, r, type, onlyEmpty = true) {
  const g = world.grid;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy > r * r) continue;
    const X = Math.floor(x + dx), Y = Math.floor(y + dy);
    if (!g.inBounds(X, Y)) continue;
    if (onlyEmpty && g.type[Y * g.w + X] !== 0) continue;
    g.set(X, Y, type);
  }
}
function steamCloud(world, at, size) { fillCells(world, at[0], at[1], Math.min(9, 3 + size / 10), EL.STEAM); emit('hiss', at[0]); }
function mud(world, at) { // mud blob that falls and spreads where it lands
  for (let k = 0; k < 26; k++) world.particles.spawn(at[0] + (Math.random() - 0.5) * 6, at[1] + (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 1.5, Math.random() * 0.5, EL.MUD, { bounces: 0, dmg: 0 });
  emit('splat', at[0]);
}
function iceWall(world, at) { // a 3-wide column of ice where the water froze
  const g = world.grid;
  for (let y = Math.floor(at[1]) - 9; y <= Math.floor(at[1]) + 6; y++) for (let x = Math.floor(at[0]) - 1; x <= Math.floor(at[0]) + 1; x++) {
    if (g.inBounds(x, y) && (g.type[y * g.w + x] === 0 || g.type[y * g.w + x] === EL.WATER)) g.set(x, y, EL.ICE);
  }
  emit('freezeclash', at[0]);
}
function shockOwner(world, water, at) { // electricity runs back along the water to whoever bent it
  const owner = (world.players || []).find((q) => q.id === water.owner && !q.dead);
  if (!owner) return;
  const now = performance.now();
  if (now - (owner.lastShockAt || 0) < 400) return; // a held jet in contact is shocked once, not every frame
  owner.lastShockAt = now;
  const ox = owner.x + BW / 2, oy = owner.y + BH / 2, n = Math.ceil(Math.hypot(ox - at[0], oy - at[1]) / 3);
  for (let k = 0; k <= n; k++) world.particles.spawn(at[0] + ((ox - at[0]) * k) / n + (Math.random() - 0.5) * 3, at[1] + ((oy - at[1]) * k) / n + (Math.random() - 0.5) * 3, 0, 0, EL.ICE, { ghost: true, gravity: 0, life: 4 });
  owner.damage(10, -1); owner.stunT = Math.max(owner.stunT || 0, 24);
  emit('zap', ox);
}

// ---------- pair rules ----------
// Each rule may set res.handled (it decided everything) and res.text (for the Clash Lab log).
function genericRule(world, res) { res.text = ''; }

const PAIR_RULES = {
  // Water vs fire: the fire is put out (or a big fire boils the water away), leaving scalding steam.
  'fire+water'(world, res, a, b) {
    steamCloud(world, res.at, a.pow + b.pow);
    res.text = res.cancel ? 'both turn to steam' : res.winner.el === 'water' ? 'water puts the fire out, steam' : 'fire boils the water away, steam';
  },
  // Ice vs fire: the ice melts into water (it keeps flying as water if it wins).
  'fire+ice'(world, res, a, b) {
    const ice = a.el === 'ice' ? a : b;
    steamCloud(world, res.at, 10);
    if (res.winner === ice) { res.handled = true; const f = ice === a ? b : a; kill(f); ice.set && ice.set({ el: 'water', pow: ice.pow * 0.6 }); ice.el = 'water'; res.text = 'the ice spear melts into water and keeps going'; burst(world, res.at, 'ice', 'water', 0.6); }
    else res.text = res.cancel ? 'ice and fire cancel, steam' : 'fire melts the ice';
  },
  // Fire vs earth: the rock melts. If the rock wins it keeps flying as molten lava; if the fire
  // wins the rock collapses into a lava splash.
  'earth+fire'(world, res, a, b) {
    const rock = a.el === 'earth' ? a : b, fire = rock === a ? b : a;
    res.handled = true;
    if (res.winner === rock) {
      kill(fire); weaken(rock, Math.max(res.ea, res.eb) - Math.min(res.ea, res.eb)); rock.el = 'lava'; rock.set && rock.set({ el: 'lava', name: 'Lava rock' });
      res.text = 'the fire melts the stone into a flying lava rock';
    } else {
      kill(rock); if (!res.cancel) weaken(fire, (Math.max(res.ea, res.eb) - Math.min(res.ea, res.eb)) / 2); else kill(fire);
      fillCells(world, res.at[0], res.at[1] + 2, 2, EL.LAVA);
      res.text = res.cancel ? 'both melt into a lava splash' : 'the fire melts the stone into a lava splash';
    }
    burst(world, res.at, 'lava', 'fire'); emit('sizzle', res.at[0]);
  },
  // Earth vs water: earth soaks the water up into mud; very strong water erodes the earth instead.
  'earth+water'(world, res) {
    mud(world, res.at);
    res.text = res.cancel ? 'both collapse into mud' : res.winner.el === 'earth' ? 'the earth soaks up the water: mud' : 'the water erodes the earth away';
  },
  // Air vs fire: the air feeds the fire and carries it: the fire flies on in the air's direction,
  // bigger, and now belongs to whoever sent the air.
  'air+fire'(world, res, a, b) {
    const air = a.el === 'air' ? a : b, fire = air === a ? b : a;
    res.handled = true;
    kill(air);
    const sp = Math.hypot(fire.vx || 0, fire.vy || 0) || 8, al = Math.hypot(air.vx || 0, air.vy || 0) || 1;
    const vx = ((air.vx || 0) / al) * sp, vy = ((air.vy || 0) / al) * sp;
    const pow = fire.pow + air.pow * 0.6;
    if (air.form === 'area') { // a tornado swallows the fire and becomes a fire tornado
      air.dead = false; kill(fire); air.set && air.set({ el: 'fire' });
      burst(world, res.at, 'fire', 'fire', 1.2); emit('whoosh', res.at[0]);
      res.text = 'the tornado swallows the fire: fire tornado';
      return;
    }
    takeOver(fire, { owner: air.owner, team: air.team, vx, vy, pow, r: (fire.r || 3) * 1.3, name: 'Wind-fed fire' });
    burst(world, res.at, 'fire', 'fire', 1.2); emit('whoosh', res.at[0]);
    res.text = 'the air feeds the fire and throws it back, bigger';
  },
  // Air vs water: the water is scattered into a harmless mist.
  'air+water'(world, res, a, b) {
    for (let k = 0; k < 20; k++) world.particles.spawn(res.at[0], res.at[1], (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, EL.WATER, { ghost: true, gravity: 0.02, life: 18 });
    res.text = res.cancel ? 'both blow apart into mist' : res.winner.el === 'air' ? 'the air scatters the water into mist' : 'the water bursts through the air';
  },
  // Air vs earth: heavy rock plows through; a light stone gets deflected (and is now the air's).
  'air+earth'(world, res, a, b) {
    const air = a.el === 'air' ? a : b, rock = air === a ? b : a;
    if (res.winner === air) {
      res.handled = true; kill(air);
      const sp = Math.hypot(rock.vx || 0, rock.vy || 0) || 8, al = Math.hypot(air.vx || 0, air.vy || 0) || 1;
      takeOver(rock, { owner: air.owner, team: air.team, vx: ((air.vx || 0) / al) * sp, vy: ((air.vy || 0) / al) * sp, name: 'Deflected stone' });
      burst(world, res.at, 'air', 'earth', 0.6); emit('whoosh', res.at[0]);
      res.text = 'the air deflects the stone back';
    } else res.text = res.cancel ? 'stone and air cancel' : 'the stone plows straight through the air';
  },
  // Ice vs water: the water freezes into an ice wall.
  'ice+water'(world, res, a, b) {
    const water = a.el === 'water' ? a : b;
    if (res.winner !== water) { iceWall(world, res.at); res.text = 'the water freezes into an ice wall'; }
    else res.text = 'the water swallows the ice';
  },
  // Lightning vs water: the water is electrified and the shock runs back to whoever bent it.
  'lightning+water'(world, res, a, b) {
    const water = a.el === 'water' ? a : b;
    if (res.winner !== water) { res.handled = true; kill(water); shockOwner(world, water, res.at); res.text = 'lightning electrifies the water, shocking its bender'; }
    else res.text = 'the water grounds the lightning';
  },
  // Lava vs water: obsidian + steam.
  'lava+water'(world, res) {
    fillCells(world, res.at[0], res.at[1], 2, EL.OBSIDIAN); steamCloud(world, res.at, 15);
    res.text = 'lava meets water: obsidian and steam';
  },
  // Sand vs fire: the sand smothers the fire (leaving sand and ash); if the fire wins, the sand
  // melts into glass.
  'fire+sand'(world, res, a, b) {
    if (res.winner && res.winner.el === 'sand') { fillCells(world, res.at[0], res.at[1] + 2, 2, EL.ASH); res.text = 'the sand smothers the fire'; emit('splat', res.at[0]); }
    else { fillCells(world, res.at[0], res.at[1], 2, EL.GLASS); res.text = res.cancel ? 'sand and fire fuse into glass' : 'the fire melts the sand into glass'; emit('sizzle', res.at[0]); }
  },
  // Sand vs water: mud.
  'sand+water'(world, res) { mud(world, res.at); res.text = res.cancel ? 'both collapse into mud' : res.winner.el === 'sand' ? 'the sand soaks up the water: mud' : 'the water washes the sand into mud'; },
  // Air vs sand: the air blows the sand away.
  'air+sand'(world, res) { res.text = res.cancel ? 'sand and wind cancel' : res.winner.el === 'air' ? 'the air blows the sand away' : 'the sand blasts through the air'; },
  'ice+lava'(world, res) { steamCloud(world, res.at, 10); res.text = 'the lava melts the ice'; },
  'earth+lightning'(world, res) { res.text = 'the earth grounds the lightning'; },
};
