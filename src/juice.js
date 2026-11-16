// Game-feel state shared by the simulation, the main loop and the renderer:
//   hitstop  - frames the whole simulation freezes on a big hit (weight)
//   slow     - slow motion for a while (KOs, match end, ultimate cinematics)
//   popups   - floating damage numbers
//   cine     - the ultimate cinematic in progress (banner + darkening)
export const juice = {
  hitstop: 0,
  slowT: 0, slowRate: 1,
  popups: [],          // { x, y, text, color, life }
  cine: null,          // { name, color, t }
};

export function hitstop(frames) {
  juice.hitstop = Math.max(juice.hitstop, Math.round(frames));
}

// rate: simulation speed while slowed (0.3 = 30 %).
export function slowmo(frames, rate) {
  if (frames >= juice.slowT || rate < juice.slowRate) { juice.slowT = frames; juice.slowRate = rate; }
}

export function popup(x, y, text, color = '#ffffff') {
  if (juice.popups.length > 24) juice.popups.shift();
  juice.popups.push({ x, y, text: String(text), color, life: 50 });
}

export const ULT_NAMES = { fire: 'INFERNO ASCENSION', earth: 'CONTINENTAL RIFT', water: 'GLACIAL CATACLYSM', air: 'WIND DRAGON' };
export function cinematic(type, color) {
  juice.cine = { name: ULT_NAMES[type] || 'ULTIMATE', color, t: 0 };
  slowmo(36, 0.3);
}

// Per rendered frame: age popups / timers.
export function stepJuice() {
  if (juice.slowT > 0 && --juice.slowT === 0) juice.slowRate = 1;
  for (const p of juice.popups) { p.y -= 0.35; p.life--; }
  juice.popups = juice.popups.filter((p) => p.life > 0);
  if (juice.cine && ++juice.cine.t > 70) juice.cine = null;
}

export function resetJuice() {
  juice.hitstop = 0; juice.slowT = 0; juice.slowRate = 1; juice.popups = []; juice.cine = null;
}
