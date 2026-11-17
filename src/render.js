// Grid -> pixels. Normal view (with heat glow, fire flicker, wind tint) or heat-map view.
import { EL, PALETTE, SHADES, IGNITE_T, pack } from './elements.js';
import { FIELD } from './grid.js';
import { BENDER_TYPES, BW, BH, MAX_HP } from './benders.js';
import { MAX_ENERGY } from './abilities.js';
import { drawSprite } from './sprite.js';
import { juice } from './juice.js';

const BG = PALETTE[0];
const WIND_TINT = pack('#9fd4ff');
const AFTERIMAGE = pack('#cfe8ff');

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
  const { w, h } = grid;
  const ctx = canvas.getContext('2d');
  const worldCanvas = document.createElement('canvas');
  worldCanvas.width = w;
  worldCanvas.height = h;
  const wctx = worldCanvas.getContext('2d');
  const img = wctx.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);
  let view = { x: 0, y: 0, w, h };

  // Camera rectangle in world cells (x, y integers). Resizes the visible canvas to match.
  function setView(v) {
    view = v;
    if (canvas.width !== v.w || canvas.height !== v.h) { canvas.width = v.w; canvas.height = v.h; }
  }

  function draw(heatView) {
    const { type, shade, temp, life, vx, vy, fw, backdrop } = grid;
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
  function drawPlayer(p) {
    if (p.dead) return;
    if (p.y + BH < 0 && p.color) { // above the top of the map: a pointer in their color at the edge
      if (!tagColors.has(p.color)) tagColors.set(p.color, pack(p.color));
      const tc = tagColors.get(p.color), x = Math.round(p.x + BW / 2);
      for (let r = 0; r < 4; r++) for (let k = -r; k <= r; k++) px(x + k, 1 + r, tc);
      for (let k = -4; k <= 4; k++) px(x + k, 5, DARK);
    }
    if (p.invulnT > 0 && p.invulnT < 80 && (p.invulnT >> 2) % 2) return; // spawn protection blink
    // Air step afterimages: the pose at each earlier tick, in pale wind color, fading out.
    for (const ai of p.afterimages || []) {
      const c = blend(BG, AFTERIMAGE, Math.min(0.8, ai.life / 10));
      const pal = { H: c, S: c, E: c, B: c, T: c, L: c, C: c, F: c, D: c, K: c, Z: c, G: c };
      drawSprite({ x: ai.x, y: ai.y, facing: ai.facing, def: p.def, anim: { j: ai.j, n: 0, blink: 0, state: 'dash' } }, px, pal, false, WHITE);
    }
    const flash = p.flash > 0 && p.flash % 2 === 0;
    let pal = PLAYER_PALETTES[p.type];
    if (p.frozenT > 0) { // frozen solid: the whole body is ice
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
    for (let k = -1; k <= len; k++) { px(hx + k, by - 4, DARK); px(hx + k, by - 3, DARK); }
    if (p.color) { // player / team color tag above the bars
      if (!tagColors.has(p.color)) tagColors.set(p.color, pack(p.color));
      const tc = tagColors.get(p.color);
      for (let k = 1; k < len - 1; k++) px(hx + k, by - 6, tc);
      px(hx + (len >> 1), by - 5, tc);
      if (p.tag) drawTag(hx + len / 2, by - 13, p.tag, p.color);
    }
    bar(hx, by - 4, len, p.hp / MAX_HP, HP_ON);
    bar(hx, by - 3, len, p.energy / MAX_ENERGY, ENERGY_ON);
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

  function present(players, particles, labels = null, owners = null) {
    if (particles) drawParticles(particles);
    const list = players ? (Array.isArray(players) ? players : [players]) : [];
    for (const p of list) drawPlayer(p);
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
