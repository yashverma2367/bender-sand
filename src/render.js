// Grid -> pixels. Normal view (with heat glow, fire flicker, wind tint) or heat-map view.
import { EL, PALETTE, SHADES, IGNITE_T, STRENGTH, pack } from './elements.js';
import { FIELD } from './grid.js';
import { BENDER_TYPES, BW, BH, MAX_HP } from './benders.js';
import { drawSprite } from './sprite.js';
import { juice } from './juice.js';
import { bursts, hasJetMaterial, JET_ANGLE, JET_SPREAD } from './physics.js';

const BG = PALETTE[0];
const CRACK_C = pack('#1c1714'); // fracture lines on damaged walls
const WIND_TINT = pack('#9fd4ff');
const DBG_AIR = pack('#0c0d12'), DBG_SOLID = pack('#4a4f63'), PRESS_HI = pack('#ff3b3b'), PRESS_LO = pack('#3b6cff');
const WIND_COLS = ['#7fd8ff', '#9ff0c8', '#e8f070', '#ffb340', '#ff6a3a'].map(pack); // calm breeze -> blast
const AFTERIMAGE = pack('#cfe8ff');
const WATER_IMG = pack('#3a7fe6');

// Blend two packed ABGR colors. f = 0 gives a, f = 1 gives b.
function blend(a, b, f) {
  const ar = a & 255, ag = (a >>> 8) & 255, ab = (a >>> 16) & 255;
  const r = ar + (((b & 255) - ar) * f) | 0;
  const g = ag + ((((b >>> 8) & 255) - ag) * f) | 0;
  const bl = ab + ((((b >>> 16) & 255) - ab) * f) | 0;
  return ((255 << 24) | (bl << 16) | (g << 8) | r) >>> 0;
}

// Sample a list of [position 0..1, hex] stops into n packed colors.
function gradient(stops, n) {
  const out = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    const p = k / (n - 1);
    let s = 0;
    while (s < stops.length - 2 && p > stops[s + 1][0]) s++;
    const [p0, c0] = stops[s], [p1, c1] = stops[s + 1];
    out[k] = blend(pack(c0), pack(c1), Math.min(1, Math.max(0, (p - p0) / (p1 - p0))));
  }
  return out;
}

// Incandescence: dark red -> orange -> yellow-white.
const GLOW = gradient([[0, '#4a0a00'], [0.3, '#b31b00'], [0.6, '#ff5a00'], [0.85, '#ffa31a'], [1, '#ffe680']], 64);

// Heat view: -60 blue, 20 dark, 1300 white-hot.
const HEAT_MIN = -60, HEAT_MAX = 1300;
const heatPos = (t) => (t - HEAT_MIN) / (HEAT_MAX - HEAT_MIN);
const HEAT = gradient([
  [0, '#3b6cff'], [heatPos(0), '#1c2a55'], [heatPos(20), '#14151c'], [heatPos(100), '#5a1a1a'],
  [heatPos(400), '#c2300e'], [heatPos(800), '#ff8a1a'], [1, '#fff3b0'],
], 256);

// Everything (sand grid, particles, player) is drawn at 1 pixel per cell into an offscreen
// world-sized canvas; only the camera's view rectangle is drawn each frame and copied to the
// visible canvas, which CSS scales up.
export function createRenderer(grid, canvas) {
  let { w, h } = grid;
  const ctx = canvas.getContext('2d');
  const worldCanvas = document.createElement('canvas');
  worldCanvas.width = w;
  worldCanvas.height = h;
  const wctx = worldCanvas.getContext('2d');
  let img = wctx.createImageData(w, h);
  let buf = new Uint32Array(img.data.buffer);
  let view = { x: 0, y: 0, w, h };
  function fitWorld() { // maps come in different sizes: follow the grid
    if (grid.w === w && grid.h === h) return;
    w = grid.w; h = grid.h;
    worldCanvas.width = w; worldCanvas.height = h;
    img = wctx.createImageData(w, h); buf = new Uint32Array(img.data.buffer);
  }

  // Camera rectangle in world cells (x, y integers). Resizes the visible canvas to match.
  function setView(v) {
    view = v;
    if (canvas.width !== v.w || canvas.height !== v.h) { canvas.width = v.w; canvas.height = v.h; }
  }

  // heatView: the sandbox heat map. debug: the P view (heat colors for everything, air pressure
  // tinted red/blue, wind arrows drawn on top in present()).
  let debugOn = false;
  function draw(heatView, debug = false) {
    fitWorld();
    debugOn = debug;
    const rho = grid.rho;
    const { type, shade, temp, life, vx, vy, fw, backdrop, crack } = grid;
    const x0 = Math.max(0, view.x), x1 = Math.min(w, view.x + view.w + 1);
    const y0 = Math.max(0, view.y), y1 = Math.min(h, view.y + view.h + 1);
    for (let y = y0; y < y1; y++) {
      const frow = ((y / FIELD) | 0) * fw;
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const t = type[i];

        if (heatView) {
          buf[i] = t === 0 ? BG : HEAT[Math.max(0, Math.min(255, (heatPos(temp[i]) * 255) | 0))];
          continue;
        }
        if (debug) {
          if (t === 0) { // air: dark, tinted by pressure (red = compressed, blue = vacuum)
            const pr = rho ? rho[frow + ((x / FIELD) | 0)] : 0;
            buf[i] = pr > 0.15 ? blend(DBG_AIR, PRESS_HI, Math.min(0.75, pr * 0.18)) : pr < -0.15 ? blend(DBG_AIR, PRESS_LO, Math.min(0.75, -pr * 0.18)) : DBG_AIR;
          } else { // everything solid / liquid / gas by temperature (online guests only know hot things)
            let T = temp[i];
            if (t === EL.FIRE) T = Math.max(T, 800); else if (t === EL.LAVA) T = Math.max(T, 1200); else if (life[i] && IGNITE_T[t] !== Infinity) T = Math.max(T, 600);
            const c = HEAT[Math.max(0, Math.min(255, (heatPos(T) * 255) | 0))];
            buf[i] = T > 60 || T < 0 ? c : blend(c, DBG_SOLID, 0.55); // room-temperature stuff stays readable as gray
          }
          continue;
        }

        if (t === 0) { // empty: the map's painted backdrop (sky, skyline, interiors), tinted by wind
          const f = frow + ((x / FIELD) | 0);
          const m = Math.abs(vx[f]) + Math.abs(vy[f]);
          const bg = backdrop ? backdrop[i] : BG;
          buf[i] = m > 0.2 ? blend(bg, WIND_TINT, Math.min(0.3, m * 0.06)) : bg;
          continue;
        }

        let c = PALETTE[t * SHADES + shade[i]];
        const T = temp[i];

        if (t === EL.FIRE) {
          const L = life[i];
          let s = L > 30 ? 0 : L > 15 ? 1 : L > 6 ? 2 : 3;
          if (Math.random() < 0.3 && s < 3) s++;
          c = PALETTE[t * SHADES + s];
        } else if (t === EL.SMOKE) {
          c = blend(backdrop ? backdrop[i] : BG, c, Math.min(1, life[i] / 50));
        } else if (t === EL.WATER || t === EL.LAVA) {
          if (Math.random() < 0.01) shade[i] = (Math.random() * SHADES) | 0; // shimmer
          if (t === EL.LAVA) {
            const g = Math.max(0, Math.min(1, (T - 500) / 800));
            c = blend(c, GLOW[(g * 63) | 0], 0.8);
          }
        } else if (IGNITE_T[t] !== Infinity && life[i] > 0) {
          c = blend(c, GLOW[40 + ((Math.random() * 20) | 0)], 0.6); // burning ember
        } else if (T > 350) {
          const g = Math.min(1, (T - 350) / 900);
          c = blend(c, GLOW[(g * 63) | 0], g * 0.9);
        }
        const ck = crack[i];
        if (ck > 12 && t !== EL.FIRE) { // cracked: dark fracture lines that spread as damage builds
          const hsh = (x * 73856093 ^ y * 19349663) >>> 0, lvl = ck / STRENGTH[t];
          if ((hsh % 997) / 997 < lvl * 0.55) c = blend(c, CRACK_C, 0.75);
          else c = blend(c, CRACK_C, lvl * 0.18);
        }
        buf[i] = c;
      }
    }
  }

  // Lighten the cells on the brush ring.
  function drawBrush(cx, cy, r) {
    const outer = r * r + r * 0.5;
    const inner = r > 0 ? (r - 1) * (r - 1) + (r - 1) * 0.5 : -1;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > outer || d2 <= inner) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        const i = y * w + x;
        buf[i] = (((buf[i] >>> 1) & 0x7f7f7f7f) + 0x80808080) >>> 0; // halfway to white
      }
    }
  }

  const dark = (c) => blend(c, 0xff000000, 0.3);
  const PLAYER_PALETTES = {};
  for (const [id, d] of Object.entries(BENDER_TYPES)) {
    const pal = Object.fromEntries(Object.entries(d.palette).map(([k, v]) => [k, pack(v)]));
    pal.D = dark(pal.B); // far upper arm
    pal.K = dark(pal.L); // far leg
    pal.Z = dark(pal.S); // far forearm / hand
    pal.G = dark(pal.F); // far boot
    PLAYER_PALETTES[id] = pal;
  }
  const ENERGY_ON = pack('#f0a030'), ULT_ON = pack('#c070ff');
  const WHITE = pack('#ffffff'), HP_ON = pack('#4cd964'), HP_OFF = pack('#5a1a1a'), AIR_ON = pack('#7fc8ff'), DARK = pack('#000000');

  function px(x, y, c) {
    if (x >= 0 && x < w && y >= 0 && y < h) buf[y * w + x] = c;
  }

  function bar(x, y, len, frac, on) {
    const filled = Math.ceil(len * Math.max(0, frac));
    for (let k = 0; k < len; k++) px(x + k, y, k < filled ? on : HP_OFF);
  }

  const tagColors = new Map(); // css color -> packed
  // A knocked-out body tumbling: the falling pose, rotated about its center.
  function drawRag(p) {
    const r = p.rag, cx = r.x + BW / 2, cy = r.y + BH / 2, ca = Math.cos(r.a), sa = Math.sin(r.a);
    const rot = (x, y, c) => { const dx = x + 0.5 - cx, dy = y + 0.5 - cy; px(Math.floor(cx + dx * ca - dy * sa), Math.floor(cy + dx * sa + dy * ca), c); };
    const body = { x: r.x, y: r.y, facing: p.facing, def: p.def, type: p.type, anim: { ...(p.anim || {}), state: 'fall', blink: 1 } };
    drawSprite(body, rot, PLAYER_PALETTES[p.type], false, WHITE);
  }

  function drawPlayer(p) {
    if (p.dead) { if (p.rag && p.anim) drawRag(p); return; }
    if (p.y + BH < 0 && p.color) { // above the top of the map: a pointer in their color at the edge
      if (!tagColors.has(p.color)) tagColors.set(p.color, pack(p.color));
      const tc = tagColors.get(p.color), x = Math.round(p.x + BW / 2);
      for (let r = 0; r < 4; r++) for (let k = -r; k <= r; k++) px(x + k, 1 + r, tc);
      for (let k = -4; k <= 4; k++) px(x + k, 5, DARK);
    }
    if (p.invulnT > 0 && p.invulnT < 80 && (p.invulnT >> 2) % 2) return; // spawn protection blink
    // Air step afterimages: the pose at each earlier tick, in pale wind color, fading out.
    for (const ai of p.afterimages || []) {
      const c = blend(BG, ai.water ? WATER_IMG : AFTERIMAGE, Math.min(0.8, ai.life / 10));
      const pal = { H: c, S: c, E: c, B: c, T: c, L: c, C: c, F: c, D: c, K: c, Z: c, G: c };
      drawSprite({ x: ai.x, y: ai.y, facing: ai.facing, def: p.def, anim: { j: ai.j, n: 0, blink: 0, state: 'dash' } }, px, pal, false, WHITE);
    }
    const flash = p.flash > 0 && p.flash % 2 === 0;
    let pal = PLAYER_PALETTES[p.type];
    if (p.waterFormT > 0) { // water form: a body of rippling water
      const w = (k) => PALETTE[EL.WATER * SHADES + ((k + (Math.random() * 2) | 0) & 3)];
      pal = { H: w(0), S: w(1), E: PALETTE[EL.ICE * SHADES], B: w(2), T: w(1), L: w(3), C: w(0), F: w(2), D: w(3), K: w(1), Z: w(0), G: w(2) };
    } else if (p.frozenT > 0) { // frozen solid: the whole body is ice
      const ice = PALETTE[EL.ICE * SHADES], ice2 = PALETTE[EL.ICE * SHADES + 2];
      pal = { H: ice, S: ice, E: ice2, B: ice2, T: ice, L: ice2, C: ice, F: ice2, D: ice2, K: ice2, Z: ice, G: ice2 };
    } else if (p.flameHair) { // ascended: hair and scarf become living fire
      const fire = PALETTE[EL.FIRE * SHADES + ((Math.random() * 3) | 0)];
      pal = { ...pal, H: fire, C: PALETTE[EL.FIRE * SHADES + ((Math.random() * 3) | 0)] };
    }
    if (p.color) { // a 1-px outline in the player's color around the whole body
      if (!tagColors.has(p.color)) tagColors.set(p.color, pack(p.color));
      const oc = tagColors.get(p.color), drawn = new Set();
      drawSprite(p, (x, y, c) => { if (x >= 0 && x < w && y >= 0 && y < h) { buf[y * w + x] = c; drawn.add(y * w + x); } }, pal, flash, WHITE);
      for (const i of drawn) {
        const x = i % w;
        for (const j of [i - 1, i + 1, i - w, i + w]) {
          if (j < 0 || j >= w * h || drawn.has(j) || Math.abs((j % w) - x) > 1) continue;
          buf[j] = blend(buf[j], oc, 0.85);
        }
      }
    } else drawSprite(p, px, pal, flash, WHITE);
    // HP bar (and air bar while holding breath) above the head.
    const bx = Math.floor(p.x), by = Math.floor(p.y);
    const hx = bx - 2, len = BW + 4;
    for (let k = -1; k <= len; k++) px(hx + k, by - 4, DARK);
    if (p.color) { // player / team color tag above the bars
      if (!tagColors.has(p.color)) tagColors.set(p.color, pack(p.color));
      const tc = tagColors.get(p.color);
      for (let k = 1; k < len - 1; k++) px(hx + k, by - 6, tc);
      px(hx + (len >> 1), by - 5, tc);
      if (p.tag) drawTag(hx + len / 2, by - 13, p.tag, p.color);
    }
    bar(hx, by - 4, len, p.hp / MAX_HP, HP_ON);
    if (p.ult >= 100) px(hx + len, by - 4, (p.anim.t >> 3) & 1 ? ULT_ON : WHITE); // ultimate ready
    if (p.air < p.def.breath) bar(hx, by - 6, len, p.air / p.def.breath, AIR_ON);
  }

  // Flying particles: one pixel each in their element color, plus a dim trail pixel when fast.
  function drawParticles(ps) {
    for (let i = 0; i < ps.n; i++) {
      const t = ps.type[i];
      const x = Math.floor(ps.x[i]), y = Math.floor(ps.y[i]);
      // Fire flickers; ghost fire (torrent core / cone) skews bright yellow-white.
      const shade = t === EL.FIRE ? (ps.ghost[i] ? (Math.random() * 2.6) | 0 : (Math.random() * SHADES) | 0)
        : t === EL.LAVA ? (Math.random() * SHADES) | 0 : ps.shade[i];
      const c = PALETTE[t * SHADES + shade];
      // Trail: longer for faster particles (up to 8 px), fading out behind.
      const vx = ps.vx[i], vy = ps.vy[i], sp = Math.hypot(vx, vy);
      const len = Math.min(8, Math.floor(sp * 0.9));
      for (let k = 1; k <= len; k++) {
        const tx = Math.floor(ps.x[i] - (vx / sp) * k), ty = Math.floor(ps.y[i] - (vy / sp) * k);
        if (tx >= 0 && tx < w && ty >= 0 && ty < h) buf[ty * w + tx] = blend(buf[ty * w + tx], c, 0.75 * (1 - k / (len + 1)));
      }
      px(x, y, c);
    }
  }

  // Particles and player are drawn into the same pixel buffer as the world
  // (player skipped with null, e.g. heat view).
  // 3x5 pixel digits for damage numbers (rows top to bottom, 3 bits each).
  const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
    '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
  // "P1".."P4" over a player's head, in their color with a dark outline.
  const GLYPH_P = '110101110100100';
  function drawTag(cx, y, n, color) {
    const c = tagColors.get(color), x0 = Math.round(cx - 3.5), y0 = Math.round(y);
    for (const [g, ox] of [[GLYPH_P, 0], [DIGITS[n], 4]]) for (let r = 0; r < 5; r++) for (let cc = 0; cc < 3; cc++) {
      const X = x0 + ox + cc, Y = y0 + r;
      if (g[r * 3 + cc] === '1') px(X, Y, c);
      else if (X >= 0 && X < w && Y >= 0 && Y < h) buf[Y * w + X] = blend(buf[Y * w + X], DARK, 0.55);
    }
  }
  function drawPopups() {
    for (const q of juice.popups) drawDigits(q.x, q.y, q.text, q.color, Math.min(1, q.life / 15));
  }
  // Pixel digits centered on x, with a dark outline when fully opaque.
  function drawDigits(x, y, text, color, fade = 1) {
    {
      if (!tagColors.has(color)) tagColors.set(color, pack(color));
      const c = tagColors.get(color);
      const col = fade < 1 ? blend(BG, c, fade) : c;
      const s = text, x0 = Math.round(x - (s.length * 4 - 1) / 2), y0 = Math.round(y);
      for (let k = 0; k < s.length; k++) {
        const d = DIGITS[+s[k]];
        if (!d) continue;
        for (let r = 0; r < 5; r++) for (let cc = 0; cc < 3; cc++) {
          const X = x0 + k * 4 + cc, Y = y0 + r;
          if (d[r * 3 + cc] === '1') px(X, Y, col);
          else if (fade >= 1) { // dark outline so numbers read over anything
            const i = Y * w + X;
            if (X >= 0 && X < w && Y >= 0 && Y < h) buf[i] = blend(buf[i], DARK, 0.5);
          }
        }
      }
    }
  }

  // Zoomed camera: a small arrow at the screen edge pointing at each player outside the view.
  function drawEdgeArrows(list) {
    if (view.w >= w && view.h >= h) return;
    for (const p of list) {
      if (p.dead || !p.color) continue;
      const cx = p.x + BW / 2, cy = p.y + BH / 2;
      if (cx >= view.x && cx < view.x + view.w && cy >= view.y && cy < view.y + view.h) continue;
      if (!tagColors.has(p.color)) tagColors.set(p.color, pack(p.color));
      const tc = tagColors.get(p.color);
      const vx0 = view.x + 4, vx1 = view.x + view.w - 5, vy0 = view.y + 4, vy1 = view.y + view.h - 5;
      const ax = Math.max(vx0, Math.min(vx1, cx)), ay = Math.max(vy0, Math.min(vy1, cy));
      const dx = Math.sign(cx - ax), dy = Math.sign(cy - ay);
      for (let r = 0; r < 4; r++) for (let k = -r; k <= r; k++) { // triangle pointing out of the screen
        const X = Math.round(ax + (dx ? dx * (r - 3) : k)), Y = Math.round(ay + (dy ? dy * (r - 3) : (dx ? k : 0)));
        px(X, Y, tc);
      }
    }
  }

  // Clash Lab: each attack's power above it, in its element's color.
  const EL_COLOR = { fire: '#ff7a2a', water: '#4ea8ff', earth: '#d8b070', air: '#e6f4ff', ice: '#bfefff', lava: '#ff4a1a', lightning: '#f5f07a' };
  function drawAttackLabels(list) {
    for (const e of list) {
      if (e.dead) continue;
      const color = EL_COLOR[e.el] || '#ffffff';
      drawDigits(e.x2 !== undefined ? (e.x + e.x2) / 2 : e.x, (e.x2 !== undefined ? Math.min(e.y, e.y2) : e.y) - e.r - 8, String(Math.round(e.pow)), color);
    }
  }

  // Who threw what: a small diamond in the thrower's color riding on each live attack.
  function drawOwnerMarks(entries, list) {
    if (!entries || list.length < 2) return;
    const byId = new Map(list.map((p) => [p.id, p]));
    for (const e of entries) {
      const o = byId.get(e.owner);
      if (e.dead || !o || !o.color) continue;
      if (!tagColors.has(o.color)) tagColors.set(o.color, pack(o.color));
      const c = tagColors.get(o.color);
      const x = Math.round(e.x2 !== undefined ? (e.x + e.x2) / 2 : e.x), y = Math.round((e.x2 !== undefined ? Math.min(e.y, e.y2) : e.y) - (e.r || 3) - 3);
      for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) px(x + dx, y + dy, DARK);
      px(x, y, c);
      for (const [dx, dy] of [[0, -2], [-2, 0], [2, 0], [0, 2], [-1, -1], [1, -1], [-1, 1], [1, 1]]) px(x + dx, y + dy, c);
    }
  }

  // ---------- clash bursts: additive light ----------
  // Light adds onto what's already drawn (so it glows instead of covering).
  function addLight(x, y, r, g, b, a) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < view.x || x >= view.x + view.w || y < view.y || y >= view.y + view.h || a <= 0) return;
    const k = y * w + x, p = buf[k];
    const R = Math.min(255, (p & 255) + r * a), G = Math.min(255, ((p >> 8) & 255) + g * a), B = Math.min(255, ((p >> 16) & 255) + b * a);
    buf[k] = (255 << 24 | B << 16 | G << 8 | R) >>> 0;
  }
  // A soft disc of light (for strokes): stamped along a path.
  function blob(x, y, rad, col, a) {
    const R = Math.max(0.5, rad);
    for (let dy = -Math.ceil(R); dy <= R; dy++) for (let dx = -Math.ceil(R); dx <= R; dx++) {
      const d = Math.hypot(dx, dy) / (R + 0.5);
      if (d > 1) continue;
      const f = a * (1 - d * d);
      addLight(x + dx, y + dy, col[0], col[1], col[2], f);
    }
  }
  const WHITE3 = [255, 255, 255];
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  // Deterministic randoms per (burst seed, a, b): the host and online guests draw the same thing.
  function hrnd(seed, a, b) { let h = (seed ^ Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663)) >>> 0; return () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 4294967296); }
  function streak(x0, y0, x1, y1, col, a, w0, w1) { // tapered additive stroke
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let k = 0; k <= n; k++) { const t = k / n; blob(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w0 + (w1 - w0) * t, col, a); }
  }
  function drawBursts() {
    for (const b of bursts) {
      const t = b.t, s = b.s, active = b.rel < 0, since = active ? -1 : t - b.rel, endT = active ? t : b.rel;
      const A = [b.ax, b.ay]; let U = [-b.ay, b.ax]; if (U[1] > 0) U = [-U[0], -U[1]]; // along the clash / "up" across it
      // the clash ball: small and white-hot on impact, each half rimmed in its side's color. When it
      // throws particles (the gush on contact, and the release) it pops out quickly to a little
      // more than its impact size, then settles back / fades.
      if (active || since < 8) {
        const R0 = 2 + 3 * s;                                                    // impact size
        const pop = (tt) => (tt >= 0 && tt < 6 ? Math.sin((tt / 6) * Math.PI) * 0.4 : 0); // quick swell and back
        const grow = active ? 1 + pop(t) : 1 + 0.4 * Math.min(1, since / 2.5);  // contact pop / release swell
        const fade = active ? 1 : 1 - since / 8;
        const R = R0 * grow * (1 + 0.06 * Math.sin(t * 0.9)), RR = Math.ceil(R * 1.6);
        for (let dy = -RR; dy <= RR; dy++) for (let dx = -RR; dx <= RR; dx++) {
          const d = Math.hypot(dx, dy) / R; if (d > 1.6) continue;
          const c = d < 0.6 ? WHITE3 : mix3(WHITE3, dx * A[0] + dy * A[1] < 0 ? b.ca : b.cb, Math.min(1, (d - 0.6) * 1.3));
          addLight(b.x + dx, b.y + dy, c[0], c[1], c[2], fade * (d < 1 ? 1.15 : Math.pow(1 - (d - 1) / 0.6, 2) * 0.6));
        }
      }
      // > < jets: real particles for material elements (physics.js); attacks with no material
      // (air, lightning, sonic) get their jets drawn here as light
      const live = active || since < 8, jetEnd = active ? t : b.rel + 2;
      for (let e = Math.max(1, jetEnd - 26); e <= jetEnd; e++) {
        const n = e === 1 ? 10 : 4; // a burst on contact, then a steady stream
        for (let j = 0; j < n; j++) {
          const r = hrnd(b.seed, e, j), side = j & 1 ? 1 : -1, up = j & 2 ? 1 : -1;
          if (hasJetMaterial(side < 0 ? b.ea : b.eb)) continue;
          const ang = JET_ANGLE + (r() - 0.5) * JET_SPREAD;
          const sp = (2.6 + r() * 1.6) * (0.75 + 0.3 * s), life = 14 + r() * 8, age = t - e;
          if (age < 0 || age > life || !live && e > b.rel) continue;
          const k = age / life, va = side * Math.cos(ang) * sp, vu = up * Math.sin(ang) * sp;
          const vx = A[0] * va + U[0] * vu, vy = A[1] * va + U[1] * vu;
          const x = b.x + vx * age, y = b.y + vy * age, l = Math.hypot(vx, vy) || 1, len = 5 + sp * 3.5;
          const w = (1.1 + 1.1 * s) * (1 - k * 0.7);
          streak(x, y, x - (vx / l) * len, y - (vy / l) * len, mix3(WHITE3, side < 0 ? b.ca : b.cb, Math.min(1, k * 1.4 + 0.15)), 0.95 * (1 - k * 0.75), w, 0.1);
        }
      }
    }
  }

  // Hanging dust (grid.dust, one value per FIELD x FIELD cells): drawn over everything in the
  // world, so fighters can disappear into a cloud for a moment.
  const DUST = pack('#8a7f70');
  function drawDust() {
    const dust = grid.dust; if (!dust) return;
    const fw = grid.fw, i0 = Math.max(0, Math.floor(view.x / FIELD)), i1 = Math.min(fw - 1, Math.floor((view.x + view.w) / FIELD));
    const j0 = Math.max(0, Math.floor(view.y / FIELD)), j1 = Math.min(grid.fh - 1, Math.floor((view.y + view.h) / FIELD));
    const fh = grid.fh, at = (i, j) => dust[Math.min(fh - 1, Math.max(0, j)) * fw + Math.min(fw - 1, Math.max(0, i))];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (at(i, j) < 0.02 && at(i + 1, j) < 0.02 && at(i, j + 1) < 0.02 && at(i + 1, j + 1) < 0.02) continue;
      // smooth: blend between the 4 surrounding field values (no blocky squares)
      const d00 = at(i, j), d10 = at(i + 1, j), d01 = at(i, j + 1), d11 = at(i + 1, j + 1);
      for (let y = j * FIELD + 2; y < j * FIELD + FIELD + 2 && y < h; y++) for (let x = i * FIELD + 2; x < i * FIELD + FIELD + 2 && x < w; x++) {
        const fx = (x - i * FIELD - 2) / FIELD, fy = (y - j * FIELD - 2) / FIELD;
        const d = (d00 * (1 - fx) + d10 * fx) * (1 - fy) + (d01 * (1 - fx) + d11 * fx) * fy;
        if (d < 0.02) continue;
        const k = y * w + x;
        buf[k] = blend(buf[k], DUST, Math.min(0.8, d * 0.6) * (0.88 + ((x * 7 + y * 13) % 5) * 0.03)); // a little grain
      }
    }
  }

  // Wind arrows: one per 2x2 air blocks (8 x 8 cells), from the block's middle along the flow,
  // longer and hotter-colored the stronger it blows, with a bright head.
  function drawWind() {
    const { vx, vy, fw, fh } = grid;
    const fx0 = Math.max(0, Math.floor(view.x / FIELD)), fx1 = Math.min(fw, Math.ceil((view.x + view.w) / FIELD));
    const fy0 = Math.max(0, Math.floor(view.y / FIELD)), fy1 = Math.min(fh, Math.ceil((view.y + view.h) / FIELD));
    for (let fy = fy0 - (fy0 & 1); fy < fy1; fy += 2) for (let fx = fx0 - (fx0 & 1); fx < fx1; fx += 2) {
      const f = fy * fw + fx, ux = vx[f], uy = vy[f], m = Math.hypot(ux, uy);
      if (m < 0.25) continue;
      const len = Math.min(9, 2 + m * 1.6), dx = ux / m, dy = uy / m;
      const cx = fx * FIELD + FIELD, cy = fy * FIELD + FIELD;
      const col = WIND_COLS[Math.min(WIND_COLS.length - 1, (m * 1.2) | 0)];
      for (let k = 0; k <= len; k++) {
        const X = Math.round(cx + dx * k), Y = Math.round(cy + dy * k);
        if (X >= 0 && X < w && Y >= 0 && Y < h) buf[Y * w + X] = k >= len - 1 ? WHITE : blend(buf[Y * w + X], col, 0.85);
      }
    }
  }

  function present(players, particles, labels = null, owners = null) {
    if (particles) drawParticles(particles);
    const list = players ? (Array.isArray(players) ? players : [players]) : [];
    for (const p of list) drawPlayer(p);
    if (debugOn) drawWind();
    drawDust();
    drawBursts();
    drawEdgeArrows(list);
    if (!labels) drawOwnerMarks(owners, list);
    drawPopups();
    if (labels) drawAttackLabels(labels); // Clash Lab power numbers, on top
    wctx.putImageData(img, 0, 0, view.x, view.y, view.w, view.h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(worldCanvas, view.x, view.y, view.w, view.h, 0, 0, view.w, view.h);
  }

  return { draw, drawBrush, present, setView };
}
