// CPU fighters. A bot fills the same input object a human controller would (left / right / up /
// down / jump / held moves), so it plays by exactly the same rules: cooldowns, energy, charge
// times, 8-way aiming. Every tick it:
//   1. picks the nearest enemy
//   2. moves to its bender's preferred range (jumping walls / gaps, avoiding lava, unsticking)
//   3. dodges incoming fire (chance depends on difficulty)
//   4. picks a move that fits the situation (range, line of sight, height, HP, ult) and
//      performs it: taps, charged holds (tracking the target), full-charge clap
import { EL, KIND, Kind } from './elements.js';
import { BODY_W as BW, BODY_H as BH } from './sprite.js';
import { createInput } from './input.js';
import { projectiles } from './clash.js';

export const BOT_LEVELS = {
  easy: { name: 'Easy', react: [70, 130], aimErr: 0.45, dodge: 0, holdFrac: 0.5, jumpy: 0.002, aggro: 0.5 },
  normal: { name: 'Normal', react: [14, 40], aimErr: 0.12, dodge: 0.35, holdFrac: 0.85, jumpy: 0.006, aggro: 0.85 },
  hard: { name: 'Hard', react: [3, 14], aimErr: 0.02, dodge: 0.75, holdFrac: 1, jumpy: 0.012, aggro: 1 },
};

// Preferred distance band (cells) per bender.
const RANGE = { fire: [45, 105], water: [35, 95], earth: [30, 85], air: [14, 60] };
// Energy cost to start each move (mirrors abilities.js) so the bot doesn't spam failed casts.
const COST = {
  fire: { basic: 12, heavy: 10, special: 20, defense: 18, mobility: 8 },
  earth: { basic: 15, heavy: 8, special: 15, defense: 18, mobility: 8 },
  water: { basic: 12, heavy: 8, special: 28, defense: 10, mobility: 8 },
  air: { basic: 15, heavy: 8, special: 22, defense: 8, mobility: 8 },
};
// Energy drained per tick while holding (mirrors abilities.js).
const DRAIN = {
  fire: { heavy: 0.45, mobility: 1.0 }, earth: { heavy: 0.4, mobility: 0.8 },
  water: { heavy: 0.4, defense: 1.1, mobility: 0.9 }, air: { heavy: 0.45, defense: 0.2, mobility: 0.85 },
};

const SOLID = new Uint8Array(256);
for (let t = 0; t < 256; t++) SOLID[t] = KIND[t] === Kind.STATIC || KIND[t] === Kind.POWDER ? 1 : 0;
const rnd = (a, b) => a + Math.random() * (b - a);

export class Bot {
  constructor(player, level = 'normal') {
    this.p = player;
    this.level = level; // 'dummy' (stands still) and 'walker' (paces around) are training dummies
    this.L = BOT_LEVELS[level] || BOT_LEVELS.normal;
    this.inp = createInput();
    this.action = null;      // { slot, ticks, hold, aim: [h, v], track }
    this.think = 30;         // ticks until the next attack decision
    this.dodgeCd = 0;
    this.lastX = player.x; this.stuckT = 0; this.stuckWin = 0; this.unstick = 0;
    this.strafe = 0;         // small random footwork
    this.healing = false;
    this.blocked = 0;     // > 0: can't reach the enemy, so fight from longer range
  }

  // ---------- world sensing ----------
  solidAt(x, y) {
    const g = this.p.grid;
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || x >= g.w || y >= g.h) return true;
    if (y < 0) return false;
    return !!SOLID[g.type[y * g.w + x]];
  }
  cellAt(x, y) {
    const g = this.p.grid;
    x = Math.floor(x); y = Math.floor(y);
    return x < 0 || x >= g.w || y < 0 || y >= g.h ? 0 : g.type[y * g.w + x];
  }
  // Clear straight line (no rock / powder) between two points?
  los(x0, y0, x1, y1) {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 2);
    for (let k = 1; k < n; k++) if (this.solidAt(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n)) return false;
    return true;
  }
  wallAhead(dir) { // something to jump over in front of the body
    const p = this.p, fx = dir > 0 ? p.x + BW + 1 : p.x - 2;
    for (let y = p.y + 2; y < p.y + BH - 1; y++) if (this.solidAt(fx, y)) return true;
    return false;
  }
  // Bad landing in column x: lava, fire (unless fire bender), or deep water (unless a swimmer).
  // No fall damage, so plain drops are fine.
  badColumn(x) {
    const p = this.p, g = p.grid;
    for (let y = Math.max(0, Math.floor(p.y + BH - 2)); y < g.h; y++) {
      const t = this.cellAt(x, y);
      if (t === EL.LAVA || (t === EL.FIRE && p.type !== 'fire')) return true;
      if (t === EL.WATER) {
        if (p.def.swimmer) return false;
        let depth = 0;
        while (depth < 16 && this.cellAt(x, y + depth) === EL.WATER) depth++;
        return depth >= 14;
      }
      if (SOLID[t]) return false;
    }
    return false; // the map floor is solid
  }
  danger(dir) { return this.badColumn(this.p.x + BW / 2 + dir * 6); }
  // Is there safe footing within jumping range on the other side of a bad stretch?
  crossable(dir, reach = this.p.type === 'air' ? 70 : 24) {
    const p = this.p;
    let bad = false;
    for (let d = 4; d <= reach; d += 2) {
      const x = p.x + BW / 2 + dir * d;
      if (this.badColumn(x)) { bad = true; continue; }
      if (bad) { // first good column after the bad stretch: footing near our height?
        for (let y = p.y; y < p.y + BH + 10; y++) if (this.solidAt(x, y)) return true;
        return false;
      }
    }
    return !bad;
  }

  target(world) {
    const p = this.p;
    let best = null, bd = Infinity;
    for (const q of world.players) {
      if (q === p || q.dead || q.out || (p.team !== null && q.team === p.team)) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  // Incoming enemy projectile on a collision course?
  threatened(world) {
    const ps = world.particles, p = this.p, cx = p.x + BW / 2, cy = p.y + BH / 2;
    for (let i = 0; i < ps.n; i++) {
      if (ps.ghost[i] || !ps.owner[i] || ps.owner[i] === p.id + 1) continue;
      const dx = cx - ps.x[i], dy = cy - ps.y[i];
      if (Math.abs(dx) > 45 || Math.abs(dy) > 30) continue;
      const vx = ps.vx[i], vy = ps.vy[i], sp = Math.hypot(vx, vy);
      if (sp < 3) continue;
      const t = (dx * vx + dy * vy) / (sp * sp); // ticks to closest approach
      if (t < 0 || t > 14) continue;
      if (Math.hypot(ps.x[i] + vx * t - cx, ps.y[i] + vy * t - cy) < 8) return true;
    }
    for (const q of projectiles) { // clash-engine shots (fireballs, stones, ice spears)
      if (!q.alive || q.owner === p.id || (p.team !== null && q.team === p.team)) continue;
      const dx = cx - q.x, dy = cy - q.y, sp = Math.hypot(q.vx, q.vy);
      if (Math.abs(dx) > 60 || Math.abs(dy) > 40 || sp < 2) continue;
      const t = (dx * q.vx + dy * q.vy) / (sp * sp);
      if (t >= 0 && t < 14 && Math.hypot(q.x + q.vx * t - cx, q.y + q.vy * t - cy) < 10) return true;
    }
    return false;
  }

  // 8-way aim toward (dx, dy): [h, v] with h = -1/0/1 (0 = keep facing), v = -1 up / 0 / 1 down.
  aimAt(dx, dy) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    let v = ay > ax * 0.45 ? Math.sign(dy) : 0;
    let h = ax > ay * 0.45 ? Math.sign(dx) : 0;
    if (Math.random() < this.L.aimErr) v = [-1, 0, 1][(Math.random() * 3) | 0];
    if (!h && !v) h = Math.sign(dx) || 1;
    return [h, v];
  }

  // hold: planned hold ticks -> also needs the energy to finish the charge.
  ready(slot, hold = 0) {
    const p = this.p;
    if (p.cd[slot] > 0) return false;
    if (slot === 'ultimate') return p.ult >= 100;
    const drain = (DRAIN[p.type][slot] || 0) * hold * (slot === 'defense' ? 1 : 0.6);
    return p.energy >= (COST[p.type][slot] || 0) + drain + 2;
  }

  // ---------- move choice ----------
  choose(q, dx, dy, dist, clear) {
    const p = this.p, t = p.type, L = this.L;
    const flat = Math.abs(dy) < 14, near = dist < 30;
    const opts = []; // [score, slot, holdTicks]
    const add = (score, slot, hold = 0) => { if (score > 0 && this.ready(slot, hold)) opts.push([score * rnd(0.7, 1.3), slot, hold]); };
    const charge = (lo, hi) => Math.round(rnd(lo, hi) * L.holdFrac);
    if (t === 'fire') {
      add(dist < 110 ? 9 : 0, 'ultimate');
      add(Math.abs(dx) < 50 && Math.abs(dy) < 14 ? 6.5 : 0, 'basic');      // flame stomp: same floor, close
      add(dist < 140 && clear ? 5 : 0, 'heavy', charge(22, 48));
      add(dist < 60 ? 4.5 : 0, 'special');                                  // flame wall up close
      add(dist < 130 ? (q.type === 'water' ? 9 : 4) : 0, 'defense');       // lightning: the answer to water
    } else if (t === 'earth') {
      add(dist < 200 && q.onGround ? 9 : 0, 'ultimate');                    // continental rift under them
      add(near && q.cast ? 7 : 0, 'defense');                               // rock parry a close-range swing
      add(dist < 95 && !(q.rootT > 0) ? 6.5 : 0, 'basic');                 // earth grip
      add(q.rootT > 0 ? 3 : 0, 'special');                                  // held: wall up, then ram them
      add(dist > 25 && dist < 150 && clear ? 5 : 0, 'heavy', charge(30, 58));
      add(near ? 3 : 0, 'special');
    } else if (t === 'water') {
      add(dist < 130 ? 9 : 0, 'ultimate');
      add(dist < 120 && clear ? 6.5 : 0, 'basic');                         // water bullets
      add(q.type === 'earth' && dist < 75 ? 8 : dist < 50 && clear ? 4 : 0, 'defense', 60); // erosion jet: the answer to earth
      add(this.blocked > 0 && dist < 85 ? 7 : 0, 'defense', 60);           // wash away what's in the way
      add(dist > 25 && dist < 150 && clear ? 5.5 : 0, 'heavy', charge(25, 48));
      add(dist < 110 && Math.abs(dy) < 20 ? 6 : 0, 'special');             // tidal wave along the floor
    } else if (t === 'air') {
      add(9, 'ultimate');
      add(dist < 50 ? (q.type === 'earth' ? 8 : 4.5) : 0, 'defense');      // sonic boom: the answer to earth
      add(dist > 18 && dist < 120 && clear ? 5.5 : 0, 'basic');
      add(dist < 115 ? 5 : 0, 'heavy', charge(25, 48));
      add(dist < 100 && flat ? 4.5 : 0, 'special');
    }
    opts.sort((a, b) => b[0] - a[0]);
    return opts[0] || null;
  }

  start(slot, hold, dx, dy) {
    let aim = this.aimAt(dx, dy);
    if (this.p.type === 'earth' && (slot === 'ultimate' || slot === 'basic')) aim = [Math.sign(dx) || 1, slot === 'basic' && dy < -20 ? -1 : 0];
    if (slot === 'special' && this.p.type === 'air') aim = [Math.sign(dx) || 1, dy < -25 ? -1 : 0];
    this.action = { slot, ticks: hold || 3, hold: !!hold, aim, track: hold && slot !== 'defense', age: 0 };
  }

  // ---------- per tick ----------
  // Jumps are held for a moment (variable jump height cuts a jump short when the key is let go).
  update(world) {
    if (this.level === 'dummy' || this.level === 'walker') return this.dummy();
    const inp = this.brain(world);
    if (inp.jump) this.jumpHold = 14;
    if (this.jumpHold > 0) { this.jumpHold--; if (!this.action) inp.up = true; }
    return inp;
  }

  dummy() {
    const inp = this.inp, p = this.p;
    inp.left = inp.right = inp.up = inp.down = inp.jump = false;
    for (const s of ['basic', 'heavy', 'special', 'defense', 'mobility', 'ultimate']) inp.held[s] = false;
    if (this.level === 'walker' && !p.dead) {
      this.dir = this.dir || 1;
      if (Math.random() < 0.01 || this.wallAhead(this.dir) && !p.onGround) this.dir = -this.dir;
      if (p.x < 30) this.dir = 1; else if (p.x > p.grid.w - 30) this.dir = -1;
      if (this.dir < 0) inp.left = true; else inp.right = true;
      if (this.wallAhead(this.dir) && p.onGround) inp.jump = true;
      if (Math.random() < 0.006 && p.onGround) inp.jump = true;
    }
    return inp;
  }

  brain(world) {
    const p = this.p, L = this.L, inp = this.inp;
    inp.left = inp.right = inp.up = inp.down = inp.jump = false;
    for (const s of ['basic', 'heavy', 'special', 'defense', 'mobility', 'ultimate']) inp.held[s] = false;
    if (p.dead) { this.action = null; this.healing = false; return inp; }

    const q = this.target(world);
    const cx = p.x + BW / 2, cy = p.y + BH / 2;
    const dx = q ? q.x + BW / 2 - cx : 0, dy = q ? q.y + BH / 2 - cy : 0, dist = Math.hypot(dx, dy);
    const press = (dir) => { if (dir < 0) inp.left = true; else if (dir > 0) inp.right = true; };

    // Mid-move: keep the keys held, keep aiming.
    if (this.action) {
      const a = this.action;
      // A held move that got cut off (out of energy, stunned) or never started: let go.
      if (a.hold && ++a.age > 3 && !(p.channel && p.channel.slot === a.slot)) { this.action = null; return inp; }
      if (a.track && q) { const na = this.aimAt(dx, dy); a.aim = [na[0] || a.aim[0], na[1]]; }
      inp.held[a.slot] = true;
      press(a.aim[0]);
      if (a.aim[1] < 0) inp.up = true; else if (a.aim[1] > 0) inp.down = true;
      if (--a.ticks <= 0) this.action = null;
      return inp;
    }

    if (this.dodgeCd > 0) this.dodgeCd--;
    if (this.think > 0) this.think--;

    // Dodge incoming fire.
    if (this.dodgeCd <= 0 && this.threatened(world)) {
      this.dodgeCd = 25;
      if (Math.random() < L.dodge) {
        if (p.type === 'earth' && this.ready('defense') && Math.random() < 0.6) this.action = { slot: 'defense', ticks: 2, hold: false, aim: [Math.sign(dx) || 1, 0] }; // rock parry
        else if (p.onGround || (p.type === 'air' && !p.usedDouble)) inp.jump = true;
        else if (this.ready('mobility')) { this.action = { slot: 'mobility', ticks: 14, hold: true, age: 0, aim: [Math.random() < 0.5 ? -1 : 1, -1] }; }
        else if ((p.type === 'earth' || p.type === 'fire') && this.ready('special')) this.action = { slot: 'special', ticks: 2, hold: false, aim: [Math.sign(dx) || 1, 0] }; // wall up
      }
    }

    if (!q) { // nobody to fight: drift to the middle
      press(Math.sign(p.grid.w / 2 - cx));
      return inp;
    }

    // Low HP water bender: back off and heal.

    // ---- footwork ----
    const [lo, hi] = RANGE[p.type];
    const low = p.hp < 30 && L.aggro < 1;
    let move = 0;
    if (dist > hi || (Math.abs(dy) > 25 && Math.abs(dx) > 10)) move = Math.sign(dx);
    else if (dist < lo || low) move = -Math.sign(dx);
    if (Math.random() < 0.02) this.strafe = Math.random() < 0.5 ? 0 : (Math.random() < 0.5 ? -1 : 1) * Math.round(rnd(10, 30));
    if (!move && this.strafe) { move = Math.sign(this.strafe); this.strafe -= Math.sign(this.strafe); }
    // Backed against a map edge: go over / past them instead.
    if (move && ((move < 0 && cx < 20) || (move > 0 && cx > p.grid.w - 20))) { move = Math.sign(dx); inp.jump = p.onGround; }
    if (move && this.danger(move)) {
      if (Math.sign(dx) === move && dist > 30 && this.crossable(move)) {
        inp.jump = p.onGround || (p.type === 'air' && !p.usedDouble && p.vy > 0);
        if (p.type === 'air') inp.up = true; // glide across
      } else if (Math.sign(dx) === move && dist > 30 && p.onGround && this.ready('mobility') && this.crossable(move, 75)) {
        // too far to jump: dash / jet across, angled up
        this.action = { slot: 'mobility', ticks: 40, hold: true, age: 0, aim: [move, -1] };
        inp.jump = true;
        return inp;
      } else if (p.onGround) { move = 0; this.blocked = 90; } // hold position, fight from here
    }
    if (this.blocked > 0) this.blocked--;
    press(move);
    this.dbg = { move, dist: Math.round(dist) };
    // Walls / climbing.
    if (move && this.wallAhead(move) && (p.onGround || (p.type === 'air' && !p.usedDouble))) inp.jump = true;
    if (dy < -22 && Math.abs(dx) < 50 && p.onGround) inp.jump = true;
    if (p.type === 'air' && p.vy > 0.3 && dy < -10) inp.up = true; // glide / climb
    if (Math.random() < L.jumpy && p.onGround) inp.jump = true;
    // Underwater (not a swimmer): swim up.
    const head = this.cellAt(cx, p.y + 3);
    if (head === EL.WATER && !p.def.swimmer) {
      inp.up = true;
      if (p.air < p.def.breath * 0.6) { // drowning (maybe trapped under ice): blast out upward
        if (this.ready('mobility', 25)) { this.action = { slot: 'mobility', ticks: 25, hold: true, age: 0, aim: [0, -1] }; return inp; }
        if (p.type === 'fire' && this.ready('special', 30)) { this.action = { slot: 'special', ticks: 30, hold: true, age: 0, aim: [0, -1] }; return inp; }
        if (this.ready('heavy', 20)) { this.action = { slot: 'heavy', ticks: 20, hold: true, age: 0, aim: [0, -1] }; return inp; }
      }
    }
    // Stuck: wanted to move for most of the last second but got almost nowhere.
    if (move) this.stuckT++;
    if (++this.stuckWin >= 60) {
      const stuck = this.stuckT > 40 && Math.abs(p.x - this.lastX) < 4;
      this.stuckWin = 0; this.stuckT = 0; this.lastX = p.x;
      if (stuck) this.unstick = 1;
    }
    if (this.unstick) {
      this.unstick = 0;
      if (this.ready('mobility', 20)) { this.action = { slot: 'mobility', ticks: 20, hold: true, age: 0, aim: [move, -1] }; return inp; }
      if (p.type === 'fire' && this.ready('special')) { this.action = { slot: 'special', ticks: 3, hold: false, aim: [move, 0] }; return inp; } // kick through
    }
    // Close the gap fast when far.
    if (dist > 170 && this.ready('mobility') && Math.random() < 0.02 * L.aggro && !this.danger(Math.sign(dx))) {
      this.action = { slot: 'mobility', ticks: 35, hold: true, age: 0, aim: [Math.sign(dx), p.type === 'air' ? -1 : 0] };
      return inp;
    }

    // ---- attack ----
    if (this.think <= 0) {
      this.think = Math.round(rnd(...L.react));
      if (Math.random() > L.aggro) return inp;
      const clear = this.los(cx, p.y + 4, q.x + BW / 2, q.y + BH / 2);
      if (p.orbs && clear && dist < 150) { this.start('heavy', 0, dx, dy); this.action.ticks = 2; return inp; } // fling an orb
      const pick = this.choose(q, dx, dy, this.blocked > 0 ? dist * 0.7 : dist, clear || this.blocked > 0);
      if (pick) this.start(pick[1], pick[2], dx, dy);
    }
    return inp;
  }
}
