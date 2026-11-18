// Map templates. Each map fills the grid with terrain and returns
//   { spawns: [x, x, x, x], tick?: fn(grid, particles, t, env) }
// spawns: one x per player (left to right). tick (optional) runs every simulation tick for
// live hazards; env = { fx, players }. Terrain uses seeded noise, so a map looks the same
// every time it's loaded.
import { EL, KIND, Kind, pack } from './elements.js';
import { emit } from './sfx.js';

// ---------- helpers ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}


function put(g, x, y, t) {
  x = Math.floor(x); y = Math.floor(y);
  if (g.inBounds(x, y)) g.set(x, y, t);
}

function clear(g, x, y) {
  x = Math.floor(x); y = Math.floor(y);
  if (g.inBounds(x, y)) { g.type[y * g.w + x] = 0; g.temp[y * g.w + x] = 20; }
}

const typeAt = (g, x, y) => (g.inBounds(Math.floor(x), Math.floor(y)) ? g.type[Math.floor(y) * g.w + Math.floor(x)] : -1);


function disc(g, cx, cy, r, t, onlyEmpty = false) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r || !g.inBounds(x, y)) continue;
      if (onlyEmpty && g.type[y * g.w + x] !== 0) continue;
      if (t === 0) clear(g, x, y); else put(g, x, y, t);
    }
  }
}

function rect(g, x0, y0, x1, y1, t, onlyEmpty = false) {
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      if (!g.inBounds(x, y) || (onlyEmpty && g.type[y * g.w + x] !== 0)) continue;
      if (t === 0) clear(g, x, y); else put(g, x, y, t);
    }
  }
}

// Fill empty cells below `level` inside [x0, x1) with a liquid (lakes, rivers, seas).
function fill(g, x0, x1, level, t = EL.WATER) {
  for (let x = Math.max(0, Math.floor(x0)); x < Math.min(g.w, x1); x++) {
    for (let y = Math.floor(level); y < g.h; y++) {
      if (g.type[y * g.w + x] === 0) put(g, x, y, t);
      else break;
    }
  }
}

// Fill every empty cell in a rect (for flooding caves).
function flood(g, x0, y0, x1, y1, t) { rect(g, x0, y0, x1, y1, t, true); }


function tree(g, x, groundY, h, r) {
  rect(g, x, groundY - h, x + 2, groundY, EL.WOOD);
  disc(g, x + 1, groundY - h - r * 0.4, r, EL.PLANT, true);
  disc(g, x - r * 0.6, groundY - h + r * 0.3, r * 0.7, EL.PLANT, true);
  disc(g, x + 2 + r * 0.6, groundY - h + r * 0.3, r * 0.7, EL.PLANT, true);
}



const spread = (g, fracs) => fracs.map((f) => Math.floor(g.w * f));



// ---------- city ----------

const STREET = 270;          // top of the road
let ROOMS = [];              // backdrop rects collected while building
const TUNNEL_TOP = 278, TUNNEL_BOT = 336; // subway tunnel interior rows [top, bot)
const FH = 22;               // building floor height
const PLATFORM_Y = 297;      // station ledges (clear of the train's roof)

// A building standing on the street: outer walls with windows, floors with a stairwell gap
// (alternating sides, so you can climb inside), doors on both sides at street level, a roof
// with a parapet. mat = wall material; glassy = big windows (office towers).
function building(g, x0, x1, floors, mat, glassy = false) {
  const top = STREET - floors * FH, wall = glassy ? 2 : 3;
  ROOMS.push([x0, top - 3, x1, STREET, mat === EL.BRICK ? '#4a3632' : mat === EL.STEEL ? '#2e3a50' : '#3e4048', true]);
  rect(g, x0, top, x0 + wall, STREET, mat);
  rect(g, x1 - wall, top, x1, STREET, mat);
  rect(g, x0, top, x1, top + 3, mat === EL.STEEL ? EL.CONCRETE : mat);           // roof
  rect(g, x0, top - 3, x0 + 3, top, mat); rect(g, x1 - 3, top - 3, x1, top, mat); // parapet
  for (let f = 0; f < floors; f++) {
    const base = STREET - f * FH;
    let surface = STREET, gx = -99;
    if (f > 0) { // floor slab with a stairwell gap, wooden floorboards on top (they burn)
      rect(g, x0 + wall, base - 2, x1 - wall, base, EL.CONCRETE);
      gx = f % 2 ? x0 + wall + 3 : x1 - wall - 17;
      rect(g, x0 + wall, base - 3, x1 - wall, base - 2, EL.WOOD);
      rect(g, gx, base - 3, gx + 14, base, 0);
      surface = base - 3;
    }
    // low wooden furniture (tables / benches, 2 high so you can step over them): fire spreads
    // through a burning building along the floorboards and furniture
    for (let x = x0 + wall + 6; x < x1 - wall - 10; x += 22) {
      if (x + 9 > gx - 2 && x < gx + 16) continue;
      rect(g, x, surface - 2, x + 8, surface - 1, EL.WOOD);
      rect(g, x, surface - 1, x + 1, surface, EL.WOOD); rect(g, x + 7, surface - 1, x + 8, surface, EL.WOOD);
    }
    if (f === 0) { // doors at street level
      rect(g, x0, STREET - 15, x0 + wall, STREET, 0);
      rect(g, x1 - wall, STREET - 15, x1, STREET, 0);
    } else { // windows
      const h = glassy ? 14 : 9, y0 = base - 4 - h;
      rect(g, x0, y0, x0 + wall, base - 4, EL.GLASS);
      rect(g, x1 - wall, y0, x1, base - 4, EL.GLASS);
    }
  }
  return top;
}

// Brick mortar lines + a light seam pattern on concrete, road paint on asphalt.
function cityPatterns(g) {
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const i = y * g.w + x, t = g.type[i];
    if (t === EL.BRICK) g.shade[i] = y % 4 === 3 || (x + ((y >> 2) & 1) * 4) % 8 === 0 ? 3 : (x + y) % 3;
    else if (t === EL.CONCRETE) g.shade[i] = (x % 24 === 0 || y % 22 === 0) ? 3 : g.shade[i] % 3;
    else if (t === EL.STEEL) g.shade[i] = (x + y) % 6 === 0 ? 3 : g.shade[i] % 3;
    else if (t === EL.ASPHALT) g.shade[i] = y === STREET + 1 && x % 16 < 7 ? 3 : g.shade[i] % 3;
  }
}

function lamp(g, x) {
  rect(g, x, STREET - 22, x + 1, STREET, EL.STEEL);
  rect(g, x - 2, STREET - 24, x + 4, STREET - 22, EL.STEEL);
  rect(g, x - 1, STREET - 22, x + 3, STREET - 21, EL.GLASS);
}

function car(g, x) { // a parked car: steel body, glass cabin, steel wheels
  rect(g, x, STREET - 7, x + 24, STREET - 2, EL.STEEL);
  rect(g, x + 5, STREET - 11, x + 18, STREET - 7, EL.GLASS);
  rect(g, x + 4, STREET - 12, x + 19, STREET - 11, EL.STEEL);
  rect(g, x + 3, STREET - 2, x + 7, STREET, EL.STEEL); rect(g, x + 17, STREET - 2, x + 21, STREET, EL.STEEL);
}

function girder(g, x0, x1, y, struts = true) { // a steel truss: two chords + vertical struts
  rect(g, x0, y, x1, y + 2, EL.STEEL);
  if (!struts) return;
  rect(g, x0, y + 7, x1, y + 8, EL.STEEL);
  for (let x = x0; x < x1; x += 10) rect(g, x, y + 2, x + 1, y + 7, EL.STEEL);
}

// ---------- city backdrop ----------
// Painted once per map: what shows through empty cells. Night sky with stars, a dusk glow at
// the horizon, a distant skyline with lit windows, dark interiors inside buildings, tiled
// subway walls. Holes blown in walls later reveal the interior behind them.
const hexMix = (a, b, k) => { // mix two '#rrggbb' colors -> packed
  const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16), ch = (n, s) => (n >> s) & 255;
  const m = (s) => Math.round(ch(A, s) + (ch(B, s) - ch(A, s)) * k).toString(16).padStart(2, '0');
  return pack('#' + m(16) + m(8) + m(0));
};
function cityBackdrop(g, rooms) {
  const bd = new Uint32Array(g.w * g.h), r = rng(99);
  const sky = Array.from({ length: STREET }, (_, y) => y < 150 ? hexMix('#1c2544', '#34406e', y / 150) : hexMix('#34406e', '#6a4c74', (y - 150) / (STREET - 150)));
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) bd[y * g.w + x] = y < STREET ? sky[y] : pack('#1c1d24');
  for (let k = 0; k < 260; k++) { const x = (r() * g.w) | 0, y = (r() * 160) | 0; bd[y * g.w + x] = pack(r() < 0.8 ? '#8a90b0' : '#d0d4ec'); } // stars
  const far = pack('#3a3f60'), far2 = pack('#2c3150'), lit = pack('#a08850'), lit2 = pack('#6a7aa0');
  for (const [layer, col, hMin, hMax] of [[0, far2, 60, 190], [1, far, 30, 120]]) { // two skyline layers
    let x = 0;
    while (x < g.w) {
      const bw = 18 + ((r() * 40) | 0), top = STREET - hMin - ((r() * (hMax - hMin)) | 0);
      for (let X = x; X < Math.min(g.w, x + bw); X++) for (let y = top; y < STREET; y++) {
        const win = layer === 1 && (X - x) % 5 >= 2 && (X - x) % 5 < 4 && (y - top) % 7 >= 3 && (y - top) % 7 < 5 && X > x + 1 && X < x + bw - 2;
        bd[y * g.w + X] = win ? (r() < 0.25 ? (r() < 0.6 ? lit : lit2) : col) : col;
      }
      x += bw + ((r() * 6) | 0);
    }
  }
  for (const [x0, y0, x1, y1, base, lines] of rooms) { // building interiors: wall + wainscot + lights
    const A = pack(base), B = hexMix(base, '#000000', 0.35), L = hexMix(base, '#ffe8a0', 0.25);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const fy = (STREET - y) % FH; // height inside the floor
      bd[y * g.w + x] = lines && fy < 6 ? B : lines && fy > FH - 4 && (x % 30 < 4) ? L : A;
    }
  }
  return bd;
}

export const MAPS = [
  {
    id: 'city',
    name: 'Neo Republic City',
    // One big side-scrolling city: a harbor with a pier, apartment blocks, a glass skyscraper,
    // a park with a fountain under a steel skybridge, an office tower, a construction site with
    // a crane, more towers on the far side. Under the street: a subway tunnel with two stations,
    // stairs and vent shafts up to the street, a flooded sewer below. A train runs through the
    // tunnel (horn + flashing lights first) and plows anyone on the tracks (off: SUBWAY_TRAIN).
    build(g) {
      const r = rng(2077);
      ROOMS = [];
      // ground: road / sidewalk, the slab over the tunnel, the tunnel, bedrock
      for (let x = 0; x < g.w; x++) {
        if (x < 96) continue; // harbor
        rect(g, x, STREET, x + 1, STREET + 3, EL.ASPHALT);
        rect(g, x, STREET + 3, x + 1, TUNNEL_TOP, EL.CONCRETE);
        rect(g, x, TUNNEL_TOP, x + 1, TUNNEL_BOT + 4, x >= 104 && x < 1172 ? 0 : EL.CONCRETE);
        rect(g, x, TUNNEL_BOT, x + 1, TUNNEL_BOT + 4, EL.CONCRETE);
        rect(g, x, TUNNEL_BOT + 4, x + 1, g.h - 4, EL.EARTH);
        rect(g, x, g.h - 4, x + 1, g.h, EL.STONE);
      }
      rect(g, 104, TUNNEL_BOT - 1, 1172, TUNNEL_BOT, EL.STEEL); // rails
      // harbor: seawall, sea, sea floor, a wooden pier on posts
      rect(g, 90, STREET, 96, g.h - 8, EL.CONCRETE);
      rect(g, 0, g.h - 8, 96, g.h, EL.SAND);
      fill(g, 0, 90, 282);
      rect(g, 14, STREET - 2, 96, STREET, EL.WOOD);
      for (let x = 18; x < 90; x += 18) rect(g, x, STREET, x + 2, g.h - 8, EL.WOOD);
      // stations: platform ledges above the tracks (the train runs underneath), stairs up to
      // the street, vent shafts
      for (const [a, b] of [[262, 378], [800, 916]]) {
        rect(g, a, PLATFORM_Y, a + 32, PLATFORM_Y + 3, EL.CONCRETE);
        rect(g, b - 32, PLATFORM_Y, b, PLATFORM_Y + 3, EL.CONCRETE);
        for (let x = a + 40; x < b - 40; x += 18) rect(g, x, TUNNEL_TOP, x + 2, TUNNEL_TOP + 3, EL.GLASS); // ceiling lights
      }
      for (const sx of [298, 838]) rect(g, sx, STREET, sx + 22, TUNNEL_TOP, 0);   // stairwells
      for (const sx of [560, 1062]) rect(g, sx, STREET, sx + 10, TUNNEL_TOP, 0);  // vent shafts
      // flooded sewer under the park, reached by a drain from the tunnel floor
      rect(g, 556, TUNNEL_BOT + 6, 704, g.h - 2, EL.CONCRETE);
      rect(g, 560, TUNNEL_BOT + 8, 700, g.h - 4, 0);
      fill(g, 560, 700, TUNNEL_BOT + 11);
      rect(g, 626, TUNNEL_BOT, 636, TUNNEL_BOT + 8, 0);
      // buildings
      building(g, 110, 190, 5, EL.BRICK);
      const shop = building(g, 214, 266, 2, EL.CONCRETE);
      rect(g, 224, shop - 22, 256, shop - 20, EL.WOOD); rect(g, 224, shop - 20, 226, shop - 3, EL.WOOD); // rooftop water tank
      rect(g, 254, shop - 20, 256, shop - 3, EL.WOOD); rect(g, 224, shop - 5, 256, shop - 3, EL.WOOD);
      flood(g, 226, shop - 18, 254, shop - 5, EL.WATER);
      for (const lx of [228, 252]) rect(g, lx, shop - 3, lx + 2, shop, EL.WOOD);
      const sky = building(g, 394, 496, 10, EL.STEEL, true);
      rect(g, 444, sky - 30, 446, sky - 3, EL.STEEL); // antenna
      // park: soil, grass, trees, a fountain
      rect(g, 504, STREET - 3, 694, STREET, EL.EARTH);
      for (let x = 504; x < 694; x++) if (x < 560 || x >= 570) put(g, x, STREET - 4, EL.PLANT);
      for (const tx of [524, 548, 652, 676]) tree(g, tx, STREET - 4, 12 + r() * 6, 6 + r() * 2);
      rect(g, 582, STREET - 10, 618, STREET - 3, EL.CONCRETE);
      rect(g, 585, STREET - 9, 615, STREET - 3, 0);
      flood(g, 585, STREET - 8, 615, STREET - 3, EL.WATER);
      rect(g, 599, STREET - 18, 601, STREET - 8, EL.CONCRETE);
      // skybridge from the skyscraper to the office tower
      girder(g, 496, 700, 128);
      const office = building(g, 700, 776, 8, EL.CONCRETE);
      // construction site: an open steel frame, sand and gravel piles, a crane
      for (const cx of [790, 820, 850, 878]) rect(g, cx, 110, cx + 2, STREET, EL.STEEL);
      for (let y = 110; y < STREET - 20; y += 32) girder(g, 790, 880, y, false);
      for (let x = 796; x < 846; x++) { const h = Math.round(10 * Math.sin(((x - 796) / 50) * Math.PI)); rect(g, x, STREET - h, x + 1, STREET, x < 820 ? EL.SAND : EL.EARTH); }
      rect(g, 864, 40, 868, 110, EL.STEEL);
      girder(g, 760, 920, 36, true);
      rect(g, 770, 46, 771, 70, EL.STEEL); rect(g, 766, 70, 775, 72, EL.STEEL); // crane hook
      building(g, 930, 1010, 4, EL.BRICK);
      rect(g, 944, 150, 946, STREET - 4 * FH - 3, EL.STEEL); rect(g, 994, 150, 996, STREET - 4 * FH - 3, EL.STEEL); // billboard
      rect(g, 936, 136, 1004, 152, EL.WOOD); rect(g, 940, 139, 1000, 149, EL.GLASS);
      building(g, 1060, 1196, 9, EL.CONCRETE, true);
      rect(g, 1196, 0, g.w, STREET, EL.CONCRETE); // edge of the city
      // street furniture
      for (const lx of [204, 280, 384, 502, 782, 922, 1020, 1046]) lamp(g, lx);
      for (const cx of [330, 960 + 60, 702 - 40]) car(g, cx);
      cityPatterns(g);
      ROOMS.push([104, TUNNEL_TOP, 1172, TUNNEL_BOT, '#2c2f3a', false], [560, TUNNEL_BOT + 8, 700, g.h - 4, '#1e2a36', false], [626, TUNNEL_BOT, 636, TUNNEL_BOT + 8, '#1e2a36', false]);
      ROOMS.push([298, STREET, 320, TUNNEL_TOP, '#2c2f3a', false], [838, STREET, 860, TUNNEL_TOP, '#2c2f3a', false], [560, STREET, 570, TUNNEL_TOP, '#2c2f3a', false], [1062, STREET, 1072, TUNNEL_TOP, '#2c2f3a', false]);
      g.backdrop = cityBackdrop(g, ROOMS);
      { // tunnel wall tiles + a stripe, station signs
        const bd = g.backdrop, tile = pack('#353946'), stripe = pack('#3c628a'), sign = pack('#c9a227');
        for (let y = TUNNEL_TOP; y < TUNNEL_BOT; y++) for (let x = 104; x < 1172; x++) {
          const i = y * g.w + x;
          if (y >= TUNNEL_TOP + 8 && y < TUNNEL_TOP + 11) bd[i] = stripe;
          else if ((x % 8 === 0 || y % 6 === 0) && y < TUNNEL_BOT - 24) bd[i] = tile;
        }
        for (const sx of [300, 840]) for (let y = TUNNEL_TOP + 13; y < TUNNEL_TOP + 17; y++) for (let x = sx + 12; x < sx + 52; x++) bd[y * g.w + x] = sign;
      }
      this.train = { t: 0, next: 900, x: null, dir: 1 };
      const tick = SUBWAY_TRAIN ? (grid, ps, t, env) => subwayTick(this.train, grid, ps, env) : null;
      return { spawns: [60, 340, 600, 970, 1120, 240], tick };
    },
  },
];

// ---------- subway train ----------
// Switched off (players found it annoying). Set to true to bring the train back.
const SUBWAY_TRAIN = false;
// Every 20-30 s a train runs the length of the tunnel (direction alternates). Two seconds
// before, the station lights flash red and a horn sounds. It is built out of real cells (so it
// shows up online and plows debris) and slams anyone on the tracks (25 + a big launch).
const TRAIN_LEN = 150, TRAIN_H = 22, TRAIN_SPEED = 7, T_X0 = 104, T_X1 = 1172;
function subwayTick(tr, g, ps, env) {
  const yTop = TUNNEL_BOT - 1 - TRAIN_H, yBot = TUNNEL_BOT - 1; // rows [yTop, yBot)
  if (tr.x === null) {
    if (--tr.next === 120) emit('train', g.w / 2, 1);
    if (tr.next <= 120 && ps && (tr.next >> 3) % 2) for (let x = T_X0 + 20; x < T_X1; x += 60) ps.spawn(x, TUNNEL_TOP + 3, 0, 0, EL.FIRE, { ghost: true, gravity: 0, life: 4 });
    if (tr.next > 0) return;
    tr.x = tr.dir > 0 ? T_X0 - TRAIN_LEN : T_X1; tr.hit = new Set();
  }
  const isTrain = (t) => t === EL.STEEL || t === EL.GLASS;
  const cellOf = (dx, y) => { // what the train looks like at column dx (0 = rear), row y
    const ry = y - yTop;
    if (ry < 2 || ry >= TRAIN_H - 2 || dx < 2 || dx >= TRAIN_LEN - 2) return EL.STEEL;
    if (ry >= 6 && ry < 11 && dx % 25 > 3 && dx % 25 < 20) return EL.GLASS;
    return dx % 50 === 0 ? EL.STEEL : -1; // hollow cars, car joints
  };
  const old = tr.x, nx = old + tr.dir * TRAIN_SPEED;
  // erase where it was, draw where it is (only inside the tunnel)
  for (let x = Math.max(T_X0, Math.floor(old)); x < Math.min(T_X1, Math.floor(old) + TRAIN_LEN); x++) for (let y = yTop; y < yBot; y++) {
    const i = y * g.w + x; if (isTrain(g.type[i])) { g.type[i] = 0; g.temp[i] = 20; }
  }
  tr.x = nx;
  if ((tr.dir > 0 && nx > T_X1) || (tr.dir < 0 && nx + TRAIN_LEN < T_X0)) { tr.x = null; tr.next = 1200 + Math.floor(Math.random() * 600); tr.dir = -tr.dir; return; }
  for (let x = Math.max(T_X0, Math.floor(nx)); x < Math.min(T_X1, Math.floor(nx) + TRAIN_LEN); x++) for (let y = yTop; y < yBot; y++) {
    const c = cellOf(x - Math.floor(nx), y); if (c < 0) continue;
    const i = y * g.w + x, t = g.type[i];
    if (t !== 0 && !isTrain(t) && ps) ps.lift(x, y, tr.dir * (3 + Math.random() * 3), -1 - Math.random() * 2, { bounces: 1 }); // plowed debris
    g.set(x, y, c);
  }
  for (const p of env.players || []) { // anyone on the tracks gets hit
    if (p.dead || tr.hit.has(p.id)) continue;
    const px = p.x + 2.5, front = tr.dir > 0 ? nx + TRAIN_LEN : nx;
    if (p.y + 18 > yTop && p.y < yBot && px > nx - 4 && px < nx + TRAIN_LEN + 4) {
      tr.hit.add(p.id);
      p.damage(25, -1);
      p.x = tr.dir > 0 ? Math.min(T_X1 - 8, front + 2) : Math.max(T_X0 + 2, front - 8);
      p.vx = tr.dir * 5; p.vy = -2.5;
      if (env.fx) env.fx.shake(8);
      emit('boom', px, 6);
    }
  }
}

// Wipe the world and build a map. Returns { spawns: [x, x, x, x], tick?: fn(grid, particles, t, env) }.
export function loadMap(grid, particles, map) {
  grid.clear();
  grid.backdrop = null; // a map may paint one (what you see through empty cells)
  if (particles) particles.clear();
  const r = map.build(grid);
  return Array.isArray(r) ? { spawns: r } : r;
}
