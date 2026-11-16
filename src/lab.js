// Clash Lab: a test arena for the attack interaction engine.
//   - two emitters fire chosen attacks at each other (fire once / auto every 2 s)
//   - "dummy shoots at you": the dummy fires the right-side attack at you, so you can counter it
//     with your own bender's moves
//   - slow motion, a clash log (effective powers + what happened), power labels on every attack
import { spawnProjectile, spawnWall, register, onClash, advantage, ELEMENT_COLORS } from './clash.js';
import { EL } from './elements.js';
import { BODY_W as BW, BODY_H as BH } from './sprite.js';
import { slowmo, juice } from './juice.js';

// Attacks you can fire from the emitters.
export const LAB_ATTACKS = {
  fireball: { name: 'Fireball', el: 'fire', r: 3, boomR: 4.5 },
  flamewall: { name: 'Flame Wall', el: 'fire', wall: true },
  stone: { name: 'Stone', el: 'earth', r: 3.5, boomR: 4.5, cells: [EL.STONE, EL.STONE, EL.EARTH, EL.SAND] },
  spear: { name: 'Ice spear', el: 'ice', r: 2.5, boomR: 4 },
  waterball: { name: 'Water ball', el: 'water', r: 3.5, boomR: 3 },
  airblast: { name: 'Air blast', el: 'air', r: 4, boomR: 5 },
  lavarock: { name: 'Lava rock', el: 'lava', r: 3.5, boomR: 4.5 },
  bullet: { name: 'Water bullet', el: 'water', r: 2, boomR: 2 },
  shard: { name: 'Rock shard', el: 'earth', r: 2, boomR: 2.2, cells: [EL.STONE] },
  sandblast: { name: 'Sand blast', el: 'sand', r: 5, boomR: 4 },
  lightning: { name: 'Lightning', el: 'lightning', beam: true },
  erosion: { name: 'Erosion Jet', el: 'water', beam: true },
  blade: { name: 'Wind blade', el: 'air', r: 3, boomR: 2 },
  sonic: { name: 'Sonic wave', el: 'sonic', r: 5, boomR: 5 },
};
const POWERS = [6, 8, 9, 10, 18, 20, 22, 24, 30, 35, 40, 55, 60, 65, 80]; // includes every move's real power
const SPEED = 6;
const FLOOR = 186, EMIT_Y = 150, LEFT_X = 220, RIGHT_X = 420;
const LEFT_OWNER = 900, RIGHT_OWNER = 901; // the emitters fight each other, not the benders

export function createLab({ world, getMatch }) {
  const st = { me: 'air', active: false, left: 'fireball', lp: 20, right: 'spear', rp: 20, auto: false, dummy: false, slow: false, t: 0, log: [], beams: [] };

  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.className = 'labpanel';
  panel.style.display = 'none';
  document.body.append(panel);

  const opt = (sel, val, list) => list.map(([v, t]) => `<option value="${v}"${String(v) === String(val) ? ' selected' : ''}>${t}</option>`).join('');
  const attackOpts = Object.entries(LAB_ATTACKS).map(([k, a]) => [k, `${a.name} (${a.el})`]);
  const powerOpts = POWERS.map((p) => [p, `power ${p}`]);
  function render() {
    const L = LAB_ATTACKS[st.left], R = LAB_ATTACKS[st.right];
    const ea = st.lp * advantage(L.el, R.el), eb = st.rp * advantage(R.el, L.el);
    panel.innerHTML = `
      <div class="labrow"><b class="labtitle">CLASH LAB</b>
        <span class="side">YOU <select data-k="me">${opt(0, st.me, [['fire', 'Fire'], ['earth', 'Earth'], ['water', 'Water'], ['air', 'Air']])}</select></span>
        <span class="side" style="--c:${ELEMENT_COLORS[L.el]}">LEFT <select data-k="left">${opt(0, st.left, attackOpts)}</select><select data-k="lp">${opt(0, st.lp, powerOpts)}</select></span>
        <span class="vs">vs</span>
        <span class="side" style="--c:${ELEMENT_COLORS[R.el]}">RIGHT <select data-k="right">${opt(0, st.right, attackOpts)}</select><select data-k="rp">${opt(0, st.rp, powerOpts)}</select></span>
        <span class="pred">effective ${ea} vs ${eb}${ea !== st.lp || eb !== st.rp ? ' (element advantage x2)' : ''}</span>
      </div>
      <div class="labrow">
        <button data-a="fire" class="btn primary">Fire both</button>
        <button data-a="auto" class="btn${st.auto ? ' active' : ''}">Auto-fire every 2 s: ${st.auto ? 'on' : 'off'}</button>
        <button data-a="dummy" class="btn${st.dummy ? ' active' : ''}">Dummy shoots RIGHT at you: ${st.dummy ? 'on' : 'off'}</button>
        <button data-a="slow" class="btn${st.slow ? ' active' : ''}">Slow motion: ${st.slow ? 'on' : 'off'}</button>
        <button data-a="clear" class="btn">Clear arena</button>
      </div>
      <div class="lablog">${st.log.map((l) => `<div>${l}</div>`).join('') || '<div class="hint">clash results appear here</div>'}</div>`;
    panel.querySelectorAll('select').forEach((s) => { s.onchange = () => {
      const k = s.dataset.k; st[k] = k === 'lp' || k === 'rp' ? +s.value : s.value;
      if (k === 'me') { const m = getMatch(); if (m && m.players[0]) m.players[0].setType(s.value); }
      s.blur(); render();
    }; });
    panel.querySelectorAll('button').forEach((b) => { b.onclick = () => act(b.dataset.a); });
  }
  function act(a) {
    if (a === 'fire') fireBoth();
    else if (a === 'auto') st.auto = !st.auto;
    else if (a === 'dummy') st.dummy = !st.dummy;
    else if (a === 'slow') st.slow = !st.slow;
    else if (a === 'clear') arena();
    render();
  }

  // ---------- firing ----------
  function fire(key, pow, x, y, dx, dy, owner, team = null) {
    const A = LAB_ATTACKS[key];
    if (A.beam) { st.beams.push({ el: A.el, name: A.name, x, y, x2: x + dx * 260, y2: y + dy * 260, owner, team, pow, t: 0 }); return; }
    if (A.wall) { spawnWall({ el: A.el, name: A.name, x: x + dx * 40, base: FLOOR, h: 30, pow, owner, team, life: 240 }); return; }
    spawnProjectile({ el: A.el, name: A.name, x, y, vx: dx * SPEED, vy: dy * SPEED, pow, r: A.r, boomR: A.boomR, owner, team, cells: A.cells, life: 160 });
  }
  function fireBoth() {
    fire(st.left, st.lp, LEFT_X, EMIT_Y, 1, 0, LEFT_OWNER);
    fire(st.right, st.rp, RIGHT_X, EMIT_Y, -1, 0, RIGHT_OWNER);
  }
  function dummyShot() {
    const m = getMatch(); if (!m) return;
    const me = m.players[0], d = m.players[1];
    if (!me || !d || d.dead || me.dead) return;
    const sx = d.x + BW / 2 - 6, sy = d.y + BH * 0.35, tx = me.x + BW / 2, ty = me.y + BH / 2;
    const l = Math.hypot(tx - sx, ty - sy) || 1;
    fire(st.right, st.rp, sx, sy, (tx - sx) / l, (ty - sy) / l, d.id, d.team);
  }

  // Flat arena: a floor, the two emitter pads, you on the left, the dummy on the right.
  function arena() {
    const g = world.grid;
    g.clear(); world.particles.clear();
    for (let x = 0; x < g.w; x++) for (let y = FLOOR; y < g.h; y++) g.set(x, y, y < FLOOR + 3 ? EL.EARTH : EL.STONE);
    for (const ex of [LEFT_X, RIGHT_X]) for (let x = ex - 3; x <= ex + 3; x++) for (let y = EMIT_Y + 8; y < EMIT_Y + 10; y++) g.set(x, y, EL.OBSIDIAN);
    const m = getMatch();
    if (m) {
      const [me, d] = m.players;
      if (me) { me.x = 90; me.y = FLOOR - BH; me.vx = me.vy = 0; me.facing = 1; }
      if (d) { d.x = 545; d.y = FLOOR - BH; d.vx = d.vy = 0; d.facing = -1; }
    }
  }

  onClash((r) => {
    if (!st.active) return;
    const tag = (e, eff) => `<b style="color:${ELEMENT_COLORS[e.el] || '#fff'}">${e.name || e.el}</b> (${e.el} ${Math.round(e.pow0)}${eff !== Math.round(e.pow0) ? ` x2 = ${eff}` : ''})`;
    const line = `${tag(r.a, Math.round(r.ea))} vs ${tag(r.b, Math.round(r.eb))} → <i>${r.text || (r.cancel ? 'cancelled out' : 'winner continues')}</i>`;
    st.log.unshift(line); st.log.length = Math.min(st.log.length, 7);
    render();
  });

  return {
    get active() { return st.active; },
    start(type) { st.active = true; st.log = []; st.me = type || st.me; arena(); render(); panel.style.display = ''; },
    get me() { return st.me; },
    stop() { st.active = false; st.beams = []; panel.style.display = 'none'; },
    // Called every simulation tick while the lab is open.
    tick() {
      if (!st.active) return;
      st.t++;
      if (st.auto && st.t % 120 === 0) fireBoth();
      if (st.dummy && st.t % 120 === 60) dummyShot();
      if (st.slow) slowmo(4, 0.25);
      // Lab lightning beams: drawn as a jagged bolt and registered for clashes for a few ticks.
      st.beams = st.beams.filter((b) => {
        b.t++;
        const water = b.el === 'water', n = water ? 130 : 26;
        for (let k = 0; k <= n; k++) { // lightning: a jagged bolt; water: a straight dense jet
          const jit = water ? 0.6 : 4;
          const x = b.x + ((b.x2 - b.x) * k) / n + (k % n ? (Math.random() - 0.5) * jit : 0), y = b.y + ((b.y2 - b.y) * k) / n + (k % n ? (Math.random() - 0.5) * jit : 0);
          world.particles.spawn(x, y, 0, 0, water ? (k % 5 ? EL.WATER : EL.ICE) : EL.ICE, { ghost: true, gravity: 0, life: 1 });
        }
        register({ el: b.el, form: 'beam', name: b.name, pow: b.pow, x: b.x, y: b.y, x2: b.x2, y2: b.y2, r: 3, owner: b.owner, team: b.team });
        return b.t < (water ? 40 : 6);
      });
    },
  };
}
