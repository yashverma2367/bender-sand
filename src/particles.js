// Free-flying particles: single cells of an element that leave the sand grid and fly with
// velocity, gravity, drag and wind (rocks thrown, water whips, fireballs). When a particle hits
// something it either reacts with it (same REACTIONS table as the grid: fire + water -> steam),
// bounces, or settles back into the grid as a normal cell. One particle = one cell, so matter is
// conserved: lifting cells out of the grid and throwing them never creates or destroys material.
//
// Storage is struct-of-arrays with swap-remove, so thousands of particles stay cheap.
import { Kind, KIND, WIND, R_CHANCE, R_SELF, R_OTHER, SHADES, AMBIENT, SPAWN_T, EL, IGNITE_T } from './elements.js';

const DEFAULT_MAX = 8192;
const GRAVITY = 0.08;      // matches the player
const GAS_GRAVITY = -0.03; // gases float up
const DRAG = 0.995;
const WIND_PUSH = 0.03;
const BOUNCE_REST = 0.4;   // speed kept after a bounce
const MIN_BOUNCE_SPEED = 0.6;
const MAX_HIT_PER_TICK = 4; // most particle-hit damage one body can take per tick

export class Particles {
  constructor(grid, max = DEFAULT_MAX) {
    this.grid = grid;
    this.max = max;
    this.n = 0;
    this.x = new Float32Array(max);
    this.y = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.g = new Float32Array(max);       // gravity per tick
    this.drag = new Float32Array(max);
    this.temp = new Float32Array(max);
    this.type = new Uint8Array(max);
    this.shade = new Uint8Array(max);
    this.life = new Uint16Array(max);     // ticks left, 0 = until it hits something
    this.bounces = new Uint8Array(max);   // bounces left before settling
    this.boom = new Float32Array(max);    // > 0: explodes with this radius on impact / expiry
    this.ghost = new Uint8Array(max);     // 1: visual only, passes through everything, never settles
    this.tag = new Uint8Array(max);       // free label for moves that need to find their particles later
    this.owner = new Uint8Array(max);     // player id + 1 of whoever launched it (0 = nobody)
    this.dmg = new Float32Array(max);     // damage multiplier when it hits a body (sprays are tiny)
    this.tickNo = 0;
    this.defaultOwner = 0;                // owner given to particles spawned without one
    // Bodies that flying particles can hit: [{ id, x, y, dead, damage(n) }], and a callback
    // onHit(ownerId, victim, damage) so attackers can be credited.
    this.bodies = null;
    this.onHit = null;
    // Called as onImpact(x, y, radius, type) when a booming particle hits or expires.
    this.onImpact = null;
  }

  // Spawn one particle. opts: gravity, drag, life (ticks), bounces, temp, boom (explosion radius),
  // ghost (visual only: no collisions, vanishes when its life runs out).
  // Returns its index, or -1 if the pool is full.
  spawn(x, y, vx, vy, type, opts = {}) {
    if (this.n >= this.max) return -1;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y;
    this.vx[i] = vx; this.vy[i] = vy;
    this.g[i] = opts.gravity ?? (KIND[type] === Kind.GAS ? GAS_GRAVITY : GRAVITY);
    this.drag[i] = opts.drag ?? DRAG;
    this.temp[i] = opts.temp ?? SPAWN_T[type];
    this.type[i] = type;
    this.shade[i] = (Math.random() * SHADES) | 0;
    this.life[i] = opts.life ?? 0;
    this.bounces[i] = opts.bounces ?? 0;
    this.boom[i] = opts.boom ?? 0;
    this.ghost[i] = opts.ghost ? 1 : 0;
    this.tag[i] = opts.tag ?? 0;
    this.owner[i] = opts.owner ?? this.defaultOwner;
    this.dmg[i] = opts.dmg ?? 1;
    return i;
  }

  // Pull a cell out of the grid and launch it as a particle (keeps its heat).
  // Returns the particle index, or -1 if the cell is empty / out of bounds / pool full.
  lift(cx, cy, vx, vy, opts = {}) {
    const g = this.grid;
    if (!g.inBounds(cx, cy)) return -1;
    const ci = cy * g.w + cx;
    const t = g.type[ci];
    if (t === 0) return -1;
    const i = this.spawn(cx + 0.5, cy + 0.5, vx, vy, t, { temp: g.temp[ci], ...opts });
    if (i >= 0) { g.type[ci] = 0; g.temp[ci] = AMBIENT; g.life[ci] = 0; }
    return i;
  }

  clear() {
    this.n = 0;
  }

  // Swap-remove.
  kill(i) {
    const last = --this.n;
    if (i === last) return;
    this.x[i] = this.x[last]; this.y[i] = this.y[last];
    this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last];
    this.g[i] = this.g[last]; this.drag[i] = this.drag[last];
    this.temp[i] = this.temp[last]; this.type[i] = this.type[last];
    this.shade[i] = this.shade[last]; this.life[i] = this.life[last];
    this.bounces[i] = this.bounces[last];
    this.boom[i] = this.boom[last];
    this.ghost[i] = this.ghost[last];
    this.tag[i] = this.tag[last];
    this.owner[i] = this.owner[last];
    this.dmg[i] = this.dmg[last];
  }

  // Explode (if it carries a boom) instead of settling.
  detonate(i, x, y) {
    if (this.boom[i] > 0 && this.onImpact) {
      this.onImpact(x, y, this.boom[i], this.type[i], this.owner[i] - 1);
      return true;
    }
    return false;
  }

  step() {
    this.tickNo++;
    let i = 0;
    while (i < this.n) {
      const ox = this.x[i], oy = this.y[i];
      if (this.update(i) && !this.hitBody(i, ox, oy)) i++;
      else this.kill(i); // the last particle moved into slot i, so don't advance
    }
  }

  // A fast, solid particle flying into another player's body hurts them (more when faster) and
  // stops there (booming ones explode on them). Returns true if the particle is used up.
  // Swept along the whole path from (ox, oy) this tick, so fast shots can't skip over a body.
  hitBody(i, ox, oy) {
    const bodies = this.bodies;
    if (!bodies || this.ghost[i]) return false;
    const vx = this.vx[i], vy = this.vy[i], sp2 = vx * vx + vy * vy;
    if (sp2 < 6.25) return false; // slower than 2.5 cells/tick: harmless
    const ex = this.x[i], ey = this.y[i], steps = Math.max(1, Math.ceil(Math.hypot(ex - ox, ey - oy)));
    for (const b of bodies) {
      if (b.dead || b.id + 1 === this.owner[i]) continue;
      let x = ex, y = ey, inside = false;
      for (let s = 1; s <= steps && !inside; s++) {
        x = ox + ((ex - ox) * s) / steps; y = oy + ((ey - oy) * s) / steps;
        inside = x >= b.x - 0.5 && x <= b.x + 3.5 && y >= b.y && y <= b.y + 12;
      }
      if (!inside) continue;
      // Damage: faster = harder, scaled per particle; capped per body per tick so a cloud of
      // debris can't shred someone instantly.
      if (b.hitTick !== this.tickNo) { b.hitTick = this.tickNo; b.hitDmg = 0; }
      const dmg = Math.min(8, Math.sqrt(sp2) * 0.6) * (KIND[this.type[i]] === Kind.GAS ? 0.5 : 1) * this.dmg[i];
      const dealt = Math.max(0, Math.min(dmg, MAX_HIT_PER_TICK - b.hitDmg));
      if (dealt > 0) {
        b.hitDmg += dealt;
        const applied = b.damage(dealt, this.owner[i] - 1);
        if (this.onHit && applied) this.onHit(this.owner[i] - 1, b, applied);
      }
      if (this.detonate(i, x, y)) return true;
      this.settle(i, Math.floor(x - vx / Math.sqrt(sp2) * 2), Math.floor(y));
      return true;
    }
    return false;
  }

  // Returns false when the particle is gone (settled, reacted, expired).
  update(i) {
    const g = this.grid, t = this.type[i];
    if (this.ghost[i]) {
      this.vy[i] += this.g[i];
      this.x[i] += this.vx[i];
      this.y[i] += this.vy[i];
      return --this.life[i] > 0;
    }
    if (this.life[i] && --this.life[i] === 0) {
      if (!this.detonate(i, this.x[i], this.y[i])) this.settle(i, Math.floor(this.x[i]), Math.floor(this.y[i]));
      return false;
    }

    // Forces: gravity, wind, drag.
    if (g.inBounds(this.x[i], this.y[i])) {
      const [wx, wy] = g.windAt(this.x[i], this.y[i]);
      this.vx[i] += wx * WIND[t] * WIND_PUSH;
      this.vy[i] += wy * WIND[t] * WIND_PUSH;
    }
    this.vy[i] += this.g[i];
    this.vx[i] *= this.drag[i];
    this.vy[i] *= this.drag[i];

    // Move in sub-steps of at most 1 cell so fast particles can't tunnel through walls.
    const vx = this.vx[i], vy = this.vy[i];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(vx), Math.abs(vy))));
    let px = this.x[i], py = this.y[i];
    for (let s = 0; s < steps; s++) {
      const nx = px + vx / steps, ny = py + vy / steps;
      const cx = Math.floor(nx), cy = Math.floor(ny);
      if (cy < 0) {                       // above the screen: keep flying, unless way off
        if (ny < -60) return false;
        px = nx; py = ny; continue;
      }
      if (cx < 0 || cx >= g.w || cy >= g.h) { // side walls / floor
        return this.collide(i, px, py, nx, ny, -1, cx, cy);
      }
      const ci = cy * g.w + cx;
      const u = g.type[ci];
      if (u !== 0 && KIND[u] !== Kind.GAS) return this.collide(i, px, py, nx, ny, ci, cx, cy);
      // Flying through a gas it reacts with (water through fire): change the gas, keep going.
      if (u !== 0) {
        const r = t * 256 + u;
        if (R_CHANCE[r] > 0 && R_SELF[r] === t && R_OTHER[r] !== u) g.transform(ci, R_OTHER[r]);
      }
      px = nx; py = ny;
    }
    this.x[i] = px; this.y[i] = py;
    return true;
  }

  // Hit cell ci (or a wall when ci = -1) while moving from (px,py) to (nx,ny).
  collide(i, px, py, nx, ny, ci, cx, cy) {
    const g = this.grid, t = this.type[i];
    const lx = Math.floor(px), ly = Math.floor(py);

    // Ice shards freeze what they hit (and then stick as ice).
    if (t === EL.ICE) g.freeze(px, py, ci >= 0 && g.type[ci] === EL.WATER ? 3.5 : 1.8); // spreads over open water

    // Water splashing on something burning puts it out.
    if (ci >= 0 && t === EL.WATER) {
      const u = g.type[ci];
      if (IGNITE_T[u] !== Infinity && g.life[ci] > 0) { g.life[ci] = 0; g.temp[ci] = AMBIENT; }
    }

    if (this.detonate(i, px, py)) return false;

    // Reaction with what it hit (fire -> water = steam, lava -> water = obsidian, ...).
    if (ci >= 0) {
      const u = g.type[ci], r = t * 256 + u;
      if (R_CHANCE[r] > 0) {
        if (R_OTHER[r] !== u) g.transform(ci, R_OTHER[r]);
        if (R_SELF[r] !== 0) this.settle(i, lx, ly, R_SELF[r]);
        return false;
      }
    }

    // Bounce off, losing speed; settle once out of bounces or too slow.
    const speed = Math.hypot(this.vx[i], this.vy[i]);
    if (this.bounces[i] > 0 && speed > MIN_BOUNCE_SPEED) {
      this.bounces[i]--;
      const blockedX = !this.free(Math.floor(nx), ly);
      const blockedY = !this.free(lx, Math.floor(ny));
      if (blockedX || !blockedY) this.vx[i] *= -BOUNCE_REST;
      if (blockedY || !blockedX) this.vy[i] *= -BOUNCE_REST;
      if (blockedY && !blockedX) this.vx[i] *= 0.8; // floor friction
      this.x[i] = px; this.y[i] = py;
      return true;
    }

    this.settle(i, lx, ly);
    return false;
  }

  free(x, y) {
    const g = this.grid;
    if (y < 0) return x >= 0 && x < g.w;
    if (!g.inBounds(x, y)) return false;
    const u = g.type[y * g.w + x];
    return u === 0 || KIND[u] === Kind.GAS;
  }

  // Put the particle back into the grid as a cell at (x,y), or the nearest empty spot above /
  // beside it. Lost only if there is nowhere to put it.
  settle(i, x, y, as = this.type[i]) {
    const g = this.grid;
    x = Math.max(0, Math.min(g.w - 1, x));
    y = Math.min(g.h - 1, y);
    if (y < 0) return;
    const spots = [[0, 0], [0, -1], [-1, 0], [1, 0], [-1, -1], [1, -1], [0, -2]];
    for (const [dx, dy] of spots) {
      const sx = x + dx, sy = y + dy;
      if (!g.inBounds(sx, sy) || g.type[sy * g.w + sx] !== 0) continue;
      g.set(sx, sy, as);
      if (as === this.type[i] && KIND[as] !== Kind.GAS) g.temp[sy * g.w + sx] = this.temp[i];
      return;
    }
  }
}
