// The player bender: body, physics against the grid, environment damage, death burst.
import { Kind, KIND, EL } from './elements.js';
import { BODY_W, BODY_H, createAnim, updateAnim } from './sprite.js';
import { initAbilities, explode } from './abilities.js';
import { splash, addDust, shatterGlass } from './physics.js';
import { emit } from './sfx.js';
import { hitstop, slowmo, popup } from './juice.js';

export const BW = BODY_W;     // collision box width in cells
export const BH = BODY_H;     // collision box height in cells
export const MAX_HP = 100;

const GRAVITY = 0.08;         // cells/tick^2
const SPLAT_V = 2.6;          // knocked faster than this into terrain = a wall-splat
const MAX_FALL = 3.5;
const RESPAWN_TICKS = 120;
const SPAWN_PROTECTION = 90; // ticks of invulnerability after (re)spawning
const HOT_T = 300;            // cells hotter than this burn on contact
const COYOTE = 7;             // ticks you can still jump after walking off a ledge
const JUMP_BUFFER = 7;        // a jump pressed this many ticks before landing still happens
const WALL_SLIDE = 0.7;       // max fall speed while sliding down a wall you're pushing into

// passive multipliers: 0 = immune, 1 = normal
// look: stance (idle pose), robe, topknot, hood, headband, rope = trailing scarf/cape/ponytail {len, from}
export const BENDER_TYPES = {
  earth: {
    name: 'Earth', speed: 0.6, jump: 1.96, breath: 300,
    fireMul: 1, lavaMul: 1, heatMul: 1, steamMul: 1, crushMul: 0, windMul: 0.3,
    stance: 'wide', headband: true, rope: { len: 2, from: 'head' },
    palette: { H: '#3d2a1a', S: '#d9a877', E: '#111111', B: '#3f7a3a', T: '#7a5230', L: '#86603c', C: '#a0703e', F: '#3a2616' },
  },
  water: {
    name: 'Water', speed: 0.66, jump: 1.96, breath: 900, swimmer: true, heal: 0.05,
    fireMul: 1, lavaMul: 1, heatMul: 1, steamMul: 0, crushMul: 1, windMul: 1,
    stance: 'flow', robe: true, rope: { len: 4, from: 'neck' },
    palette: { H: '#1b2333', S: '#c99a6e', E: '#111111', B: '#2f6fd6', T: '#e8f2ff', L: '#2c56a0', C: '#e8f2ff', F: '#2a2320' },
  },
  fire: {
    name: 'Fire', speed: 0.72, jump: 1.96, breath: 300,
    fireMul: 0, lavaMul: 0.3, heatMul: 0, steamMul: 1, crushMul: 1, windMul: 1,
    stance: 'guard', rope: { len: 3, from: 'head' },
    palette: { H: '#3a2420', S: '#e0b48a', E: '#111111', B: '#c22d22', T: '#e8b04a', L: '#7a3024', C: '#3a2420', F: '#2a1612' },
  },
  air: {
    name: 'Air', speed: 0.84, jump: 2.14, breath: 300, doubleJump: true, glide: 0.6,
    fireMul: 1, lavaMul: 1, heatMul: 1, steamMul: 1, crushMul: 1, windMul: 1.5,
    stance: 'light', robe: true, hood: true, rope: { len: 3, from: 'neck' },
    palette: { H: '#e8742a', S: '#e3b88c', E: '#111111', B: '#f2c84b', T: '#e8742a', L: '#8a5a1e', C: '#e8742a', F: '#4a3218' },
  },
};

const SOLID = new Uint8Array(256);
for (let t = 0; t < 256; t++) SOLID[t] = KIND[t] === Kind.STATIC || KIND[t] === Kind.POWDER ? 1 : 0;

const NO_INPUT = { left: false, right: false, up: false, down: false, jump: false, held: {} };

export class Player {
  constructor(grid, type = 'fire') {
    this.grid = grid;
    this.type = type;
    this.id = Player.nextId++; // who did what (damage credit, projectile owner)
    Player.registry.set(this.id, this);
    this.team = null;          // players on the same team can't hurt each other
    this.onDeath = null;       // match hook: (victim) => {}
    this.spawn();
  }

  static nextId = 0;
  static registry = new Map(); // id -> player
  static clock = 0;            // match ticks (for "who hit me last")
  static particles = null;     // set by main: for landing / running dust
  static world = null;         // set by main: for wall-splat blasts

  get def() {
    return BENDER_TYPES[this.type];
  }

  // Top-center: first spot where the body fits, then dropped straight onto whatever is below
  // (no fall damage on spawn).
  spawn() {
    const g = this.grid;
    const sx = Math.max(2, Math.min(g.w - BW - 2, Math.floor(this.spawnX ?? g.w / 2) - Math.floor(BW / 2))); // map spawn point
    let sy = 0;
    while (sy < g.h - BH && this.collide(sx, sy)) sy++;
    while (sy < g.h - BH && !this.collide(sx, sy + 1)) sy++;
    Object.assign(this, {
      x: sx, y: sy, vx: 0, vy: 0, facing: 1, hp: MAX_HP, air: this.def.breath,
      dead: false, respawn: 0, flash: 0, onGround: false, usedDouble: false,
    });
    const keptUlt = this.ult || 0; // the ultimate meter survives respawns
    initAbilities(this);
    this.ult = keptUlt;
    this.invulnT = SPAWN_PROTECTION;
    this.anim = createAnim(this);
  }

  setType(type) {
    this.type = type;
    this.channel = null;
    this.meteors = null;
    this.air = Math.min(this.air, this.def.breath);
    this.anim = createAnim(this);
  }

  // Body box at integer (bx, by) overlaps a solid cell? Sides and floor are walls; sky is open.
  collide(bx, by) {
    const { w, h, type } = this.grid;
    for (let y = by; y < by + BH; y++) {
      if (y < 0) continue;
      if (y >= h) return true;
      for (let x = bx; x < bx + BW; x++) {
        if (x < 0 || x >= w) return true;
        if (SOLID[type[y * w + x]]) return true;
      }
    }
    return false;
  }

  // Bumping into floating debris (a few loose solid pixels left by blasts) knocks it away
  // instead of stopping you. Returns true if anything in the box at (bx, by) was cleared.
  clearStrays(bx, by) {
    const g = this.grid, ps = Player.particles;
    let any = false;
    for (let y = Math.max(0, by); y < Math.min(g.h, by + BH); y++) for (let x = Math.max(0, bx); x < Math.min(g.w, bx + BW); x++) {
      const c = g.strayCluster(x, y);
      if (!c) continue;
      g.crumbleStray(c);
      for (const i of c) if (ps) ps.lift(i % g.w, (i / g.w) | 0, this.vx * 0.5 + (Math.random() - 0.5), -0.5 - Math.random(), { bounces: 0 });
      any = true;
    }
    return any;
  }

  update(input) {
    if (this.dead) {
      if (this.rag) this.stepRag();
      if (--this.respawn <= 0) { this.rag = null; this.spawn(); }
      return;
    }
    if (this.invulnT > 0) this.invulnT--;
    if (this.stunT > 0) { this.stunT--; input = NO_INPUT; } // stunned / frozen: no control
    const d = this.def;
    this.resolveOverlap();
    const env = this.sense();

    // Held by Earth's grip: can't walk or jump.
    if (this.waterFormT > 0) this.waterFormT--;
    const rooted = this.rootT > 0;
    if (rooted) { this.rootT--; input = { ...input, jump: false, left: false, right: false }; }
    // Horizontal control (briefly weakened right after a wall jump, so the kick-off carries).
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    this.moveDir = dir; // read by the animation: running only happens on purpose
    if (dir && !(this.wallLock > 0)) this.facing = dir;
    let speed = d.speed;
    if (this.slowT > 0) speed *= 0.55; // stone armor
    if (rooted) this.vx *= 0.5;
    if (env.submerged) speed *= d.swimmer ? 0.9 : 0.5;
    if (env.lava) speed *= 0.4;
    // On ice you slide: barely any grip to speed up, stop or turn.
    const under = this.grid.get(Math.floor(this.x + BW / 2), Math.floor(this.y) + BH);
    this.onIce = this.onGround && under === EL.ICE;
    this.vx += (dir * speed * (this.onIce ? 1.25 : 1) - this.vx) * (this.onGround ? (this.onIce ? 0.03 : 0.3) : this.wallLock > 0 ? 0.03 : 0.12);
    if (this.wallLock > 0) this.wallLock--;
    if (this.surfT > 0) { this.surfT--; this.vx = this.surfVX; } // earth surf carries you

    // Vertical: swim in liquid, otherwise gravity + jumps.
    if (env.submerged) {
      this.vy += GRAVITY * 0.25;
      this.vy *= 0.9;
      if (input.up) this.vy -= d.swimmer ? 0.2 : 0.14;
      if (input.down) this.vy += 0.08;
      if (env.liquidFrac > 0.6) this.vy -= 0.04; // buoyancy
      this.vy = Math.max(-1.2, Math.min(1.2, this.vy));
    } else {
      this.vy += GRAVITY;
      if (d.glide && input.up && this.vy > d.glide) this.vy = d.glide;
      // Forgiving jumps: coyote time (just walked off a ledge) + input buffer (pressed just
      // before landing). Wall jumps kick you off a wall you're touching in the air.
      if (this.onGround) this.coyote = COYOTE; else if (this.coyote > 0) this.coyote--;
      if (input.jump) this.jumpBuf = JUMP_BUFFER; else if (this.jumpBuf > 0) this.jumpBuf--;
      if (rooted) { this.jumpBuf = 0; this.coyote = 0; }
      const bx = Math.floor(this.x), by = Math.floor(this.y);
      const wall = this.onGround ? 0 : this.collide(bx + 1, by) ? 1 : this.collide(bx - 1, by) ? -1 : 0;
      if (this.jumpBuf > 0 && (this.onGround || this.coyote > 0)) {
        this.vy = -d.jump; this.jumpBuf = 0; this.coyote = 0; this.rising = true; emit('jump', this.x);
      } else if (this.jumpBuf > 0 && wall) {
        this.vy = -d.jump * 0.95; this.vx = -wall * 1.7; this.facing = -wall; this.wallLock = 10;
        this.jumpBuf = 0; this.rising = true; this.usedDouble = false; emit('jump2', this.x);
        this.dust(wall > 0 ? bx + BW : bx - 1, by + BH / 2, 4);
      } else if (input.jump && d.doubleJump && !this.usedDouble && !this.onGround) {
        this.vy = -d.jump * 0.9; this.usedDouble = true; this.jumpBuf = 0; this.rising = true; emit('jump2', this.x);
      }
      // Variable height: let go of jump early and the rise is cut short.
      if (this.rising && !input.up && this.vy < -0.5) { this.vy *= 0.5; this.rising = false; }
      if (this.vy >= 0) this.rising = false;
      // Wall slide: pushing into a wall in the air slows the fall.
      this.wallSlide = wall && dir === wall && this.vy > 0 ? wall : 0;
      if (this.wallSlide) {
        this.vy = Math.min(this.vy, WALL_SLIDE);
        if ((this.anim.t & 7) === 0) this.dust(wall > 0 ? bx + BW : bx - 1, by + BH / 3, 1);
      }
      this.vy = Math.min(this.vy, MAX_FALL);
    }

    // Dash (mobility moves): fixed velocity, no gravity, for a few ticks.
    if (this.dashT > 0) {
      this.dashT--;
      this.vx = this.dashVX;
      this.vy = this.dashVY;
      this.dashGrace = 8; // no fall damage from dashing into the ground
    } else if (this.dashGrace > 0) this.dashGrace--;

    // Wind pushes the body.
    const [wx, wy] = this.grid.windAt(this.x + BW / 2, this.y + BH / 2);
    this.windX = wx * d.windMul; // effective sideways wind on this body, for the drag pose
    this.vx += wx * 0.04 * d.windMul;
    this.vy += wy * 0.04 * d.windMul;

    const impact = this.vy;
    const wasGround = this.onGround;
    const pvx = this.vx, pvy = this.vy;
    this.moveX();
    this.moveY();
    // Knocked hard into a wall / the floor / a ceiling: you smash into it (a crater, flying
    // debris, a freeze-frame, extra damage credited to whoever sent you).
    const hitRecent = this.lastHitAt !== undefined && Player.clock - this.lastHitAt < 45;
    if (this.splatCd > 0) this.splatCd--;
    else if (hitRecent && Player.world && !(this.dashGrace > 0)) { // (not while jetting)
      const cx = this.x + BW / 2, cy = this.y + BH / 2;
      if (Math.abs(pvx) > SPLAT_V && Math.abs(this.vx) < 0.05) this.splat(pvx > 0 ? this.x + BW + 1 : this.x - 1, cy, Math.abs(pvx), -Math.sign(pvx), 0);
      else if (pvy > SPLAT_V + 0.6 && this.vy === 0) this.splat(cx, this.y + BH + 1, pvy, 0, -1);
      else if (pvy < -SPLAT_V && this.vy === 0) this.splat(cx, this.y - 1, -pvy, 0, 1);
    }
    // Plunging into water throws up a splash.
    const wet = this.grid.get(Math.floor(this.x + BW / 2), Math.floor(this.y + BH - 2)) === EL.WATER;
    if (wet && !this.wasWet && pvy > 1.6) splash(this.x + BW / 2, this.y + BH - 2, pvy * 2.2);
    this.wasWet = wet;

    // Touchdown = not grounded last tick, grounded now (the fall can end exactly on the floor
    // without moveY ever being blocked, so don't rely on that).
    this.onGround = this.collide(Math.floor(this.x), Math.floor(this.y) + 1);
    const touchdown = this.onGround && !wasGround && impact > 0;
    if (touchdown) {
      this.vy = 0;
      if (impact > 1.2) emit('land', this.x, impact);
      if (impact > 0.9) this.dust(Math.floor(this.x + BW / 2), Math.floor(this.y) + BH, Math.min(10, Math.round(impact * 3)));
    } else if (this.onGround && Math.abs(this.vx) > 0.45 && (this.anim.t % 7) === 0) {
      this.dust(Math.floor(this.x + BW / 2 - Math.sign(this.vx) * 3), Math.floor(this.y) + BH, 1); // running kicks up a puff
    }
    // Damage numbers: hits within a short window add up into one popup.
    if (this.dmgShowT > 0 && --this.dmgShowT === 0) this.flushDamage();
    if (this.onGround) this.usedDouble = false;
    if (this.flash > 0) this.flash--;
    updateAnim(this, env, touchdown ? impact : 0);

    if (!this.dead) this.applyEnv(env);
  }

  // Step one cell at a time so fast motion can't tunnel. Walking auto-climbs 1-2 cell ledges.
  moveX() {
    let rem = this.vx;
    while (Math.abs(rem) > 1e-6) {
      const step = Math.sign(rem) * Math.min(1, Math.abs(rem));
      rem -= step;
      const nx = this.x + step;
      const bx = Math.floor(nx), by = Math.floor(this.y);
      if (bx === Math.floor(this.x) || !this.collide(bx, by)) { this.x = nx; continue; }
      let climbed = false;
      if (this.onGround) {
        for (let k = 1; k <= 2 && !climbed; k++) {
          if (!this.collide(bx, by - k)) { this.x = nx; this.y -= k; climbed = true; }
        }
      }
      if (!climbed && this.clearStrays(bx, by) && !this.collide(bx, by)) { this.x = nx; continue; }
      if (!climbed) { this.vx = 0; return; }
    }
  }

  moveY() {
    let rem = this.vy;
    while (Math.abs(rem) > 1e-6) {
      const step = Math.sign(rem) * Math.min(1, Math.abs(rem));
      rem -= step;
      const ny = this.y + step;
      const by = Math.floor(ny);
      if (by === Math.floor(this.y) || !this.collide(Math.floor(this.x), by)) { this.y = ny; continue; }
      if (step < 0 && this.clearStrays(Math.floor(this.x), by) && !this.collide(Math.floor(this.x), by)) { this.y = ny; continue; } // head-butt debris overhead
      this.vy = 0;
      return step > 0;
    }
    return false;
  }

  // The grid doesn't know about the body, so sand can fall into it or get painted on it.
  // Lift the body if there's room above, otherwise shove loose cells out sideways.
  resolveOverlap() {
    const g = this.grid;
    let bx = Math.floor(this.x), by = Math.floor(this.y);
    if (!this.collide(bx, by)) return;
    for (let k = 1; k <= 3; k++) {
      if (!this.collide(bx, by - k)) { this.y -= k; return; }
    }

    let crushed = 0;
    for (let y = Math.max(0, by); y < Math.min(g.h, by + BH); y++) {
      for (let x = Math.max(0, bx); x < Math.min(g.w, bx + BW); x++) {
        const i = y * g.w + x;
        if (KIND[g.type[i]] !== Kind.POWDER) continue;
        const side = x - bx < BW / 2 ? -1 : 1;
        const start = side < 0 ? bx - 1 : bx + BW;
        for (let s = 0; s < 6; s++) {
          const tx = start + side * s;
          if (g.get(tx, y) === 0) { g.swap(i, y * g.w + tx); break; }
        }
        if (y < by + 3) crushed++;
      }
    }
    if (crushed) this.damage(crushed * 0.3 * this.def.crushMul);

    // Still stuck inside something static: nudge sideways, then upward.
    if (!this.collide(bx, by)) return;
    for (let s = 1; s <= 6; s++) {
      if (!this.collide(bx - s, by)) { this.x -= s; return; }
      if (!this.collide(bx + s, by)) { this.x += s; return; }
    }
    for (let k = 4; k <= BH + 3; k++) {
      if (!this.collide(bx, by - k)) { this.y -= k; return; }
    }
  }

  // Count what the body overlaps; the row under the feet counts for heat only.
  sense() {
    const g = this.grid;
    const bx = Math.floor(this.x), by = Math.floor(this.y);
    let liquid = 0, lava = 0, fire = 0, steam = 0, hot = 0, head = 0;
    for (let r = 0; r <= BH; r++) {
      const y = by + r;
      if (y < 0 || y >= g.h) continue;
      for (let x = bx; x < bx + BW; x++) {
        if (x < 0 || x >= g.w) continue;
        const i = y * g.w + x;
        const t = g.type[i];
        if (t === 0) continue;
        const T = g.temp[i];
        if (t !== EL.FIRE && t !== EL.LAVA && T > HOT_T) hot += T - HOT_T;
        if (r === BH) continue;
        if (KIND[t] === Kind.LIQUID) {
          liquid++;
          if (t === EL.LAVA) lava++;
          if (r < 2) head++;
        } else if (t === EL.FIRE) fire++;
        else if (t === EL.STEAM) steam++;
      }
    }
    const liquidFrac = liquid / (BW * BH);
    return { liquidFrac, submerged: liquidFrac > 0.35, lava, fire, steam, hot, headUnder: head >= BW * 2 - 1 };
  }

  applyEnv(env) {
    const d = this.def;
    let dmg = 0;
    if (env.fire) dmg += Math.min(0.4, env.fire * 0.03) * d.fireMul;
    if (env.lava) dmg += Math.min(0.8, env.lava * 0.15) * d.lavaMul; // up to ~48 per second standing in lava
    if (env.hot) dmg += Math.min(0.4, env.hot * 0.0003) * d.heatMul;
    if (env.steam) dmg += Math.min(0.3, env.steam * 0.02) * d.steamMul;

    if (env.headUnder) {
      this.air = Math.max(0, this.air - 1);
      if (this.air === 0) dmg += 0.3;
    } else {
      this.air = Math.min(d.breath, this.air + 3);
    }
    if (d.heal && env.liquidFrac > 0.3 && !env.lava) this.hp = Math.min(MAX_HP, this.hp + d.heal);
    if (dmg > 0) this.damage(dmg);
  }

  // Take damage from attacker `by` (player id, or -1 for the environment). Teammates can't hurt
  // each other; freshly spawned players are briefly invulnerable. Returns the damage applied.
  damage(n, by = -1) {
    if (this.dead || n <= 0 || this.invulnT > 0) return 0;
    if (this.waterFormT > 0 && by !== this.id) { this.waterDodged = true; return 0; } // water form: it passes through
    if (this.domeUp && by !== this.id) return 0; // inside a vine dome
    if (this.parry && this.parry.t <= 24 && by !== this.id) { // rock parry: absorbed (and countered)
      if (this.parry.hit === null && by >= 0) this.parry.hit = by;
      return 0;
    }
    if (by >= 0 && by !== this.id) {
      const a = Player.registry.get(by);
      if (a && this.team !== null && a.team === this.team) return 0;
      this.lastHitBy = by;
      this.lastHitAt = Player.clock;
    }
    this.hp -= n;
    if (n >= 0.05) this.flash = 6;
    if (by >= 0) {
      this.dmgShow = (this.dmgShow || 0) + n; this.dmgShowT = 12;
      if (n >= 6) { // a real hit: freeze-frame + a readable knockback arc away from the attacker
        hitstop(Math.min(6, 2 + n / 6));
        const a = Player.registry.get(by), side = a ? Math.sign(this.x - a.x) || 1 : this.facing * -1;
        this.vx += side * Math.min(2.2, n * 0.07);
        this.vy -= Math.min(1.8, 0.4 + n * 0.05);
      }
    }
    if (n >= 0.3) emit('hit', this.x, n, 'hit' + this.id, 110);
    if (this.hp <= 0) this.die();
    return n;
  }

  flushDamage() {
    const by = Player.registry.get(this.lastHitBy); // tinted with the attacker's color: who hit whom
    if (this.dmgShow >= 1) popup(this.x + BW / 2, this.y - 20, Math.round(this.dmgShow), by && by.color && by !== this ? by.color : this.dmgShow >= 15 ? '#ffd24e' : '#ffffff');
    this.dmgShow = 0; this.dmgShowT = 0;
  }

  // Smashed into terrain at speed: a crater blast at the contact point (credited to the attacker),
  // a bounce back off it, dust, a freeze-frame.
  splat(x, y, speed, bx, by) {
    this.splatCd = 30;
    const r = Math.min(5, 2 + speed * 0.55);
    shatterGlass(x, y, r * 2, 3);
    explode(Player.world, x, y, r, 0, true, false, this.lastHitBy !== undefined ? this.lastHitBy : -1);
    addDust(x, y, 14, 0.5);
    hitstop(5);
    this.vx = bx * speed * 0.35; if (by) this.vy = by * speed * 0.3;
    emit('splat', x, 2);
  }

  // Knocked out: the body tumbles away spinning, bounces off what it hits and crashes through glass.
  stepRag() {
    const r = this.rag, g = this.grid;
    if (++r.t > 160) { this.rag = null; return; }
    const solid = (x, y) => {
      const X = Math.floor(x), Y = Math.floor(y);
      if (X < 0 || X >= g.w || Y >= g.h) return 2;
      if (Y < 0) return 0;
      const t = g.type[Y * g.w + X];
      return t === EL.GLASS ? 3 : KIND[t] === Kind.STATIC || KIND[t] === Kind.POWDER ? 1 : 0;
    };
    if (!r.rest) r.vy = Math.min(4.5, r.vy + 0.12);
    const cx = r.x + BW / 2, cy = r.y + BH / 2, R = 4;
    const nx = cx + r.vx, sx = solid(nx + Math.sign(r.vx) * R, cy);
    if (sx === 3) { shatterGlass(nx + Math.sign(r.vx) * R, cy, 5, 2.5); r.vx *= 0.8; r.x += r.vx; }
    else if (sx) { r.vx *= -0.45; r.spin *= 0.6; if (Math.abs(r.vx) > 0.8) this.dust(Math.floor(nx), Math.floor(cy), 4); }
    else r.x += r.vx;
    const ny = cy + r.vy, sy = solid(cx, ny + Math.sign(r.vy) * R);
    if (sy === 3) { shatterGlass(cx, ny + Math.sign(r.vy) * R, 5, 2.5); r.vy *= 0.8; r.y += r.vy; }
    else if (sy) {
      if (Math.abs(r.vy) > 1) { this.dust(Math.floor(cx), Math.floor(ny + R), 6); emit('land', r.x, Math.abs(r.vy)); }
      r.vy = Math.abs(r.vy) > 0.7 ? -r.vy * 0.35 : 0; r.vx *= 0.7; r.spin *= 0.6;
      if (r.vy === 0) r.rest = true;
    } else { r.y += r.vy; r.rest = false; }
    if (r.rest) { r.vx *= 0.85; const lie = Math.round(r.a / (Math.PI / 2)) * (Math.PI / 2); r.a += (lie - r.a) * 0.2; r.spin = 0; } // settles lying down
    else r.a += r.spin;
  }

  // A puff of whatever you're standing on (sand, snow, stone ...), visual only.
  dust(x, y, n) {
    const ps = Player.particles, g = this.grid;
    if (!ps) return;
    let t = g.get(x, y);
    if (!t || t === 255) t = g.get(x, y + 1);
    if (!t || t === 255 || KIND[t] === Kind.LIQUID || KIND[t] === Kind.GAS) return;
    for (let k = 0; k < n; k++) {
      ps.spawn(x + (Math.random() - 0.5) * 3, y - 1, (Math.random() - 0.5) * 1.6, -0.3 - Math.random() * 0.7, t, { ghost: true, gravity: 0.06, life: 10 + Math.random() * 8 });
    }
  }

  die() {
    this.flushDamage();
    { // the body goes tumbling, away from whoever finished you
      const a = Player.registry.get(this.lastHitBy), side = a && a !== this ? Math.sign(this.x - a.x) || 1 : -this.facing;
      this.rag = { x: this.x, y: this.y, vx: this.vx * 0.8 + side * 1.6, vy: Math.min(this.vy, 0) - 2.6, a: 0, spin: side * (0.25 + Math.random() * 0.2), t: 0, rest: false };
    }
    if (this.lastHitBy !== undefined) slowmo(28, 0.35); // a KO lands in slow motion
    this.hp = 0;
    this.dead = true;
    this.respawn = RESPAWN_TICKS;
    emit('ko', this.x);
    if (this.onDeath) this.onDeath(this); // the match may change the respawn (or cancel it)
    const g = this.grid;
    const cx = Math.round(this.x + BW / 2), cy = Math.round(this.y + BH / 2);
    switch (this.type) {
      case 'earth': g.paint(cx, cy, 5, EL.EARTH); g.paint(cx, cy, 6, EL.SAND); break;
      case 'water': g.paint(cx, cy, 6, EL.WATER); break;
      case 'fire': g.paint(cx, cy, 6, EL.FIRE); g.paint(cx, cy, 6, EL.FIRE); break;
      case 'air':
        for (let a = 0; a < 8; a++) {
          const dx = Math.cos((a * Math.PI) / 4), dy = Math.sin((a * Math.PI) / 4);
          g.addWind(cx + dx * 8, cy + dy * 8, 10, dx * 6, dy * 6);
        }
        break;
    }
  }
}

