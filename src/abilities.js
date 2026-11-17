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
import { slowmo } from './juice.js';
import { spawnProjectile, spawnWall, register } from './clash.js';

export const SLOTS = ['basic', 'heavy', 'special', 'defense', 'mobility', 'ultimate'];
export const SLOT_KEYS = { z: 'basic', x: 'heavy', c: 'special', a: 'defense', s: 'mobility', v: 'ultimate' };
export const MAX_ENERGY = 175;
const ENERGY_REGEN = 0.3;      // per tick (~10 s from empty)
const BOOM_WINDUP = 15;        // sonic boom: ticks of wind-up before the shockwave
const ULT_PER_DAMAGE = 0.5;
// X orbs: hold X to form up to 3 element orbs that orbit you (one more every ORB_EVERY ticks of
// charge); each tap of X throws one along your aim. Unused orbs fade after ORB_LIFE ticks.
const ORB_EVERY = 14;
const ORB_LIFE = 420;
    // ultimate meter gained per point of damage dealt (200 damage = full)
let currentOwner = -1;         // id of the player whose moves are being processed right now

// The first enemy body (not attackerId) containing point (x, y), or null.
export function bodyAt(world, x, y, attackerId, pad = 0) {
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
  p.rift = null;     // earth continental rift
  p.grips = [];      // earth grip hands
  p.parry = null;    // earth rock parry stance
  p.ascend = null;
  p.ascended = 0;
  p.flameHair = false;
  p.tsunami = null;
  p.pillar = null;
  p.blades = [];     // air wind blades
  p.bladeQ = null;   // air: blades still to throw { n, t }
  p.boom = null;     // air sonic boom wind-up
  p.cannons = [];
  p.tornados = [];
  p.dragon = null;
  p.step = null;
  p.bolt = null;     // fire lightning
  p.claps = [];      // air sonic clap shockwaves
  p.stunT = 0;       // can't move / cast
  p.frozenT = 0;     // frozen solid (drawn as ice)
  p.afterimages = [];
  p.bullets = null;  // water bullets burst in progress
  p.tides = [];      // water tidal waves rolling
  p.stompWaves = []; // fire stomp shockwaves racing along the ground
  p.stomping = false;
}

// ---------- explosions ----------
// Blast at (x, y): loose cells (sand, water, ...) fly outward fast as particles, everything in
// range heats up (ignites wood, boils water), air is shoved outward, the screen shakes.
// Fire blasts also fill empty space with flame; rock blasts leave a little rubble.
// Every blast breaks solid blocks near its center; breakStatic (big blasts) breaks deeper,
// including obsidian.
// Blasts are drawn / dig / reach BLAST_SCALE x their nominal radius (the city map is big, so
// attacks need to read big); damage amounts still come from the nominal radius.
const BLAST_SCALE = 1.6;
export function explode(world, x, y, r0, type, breakStatic = false, knockPlayer = true, owner = currentOwner) {
  const { grid: g, particles: ps, fx } = world;
  if (r0 >= 5) emit('boom', x, r0); else emit('boom', x, r0, 'smallboom', 60);
  const r = r0 * BLAST_SCALE;
  breakStatic = breakStatic || r0 >= 4; // anything bigger than a pebble shot breaks walls
  const cx = Math.floor(x), cy = Math.floor(y), R = Math.ceil(r);
  const force = 2.5 + r0 * 1.1;
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
      const smash = kind === Kind.STATIC && (t === EL.STEEL ? r0 >= 8 && d < r * 0.6 // steel only gives to huge blasts
        : breakStatic ? d < r * 0.9 : t !== EL.OBSIDIAN && d < r * 0.7);
      if (smash && CRUMBLE[t]) g.type[i] = CRUMBLE[t]; // broken rock crumbles into rubble (sand)
      if ((loose && Math.random() < 0.85) || smash) {
        const nx = d ? dx / d : 0, ny = d ? dy / d : -1, sp = force * k * (0.6 + Math.random() * 0.7);
        ps.lift(X, Y, nx * sp, ny * sp - 0.6, { bounces: 1, dmg: 0.25 });
      }
    }
  }
  // Knock the player away from the blast (fireball at your own feet = rocket jump).
  // Blast damage to everyone but the attacker, scaled by blast size.
  damageArea(world, x, y, r, 6 + r0 * 2.2, owner);
  if (type === EL.ICE) { // ice shots pin whoever they catch: frozen in place for 0.4 s
    const own = (world.players || []).find((q) => q && q.id === owner);
    for (const pl of world.players || []) {
      if (!pl || pl.dead || pl.id === owner || (own && own.team !== null && pl.team === own.team) || pl.invulnT > 0) continue;
      if (Math.hypot(pl.x + BW / 2 - x, pl.y + BH / 2 - y) > r * 1.3 + 4) continue;
      if (!(pl.frozenT > 24)) { pl.frozenT = 24; pl.stunT = Math.max(pl.stunT || 0, 24); pl.vx *= 0.2; pl.vy *= 0.2; }
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
  fx.shake(Math.min(12, r * 0.8));
}

// What solid blocks turn into when a blast breaks them (so holes stay open instead of the
// pieces settling back as solid rock).
const CRUMBLE = { [EL.STONE]: EL.SAND, [EL.OBSIDIAN]: EL.SAND, [EL.GLASS]: EL.SAND, [EL.CONCRETE]: EL.SAND, [EL.BRICK]: EL.SAND, [EL.ASPHALT]: EL.SAND };
// What the sonic clap pulverizes solids into.
const PULVERIZE = { [EL.STONE]: EL.SAND, [EL.GLASS]: EL.SAND, [EL.OBSIDIAN]: EL.SAND, [EL.WOOD]: EL.ASH, [EL.PLANT]: EL.ASH, [EL.EARTH]: EL.EARTH, [EL.CONCRETE]: EL.SAND, [EL.BRICK]: EL.SAND, [EL.ASPHALT]: EL.SAND };
// What the blaze torrent can melt into lava when it's held on one spot (sand turns to glass on its own).
const MELTS = { [EL.STONE]: 1, [EL.EARTH]: 1, [EL.GLASS]: 1, [EL.MUD]: 1, [EL.OBSIDIAN]: 1, [EL.CONCRETE]: 1, [EL.BRICK]: 1, [EL.ASPHALT]: 1 };

// ---------- earth helpers ----------
const EARTHY = new Set([EL.EARTH, EL.STONE, EL.SAND, EL.MUD, EL.CONCRETE, EL.BRICK, EL.ASPHALT]); // earthbenders rip up the city too
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
    // Z: flame stomp. Stomp the ground and a fire shockwave races along the floor both ways
    // (~50 cells each), following slopes: it launches enemies it passes under and leaves the
    // ground smouldering. In the air you slam straight down first and stomp on landing.
    basic: {
      cost: 14, cooldown: 75, pose: 'slam', poseTime: 14,
      cast(c) {
        const p = c.p;
        if (p.onGround) stomp(c);
        else { p.stomping = true; p.dashT = 2; p.dashVX = 0; p.dashVY = 4.5; }
      },
    },
    // X: fireballs. Hold to conjure up to 3 fireballs that orbit you; then each tap of X flings
    // one along your aim (they explode on impact, or when they pass close to an enemy).
    heavy: {
      cost: 10, hold: true, drain: 0.45, maxHold: 40, cooldown: 50, pose: 'charge', orbs: true, quietRelease: true,
      hold(c, ch) { drawOrbs(c, orbCount(ch.t), ch.t); },
      release(c, ch) { makeOrbs(c, ch, () => ({})); },
    },
    // C: flame wall. A wall of fire bursts up ahead of you for 3 s (power 40): weak shots passing
    // through burn up, water hitting it boils into a steam screen, enemies standing in it burn.
    special: {
      cost: 20, cooldown: 120, pose: 'slam', poseTime: 12,
      cast(c) {
        const p = c.p, x = Math.floor(c.center[0] + p.facing * 16);
        const base = groundBelow(c.grid, x, p.y) > 0 ? groundBelow(c.grid, x, p.y) : Math.floor(p.y + BH);
        spawnWall({ el: 'fire', name: 'Flame Wall', x, base, h: 44, pow: 40, owner: p.id, team: p.team, life: 180 });
        c.fx.shake(3);
      },
    },
    // A: lightning (Fire's answer to Water). A short wind-up (sparks crackle at the hands, a
    // warning line shows the aim, which you can still adjust), then an instant jagged bolt.
    // Beats water: electrifies water attacks and shocks the water bender. Ignites what it hits,
    // fuses sand into glass, electrifies a whole connected body of water.
    defense: {
      cost: 18, cooldown: 120, pose: 'charge', poseTime: 12,
      cast(c) { c.p.bolt = { t: 0 }; },
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
    // Z: earth grip. A stone hand bursts out of the ground under the nearest enemy (within ~100
    // cells) and grabs their feet for 1 s: they can't walk, jump or jet (they can still attack;
    // smashing the hand frees them). Whiffs onto the ground ahead if nobody is in range.
    basic: {
      cost: 15, cooldown: 140, pose: 'lift', poseTime: 14,
      cast(c) {
        const p = c.p, v = nearestEnemy(c, 100);
        const x = v ? v.x + BW / 2 : c.center[0] + p.facing * 40;
        const gy = v ? v.y + BH : groundBelow(c.grid, Math.floor(x), p.y);
        if (gy < 0) return;
        if (v) { v.rootT = 60; hurt(c.world, v, 6, p.id); }
        p.grips.push({ v, x, y: gy, t: 0 });
        c.fx.shake(3);
      },
    },
    // X: stones. Hold to rip rock from the ground into up to 3 stones that orbit you; then each
    // tap of X hurls one along your aim.
    heavy: {
      cost: 8, hold: true, drain: 0.4, maxHold: 40, cooldown: 50, pose: 'lift', orbs: true, quietRelease: true,
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
      cost: 15, cooldown: 75, pose: 'slam', poseTime: 12,
      cast(c) {
        const under = c.aim[1] > 0 && c.aim[0] === 0;
        const x = Math.floor(c.p.x + BW / 2 + (under ? 0 : c.p.facing * 14));
        const gy = groundBelow(c.grid, x, c.p.y + BH - 3);
        if (gy < 0) return;
        c.p.pillar = { x, base: gy, h: 0, max: 38, launch: under ? 3.8 : 0 }; // 5 wide, 38 tall: twice a bender
        c.fx.shake(3);
      },
    },
    // A: rock parry. A 0.4 s counter stance: a stone slab snaps up in front of you. Anything that
    // hits you or the slab in that window is absorbed (projectiles shatter on it) and a stone
    // pillar erupts under whoever threw it (14, launches them). Whiff it and you're open: no
    // moves for half a second.
    defense: {
      cost: 18, cooldown: 110, pose: 'guard', poseTime: 24,
      cast(c) {
        c.p.parry = { t: 0, hit: null };
        c.fx.shake(1.5);
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
    // V: continental rift. The ground cracks around the nearest enemy (telegraphed for 0.4 s),
    // then the floor there collapses into a deep chasm; 0.8 s later the two sides slam back
    // together, crushing anyone caught between them (45) and launching them out.
    ultimate: {
      cooldown: 60, pose: 'slam', poseTime: 40,
      cast(c) {
        const p = c.p, v = nearestEnemy(c, 260);
        const cx = Math.floor(v ? v.x + BW / 2 : c.center[0] + p.facing * 80);
        p.rift = { t: 0, cx, half: 48, depth: 44, tops: {}, y0: Math.floor((v || p).y) };
        c.fx.shake(6);
      },
    },
  },
  water: {
    // Z: water bullets. A rapid burst of 4 small water shots (power 6 each) along your aim: each
    // one puts out a fire attack it meets, splashes real water, and stings (4 damage).
    basic: {
      cost: 12, cooldown: 70, pose: 'palms', poseTime: 18,
      cast(c) { c.p.bullets = { n: 4, t: 0 }; },
    },
    // X: ice spears. Hold to draw water into up to 3 ice spears that orbit you; then each tap
    // of X fires one along your aim (freezes the area it hits).
    heavy: {
      cost: 8, hold: true, drain: 0.4, maxHold: 40, cooldown: 50, pose: 'lift', orbs: true, quietRelease: true,
      start(c, ch) { ch.n = 0; },
      hold(c, ch) {
        if (ch.t % 2 === 0 && ch.n < 18) ch.n += takeWater(c, 1, c.center).length;
        drawOrbs(c, orbCount(ch.t), ch.t);
      },
      release(c, ch) { const n = orbCount(ch.t); makeOrbs(c, ch, () => ({ shards: Math.max(6, Math.round(ch.n / n)) })); },
    },
    // C: tidal wave. A wave of real water rises in front of you and rolls along the ground
    // (~120 cells): it pushes enemies along, drowns fire attacks and burning things it meets,
    // and leaves water behind to fight in (power 35, fading as it travels).
    special: {
      cost: 28, cooldown: 150, pose: 'wave', poseTime: 16,
      cast(c) {
        const p = c.p, vol = gatherWater(c, 30, 500); // nearby water joins the wave
        p.tides.push({ x: c.center[0] + p.facing * 6, y: p.y + BH, dir: p.facing, t: 0, hit: new Set(), vol });
        c.fx.shake(3 + Math.min(4, vol / 100));
      },
    },
    // A: erosion jet (Water's answer to Earth). Hold: a high-pressure jet (power 65) that blasts
    // through stone attacks and washes earth, sand and stone walls away. Drains mana while held.
    defense: {
      cost: 10, hold: true, drain: 1.1, maxHold: 90, cooldown: 120, pose: 'jet',
      hold(c, ch) { erosionJet(c, ch); },
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
    // Z: wind blades. Two fast crescents of compressed air along your aim, the second a beat
    // after the first and tilted the other way (power 9 each, 5 dmg + a shove). Air beats water:
    // each blade scatters a water attack into mist. They slice loose sand / water out of the way.
    basic: {
      cost: 12, cooldown: 70, pose: 'palms', poseTime: 12,
      cast(c) { c.p.bladeQ = { n: 2, t: 0 }; },
    },
    // X: air cannons. Hold to compress up to 3 balls of air that orbit you; then each tap of X
    // fires one as a pressure sphere that bursts into a wind shockwave.
    heavy: {
      cost: 8, hold: true, drain: 0.45, maxHold: 40, cooldown: 50, pose: 'charge', orbs: true, quietRelease: true,
      hold(c, ch) { drawOrbs(c, orbCount(ch.t), ch.t); c.grid.addWind(c.center[0], c.center[1], 10, 0, 0); },
      release(c, ch) { makeOrbs(c, ch, () => ({})); },
    },
    // C: tornado, aimable: forward = travels along the ground, up / diagonal = flies that way,
    // down = spawns under you and carries you up. Sucks in loose stuff and spins it up the
    // funnel (fire -> fire tornado, water -> waterspout), flinging it out the top.
    special: {
      cost: 22, cooldown: 120, pose: 'spin', poseTime: 16,
      cast(c) {
        const [ax, ay] = c.aim, under = ax === 0 && ay > 0;
        const x = under ? c.center[0] : c.center[0] + ax * 14;
        const y = under ? c.p.y + BH : ay < 0 ? c.center[1] + ay * 10 : c.p.y + BH;
        c.p.tornados.push({ x, y, vx: under ? 0 : ax * 0.9, vy: under ? 0 : ay * 0.9, ground: ay === 0 || under, t: 0, life: 240, h: 80 });
        c.fx.shake(3);
      },
    },
    // A: sonic boom. A quarter-second wind-up (air rushing between your hands, the cone shown),
    // then a supersonic shockwave cone (~50 cells) along your aim: sonic beats earth, so it
    // shatters stone attacks and walls, pulverizes rock into sand, and blasts enemies away
    // (10-18 dmg, stunned 0.5 s).
    defense: {
      cost: 20, cooldown: 130, pose: 'charge', poseTime: BOOM_WINDUP,
      cast(c) { c.p.boom = { t: 0, aim: [...c.aim] }; c.p.slowT = BOOM_WINDUP; },
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

// The sonic boom itself (fired after the wind-up).
function sonicBoom(c, aim) {
  const g = c.grid, ps = c.ps, p = c.p, [ax, ay] = aim, base = Math.atan2(ay, ax);
  const hx = c.center[0] + ax * 5, hy = c.center[1] - 2 + ay * 5;
  const R = 75, HALF = 0.55;
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
    const hit = pl.damage(10 + 8 * k, p.id); if (!hit) continue; total += hit;
    pl.vx += Math.cos(base) * (2 + 4 * k); pl.vy += Math.sin(base) * (2 + 4 * k) - 1.5;
    pl.stunT = Math.max(pl.stunT || 0, 30);
  }
  creditDamage(c.world, p.id, total);
  p.claps.push({ t: 0, x: hx, y: hy, base, R, HALF });
  emit('air.defense.release', p.x);
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

  // Wind blades queued by Z: one now, the next 7 ticks later, tilted the other way.
  if (p.bladeQ && p.bladeQ.t-- <= 0) {
    const [ax, ay] = c.aim, [hx, hy] = c.hand, k = 2 - p.bladeQ.n; // 0, 1
    const a = Math.atan2(ay, ax) + (k ? -0.06 : 0.06);
    p.blades.push({ x: hx, y: hy, vx: Math.cos(a) * 6, vy: Math.sin(a) * 6, t: 0, life: 24, tilt: k ? -1 : 1 });
    if (k) emit('air.basic', p.x); // (the first blade's sound plays on the cast)
    p.cast = { pose: k ? 'palms' : 'punch', t: 8 };
    if (--p.bladeQ.n <= 0) p.bladeQ = null; else p.bladeQ.t = 7;
  }

  // Air blades: a crescent whose leading arc sweeps the air; loose cells along the arc are
  // sliced away; the center bursts on solid ground; a body it reaches takes a cut and a shove.
  p.blades = p.blades.filter((b) => {
    if (b.dead) return false; // lost a clash
    b.t++;
    const sp = Math.hypot(b.vx, b.vy), dx = b.vx / sp, dy = b.vy / sp, px = -dy, py = dx;
    const R = 9 + Math.min(1, b.t / 12) * 13; // grows as it flies
    const arc = (th) => [b.x + dx * (Math.cos(th) - 1) * R * 0.6 + px * Math.sin(th) * R,
                         b.y + dy * (Math.cos(th) - 1) * R * 0.6 + py * Math.sin(th) * R];
    const steps = Math.ceil(sp);
    for (let s = 0; s < steps; s++) {
      b.x += dx; b.y += dy;
      if (b.x < -20 || b.x > g.w + 20 || b.y > g.h + 5 || b.y < -40) return false;
      const X = Math.floor(b.x), Y = Math.floor(b.y);
      if (g.inBounds(X, Y)) {
        const t = g.type[Y * g.w + X];
        if (t !== 0 && KIND[t] === Kind.STATIC) { explode(c.world, b.x - dx * 2, b.y - dy * 2, 3, 0, false, false); return false; }
      }
      const v = bodyAt(c.world, b.x, b.y, p.id, 3);
      if (v) {
        hurt(c.world, v, 5, p.id);
        v.vx += dx * 1.6; v.vy += dy * 1.2 - 0.6;
        for (let k = 0; k < 12; k++) streak(c, b.x, b.y, dx * 2 + (Math.random() - 0.5) * 3, dy * 2 + (Math.random() - 0.5) * 3, 6);
        return false;
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
    if (--b.life <= 0) { for (let k = 0; k < 8; k++) streak(c, b.x, b.y, dx + (Math.random() - 0.5) * 2, dy + (Math.random() - 0.5) * 2, 6); return false; }
    { const Rr = 6 + Math.min(1, b.t / 12) * 9;
      const mx = b.x - dx * sp / 2, my = b.y - dy * sp / 2; // mid-tick, thick enough not to tunnel
      register({ el: 'air', form: 'wave', name: 'Wind blade', pow: 9, r: 2 + sp / 2, owner: p.id, team: p.team, vx: b.vx, vy: b.vy, canOwn: false,
        x: mx + px * Rr * 0.8, y: my + py * Rr * 0.8, x2: mx - px * Rr * 0.8, y2: my - py * Rr * 0.8,
        kill: () => { b.dead = true; }, set: (q) => { if (q.vx !== undefined) { b.vx = q.vx; b.vy = q.vy; } } }); }
    return true;
  });

  // Air cannon balls: burst into a shockwave on touching anything (or at max range).
  p.cannons = p.cannons.filter((b) => {
    if (b.dead) return false; // lost a clash
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
    register({ el: 'air', form: 'projectile', name: 'Air cannon', pow: b.orb ? 20 : 15 + 30 * b.power, x: b.x, y: b.y, r: b.r + 1, vx: b.vx, vy: b.vy, owner: p.id, team: p.team,
      kill: () => { b.dead = true; }, set: (q) => { if (q.vx !== undefined) { b.vx = q.vx; b.vy = q.vy; } } });
    return true;
  });

  // Tornados: a cone (narrow base, wide top) drawn as 5 helical bands spinning around it, bright
  // on the front side and dim on the back. Debris orbits up the cone and drops out the top.
  p.tornados = p.tornados.filter((tn) => {
    tn.t++;
    tn.x += tn.vx; tn.y += tn.vy;
    if (tn.ground) { const gy = groundBelow(g, Math.floor(tn.x), tn.y - 12); if (gy > 0) tn.y = gy; }
    if (tn.x < -10 || tn.x > g.w + 10 || tn.y < -tn.h || tn.t > tn.life || tn.dead) return false;
    register({ el: tn.fire ? 'fire' : 'air', form: 'area', name: tn.fire ? 'Fire tornado' : 'Tornado', pow: 12 + 28 * (1 - tn.t / tn.life),
      x: tn.x, y: tn.y - tn.h * 0.4, r: 9, vx: tn.vx, vy: tn.vy, owner: p.id, team: p.team,
      kill: () => { tn.dead = true; },
      set: (q) => { if (q.el === 'fire' && !tn.fire) { tn.fire = true; for (let k = 0; k < 30; k++) { const X = Math.floor(tn.x + (Math.random() - 0.5) * 10), Y = Math.floor(tn.y - Math.random() * 8); if (g.inBounds(X, Y) && g.type[Y * g.w + X] === 0) g.set(X, Y, EL.FIRE); } } } });
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




// ---------- A moves: sonic boom ----------
function aOngoing(c) {
  const p = c.p, g = c.grid, ps = c.ps;

  // Sonic boom wind-up: air rushes in between the hands, the cone edges flicker, then it fires.
  if (p.boom) {
    const bm = p.boom, k = ++bm.t / BOOM_WINDUP, [ax, ay] = bm.aim, hx = c.center[0] + ax * 5, hy = c.center[1] - 2 + ay * 5;
    const a0 = Math.atan2(ay, ax);
    for (const da of [-0.5, 0.5]) telegraph(c, hx, hy, Math.cos(a0 + da), Math.sin(a0 + da), 50, EL.STEAM, bm.t, 4);
    for (let n = 0; n < 6 + k * 10; n++) {
      const a = bm.t * 0.5 + n * 1.1, r = 2 + (1 - k) * 9 + Math.random() * 2;
      streak(c, hx + Math.cos(a) * r, hy + Math.sin(a) * r * 0.8, -Math.cos(a) * 0.9, -Math.sin(a) * 0.7, 2);
    }
    if (bm.t >= BOOM_WINDUP) { p.boom = null; sonicBoom(c, bm.aim); p.cast = { pose: 'palms', t: 12 }; }
  }

  // Stunned bodies: little sparks circling the head.
  for (const pl of c.world.players || [c.world.player]) {
    if (!pl || pl.dead || !(pl.stunT > 0) || pl.frozenT > 0 || pl !== p) continue;
    const a = pl.stunT * 0.4;
    for (const s of [0, Math.PI]) ps.spawn(pl.x + BW / 2 + Math.cos(a + s) * 3, pl.y - 3 + Math.sin(a + s) * 1, 0, 0, EL.ICE, { ghost: true, gravity: 0, life: 1 });
  }

  // Sonic clap: arcs of the shockwave expanding through the cone.
  p.claps = p.claps.filter((cl) => {
    cl.t++;
    for (const r of [cl.t * 6, cl.t * 6 - 5]) {
      if (r <= 2 || r > cl.R) continue;
      for (let a = -cl.HALF; a <= cl.HALF; a += 0.04) ps.spawn(cl.x + Math.cos(cl.base + a) * r, cl.y + Math.sin(cl.base + a) * r, 0, 0, EL.STEAM, { ghost: true, gravity: 0, life: 1 });
    }
    const r = Math.min(cl.R, cl.t * 6);
    if (!cl.dead && r > 4) register({ el: 'sonic', form: 'wave', name: 'Sonic Boom', pow: 35, r: 3, owner: p.id, team: p.team,
      x: cl.x + Math.cos(cl.base - cl.HALF) * r, y: cl.y + Math.sin(cl.base - cl.HALF) * r, x2: cl.x + Math.cos(cl.base + cl.HALF) * r, y2: cl.y + Math.sin(cl.base + cl.HALF) * r,
      kill: () => { cl.dead = true; }, set() {} });
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

// ---------- signature moves: lightning ----------
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
      register({ el: 'lightning', form: 'beam', name: 'Lightning', pow: 35, x: hx, y: hy, x2: hit[0], y2: hit[1], r: 3, owner: p.id, team: p.team });
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
// Battering ram: the whole pillar tears out of the ground and flies forward as ONE heavy clash
// projectile (it hits once, hard, instead of every stone cell hitting separately).
function launchPillar(c, q) {
  const g = c.grid, f = c.p.facing, p = c.p;
  let n = 0;
  for (let y = q.top; y < q.base; y++) for (let x = q.x0; x <= q.x1; x++) {
    if (!g.inBounds(x, y) || g.type[y * g.w + x] !== EL.STONE) continue;
    g.set(x, y, 0); n++;
  }
  if (!n) return;
  const h = Math.min(26, q.base - q.top);
  spawnProjectile({ el: 'earth', name: 'Battering Ram', shape: 'ram', h, x: (q.x0 + q.x1) / 2 + f * 2, y: q.base - h / 2, vx: f * 9, vy: 0,
    pow: 30 + Math.min(25, n / 6), r: 6, boomR: 7, gravity: 0.015, life: 80, cells: [EL.STONE, EL.STONE, EL.EARTH], owner: p.id, team: p.team });
  for (let k = 0; k < 16; k++) c.ps.spawn((q.x0 + q.x1) / 2, q.base - Math.random() * h, -f * Math.random() * 2, -Math.random() * 2, EL.SAND, { ghost: true, gravity: 0.1, life: 12 });
  c.fx.shake(7);
  emit('ram', p.x);
  p.cast = { pose: 'palms', t: 12 };
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
    ? [center[0], center[1] + aim[1] * BH * 0.625]
    : [center[0] + aim[0] * 4.5, p.y + BH * 0.375 + aim[1] * 4.5];
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
    const ox = cx + Math.cos(a) * 12, oy = cy - 3 + Math.sin(a) * 9;
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
  // Fire / earth / water orbs fly as clash-engine projectiles (they react with other attacks).
  const shot = { x: hx, y: hy, owner: p.id, team: p.team };
  if (p.type === 'fire') spawnProjectile({ ...shot, el: 'fire', name: 'Fireball', vx: ax * 11, vy: ay * 11, pow: 20, r: 3, boomR: 4.5, gravity: 0.012 });
  else if (p.type === 'earth') { const n = o.cells.length; spawnProjectile({ ...shot, el: 'earth', name: 'Stone', vx: ax * 9.5, vy: ay * 9.5, pow: 24, r: 3.5, boomR: 2.5 + n / 5, gravity: 0.03, cells: o.cells }); }
  else if (p.type === 'water') spawnProjectile({ ...shot, el: 'ice', name: 'Ice spear', vx: ax * 12, vy: ay * 12, pow: 18, r: 2.5, boomR: 3 + o.shards / 5, gravity: 0.01 });
  else {
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
  if (p.dead) { p.channel = null; p.cast = null; p.rift = null; p.grips = []; p.parry = null; p.tsunami = null; p.pillar = null; p.dragon = null; p.step = null; p.tornados = []; p.bolt = null; p.claps = []; p.blades = []; p.bladeQ = null; p.boom = null; p.ascend = null; p.ascended = 0; p.flameHair = false; p.orbs = null; p.bullets = null; p.tides = []; p.stompWaves = []; p.stomping = false; return; }
  for (const s of SLOTS) if (p.cd[s] > 0) p.cd[s] -= p.ascended > 0 ? 2 : 1; // ascended: cooldowns run 2x
  if (p.cast && --p.cast.t <= 0) p.cast = null;
  if (p.shield > 0) p.shield--;
  if (p.slowT > 0) p.slowT--;

  const aim = aimOf(p, input);
  const center = [p.x + BW / 2, p.y + BH / 2];
  // Hand: in front of the chest, pushed out along the aim (above the head / below the feet).
  const hand = aim[0] === 0
    ? [center[0], center[1] + aim[1] * BH * 0.625]
    : [center[0] + aim[0] * 4.5, p.y + BH * 0.375 + aim[1] * 4.5];
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
  if (p.orbThrowT > 0) p.orbThrowT--;
  if (p.orbs && xPress && !p.channel && !(p.orbThrowT > 0)) { throwOrb(c); p.orbThrowT = 14; } // a beat between throws

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
// ---------- fire stomp ----------
const STOMP_SPEED = 4.6, STOMP_TICKS = 16, STOMP_DMG = 12;
function stomp(c) {
  const p = c.p, x = c.center[0], feet = p.y + BH;
  for (const dir of [-1, 1]) p.stompWaves.push({ x: x + dir * 3, y: feet, dir, t: 0, hit: new Set() });
  for (let k = 0; k < 14; k++) c.ps.spawn(x + (Math.random() - 0.5) * 8, feet - 1, (Math.random() - 0.5) * 3, -1 - Math.random() * 2, EL.FIRE, { ghost: true, gravity: 0.06, life: 12 });
  p.dust(Math.floor(x), Math.floor(feet), 8);
  p.cast = { pose: 'slam', t: 12 };
  c.fx.shake(4);
  emit('stomp', p.x);
}
function stompOngoing(c) {
  const p = c.p, g = c.grid;
  if (p.stomping) { // slamming down from the air
    if (p.onGround) { p.stomping = false; p.dashT = 0; stomp(c); }
    else if (p.dead) p.stomping = false;
    else { p.dashT = 2; p.dashVX = 0; p.dashVY = 4.5; p.cast = { pose: 'slam', t: 2 }; }
  }
  p.stompWaves = p.stompWaves.filter((w) => {
    if (w.dead) return false;
    w.t++;
    w.x += w.dir * STOMP_SPEED;
    const X = Math.floor(w.x);
    if (X < 1 || X >= g.w - 1) return false;
    const gy = groundBelow(g, X, w.y - 8); // hug the ground: up small steps, down slopes
    if (gy < 0 || gy > w.y + 10) return false; // ran off a ledge
    w.y = gy;
    const k = 1 - w.t / STOMP_TICKS, hgt = 5 + 9 * k; // the crest shrinks as it travels
    for (let q = 0; q < 10; q++) { // a crest of flame + flung dirt
      const ox = (Math.random() - 0.5) * 4, oy = -Math.random() * hgt;
      c.ps.spawn(w.x + ox, gy + oy, w.dir * 0.6, -0.6 - Math.random(), q < 7 ? EL.FIRE : EL.SAND, { ghost: true, gravity: 0.05, life: 4 + Math.random() * 4 });
    }
    if (Math.random() < 0.35 && g.inBounds(X, gy - 1) && g.type[(gy - 1) * g.w + X] === 0) g.set(X, gy - 1, EL.FIRE); // smouldering ground
    for (const v of c.world.players || []) { // launch anyone it passes under
      if (v.dead || v.id === p.id || w.hit.has(v) || (p.team !== null && v.team === p.team)) continue;
      if (Math.abs(v.x + BW / 2 - w.x) < 4 && v.y + BH >= gy - 8 && v.y + BH <= gy + 3) {
        w.hit.add(v);
        hurt(c.world, v, STOMP_DMG * (0.6 + 0.4 * k), p.id);
        v.vy = -2.4; v.vx += w.dir * 1.1;
      }
    }
    register({ el: 'fire', form: 'wave', name: 'Flame Stomp', pow: 22 * (0.5 + 0.5 * k), x: w.x, y: gy - 4, r: 5, vx: w.dir * STOMP_SPEED, vy: 0, owner: p.id, team: p.team,
      kill: () => { w.dead = true; }, set: (q) => { if (q.vx !== undefined && q.vx !== 0) w.dir = Math.sign(q.vx); } });
    return w.t < STOMP_TICKS;
  });
}

// ---------- water bullets ----------
function bulletsOngoing(c) {
  const p = c.p, b = p.bullets;
  if (!b) return;
  if (b.t++ % 4 === 0) { // one shot every 4 ticks, along the current aim
    const [ax, ay] = c.aim, [hx, hy] = c.hand, j = (Math.random() - 0.5) * 0.06;
    spawnProjectile({ el: 'water', name: 'Water bullet', x: hx + ax * 3, y: hy + ay * 3, vx: (ax - ay * j) * 11, vy: (ay + ax * j) * 11, pow: 6, r: 2, boomR: 2, dmg: 4, gravity: 0.01, life: 45, owner: p.id, team: p.team });
    for (let k = 0; k < 4; k++) c.ps.spawn(hx, hy, ax * 2 + (Math.random() - 0.5), ay * 2 + (Math.random() - 0.5), EL.WATER, { ghost: true, gravity: 0.08, life: 6 });
    p.cast = { pose: 'palms', t: 5 };
    p.vx -= p.facing * 0.08;
    emit('bullet', p.x);
    if (--b.n <= 0) p.bullets = null;
  }
}

// ---------- tidal wave ----------
const TIDE_SPEED = 3.2, TIDE_TICKS = 50, TIDE_H = 34, TIDE_LEN = 24, TIDE_MAXVOL = 1600;
// The wave's size grows with the water it carries: 0 cells = normal, 360+ = 2.2x.
const tideScale = (vol) => 1 + Math.min(1.2, vol / 300);

// Pull real water cells within r of the bender into the move (up to max): they vanish from the
// map and stream toward your hands. Returns how many were taken.
function gatherWater(c, r, max) {
  const g = c.grid, [cx, cy] = c.center;
  let n = 0;
  for (let dy = -r; dy <= r && n < max; dy++) for (let dx = -r; dx <= r && n < max; dx++) {
    if (dx * dx + dy * dy > r * r) continue;
    const X = Math.floor(cx + dx), Y = Math.floor(cy + dy);
    if (!g.inBounds(X, Y) || g.type[Y * g.w + X] !== EL.WATER) continue;
    g.set(X, Y, 0); n++;
    if (n % 4 === 0) c.ps.spawn(X, Y, -dx * 0.08, -dy * 0.08, EL.WATER, { ghost: true, gravity: 0, life: 12 }); // streaming in
  }
  return n;
}
function tidesOngoing(c) {
  const p = c.p, g = c.grid;
  p.tides = p.tides.filter((w) => {
    if (w.dead) return false;
    w.t++;
    w.peak = Math.max(w.peak || 0, w.vol); // size follows the most water it has carried (it lays water down as it goes)
    const sc = tideScale(w.peak), LEN = Math.round(TIDE_LEN * (0.6 + 0.4 * sc));
    const k = 1 - w.t / TIDE_TICKS, H = TIDE_H * sc * Math.min(1, w.t / 5) * (k > 0.35 ? 1 : 0.35 + k * 1.85); // rises, holds, collapses at the end
    w.x += w.dir * TIDE_SPEED;
    const X = Math.floor(w.x);
    if (X < 1 || X >= g.w - 1) return false;
    const gy = groundBelow(g, X, w.y - 12);
    if (gy < 0) return false;
    w.y = gy;
    // Body: columns behind the front, tallest just behind the crest; foam on top.
    for (let o = 0; o < LEN; o++) {
      const cx = w.x - w.dir * o, h = H * (o < 4 ? 0.65 + o * 0.09 : 1 - (o - 4) / (LEN - 2));
      if (h < 1) continue;
      const col = Math.floor(cx), base = groundBelow(g, col, gy - 12) > 0 ? groundBelow(g, col, gy - 12) : gy;
      for (let y = 0; y < h; y += 1) { // solid body of water, white foam along the crest
        const curl = o < 4 && y > h - 6 ? w.dir * (4 - o) * 1.1 : 0; // the crest curls forward
        const cell = y > h - 2.5 ? EL.ICE : EL.WATER;
        c.ps.spawn(cx + curl, base - y, 0, 0, cell, { ghost: true, gravity: 0, life: 1 });
        if (Math.random() < 0.6) c.ps.spawn(cx + curl - w.dir * 0.5, base - y, 0, 0, cell, { ghost: true, gravity: 0, life: 1 });
      }
      // Douse fire / burning things inside the wave; swallow water it rolls over (it grows).
      for (let y = 0; y < h; y++) {
        const Y = Math.floor(base - y);
        if (!g.inBounds(col, Y)) continue;
        const i = Y * g.w + col, t = g.type[i];
        if (t === EL.WATER && o < 4 && w.vol < TIDE_MAXVOL) { g.set(col, Y, 0); w.vol++; continue; }
        if (t === EL.FIRE) g.transform(i, EL.STEAM);
        else if (IGNITE_T[t] !== Infinity && g.life[i] > 0) { g.life[i] = 0; g.temp[i] = 20; }
      }
    }
    // It lays its water back down behind it as it travels (nothing is lost).
    const drop = Math.min(w.vol, Math.max(1, Math.round(w.vol / (TIDE_TICKS - w.t + 1))));
    for (let q = 0; q < Math.min(drop, 12); q++) c.ps.spawn(w.x - w.dir * (LEN * 0.6 + Math.random() * LEN * 0.4), gy - H * Math.random() * 0.6, -w.dir * 0.4, 0.5, EL.WATER, { bounces: 0, dmg: 0 });
    w.vol = Math.max(0, w.vol - Math.min(drop, 12));
    if (w.t % 2 === 0 && w.vol < 1) c.ps.spawn(w.x - w.dir * 8, gy - H * 0.5, -w.dir * 0.4, 0.5, EL.WATER, { bounces: 0, dmg: 0 });
    // Push enemies caught in it (first contact also hurts).
    for (const v of c.world.players || []) {
      if (v.dead || v.id === p.id || (p.team !== null && v.team === p.team)) continue;
      const vx = v.x + BW / 2;
      if ((vx - w.x) * w.dir > 2 || (vx - w.x) * w.dir < -LEN || v.y + BH < gy - H || v.y > gy) continue;
      if (!w.hit.has(v)) { w.hit.add(v); hurt(c.world, v, 9 * sc, p.id); }
      v.vx = w.dir * Math.max(Math.abs(v.vx), 2.2 * (0.8 + 0.2 * sc)); v.vy = Math.min(v.vy, -0.5);
    }
    register({ el: 'water', form: 'wave', name: 'Tidal Wave', pow: 35 * sc * (0.5 + 0.5 * k), x: w.x - w.dir * 3, y: gy - H / 2, r: Math.max(5, H / 2), vx: w.dir * TIDE_SPEED, vy: 0,
      owner: p.id, team: p.team, kill: () => { w.dead = true; }, set: (q) => { if (q.vx) w.dir = Math.sign(q.vx); } });
    if (w.t % 8 === 1) emit('wavewash', w.x);
    return w.t < TIDE_TICKS;
  });
}

// ---------- erosion jet ----------
const ERODES = new Set([EL.STONE, EL.EARTH, EL.SAND, EL.MUD, EL.GLASS, EL.OBSIDIAN, EL.ASH, EL.CONCRETE, EL.BRICK, EL.ASPHALT]);
function erosionJet(c, ch) {
  const p = c.p, g = c.grid, [ax, ay] = c.aim, [hx, hy] = c.hand;
  p.slowT = 2;
  p.vx -= ax * 0.05;
  let x = hx, y = hy, end = [hx + ax * 80, hy + ay * 80];
  const hitBodies = new Set();
  for (let d = 0; d < 80; d++) {
    x += ax; y += ay;
    const X = Math.floor(x), Y = Math.floor(y);
    if (X < 0 || X >= g.w || Y >= g.h) { end = [x, y]; break; }
    if (Y >= 0) {
      const t = g.type[Y * g.w + X];
      if (t === EL.FIRE) g.transform(Y * g.w + X, EL.STEAM);
      else if (t !== 0 && t !== EL.WATER && KIND[t] !== Kind.GAS) { end = [x, y]; break; }
    }
    if (d % 2 === 0) c.ps.spawn(x + (Math.random() - 0.5) * 0.8, y + (Math.random() - 0.5) * 0.8, 0, 0, d % 6 ? EL.WATER : EL.ICE, { ghost: true, gravity: 0, life: 1 });
    const v = bodyAt(c.world, x, y, p.id, 1.5);
    if (v && !hitBodies.has(v)) {
      hitBodies.add(v);
      hurt(c.world, v, 0.9, p.id);
      v.vx += ax * 0.25; v.vy += ay * 0.15;
      v.vx = Math.max(-2.5, Math.min(2.5, v.vx));
    }
  }
  // Erode whatever the jet hits: stone is chiselled away, earth and sand blasted off, some mud left.
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    if (dx * dx + dy * dy > 9) continue;
    const X = Math.floor(end[0]) + dx, Y = Math.floor(end[1]) + dy;
    if (!g.inBounds(X, Y)) continue;
    const t = g.type[Y * g.w + X];
    if (!ERODES.has(t)) continue;
    const hard = t === EL.STONE || t === EL.GLASS || t === EL.OBSIDIAN;
    if (Math.random() < (hard ? 0.32 : 0.6)) c.ps.lift(X, Y, ax * 3 + (Math.random() - 0.5) * 2, ay * 3 - 1 - Math.random() * 1.5, { bounces: 1, dmg: 0.2 });
    else if (t === EL.EARTH && Math.random() < 0.1) g.transform(Y * g.w + X, EL.MUD);
  }
  for (let k = 0; k < 4; k++) c.ps.spawn(end[0], end[1], -ax * 1.5 + (Math.random() - 0.5) * 2.5, -ay * 1.5 - Math.random() * 1.5, EL.WATER, { ghost: true, gravity: 0.1, life: 8 }); // spray
  if (ch.t % 3 === 0) c.ps.spawn(end[0] - ax * 2, end[1] - ay * 2, (Math.random() - 0.5), -0.5, EL.WATER, { bounces: 0, dmg: 0 });
  register({ el: 'water', form: 'beam', name: 'Erosion Jet', pow: 65, x: hx, y: hy, x2: end[0], y2: end[1], r: 3, owner: p.id, team: p.team });
}

// ---------- earth: grip, rock parry, rift ----------
const PARRY_T = 24;
// Something hit the parry (an attack on the slab, or damage to the body): remember the attacker.
function parried(c, by) { const pa = c.p.parry; if (pa && pa.hit === null && pa.t <= PARRY_T) pa.hit = by; }

function nearestEnemy(c, range) {
  const p = c.p;
  let best = null, bd = range;
  for (const v of c.world.players || []) {
    if (v.dead || v.out || v.id === p.id || (p.team !== null && v.team === p.team)) continue;
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

function earthOngoing(c) {
  const p = c.p, g = c.grid, ps = c.ps;
  // Earth grip: four stone fingers curl up around the feet, a palm under them.
  p.grips = p.grips.filter((gr) => {
    gr.t++;
    const v = gr.v;
    if (v && !v.dead && gr.t < 60 && !gr.dead) { gr.x = v.x + BW / 2; v.rootT = Math.max(v.rootT || 0, 2); }
    const rise = Math.min(1, gr.t / 5);
    // palm: a slab of rock the feet sit in
    for (let x = -6; x <= 6; x++) for (let y = 0; y < 3; y++) if (Math.abs(x) < 6 || y < 2) ps.spawn(gr.x + x, gr.y - y + 1, 0, 0, y === 0 ? EL.EARTH : EL.STONE, { ghost: true, gravity: 0, life: 1 });
    // fingers (2 wide) curling in over the shins, a thumb on the other side
    for (const [fx, len] of [[-6, 11], [-3, 12], [4, 10], [6, 8]]) for (let y = 2; y < len * rise; y++) {
      const curl = y > len - 4 ? -Math.sign(fx) * (y - (len - 4)) * 0.8 : 0;
      for (let w = 0; w < 2; w++) ps.spawn(gr.x + fx + curl + w - 0.5, gr.y - y, 0, 0, w ? EL.STONE : EL.OBSIDIAN, { ghost: true, gravity: 0, life: 1 });
    }
    const done = gr.dead || gr.t >= 60 || (v && v.dead);
    if (done) { // crumble
      if (v) v.rootT = 0;
      for (let k = 0; k < 14; k++) ps.spawn(gr.x + (Math.random() - 0.5) * 9, gr.y - Math.random() * 8, (Math.random() - 0.5) * 2, -Math.random() * 1.5, EL.STONE, { ghost: true, gravity: 0.12, life: 14 });
      return false;
    }
    register({ el: 'earth', form: 'area', name: 'Earth Grip', pow: 25, x: gr.x, y: gr.y - 4, r: 5, owner: p.id, team: p.team, kill: () => { gr.dead = true; } });
    return true;
  });
  // Rock parry.
  const pa = p.parry;
  if (pa) {
    pa.t++;
    if (pa.t <= PARRY_T) {
      if (p.onGround) { p.vx *= 0.3; } // feet planted
      const W = 5, H = BH + 6, sx = p.facing > 0 ? p.x + BW + 1 : p.x - W - 1, up = Math.min(1, pa.t / 3);
      for (let y = 0; y < H * up; y++) for (let w = 0; w < W; w++) { // a slab with a dark rim, tapered top
        if (y >= H - 2 && (w === 0 || w === W - 1)) continue;
        const rim = w === 0 || w === W - 1 || y >= H - 3;
        ps.spawn(sx + w, p.y + BH - y, 0, 0, rim ? EL.OBSIDIAN : (y * 3 + w) % 7 ? EL.STONE : EL.EARTH, { ghost: true, gravity: 0, life: 1 });
      }
      register({ el: 'earth', form: 'area', name: 'Rock Parry', pow: 999, parry: (by) => parried(c, by), x: sx + W / 2, y: p.y + BH - H / 2, r: H / 2 + 1, owner: p.id, team: p.team, kill() {} });
    }
    if (pa.hit !== null && !pa.countered) { // the counter: a pillar under the attacker
      pa.countered = true;
      p.cd.defense = Math.min(p.cd.defense || 0, 30); // a good read: back sooner
      const a = (c.world.players || []).find((v) => v.id === pa.hit && !v.dead);
      emit('clash', p.x); c.fx.shake(5); slowmo(10, 0.35);
      for (let k = 0; k < 16; k++) ps.spawn(p.x + BW / 2 + p.facing * 4, p.y + BH / 2 + (Math.random() - 0.5) * 12, p.facing * Math.random() * 2, (Math.random() - 0.5) * 2, EL.STONE, { ghost: true, gravity: 0.1, life: 12 });
      if (a) {
        const gy = groundBelow(g, Math.floor(a.x + BW / 2), a.y);
        pa.pillar = { x: a.x + BW / 2, base: gy > 0 ? gy : a.y + BH, t: 0 };
        hurt(c.world, a, 14, p.id);
        a.vy = -3.6; a.vx += Math.sign(a.x - p.x || 1) * 0.6;
        emit('earth.special', a.x);
      }
    }
    if (pa.pillar) { // the counter pillar shoots up, holds, then crumbles
      const pl = pa.pillar; pl.t++;
      const h = pl.t < 5 ? (pl.t / 5) * 28 : pl.t < 22 ? 28 : 0;
      for (let y = 0; y < h; y++) for (let x = -3; x <= 3; x++) { // pointed earth spire
        if (y > h - 4 && Math.abs(x) > h - y - 1) continue;
        ps.spawn(pl.x + x, pl.base - y, 0, 0, Math.abs(x) === 3 ? EL.OBSIDIAN : (x + y) % 5 ? EL.EARTH : EL.STONE, { ghost: true, gravity: 0, life: 1 });
      }
      if (pl.t === 22) for (let k = 0; k < 26; k++) ps.spawn(pl.x + (Math.random() - 0.5) * 7, pl.base - Math.random() * 28, (Math.random() - 0.5) * 1.5, -Math.random(), EL.EARTH, { ghost: true, gravity: 0.15, life: 16 });
    }
    if (pa.t === PARRY_T && pa.hit === null) { // whiffed: open for half a second
      for (const s of SLOTS) if (s !== 'mobility') p.cd[s] = Math.max(p.cd[s] || 0, 30);
      for (let k = 0; k < 10; k++) ps.spawn(p.x + BW / 2 + p.facing * 4, p.y + Math.random() * BH, p.facing * 0.5, 0.3, EL.STONE, { ghost: true, gravity: 0.15, life: 14 });
    }
    if (pa.t > PARRY_T + 25 && (!pa.pillar || pa.pillar.t > 22)) p.parry = null;
  }
  // Continental rift.
  const rf = p.rift;
  if (rf) {
    rf.t++;
    const { cx, half, depth } = rf;
    const topOf = (x) => { if (rf.tops[x] === undefined) rf.tops[x] = groundBelow(g, x, rf.y0); return rf.tops[x]; };
    if (rf.t < 24) { // crack telegraph: the outline of the zone blinks, dust rising from the cracks
      if ((rf.t >> 2) & 1) for (let x = cx - half; x <= cx + half; x += 3) { const ty = topOf(x); if (ty > 0) ps.spawn(x, ty - 1, 0, -0.3, EL.SAND, { ghost: true, gravity: 0, life: 2 }); }
      for (const ex of [cx - half, cx + half]) { const ty = topOf(ex); if (ty > 0) for (let k = 0; k < 3; k++) ps.spawn(ex + (Math.random() - 0.5) * 2, ty - Math.random() * 4, 0, -1, EL.SAND, { ghost: true, gravity: 0.02, life: 10 }); }
      c.fx.shake(1.5);
    } else if (rf.t === 24) { // the floor collapses into a chasm
      rf.dug = {}; // what was there, so the slam can put the ground back
      for (let x = cx - half; x <= cx + half; x++) {
        const ty = topOf(x);
        if (ty < 0) continue;
        const col = rf.dug[x] = [];
        for (let y = ty; y < Math.min(g.h - 2, ty + depth); y++) {
          if (!g.inBounds(x, y)) continue;
          const t0 = g.type[y * g.w + x];
          if (t0 === 0) continue;
          col.push(y, t0);
          if (Math.random() < 0.04) ps.lift(x, y, (Math.random() - 0.5) * 1.5, Math.random() * 0.5, { bounces: 0 });
          else g.set(x, y, 0);
        }
      }
      c.fx.shake(10); emit('boom', cx, 12);
    } else if (rf.t >= 70 && rf.t <= 76) { // the sides slam back together, from the edges inward
      const k = (rf.t - 69) / 7, reach = Math.ceil(half * k);
      for (let x = cx - half; x <= cx + half; x++) {
        if (Math.abs(x - cx) < half - reach) continue;
        const col = rf.dug && rf.dug[x];
        if (!col) continue;
        for (let k = 0; k < col.length; k += 2) g.set(x, col[k], col[k + 1] === EL.WATER || col[k + 1] === EL.LAVA ? EL.STONE : col[k + 1]);
        rf.dug[x] = null;
      }
      register({ el: 'earth', form: 'area', name: 'Continental Rift', pow: 120, x: cx, y: topOf(cx) + depth / 2, r: half, owner: p.id, team: p.team });
      if (rf.t === 76) { // crushed: anyone caught in the zone
        for (const v of c.world.players || []) {
          if (v.dead) continue;
          const vx = v.x + BW / 2, ty = topOf(Math.floor(Math.max(cx - half, Math.min(cx + half, vx))));
          if (Math.abs(vx - cx) > half + 2 || v.y + BH <= ty - 4 || ty < 0) continue;
          const ally = v.id === p.id || (p.team !== null && v.team === p.team);
          if (!ally) hurt(c.world, v, 45, p.id);
          v.y = Math.min(v.y, ty - BH - 1); v.vy = ally ? -1.5 : -3.2; // pushed out of the closed ground
          if (!ally) v.vx += Math.sign(vx - cx || 1) * 1.5;
        }
        c.fx.shake(14); emit('boom', cx, 14);
      }
    }
    if (rf.t > 80) p.rift = null;
  }
}

// ---------- jets (every bender's S, held) ----------
// Velocity eases toward speed x the 8-way aim (forward when no arrows are held), so turns and
// starts feel smooth; the body ignores gravity while jetting; letting go keeps the momentum.
function startJet(c, ch) { ch.vx = c.p.vx; ch.vy = c.p.vy; }
function jet(c, ch, speed) {
  const p = c.p, [ax, ay] = c.aim;
  if (p.rootT > 0) { p.dashT = 0; p.surfT = 0; return; } // held by Earth: no jetting away
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
  bulletsOngoing(c);
  tidesOngoing(c);
  earthOngoing(c);
  stompOngoing(c);
  zOngoing(c);
  ascendOngoing(c);
  aOngoing(c);

  // Earth pillar: a 5-wide stone column grows 3 rows per tick. Loose stuff in the way is
  // thrown upward; standing on an under-feet pillar launches you at the top. Finished pillars
  // are remembered so a surf / dash into them can fire them forward.
  const pl = p.pillar;
  if (pl) {
    for (let step = 0; step < 3 && pl.h < pl.max; step++, pl.h++) {
      const y = pl.base - 1 - pl.h;
      if (y < 0) { pl.h = pl.max; break; }
      for (let x = pl.x - 2; x <= pl.x + 2; x++) {
        if (!g.inBounds(x, y)) continue;
        const t = g.type[y * g.w + x];
        if (t !== 0 && KIND[t] !== Kind.GAS) c.ps.lift(x, y, (Math.random() - 0.5) * 1.5, -4 - Math.random() * 2, { bounces: 1 });
        g.set(x, y, EL.STONE);
      }
    }
    if (pl.h >= pl.max) {
      const top = pl.base - pl.h;
      const onIt = Math.abs(p.x + BW / 2 - pl.x - 0.5) < 4 && Math.abs(p.y + BH - top) < 4;
      if (pl.launch && onIt) { p.vy = -pl.launch; p.onGround = false; }
      (p.pillars = p.pillars || []).push({ x0: pl.x - 2, x1: pl.x + 2, top, base: pl.base, t: 0 });
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


  // Dash exhaust: fire blasted backward.
  if (p.dashT > 0 && p.dashFire) {
    const [cx, cy] = c.center;
    const l = Math.hypot(p.dashVX, p.dashVY) || 1, bx = -p.dashVX / l, by = -p.dashVY / l;
    for (let k = 0; k < 4; k++) {
      c.ps.spawn(cx + bx * 2, cy + by * 2, bx * (5 + Math.random() * 2) + (Math.random() - 0.5), by * 5 + (Math.random() - 0.5), EL.FIRE, { gravity: -0.02, drag: 0.9, life: 8 + Math.random() * 6 });
    }
  } else if (p.dashT <= 0) p.dashFire = false;

}
