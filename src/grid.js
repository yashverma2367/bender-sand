// Cell storage + per-tick simulation: heat, air field, reactions, movement.
import {
  Kind, EL, KIND, DENSITY, SLIDE, COHESIVE, DISPERSION, VISCOSITY, WIND, SPAWN_T, HOLD_T, COND, AIRLOSS,
  HOT_T, HOT_TO, HOT_P, COLD_T, COLD_TO, COLD_P, LIFE_MIN, LIFE_MAX, DEATH_TO, DEATH_P,
  IGNITE_T, BURN_MIN, BURN_MAX, ASH_P, R_CHANCE, R_SELF, R_OTHER, HAS_RULES,
  WALL, AMBIENT, BURN_T, SHADES,
} from './elements.js';

// Solids that never do anything on their own (no reactions, no burning, no lifetime): skipped in
// the update loop unless they're hot / cold enough to change phase.
const QUIET = new Uint8Array(256);
for (let t = 1; t < 255; t++) QUIET[t] = KIND[t] === Kind.STATIC && !HAS_RULES[t] && !LIFE_MAX[t] && IGNITE_T[t] === Infinity && !HOLD_T[t] ? 1 : 0;

export const FIELD = 4;     // air field cell = 4x4 grid cells
const WIND_MAX = 6;
const WIND_DECAY = 0.985;   // still air returns slowly
const ADVECT = 0.22;       // how far the flow carries itself per tick (field cells per unit wind)
const PUSH = 0.7;          // how hard pressure differences push the air
const COMPRESS = 0.55;     // how fast converging air builds pressure
const PRESSURE_DECAY = 0.988;
const PRESSURE_MAX = 8;
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
    this.resize(w, h);
  }

  // (Re)allocate everything for a w x h world (maps come in different sizes). Wipes the world.
  resize(w, h) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.type = new Uint8Array(n);   // element id per cell
    this.shade = new Uint8Array(n);  // color variant, travels with the cell
    this.temp = new Float32Array(n).fill(AMBIENT);
    this.life = new Uint16Array(n);  // countdown: lifetime for fire/smoke, burn time for wood/plant
    this.stamp = new Uint32Array(n); // tick a cell last changed, prevents double updates
    this.crack = new Uint8Array(n);  // structural damage on solid cells (0 = sound); breaks at the material's strength
    this.tick = 0;

    this.fw = Math.ceil(w / FIELD);
    this.fh = Math.ceil(h / FIELD);
    const fn = this.fw * this.fh;
    this.vx = new Float32Array(fn);
    this.vy = new Float32Array(fn);
    this.tmpX = new Float32Array(fn);
    this.tmpY = new Float32Array(fn);
    this.rho = new Float32Array(fn);     // air overpressure (0 = calm, + = compressed, - = vacuum)
    this.tmpR = new Float32Array(fn);
    this.solidF = new Uint8Array(fn);    // 1 = this air cell is mostly solid (walls block the air)
    this.heatF = new Float32Array(fn);   // how much heat rises off this block (fire, lava, hot metal)
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
    this.crack[i] = 0;
    this.temp[i] = SPAWN_T[t];
    this.life[i] = LIFE_MAX[t] ? randRange(LIFE_MIN[t], LIFE_MAX[t]) : 0;
  }

  // Turn an existing cell into another element. Keeps its heat unless the new element is hotter
  // (lava -> obsidian stays hot); gases always take their own temperature.
  transform(i, t) {
    const T = this.temp;
    this.type[i] = t;
    this.crack[i] = 0;
    this.shade[i] = (Math.random() * SHADES) | 0;
    this.life[i] = LIFE_MAX[t] ? randRange(LIFE_MIN[t], LIFE_MAX[t]) : 0;
    if (t === 0) T[i] = AMBIENT;
    else if (KIND[t] === Kind.GAS || HOLD_T[t]) T[i] = SPAWN_T[t];
    else if (SPAWN_T[t] > T[i]) T[i] = SPAWN_T[t];
    this.stamp[i] = this.tick;
  }

  clear() {
    this.type.fill(0);
    this.crack.fill(0);
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
  // Floating debris: a solid (static) fragment of at most `max` cells touching no other solid
  // cell (8-neighborhood, through the fragment). Returns its cell indices, or null if (x, y)
  // isn't static or belongs to something bigger / anchored.
  strayCluster(x, y, max = 8) {
    const { w, h, type } = this, i0 = y * w + x;
    if (KIND[type[i0]] !== Kind.STATIC) return null;
    const seen = [i0];
    for (let k = 0; k < seen.length; k++) {
      const i = seen[k], cx = i % w, cy = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = cx + dx, Y = cy + dy;
        if (X < 0 || X >= w || Y >= h) return null; // touching the map edge / floor: anchored
        if (Y < 0) continue;
        const j = Y * w + X, k2 = KIND[type[j]];
        if (type[j] === EL.LAVA) return null; // crust floating on lava: part of the pool
        if (k2 !== Kind.STATIC && k2 !== Kind.POWDER) continue;
        if (k2 === Kind.POWDER) return null; // resting on a pile: leave it
        if (!seen.includes(j)) { seen.push(j); if (seen.length > max) return null; }
      }
    }
    return seen;
  }

  // Turn a stray fragment into loose rubble that falls (rock-ish -> sand, wood / plants -> ash, ice -> water).
  crumbleStray(cells) {
    for (const i of cells) {
      const t = this.type[i];
      this.type[i] = t === EL.WOOD || t === EL.PLANT ? EL.ASH : t === EL.ICE ? EL.WATER : EL.SAND;
      this.temp[i] = AMBIENT; this.life[i] = 0;
    }
  }

  // Sweep a slice of the map for floating debris (call every tick; covers the map every `every` ticks).
  sweepStrays(every = 30) {
    const { w, h, type } = this, rows = Math.ceil(h / every), y0 = (this.tick % every) * rows;
    for (let y = y0; y < Math.min(h, y0 + rows); y++) for (let x = 0; x < w; x++) {
      if (KIND[type[y * w + x]] !== Kind.STATIC) continue;
      let n = 0; // quick reject: well-connected cells are part of something bigger
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || X >= w || Y < 0 || Y >= h || KIND[type[Y * w + X]] === Kind.STATIC) n++;
      }
      if (n > 4) continue;
      const c = this.strayCluster(x, y);
      if (c) this.crumbleStray(c);
    }
  }

  step() {
    this.tick++;
    this.heat();
    this.stepWind();
    const { w, h, type, stamp, tick, temp } = this;
    // Bottom-up so falling cells don't get processed twice; random row direction avoids left/right bias.
    for (let y = h - 1; y >= 0; y--) {
      const ltr = Math.random() < 0.5;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = y * w + x;
        const t = type[i];
        if (t === 0 || stamp[i] === tick) continue;
        if (QUIET[t] && temp[i] <= HOT_T[t] && temp[i] >= COLD_T[t]) continue; // plain solid walls: nothing to do
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
        const a = type[i], ti = temp[i];
        // (two cells both exactly at room temperature exchange nothing: skip them, most of the map)
        if (x + 1 < w && (ti !== AMBIENT || temp[i + 1] !== AMBIENT)) this.exchange(i, i + 1, a, type[i + 1], temp);
        if (y + 1 < h && (ti !== AMBIENT || temp[i + w] !== AMBIENT)) this.exchange(i, i + w, a, type[i + w], temp);
      }
    }
  }

  exchange(i, j, a, b, temp) {
    if (a === 0) {
      if (b !== 0) { temp[j] += (AMBIENT - temp[j]) * AIRLOSS[b]; if (temp[j] > AMBIENT - 0.05 && temp[j] < AMBIENT + 0.05) temp[j] = AMBIENT; }
      return;
    }
    if (b === 0) {
      temp[i] += (AMBIENT - temp[i]) * AIRLOSS[a]; if (temp[i] > AMBIENT - 0.05 && temp[i] < AMBIENT + 0.05) temp[i] = AMBIENT;
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
  // ---------- air: a simple compressible flow on the coarse field ----------
  // Velocity (vx, vy) and overpressure (rho) per FIELD x FIELD block. Each tick:
  //   - the flow carries itself along (semi-Lagrangian advection)
  //   - air accelerates from high to low pressure; pressure rises where air converges
  //     (a sound / blast wave that travels, reflects off walls and funnels down corridors)
  //   - solid blocks are walls: no flow into them, no pressure through them
  //   - everything slowly calms back to still air
  // The map's edges are open sky (pressure vents out), except the floor.
  updateSolidField() {
    // A block blocks the air if a solid line crosses it (any full row or full column of solid cells):
    // so 2-3 cell walls, floors and slabs are airtight even though they don't fill the block.
    const { w, h, fw, fh, type, solidF } = this;
    const isS = (x, y) => { if (x >= w || y >= h) return true; const t = type[y * w + x]; const k = KIND[t]; return t !== EL.CABLE && (k === Kind.STATIC || k === Kind.POWDER || k === Kind.LIQUID); };
    for (let fy = 0; fy < fh; fy++) for (let fx = 0; fx < fw; fx++) {
      const x0 = fx * FIELD, y0 = fy * FIELD;
      let block = false;
      for (let r = 0; r < FIELD && !block; r++) { let row = true, col = true; for (let q = 0; q < FIELD; q++) { if (!isS(x0 + q, y0 + r)) row = false; if (!isS(x0 + r, y0 + q)) col = false; } block = row || col; }
      solidF[fy * fw + fx] = block ? 1 : 0;
      // heat rising from here: hot cells in this block (fire, lava, hot ground, hot steel)
      let heat = 0;
      for (let y = y0; y < Math.min(h, y0 + FIELD); y++) for (let x = x0; x < Math.min(w, x0 + FIELD); x++) { const T = this.temp[y * w + x]; if (T > 90) heat += Math.min(1, (T - 90) / 500); }
      this.heatF[fy * fw + fx] = heat / (FIELD * FIELD);
    }
    // the warmth carries up: a block above a hot one is lifted too (a rising column)
    for (let fy = fh - 1; fy >= 1; fy--) for (let fx = 0; fx < fw; fx++) { // bottom to top, so a column carries all the way up
      const i = fy * fw + fx, up = i - fw;
      if (!solidF[up]) this.heatF[up] = Math.max(this.heatF[up], this.heatF[i] * 0.93);
    }
  }

  stepWind() {
    const { fw, fh, solidF } = this;
    if (this.tick % 4 === 1) this.updateSolidField();
    let { vx, vy, tmpX, tmpY, rho, tmpR } = this;
    const solid = (x, y) => x < 0 || x >= fw ? false : y >= fh ? true : y < 0 ? false : solidF[y * fw + x] === 1;
    // 1. advection: each cell takes the velocity found upstream of it
    const sample = (arr, x, y) => {
      x = Math.max(0, Math.min(fw - 1.001, x)); y = Math.max(0, Math.min(fh - 1.001, y));
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * fw + x0;
      return (arr[i] * (1 - fx) + arr[i + 1] * fx) * (1 - fy) + (arr[i + fw] * (1 - fx) + arr[i + fw + 1] * fx) * fy;
    };
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const i = y * fw + x;
      if (solidF[i]) { tmpX[i] = 0; tmpY[i] = 0; continue; }
      const sx = x - vx[i] * ADVECT, sy = y - vy[i] * ADVECT;
      tmpX[i] = sample(vx, sx, sy); tmpY[i] = sample(vy, sx, sy);
    }
    [vx, tmpX] = [tmpX, vx]; [vy, tmpY] = [tmpY, vy];
    // 2. pressure pushes the air; walls stop it; a little blur; calm down
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const i = y * fw + x;
      if (solidF[i]) { tmpX[i] = 0; tmpY[i] = 0; continue; }
      const pr = rho[i];
      const pl = x > 0 ? (solidF[i - 1] ? pr : rho[i - 1]) : 0, prr = x < fw - 1 ? (solidF[i + 1] ? pr : rho[i + 1]) : 0;
      const pu = y > 0 ? (solidF[i - fw] ? pr : rho[i - fw]) : 0, pd = y < fh - 1 ? (solidF[i + fw] ? pr : rho[i + fw]) : pr;
      let ux = vx[i] - PUSH * (prr - pl) * 0.5, uy = vy[i] - PUSH * (pd - pu) * 0.5;
      // neighbours' average (only open air) for a little blur
      let ax = 0, ay = 0, n = 0;
      if (x > 0 && !solidF[i - 1]) { ax += vx[i - 1]; ay += vy[i - 1]; n++; }
      if (x < fw - 1 && !solidF[i + 1]) { ax += vx[i + 1]; ay += vy[i + 1]; n++; }
      if (y > 0 && !solidF[i - fw]) { ax += vx[i - fw]; ay += vy[i - fw]; n++; }
      if (y < fh - 1 && !solidF[i + fw]) { ax += vx[i + fw]; ay += vy[i + fw]; n++; }
      if (n) { ux = ux * 0.88 + (ax / n) * 0.12; uy = uy * 0.88 + (ay / n) * 0.12; }
      // walls: no flow into a solid neighbour
      if (ux > 0 && solid(x + 1, y)) ux = 0; else if (ux < 0 && solid(x - 1, y)) ux = 0;
      if (uy > 0 && solid(x, y + 1)) uy = 0; else if (uy < 0 && solid(x, y - 1)) uy = 0;
      tmpX[i] = Math.max(-WIND_MAX, Math.min(WIND_MAX, ux * WIND_DECAY));
      tmpY[i] = Math.max(-WIND_MAX, Math.min(WIND_MAX, uy * WIND_DECAY));
    }
    [vx, tmpX] = [tmpX, vx]; [vy, tmpY] = [tmpY, vy];
    // 3. pressure: rises where air converges, falls where it spreads out; relaxes back to calm
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const i = y * fw + x;
      if (solidF[i]) { tmpR[i] = 0; continue; }
      const vl = x > 0 ? vx[i - 1] : vx[i], vr = x < fw - 1 ? vx[i + 1] : vx[i], vu = y > 0 ? vy[i - fw] : vy[i], vd = y < fh - 1 ? vy[i + fw] : vy[i];
      const div = (vr - vl) * 0.5 + (vd - vu) * 0.5;
      tmpR[i] = (rho[i] - COMPRESS * div) * PRESSURE_DECAY;
    }
    [rho, tmpR] = [tmpR, rho];
    this.vx = vx; this.vy = vy; this.tmpX = tmpX; this.tmpY = tmpY; this.rho = rho; this.tmpR = tmpR;
  }

  // A burst of overpressure (a blast): it expands as a wave, shaped by the walls around it.
  addPressure(x, y, r, amount) {
    const { fw, fh, rho, solidF } = this;
    const cx = x / FIELD, cy = y / FIELD, fr = Math.max(1, r / FIELD);
    for (let fy = Math.floor(cy - fr); fy <= Math.ceil(cy + fr); fy++) for (let fx = Math.floor(cx - fr); fx <= Math.ceil(cx + fr); fx++) {
      if (fx < 0 || fx >= fw || fy < 0 || fy >= fh || solidF[fy * fw + fx]) continue;
      const d = Math.hypot(fx + 0.5 - cx, fy + 0.5 - cy) / fr;
      if (d > 1) continue;
      const i = fy * fw + fx;
      rho[i] = Math.max(-PRESSURE_MAX, Math.min(PRESSURE_MAX, rho[i] + amount * (1 - d * 0.6)));
    }
  }
  pressureAt(x, y) {
    const fx = Math.max(0, Math.min(this.fw - 1, (x / FIELD) | 0)), fy = Math.max(0, Math.min(this.fh - 1, (y / FIELD) | 0));
    return this.rho[fy * this.fw + fx];
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
