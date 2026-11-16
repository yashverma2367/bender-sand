// Map templates. Each map fills the grid with terrain and returns
//   { spawns: [x, x, x, x], tick?: fn(grid, particles, t, env) }
// spawns: one x per player (left to right). tick (optional) runs every simulation tick for
// live hazards; env = { fx, players }. Terrain uses seeded noise, so a map looks the same
// every time it's loaded.
import { EL, KIND, Kind } from './elements.js';
import { emit } from './sfx.js';

// ---------- helpers ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Smooth 1D noise in [-1, 1] with features about `scale` cells wide.
function noise(seed, scale) {
  const r = rng(seed), pts = Array.from({ length: 512 }, () => r() * 2 - 1);
  return (x) => {
    const f = x / scale, i = Math.floor(f), t = f - i, s = t * t * (3 - 2 * t);
    return pts[((i % 512) + 512) % 512] * (1 - s) + pts[(((i + 1) % 512) + 512) % 512] * s;
  };
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

// Ground column from `top` down to the floor: `surface` for the first rows, then earth, then stone.
function column(g, x, top, surface = EL.EARTH, surfaceDepth = 3, earthDepth = 12) {
  for (let y = Math.max(0, Math.floor(top)); y < g.h; y++) {
    const d = y - top;
    put(g, x, y, d < surfaceDepth ? surface : d < earthDepth ? EL.EARTH : EL.STONE);
  }
}

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

// A cave: a random-walk "worm" that carves a tunnel of radius ~rad for `len` steps.
function worm(g, r, x, y, len, rad, yMin = 0, yMax = 1e9) {
  let a = r() * Math.PI * 2;
  for (let k = 0; k < len; k++) {
    disc(g, x, y, rad * (0.8 + r() * 0.4), 0);
    a += (r() - 0.5) * 0.7;
    x += Math.cos(a) * 1.5; y += Math.sin(a) * 0.9;
    if (y < yMin) { y = yMin; a = Math.abs(a); }
    if (y > yMax) { y = yMax; a = -Math.abs(a); }
    x = Math.max(2, Math.min(g.w - 3, x));
  }
}

function tree(g, x, groundY, h, r) {
  rect(g, x, groundY - h, x + 2, groundY, EL.WOOD);
  disc(g, x + 1, groundY - h - r * 0.4, r, EL.PLANT, true);
  disc(g, x - r * 0.6, groundY - h + r * 0.3, r * 0.7, EL.PLANT, true);
  disc(g, x + 2 + r * 0.6, groundY - h + r * 0.3, r * 0.7, EL.PLANT, true);
}

// Plank bridge from x0 to x1 sagging `sag` cells in the middle.
function bridge(g, x0, x1, y, sag = 4, t = EL.WOOD) {
  for (let x = Math.floor(x0); x <= x1; x++) {
    const k = (x - x0) / (x1 - x0), yy = Math.round(y + Math.sin(k * Math.PI) * sag);
    put(g, x, yy, t); put(g, x, yy + 1, t);
  }
}

// Surface y of the ground at column x (first solid-ish cell from the top).
function surfaceAt(g, x) {
  for (let y = 0; y < g.h; y++) {
    const t = g.type[y * g.w + Math.floor(x)];
    if (t !== 0 && t !== EL.WATER && t !== EL.PLANT && t !== EL.WOOD) return y;
  }
  return g.h - 1;
}

const spread = (g, fracs) => fracs.map((f) => Math.floor(g.w * f));

// A castle: thick stone walls, wooden floors with a gap to jump through, windows, a door on
// the inner side, a stone roof with battlements. `dir` = which side faces the enemy (+1 right).
function castle(g, x0, x1, ground, floors, dir) {
  const H = floors * 17, top = ground - H;
  rect(g, x0, top, x0 + 3, ground, EL.STONE);
  rect(g, x1 - 3, top, x1, ground, EL.STONE);
  rect(g, x0, top, x1, top + 3, EL.STONE); // roof
  for (let x = x0; x < x1; x += 6) rect(g, x, top - 4, x + 3, top, EL.STONE); // battlements
  for (let f = 1; f < floors; f++) { // floors with a jump-through gap near the back wall
    const y = ground - f * 17;
    const gapX = dir > 0 ? x0 + 4 : x1 - 14;
    rect(g, x0 + 3, y, x1 - 3, y + 2, EL.WOOD);
    rect(g, gapX, y, gapX + 10, y + 2, 0);
  }
  for (let f = 0; f < floors; f++) { // windows on both walls, a door on the inner side
    const y = ground - f * 17 - 11;
    rect(g, x0, y, x0 + 3, y + 6, 0);
    rect(g, x1 - 3, y, x1, y + 6, 0);
  }
  const doorX = dir > 0 ? x1 - 3 : x0;
  rect(g, doorX, ground - 10, doorX + 3, ground, 0);
}

// Icicle hanging from a ceiling at (x, y), pointing down.
function icicle(g, x, y, len) {
  for (let k = 0; k < len; k++) {
    const w = Math.max(0, Math.round((1 - k / len) * 2));
    for (let dx = -w; dx <= w; dx++) if (typeAt(g, x + dx, y + k) === 0) put(g, x + dx, y + k, EL.ICE);
  }
}

// ---------- maps ----------
export const MAPS = [
  {
    id: 'fortress',
    name: 'Fortress Clash',
    // Two mirrored stone castles (floors, windows, doors, battlements) facing each other across a
    // deep chasm spanned by a wooden bridge. Caves with a buried pool under each castle.
    build(g) {
      const n1 = noise(71, 60), r = rng(72);
      const chL = g.w * 0.42, chR = g.w * 0.58;
      for (let x = 0; x < g.w; x++) {
        let top = 176 + n1(x) * 3;
        if (x > chL && x < chR) top = 210; // chasm
        column(g, x, top, EL.EARTH, 4, 9);
      }
      fill(g, chL, chR, 198);
      bridge(g, chL - 4, chR + 4, 168, 5);
      castle(g, 30, 140, 176, 3, 1);
      castle(g, g.w - 140, g.w - 30, 176, 3, -1);
      for (const side of [1, -1]) { // caves under each castle with a pool and a lava pocket
        const cx = side > 0 ? 90 : g.w - 90;
        worm(g, r, cx, 192, 90, 3, 184, 206);
        flood(g, cx - 25, 200, cx + 25, 210, EL.WATER);
        disc(g, cx + side * 40, 196, 4, EL.LAVA);
      }
      for (let k = 0; k < 4; k++) { // boulders for cover in no-man's-land
        const x = (k < 2 ? g.w * 0.28 : g.w * 0.66) + (k % 2) * 30;
        disc(g, x, surfaceAt(g, x) - 2, 4 + r() * 2, EL.STONE);
      }
      return { spawns: [70, Math.floor(g.w * 0.33), Math.floor(g.w * 0.67), g.w - 70] };
    },
  },
  {
    id: 'volcano',
    name: 'Twin Volcanoes',
    // Two active volcanoes (molten craters, lava tubes, magma chambers, smoke plumes, eruptions
    // every 10-18 s), obsidian ledges up the slopes, ash fields, and a cave with a hot spring
    // under the valley lake.
    build(g) {
      const n1 = noise(21, 40), n2 = noise(22, 9), r = rng(23);
      const peaks = [g.w * 0.22, g.w * 0.78];
      const lakeL = g.w * 0.4, lakeR = g.w * 0.6;
      for (let x = 0; x < g.w; x++) {
        let top = 188 + n1(x) * 3;
        for (const cx of peaks) top = Math.min(top, Math.max(84, 72 + Math.abs(x - cx) * 1.55 + n2(x) * 3));
        if (x > lakeL && x < lakeR) top = Math.max(top, 188 + Math.sin(((x - lakeL) / (lakeR - lakeL)) * Math.PI) * 14);
        column(g, x, top, EL.EARTH, 4, 8);
        if (top > 180 && (x < lakeL - 10 || x > lakeR + 10)) for (let y = Math.floor(top); y < top + 2; y++) put(g, x, y, EL.ASH); // ash fields
      }
      for (const cx of peaks) {
        for (let y = 70; y < 104; y++) for (let x = Math.floor(cx - 16); x <= cx + 16; x++) if (g.type[y * g.w + x] === EL.EARTH) put(g, x, y, EL.STONE);
        for (let x = Math.floor(cx - 12); x <= cx + 12; x++) {
          const d = Math.abs(x - cx);
          if (d >= 9) { for (let y = 79; y < 85; y++) put(g, x, y, EL.STONE); continue; }
          for (let y = 81; y < 84 + 8 * Math.cos((d / 9) * (Math.PI / 2)); y++) put(g, x, y, EL.LAVA);
        }
        rect(g, cx - 2, 92, cx + 2, 104, EL.LAVA);
        disc(g, cx, 112, 9, EL.LAVA);
        for (const s of [-1, 1]) { // lava tubes snaking down inside the mountain
          let x = cx, y = 118;
          for (let k = 0; k < 40; k++) { disc(g, x, y, 1.6, EL.LAVA); x += s * (1 + r()); y += 1 + r() * 0.8; }
        }
        for (let k = 0; k < 4; k++) { // obsidian ledges to climb on
          const s = k % 2 ? 1 : -1, y = 112 + k * 16, x = cx + s * (Math.max(0, y - 72) / 1.55 + 2);
          rect(g, s > 0 ? x : x - 10, y, s > 0 ? x + 10 : x, y + 2, EL.OBSIDIAN);
        }
        for (let y = 76; y < 128; y++) for (let x = Math.floor(cx - 20); x <= cx + 20; x++) {
          const i = y * g.w + x;
          if (g.type[i] === EL.STONE) g.temp[i] = Math.max(g.temp[i], 1100 - Math.hypot(x - cx, y - 112) * 12);
          if (g.type[i] === EL.LAVA) g.temp[i] = 1300;
        }
      }
      fill(g, lakeL, lakeR, 190);
      worm(g, r, g.w * 0.5, 206, 80, 3, 200, 212); // cave under the lake with a hot spring
      flood(g, g.w * 0.45, 206, g.w * 0.55, 214, EL.WATER);
      for (let y = 206; y < 214; y++) for (let x = Math.floor(g.w * 0.45); x < g.w * 0.55; x++) if (g.type[y * g.w + x] === EL.WATER) g.temp[y * g.w + x] = 95;

      const hearts = peaks.map((cx) => {
        const cells = [];
        for (let y = 80; y < 122; y++) for (let x = Math.floor(cx - 9); x <= cx + 9; x++) {
          const crater = y < 92 && Math.abs(x - cx) < 9, vent = y >= 92 && y < 104 && Math.abs(x - cx) <= 2;
          if ((crater || vent || Math.hypot(x - cx, y - 112) <= 9) && g.type[y * g.w + x] === EL.LAVA) cells.push(y * g.w + x);
        }
        return { cx, cells, next: 300 + Math.floor(Math.random() * 400), erupting: 0 };
      });
      const tick = (grid, ps, t) => {
        for (const v of hearts) {
          for (let k = 0; k < 40; k++) {
            const i = v.cells[(Math.random() * v.cells.length) | 0];
            if (grid.type[i] === EL.STONE || grid.type[i] === EL.OBSIDIAN) grid.transform(i, EL.LAVA);
            if (grid.type[i] === EL.LAVA) grid.temp[i] = 1300;
          }
          if (t % 6 === 0) { const x = Math.floor(v.cx + (Math.random() - 0.5) * 10); if (grid.type[76 * grid.w + x] === 0) grid.set(x, 76, EL.SMOKE); }
          if (--v.next <= 0) { emit('boom', v.cx, 12); v.erupting = 60; v.next = 600 + Math.floor(Math.random() * 480); }
          if (v.erupting > 0 && ps) {
            v.erupting--;
            for (let k = 0; k < 4; k++) ps.spawn(v.cx + (Math.random() - 0.5) * 8, 80, (Math.random() - 0.5) * 3.5, -4 - Math.random() * 4, EL.LAVA, { gravity: 0.1 });
          }
        }
      };
      return { spawns: spread(g, [0.06, 0.36, 0.64, 0.94]), tick };
    },
  },
  {
    id: 'cove',
    name: 'Shipwreck Cove',
    // A sea with three islands (underwater caves, palms, coral) and a sunken wooden ship in the
    // middle. A tidal surge crashes across the sea every ~20 s, alternating sides.
    build(g) {
      const nb = noise(31, 50), ni = noise(32, 12), r = rng(33);
      const islands = [{ cx: g.w * 0.12, hw: 46 }, { cx: g.w * 0.5, hw: 30 }, { cx: g.w * 0.88, hw: 46 }];
      for (let x = 0; x < g.w; x++) {
        let top = 202 + nb(x) * 5;
        for (const is of islands) {
          const dx = (x - is.cx) / is.hw;
          if (Math.abs(dx) < 1) top = Math.min(top, 160 - Math.sqrt(1 - dx * dx) * 20 + ni(x) * 3);
        }
        column(g, x, top, EL.SAND, 4, 14);
      }
      for (const is of [islands[0], islands[2]]) worm(g, r, is.cx, 182, 50, 3, 172, 196); // island caves
      fill(g, 0, g.w, 165);
      for (const is of [islands[0], islands[2]]) flood(g, is.cx - 40, 172, is.cx + 40, 200, EL.WATER);
      // The shipwreck: a curved wooden hull resting on the seabed, deck, mast and yard.
      const sx = g.w * 0.25, sw = 56, sy = 168;
      for (let x = Math.floor(sx); x < sx + sw; x++) {
        const k = (x - sx) / sw, depth = Math.sin(k * Math.PI) * 18;
        for (let y = sy; y < sy + depth + 2; y++) {
          if (y > sy + depth - 1 || x < sx + 2 || x > sx + sw - 3) put(g, x, y, EL.WOOD); else clear(g, x, y);
        }
        if (k > 0.1 && k < 0.9) { put(g, x, sy, EL.WOOD); put(g, x, sy + 1, EL.WOOD); }
      }
      rect(g, sx + 6, sy, sx + 12, sy + 2, 0); // hole in the deck
      rect(g, sx + sw * 0.5, sy - 32, sx + sw * 0.5 + 2, sy, EL.WOOD); // mast
      rect(g, sx + sw * 0.5 - 10, sy - 30, sx + sw * 0.5 + 12, sy - 28, EL.WOOD); // yard
      flood(g, sx, sy + 2, sx + sw, sy + 20, EL.WATER);
      const bx = g.w * 0.66; // a second, broken hull on the seabed
      for (let x = Math.floor(bx); x < bx + 36; x++) put(g, x, surfaceAt(g, x) - 1, EL.WOOD);
      for (let k = 0; k < 14; k++) { // coral
        const x = Math.floor(r() * g.w), gy = surfaceAt(g, x);
        if (gy > 175) for (let h = 0; h < 3 + r() * 6; h++) put(g, x + Math.round(Math.sin(h)), gy - 1 - h, EL.PLANT);
      }
      for (const is of islands) tree(g, Math.floor(is.cx + (r() - 0.5) * is.hw * 0.6), surfaceAt(g, is.cx), 14 + r() * 6, 5);

      let next = 900, surge = 0, dir = 1;
      const tick = (grid, ps) => {
        if (--next <= 0) { surge = 70; next = 1200 + Math.floor(Math.random() * 300); dir = -dir; }
        if (surge > 0 && ps) { // a wall of water rolling in from one edge
          surge--;
          const x = dir > 0 ? 2 : grid.w - 3;
          for (let k = 0; k < 10; k++) ps.spawn(x, 160 - Math.random() * 26, dir * (3.5 + Math.random() * 1.5), -0.4, EL.WATER, { gravity: 0.04, dmg: 0.2 });
        }
      };
      return { spawns: [Math.floor(islands[0].cx), Math.floor(sx + sw * 0.3), Math.floor(islands[1].cx), Math.floor(islands[2].cx)], tick };
    },
  },
  {
    id: 'sky',
    name: 'Sky Islands',
    // Floating islands over a sea of LAVA (don't fall). Rope bridges between neighbours, hanging
    // vines, glass crystals, a big central island with a cave, and a waterfall pouring off a high
    // island that hisses into obsidian where it meets the lava.
    build(g) {
      rect(g, 0, g.h - 4, g.w, g.h, EL.STONE);
      rect(g, 0, g.h - 12, g.w, g.h - 4, EL.LAVA);
      const r = rng(41), nTop = noise(42, 8);
      const isl = [];
      const defs = [[0.07, 18, 110], [0.2, 16, 85], [0.33, 18, 125], [0.5, 34, 100], [0.67, 18, 125], [0.8, 16, 85], [0.93, 18, 110]];
      for (const [f, hw, top] of defs) {
        const cx = g.w * f;
        isl.push({ cx, top, hw });
        for (let x = Math.floor(cx - hw); x <= cx + hw; x++) {
          const dx = (x - cx) / hw, under = Math.sqrt(Math.max(0, 1 - dx * dx)) * (18 + hw * 0.6);
          const t0 = top + nTop(x) * 1.5;
          for (let y = Math.floor(t0); y < top + under; y++) put(g, x, y, y - t0 < 1 ? EL.PLANT : y - t0 < 5 ? EL.EARTH : EL.STONE);
          if (r() < 0.12) for (let y = Math.floor(top + under); y < top + under + 4 + r() * 10; y++) put(g, x, y, EL.PLANT); // vines
        }
        if (r() < 0.5) disc(g, cx + (r() - 0.5) * hw, top + 10, 2 + r() * 2, EL.GLASS); // crystals
      }
      const mid = isl[3];
      worm(g, r, mid.cx, mid.top + 14, 40, 3, mid.top + 9, mid.top + 22); // cave in the big island
      for (let k = 0; k + 1 < isl.length; k++) { // rope bridges between neighbours of similar height
        const a = isl[k], b = isl[k + 1];
        if (Math.abs(a.top - b.top) > 30) continue;
        bridge(g, a.cx + a.hw - 2, b.cx - b.hw + 2, Math.min(a.top, b.top) + 1, 6);
      }
      for (const i of [isl[1], isl[5]]) tree(g, Math.floor(i.cx), surfaceAt(g, i.cx), 10, 4);
      const fall = { x: Math.floor(isl[1].cx + isl[1].hw - 1), y: isl[1].top + 2 }; // waterfall source
      const tick = (grid, ps, t) => {
        if (t % 900 < 500 && t % 2 === 0) { // waterfall on for ~8 s, off for ~7 s
          const x = fall.x + 1 + ((Math.random() * 2) | 0);
          if (grid.type[fall.y * grid.w + x] === 0) grid.set(x, fall.y, EL.WATER);
        }
      };
      return { spawns: [isl[0], isl[2], isl[4], isl[6]].map((i) => Math.floor(i.cx)), tick };
    },
  },
  {
    id: 'forest',
    name: 'Storm Forest',
    // Wooded hills with treehouses, a canyon river spanned by a log bridge, caves under the hills,
    // a spring pouring into the canyon. A thunderstorm rages: rain, and every 12-20 s lightning
    // strikes (prefers trees), setting things alight and hurting anyone close.
    build(g) {
      const n1 = noise(51, 60), n2 = noise(52, 15), r = rng(53);
      const cL = g.w * 0.44, cR = g.w * 0.56;
      for (let x = 0; x < g.w; x++) {
        let top = 156 + n1(x) * 18 + n2(x) * 3;
        if (x > cL && x < cR) top += Math.sin(((x - cL) / (cR - cL)) * Math.PI) * 50;
        column(g, x, top);
        put(g, x, Math.floor(top) - 1, EL.PLANT);
      }
      fill(g, cL, cR, 196);
      worm(g, r, g.w * 0.2, 190, 80, 3, 178, 206); // caves
      worm(g, r, g.w * 0.8, 190, 80, 3, 178, 206);
      bridge(g, cL - 6, cR + 6, Math.min(surfaceAt(g, cL - 6), surfaceAt(g, cR + 6)) - 1, 6);
      const trees = [];
      for (let x = 10; x < g.w - 10; x += 13 + Math.floor(r() * 9)) {
        if (x > cL - 12 && x < cR + 12) continue;
        const h = 14 + r() * 14, gy = surfaceAt(g, x);
        tree(g, x, gy, h, 5 + r() * 3);
        trees.push(x + 1);
        if (r() < 0.22) rect(g, x - 7, gy - h * 0.6, x + 9, gy - h * 0.6 + 2, EL.WOOD); // treehouse deck
      }
      const spring = { x: Math.floor(cL + 2), y: surfaceAt(g, cL - 2) + 6 };
      rect(g, spring.x - 3, spring.y - 2, spring.x + 1, spring.y + 1, 0); // spring mouth

      let nextBolt = 300;
      const tick = (grid, ps, t, env = {}) => {
        if (ps) ps.spawn(Math.random() * grid.w, 0, -0.3, 2.5, EL.WATER, { gravity: 0.05, dmg: 0 }); // rain
        if (t % 3 === 0 && grid.type[spring.y * grid.w + spring.x] === 0) grid.set(spring.x, spring.y, EL.WATER);
        if (--nextBolt > 0) return;
        nextBolt = 720 + Math.floor(Math.random() * 480); // a strike every 12-20 s
        const x = Math.random() < 0.7 && trees.length ? trees[(Math.random() * trees.length) | 0] : Math.floor(Math.random() * grid.w);
        let y = 0; // strike: from the sky down to the first solid thing
        while (y < grid.h - 1) { const u = grid.type[y * grid.w + x]; if (u !== 0 && KIND[u] !== Kind.GAS && u !== EL.WATER) break; y++; }
        let jx = x;
        for (let yy = 0; yy < y; yy++) {
          if (yy % 6 === 0) jx = x + Math.round((Math.random() - 0.5) * 4);
          if (ps) ps.spawn(jx, yy, 0, 0, EL.ICE, { ghost: true, gravity: 0, life: 6 });
        }
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const X = x + dx, Y = y + dy;
          if (!grid.inBounds(X, Y)) continue;
          const i = Y * grid.w + X;
          if (grid.type[i] === 0) { if (Math.random() < 0.5) grid.set(X, Y, EL.FIRE); } else grid.temp[i] += 500;
        }
        for (const p of env.players || []) if (!p.dead && Math.abs(p.x + 2.5 - x) < 7 && p.y + 18 >= y - 30) p.damage(25);
        if (env.fx) { env.fx.flash(4); env.fx.shake(5); }
        emit('thunder', x);
      };
      return { spawns: spread(g, [0.08, 0.32, 0.68, 0.92]), tick };
    },
  },
  {
    id: 'desert',
    name: 'Desert Ruins',
    // Big dunes over a buried stone temple (chambers, corridors, a glass relic), broken pillars,
    // cacti, quicksand mud pits and an oasis. Every ~25 s a sandstorm blows across the map.
    build(g) {
      const n1 = noise(61, 90), n2 = noise(62, 25), r = rng(63);
      for (let x = 0; x < g.w; x++) column(g, x, 168 + n1(x) * 16 + n2(x) * 4, EL.SAND, 14, 18);
      // Buried temple: a stone block with carved rooms and corridors, an entrance shaft.
      const tx = Math.floor(g.w * 0.3), ty = 188;
      rect(g, tx, ty - 18, tx + 120, ty + 20, EL.STONE);
      for (const [x0, w] of [[6, 24], [38, 40], [86, 28]]) rect(g, tx + x0, ty - 12, tx + x0 + w, ty + 4, 0); // rooms
      rect(g, tx + 6, ty - 2, tx + 114, ty + 4, 0); // corridor
      rect(g, tx + 52, ty - 40, tx + 58, ty - 12, 0); // entrance shaft through the sand
      for (let y = ty - 40; y < ty - 18; y++) { put(g, tx + 51, y, EL.STONE); put(g, tx + 58, y, EL.STONE); }
      disc(g, tx + 64, ty - 6, 3, EL.GLASS); // relic
      for (let k = 0; k < 4; k++) rect(g, tx + 40 + k * 10, ty - 12, tx + 42 + k * 10, ty + 4, EL.STONE); // columns
      for (let k = 0; k < 8; k++) { // broken pillars above ground
        const x = Math.floor(20 + r() * (g.w - 40)), h = 10 + r() * 22, gy = surfaceAt(g, x);
        rect(g, x, gy - h, x + 4, gy, EL.STONE);
        if (r() < 0.5) rect(g, x - 3, gy - h - 2, x + 7, gy - h, EL.STONE);
      }
      for (let k = 0; k < 9; k++) { // cacti
        const x = Math.floor(10 + r() * (g.w - 20)), gy = surfaceAt(g, x), h = 6 + r() * 8;
        rect(g, x, gy - h, x + 2, gy, EL.PLANT);
        rect(g, x - 3, gy - h * 0.6, x, gy - h * 0.6 + 1, EL.PLANT); rect(g, x - 3, gy - h * 0.6 - 3, x - 2, gy - h * 0.6, EL.PLANT);
      }
      for (const f of [0.15, 0.8]) { // quicksand
        const x0 = Math.floor(g.w * f), gy = surfaceAt(g, x0 + 10);
        for (let x = x0; x < x0 + 22; x++) for (let y = gy; y < gy + 6; y++) put(g, x, y, EL.MUD);
      }
      const ox = Math.floor(g.w * 0.62); // oasis
      for (let x = ox - 18; x < ox + 18; x++) {
        const gy = surfaceAt(g, x), d = 8 * Math.cos(((x - ox) / 18) * (Math.PI / 2));
        for (let y = gy; y < gy + d; y++) clear(g, x, y);
      }
      fill(g, ox - 18, ox + 18, surfaceAt(g, ox - 18) + 1);
      tree(g, ox - 22, surfaceAt(g, ox - 22), 12, 4);
      tree(g, ox + 20, surfaceAt(g, ox + 20), 15, 4);

      let next = 1100, storm = 0, dir = 1;
      const tick = (grid, ps) => {
        if (--next <= 0) { storm = 300; next = 1500 + Math.floor(Math.random() * 300); dir = Math.random() < 0.5 ? -1 : 1; }
        if (storm <= 0) return;
        storm--;
        for (let y = 60; y < grid.h; y += 16) for (let x = 0; x < grid.w; x += 40) { // steady gale, capped
          if (Math.abs(grid.windAt(x, y)[0]) < 1.6) grid.addWind(x, y, 14, dir * 0.5, 0);
        }
        for (let k = 0; k < 3 && ps; k++) { // sand ripped off the dune tops
          const x = Math.floor(Math.random() * grid.w), y = surfaceAt(grid, x);
          if (grid.type[y * grid.w + x] === EL.SAND) ps.lift(x, y, dir * 3, -1.5, { bounces: 1, dmg: 0 });
        }
      };
      return { spawns: spread(g, [0.06, 0.38, 0.52, 0.94]), tick };
    },
  },
  {
    id: 'glacier',
    name: 'Glacier Peaks',
    // Ice mountains on stone, a frozen lake (an ice crust over cold water), ice caves hung with
    // icicles. Every 8-14 s, icicles break off and rain down - they hurt.
    build(g) {
      const n1 = noise(81, 70), n2 = noise(82, 14), r = rng(83);
      const lakeL = g.w * 0.38, lakeR = g.w * 0.62;
      for (let x = 0; x < g.w; x++) {
        let top = 150 + n1(x) * 35 + n2(x) * 5;
        // Blend smoothly down into the lake basin (no cliff-walled pit).
        const m = 40, w = x < lakeL - m || x > lakeR + m ? 0 : x < lakeL ? (x - lakeL + m) / m : x > lakeR ? (lakeR + m - x) / m : 1;
        const basin = 182 + Math.sin(Math.max(0, Math.min(1, (x - lakeL) / (lakeR - lakeL))) * Math.PI) * 20;
        top = top * (1 - w * w * (3 - 2 * w)) + basin * (w * w * (3 - 2 * w));
        for (let y = Math.max(0, Math.floor(top)); y < g.h; y++) put(g, x, y, y - top < 8 ? EL.ICE : EL.STONE);
      }
      fill(g, lakeL, lakeR, 186);
      for (let x = Math.floor(lakeL); x < lakeR; x++) for (let y = 186; y < 189; y++) if (g.type[y * g.w + x] === EL.WATER) put(g, x, y, EL.ICE); // ice crust
      const ceilings = [];
      for (const cx of [g.w * 0.15, g.w * 0.85]) { // ice caves with icicles
        worm(g, r, cx, 185, 110, 4, 170, 205);
        for (let x = Math.floor(cx - 40); x < cx + 40; x += 3 + Math.floor(r() * 4)) {
          for (let y = 160; y < 210; y++) {
            if (g.type[y * g.w + x] !== 0 && typeAt(g, x, y + 1) === 0) { icicle(g, x, y + 1, 3 + r() * 5); ceilings.push([x, y + 1]); break; }
          }
        }
      }
      for (let i = 0; i < g.w * g.h; i++) { const t = g.type[i]; if (t === EL.ICE) g.temp[i] = -40; else if (t === EL.WATER) g.temp[i] = 2; else if (t) g.temp[i] = -30; } // frozen world

      let next = 500;
      const tick = (grid, ps) => {
        for (let k = 0; k < 300; k++) { // the cold keeps the glacier frozen (fire can still melt it)
          const i = (Math.random() * grid.w * grid.h) | 0;
          if ((grid.type[i] === EL.ICE || grid.type[i] === EL.STONE) && grid.temp[i] < 100) grid.temp[i] = Math.min(grid.temp[i], -30);
        }
        if (--next > 0 || !ps) return;
        next = 480 + Math.floor(Math.random() * 360);
        for (let k = 0; k < 14; k++) { // icicles break off the sky / cave ceilings and fall
          const fromCave = k % 2 === 0 && ceilings.length;
          const [x, y] = fromCave ? ceilings[(Math.random() * ceilings.length) | 0] : [Math.random() * grid.w, 0];
          for (let s = 0; s < 3; s++) ps.spawn(x, y + s, 0, 3.5 + Math.random(), EL.ICE, { gravity: 0.12, dmg: 1 });
        }
      };
      return { spawns: spread(g, [0.08, 0.32, 0.68, 0.92]), tick };
    },
  },
];

// Wipe the world and build a map. Returns { spawns: [x, x, x, x], tick?: fn(grid, particles, t, env) }.
export function loadMap(grid, particles, map) {
  grid.clear();
  if (particles) particles.clear();
  const r = map.build(grid);
  return Array.isArray(r) ? { spawns: r } : r;
}
