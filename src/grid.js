// Cell storage + per-tick simulation: heat, air field, reactions, movement.
import {
  Kind, EL, KIND, DENSITY, SLIDE, COHESIVE, DISPERSION, VISCOSITY, WIND, SPAWN_T, HOLD_T, COND, AIRLOSS,
  HOT_T, HOT_TO, HOT_P, COLD_T, COLD_TO, COLD_P, LIFE_MIN, LIFE_MAX, DEATH_TO, DEATH_P,
  IGNITE_T, BURN_MIN, BURN_MAX, ASH_P, R_CHANCE, R_SELF, R_OTHER, HAS_RULES,
  WALL, AMBIENT, BURN_T, SHADES,
} from './elements.js';

export const FIELD = 4;     // air field cell = 4x4 grid cells
const WIND_MAX = 6;
const WIND_DECAY = 0.97;
const RADIANT_HEAT = 120;

const DX4 = [0, 0, -1, 1];
const DY4 = [-1, 1, 0, 0];
// Burning cells throw fire mostly upward.
const FIRE_DX = [0, 0, -1, 1, 0];
const FIRE_DY = [-1, -1, 0, 0, 1];

function randRange(min, max) {
  return min + ((Math.random() * (max - min + 1)) | 0);
}

export class Grid {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.type = new Uint8Array(n);   // element id per cell
    this.shade = new Uint8Array(n);  // color variant, travels with the cell
    this.temp = new Float32Array(n).fill(AMBIENT);
    this.life = new Uint16Array(n);  // countdown: lifetime for fire/smoke, burn time for wood/plant
    this.stamp = new Uint32Array(n); // tick a cell last changed, prevents double updates
    this.tick = 0;

    this.fw = Math.ceil(w / FIELD);
    this.fh = Math.ceil(h / FIELD);
    const fn = this.fw * this.fh;
    this.vx = new Float32Array(fn);
    this.vy = new Float32Array(fn);
    this.tmpX = new Float32Array(fn);
    this.tmpY = new Float32Array(fn);
  }

  inBounds(x, y) {
    return x >= 0 && x < this.w && y >= 0 && y < this.h;
  }

  get(x, y) {
    return this.inBounds(x, y) ? this.type[y * this.w + x] : WALL;
  }

  // Place a fresh cell (brush): full spawn temperature and lifetime.
  set(x, y, t) {
    if (!this.inBounds(x, y)) return;
    const i = y * this.w + x;
    this.type[i] = t;
    this.shade[i] = (Math.random() * SHADES) | 0;
    this.temp[i] = SPAWN_T[t];
    this.life[i] = LIFE_MAX[t] ? randRange(LIFE_MIN[t], LIFE_MAX[t]) : 0;
  }

  // Turn an existing cell into another element. Keeps its heat unless the new element is hotter
  // (lava -> obsidian stays hot); gases always take their own temperature.
  transform(i, t) {
    const T = this.temp;
    this.type[i] = t;
    this.shade[i] = (Math.random() * SHADES) | 0;
    this.life[i] = LIFE_MAX[t] ? randRange(LIFE_MIN[t], LIFE_MAX[t]) : 0;
    if (t === 0) T[i] = AMBIENT;
    else if (KIND[t] === Kind.GAS || HOLD_T[t]) T[i] = SPAWN_T[t];
    else if (SPAWN_T[t] > T[i]) T[i] = SPAWN_T[t];
    this.stamp[i] = this.tick;
  }

  clear() {
    this.type.fill(0);
    this.temp.fill(AMBIENT);
    this.life.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
  }

  count() {
    let n = 0;
    for (let i = 0; i < this.type.length; i++) if (this.type[i] !== 0) n++;
    return n;
  }

  swap(i, j) {
    const t = this.type, s = this.shade, T = this.temp, L = this.life;
    let a = t[i]; t[i] = t[j]; t[j] = a;
    a = s[i]; s[i] = s[j]; s[j] = a;
    a = T[i]; T[i] = T[j]; T[j] = a;
    a = L[i]; L[i] = L[j]; L[j] = a;
    this.stamp[i] = this.stamp[j] = this.tick;
  }

  // Can element t move into (x,y) going down/sideways? Empty, or a lighter non-static cell.
  canEnter(t, x, y) {
    const u = this.get(x, y);
    if (u === 0) return true;
    if (KIND[u] === Kind.STATIC) return false;
    return DENSITY[t] > DENSITY[u];
  }

  // Can gas t move into (x,y) going up? Empty, or bubble slowly through heavier liquid/powder.
  canRise(t, x, y) {
    const u = this.get(x, y);
    if (u === 0) return true;
    const k = KIND[u];
    if (k === Kind.STATIC || k === Kind.GAS) return false;
    return DENSITY[u] > DENSITY[t] && Math.random() < 0.3;
  }

  // ---------- tick ----------
  step() {
    this.tick++;
    this.heat();
    this.stepWind();
    const { w, h, type, stamp, tick } = this;
    // Bottom-up so falling cells don't get processed twice; random row direction avoids left/right bias.
    for (let y = h - 1; y >= 0; y--) {
      const ltr = Math.random() < 0.5;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = y * w + x;
        const t = type[i];
        if (t === 0 || stamp[i] === tick) continue;
        this.updateCell(x, y, i, t);
      }
    }
  }

  updateCell(x, y, i, t) {
    const T = this.temp;
    if (HOLD_T[t]) T[i] = SPAWN_T[t];
    if (t === EL.FIRE) this.radiate(x, y);

    // Lifetime (fire, smoke).
    if (LIFE_MAX[t]) {
      if (--this.life[i] === 0) {
        this.transform(i, Math.random() < DEATH_P[t] ? DEATH_TO[t] : EL.EMPTY);
        return;
      }
    } else if (IGNITE_T[t] !== Infinity && this.burn(x, y, i, t)) {
      return;
    }

    // Phase changes from temperature.
    if (T[i] > HOT_T[t] && Math.random() < HOT_P[t]) { this.transform(i, HOT_TO[t]); return; }
    if (T[i] < COLD_T[t] && Math.random() < COLD_P[t]) { this.transform(i, COLD_TO[t]); return; }

    if (HAS_RULES[t] && this.react(x, y, i, t)) return;

    const kind = KIND[t];
    if (kind === Kind.STATIC) return;
    if (VISCOSITY[t] && Math.random() < VISCOSITY[t]) return;
    if (WIND[t] && this.blow(x, y, i, t)) return;

    switch (kind) {
      case Kind.POWDER: this.updatePowder(x, y, i, t); break;
      case Kind.LIQUID: this.updateLiquid(x, y, i, t); break;
      case Kind.GAS: this.updateGas(x, y, i, t); break;
    }
  }

  // ---------- heat ----------
  // Each cell exchanges heat with its right and down neighbor, so every touching pair is visited once.
  // Cells touching empty air drift toward ambient instead.
  heat() {
    const { w, h, type, temp } = this;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const a = type[i];
        if (x + 1 < w) this.exchange(i, i + 1, a, type[i + 1], temp);
        if (y + 1 < h) this.exchange(i, i + w, a, type[i + w], temp);
      }
    }
  }

  exchange(i, j, a, b, temp) {
    if (a === 0) {
      if (b !== 0) temp[j] += (AMBIENT - temp[j]) * AIRLOSS[b];
      return;
    }
    if (b === 0) {
      temp[i] += (AMBIENT - temp[i]) * AIRLOSS[a];
      return;
    }
    const k = COND[a] < COND[b] ? COND[a] : COND[b];
    const d = (temp[i] - temp[j]) * k;
    temp[i] -= d;
    temp[j] += d;
  }

  // Fire is a gas and rises away fast, so it also heats a random nearby cell (up to 2 below)
  // directly. Lets flames lick fuel they never quite touch.
  radiate(x, y) {
    const nx = x + ((Math.random() * 3) | 0) - 1;
    const ny = y + ((Math.random() * 4) | 0) - 1;
    const u = this.get(nx, ny);
    if (u !== 0 && u !== WALL && u !== EL.FIRE) this.temp[ny * this.w + nx] += RADIANT_HEAT;
  }

  // ---------- burning (wood, plant) ----------
  burn(x, y, i, t) {
    const L = this.life, T = this.temp;
    if (L[i] === 0) {
      if (T[i] <= IGNITE_T[t]) return false;
      L[i] = randRange(BURN_MIN[t], BURN_MAX[t]);
    }
    if (T[i] < BURN_T) T[i] = BURN_T;

    const d = (Math.random() * 5) | 0;
    const nx = x + FIRE_DX[d], ny = y + FIRE_DY[d];
    const u = this.get(nx, ny);
    if (u === EL.WATER) {
      // Doused: water flashes to steam, cell stops burning (can reignite if neighbors stay hot).
      L[i] = 0;
      T[i] = 100;
      this.transform(ny * this.w + nx, EL.STEAM);
      return true;
    }
    if (u === 0 && Math.random() < 0.3) this.transform(ny * this.w + nx, EL.FIRE);

    if (--L[i] === 0) this.transform(i, Math.random() < ASH_P[t] ? EL.ASH : EL.FIRE);
    return true;
  }

  // ---------- reactions ----------
  react(x, y, i, t) {
    const d = (Math.random() * 4) | 0;
    const nx = x + DX4[d], ny = y + DY4[d];
    const u = this.get(nx, ny);
    if (u === WALL) return false;
    const r = t * 256 + u;
    const c = R_CHANCE[r];
    if (c === 0 || Math.random() >= c) return false;
    const j = ny * this.w + nx;
    if (R_SELF[r] !== t) this.transform(i, R_SELF[r]);
    else this.stamp[i] = this.tick;
    if (R_OTHER[r] !== u) this.transform(j, R_OTHER[r]);
    return true;
  }

  // ---------- air field ----------
  stepWind() {
    const { fw, fh, vx, vy, tmpX, tmpY } = this;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const i = y * fw + x;
        const l = x > 0 ? i - 1 : i, r = x < fw - 1 ? i + 1 : i;
        const u = y > 0 ? i - fw : i, d = y < fh - 1 ? i + fw : i;
        tmpX[i] = (vx[i] * 0.6 + (vx[l] + vx[r] + vx[u] + vx[d]) * 0.1) * WIND_DECAY;
        tmpY[i] = (vy[i] * 0.6 + (vy[l] + vy[r] + vy[u] + vy[d]) * 0.1) * WIND_DECAY;
      }
    }
    this.vx = tmpX; this.tmpX = vx;
    this.vy = tmpY; this.tmpY = vy;
  }

  // Add force (dx, dy) in a circle of radius r grid cells around (x, y).
  addWind(x, y, r, dx, dy) {
    const { fw, fh, vx, vy } = this;
    const cx = x / FIELD, cy = y / FIELD;
    const fr = Math.max(1, r / FIELD + 0.5);
    for (let fy = Math.floor(cy - fr); fy <= Math.ceil(cy + fr); fy++) {
      for (let fx = Math.floor(cx - fr); fx <= Math.ceil(cx + fr); fx++) {
        if (fx < 0 || fx >= fw || fy < 0 || fy >= fh) continue;
        const dist = Math.hypot(fx + 0.5 - cx, fy + 0.5 - cy);
        if (dist > fr) continue;
        const f = 1 - dist / (fr + 1);
        const i = fy * fw + fx;
        vx[i] = Math.max(-WIND_MAX, Math.min(WIND_MAX, vx[i] + dx * f));
        vy[i] = Math.max(-WIND_MAX, Math.min(WIND_MAX, vy[i] + dy * f));
      }
    }
  }

  // Wind at any point; outside the map uses the nearest edge cell (never reads out of range).
  windAt(x, y) {
    const fx = Math.max(0, Math.min(this.fw - 1, (x / FIELD) | 0));
    const fy = Math.max(0, Math.min(this.fh - 1, (y / FIELD) | 0));
    const i = fy * this.fw + fx;
    return [this.vx[i], this.vy[i]];
  }

  // Push one cell along the wind. Only into empty space (or through gas for non-gases).
  blow(x, y, i, t) {
    const f = ((y / FIELD) | 0) * this.fw + ((x / FIELD) | 0);
    const vx = this.vx[f], vy = this.vy[f];
    const ax = vx < 0 ? -vx : vx, ay = vy < 0 ? -vy : vy;
    const m = ax + ay;
    if (m < 0.05 || Math.random() >= m * WIND[t] * 0.4) return false;
    let dx = 0, dy = 0;
    if (Math.random() * m < ax) dx = vx > 0 ? 1 : -1;
    else dy = vy > 0 ? 1 : -1;
    const nx = x + dx, ny = y + dy;
    const u = this.get(nx, ny);
    if (u !== 0 && !(KIND[u] === Kind.GAS && KIND[t] !== Kind.GAS)) return false;
    this.swap(i, ny * this.w + nx);
    return true;
  }

  // ---------- movement ----------
  updatePowder(x, y, i, t) {
    const w = this.w;
    if (this.canEnter(t, x, y + 1)) {
      // Sink through liquid at half speed so it looks heavy-but-wet.
      const below = this.type[i + w];
      if (below !== 0 && KIND[below] === Kind.LIQUID && Math.random() < 0.5) return;
      this.swap(i, i + w);
      return;
    }
    if (Math.random() > SLIDE[t]) return;
    const d = Math.random() < 0.5 ? -1 : 1;
    if (this.canSlide(t, x + d, y)) { this.swap(i, i + w + d); return; }
    if (this.canSlide(t, x - d, y)) { this.swap(i, i + w - d); }
  }

  // Diagonal roll target is (nx, y+1). Cohesive powders also need the cell below that open.
  canSlide(t, nx, y) {
    if (!this.canEnter(t, nx, y + 1)) return false;
    return !COHESIVE[t] || this.canEnter(t, nx, y + 2);
  }

  updateLiquid(x, y, i, t) {
    const w = this.w;
    if (this.canEnter(t, x, y + 1)) { this.swap(i, i + w); return; }
    const d = Math.random() < 0.5 ? -1 : 1;
    if (this.canEnter(t, x + d, y + 1)) { this.swap(i, i + w + d); return; }
    if (this.canEnter(t, x - d, y + 1)) { this.swap(i, i + w - d); return; }
    if (this.spread(x, y, i, t, d, false)) return;
    this.spread(x, y, i, t, -d, false);
  }

  updateGas(x, y, i, t) {
    const w = this.w;
    const d = Math.random() < 0.5 ? -1 : 1;
    // Random sideways jitter first so gas looks wispy instead of rising in columns.
    if (Math.random() < 0.3 && this.spread(x, y, i, t, d, true)) return;
    if (this.canRise(t, x, y - 1)) { this.swap(i, i - w); return; }
    if (this.canRise(t, x + d, y - 1)) { this.swap(i, i - w + d); return; }
    if (this.canRise(t, x - d, y - 1)) { this.swap(i, i - w - d); return; }
    if (this.spread(x, y, i, t, d, true)) return;
    this.spread(x, y, i, t, -d, true);
  }

  // Slide sideways up to DISPERSION cells, stopping early at a drop (or a gap above, for gas).
  spread(x, y, i, t, d, gas) {
    const n = DISPERSION[t];
    const next = gas ? y - 1 : y + 1;
    let best = -1;
    for (let s = 1; s <= n; s++) {
      const nx = x + d * s;
      if (this.get(nx, y) !== 0 && !(gas ? this.canRise(t, nx, y) : this.canEnter(t, nx, y))) break;
      best = nx;
      if (gas ? this.get(nx, next) === 0 : this.canEnter(t, nx, next)) break;
    }
    if (best < 0) return false;
    this.swap(i, y * this.w + best);
    return true;
  }

  // ---------- freezing (water bending) ----------
  // Freeze a disc: water / steam -> ice, lava -> obsidian, fire out, burning stops, all chilled.
  freeze(x, y, r) {
    const cx = Math.floor(x), cy = Math.floor(y), R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const X = cx + dx, Y = cy + dy;
        if (!this.inBounds(X, Y)) continue;
        const i = Y * this.w + X, t = this.type[i];
        if (t === EL.WATER || t === EL.STEAM) { this.transform(i, EL.ICE); this.temp[i] = -40; }
        else if (t === EL.LAVA) { this.transform(i, EL.OBSIDIAN); this.temp[i] = 150; }
        else if (t === EL.FIRE) this.transform(i, EL.EMPTY);
        else if (t !== 0) {
          this.temp[i] = Math.min(this.temp[i], -20);
          if (KIND[t] === Kind.STATIC) this.life[i] = 0; // stops burning wood / plants
        }
      }
    }
  }

  // ---------- brush ----------
  // Fill a circle. Loose elements are sprinkled; static ones and the eraser are solid.
  paint(cx, cy, r, t) {
    const solid = t === 0 || KIND[t] === Kind.STATIC || r <= 1;
    const p = solid ? 1 : 0.45;
    const r2 = r * r + r * 0.5;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = cx + dx, y = cy + dy;
        if (!this.inBounds(x, y) || Math.random() > p) continue;
        const i = y * this.w + x;
        if (t === 0) { this.type[i] = 0; this.temp[i] = AMBIENT; this.life[i] = 0; continue; }
        if (this.type[i] === 0) this.set(x, y, t);
      }
    }
  }
}
