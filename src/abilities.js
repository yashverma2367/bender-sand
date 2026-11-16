// Bending powers. Every bender has the same 6 slots on the same keys:
//   Z basic · X heavy · C special · A defense · S mobility · V ultimate
// Moves spend energy (refills over time); the ultimate needs a full ultimate meter, which fills
// as energy is spent. Moves are either taps (cast once, auto-repeat while held at the cooldown)
// or holds (channel every tick while the key is held, then release).
//
// Every move works through real cells and flying particles, so it reacts with the world.
// Most attacks are deliberately very fast (7-12 cells/tick) with explosive impacts.
import { EL, Kind, KIND, IGNITE_T } from './elements.js';
import { MAX_HP } from './benders.js';
import { BODY_W as BW, BODY_H as BH } from './sprite.js';
import { emit } from './sfx.js';

export const SLOTS = ['basic', 'heavy', 'special', 'defense', 'mobility', 'ultimate'];
export const SLOT_KEYS = { z: 'basic', x: 'heavy', c: 'special', a: 'defense', s: 'mobility', v: 'ultimate' };
export const MAX_ENERGY = 175;
const ENERGY_REGEN = 0.45;     // per tick (~6.5 s from empty)
const LANCE_CHARGE = 240;      // plasma lance: ticks of charging needed (4 s)
const CLAP_CHARGE = 150;       // sonic clap: ticks of charging needed (2.5 s)
const ULT_PER_DAMAGE = 0.5;
// X orbs: hold X to form up to 3 element orbs that orbit you (one more every ORB_EVERY ticks of
// charge); each tap of X throws one along your aim. Unused orbs fade after ORB_LIFE ticks.
const ORB_EVERY = 14;
const ORB_LIFE = 420;
    // ultimate meter gained per point of damage dealt (200 damage = full)
let currentOwner = -1;         // id of the player whose moves are being processed right now

// The first enemy body (not attackerId) containing point (x, y), or null.
function bodyAt(world, x, y, attackerId, pad = 0) {
  const list = world.players || [world.player];
  const me = list.find((q) => q && q.id === attackerId);
  for (const pl of list) {
    if (!pl || pl.dead || pl.id === attackerId) continue;
    if (me && me.team !== null && pl.team === me.team) continue;
    if (x >= pl.x - pad && x <= pl.x + BW + pad && y >= pl.y - pad && y <= pl.y + BH + pad) return pl;
  }
  return null;
}

// Direct damage to one body, credited to the attacker.
function hurt(world, victim, dmg, attackerId) {
  creditDamage(world, attackerId, victim.damage(dmg, attackerId));
}

// Credit damage dealt by `attackerId` toward their ultimate.
export function creditDamage(world, attackerId, dmg) {
  const a = (world.players || [world.player]).find((p) => p && p.id === attackerId);
  if (a && dmg > 0) a.ult = Math.min(100, a.ult + dmg * ULT_PER_DAMAGE);
}

// Hurt every player except the attacker within r of (x, y) (body center), falling off with
// distance. Returns total damage dealt.
export function damageArea(world, x, y, r, amount, attackerId = currentOwner) {
  let total = 0;
  for (const pl of world.players || [world.player]) {
    if (!pl || pl.dead || pl.id === attackerId) continue;
    const d = Math.hypot(pl.x + BW / 2 - x, pl.y + BH / 2 - y);
    const reach = r * 1.3 + 7; // generous: a blast near you still hurts
    if (d > reach) continue;
    const dmg = amount * (1 - (d / reach) * 0.5);
    total += pl.damage(dmg, attackerId);
  }
  creditDamage(world, attackerId, total);
  return total;
}

export function initAbilities(p) {
  p.energy = MAX_ENERGY;
  p.ult = 0;
  p.cd = {};
  p.cast = null;     // { pose, t } upper-body pose the sprite shows
  p.channel = null;  // { slot, t } held move in progress
  p.shield = 0;      // ticks of damage reduction left
  p.slowT = 0;       // ticks of slowed movement (stone armor)
  p.dashT = 0;
  p.surfT = 0;
  p.rupture = null;
  p.ascend = null;
  p.ascended = 0;
  p.flameHair = false;
  p.tsunami = null;
  p.pillar = null;
  p.blades = [];     // air
  p.cannons = [];
  p.tornados = [];
  p.dragon = null;
  p.step = null;
  p.bolt = null;     // fire lightning
  p.lance = null;    // fire plasma lance
  p.cage = null;     // earth stone cage
  p.freezeBurst = null; // water flash freeze visual
  p.claps = [];      // air sonic clap shockwaves
  p.stunT = 0;       // can't move / cast
  p.frozenT = 0;     // frozen solid (drawn as ice)
  p.magma = null;    // earth magma surge
  p.vacuums = [];    // air vacuum spheres
  p.afterimages = [];
  p.kicks = null;    // fire kick barrage in progress
  p.crescents = [];  // flying fire crescents
  p.bubbles = [];    // water bubble-trap orbs in flight
  p.whips = [];      // water whips cracking
  p.whipCombo = 0;   // ticks left to press Z again for the follow-up lash
  p.whipLock = 0;
}

// ---------- explosions ----------
// Blast at (x, y): loose cells (sand, water, ...) fly outward fast as particles, everything in
// range heats up (ignites wood, boils water), air is shoved outward, the screen shakes.
// Fire blasts also fill empty space with flame; rock blasts leave a little rubble.
// Every blast breaks solid blocks near its center; breakStatic (big blasts) breaks deeper,
// including obsidian.
export function explode(world, x, y, r, type, breakStatic = false, knockPlayer = true, owner = currentOwner) {
  const { grid: g, particles: ps, fx } = world;
  if (r >= 5) emit('boom', x, r); else emit('boom', x, r, 'smallboom', 60);
  const cx = Math.floor(x), cy = Math.floor(y), R = Math.ceil(r);
  const force = 2.5 + r * 0.9;
  const heat = type === EL.FIRE || type === EL.LAVA ? 450 : 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      const X = cx + dx, Y = cy + dy;
      if (!g.inBounds(X, Y)) continue;
      const i = Y * g.w + X, t = g.type[i];
      const k = 1 - d / (r + 1);
      if (t === 0) {
        if (type === EL.FIRE && Math.random() < 0.15 + 0.55 * k) g.set(X, Y, EL.FIRE);
        continue;
      }
      const kind = KIND[t];
      if (kind === Kind.GAS) continue;
      g.temp[i] += heat * k;
      const loose = kind === Kind.POWDER || kind === Kind.LIQUID;
      // Solid blocks: every blast chips out its inner part; big blasts (breakStatic) dig deeper and
      // can break obsidian too.
      const smash = kind === Kind.STATIC && (breakStatic ? d < r * 0.8 : t !== EL.OBSIDIAN && d < r * 0.55);
      if (smash && CRUMBLE[t]) g.type[i] = CRUMBLE[t]; // broken rock crumbles into rubble (sand)
      if ((loose && Math.random() < 0.85) || smash) {
        const nx = d ? dx / d : 0, ny = d ? dy / d : -1, sp = force * k * (0.6 + Math.random() * 0.7);
        ps.lift(X, Y, nx * sp, ny * sp - 0.6, { bounces: 1, dmg: 0.25 });
      }
    }
  }
  // Knock the player away from the blast (fireball at your own feet = rocket jump).
  // Blast damage to everyone but the attacker, scaled by blast size.
  damageArea(world, x, y, r, 6 + r * 2.2, owner);
  if (type === EL.ICE) { // ice shots pin whoever they catch: frozen in place for 0.4 s
    const own = (world.players || []).find((q) => q && q.id === owner);
    for (const pl of world.players || []) {
      if (!pl || pl.dead || pl.id === owner || (own && own.team !== null && pl.team === own.team) || pl.invulnT > 0) continue;
      if (Math.hypot(pl.x + BW / 2 - x, pl.y + BH / 2 - y) > r * 1.3 + 4) continue;
      if (!(pl.frozenT > 24)) { pl.frozenT = 24; pl.stunT = Math.max(pl.stunT || 0, 24); pl.vx *= 0.2; pl.vy *= 0.2; pl.shatterable = false; }
    }
  }
  // Knock bodies away from the blast (your own fireball at your feet = rocket jump).
  for (const pl of world.players || [world.player]) {
    if (!pl || pl.dead || (!knockPlayer && pl.id === owner)) continue;
    const dx = pl.x + BW / 2 - x, dy = pl.y + BH / 2 - y, d = Math.hypot(dx, dy);
    if (d < r + 6) {
      const k = (1 - d / (r + 6)) * force * 0.45;
      pl.vx += (d ? dx / d : 0) * k;
      pl.vy += (d ? dy / d : -1) * k - k * 0.3;
    }
  }
  for (let a = 0; a < 8; a++) {
    const ax = Math.cos((a * Math.PI) / 4), ay = Math.sin((a * Math.PI) / 4);
    g.addWind(x + ax * r, y + ay * r, r, ax * force * 0.8, ay * force * 0.8);
  }
  const centerEmpty = g.inBounds(cx, cy) && g.type[cy * g.w + cx] === 0;
  if (EARTHY.has(type) && centerEmpty) g.set(cx, cy, EL.SAND);
  if (type === EL.WATER && centerEmpty) g.set(cx, cy, EL.WATER);
  if (type === EL.ICE) { freezeArea(g, x, y, r + 2); if (centerEmpty) { g.set(cx, cy, EL.ICE); g.temp[cy * g.w + cx] = -40; } }
  fx.shake(Math.min(10, r * 0.9));
}

// What solid blocks turn into when a blast breaks them (so holes stay open instead of the
// pieces settling back as solid rock).
const CRUMBLE = { [EL.STONE]: EL.SAND, [EL.OBSIDIAN]: EL.SAND, [EL.GLASS]: EL.SAND };
// What the sonic clap pulverizes solids into.
const PULVERIZE = { [EL.STONE]: EL.SAND, [EL.GLASS]: EL.SAND, [EL.OBSIDIAN]: EL.SAND, [EL.WOOD]: EL.ASH, [EL.PLANT]: EL.ASH, [EL.EARTH]: EL.EARTH };
// What the blaze torrent can melt into lava when it's held on one spot (sand turns to glass on its own).
const MELTS = { [EL.STONE]: 1, [EL.EARTH]: 1, [EL.GLASS]: 1, [EL.MUD]: 1, [EL.OBSIDIAN]: 1 };

// ---------- earth helpers ----------
const EARTHY = new Set([EL.EARTH, EL.STONE, EL.SAND, EL.MUD]);
const SOLID_KINDS = new Set([Kind.STATIC, Kind.POWDER]);

// Take up to n cells whose type is in `kinds` from around (ox, oy), nearest first within maxR,
// pulling them toward `to` as a visual. Missing material is conjured as `conjure` for
// conjureCost energy each (if affordable), so moves still work away from their element.
function takeCells(c, kinds, n, ox, oy, maxR, to, conjure, conjureCost) {
  const g = c.grid, p = c.p, fx = Math.floor(ox), fy = Math.floor(oy);
  const found = [];
  for (let r = 0; r <= maxR && found.length < n; r++) {
    for (let dy = -r; dy <= r && found.length < n; dy++) {
      for (let dx = -r; dx <= r && found.length < n; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring at distance r
        const X = fx + dx, Y = fy + dy;
        if (!g.inBounds(X, Y)) continue;
        const i = Y * g.w + X, t = g.type[i];
        if (!kinds.has(t)) continue;
        found.push(t);
        g.type[i] = 0; g.temp[i] = 20; g.life[i] = 0;
        if (to) c.ps.spawn(X + 0.5, Y + 0.5, (to[0] - X) / 4, (to[1] - Y) / 4, t, { ghost: true, gravity: 0, life: 4 });
      }
    }
  }
  while (found.length < n && p.energy >= conjureCost) { p.energy -= conjureCost; found.push(conjure); }
  return found;
}

// Earth: rip ground from around the feet.
function takeGround(c, n, to, conjureCost = 0.6) {
  return takeCells(c, EARTHY, n, c.p.x + BW / 2, c.p.y + BH, 7, to, EL.EARTH, conjureCost);
}

// Water: draw water from anywhere within ~15 cells.
const WATERY = new Set([EL.WATER]);
function takeWater(c, n, to, conjureCost = 0.5) {
  return takeCells(c, WATERY, n, c.center[0], c.center[1], 15, to, EL.WATER, conjureCost);
}

// Freeze a disc (see Grid.freeze).
export function freezeArea(g, x, y, r) {
  g.freeze(x, y, r);
}

// Top of the ground at column x, scanning down from y. -1 if none.
function groundBelow(g, x, y) {
  if (x < 0 || x >= g.w) return -1;
  for (let yy = Math.max(0, Math.floor(y)); yy < g.h; yy++) {
    if (SOLID_KINDS.has(KIND[g.type[yy * g.w + x]])) return yy;
  }
  return -1;
}

// Launch a cluster of rock: one booming core plus followers flying together.
function rockShot(c, types, speed, radius, spread = 1) {
  const [ax, ay] = c.aim, [hx, hy] = c.hand;
  types.forEach((t, k) => {
    const j = () => (Math.random() - 0.5) * spread * Math.sqrt(k);
    c.ps.spawn(hx + j(), hy + j(), ax * speed, ay * speed, t === EL.SAND ? EL.STONE : t,
      { gravity: 0.03, drag: 1, boom: k === 0 ? radius : 0, bounces: k === 0 ? 0 : 1 });
  });
}

// ---------- helpers ----------
// 8-way aim: Up / Down alone = straight up / down, with Left/Right = diagonal, else forward.
function aimOf(p, input) {
  const ay = input.up ? -1 : input.down ? 1 : 0;
  const ax = ay === 0 || input.left || input.right ? p.facing : 0;
  const l = Math.hypot(ax, ay);
  return [ax / l, ay / l];
}

// A fast fire projectile: a tight cluster with one booming core.
function fireball(c, speed, radius, size = 3) {
  const [ax, ay] = c.aim, [hx, hy] = c.hand;
  c.ps.spawn(hx, hy, ax * speed, ay * speed, EL.FIRE, { gravity: 0.012, drag: 1, life: 70, boom: radius });
  for (let k = 1; k < size; k++) {
    const j = () => (Math.random() - 0.5) * 1.2;
    c.ps.spawn(hx - ax * k * 0.7 + j(), hy - ay * k * 0.7 + j(), ax * speed, ay * speed, EL.FIRE, { gravity: 0.012, drag: 1, life: 70 });
  }
}

// ---------- kits ----------
// Move fields: cost (energy to start), cooldown (ticks), pose / poseTime (cast animation),
// cast(ctx) for taps; hold: true + drain (energy/tick), maxHold, start / hold / release for holds.
const KITS = {
  fire: {
    // Z: lightning strike. A short wind-up (sparks crackle at the hands), then an instant jagged
    // bolt along the aim. Ignites and blasts what it hits, fuses sand into glass, and
    // electrifies an entire connected body of water. Long cooldown, big payoff.
    basic: {
      cost: 20, cooldown: 150, pose: 'charge', poseTime: 12,
      cast(c) { c.p.bolt = { t: 0 }; },
    },
    // X: fireballs. Hold to conjure up to 3 fireballs that orbit you; then each tap of X flings
    // one along your aim (they explode on impact, or when they pass close to an enemy).
    heavy: {
      cost: 10, hold: true, drain: 0.45, maxHold: 40, cooldown: 25, pose: 'charge', orbs: true, quietRelease: true,
      hold(c, ch) { drawOrbs(c, orbCount(ch.t), ch.t); },
      release(c, ch) { makeOrbs(c, ch, () => ({})); },
    },
    // C: fire kick barrage. Three fast flaming kicks (two slashes, then a spinning kick), each
    // firing a crescent blade of fire ~75 cells along the aim. Crescents ignite wood / plants,
    // blow loose sand away, burst on rock, and hit each enemy once with knockback.
    special: {
      cost: 22, cooldown: 70, pose: 'slash', poseTime: 6,
      cast(c) { c.p.kicks = { t: 0, aim: c.aim.slice() }; },
    },
    // A: plasma lance (hold 4 s). A plasma ball grows and crackles at your hand while you charge
    // (you move slowly); at full charge a superheated lance fires in a straight line across the
    // whole map and PIERCES everything: it vaporizes a tunnel through rock (glowing molten walls),
    // ignites everything along it, and hits every enemy in the line. Let go early and it fizzles.
    defense: {
      cost: 10, hold: true, drain: 0.25, maxHold: LANCE_CHARGE, cooldown: 150, pose: 'charge',
      hold(c, ch) {
        const k = ch.t / LANCE_CHARGE, [hx, hy] = c.hand, r = 0.8 + k * 3.5;
        c.p.slowT = 2;
        if (k > 0.7) telegraph(c, hx, hy, c.aim[0], c.aim[1], 700, EL.FIRE, ch.t, k > 0.9 ? 3 : 6); // incoming!
        for (let n = 0; n < 6 + k * 18; n++) { // the plasma ball: white-hot core, fiery shell
          const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
          c.ps.spawn(hx + Math.cos(a) * d, hy + Math.sin(a) * d, 0, 0, d < r * 0.5 ? EL.ICE : EL.FIRE, { ghost: true, gravity: 0, life: 1 });
        }
        if (Math.random() < 0.3 + k * 0.6) { // crackling arcs
          let sx = hx, sy = hy;
          for (let s2 = 0; s2 < 3 + k * 6; s2++) { sx += (Math.random() - 0.5) * 3; sy += (Math.random() - 0.5) * 3; spark(c, sx, sy, 0, 0, 1); }
        }
        if (ch.t % 20 === 0) c.fx.shake(1 + k * 3);
      },
      release(c, ch) {
        if (ch.t >= LANCE_CHARGE) { c.p.lance = { t: 11 }; return; } // full charge: fire
        for (let n = 0; n < 12; n++) c.ps.spawn(c.hand[0], c.hand[1], (Math.random() - 0.5) * 2, -Math.random() * 1.5, EL.SMOKE, { ghost: true, gravity: 0, life: 12 }); // fizzle
        c.p.cd.defense = 40;
      },
    },
    // S: fire jet (hold). Flame jets carry you along the arrows (forward by default, Up climbs,
    // Down dives) until you let go or run out of mana; momentum carries on after.
    mobility: {
      cost: 8, hold: true, drain: 1.0, maxHold: 1e9, cooldown: 20, pose: 'dash',
      start(c, ch) { startJet(c, ch); c.p.dashFire = true; },
      hold(c, ch) { jet(c, ch, 3.8); c.p.dashFire = true; },
      release(c, ch) { endJet(c, ch); },
    },
    // V: inferno ascension. A fire power-up transformation: you plant yourself and power up for
    // 1.5 s (flame aura, burning hair, rocks floating up around you, sparks, shockwave pulses),
    // then explode in a massive blast; you stay ascended for 8 s (flame aura, energy always full,
    // cooldowns twice as fast).
    ultimate: {
      cooldown: 60, pose: 'powerup', poseTime: 92,
      cast(c) {
        c.p.ascend = { t: 0 };
        c.fx.shake(4);
      },
    },
  },

  earth: {
    // Z: magma surge. The ground ahead melts into lava, which erupts upward as a geyser of
    // molten rock, then cools into stone / obsidian. Aim up for a taller geyser.
    basic: {
      cost: 18, cooldown: 120, pose: 'slam', poseTime: 16,
      cast(c) {
        const [ax, ay] = c.aim;
        const dist = ax === 0 ? 22 : ay !== 0 ? 30 : 26; // erupts well clear of the bender
        const x = Math.floor(c.center[0] + c.p.facing * dist);
        const gy = groundBelow(c.grid, x, c.p.y + BH - 4);
        if (gy < 0) return;
        c.p.magma = { t: 0, x, y: gy, power: ay < 0 ? 1.5 : 1 };
        c.fx.shake(4);
      },
    },
    // X: stones. Hold to rip rock from the ground into up to 3 stones that orbit you; then each
    // tap of X hurls one along your aim.
    heavy: {
      cost: 8, hold: true, drain: 0.4, maxHold: 40, cooldown: 25, pose: 'lift', orbs: true, quietRelease: true,
      start(c, ch) { ch.rock = []; },
      hold(c, ch) {
        if (ch.t % 2 === 0 && ch.rock.length < 27) ch.rock.push(...takeGround(c, 1, c.center));
        drawOrbs(c, orbCount(ch.t), ch.t, ch.rock);
      },
      release(c, ch) {
        const n = orbCount(ch.t), per = Math.max(6, Math.floor(ch.rock.length / n));
        makeOrbs(c, ch, (k) => { const cells = ch.rock.slice(k * per, (k + 1) * per); while (cells.length < 6) cells.push(EL.STONE); return { cells }; });
      },
    },
    // C: a stone pillar bursts up right in front of you (a wall). Down+C: under your own feet,
    // launching you. Surf or dash into a pillar to fire it forward as a battering ram.
    special: {
      cost: 15, cooldown: 30, pose: 'slam', poseTime: 12,
      cast(c) {
        const under = c.aim[1] > 0 && c.aim[0] === 0;
        const x = Math.floor(c.p.x + BW / 2 + (under ? 0 : c.p.facing * 11));
        const gy = groundBelow(c.grid, x, c.p.y + BH - 3);
        if (gy < 0) return;
        c.p.pillar = { x, base: gy, h: 0, max: 16, launch: under ? 2.6 : 0 };
        c.fx.shake(3);
      },
    },
    // A: stone cage. Rock walls slam up around the nearest enemy (within ~140 cells; otherwise a
    // spot ahead) and a roof crashes down: they're boxed in stone until they blast their way out.
    defense: {
      cost: 20, cooldown: 180, pose: 'lift', poseTime: 14,
      cast(c) {
        const p = c.p;
        let best = null, bd = 140;
        for (const pl of c.world.players || []) {
          if (pl === p || pl.dead || (p.team !== null && pl.team === p.team)) continue;
          const d = Math.hypot(pl.x - p.x, pl.y - p.y);
          if (d < bd) { bd = d; best = pl; }
        }
        const cx = best ? Math.floor(best.x + BW / 2) : Math.floor(c.center[0] + p.facing * 26);
        const feet = best ? Math.floor(best.y + BH) : groundBelow(c.grid, cx, p.y);
        p.cage = { t: 0, cx, feet, victim: best };
        c.fx.shake(3);
      },
    },
    // S: sand jet (hold). On the ground, going sideways: surf a wave of real sand. Otherwise a
    // jet of sand from your feet carries you along the arrows. Surf / jet into a pillar to fire it.
    mobility: {
      cost: 8, hold: true, drain: 0.8, maxHold: 1e9, cooldown: 20, pose: 'surf',
      start(c, ch) { startJet(c, ch); },
      hold(c, ch) {
        const p = c.p, [, ay] = c.aim;
        if (p.onGround && Math.abs(ay) < 0.1 && !ch.flying) { // ground surf
          ch.vx += (p.facing * 3.2 - ch.vx) * 0.2; ch.vy = 0;
          p.dashT = 0; p.surfT = 2; p.surfVX = ch.vx; p.jetType = 0;
          p.cast = { pose: 'surf', t: 2 };
        } else {
          ch.flying = true; // once airborne, stay in jet mode until released
          jet(c, ch, 3.3);
          p.jetType = EL.SAND;
        }
      },
      release(c, ch) { endJet(c, ch); },
    },
    // V: tectonic rupture. A fissure races forward ~110 cells: 12 stone spikes erupt in sequence,
    // each taller than the last, hurling debris; then they all shatter at once into rubble.
    ultimate: {
      cooldown: 60, pose: 'slam', poseTime: 40,
      cast(c) {
        c.p.rupture = { t: 0, x0: c.p.x + BW / 2, y0: c.p.y, f: c.p.facing, next: 0, spikes: [], done: -1 };
        c.fx.shake(8);
        for (let d = 6; d < 112; d += 3) { // the fissure cracks open along the ground first
          const x = c.p.x + BW / 2 + c.p.facing * d, gy = groundBelow(c.grid, Math.floor(x), c.p.y);
          if (gy >= 0) c.ps.spawn(x, gy - 1, 0, -0.4 - Math.random() * 0.6, EL.SAND, { ghost: true, gravity: 0.05, life: 10 + d / 6 });
        }
      },
    },
  },

  water: {
    // Z: water whip. A lash of water cracks out ~45 cells along your aim. Press again within half
    // a second for the follow-up lash, which yanks whoever it hits toward you. Douses fire.
    basic: {
      cost: 12, cooldown: 12, pose: 'slash', poseTime: 10,
      ready(c) { return !(c.p.whipLock > 0); },
      cast(c) {
        const p = c.p, second = p.whipCombo > 0;
        p.whips.push({ t: 0, aim: c.aim.slice(), second, hit: new Set() });
        p.whipCombo = second ? 0 : 32;
        if (second) p.whipLock = 45;
        p.cast = { pose: second ? 'slashUp' : 'slash', t: 10 };
        p.vx += p.facing * 0.3;
      },
    },
    // X: ice spears. Hold to draw water into up to 3 ice spears that orbit you; then each tap
    // of X fires one along your aim (freezes the area it hits).
    heavy: {
      cost: 8, hold: true, drain: 0.4, maxHold: 40, cooldown: 25, pose: 'lift', orbs: true, quietRelease: true,
      start(c, ch) { ch.n = 0; },
      hold(c, ch) {
        if (ch.t % 2 === 0 && ch.n < 18) ch.n += takeWater(c, 1, c.center).length;
        drawOrbs(c, orbCount(ch.t), ch.t);
      },
      release(c, ch) { const n = orbCount(ch.t); makeOrbs(c, ch, () => ({ shards: Math.max(6, Math.round(ch.n / n)) })); },
    },
    // C: bubble trap. Throws a water orb; the first enemy it touches is engulfed in a bubble and
    // floats helplessly, slowly drowning, for 2 s, then it pops in a splash. Flash Freeze (A)
    // while someone is trapped freezes the bubble solid around them (3 s).
    special: {
      cost: 20, cooldown: 90, pose: 'palms', poseTime: 10,
      cast(c) {
        const [ax, ay] = c.aim, [hx, hy] = c.hand;
        c.p.bubbles.push({ x: hx + ax * 3, y: hy + ay * 3, vx: ax * 5, vy: ay * 5, life: 48 });
      },
    },
    // A: flash freeze. Everything within ~40 cells freezes in an instant: water -> ice, lava ->
    // obsidian, fire dies, and enemies caught are frozen solid for 2 s. Hitting a frozen enemy
    // shatters the ice for bonus damage (and frees them).
    defense: {
      cost: 25, cooldown: 200, pose: 'guard', poseTime: 16,
      cast(c) {
        const g = c.grid, p = c.p, [cx, cy] = c.center, R = 40;
        // Freeze the world around you (but not the cells you're standing in).
        for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
          if (dx * dx + dy * dy > R * R) continue;
          const x = cx + dx, y = cy + dy;
          if (Math.abs(dx) < 4 && Math.abs(dy) < 8) continue;
          g.freeze(x, y, 1.6);
        }
        let total = 0;
        for (const pl of c.world.players || []) {
          if (pl === p || pl.dead) continue;
          if (Math.hypot(pl.x + BW / 2 - cx, pl.y + BH / 2 - cy) > R + 2) continue;
          const hit = pl.damage(10, p.id); if (!hit) continue; total += hit; pl.frozenT = 120; pl.stunT = 120; pl.vx = 0; pl.vy = 0; pl.shatterable = true;
        }
        creditDamage(c.world, p.id, total);
        // Combo: anyone in your bubble trap (any range) freezes solid inside it.
        for (const pl of c.world.players || []) {
          if (!pl.bubble || pl.bubble.by !== p.id || pl.dead) continue;
          pl.frozenT = 180; pl.stunT = 180; pl.vx = 0; pl.vy = 0; pl.shatterable = true;
          popBubble(c, pl, EL.ICE);
          emit('combo', pl.x);
        }
        p.freezeBurst = { t: 0, x: cx, y: cy, R };
        c.fx.shake(5);
        if (c.fx.flash) c.fx.flash(2);
      },
    },
    // S: riptide (hold). A jet of real water carries you along the arrows until you let go or run
    // out of mana. Faster, and much cheaper, while you're in water.
    mobility: {
      cost: 8, hold: true, drain: 0.9, maxHold: 1e9, cooldown: 20, pose: 'dash',
      start(c, ch) { startJet(c, ch); },
      hold(c, ch) {
        const inWater = c.p.anim && c.p.anim.state === 'swim';
        if (inWater) c.p.energy = Math.min(MAX_ENERGY, c.p.energy + 0.5);
        jet(c, ch, inWater ? 4.6 : 3.5);
        c.p.jetType = EL.WATER;
      },
      release(c, ch) { endJet(c, ch); },
    },
    // V: glacial cataclysm. A huge tsunami rises and surges forward; mid-crash the whole wave
    // flash-freezes in the air; then it shatters into a storm of ice shards blasting forward.
    ultimate: {
      cooldown: 60, pose: 'wave', poseTime: 60,
      cast(c) {
        c.p.tsunami = { t: 0, x0: c.p.x + BW / 2, f: c.p.facing, ground: groundBelow(c.grid, Math.floor(c.p.x + BW / 2), c.p.y + 2) };
        c.fx.shake(6);
      },
    },
  },

  air: {
    // Z: vacuum sphere. Fires a sphere that stops where it hits (or at range) and becomes a
    // vacuum: sand, water, fire and debris around it are violently sucked into one dense ball,
    // which then pops and flings everything outward.
    basic: {
      cost: 15, cooldown: 100, pose: 'palms', poseTime: 10,
      cast(c) {
        const [ax, ay] = c.aim, [hx, hy] = c.hand;
        c.p.vacuums.push({ x: hx, y: hy, vx: ax * 7, vy: ay * 7, t: 0, phase: 'fly' });
      },
    },
    // X: air cannons. Hold to compress up to 3 balls of air that orbit you; then each tap of X
    // fires one as a pressure sphere that bursts into a wind shockwave.
    heavy: {
      cost: 8, hold: true, drain: 0.45, maxHold: 40, cooldown: 25, pose: 'charge', orbs: true, quietRelease: true,
      hold(c, ch) { drawOrbs(c, orbCount(ch.t), ch.t); c.grid.addWind(c.center[0], c.center[1], 10, 0, 0); },
      release(c, ch) { makeOrbs(c, ch, () => ({})); },
    },
    // C: tornado, aimable: forward = travels along the ground, up / diagonal = flies that way,
    // down = spawns under you and carries you up. Sucks in loose stuff and spins it up the
    // funnel (fire -> fire tornado, water -> waterspout), flinging it out the top.
    special: {
      cost: 22, cooldown: 60, pose: 'spin', poseTime: 16,
      cast(c) {
        const [ax, ay] = c.aim, under = ax === 0 && ay > 0;
        const x = under ? c.center[0] : c.center[0] + ax * 14;
        const y = under ? c.p.y + BH : ay < 0 ? c.center[1] + ay * 10 : c.p.y + BH;
        c.p.tornados.push({ x, y, vx: under ? 0 : ax * 0.9, vy: under ? 0 : ay * 0.9, ground: ay === 0 || under, t: 0, life: 240, h: 54 });
        c.fx.shake(3);
      },
    },
    // A: sonic clap (hold 2.5 s). Air swirls in between your hands while you charge (you move
    // slowly); at full charge the clap goes off: a shockwave cone (~60 cells, +-35 degrees) along
    // your aim pulverizes every solid in it to powder and blasts everything away; enemies are
    // thrown back and stunned for 1 s. Let go early and it fizzles.
    defense: {
      cost: 8, hold: true, drain: 0.2, maxHold: CLAP_CHARGE, cooldown: 120, pose: 'charge',
      hold(c, ch) {
        const k = ch.t / CLAP_CHARGE, [hx, hy] = c.hand;
        c.p.slowT = 2;
        if (k > 0.75) { // the cone edges (+-35 degrees, ~60 cells)
          const a0 = Math.atan2(c.aim[1], c.aim[0]);
          for (const da of [-0.61, 0.61]) telegraph(c, hx, hy, Math.cos(a0 + da), Math.sin(a0 + da), 60, EL.STEAM, ch.t, 4);
        }
        for (let n = 0; n < 4 + k * 10; n++) { // air spiralling in between the hands
          const a = ch.t * 0.4 + n * 1.3, r = 3 + (1 - k) * 8 + Math.random() * 3;
          streak(c, hx + Math.cos(a) * r, hy + Math.sin(a) * r * 0.8, -Math.cos(a) * 0.8, -Math.sin(a) * 0.6, 2);
        }
        if (ch.t % 15 === 0) c.grid.addWind(hx, hy, 10, 0, 0);
        if (ch.t % 30 === 0) c.fx.shake(1 + k * 2);
      },
      release(c, ch) {
        if (ch.t < CLAP_CHARGE) { // fizzle
          for (let n = 0; n < 10; n++) streak(c, c.hand[0], c.hand[1], (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 6);
          c.p.cd.defense = 30;
          return;
        }
        sonicClap(c);
        c.p.cast = { pose: 'palms', t: 12 };
      },
    },
    // S: air flight (hold). Ride a rushing current of wind along the arrows until you let go or run
    // out of mana, leaving fading wind afterimages.
    mobility: {
      cost: 8, hold: true, drain: 0.85, maxHold: 1e9, cooldown: 20, pose: 'dash',
      start(c, ch) { startJet(c, ch); },
      hold(c, ch) {
        const p = c.p;
        jet(c, ch, 4.0);
        if (ch.t % 2 === 0) p.afterimages.push({ x: p.x, y: p.y, j: p.anim.j, facing: p.facing, life: 9 });
        c.grid.addWind(c.center[0], c.center[1], 5, ch.vx * 0.4, ch.vy * 0.4);
        p.usedDouble = false;
      },
      release(c, ch) { endJet(c, ch); },
    },
    // V: wind dragon: a serpent of wind snakes across the battlefield in swooping curves,
    // tearing up the ground and carrying the debris in its body, loops back at the edges, then
    // dives and crashes in a huge blast that flings everything it carried.
    ultimate: {
      cooldown: 60, pose: 'sky', poseTime: 24,
      cast(c) {
        const [cx, cy] = c.center;
        c.p.dragon = { t: 0, x: cx, y: cy - 6, a: c.p.facing > 0 ? -0.5 : Math.PI + 0.5, hist: [], turn: 0, turnDir: 1 };
        c.fx.shake(6);
      },
    },
  },
};

const TSUNAMI_TAG = 7;

// The sonic clap itself (fired at full charge).
function sonicClap(c) {
  const g = c.grid, ps = c.ps, p = c.p, [ax, ay] = c.aim, [hx, hy] = c.hand, base = Math.atan2(ay, ax);
  const R = 60, HALF = 0.62;
  // Everything in the cone: solids are pulverized to powder (stone / glass / obsidian -> sand,
  // wood / plants -> ash), then the whole lot is blown away, hardest up close.
  for (let Y = Math.floor(hy - R); Y <= hy + R; Y++) {
    for (let X = Math.floor(hx - R); X <= hx + R; X++) {
      if (!g.inBounds(X, Y)) continue;
      const dx = X + 0.5 - hx, dy = Y + 0.5 - hy, d = Math.hypot(dx, dy);
      if (d < 2 || d > R) continue;
      let da = Math.atan2(dy, dx) - base; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) > HALF) continue;
      const i = Y * g.w + X, t = g.type[i];
      if (t === 0) continue;
      if (PULVERIZE[t]) g.type[i] = PULVERIZE[t];
      const k = 1 - d / R;
      // Thrown out along the aim and upward so it arcs clear of the crater instead of slamming
      // back into the ground beyond it.
      const a = base + da * 0.35 + (Math.random() - 0.5) * 0.25, sp = 4 + 8 * k * (0.7 + Math.random() * 0.6);
      ps.lift(X, Y, Math.cos(a) * sp, Math.sin(a) * sp * 0.5 - (1.5 + 3 * k + Math.random()), { bounces: 1, dmg: 0.15 });
    }
  }
  for (let d = 6; d < R; d += 10) for (const s of [-1, 0, 1]) { // shove the air itself
    const a = base + s * HALF * 0.7;
    g.addWind(hx + Math.cos(a) * d, hy + Math.sin(a) * d, 8, Math.cos(a) * 5, Math.sin(a) * 5);
  }
  let total = 0;
  for (const pl of c.world.players || []) {
    if (pl === p || pl.dead) continue;
    const dx = pl.x + BW / 2 - hx, dy = pl.y + BH / 2 - hy, d = Math.hypot(dx, dy);
    if (d > R) continue;
    let da = Math.atan2(dy, dx) - base; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
    if (Math.abs(da) > HALF + 0.15) continue;
    const k = 1 - d / R;
    const hit = pl.damage(8 + 12 * k, p.id); if (!hit) continue; total += hit;
    pl.vx += Math.cos(base) * (2 + 4 * k); pl.vy += Math.sin(base) * (2 + 4 * k) - 1.5;
    pl.stunT = Math.max(pl.stunT || 0, 60);
  }
  creditDamage(c.world, p.id, total);
  p.claps.push({ t: 0, x: hx, y: hy, base, R, HALF });
  c.fx.shake(6);
  if (c.fx.flash) c.fx.flash(1);
}

// Where the air cannon ball forms: out in front of the hands along the aim.
function cannonPos(c) {
  const [ax, ay] = c.aim, [cx, cy] = c.center;
  return [cx + ax * 6, cy - 2 + ay * 6];
}

// Pale wind streak (visual only).
function streak(c, x, y, vx = 0, vy = 0, life = 2) {
  c.ps.spawn(x, y, vx, vy, EL.STEAM, { ghost: true, gravity: 0, life });
}

// ---------- air: blades, cannon balls, tornados, air step, wind dragon ----------
const DRAGON_TAG = 8;
const THROWN_TAG = 9; // flung out of a tornado's top: falls freely, isn't re-caught

function airOngoing(c) {
  const p = c.p, g = c.grid, ps = c.ps;

  p.afterimages = p.afterimages.filter((a) => --a.life > 0);

  // Air blades: a crescent whose leading arc sweeps the air; loose cells along the arc are
  // sliced away; the center bursts on solid ground.
  p.blades = p.blades.filter((b) => {
    b.t++;
    const sp = Math.hypot(b.vx, b.vy), dx = b.vx / sp, dy = b.vy / sp, px = -dy, py = dx;
    const R = 6 + Math.min(1, b.t / 12) * 9; // grows as it flies
    const arc = (th) => [b.x + dx * (Math.cos(th) - 1) * R * 0.6 + px * Math.sin(th) * R,
                         b.y + dy * (Math.cos(th) - 1) * R * 0.6 + py * Math.sin(th) * R];
    const steps = Math.ceil(sp);
    for (let s = 0; s < steps; s++) {
      b.x += dx; b.y += dy;
      if (b.x < -20 || b.x > g.w + 20 || b.y > g.h + 5 || b.y < -40) return false;
      const X = Math.floor(b.x), Y = Math.floor(b.y);
      if (g.inBounds(X, Y)) {
        const t = g.type[Y * g.w + X];
        if (t !== 0 && KIND[t] === Kind.STATIC) { explode(c.world, b.x - dx * 2, b.y - dy * 2, 4.5, 0); return false; }
      }
      for (let th = -1.2; th <= 1.2; th += 0.2) { // slice along the whole arc
        const [ax, ay] = arc(th), AX = Math.floor(ax), AY = Math.floor(ay);
        if (!g.inBounds(AX, AY)) continue;
        const t = g.type[AY * g.w + AX], kind = KIND[t];
        if (kind === Kind.POWDER || kind === Kind.LIQUID) {
          const side = Math.sign(th) || 1;
          ps.lift(AX, AY, dx * 5 + px * side * 2.5, dy * 5 + py * side * 2.5 - 1, { bounces: 1 });
        }
      }
    }
    // Draw: two nested arcs (a thick crescent, tilted up or down) + curling eddies off the tips.
    for (let th = -1.25; th <= 1.25; th += 0.09) {
      const tt = th + b.tilt * 0.25;
      const [ax, ay] = arc(tt);
      streak(c, ax, ay, 0, 0, 1);
      if (Math.abs(th) < 1.05) streak(c, ax - dx, ay - dy, 0, 0, 1);       // thick in the middle,
      if (Math.abs(th) < 0.7) streak(c, ax - dx * 2, ay - dy * 2, 0, 0, 1); // thin at the tips
    }
    if (b.t % 2 === 0) for (const side of [-1.2, 1.2]) {
      const [ex, ey] = arc(side + b.tilt * 0.25);
      streak(c, ex, ey, -dx * 1.5 + px * side * 0.8, -dy * 1.5 + py * side * 0.8, 7);
    }
    g.addWind(b.x, b.y, 5, dx * 3, dy * 3);
    if (--b.life <= 0) { explode(c.world, b.x, b.y, 3, 0); return false; }
    return true;
  });

  // Air cannon balls: burst into a shockwave on touching anything (or at max range).
  p.cannons = p.cannons.filter((b) => {
    const sp = Math.hypot(b.vx, b.vy), dx = b.vx / sp, dy = b.vy / sp, steps = Math.ceil(sp);
    let hit = --b.life <= 0;
    for (let s = 0; s < steps && !hit; s++) {
      b.x += dx; b.y += dy;
      const X = Math.floor(b.x), Y = Math.floor(b.y);
      if (X < 0 || X >= g.w || Y >= g.h) { hit = true; break; }
      if (bodyAt(c.world, b.x, b.y, p.id, 4 + b.r)) { hit = true; break; } // proximity burst
      if (Y < 0) continue;
      const t = g.type[Y * g.w + X];
      if (t !== 0 && KIND[t] !== Kind.GAS) hit = true;
    }
    if (hit) {
      const R = b.orb ? 6.5 : 6 + b.power * 10;
      explode(c.world, b.x, b.y, R, 0);
      if (!b.orb) explode(c.world, b.x, b.y, R * 0.6, 0); // second pass: inner core blown out harder
      for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; streak(c, b.x, b.y, Math.cos(a) * 3, Math.sin(a) * 3, 6); }
      return false;
    }
    for (let k = 0; k < 8; k++) { const a = b.life * 0.8 + k * 0.8; streak(c, b.x + Math.cos(a) * b.r, b.y + Math.sin(a) * b.r); }
    return true;
  });

  // Tornados: a cone (narrow base, wide top) drawn as 5 helical bands spinning around it, bright
  // on the front side and dim on the back. Debris orbits up the cone and drops out the top.
  p.tornados = p.tornados.filter((tn) => {
    tn.t++;
    tn.x += tn.vx; tn.y += tn.vy;
    if (tn.ground) { const gy = groundBelow(g, Math.floor(tn.x), tn.y - 12); if (gy > 0) tn.y = gy; }
    if (tn.x < -10 || tn.x > g.w + 10 || tn.y < -tn.h || tn.t > tn.life) return false;
    const H = tn.h, top = tn.y - H, spin = tn.t * 0.32, lean = tn.vx * 4; // top leans with travel
    const fade = Math.max(0.05, Math.min(1, tn.t / 12, (tn.life - tn.t) / 20));
    const radius = (h) => (1.5 + Math.pow(Math.max(0, Math.min(1, h)), 1.3) * 13) * fade; // h = 0 (base) .. 1 (top)
    const axisX = (h) => tn.x + lean * h + Math.sin(tn.t * 0.07 + h * 2) * 1.5 * h;

    // Suck in: surface ground near the base, plus fire / smoke / water inside the funnel.
    const grab = (X, Y) => {
      if (!g.inBounds(X, Y)) return;
      const t = g.type[Y * g.w + X], kind = KIND[t];
      if (kind === Kind.POWDER || kind === Kind.LIQUID || t === EL.FIRE || t === EL.SMOKE) ps.lift(X, Y, (tn.x - X) * 0.15, -1.2, { bounces: 1 });
    };
    for (let k = 0; k < 4; k++) {
      const X = Math.floor(tn.x + (Math.random() - 0.5) * 18);
      const s0 = groundBelow(g, X, tn.y - 16);
      if (s0 >= 0) grab(X, s0);
    }
    for (let k = 0; k < 5; k++) grab(Math.floor(tn.x + (Math.random() - 0.5) * 26), Math.floor(tn.y - Math.random() * H));

    // Orbit captured material up the cone; at the top it's released and falls out.
    for (let i = 0; i < ps.n; i++) {
      if (ps.ghost[i] || ps.tag[i]) continue;
      const py = ps.y[i];
      if (py > tn.y + 2 || py < top - 2) continue;
      const h = (tn.y - py) / H, r = radius(h), ax = axisX(h);
      if (Math.abs(ps.x[i] - ax) > r + 5) continue;
      if (h > 0.92) { ps.vx[i] = (ps.x[i] >= ax ? 1 : -1) * (1.2 + Math.random() * 1.5); ps.vy[i] = -0.4; ps.tag[i] = THROWN_TAG; continue; }
      const ph = spin * 1.3 + i * 2.4;
      ps.vx[i] = (ax + Math.sin(ph) * r - ps.x[i]) * 0.35 + tn.vx;
      ps.vy[i] = -0.9 + tn.vy;
    }

    // Enemies caught in the funnel are spun up it and battered.
    for (const pl of c.world.players || [c.world.player]) {
      if (!pl || pl.dead || pl.id === p.id) continue;
      const ex = pl.x + BW / 2 - tn.x, ey = pl.y + BH;
      if (Math.abs(ex) < 7 && ey <= tn.y + 2 && ey > top) {
        pl.vy = Math.min(pl.vy, -1.1); pl.vx += -ex * 0.06 + tn.vx * 0.5;
        if (tn.t % 4 === 0) hurt(c.world, pl, 1.5, p.id);
      }
    }

    // Ride it.
    const pdx = p.x + BW / 2 - tn.x, ppy = p.y + BH;
    if (Math.abs(pdx) < 5 && ppy <= tn.y + 2 && ppy > top) { p.vy = Math.min(p.vy, -1.2); p.vx += -pdx * 0.05 + tn.vx * 0.5; }

    // Draw the helical bands.
    for (let b = 0; b < 5; b++) {
      for (let h = 0; h <= 1.001; h += 1.4 / H) {
        const ang = spin + (b * Math.PI * 2) / 5 + h * 5;
        const x = axisX(h) + Math.sin(ang) * radius(h), y = tn.y - h * H;
        ps.spawn(x, y, 0, 0, Math.cos(ang) > 0 ? EL.STEAM : EL.SMOKE, { ghost: true, gravity: 0, life: 1 });
      }
    }
    for (let y = tn.y; y > top; y -= 8) {
      const [, wy] = g.windAt(tn.x, Math.max(0, y));
      if (wy > -1.5) g.addWind(tn.x, y, 5, 0, -0.3);
    }
    return true;
  });

  // Wind dragon: the head flies at 5 cells/tick on a swooping path over the ground, loops back
  // at the screen edges, carries what it tears up along its body, and after ~125 ticks dives
  // into the ground and explodes.
  const dr = p.dragon;
  if (dr) {
    dr.t++;
    const diving = dr.t > 125;
    const ground = groundBelow(g, Math.max(0, Math.min(g.w - 1, Math.floor(dr.x))), 0);
    const gy = ground > 0 ? ground : g.h - 1;
    const targetY = diving ? gy + 4 : gy - 22 + Math.sin(dr.t * 0.09) * 26; // swoops dip into the ground
    let hx = Math.cos(dr.a);
    if (dr.turn <= 0 && ((dr.x < 48 && hx < -0.3) || (dr.x > g.w - 48 && hx > 0.3))) { dr.turn = 24; dr.turnDir = hx > 0 ? -1 : 1; }
    if (dr.turn > 0) { dr.a += dr.turnDir * (Math.PI / 24); dr.turn--; } // half-loop over the top
    else { // steer toward the swoop height
      const want = Math.atan2(targetY - dr.y, hx >= 0 ? 30 : -30);
      let d = want - dr.a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      dr.a += Math.max(-0.09, Math.min(0.09, d));
    }
    hx = Math.cos(dr.a); const hy = Math.sin(dr.a);
    const speed = diving ? 6.5 : 5;
    dr.x += hx * speed; dr.y += hy * speed;
    dr.hist.unshift([dr.x, dr.y]);
    if (dr.hist.length > 46) dr.hist.pop();

    // Tear up whatever the head passes over / through (up to a limit) and wire it to the body.
    let carried = 0;
    for (let i = 0; i < ps.n; i++) if (ps.tag[i] === DRAGON_TAG) carried++;
    for (let k = 0; k < 24 && carried < 700; k++) {
      const X = Math.floor(dr.x + (Math.random() - 0.5) * 18), Y = Math.floor(dr.y + (Math.random() - 0.5) * 18);
      if (!g.inBounds(X, Y)) continue;
      const t = g.type[Y * g.w + X], kind = KIND[t];
      if (kind === Kind.POWDER || kind === Kind.LIQUID || t === EL.FIRE) {
        // Carried debris rides inside the wind (passes through things) until the crash.
        const i = ps.lift(X, Y, hx * 3, hy * 3, { ghost: true, gravity: 0, life: 400 });
        if (i >= 0) { ps.tag[i] = DRAGON_TAG; carried++; }
      }
    }
    // Carried debris streams along the body.
    const L = dr.hist.length;
    for (let i = 0; i < ps.n; i++) {
      if (ps.tag[i] !== DRAGON_TAG) continue;
      const seg = dr.hist[Math.min(L - 1, 3 + ((i * 7) % Math.max(1, L - 3)))];
      const off = ((i * 13) % 7) - 3;
      ps.vx[i] = (seg[0] + off * -hy - ps.x[i]) * 0.3;
      ps.vy[i] = (seg[1] + off * hx - ps.y[i]) * 0.3;
    }
    // Draw the body as a tapering ribbon of wind, thickest just behind the head.
    for (let k = 0; k < L; k++) {
      const [bx, by] = dr.hist[k], r = 1 + 7 * Math.sin(Math.min(1, (k + 3) / 14) * Math.PI / 2) * (1 - k / L);
      const n = 2 + Math.round(r);
      for (let m = 0; m < n; m++) {
        const a = Math.random() * Math.PI * 2, rr = Math.random() * r;
        ps.spawn(bx + Math.cos(a) * rr, by + Math.sin(a) * rr, 0, 0, m % 3 ? EL.STEAM : EL.SMOKE, { ghost: true, gravity: 0, life: 1 });
      }
    }
    for (let k = 0; k < 6; k++) { // head + two whiskers streaming back
      ps.spawn(dr.x + hx * k * 0.5, dr.y + hy * k * 0.5, 0, 0, EL.STEAM, { ghost: true, gravity: 0, life: 1 });
      for (const s of [-1, 1]) ps.spawn(dr.x - hx * k * 1.5 + s * -hy * (2 + k * 0.6), dr.y - hy * k * 1.5 + s * hx * (2 + k * 0.6), 0, 0, EL.STEAM, { ghost: true, gravity: 0, life: 1 });
    }
    g.addWind(dr.x, dr.y, 8, hx * 4, hy * 4);
    const bit = bodyAt(c.world, dr.x, dr.y, p.id, 6); // the head rams anyone in its way
    if (bit && dr.t % 3 === 0) { hurt(c.world, bit, 3, p.id); bit.vx += hx * 1.5; bit.vy += hy * 1.5 - 0.5; }
    c.fx.shake(2);

    // Crash: dives into the ground (or times out) and everything it carried is flung forward.
    const X = Math.floor(dr.x), Y = Math.floor(dr.y);
    const hitGround = diving && (Y >= g.h - 1 || (g.inBounds(X, Y) && g.type[Y * g.w + X] !== 0 && KIND[g.type[Y * g.w + X]] !== Kind.GAS));
    if (hitGround || dr.t > 200) {
      for (let i = 0; i < ps.n; i++) {
        if (ps.tag[i] !== DRAGON_TAG) continue;
        ps.tag[i] = 0; ps.ghost[i] = 0; ps.life[i] = 0; ps.g[i] = 0.08; // solid again
        const a = dr.a + (Math.random() - 0.5) * 2.2, sp = 6 + Math.random() * 6;
        ps.vx[i] = Math.cos(a) * sp; ps.vy[i] = Math.sin(a) * sp - 3;
      }
      explode(c.world, dr.x - hx * 3, dr.y - hy * 3, 14, 0);
      for (let k = 0; k < 48; k++) { const a = (k / 48) * Math.PI * 2; streak(c, dr.x, dr.y, Math.cos(a) * 5, Math.sin(a) * 5, 10); }
      c.fx.shake(12);
      p.dragon = null;
    }
  }
}




// ---------- A moves: plasma lance, stone cage, flash freeze, sonic clap ----------
function aOngoing(c) {
  const p = c.p, g = c.grid, ps = c.ps;

  // Stunned bodies: little sparks circling the head.
  for (const pl of c.world.players || [c.world.player]) {
    if (!pl || pl.dead || !(pl.stunT > 0) || pl.frozenT > 0 || pl !== p) continue;
    const a = pl.stunT * 0.4;
    for (const s of [0, Math.PI]) ps.spawn(pl.x + BW / 2 + Math.cos(a + s) * 3, pl.y - 3 + Math.sin(a + s) * 1, 0, 0, EL.ICE, { ghost: true, gravity: 0, life: 1 });
  }

  // Plasma lance: gather for 12 ticks, then fire the beam; it lingers and fades for 10 ticks.
  const ln = p.lance;
  if (ln) {
    ln.t++;
    const [hx, hy] = c.hand;
    if (ln.t < 12) {
      for (let k = 0; k < 8; k++) { // plasma condensing at the hand
        const a = Math.random() * Math.PI * 2, r = 6 - ln.t * 0.4;
        ps.spawn(hx + Math.cos(a) * r, hy + Math.sin(a) * r, -Math.cos(a) * 0.5, -Math.sin(a) * 0.5, k % 2 ? EL.FIRE : EL.ICE, { ghost: true, gravity: 0, life: 2 });
      }
      c.fx.shake(1);
    } else if (ln.t === 12) {
      const [ax, ay] = c.aim, px = -ay, py = ax;
      const path = [];
      let x = hx, y = hy;
      while (x > -2 && x < g.w + 2 && y > -2 && y < g.h + 2) { path.push([x, y]); x += ax; y += ay; }
      ln.path = path; ln.ax = ax; ln.ay = ay;
      for (const [bx, by] of path) { // melt / vaporize a tunnel along the line
        for (let o = -3; o <= 3; o++) {
          const X = Math.floor(bx + px * o), Y = Math.floor(by + py * o);
          if (!g.inBounds(X, Y)) continue;
          const i = Y * g.w + X, t = g.type[i], ao = Math.abs(o);
          if (t === 0) { if (ao <= 1 && Math.random() < 0.3) g.set(X, Y, EL.FIRE); continue; }
          if (ao <= 1) { if (KIND[t] !== Kind.GAS) g.transform(i, Math.random() < 0.15 ? EL.FIRE : EL.EMPTY); }
          else if (ao === 2) { if (t === EL.SAND) g.transform(i, EL.GLASS); else if (MELTS[t] || EARTHY.has(t)) { g.transform(i, EL.LAVA); g.temp[i] = 1300; } else g.temp[i] += 700; }
          else g.temp[i] += 400;
        }
      }
      let total = 0; // every enemy in the line
      for (const pl of c.world.players || []) {
        if (pl === p || pl.dead) continue;
        const bx = pl.x + BW / 2, by = pl.y + BH / 2;
        const t = (bx - hx) * ax + (by - hy) * ay, off = Math.abs((bx - hx) * px + (by - hy) * py);
        if (t > 0 && off < 7) { const hit = pl.damage(40, p.id); if (hit) { total += hit; pl.vx += ax * 3; pl.vy += ay * 3 - 1; } }
      }
      creditDamage(c.world, p.id, total);
      p.vx -= ax * 1.2; p.vy -= ay * 0.6;
      c.fx.shake(8);
      if (c.fx.flash) c.fx.flash(4);
      p.cast = { pose: 'punch', t: 14 };
    }
    if (ln.path && ln.t <= 22) { // the beam: white-hot core, orange glow, thinning out
      const fade = ln.t - 12, w = Math.max(0, 2 - fade * 0.25), px = -ln.ay, py = ln.ax;
      for (let k = 0; k < ln.path.length; k++) {
        const [bx, by] = ln.path[k];
        ps.spawn(bx, by, 0, 0, fade < 5 ? EL.ICE : EL.FIRE, { ghost: true, gravity: 0, life: 1 });
        for (let o = 1; o <= w; o++) for (const s of [-1, 1]) ps.spawn(bx + px * o * s, by + py * o * s, 0, 0, EL.FIRE, { ghost: true, gravity: 0, life: 1 });
      }
    }
    if (ln.t > 22) p.lance = null;
  }

  // Stone cage: walls rise from the ground on both sides over 6 ticks, then the roof slams down.
  const cg = p.cage;
  if (cg) {
    cg.t++;
    const { cx, feet } = cg, top = feet - BH - 4, x0 = cx - 6, x1 = cx + 6;
    const setStone = (X, Y) => {
      if (!g.inBounds(X, Y)) return;
      const t = g.type[Y * g.w + X];
      if (t !== 0 && KIND[t] !== Kind.GAS && KIND[t] !== Kind.STATIC) ps.lift(X, Y, (Math.random() - 0.5) * 2, -3, { bounces: 1 });
      g.set(X, Y, EL.STONE);
    };
    if (cg.t <= 6) {
      const k = cg.t / 6, h = Math.floor((feet - top) * k);
      for (let y = feet; y > feet - h; y--) for (const x of [x0, x0 + 1, x1 - 1, x1]) setStone(x, y);
    } else if (cg.t === 8) {
      for (let x = x0; x <= x1; x++) { setStone(x, top); setStone(x, top - 1); }
      for (let x = x0; x <= x1; x++) for (const y of [feet + 1, feet + 2]) if (g.inBounds(x, y) && g.type[y * g.w + x] === 0) setStone(x, y); // floor if it's in the air
      if (cg.victim && !cg.victim.dead && cg.victim.damage(8, p.id)) { creditDamage(c.world, p.id, 8); cg.victim.stunT = Math.max(cg.victim.stunT || 0, 20); }
      c.fx.shake(6);
      for (let k = 0; k < 20; k++) ps.spawn(cx + (Math.random() - 0.5) * 14, top - 1, (Math.random() - 0.5) * 2, -1 - Math.random(), EL.SAND, { ghost: true, gravity: 0.15, life: 10 });
      p.cage = null;
    }
  }

  // Flash freeze: a ring of frost racing outward + icy mist.
  const fb = p.freezeBurst;
  if (fb) {
    fb.t++;
    const r = Math.min(fb.R, 4 + fb.t * 3);
    for (let k = 0; k < 40; k++) { const a = Math.random() * Math.PI * 2; ps.spawn(fb.x + Math.cos(a) * r, fb.y + Math.sin(a) * r, 0, 0, k % 3 ? EL.ICE : EL.GLASS, { ghost: true, gravity: 0, life: 1 }); }
    for (let k = 0; k < 4; k++) ps.spawn(fb.x + (Math.random() - 0.5) * r * 2, fb.y + (Math.random() - 0.5) * r * 1.5, 0, -0.2, EL.STEAM, { ghost: true, gravity: 0, life: 12 });
    if (fb.t > 10) p.freezeBurst = null;
  }

  // Sonic clap: arcs of the shockwave expanding through the cone.
  p.claps = p.claps.filter((cl) => {
    cl.t++;
    for (const r of [cl.t * 6, cl.t * 6 - 5]) {
      if (r <= 2 || r > cl.R) continue;
      for (let a = -cl.HALF; a <= cl.HALF; a += 0.04) ps.spawn(cl.x + Math.cos(cl.base + a) * r, cl.y + Math.sin(cl.base + a) * r, 0, 0, EL.STEAM, { ghost: true, gravity: 0, life: 1 });
    }
    return cl.t * 6 < cl.R + 6;
  });
}

// ---------- fire ultimate: inferno ascension ----------
const ASCEND_CHARGE = 90, ASCEND_TAG = 11, ASCEND_DURATION = 480;

// Flame aura: an envelope of fire around the whole body (ghost fire), widest at the waist and
// tapering into a tip above the head; `width` and `height` grow while powering up.
function auraFlames(c, n, width, height) {
  const [cx] = c.center, feet = c.p.y + BH, total = BH + height;
  for (let k = 0; k < n; k++) {
    const h = Math.pow(Math.random(), 1.3); // 0 = feet, 1 = flame tip (denser around the body)
    const w = width * Math.pow(1 - h, 0.6) * (0.75 + 0.25 * Math.sin(h * Math.PI)) + 1; // teardrop
    const x = cx + (Math.random() - 0.5) * 2 * w;
    c.ps.spawn(x, feet - h * total, (Math.random() - 0.5) * 0.2, -0.35 - Math.random() * 0.5, EL.FIRE,
      { ghost: true, gravity: 0, life: 1 + ((Math.random() * 3) | 0) });
  }
}

function ascendOngoing(c) {
  const p = c.p, g = c.grid, ps = c.ps, as = p.ascend;
  p.flameHair = !!as || p.ascended > 0;

  // Ascended afterglow: lighter aura, full energy, fast cooldowns (handled in updateAbilities).
  if (p.ascended > 0) {
    p.ascended--;
    p.energy = MAX_ENERGY;
    auraFlames(c, 14, 4, 5);
    if (p.onGround && Math.abs(p.vx) > 0.3 && Math.random() < 0.5) { // burning footprints
      const X = Math.floor(p.x + BW / 2), Y = Math.floor(p.y + BH - 1);
      if (g.inBounds(X, Y) && g.type[Y * g.w + X] === 0) g.set(X, Y, EL.FIRE);
    }
  }
  if (!as) return;
  as.t++;
  const [cx, cy] = c.center;

  if (as.t <= ASCEND_CHARGE) {
    p.dashT = 2; p.dashVX = 0; p.dashVY = 0; // planted while powering up
    const k = as.t / ASCEND_CHARGE;
    auraFlames(c, 50 + Math.floor(k * 80), 4 + k * 5, 6 + k * 20);
    // Rocks and sand lift off the ground and float up around you.
    for (let n = 0; n < 3; n++) {
      const X = Math.floor(cx + (Math.random() - 0.5) * 60), top = groundBelow(g, X, p.y);
      if (top > 0 && Math.abs(X - cx) > 3) {
        const t = g.type[top * g.w + X];
        if (KIND[t] === Kind.POWDER || t === EL.STONE) {
          const i = ps.lift(X, top, (Math.random() - 0.5) * 0.2, -0.7 - Math.random() * 0.7, { ghost: true, gravity: 0, life: 400 });
          if (i >= 0) ps.tag[i] = ASCEND_TAG;
        }
      }
    }
    for (let i = 0; i < ps.n; i++) if (ps.tag[i] === ASCEND_TAG) { ps.vy[i] *= 0.985; ps.vx[i] += (Math.random() - 0.5) * 0.05; } // drifting up, slowing
    if (Math.random() < 0.4 + k * 0.5) { // electricity crackling over the body
      let sx = cx + (Math.random() - 0.5) * 6, sy = cy + (Math.random() - 0.5) * 12;
      for (let s = 0; s < 4; s++) { spark(c, sx, sy, 0, 0, 1); sx += (Math.random() - 0.5) * 3; sy += (Math.random() - 0.5) * 3; }
    }
    if (as.t % 30 === 0) { // shockwave pulse
      for (let n = 0; n < 32; n++) { const a = (n / 32) * Math.PI * 2; c.ps.spawn(cx, cy, Math.cos(a) * 3, Math.sin(a) * 2.2, EL.FIRE, { ghost: true, gravity: 0, life: 8 }); }
      for (let a = 0; a < 8; a++) { const dx = Math.cos((a * Math.PI) / 4), dy = Math.sin((a * Math.PI) / 4); g.addWind(cx + dx * 10, cy + dy * 10, 8, dx * 3, dy * 3); }
      if (c.fx.flash) c.fx.flash(1);
    }
    c.fx.shake(1 + k * 6);
    if (as.t === ASCEND_CHARGE) detonateAscension(c, cx, cy);
    return;
  }
  // Explosion aftermath: a giant ring of fire races outward.
  const age = as.t - ASCEND_CHARGE;
  if (age < 18) {
    const r = 8 + age * 4.5;
    for (let n = 0; n < 70; n++) {
      const a = (n / 70) * Math.PI * 2 + Math.random() * 0.05;
      c.ps.spawn(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.75, 0, 0, EL.FIRE, { ghost: true, gravity: 0, life: 1 + ((Math.random() * 2) | 0) });
    }
  } else { p.ascend = null; p.ascended = ASCEND_DURATION; }
}

function detonateAscension(c, x, y) {
  const g = c.grid, ps = c.ps, R = 46, cx = Math.floor(x), cy = Math.floor(y);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      const X = cx + dx, Y = cy + dy;
      if (!g.inBounds(X, Y)) continue;
      const i = Y * g.w + X, t = g.type[i], k = 1 - d / R;
      if (t === 0) { if (d > 4 && Math.random() < 0.5 * k) g.set(X, Y, EL.FIRE); continue; }
      g.temp[i] += 1000 * k;
      if (t === EL.SAND && d < R * 0.6) { g.transform(i, EL.GLASS); g.temp[i] = 900; }
    }
  }
  explode(c.world, x, y + 4, 28, EL.FIRE, true, false);
  for (let k = 0; k < 8; k++) { // chain of secondary blasts around the main one
    const a = (k / 8) * Math.PI * 2 + Math.random() * 0.4, r = 26 + Math.random() * 10;
    explode(c.world, x + Math.cos(a) * r, y + Math.sin(a) * r * 0.6, 7 + Math.random() * 3, EL.FIRE, false, false);
  }
  for (let i = 0; i < ps.n; i++) { // the floating rocks are blasted away
    if (ps.tag[i] !== ASCEND_TAG) continue;
    ps.tag[i] = 0; ps.ghost[i] = 0; ps.life[i] = 0; ps.g[i] = 0.08;
    const dx = ps.x[i] - x, dy = ps.y[i] - y, d = Math.hypot(dx, dy) || 1, sp = 8 + Math.random() * 5;
    ps.vx[i] = (dx / d) * sp; ps.vy[i] = (dy / d) * sp - 2;
  }
  for (let k = 0; k < 120; k++) { // fire blasted outward
    const a = Math.random() * Math.PI * 2, sp = 5 + Math.random() * 7;
    ps.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, EL.FIRE, { gravity: -0.02, drag: 0.94, life: 14 + Math.random() * 14 });
  }
  for (let a = 0; a < 16; a++) {
    const dx = Math.cos((a * Math.PI) / 8), dy = Math.sin((a * Math.PI) / 8);
    for (let r = 14; r < 130; r += 18) g.addWind(x + dx * r, y + dy * r, 12, dx * 6, dy * 6);
  }
  if (c.fx.flash) c.fx.flash(10);
  c.fx.shake(16);
  c.p.cast = { pose: 'sky', t: 20 };
}

// ---------- signature Z moves: lightning, magma surge, vacuum sphere ----------
const VACUUM_TAG = 10;
const SPARK = [EL.ICE, EL.GLASS]; // pale blue-white "electric" colors for ghost sparks

function spark(c, x, y, vx = 0, vy = 0, life = 2) {
  c.ps.spawn(x, y, vx, vy, SPARK[(Math.random() * 2) | 0], { ghost: true, gravity: 0, life });
}

function zOngoing(c) {
  const p = c.p, g = c.grid, ps = c.ps;

  // Lightning: 10 ticks of crackling wind-up, then the bolt.
  const bo = p.bolt;
  if (bo) {
    const [hx, hy] = c.hand;
    if (bo.t < 10) {
      telegraph(c, hx, hy, c.aim[0], c.aim[1], 120, EL.ICE, bo.t, 5); // where the bolt will strike
      for (let k = 0; k < 6; k++) { // electricity crawling over the hands, growing
        const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * (2 + bo.t * 0.4);
        spark(c, hx + Math.cos(a) * r, hy + Math.sin(a) * r, 0, 0, 2);
      }
    } else if (bo.t === 10) {
      const [ax, ay] = c.aim, px = -ay, py = ax;
      // Jagged path: kinks every 5-9 cells, stops at the first solid / liquid cell.
      // The zig-zag offset wanders but stays within 4 cells of the aim line, so the bolt keeps
      // going where you aimed it.
      let x = hx, y = hy, hit = null, last = [x, y], off = 0;
      const path = [[x, y]];
      for (let d = 0; d < 320 && !hit; d++) {
        if (d % 5 === 4) off = Math.max(-4, Math.min(4, off + (Math.random() - 0.5) * 7));
        x = hx + ax * (d + 1) + px * off; y = hy + ay * (d + 1) + py * off;
        if (d % 5 === 4) path.push([x, y]);
        const X = Math.floor(x), Y = Math.floor(y);
        if (X < 0 || X >= g.w || Y >= g.h) { hit = last; break; }
        if (Y < 0) continue;
        const t = g.type[Y * g.w + X];
        if (t !== 0 && KIND[t] !== Kind.GAS) hit = [x, y];
        else if (t === EL.FIRE || t === EL.SMOKE) g.temp[Y * g.w + X] += 200;
        last = [x, y];
      }
      if (!hit) hit = [x, y];
      path.push(hit);
      bo.path = path; bo.hit = hit;
      { // anyone the bolt passes through takes a heavy hit
        let total = 0;
        for (const pl of c.world.players || [c.world.player]) {
          if (!pl || pl.dead || pl.id === p.id) continue;
          const bx = pl.x + BW / 2, by = pl.y + BH / 2;
          if (path.some(([x0, y0]) => Math.abs(x0 - bx) < 4 && Math.abs(y0 - by) < 8)) total += pl.damage(35, p.id);
        }
        creditDamage(c.world, p.id, total);
      }
      // Impact: explosion + ignition, sand fused into glass, water electrified.
      const HX = Math.floor(hit[0]), HY = Math.floor(hit[1]);
      const ht = g.inBounds(HX, HY) ? g.type[HY * g.w + HX] : 0;
      if (ht === EL.WATER) electrify(c, HX, HY);
      explode(c.world, hit[0] - ax, hit[1] - ay, 5.5, EL.FIRE, true); // cracks rock too
      for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) { // then fuses the crater's sand into glass
        const X = HX + dx, Y = HY + dy;
        if (dx * dx + dy * dy <= 49 && g.inBounds(X, Y) && g.type[Y * g.w + X] === EL.SAND && Math.random() < 0.7) { g.transform(Y * g.w + X, EL.GLASS); g.temp[Y * g.w + X] = 900; }
      }
      c.fx.shake(8);
      if (c.fx.flash) c.fx.flash(5);
      p.cast = { pose: 'punch', t: 14 };
    }
    // The bolt (and a couple of forks) flickers on screen for 6 ticks.
    if (bo.path && bo.t < 16) {
      const pts = bo.path;
      const fade = bo.t - 10; // 0..6: thick and bright at first, thinning out
      for (let k = 1; k < pts.length; k++) {
        const [x0, y0] = pts[k - 1], [x1, y1] = pts[k], n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
        const lx = -(y1 - y0) / (n || 1), ly = (x1 - x0) / (n || 1);
        for (let s = 0; s <= n; s++) {
          const x = x0 + ((x1 - x0) * s) / n, y = y0 + ((y1 - y0) * s) / n;
          c.ps.spawn(x, y, 0, 0, EL.ICE, { ghost: true, gravity: 0, life: 1 });            // white-hot core
          if (fade < 4) { spark(c, x + lx, y + ly, 0, 0, 1); spark(c, x - lx, y - ly, 0, 0, 1); } // glow
        }
        if (k % 3 === 1 && (bo.t + k) % 2 === 0) { // forks crackling off the main bolt
          let fx = x1, fy = y1, ddx = lx * (k % 2 ? 1 : -1) + (x1 - x0) / (n || 1), ddy = ly * (k % 2 ? 1 : -1) + (y1 - y0) / (n || 1);
          for (let s = 0; s < 10; s++) { fx += ddx + (Math.random() - 0.5); fy += ddy + (Math.random() - 0.5); spark(c, fx, fy, 0, 0, 1); }
        }
      }
    }
    if (++bo.t > 16) p.bolt = null;
  }

  // Magma surge: ground in a ~14-wide, 7-deep bowl melts to lava over 10 ticks, then a geyser of
  // lava erupts for 20 ticks. The lava cools into stone on its own (existing heat physics).
  const mg = p.magma;
  if (mg) {
    if (mg.t < 10) {
      for (let k = 0; k < 26; k++) {
        const dx = Math.round((Math.random() - 0.5) * 22), dy = Math.floor(Math.random() * 10 * (1 - Math.abs(dx) / 13));
        const X = mg.x + dx, Y = mg.y + dy;
        if (!g.inBounds(X, Y)) continue;
        const i = Y * g.w + X, t = g.type[i];
        if (EARTHY.has(t) || t === EL.GLASS) { g.transform(i, EL.LAVA); g.temp[i] = 1250; }
      }
      for (let k = 0; k < 3; k++) c.ps.spawn(mg.x + (Math.random() - 0.5) * 12, mg.y - 1, (Math.random() - 0.5) * 0.6, -0.6 - Math.random(), EL.SMOKE, { ghost: true, gravity: 0, life: 10 });
      c.fx.shake(2);
    } else if (mg.t < 30) {
      for (let k = 0; k < 11; k++) {
        const vy = -(4.5 + Math.random() * 4) * mg.power;
        c.ps.spawn(mg.x + (Math.random() - 0.5) * 8, mg.y - 1, (Math.random() - 0.5) * 2.6, vy, EL.LAVA, { gravity: 0.1, drag: 0.995 });
      }
      for (let k = 0; k < 2; k++) c.ps.spawn(mg.x + (Math.random() - 0.5) * 10, mg.y - 4, (Math.random() - 0.5), -1.5, EL.SMOKE, { gravity: -0.02, life: 40 });
      c.fx.shake(3);
    }
    if (++mg.t >= 30) p.magma = null;
  }

  // Vacuum spheres: fly at 7 cells/tick until touching something (or 22 ticks), then pull for
  // 40 ticks, then pop.
  p.vacuums = p.vacuums.filter((v) => {
    v.t++;
    if (v.phase === 'fly') {
      const sp = Math.hypot(v.vx, v.vy), dx = v.vx / sp, dy = v.vy / sp;
      for (let s = 0; s < Math.ceil(sp); s++) {
        v.x += dx; v.y += dy;
        const X = Math.floor(v.x), Y = Math.floor(v.y);
        const blocked = X < 2 || X >= g.w - 2 || Y >= g.h - 2 || (Y >= 0 && g.type[Y * g.w + X] !== 0 && KIND[g.type[Y * g.w + X]] !== Kind.GAS)
          || bodyAt(c.world, v.x, v.y, p.id, 4);
        if (blocked) { v.x -= dx * 8; v.y -= dy * 8; v.phase = 'pull'; v.t = 0; break; } // hover just off the surface
      }
      if (v.phase === 'fly' && v.t > 22) { v.phase = 'pull'; v.t = 0; }
      for (let k = 0; k < 10; k++) { const a = v.t * 0.7 + k * 0.63; streak(c, v.x + Math.cos(a) * 2.5, v.y + Math.sin(a) * 2.5); }
      return true;
    }
    if (v.phase === 'pull') {
      // Rip loose material (and fire) from around the sphere toward it.
      for (let k = 0; k < 28; k++) {
        const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 28;
        const X = Math.floor(v.x + Math.cos(a) * r), Y = Math.floor(v.y + Math.sin(a) * r);
        if (!g.inBounds(X, Y)) continue;
        const t = g.type[Y * g.w + X], kind = KIND[t];
        if (kind === Kind.POWDER || kind === Kind.LIQUID || t === EL.FIRE || t === EL.SMOKE) {
          const i = ps.lift(X, Y, (v.x - X) * 0.15, (v.y - Y) * 0.15, { ghost: true, gravity: 0, life: 400 });
          if (i >= 0) ps.tag[i] = VACUUM_TAG;
        }
      }
      // Everything flying nearby is dragged in; captured stuff spirals into a dense ball.
      for (let i = 0; i < ps.n; i++) {
        const dx = v.x - ps.x[i], dy = v.y - ps.y[i], d = Math.hypot(dx, dy) || 1;
        if (ps.tag[i] === VACUUM_TAG) {
          // Spiral in and then orbit as a churning ball ~6 cells across.
          const want = 2.5 + ((i * 7) % 4), pull = (d - want) / d;
          ps.vx[i] = dx * pull * 0.3 + (-dy / d) * 1.4;
          ps.vy[i] = dy * pull * 0.3 + (dx / d) * 1.4;
        } else if (!ps.ghost[i] && !ps.tag[i] && d < 34) {
          ps.vx[i] += (dx / d) * 0.6; ps.vy[i] += (dy / d) * 0.6;
        }
      }
      for (let k = 0; k < 12; k++) { // inward-spiralling streaks
        const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 24;
        streak(c, v.x + Math.cos(a) * r, v.y + Math.sin(a) * r, -Math.cos(a) * r * 0.12 - Math.sin(a), -Math.sin(a) * r * 0.12 + Math.cos(a), 4);
      }
      g.addWind(v.x, v.y, 20, 0, 0);
      for (const pl of c.world.players || [c.world.player]) { // enemies are dragged into the ball
        if (!pl || pl.dead || pl.id === p.id) continue;
        const dx = v.x - (pl.x + BW / 2), dy = v.y - (pl.y + BH / 2), d = Math.hypot(dx, dy);
        if (d < 30 && d > 2) { pl.vx += (dx / d) * 0.35; pl.vy += (dy / d) * 0.35; }
        if (d < 5 && v.t % 6 === 0) hurt(c.world, pl, 2, p.id);
      }
      c.fx.shake(1.5);
      if (v.t >= 40) { v.phase = 'pop'; }
      return true;
    }
    // Pop: everything captured blasts outward.
    for (let i = 0; i < ps.n; i++) {
      if (ps.tag[i] !== VACUUM_TAG) continue;
      ps.tag[i] = 0; ps.ghost[i] = 0; ps.life[i] = 0; ps.g[i] = KIND[ps.type[i]] === Kind.GAS ? -0.03 : 0.08;
      const a = Math.random() * Math.PI * 2, sp = 7 + Math.random() * 6;
      ps.vx[i] = Math.cos(a) * sp; ps.vy[i] = Math.sin(a) * sp - 1;
    }
    explode(c.world, v.x, v.y, 9, 0);
    for (let k = 0; k < 32; k++) { const a = (k / 32) * Math.PI * 2; streak(c, v.x, v.y, Math.cos(a) * 5, Math.sin(a) * 5, 8); }
    c.fx.shake(9);
    return false;
  });
}

// Electrify a connected body of water (flood fill, up to 2500 cells): crackling sparks across
// the surface and a burst of heat that sets some of it steaming.
function electrify(c, x, y) {
  const g = c.grid, seen = new Set(), queue = [y * g.w + x];
  seen.add(queue[0]);
  while (queue.length && seen.size < 2500) {
    const i = queue.shift(), X = i % g.w, Y = (i / g.w) | 0;
    if (Math.random() < 0.12) spark(c, X + 0.5, Y + 0.5, 0, 0, 3 + ((Math.random() * 4) | 0));
    if (Math.random() < 0.04) g.temp[i] += 120;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = X + dx, ny = Y + dy, j = ny * g.w + nx;
      if (nx < 0 || nx >= g.w || ny < 0 || ny >= g.h || seen.has(j) || g.type[j] !== EL.WATER) continue;
      seen.add(j); queue.push(j);
    }
  }
  c.p.lastShock = seen.size; // how much water got electrified (for enemies standing in it later)
}

// Every stone cell left in the pillar flies forward in a straight line at high speed; a few of
// them explode on impact.
function launchPillar(c, q) {
  const g = c.grid, f = c.p.facing;
  let k = 0;
  for (let y = q.top; y < q.base; y++) {
    for (let x = q.x0; x <= q.x1; x++) {
      if (!g.inBounds(x, y) || g.type[y * g.w + x] !== EL.STONE) continue;
      const i = c.ps.lift(x, y, f * (10 + Math.random() * 0.6), (Math.random() - 0.5) * 0.25, { gravity: 0.01, drag: 1 });
      if (i >= 0 && k++ % 5 === 0) c.ps.boom[i] = 6; // radius 6+ smashes rock
    }
  }
  c.fx.shake(7);
  c.p.cast = { pose: 'palms', t: 12 };
}

// Where the held boulder hovers: in front of / above / below the player along the aim.
function boulderPos(c, ch) {
  const r = Math.sqrt((ch.rock ? ch.rock.length : 0) / Math.PI);
  const [ax, ay] = c.aim, [cx, cy] = c.center;
  return [cx + ax * (5 + r), cy - 3 + ay * (6 + r) - (ay === 0 ? r : 0)];
}

// ---------- per-tick update ----------
// world: { grid, particles, fx }. input.held[slot] is true while that key is down.
// Hand position for any aim vector (straight up / down: above the head / below the feet).
function handFor(p, center, aim) {
  return Math.abs(aim[0]) < 0.2
    ? [center[0], center[1] + aim[1] * 7.5]
    : [center[0] + aim[0] * 3, p.y + 4.5 + aim[1] * 3];
}

// ---------- telegraphs ----------
// A blinking dotted warning line from (x, y) along (ax, ay): shows where a big move is about to go.
function telegraph(c, x, y, ax, ay, len, type, t, every = 4) {
  if ((t >> 2) & 1) return; // blink
  const g = c.grid;
  for (let d = 6; d < len; d += every) {
    const X = x + ax * d, Y = y + ay * d;
    if (X < 0 || X >= g.w || Y >= g.h) break;
    c.ps.spawn(X, Y, 0, 0, type, { ghost: true, gravity: 0, life: 1 });
  }
}

// Which of the six moves are ready right now (bit per slot, Z X C A S V), for the HUD.
export function readyMask(p) {
  const kit = KITS[p.type];
  let m = 0;
  SLOTS.forEach((s, k) => {
    const mv = kit && kit[s];
    if (!mv || (p.cd && p.cd[s] > 0)) return;
    if (s === 'ultimate' ? p.ult >= 100 : p.energy >= (mv.cost || 0)) m |= 1 << k;
  });
  return m;
}

// ---------- X orbs ----------
const orbCount = (t) => 1 + Math.min(2, Math.floor(t / ORB_EVERY));

// Orbs circling the bender: each a small blob of its element. rock: cells to draw for earth.
function drawOrbs(c, n, age, rock = null) {
  const p = c.p, [cx, cy] = c.center, type = p.type;
  for (let k = 0; k < n; k++) {
    const a = age * 0.13 + (k * Math.PI * 2) / n;
    const ox = cx + Math.cos(a) * 9, oy = cy - 2 + Math.sin(a) * 6;
    if (type === 'fire') {
      for (let q = 0; q < 4; q++) c.ps.spawn(ox - 0.5 + (q & 1), oy - 0.5 + (q >> 1), 0, 0, EL.FIRE, { ghost: true, gravity: 0, life: 1 }); // 2x2 core
      for (let q = 0; q < 5; q++) c.ps.spawn(ox + (Math.random() - 0.5) * 2.4, oy + (Math.random() - 0.5) * 2.4, 0, -0.1, EL.FIRE, { ghost: true, gravity: 0, life: 1 });
      if (Math.random() < 0.3) c.ps.spawn(ox, oy, 0, -0.5, EL.FIRE, { ghost: true, gravity: -0.03, life: 4 });
    } else if (type === 'earth') {
      for (let q = 0; q < 7; q++) {
        const b = q * 2.4, d = q ? 1.3 : 0;
        c.ps.spawn(ox + Math.cos(b) * d, oy + Math.sin(b) * d, 0, 0, rock && rock.length ? rock[(k * 7 + q) % rock.length] : EL.STONE, { ghost: true, gravity: 0, life: 1 });
      }
    } else if (type === 'water') {
      const dx = Math.cos(a + Math.PI / 2), dy = Math.sin(a + Math.PI / 2) * 0.66; // spear along the orbit
      for (let q = -2; q <= 2; q++) c.ps.spawn(ox + dx * q, oy + dy * q, 0, 0, q === 2 ? EL.WATER : EL.ICE, { ghost: true, gravity: 0, life: 1 });
    } else {
      for (let q = 0; q < 6; q++) {
        const b = age * 0.6 + q * 1.05, r = q % 2 ? 1.2 : 2.2;
        c.ps.spawn(ox + Math.cos(b) * r, oy + Math.sin(b) * r, 0, 0, EL.STEAM, { ghost: true, gravity: 0, life: 1 });
      }
    }
  }
}

function makeOrbs(c, ch, data) {
  const n = orbCount(ch.t), list = [];
  for (let k = 0; k < n; k++) list.push(data(k));
  c.p.orbs = { list, age: ch.t };
  c.p.cast = { pose: 'palms', t: 6 };
  emit('orbs', c.p.x);
}

function orbsOngoing(c) {
  const p = c.p, o = p.orbs;
  if (!o) return;
  o.age++;
  o.life = (o.life || 0) + 1;
  if (p.dead || !o.list.length || o.life > ORB_LIFE) { // unused orbs fade away
    if (o.list.length && !p.dead) for (let q = 0; q < 6; q++) c.ps.spawn(c.center[0], c.center[1], (Math.random() - 0.5) * 2, -Math.random(), p.type === 'fire' ? EL.SMOKE : EL.STEAM, { ghost: true, gravity: -0.02, life: 10 });
    p.orbs = null;
    return;
  }
  drawOrbs(c, o.list.length, o.age, o.list.flatMap((q) => q.cells || []));
}

// Throw the next orb along the aim.
function throwOrb(c) {
  const p = c.p, o = p.orbs.list.shift(), [ax, ay] = c.aim;
  // Thrown from just out in front of you (earth from head height, clear of the pit its gathering digs).
  const [hx, hy] = [c.center[0] + ax * 6, c.center[1] - (p.type === 'earth' ? 7 : 2) + ay * 6]; // stones fly from orbit height
  c.hand = [hx, hy];
  if (p.type === 'fire') fireball(c, 11, 4.5, 4);
  else if (p.type === 'earth') { const n = o.cells.length; rockShot(c, o.cells, 9.5, 2.5 + n / 5, Math.sqrt(n / Math.PI)); }
  else if (p.type === 'water') {
    // One solid shard does the hit / freeze / blast; the rest of the spear is a visual trail
    // (solid followers used to pile up into floating ice walls that blocked the next spear).
    c.ps.spawn(hx, hy, ax * 12, ay * 12, EL.ICE, { gravity: 0.01, drag: 1, boom: 3 + o.shards / 5 });
    for (let k = 1; k < o.shards; k++) {
      c.ps.spawn(hx - ax * k * 0.6, hy - ay * k * 0.6, ax * 12, ay * 12, EL.ICE, { ghost: true, gravity: 0.01, life: 14 });
    }
  } else {
    const [cx, cy] = cannonPos(c);
    p.cannons.push({ x: cx, y: cy, vx: ax * 9, vy: ay * 9, r: 2.8, power: 0.5, life: 50, orb: true });
  }
  p.vx -= p.facing * 0.45;
  c.fx.shake(2.5);
  p.cast = { pose: 'palms', t: 8 };
  emit(`${p.type}.heavy.release`, p.x);
  if (!p.orbs.list.length) { p.orbs = null; p.cd.heavy = Math.max(p.cd.heavy || 0, 20); }
}

// Held move in progress, for the sound loops: { key: 'fire.defense', prog: 0..1 } or null.
export function channelInfo(type, ch) {
  const m = ch && KITS[type] && KITS[type][ch.slot];
  return m ? { key: `${type}.${ch.slot}`, prog: ch.t / m.maxHold } : null;
}

export function updateAbilities(p, input, world) {
  currentOwner = p.id;
  world.particles.defaultOwner = p.id + 1;
  if (p.dead) { p.channel = null; p.cast = null; p.rupture = null; p.tsunami = null; p.pillar = null; p.dragon = null; p.step = null; p.tornados = []; p.bolt = null; p.magma = null; p.vacuums = []; p.lance = null; p.cage = null; p.claps = []; p.ascend = null; p.ascended = 0; p.flameHair = false; p.orbs = null; p.kicks = null; p.whips = []; return; }
  for (const s of SLOTS) if (p.cd[s] > 0) p.cd[s] -= p.ascended > 0 ? 2 : 1; // ascended: cooldowns run 2x
  if (p.cast && --p.cast.t <= 0) p.cast = null;
  if (p.shield > 0) p.shield--;
  if (p.slowT > 0) p.slowT--;

  const aim = aimOf(p, input);
  const center = [p.x + BW / 2, p.y + BH / 2];
  // Hand: in front of the chest, pushed out along the aim (above the head / below the feet).
  const hand = aim[0] === 0
    ? [center[0], center[1] + aim[1] * 7.5]
    : [center[0] + aim[0] * 3, p.y + 4.5 + aim[1] * 3];
  const c = { p, world, grid: world.grid, ps: world.particles, fx: world.fx, aim, hand, center };
  // Arm tilt for aimed poses (degrees above / below horizontal), read by the sprite.
  p.aimTilt = Math.round((Math.atan2(-aim[1], Math.abs(aim[0])) * 180) / Math.PI);

  ongoing(c);
  if (p.frozenT > 0) p.frozenT--;

  // Stunned / frozen: no casting (an active hold move is cut off).
  if (p.stunT > 0) {
    if (p.channel) { p.cd[p.channel.slot] = 30; p.channel = null; }
    regen(p);
    return;
  }

  const kit = KITS[p.type];
  if (!kit) { regen(p); return; }

  // X orbs: a fresh X press throws one (holding X only charges when you have none).
  const xPress = !!input.held.heavy && !p.xWasHeld;
  p.xWasHeld = !!input.held.heavy;
  if (p.orbs && xPress && !p.channel) throwOrb(c);

  if (p.channel) {
    const m = kit[p.channel.slot];
    const ch = p.channel;
    if (input.held[ch.slot] && p.energy >= m.drain && ch.t < m.maxHold) {
      ch.t++;
      spend(p, m.drain);
      m.hold(c, ch);
      if (!p.cast || p.cast.pose === m.pose) p.cast = { pose: m.pose, t: 2 };
    } else {
      p.cd[ch.slot] = m.cooldown;
      if (m.release) m.release(c, ch); // (may shorten the cooldown, e.g. a fizzled charge)
      if (!m.quietRelease) emit(p.cd[ch.slot] < m.cooldown ? 'fizzle' : `${p.type}.${ch.slot}.release`, p.x);
      p.channel = null;
    }
    return;
  }

  const sPress = !!input.held.mobility && !p.sWasHeld;
  p.sWasHeld = !!input.held.mobility;
  for (const s of SLOTS) {
    if (!input.held[s]) continue;
    if (s === 'mobility' && !sPress) continue; // one press = one jet
    if (s === 'heavy' && p.orbs) continue;      // X throws orbs while you have them
    const m = kit[s];
    if (!m || p.cd[s] > 0) continue;
    if (m.ready && !m.ready(c)) continue;
    if (s === 'ultimate' ? p.ult < 100 : p.energy < m.cost) continue;
    if (s === 'ultimate') p.ult = 0;
    else spend(p, m.cost);
    if (m.hold) {
      p.channel = { slot: s, t: 0 };
      if (m.start) m.start(c, p.channel);
    } else {
      const before = p.cast;
      m.cast(c);
      emit(`${p.type}.${s}`, p.x);
      if (s === 'ultimate') emit(`cine:${p.type}:${p.color || '#e8b04a'}`, p.x); // ultimate cinematic
      p.cd[s] = m.cooldown;
      if (p.cast === before) p.cast = { pose: m.pose, t: m.poseTime }; // unless the move set its own
    }
    break;
  }
  regen(p);
}

function regen(p) {
  if (!p.channel) p.energy = Math.min(MAX_ENERGY, p.energy + ENERGY_REGEN);
}

function spend(p, n) {
  p.energy -= n;
}

// Effects that run on their own for a while after a cast.
// ---------- fire kick barrage ----------
const KICK_AT = [0, 7, 14]; // ticks of the three kicks
function kicksOngoing(c) {
  const p = c.p, g = c.grid;
  if (p.kicks) {
    const k = p.kicks, n = KICK_AT.indexOf(k.t);
    if (n >= 0) {
      const big = n === 2, [ax, ay] = k.aim;
      const [hx, hy] = handFor(p, c.center, k.aim);
      p.crescents.push({ x: hx, y: hy, ax, ay, R: big ? 6 : 4, life: 11, dmg: big ? 13 : 8, hit: new Set() });
      p.cast = { pose: big ? 'spin' : n === 0 ? 'slash' : 'slashUp', t: 7 };
      p.vx += p.facing * (big ? 0.9 : 0.5);
      for (let q = 0; q < 6; q++) c.ps.spawn(hx, hy, ax * 2 + (Math.random() - 0.5) * 2, ay * 2 + (Math.random() - 0.5) * 2, EL.FIRE, { ghost: true, gravity: -0.05, life: 6 });
      c.fx.shake(big ? 3 : 1.5);
      emit(big ? 'kick3' : 'kick', p.x);
    }
    if (++k.t > KICK_AT[2]) p.kicks = null;
  }
  // Crescents: an arc bowed forward, perpendicular to the flight.
  p.crescents = p.crescents.filter((cr) => {
    const px = -cr.ay, py = cr.ax;
    for (let sub = 0; sub < 2; sub++) {
      cr.x += cr.ax * 3.5; cr.y += cr.ay * 3.5;
      for (let s = -1; s <= 1.001; s += 0.25) {
        const bow = (1 - s * s) * cr.R * 0.6;
        const X = cr.x + px * s * cr.R + cr.ax * bow, Y = cr.y + py * s * cr.R + cr.ay * bow;
        const xi = Math.floor(X), yi = Math.floor(Y);
        if (!g.inBounds(xi, yi)) continue;
        const i = yi * g.w + xi, t = g.type[i], kind = KIND[t];
        if (kind === Kind.STATIC && t !== EL.WOOD && t !== EL.PLANT) { // rock: the crescent bursts
          explode(c.world, X, Y, cr.R * 0.6, EL.FIRE, false, true, p.id);
          return false;
        }
        if (t === EL.WOOD || t === EL.PLANT) g.temp[i] += 500;          // cut + ignite
        else if (kind === Kind.POWDER && Math.random() < 0.4) c.ps.lift(xi, yi, cr.ax * 3, cr.ay * 3 - 1, { bounces: 1 });
        else if (t === 0 && Math.random() < 0.08) g.set(xi, yi, EL.FIRE);
        const v = bodyAt(c.world, X, Y, p.id, 3);
        if (v && !cr.hit.has(v)) {
          cr.hit.add(v);
          hurt(c.world, v, cr.dmg, p.id);
          v.vx += cr.ax * 1.6; v.vy += cr.ay * 1.2 - 0.7;
        }
      }
    }
    for (let s = -1; s <= 1.001; s += 0.12) { // draw: bright edge + flickering trail
      const bow = (1 - s * s) * cr.R * 0.6;
      const X = cr.x + px * s * cr.R + cr.ax * bow, Y = cr.y + py * s * cr.R + cr.ay * bow;
      c.ps.spawn(X, Y, 0, 0, EL.FIRE, { ghost: true, gravity: 0, life: 1 });
      if (Math.random() < 0.5) c.ps.spawn(X - cr.ax * 2, Y - cr.ay * 2, -cr.ax * 0.5, -cr.ay * 0.5 - 0.2, EL.FIRE, { ghost: true, gravity: -0.03, life: 3 });
    }
    return --cr.life > 0;
  });
}

// ---------- water whip ----------
// The whip extends over 6 ticks, cracks, and pulls back over 5. Its body is a wave along the aim
// that tightens toward the tip; it hits each enemy once per lash.
const WHIP_LEN = 46;
function whipsOngoing(c) {
  const p = c.p, g = c.grid;
  if (p.whipCombo > 0) p.whipCombo--;
  if (p.whipLock > 0) p.whipLock--;
  p.whips = p.whips.filter((w) => {
    const ext = w.t <= 6 ? w.t / 6 : Math.max(0, 1 - (w.t - 6) / 5), len = WHIP_LEN * Math.pow(ext, 0.7);
    const [ax, ay] = w.aim, nx = -ay, ny = ax;
    const [hx, hy] = handFor(p, c.center, w.aim);
    const dir = w.second ? -1 : 1;
    for (let d = 2; d < len; d += 0.8) {
      const k = d / WHIP_LEN, wave = Math.sin(k * 7 - w.t * 1.3) * (1 - k) * 4 * dir * (1 - ext * 0.5);
      const X = hx + ax * d + nx * wave, Y = hy + ay * d + ny * wave;
      const tip = d > len - 3;
      c.ps.spawn(X, Y, 0, 0, tip || (d | 0) % 5 === 0 ? EL.ICE : EL.WATER, { ghost: true, gravity: 0, life: 1 });
      if (k < 0.6) c.ps.spawn(X + nx, Y + ny, 0, 0, EL.WATER, { ghost: true, gravity: 0, life: 1 }); // thicker near the hand
      const xi = Math.floor(X), yi = Math.floor(Y);
      if (g.inBounds(xi, yi)) { // puts out fire it touches
        const i = yi * g.w + xi, t = g.type[i];
        if (t === EL.FIRE) g.transform(i, EL.STEAM);
        else if (IGNITE_T[t] !== Infinity && g.life[i] > 0) { g.life[i] = 0; g.temp[i] = 20; }
      }
      if (w.t >= 2 && w.t <= 7) {
        const v = bodyAt(c.world, X, Y, p.id, 2);
        if (v && !w.hit.has(v)) {
          w.hit.add(v);
          hurt(c.world, v, w.second ? 12 : 11, p.id);
          if (w.second) { // yank toward the bender
            const sd = Math.sign(p.x - v.x) || -p.facing;
            v.vx = sd * 2.4; v.vy = -1.1;
          } else { v.vx = ax * 0.4; v.vy = Math.min(v.vy, -0.3); v.stunT = Math.max(v.stunT || 0, 15); } // stagger: sets up lash 2
          for (let q = 0; q < 6; q++) c.ps.spawn(X, Y, (Math.random() - 0.5) * 2, -Math.random() * 1.5, EL.WATER, { ghost: true, gravity: 0.1, life: 12 });
        }
      }
    }
    if (w.t === 6) { c.fx.shake(1.5); emit('crack', p.x); }
    return ++w.t <= 11;
  });
}

// ---------- water bubble trap ----------
function popBubble(c, v, as = EL.WATER) {
  const cx = v.x + BW / 2, cy = v.y + BH / 2;
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2;
    c.ps.spawn(cx + Math.cos(a) * 4, cy + Math.sin(a) * 6, Math.cos(a) * 1.5, Math.sin(a) * 1.5 - 0.5, as,
      as === EL.ICE ? { ghost: true, gravity: 0, life: 10 } : { bounces: 0 });
  }
  v.bubble = null;
  emit('pop', v.x);
}
function bubblesOngoing(c) {
  const p = c.p, g = c.grid;
  // Orbs in flight.
  p.bubbles = p.bubbles.filter((b) => {
    for (let sub = 0; sub < 2; sub++) {
      b.x += b.vx / 2; b.y += b.vy / 2;
      const v = bodyAt(c.world, b.x, b.y, p.id, 5);
      if (v && !(v.team !== null && v.team === p.team) && v.invulnT <= 0 && !v.bubble) {
        v.bubble = { t: 120, by: p.id };
        emit('trap', v.x);
        return false;
      }
      const t = g.get(Math.floor(b.x), Math.floor(b.y));
      if (t !== 0 && t !== EL.WATER && KIND[t] !== Kind.GAS) { // splash on whatever it hits
        for (let k = 0; k < 10; k++) c.ps.spawn(b.x - b.vx, b.y - b.vy, (Math.random() - 0.5) * 2, -Math.random() * 1.5, EL.WATER, { bounces: 0 });
        emit('pop', b.x);
        return false;
      }
    }
    for (let k = 0; k < 14; k++) { // the orb: a wobbling ring with a bright glint
      const a = (k / 14) * Math.PI * 2 + b.life * 0.2, r = 3 + Math.sin(b.life * 0.5 + k) * 0.4;
      c.ps.spawn(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r, 0, 0, EL.WATER, { ghost: true, gravity: 0, life: 1 });
    }
    c.ps.spawn(b.x - 1, b.y - 1, 0, 0, EL.ICE, { ghost: true, gravity: 0, life: 1 });
    if (--b.life <= 0) { for (let k = 0; k < 8; k++) c.ps.spawn(b.x, b.y, (Math.random() - 0.5) * 2, -Math.random(), EL.WATER, { bounces: 0 }); return false; }
    return true;
  });
  // Enemies trapped by this bender: float up helplessly, slowly drowning.
  for (const v of c.world.players || []) {
    const bb = v.bubble;
    if (!bb || bb.by !== p.id) continue;
    if (v.dead) { v.bubble = null; continue; }
    v.stunT = Math.max(v.stunT || 0, 2);
    v.vx *= 0.7;
    v.vy = Math.max(v.vy * 0.5 - 0.12, -0.35);
    hurt(c.world, v, 0.12, p.id);
    const cx = v.x + BW / 2, cy = v.y + BH / 2;
    for (let k = 0; k < 44; k++) { // the bubble: a dense wobbling shell + a faint shimmer inside
      const a = (k / 44) * Math.PI * 2 + bb.t * 0.08, w = Math.sin(bb.t * 0.3 + k * 0.7) * 0.5;
      c.ps.spawn(cx + Math.cos(a) * (5.5 + w), cy + Math.sin(a) * (8 + w), 0, 0, k % 7 ? EL.WATER : EL.ICE, { ghost: true, gravity: 0, life: 1 });
    }
    for (let k = 0; k < 5; k++) c.ps.spawn(cx + (Math.random() - 0.5) * 8, cy + (Math.random() - 0.5) * 13, 0, 0, EL.WATER, { ghost: true, gravity: 0, life: 1 });
    if (bb.t % 10 === 0) c.ps.spawn(cx + (Math.random() - 0.5) * 4, cy - 2, 0, -0.4, EL.ICE, { ghost: true, gravity: 0, life: 8 }); // air bubbles
    if (--bb.t <= 0) popBubble(c, v);
  }
}

// ---------- jets (every bender's S, held) ----------
// Velocity eases toward speed x the 8-way aim (forward when no arrows are held), so turns and
// starts feel smooth; the body ignores gravity while jetting; letting go keeps the momentum.
function startJet(c, ch) { ch.vx = c.p.vx; ch.vy = c.p.vy; }
function jet(c, ch, speed) {
  const p = c.p, [ax, ay] = c.aim;
  ch.vx += (ax * speed - ch.vx) * 0.2;
  ch.vy += (ay * speed - ch.vy) * 0.2;
  p.dashT = 2; p.dashVX = ch.vx; p.dashVY = ch.vy;
  if (ax) p.facing = Math.sign(ax);
  p.cast = { pose: ay < -0.7 && Math.abs(ax) < 0.3 ? 'sky' : 'dash', t: 2 };
}
function endJet(c, ch) {
  const p = c.p;
  p.dashT = 0; p.surfT = 0;
  p.vx = (ch.vx || 0) * 0.85; p.vy = (ch.vy || 0) * 0.85;
}

function ongoing(c) {
  const p = c.p, g = c.grid;
  airOngoing(c);
  orbsOngoing(c);
  kicksOngoing(c);
  bubblesOngoing(c);
  whipsOngoing(c);
  zOngoing(c);
  ascendOngoing(c);
  aOngoing(c);

  // Earth pillar: a 3-wide stone column grows 2 rows per tick. Loose stuff in the way is
  // thrown upward; standing on an under-feet pillar launches you at the top. Finished pillars
  // are remembered so a surf / dash into them can fire them forward.
  const pl = p.pillar;
  if (pl) {
    for (let step = 0; step < 2 && pl.h < pl.max; step++, pl.h++) {
      const y = pl.base - 1 - pl.h;
      if (y < 0) { pl.h = pl.max; break; }
      for (let x = pl.x - 1; x <= pl.x + 1; x++) {
        if (!g.inBounds(x, y)) continue;
        const t = g.type[y * g.w + x];
        if (t !== 0 && KIND[t] !== Kind.GAS) c.ps.lift(x, y, (Math.random() - 0.5) * 1.5, -4 - Math.random() * 2, { bounces: 1 });
        g.set(x, y, EL.STONE);
      }
    }
    if (pl.h >= pl.max) {
      const top = pl.base - pl.h;
      const onIt = Math.abs(p.x + BW / 2 - pl.x - 0.5) < 3 && Math.abs(p.y + BH - top) < 3;
      if (pl.launch && onIt) { p.vy = -pl.launch; p.onGround = false; }
      (p.pillars = p.pillars || []).push({ x0: pl.x - 1, x1: pl.x + 1, top, base: pl.base, t: 0 });
      if (p.pillars.length > 4) p.pillars.shift();
      p.pillar = null;
    }
  }
  if (p.pillars) p.pillars = p.pillars.filter((q) => ++q.t < 1200);

  const surfing = p.surfT > 0, jetting = p.dashT > 0 && p.jetType;
  if (p.dashT <= 0) p.jetType = 0;

  // Surf: a wave of real sand thrown up behind your feet (it piles up as a trail), and loose
  // ground ahead plowed aside.
  if (surfing) {
    const fx = p.x + BW / 2, fy = p.y + BH - 1;
    for (let k = 0; k < 5; k++) {
      c.ps.spawn(fx - p.facing * (2 + Math.random() * 2), fy - Math.random() * 2,
        -p.facing * (0.6 + Math.random() * 1.6), -1.5 - Math.random() * 1.8, EL.SAND,
        k < 2 ? { bounces: 1 } : { ghost: true, gravity: 0.15, life: 8 });
    }
    for (let dy = 0; dy < BH; dy++) {
      const X = Math.floor(fx + p.facing * 3), Y = Math.floor(p.y + dy);
      if (!g.inBounds(X, Y)) continue;
      const t = g.type[Y * g.w + X];
      if (KIND[t] === Kind.POWDER || KIND[t] === Kind.LIQUID) c.ps.lift(X, Y, p.facing * 2, -2.5 - Math.random() * 2, { bounces: 1 });
    }
  }

  // Sand / water jet: real cells blasted out of your feet, opposite to the way you're flying.
  if (jetting) {
    const l = Math.hypot(p.dashVX, p.dashVY) || 1, bx = -p.dashVX / l, by = -p.dashVY / l;
    const [cx] = c.center, fy = p.y + BH - 2;
    for (let k = 0; k < 6; k++) { // 2 real cells per tick (a held jet would flood the map), the rest spray
      const sp = 5 + Math.random() * 2.5, j = (Math.random() - 0.5) * 0.5;
      c.ps.spawn(cx + bx * 2, fy + by * 2, (bx + j * by) * sp, (by - j * bx) * sp, p.jetType,
        k < 2 ? { bounces: p.jetType === EL.SAND ? 1 : 0, dmg: 0.1 } : { ghost: true, gravity: 0.1, drag: 0.9, life: 6 });
    }
  }

  // Surfing or dashing into a pillar fires the whole pillar forward as a battering ram.
  if ((surfing || p.jetType === EL.SAND) && p.pillars) {
    const X = Math.floor(p.x + BW / 2 + p.facing * 3);
    for (const q of p.pillars) {
      if (X < q.x0 || X > q.x1 || p.y + BH <= q.top || p.y >= q.base) continue;
      launchPillar(c, q);
      p.pillars = p.pillars.filter((o) => o !== q);
      p.surfT = 0; p.dashT = 0; p.vx = -p.facing * 0.6;
      break;
    }
  }

  // Glacial cataclysm (tsunami): 0-25 water wall launched forward (tagged particles) and the
  // surge front sweeps / douses; at 30 every airborne wave cell freezes in place and the flood
  // on the ground turns to ice; at 50 the frozen wave shatters into high-speed ice shards.
  const ts = p.tsunami;
  if (ts) {
    const base = ts.ground > 0 ? ts.ground : g.h - 1;
    const ps = c.ps;
    if (ts.t < 26) {
      // Tight column: every cell launched at nearly the same speed so it travels as one wall;
      // the top moves a little faster so the wave leans forward and curls over.
      const top = Math.min(55, 18 + ts.t * 3);
      for (let k = 0; k < 60; k++) {
        const h = Math.random() * top;
        const x = ts.x0 + ts.f * (Math.random() * 3);
        ps.spawn(x, base - 2 - h, ts.f * (4.2 + h * 0.025 + Math.random() * 0.3), -0.25 + Math.random() * 0.1, EL.WATER,
          { gravity: 0.035, drag: 0.997, tag: TSUNAMI_TAG });
      }
      c.fx.shake(4);
    }
    if (ts.t < 30) {
      const front = Math.floor(ts.x0 + ts.f * (6 + ts.t * 4.3));
      for (let dx = 0; dx < 5; dx++) {
        const X = front + ts.f * dx;
        for (let y = Math.max(0, base - 50); y < base + 2; y++) {
          if (!g.inBounds(X, y)) continue;
          const i = y * g.w + X, t = g.type[i];
          if (y > base - 20 && KIND[t] === Kind.POWDER && Math.random() < 0.6) ps.lift(X, y, ts.f * (3 + Math.random() * 2), -1.5 - Math.random() * 2, { bounces: 1 });
          if (t === EL.FIRE) g.transform(i, EL.STEAM);
          else if (IGNITE_T[t] !== Infinity && g.life[i] > 0) { g.life[i] = 0; g.temp[i] = 20; } // doused
        }
      }
    }
    if (ts.t === 30) { // FREEZE: the wave stops dead in the air as ice; the flood becomes an ice sheet
      for (let i = 0; i < ps.n; i++) {
        if (ps.tag[i] !== TSUNAMI_TAG) continue;
        ps.type[i] = EL.ICE; ps.vx[i] = 0; ps.vy[i] = 0; ps.g[i] = 0; ps.drag[i] = 1;
      }
      const reach = 6 + 30 * 4.3;
      for (let d = 0; d <= reach; d += 6) g.freeze(ts.x0 + ts.f * d, base - 4, 9);
      c.fx.shake(9);
    }
    if (ts.t === 50) { // SHATTER: every frozen wave cell blasts forward as an ice shard
      let k = 0;
      for (let i = 0; i < ps.n; i++) {
        if (ps.tag[i] !== TSUNAMI_TAG) continue;
        ps.tag[i] = 0;
        ps.vx[i] = ts.f * (9 + Math.random() * 4);
        ps.vy[i] = (Math.random() - 0.6) * 2.5;
        ps.g[i] = 0.03;
        if (k++ % 14 === 0) ps.boom[i] = 3;
      }
      c.fx.shake(10);
    }
    if (++ts.t > 60) p.tsunami = null;
  }

  // Tectonic rupture: one spike every 3 ticks marching away from the bender. Each spike is a
  // tapered stone column that erupts in 3 ticks, flinging what was there upward. 20 ticks after
  // the last spike, every spike explodes (rock-smashing) into flying rubble.
  const ru = p.rupture;
  if (ru) {
    if (ru.next < 12 && ru.t % 3 === 0) {
      const x = Math.floor(ru.x0 + ru.f * (10 + ru.next * 9));
      const base = groundBelow(g, x, Math.max(0, ru.y0 - 25));
      if (base > 0) {
        ru.spikes.push({ x, base, h: 0, max: 14 + ru.next * 2.5 });
        for (const pl of c.world.players || [c.world.player]) { // impaled / launched by the spike
          if (!pl || pl.dead || pl.id === p.id || Math.abs(pl.x + BW / 2 - x) > 4) continue;
          hurt(c.world, pl, 18, p.id); pl.vy = -3;
        }
      }
      c.fx.shake(4 + ru.next * 0.3);
      ru.next++;
      if (ru.next === 12) ru.done = ru.t + 20;
    }
    for (const sp of ru.spikes) {
      for (let step = 0; step < 5 && sp.h < sp.max; step++, sp.h++) {
        const y = sp.base - 1 - sp.h;
        if (y < 0) { sp.h = sp.max; break; }
        const half = sp.h > sp.max * 0.75 ? 0 : sp.h > sp.max * 0.4 ? 1 : 2; // tapers to a point
        for (let x = sp.x - half; x <= sp.x + half; x++) {
          if (!g.inBounds(x, y)) continue;
          const t = g.type[y * g.w + x];
          if (t !== 0 && KIND[t] !== Kind.GAS) c.ps.lift(x, y, (Math.random() - 0.5) * 3, -6 - Math.random() * 4, { bounces: 1 });
          g.set(x, y, EL.STONE);
        }
      }
    }
    if (ru.t === ru.done) {
      for (const sp of ru.spikes) {
        for (let k = 0; k < 3; k++) explode(c.world, sp.x + 0.5, sp.base - sp.max * (0.2 + k * 0.3), 6.5, EL.STONE, true);
      }
      c.fx.shake(10);
      p.rupture = null;
    } else ru.t++;
  }

  // Dash exhaust: fire blasted backward.
  if (p.dashT > 0 && p.dashFire) {
    const [cx, cy] = c.center;
    const l = Math.hypot(p.dashVX, p.dashVY) || 1, bx = -p.dashVX / l, by = -p.dashVY / l;
    for (let k = 0; k < 4; k++) {
      c.ps.spawn(cx + bx * 2, cy + by * 2, bx * (5 + Math.random() * 2) + (Math.random() - 0.5), by * 5 + (Math.random() - 0.5), EL.FIRE, { gravity: -0.02, drag: 0.9, life: 8 + Math.random() * 6 });
    }
  } else if (p.dashT <= 0) p.dashFire = false;

}
