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



// ---------- shared building blocks ----------
// Scale: a bender is 5 x 18 and jumps about 24 cells, so floors are 34 tall (too high to jump) and
// every floor is reached by a real staircase (1 cell up per cell across: you walk up it).
const FH = 34;   // building floor height
const WALL = 4;  // outer walls and floor slabs
const STAIR = 34; // staircase run (= FH: one cell up per cell)
const hexMix = (a, b, k) => { // mix two '#rrggbb' colors -> packed
  const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16), ch = (n, s) => (n >> s) & 255;
  const m = (s) => Math.round(ch(A, s) + (ch(B, s) - ch(A, s)) * k).toString(16).padStart(2, '0');
  return pack('#' + m(16) + m(8) + m(0));
};
const INTERIOR = { [EL.BRICK]: '#4a3632', [EL.STEEL]: '#2e3a50', [EL.CONCRETE]: '#3e4048' };

// A staircase from (x, yLow) rising one cell per cell toward `dir` (+1 right, -1 left) up to yHigh,
// 2 cells thick (you can walk under it). Clears a landing hole in whatever deck is at the top.
// The stairwell hole runs over the whole climb (a bender is 18 tall, so it needs headroom almost
// from the first step) and through the deck's underside (truss chords); you step off the top onto
// the deck past the hole.
function stairs(g, x, yLow, yHigh, dir, mat = EL.WOOD, hole = true) {
  const rise = yLow - yHigh;
  if (hole) { const xa = x + dir * 4, xb = x + dir * (rise + 1); rect(g, Math.min(xa, xb), yHigh - WALL - 2, Math.max(xa, xb) + 1, Math.min(yLow, yHigh + 16), 0); }
  for (let k = 0; k <= rise; k++) { put(g, x + dir * k, yLow - k, mat); put(g, x + dir * k, yLow - k + 1, mat); }
}

// A building standing on `base`: 4-cell outer walls with windows, floors (concrete slab + wooden
// floorboards), a staircase up to every floor (alternating sides), tables, street doors on the
// ground floor, a roof with a parapet. Windows keep each floor airtight (fire in a closed room
// chokes, then backdrafts when the glass breaks). Returns the roof's top row.
function building(g, rooms, x0, x1, base, floors, mat, glassy = false) {
  const top = base - floors * FH;
  rooms.push([x0, top, x1, base, INTERIOR[mat] || '#3e4048', true]);
  rect(g, x0, top, x0 + WALL, base, mat);
  rect(g, x1 - WALL, top, x1, base, mat);
  rect(g, x0, top, x1, top + WALL, mat === EL.STEEL ? EL.CONCRETE : mat);
  rect(g, x0, top - 4, x0 + 4, top, mat); rect(g, x1 - 4, top - 4, x1, top, mat);
  const wide = x1 - x0 > 90;
  const surfaceOf = (f) => (f ? base - f * FH - WALL - 1 : base);
  for (let f = 0; f < floors; f++) { // slabs, windows, doors first...
    const fb = base - f * FH;
    if (f > 0) {
      rect(g, x0 + WALL, fb - WALL, x1 - WALL, fb, EL.CONCRETE);
      rect(g, x0 + WALL, fb - WALL - 1, x1 - WALL, fb - WALL, EL.WOOD);
      const h = glassy ? 22 : 14;
      rect(g, x0, fb - WALL - 3 - h, x0 + WALL, fb - WALL - 3, EL.GLASS);
      rect(g, x1 - WALL, fb - WALL - 3 - h, x1, fb - WALL - 3, EL.GLASS);
    } else {
      rect(g, x0, base - 24, x0 + WALL, base, 0); // street doors
      rect(g, x1 - WALL, base - 24, x1, base, 0);
    }
  }
  // ...then the stairwells. A 2D staircase can't switch back (you'd have to walk under the next
  // flight), so each floor has a stairwell: an opening in the ceiling against one wall, with a
  // plank ledge on that wall at half height. Hop onto the ledge (17 up), hop up through the
  // opening (17 more): two easy jumps per floor. The stairwell alternates sides floor by floor.
  for (let f = 0; f < floors; f++) {
    const surface = surfaceOf(f), ceilTop = f + 1 < floors ? surfaceOf(f + 1) - 1 : top - 1;
    const left = f % 2 === 0, hw = Math.min(28, x1 - x0 - 2 * WALL - 14), lw = Math.min(12, hw - 8);
    const hx0 = left ? x0 + WALL : x1 - WALL - hw;
    rect(g, hx0, ceilTop, hx0 + hw, ceilTop + WALL + 2, 0);                                  // the opening
    const lx0 = left ? x0 + WALL : x1 - WALL - lw, ly = surface - 17;
    rect(g, lx0, ly, lx0 + lw, ly + 2, EL.WOOD);                                              // the ledge
    if (wide) for (let x = x0 + WALL + 60; x < x1 - WALL - 50; x += 64) { // tables, 2 high (you step over them)
      if (x < hx0 + hw + 20 && x + 12 > hx0 - 20) continue; // keep the stairwell clear
      rect(g, x, surface - 2, x + 12, surface - 1, EL.WOOD);
      rect(g, x, surface - 1, x + 1, surface, EL.WOOD); rect(g, x + 11, surface - 1, x + 12, surface, EL.WOOD);
    }
  }
  return top;
}

// Pipes and cables. A pipe is drawn as a 2-thick run through a list of points (it may pass through
// walls and ground: it's buried in them). A cable is a 2-thick line that sags between its two ends.
function pipe(g, type, pts) {
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1], [x1, y1] = pts[k], n = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= n; s++) { const x = Math.round(x0 + ((x1 - x0) * s) / n), y = Math.round(y0 + ((y1 - y0) * s) / n); put(g, x, y, type); put(g, x + (y1 !== y0 ? 1 : 0), y + (y1 !== y0 ? 0 : 1), type); }
  }
}
function cable(g, x0, y0, x1, y1, sag = 8) {
  const n = Math.abs(x1 - x0);
  for (let s = 0; s <= n; s++) { const t = s / n, x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * sag); put(g, x, y, EL.CABLE); put(g, x, y + 1, EL.CABLE); }
}
function lamp(g, x, base) {
  rect(g, x, base - 30, x + 2, base, EL.STEEL);
  rect(g, x - 3, base - 32, x + 5, base - 30, EL.STEEL);
  rect(g, x - 2, base - 30, x + 4, base - 29, EL.GLASS);
}
// A steel truss: deck on top, bottom chord, diagonal struts.
function truss(g, x0, x1, y, depth = 12) {
  rect(g, x0, y, x1, y + 3, EL.STEEL);
  rect(g, x0, y + depth, x1, y + depth + 2, EL.STEEL);
  for (let x = x0; x < x1 - 8; x += 16) for (let k = 0; k < depth - 3; k++) { put(g, x + k * 0.7, y + 3 + k, EL.STEEL); put(g, x + 16 - k * 0.7, y + 3 + k, EL.STEEL); }
}

// Shading patterns: brick mortar, concrete panel seams, steel rivets, road paint, pipe bands.
function patterns(g, roadY = -1) {
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const i = y * g.w + x, t = g.type[i];
    if (t === EL.BRICK) g.shade[i] = y % 4 === 3 || (x + ((y >> 2) & 1) * 4) % 8 === 0 ? 3 : (x + y) % 3;
    else if (t === EL.CONCRETE) g.shade[i] = (x % 30 === 0 || y % 34 === 0) ? 3 : g.shade[i] % 3;
    else if (t === EL.STEEL) g.shade[i] = (x + y) % 6 === 0 ? 3 : g.shade[i] % 3;
    else if (t === EL.ASPHALT) g.shade[i] = y === roadY + 2 && x % 24 < 12 ? 3 : g.shade[i] % 3;
    else if (t === EL.GASPIPE || t === EL.WATERPIPE) g.shade[i] = (x + y) % 12 < 2 ? 3 : (y & 1);
  }
}

// What shows through empty cells: night sky + skyline above `horizon` (or plain rock for an
// underground map), room interiors from `rooms` ([x0, y0, x1, y1, color, floorLines]).
function backdrop(g, rooms, horizon, opts = {}) {
  const bd = new Uint32Array(g.w * g.h), r = rng(opts.seed || 99);
  const under = pack(opts.under || '#1c1d24');
  const sky = Array.from({ length: Math.max(1, horizon) }, (_, y) => { const k = y / horizon; return k < 0.55 ? hexMix('#1c2544', '#34406e', k / 0.55) : hexMix('#34406e', '#6a4c74', (k - 0.55) / 0.45); });
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) bd[y * g.w + x] = y < horizon ? sky[y] : under;
  for (let k = 0; k < g.w / 4; k++) { const x = (r() * g.w) | 0, y = (r() * horizon * 0.5) | 0; if (y < horizon) bd[y * g.w + x] = pack(r() < 0.8 ? '#8a90b0' : '#d0d4ec'); }
  if (horizon > 60) {
    const far = pack('#3a3f60'), far2 = pack('#2c3150'), lit = pack('#a08850'), lit2 = pack('#6a7aa0');
    for (const [layer, col, hMin, hMax] of [[0, far2, 70, Math.min(300, horizon - 10)], [1, far, 35, Math.min(170, horizon - 20)]]) {
      let x = 0;
      while (x < g.w) {
        const bw = 18 + ((r() * 40) | 0), top = horizon - hMin - ((r() * Math.max(1, hMax - hMin)) | 0);
        for (let X = x; X < Math.min(g.w, x + bw); X++) for (let y = Math.max(0, top); y < horizon; y++) {
          const win = layer === 1 && (X - x) % 6 >= 2 && (X - x) % 6 < 4 && (y - top) % 8 >= 3 && (y - top) % 8 < 6 && X > x + 1 && X < x + bw - 2;
          bd[y * g.w + X] = win && r() < 0.25 ? (r() < 0.6 ? lit : lit2) : col;
        }
        x += bw + ((r() * 6) | 0);
      }
    }
  }
  for (const [x0, y0, x1, y1, base, lines] of rooms) {
    const A = pack(base), B = hexMix(base, '#000000', 0.3), L = hexMix(base, '#ffe8a0', 0.22);
    for (let y = Math.max(0, y0); y < Math.min(g.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(g.w, x1); x++) {
      const fy = (y1 - y) % FH;
      bd[y * g.w + x] = lines && fy < 8 ? B : lines && fy > FH - 5 && (x % 40 < 5) ? L : opts.tiles && (x % 10 === 0 || y % 8 === 0) ? B : A;
    }
  }
  g.backdrop = bd;
}
// A hollow steel box (shipping container, tank shell): walls `t` thick, open inside.
function box(g, x0, y0, x1, y1, mat, t = 2) { rect(g, x0, y0, x1, y1, mat); rect(g, x0 + t, y0 + t, x1 - t, y1 - t, 0); }

// ---------- maps: medium 840 x 472, large 1120 x 630 ----------
export const MAPS = [
  {
    id: 'skyline', name: 'Skyline', size: 'Large', w: 1120, h: 630,
    // A 10-floor glass tower, a 6-floor brick block and a 12-floor steel tower over a wide avenue.
    // A 460-cell steel skybridge joins the two tall towers at the glass tower's roof. Under the
    // avenue: a gas main, a water main, then a subway tunnel with two stairways down.
    build(g) {
      const rooms = [], G = 520, W = g.w;
      rect(g, 0, G, W, G + 6, EL.ASPHALT); rect(g, 0, G + 6, W, g.h, EL.STONE); // (solid rock below: loose earth costs time every tick)
      rect(g, 0, G + 6, W, G + 36, EL.CONCRETE);
      rect(g, 0, G + 40, W, G + 100, 0); rect(g, 0, G + 100, W, G + 106, EL.CONCRETE); rect(g, 0, G + 98, W, G + 100, EL.STEEL); // subway tunnel
      rooms.push([0, G + 40, W, G + 100, '#1d2029', false]);
      for (const sx of [380, 700]) { // stairways down to the tunnel
        rect(g, sx, G, sx + 60, G + 40, 0); rooms.push([sx, G, sx + 60, G + 40, '#262a34', false]);
        stairs(g, sx + 58, G + 40, G + 1, -1, EL.CONCRETE, false);
      }
      const tA = building(g, rooms, 60, 340, G, 10, EL.CONCRETE, true);
      const tB = building(g, rooms, 470, 680, G, 6, EL.BRICK);
      const tC = building(g, rooms, 800, 1080, G, 12, EL.STEEL);
      truss(g, 340, 800, tA);                                                   // skybridge, level with the glass tower's roof
      rect(g, 800, tA - 26, 800 + WALL, tA, 0);                                   // its door into the steel tower
      rect(g, 540, tB - 54, 610, tB - 14, EL.WOOD); rect(g, 544, tB - 50, 606, tB - 18, 0); flood(g, 544, tB - 44, 606, tB - 18, EL.WATER); // water tank
      for (const lx of [546, 602]) rect(g, lx, tB - 14, lx + 4, tB, EL.WOOD);
      rect(g, 860, tC - 22, 900, tC, EL.STEEL); rect(g, 940, tC - 30, 950, tC, EL.STEEL); // AC + vent on the steel tower
      for (const lx of [20, 360, 440, 700, 780, 1100]) lamp(g, lx, G);
      // infrastructure
      pipe(g, EL.GASPIPE, [[0, G + 14], [W - 1, G + 14]]);
      for (const x of [61, 471, 801]) pipe(g, EL.GASPIPE, [[x, G + 14], [x, G - 26]]); // risers inside the walls (above the doors)
      pipe(g, EL.GASPIPE, [[61, G - 26], [61, tA + 8]]);
      pipe(g, EL.WATERPIPE, [[0, G + 24], [W - 1, G + 24]]);
      pipe(g, EL.WATERPIPE, [[575, tB - 14], [575, tB + 6], [674, tB + 6], [674, G + 24]]);
      cable(g, 340, tA + 40, 470, tB - 4, 16); cable(g, 680, tB - 4, 800, tB - 40, 12);
      cable(g, 0, G + 44, W - 1, G + 44, 4);
      patterns(g, G); backdrop(g, rooms, G);
      return { spawns: [200, 560, 940, 420, 740], props: [{ kind: 'car', x: 345, y: G - 40 }, { kind: 'car', x: 770, y: G - 40 }, { kind: 'barrel', x: 450, y: G - 40 }, { kind: 'barrel', x: 458, y: G - 40 }, { kind: 'dumpster', x: 620 }, { kind: 'barrel', x: 990 }] };
    },
  },
  {
    id: 'metro', name: 'Grand Metro', size: 'Large', w: 1120, h: 630,
    // Underground. A strip of street with two vent shafts and a stair entrance; a vaulted ticket hall
    // with a sealed glass ticket office; two long escalators down to the platforms; a two-deck
    // tunnel running off both edges; a flood channel under everything.
    build(g) {
      const rooms = [], W = g.w;
      rect(g, 0, 0, W, g.h, EL.STONE);
      rect(g, 0, 0, W, 40, 0); rect(g, 0, 40, W, 46, EL.ASPHALT); rect(g, 0, 46, W, 60, EL.CONCRETE); // the street up top
      for (const vx of [120, 980]) { rect(g, vx, 40, vx + 24, 90, 0); rooms.push([vx, 40, vx + 24, 90, '#1d2029', false]); } // vent shafts
      rect(g, 520, 40, 600, 90, 0); stairs(g, 598, 90, 41, -1, EL.CONCRETE, false); rooms.push([520, 40, 600, 90, '#262a34', false]); // street stairs
      rect(g, 40, 90, W - 40, 230, 0); rect(g, 40, 230, W - 40, 238, EL.CONCRETE);  // ticket hall
      rooms.push([40, 90, W - 40, 230, '#2c2f3a', false]);
      for (let x = 160; x < W - 100; x += 120) { rect(g, x, 90, x + 10, 150, EL.CONCRETE); rect(g, x - 6, 146, x + 16, 152, EL.CONCRETE); } // hanging arches
      box(g, 180, 140, 400, 230, EL.CONCRETE, 4); rect(g, 184, 226, 396, 230, EL.CONCRETE); // sealed ticket office
      rect(g, 180, 160, 184, 200, EL.GLASS); rect(g, 396, 160, 400, 200, EL.GLASS); rect(g, 396, 202, 400, 226, EL.WOOD); // windows, wooden door
      rooms.push([184, 144, 396, 226, '#3a2f2a', false]);
      for (const fx of [210, 290, 350]) { rect(g, fx, 218, fx + 24, 220, EL.WOOD); rect(g, fx, 220, fx + 2, 226, EL.WOOD); rect(g, fx + 22, 220, fx + 24, 226, EL.WOOD); }
      // platform level + escalators
      rect(g, 40, 238, W - 40, 430, 0); rooms.push([40, 238, W - 40, 430, '#2c2f3a', false]);
      rect(g, 430, 230, 470, 238, 0); rect(g, 650, 230, 690, 238, 0);             // escalator mouths
      stairs(g, 240, 430, 238, 1, EL.STEEL, false);                               // left escalator: platform (240) up to the hall (432)
      stairs(g, 880, 430, 238, -1, EL.STEEL, false);                              // right escalator
      rect(g, 40, 430, 440, 440, EL.CONCRETE); rect(g, 680, 430, W - 40, 440, EL.CONCRETE); // platforms
      // the tunnel (two decks), off both map edges
      rect(g, 0, 440, W, 556, 0); rect(g, 0, 494, W, 500, EL.CONCRETE); rect(g, 0, 556, W, 572, EL.CONCRETE);
      rect(g, 440, 494, 680, 500, 0);                                              // the upper deck is open under the platform gap
      rect(g, 0, 492, 440, 494, EL.STEEL); rect(g, 680, 492, W, 494, EL.STEEL); rect(g, 0, 554, W, 556, EL.STEEL); // rails
      rooms.push([0, 440, W, 556, '#1d2029', false]);
      // flood channel
      rect(g, 0, 590, W, 616, 0); flood(g, 0, 600, W, 616, EL.WATER);
      for (const dx of [300, 820]) rect(g, dx, 572, dx + 14, 590, 0);              // drains down to it
      rooms.push([0, 590, W, 616, '#1e2a36', false], [300, 572, 314, 590, '#1e2a36', false], [820, 572, 834, 590, '#1e2a36', false]);
      // infrastructure
      pipe(g, EL.GASPIPE, [[40, 93], [W - 41, 93]]);
      pipe(g, EL.WATERPIPE, [[60, 96], [60, 228]]); pipe(g, EL.WATERPIPE, [[W - 62, 96], [W - 62, 228]]);
      pipe(g, EL.WATERPIPE, [[0, 444], [W - 1, 444]]);
      cable(g, 40, 104, W - 41, 104, 6); cable(g, 0, 502, W - 1, 502, 4);
      lamp(g, 30, 40); lamp(g, 1080, 40);
      patterns(g); backdrop(g, rooms, 40, { under: '#1c1d24', tiles: false });
      return { spawns: [[100, 100], [1000, 100], [120, 300], [1000, 300], [560, 446]], props: [{ kind: 'barrel', x: 1000, y: 300 }, { kind: 'barrel', x: 1008, y: 300 }, { kind: 'barrel', x: 100, y: 100 }, { kind: 'car', x: 300 }, { kind: 'car', x: 800 }, { kind: 'dumpster', x: 120, y: 300 }] };
    },
  },
  {
    id: 'refinery', name: 'Refinery', size: 'Medium', w: 840, h: 472,
    // A brick furnace house with an open lava hearth feeding a tall smokestack; three steel catwalks
    // joined by stairs, running from the furnace house to the gas tanks; a cooling pond in the yard.
    build(g) {
      const rooms = [], G = 400, W = g.w;
      rect(g, 0, G, W, g.h - 4, EL.CONCRETE); rect(g, 0, g.h - 4, W, g.h, EL.STONE);
      rect(g, 320, G, 560, g.h - 18, EL.STONE); rect(g, 326, G, 554, g.h - 24, 0); flood(g, 326, G + 8, 554, g.h - 24, EL.WATER); // cooling pond
      rooms.push([326, G, 554, g.h - 24, '#1e2a36', false]);
      // smokestack (hollow, open at the top) fed from the hearth
      rect(g, 56, 40, 100, G, EL.BRICK); rect(g, 62, 34, 94, G, 0); rect(g, 52, 40, 62, 46, EL.STONE); rect(g, 94, 40, 104, 46, EL.STONE);
      rooms.push([62, 34, 94, G, '#2a1d1a', false]);
      // furnace house
      box(g, 100, 246, 294, G + 4, EL.BRICK, 6); rect(g, 106, G, 288, G + 4, EL.BRICK);
      rect(g, 94, G - 70, 106, G - 40, 0);                                          // flue into the stack
      rect(g, 288, G - 30, 294, G, 0);                                               // door
      rooms.push([106, 252, 288, G, '#3a2622', false]);
      rect(g, 140, G - 30, 250, G, EL.BRICK); rect(g, 146, G - 26, 244, G, 0); flood(g, 146, G - 20, 244, G, EL.LAVA); // hearth
      rect(g, 146, G - 34, 200, G - 30, EL.STEEL);                                   // its red-hot lid
      // catwalks: furnace house wall to the tanks
      truss(g, 294, 660, 330, 10); truss(g, 294, 660, 260, 10); truss(g, 100, 720, 190, 10);
      // stairs: one long climb up-left, a short landing on each catwalk (2D stairs can't switch back)
      stairs(g, 470, G - 1, 330, -1, EL.STEEL);                                      // yard -> lowest catwalk (top at 400)
      stairs(g, 390, 329, 260, -1, EL.STEEL);                                        // -> middle (top at 321)
      stairs(g, 312, 259, 190, -1, EL.STEEL);                                        // -> top (top at 243)
      // gas tanks: steel shells lined with gas
      for (const [x, h] of [[660, 170], [720, 210], [780, 140]]) { box(g, x, G - h, x + 50, G, EL.STEEL, 3); rect(g, x + 3, G - h + 3, x + 47, G, EL.GASPIPE); rect(g, x + 8, G - h + 8, x + 42, G - 4, 0); rooms.push([x + 8, G - h + 8, x + 42, G - 4, '#2a2620', false]); }
      // infrastructure
      pipe(g, EL.GASPIPE, [[294, G - 2], [660, G - 2]]);
      pipe(g, EL.WATERPIPE, [[0, G + 10], [326, G + 10]]);
      cable(g, 104, 60, 330, 190, 18); cable(g, 0, 300, 56, 300, 6);
      lamp(g, 610, G); lamp(g, 20, G);
      patterns(g); backdrop(g, rooms, G);
      return { spawns: [30, [480, 200], [480, 300], 800, [620, 350]], props: [{ kind: 'car', x: 2, y: 360 }, { kind: 'barrel', x: 300, y: 370 }, { kind: 'barrel', x: 570, y: 370 }, { kind: 'barrel', x: 578, y: 370 }, { kind: 'dumpster', x: 590, y: 370 }, { kind: 'barrel', x: 400 }] };
    },
  },
  {
    id: 'harbor', name: 'Harbor', size: 'Large', w: 1120, h: 630,
    // A brick warehouse and a container yard on the quay, a tower crane at the map edge with a long
    // boom over everything, a wooden pier over deep water, and a steel cargo ship with a two-deck
    // hold (sealed: wooden hatch) and a bridge tower. The seabed is sand.
    build(g) {
      const rooms = [], G = 430, W = g.w, SEABED = G + 92;
      rect(g, 0, SEABED, W, SEABED + 10, EL.SAND); rect(g, 0, SEABED + 10, W, g.h, EL.STONE); // a shallow harbor on a thin sand bed (deep water and loose sand are slow to simulate)
      rect(g, 0, G, 440, SEABED, EL.CONCRETE); rect(g, 0, G, 440, G + 6, EL.ASPHALT); // quay
      building(g, rooms, 30, 260, G, 3, EL.BRICK);
      // tower crane at the left edge, boom out over the harbor
      rect(g, 0, 90, 12, G, EL.STEEL); for (let y = 96; y < G; y += 12) rect(g, 12, y, 16, y + 2, EL.STEEL);
      truss(g, 0, 1000, 90, 10); rect(g, 0, 70, 6, 90, EL.STEEL);
      cable(g, 900, 103, 901, 104, 0); rect(g, 900, 104, 902, 240, EL.CABLE); rect(g, 892, 240, 910, 246, EL.STEEL); // hook
      // pier
      rect(g, 440, G, 780, G + 8, EL.WOOD); for (let x = 450; x < 780; x += 30) rect(g, x, G + 8, x + 5, SEABED, EL.WOOD);
      // the ship (reaches the map edge)
      rect(g, 760, G - 50, W, SEABED, EL.STEEL);                                   // (resting on the seabed)
      rect(g, 770, G - 40, W - 6, G + 30, 0); rect(g, 770, G + 36, W - 6, SEABED - 8, 0);
      rect(g, 860, G - 50, 900, G - 40, EL.WOOD);                                   // wooden hatch (keeps the hold sealed)
      rect(g, 990, G + 30, 1020, G + 36, EL.WOOD);                                   // hatch between the decks
      rect(g, 760, G - 54, W, G - 50, EL.STEEL);
      box(g, 980, G - 140, 1060, G - 50, EL.STEEL, 4); rect(g, 980, G - 130, 984, G - 110, EL.GLASS); rect(g, 1056, G - 130, 1060, G - 110, EL.GLASS); rect(g, 980, G - 80, 984, G - 54, 0); // bridge
      rooms.push([770, G - 40, W - 6, G + 30, '#2e3a50', false], [770, G + 36, W - 6, SEABED - 8, '#283244', false], [984, G - 136, 1056, G - 54, '#2e3a50', false]);
      // the harbor: water everywhere off the quay, not inside the ship
      fill(g, 440, 760, G + 20);
      // infrastructure
      pipe(g, EL.GASPIPE, [[0, G + 12], [440, G + 12], [440, G + 9], [780, G + 9], [780, G + 60]]); // fuel line out to the ship
      pipe(g, EL.GASPIPE, [[31, G + 12], [31, G - 26], [31, G - 90]]);
      pipe(g, EL.WATERPIPE, [[0, G + 20], [430, G + 20]]);
      cable(g, 16, 120, 260, G - 3 * FH - 4, 20);
      for (const lx of [280, 430, 600, 770]) lamp(g, lx, lx === 770 ? G - 54 : G);
      patterns(g, G); backdrop(g, rooms, G);
      return {
        spawns: [100, 330, 600, 900, 1020],
        props: [{ kind: 'container', x: 290, y: 110 }, { kind: 'container', x: 345, y: 110 }, { kind: 'container', x: 315, y: 110 }, { kind: 'container', x: 520, y: 110 }, { kind: 'container', x: 600, y: 110 }, { kind: 'car', x: 405, y: 110 }, { kind: 'barrel', x: 700, y: 110 }, { kind: 'barrel', x: 708, y: 110 }, { kind: 'barrel', x: 800, y: G - 60 }],
      };
    },
  },
  {
    id: 'oldtown', name: 'Old Town', size: 'Medium', w: 840, h: 472,
    // Four 3-floor brick houses with wooden floors and cellars around a plaza, a 9-floor clock tower
    // in the middle, fountains either side, a canal under the plaza. A gas main runs through every
    // cellar; the fountains are fed by water mains; power cables run from the houses to the tower.
    build(g) {
      const rooms = [], G = 380, W = g.w, r = rng(67);
      rect(g, 0, G, W, g.h, EL.STONE); rect(g, 0, G + 90, W, g.h - 12, EL.EARTH); // (stone round the cellars, so nothing slumps into them)
      rect(g, 300, G + 24, 540, G + 74, EL.STONE); rect(g, 306, G + 30, 534, G + 68, 0); flood(g, 306, G + 46, 534, G + 68, EL.WATER); // canal
      for (const sx of [306, 522]) rect(g, sx, G, sx + 12, G + 30, 0);              // steps down to it
      rooms.push([306, G + 30, 534, G + 68, '#1e2a36', false], [306, G, 318, G + 30, '#2a2a30', false], [522, G, 534, G + 30, '#2a2a30', false]);
      const tops = [];
      for (const [x0, x1] of [[20, 150], [150, 280], [560, 690], [690, 820]]) {
        tops.push(building(g, rooms, x0, x1, G, 3, EL.BRICK));
        rect(g, x0 + 4, G + 6, x1 - 4, G + 54, 0); rect(g, x0, G + 54, x1, G + 58, EL.STONE); // cellar
        rooms.push([x0 + 4, G + 6, x1 - 4, G + 54, '#2e2522', false]);
        stairs(g, x1 - 12, G + 53, G + 1, -1, EL.WOOD, false); rect(g, x1 - 40, G, x1 - 12, G + 6, 0); // stairs down
      }
      const tt = building(g, rooms, 395, 445, G, 9, EL.BRICK);                      // clock tower
      rect(g, 403, tt - 24, 437, tt - 4, EL.STEEL); rect(g, 410, tt - 34, 430, tt - 24, EL.STEEL); rect(g, 418, tt - 44, 422, tt - 34, EL.STEEL); // spire
      rect(g, 403, tt + 20, 437, tt + 44, EL.GLASS);                                 // clock face
      for (const [fx, fw] of [[330, 50], [460, 50]]) { rect(g, fx, G - 14, fx + fw, G, EL.STONE); rect(g, fx + 4, G - 12, fx + fw - 4, G - 3, 0); flood(g, fx + 4, G - 10, fx + fw - 4, G - 3, EL.WATER); }
      for (const x of [300, 540]) tree(g, x, G, 18 + r() * 4, 9);
      for (const lx of [290, 550]) lamp(g, lx, G);
      // infrastructure
      pipe(g, EL.GASPIPE, [[0, G + 40], [W - 1, G + 40]]);
      for (const x of [21, 151, 561, 691]) pipe(g, EL.GASPIPE, [[x, G + 40], [x, G - 60]]);
      pipe(g, EL.WATERPIPE, [[354, G - 3], [354, G + 30]]); pipe(g, EL.WATERPIPE, [[484, G - 3], [484, G + 30]]);
      cable(g, 150, tops[1] - 2, 395, tt + 60, 22); cable(g, 445, tt + 60, 690, tops[3] - 2, 22);
      patterns(g); backdrop(g, rooms, G);
      return { spawns: [85, 330, 510, 755, 215], props: [{ kind: 'barrel', x: 286, y: 300 }, { kind: 'barrel', x: 546, y: 300 }, { kind: 'dumpster', x: 40 }, { kind: 'car', x: 600 }] };
    },
  },
];

// The Clash Lab's own small arena (the lab builds its floor itself).
export const LAB_MAP = {
  id: 'lab', name: 'Clash Lab', w: 640, h: 315,
  build(g) { backdrop(g, [], 200); return { spawns: [90, 545] }; },
};

// Wipe the world (resizing it to the map) and build a map.
// Returns { spawns: [x | [x, y], ...], props?: [...], tick?: fn(grid, particles, t, env) }.
export function loadMap(grid, particles, map) {
  if (map.w && (grid.w !== map.w || grid.h !== map.h)) grid.resize(map.w, map.h);
  grid.clear();
  grid.backdrop = null; // a map may paint one (what you see through empty cells)
  if (particles) particles.clear();
  const r = map.build(grid);
  const res = Array.isArray(r) ? { spawns: r } : r;
  grid.propPlan = res.props || null; // cars, barrels, containers (placed by physics.js)
  return res;
}
