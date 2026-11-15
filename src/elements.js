// Element definitions + fast lookup tables indexed by element id.

export const Kind = { EMPTY: 0, STATIC: 1, POWDER: 2, LIQUID: 3, GAS: 4 };

export const EL = {
  EMPTY: 0, SAND: 1, EARTH: 2, STONE: 3, WATER: 4, STEAM: 5, FIRE: 6, SMOKE: 7,
  LAVA: 8, ICE: 9, WOOD: 10, PLANT: 11, MUD: 12, ASH: 13, GLASS: 14, OBSIDIAN: 15,
};

export const WIND_TOOL = 254; // brush that paints air force instead of cells
export const WALL = 255;      // returned by grid.get() for out-of-bounds cells
export const AMBIENT = 20;    // room temperature; empty air pulls cells toward this
export const BURN_T = 600;    // temperature a burning cell holds itself at
export const SHADES = 4;

export const GROUPS = ['Earth', 'Water', 'Fire', 'Nature', 'Air', 'Tools'];

// Fields (all optional except id/name/key/group/kind/colors):
//   density      heavier displaces lighter
//   slide        powder: chance per tick to roll diagonally
//   cohesive     powder: needs a 2-cell drop to slide -> steeper piles
//   dispersion   liquid/gas: max cells moved sideways per tick
//   viscosity    chance per tick to skip moving (thick stuff)
//   wind         how strongly the air field pushes it
//   temp         spawn temperature
//   holdTemp     temperature stays at `temp` every tick (fire)
//   cond         heat conductivity to touching cells (keep <= 0.25)
//   airLoss      fraction of heat lost per tick per exposed side
//   hot/cold     [threshold, becomes, chance per tick]
//   life         [min, max] ticks before dying into death[0] (chance death[1], else empty)
//   ignite       burnable: starts burning above this temperature
//   burn         [min, max] ticks it burns, then becomes ash (chance ash) else fire
export const ELEMENTS = [
  { id: EL.SAND, name: 'Sand', key: '1', group: 'Earth', kind: Kind.POWDER, density: 3, slide: 0.9, wind: 0.5,
    hot: [900, EL.GLASS, 0.01], colors: ['#e2c275', '#d9b45f', '#ebcf8a', '#cfa955'] },
  { id: EL.EARTH, name: 'Earth', key: '2', group: 'Earth', kind: Kind.POWDER, density: 3.2, slide: 0.5,
    cohesive: true, wind: 0.2, colors: ['#7a5230', '#6b4627', '#865c38', '#5e3d22'] },
  { id: EL.STONE, name: 'Stone', key: '3', group: 'Earth', kind: Kind.STATIC, density: 10, cond: 0.1,
    colors: ['#7d7f85', '#6e7076', '#8a8c91', '#63656a'] },
  { id: EL.MUD, name: 'Mud', key: 'r', group: 'Earth', kind: Kind.POWDER, density: 3.5, slide: 0.4,
    cohesive: true, viscosity: 0.6, wind: 0.05, cond: 0.1, hot: [60, EL.EARTH, 0.02],
    colors: ['#4a3322', '#523926', '#43301f', '#59402b'] },
  { id: EL.GLASS, name: 'Glass', key: 'y', group: 'Earth', kind: Kind.STATIC, density: 10, cond: 0.1,
    colors: ['#a8d8e0', '#b5e0e8', '#9ccfd8', '#c2e8ee'] },
  { id: EL.OBSIDIAN, name: 'Obsidian', key: 'u', group: 'Earth', kind: Kind.STATIC, density: 10,
    colors: ['#2a1f3a', '#241a33', '#30244a', '#1e1629'] },

  { id: EL.WATER, name: 'Water', key: '4', group: 'Water', kind: Kind.LIQUID, density: 2, dispersion: 5,
    wind: 0.6, cond: 0.15, airLoss: 0.002, hot: [100, EL.STEAM, 0.2], cold: [-2, EL.ICE, 0.05],
    colors: ['#2f6fd6', '#3577e0', '#2a66c9', '#3a7fe6'] },
  { id: EL.ICE, name: 'Ice', key: '5', group: 'Water', kind: Kind.STATIC, density: 10, temp: -50,
    cond: 0.1, airLoss: 0.0003, hot: [2, EL.WATER, 0.02],
    colors: ['#bfe6ff', '#cdeeff', '#b0dcf7', '#dcf4ff'] },
  { id: EL.STEAM, name: 'Steam', key: 'q', group: 'Water', kind: Kind.GAS, density: 0.1, dispersion: 2,
    wind: 1.2, temp: 110, airLoss: 0.003, cold: [90, EL.WATER, 0.01],
    colors: ['#c8d3dc', '#b9c6d1', '#d5dee6', '#aebcc8'] },

  { id: EL.FIRE, name: 'Fire', key: '6', group: 'Fire', kind: Kind.GAS, density: 0.05, dispersion: 1, viscosity: 0.5,
    wind: 1.5, temp: 800, holdTemp: true, cond: 0.1, life: [15, 45], death: [EL.SMOKE, 0.35],
    colors: ['#fff1a8', '#ffc23d', '#ff7a1a', '#d93a12'] },
  { id: EL.LAVA, name: 'Lava', key: '7', group: 'Fire', kind: Kind.LIQUID, density: 5, dispersion: 2,
    viscosity: 0.75, wind: 0.1, temp: 1200, airLoss: 0.0005, cold: [700, EL.STONE, 0.01],
    colors: ['#c2300e', '#b02a0c', '#d13a12', '#9e2409'] },
  { id: EL.SMOKE, name: 'Smoke', key: 'w', group: 'Fire', kind: Kind.GAS, density: 0.2, dispersion: 2,
    wind: 1.5, temp: 150, life: [60, 150], colors: ['#3d3d44', '#46464e', '#36363c', '#4f4f57'] },
  { id: EL.ASH, name: 'Ash', key: 't', group: 'Fire', kind: Kind.POWDER, density: 1.5, slide: 0.6, wind: 1,
    colors: ['#8a8784', '#7b7875', '#9a9794', '#6e6b68'] },

  { id: EL.WOOD, name: 'Wood', key: '8', group: 'Nature', kind: Kind.STATIC, density: 10, cond: 0.02,
    ignite: 250, burn: [150, 300], ash: 0.5, colors: ['#6b4423', '#5e3b1e', '#774c28', '#523319'] },
  { id: EL.PLANT, name: 'Plant', key: '9', group: 'Nature', kind: Kind.STATIC, density: 10, cond: 0.03,
    ignite: 150, burn: [15, 30], ash: 0.2, colors: ['#3f9e3a', '#4aae43', '#358a31', '#56bd4d'] },

  { id: EL.EMPTY, name: 'Eraser', key: 'e', group: 'Tools', kind: Kind.EMPTY, density: 0,
    colors: ['#0e0f14'] },
];

// Toolbar entries: every element plus non-element tools.
export const TOOLS = [
  ...ELEMENTS,
  { id: WIND_TOOL, name: 'Wind', key: '0', group: 'Air', colors: ['#9fd4ff'] },
];

// Gameplay reactions between touching cells. result = [what a becomes, what b becomes].
export const REACTIONS = [
  { a: EL.FIRE, b: EL.WATER, chance: 0.5, result: [EL.STEAM, EL.WATER] },
  { a: EL.FIRE, b: EL.ICE, chance: 0.2, result: [EL.STEAM, EL.WATER] },
  { a: EL.LAVA, b: EL.WATER, chance: 0.3, result: [EL.OBSIDIAN, EL.STEAM] },
  { a: EL.LAVA, b: EL.ICE, chance: 0.2, result: [EL.STONE, EL.WATER] },
  { a: EL.LAVA, b: EL.SAND, chance: 0.02, result: [EL.LAVA, EL.GLASS] },
  { a: EL.WATER, b: EL.EARTH, chance: 0.004, result: [EL.EMPTY, EL.MUD] },
  { a: EL.PLANT, b: EL.WATER, chance: 0.004, result: [EL.PLANT, EL.PLANT] },
];

// ---------- lookup tables ----------
export const KIND = new Uint8Array(256);
export const DENSITY = new Float32Array(256);
export const SLIDE = new Float32Array(256);
export const COHESIVE = new Uint8Array(256);
export const DISPERSION = new Uint8Array(256);
export const VISCOSITY = new Float32Array(256);
export const WIND = new Float32Array(256);
export const SPAWN_T = new Float32Array(256).fill(AMBIENT);
export const HOLD_T = new Uint8Array(256);
export const COND = new Float32Array(256).fill(0.05);
export const AIRLOSS = new Float32Array(256).fill(0.001);
export const HOT_T = new Float32Array(256).fill(Infinity);
export const HOT_TO = new Uint8Array(256);
export const HOT_P = new Float32Array(256);
export const COLD_T = new Float32Array(256).fill(-Infinity);
export const COLD_TO = new Uint8Array(256);
export const COLD_P = new Float32Array(256);
export const LIFE_MIN = new Uint16Array(256);
export const LIFE_MAX = new Uint16Array(256);
export const DEATH_TO = new Uint8Array(256);
export const DEATH_P = new Float32Array(256);
export const IGNITE_T = new Float32Array(256).fill(Infinity);
export const BURN_MIN = new Uint16Array(256);
export const BURN_MAX = new Uint16Array(256);
export const ASH_P = new Float32Array(256);
export const PALETTE = new Uint32Array(256 * SHADES);

// Reaction lookup keyed by a*256+b (stored both ways round).
export const R_CHANCE = new Float32Array(256 * 256);
export const R_SELF = new Uint8Array(256 * 256);
export const R_OTHER = new Uint8Array(256 * 256);
export const HAS_RULES = new Uint8Array(256);

// Canvas ImageData is RGBA bytes; on little-endian a Uint32 view reads as ABGR.
export function pack(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

for (const d of ELEMENTS) {
  const id = d.id;
  KIND[id] = d.kind;
  DENSITY[id] = d.density;
  SLIDE[id] = d.slide ?? 0;
  COHESIVE[id] = d.cohesive ? 1 : 0;
  DISPERSION[id] = d.dispersion ?? 0;
  VISCOSITY[id] = d.viscosity ?? 0;
  WIND[id] = d.wind ?? 0;
  if (d.temp !== undefined) SPAWN_T[id] = d.temp;
  HOLD_T[id] = d.holdTemp ? 1 : 0;
  if (d.cond !== undefined) COND[id] = d.cond;
  if (d.airLoss !== undefined) AIRLOSS[id] = d.airLoss;
  if (d.hot) [HOT_T[id], HOT_TO[id], HOT_P[id]] = d.hot;
  if (d.cold) [COLD_T[id], COLD_TO[id], COLD_P[id]] = d.cold;
  if (d.life) [LIFE_MIN[id], LIFE_MAX[id]] = d.life;
  if (d.death) [DEATH_TO[id], DEATH_P[id]] = d.death;
  if (d.ignite !== undefined) {
    IGNITE_T[id] = d.ignite;
    [BURN_MIN[id], BURN_MAX[id]] = d.burn;
    ASH_P[id] = d.ash ?? 0;
  }
  for (let s = 0; s < SHADES; s++) PALETTE[id * SHADES + s] = pack(d.colors[s % d.colors.length]);
}

KIND[WALL] = Kind.STATIC;
DENSITY[WALL] = Infinity;

for (const r of REACTIONS) {
  const ab = r.a * 256 + r.b, ba = r.b * 256 + r.a;
  R_CHANCE[ab] = R_CHANCE[ba] = r.chance;
  R_SELF[ab] = r.result[0]; R_OTHER[ab] = r.result[1];
  R_SELF[ba] = r.result[1]; R_OTHER[ba] = r.result[0];
  HAS_RULES[r.a] = HAS_RULES[r.b] = 1;
}
