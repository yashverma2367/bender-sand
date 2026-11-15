// Match rules: formats (free-for-all, 1v1, 2v2), win conditions (first to 10 KOs, timed, 3
// lives), countdown, KO credit (the last enemy to hit you within 6 s gets the KO, even if lava
// finished you), respawns at the spawn point furthest from enemies, scoring and results.
import { Player } from './benders.js';

export const FORMATS = {
  ffa: { name: 'Free-for-All', min: 2, max: 4, teams: false },
  duel: { name: '1v1', min: 2, max: 2, teams: false },
  teams: { name: '2v2', min: 4, max: 4, teams: true },
};

export const WINS = {
  kos: { name: 'First to 10 KOs', target: 10 },
  timed: { name: 'Timed (3 min)', seconds: 180 },
  lives: { name: '3 Lives', lives: 3 },
};

export const PLAYER_COLORS = ['#ff5a4e', '#4ea8ff', '#5adc6e', '#ffd24e'];
export const TEAM_COLORS = ['#ff5a4e', '#4ea8ff'];
export const TEAM_NAMES = ['Red', 'Blue'];

const COUNTDOWN = 180;      // 3 s before the fight starts
const RESPAWN = 150;        // 2.5 s
const KO_CREDIT = 360;      // a KO counts for whoever hit you in the last 6 s
const END_DELAY = 120;      // time to show the final KO before the results

export class Match {
  // slots: [{ name, type, source, team }] (team 0/1 used in 2v2)
  constructor(world, cfg, slots) {
    this.world = world;
    this.cfg = cfg; // { format, win, map }
    this.format = FORMATS[cfg.format];
    this.win = WINS[cfg.win];
    this.t = 0;
    this.countdown = COUNTDOWN;
    this.timeLeft = this.win.seconds ? this.win.seconds * 60 : 0;
    this.feed = [];        // [{ text, t }]
    this.over = false;
    this.endIn = -1;
    this.result = null;
    this.spawns = [];

    Player.registry.clear();
    Player.clock = 0;
    this.players = slots.map((s, k) => {
      const p = new Player(world.grid, s.type);
      p.name = s.name;
      p.source = s.source;
      p.color = this.format.teams ? TEAM_COLORS[s.team] : PLAYER_COLORS[k];
      p.team = this.format.teams ? s.team : null;
      p.kos = 0; p.deaths = 0;
      p.lives = this.win.lives || Infinity;
      p.out = false;
      p.onDeath = (v) => this.onDeath(v);
      return p;
    });
  }

  // Place everyone on the map's spawn points: 2v2 -> each team on its own side.
  start(spawns) {
    this.spawns = spawns;
    const order = this.format.teams
      ? [...this.players].sort((a, b) => a.team - b.team)
      : this.players.length === 2 ? this.players : this.players;
    const pick = this.players.length === 2 ? [0, 3] : [0, 1, 2, 3];
    order.forEach((p, k) => { p.spawnX = spawns[pick[k]]; p.spawn(); p.ult = 0; p.facing = k < order.length / 2 ? 1 : -1; });
  }

  get fighting() { return this.countdown <= 0 && !this.over; }

  // Called every simulation tick (before players update).
  tick() {
    Player.clock++;
    this.t++;
    if (this.countdown > 0) {
      this.countdown--;
      for (const p of this.players) { p.stunT = Math.max(p.stunT || 0, 2); p.invulnT = Math.max(p.invulnT || 0, 2); }
      return;
    }
    if (this.over) {
      if (this.endIn > 0 && --this.endIn === 0) this.result = this.computeResult();
      return;
    }
    if (this.timeLeft > 0 && --this.timeLeft === 0) this.finish();
    this.feed = this.feed.filter((f) => this.t - f.t < 300);
  }

  onDeath(v) {
    const killer = v.lastHitBy !== undefined && Player.clock - v.lastHitAt < KO_CREDIT ? Player.registry.get(v.lastHitBy) : null;
    if (this.over) { v.respawn = RESPAWN; v.spawnX = this.safestSpawn(v); return; } // scores are final
    v.deaths++;
    if (killer && killer !== v && !(v.team !== null && killer.team === v.team)) {
      killer.kos++;
      this.feed.push({ text: `${killer.name} KO'd ${v.name}`, color: killer.color, t: this.t });
    } else {
      this.feed.push({ text: `${v.name} fell`, color: v.color, t: this.t });
    }
    v.lastHitBy = undefined;
    if (this.win.lives) {
      v.lives--;
      if (v.lives <= 0) { v.out = true; v.respawn = Infinity; this.feed.push({ text: `${v.name} is OUT`, color: v.color, t: this.t }); }
    }
    if (!v.out) {
      v.respawn = RESPAWN;
      v.spawnX = this.safestSpawn(v);
    }
    this.checkWin();
  }

  // The spawn point furthest from every living enemy.
  safestSpawn(v) {
    let best = this.spawns[0], bestD = -1;
    for (const sx of this.spawns) {
      let d = Infinity;
      for (const p of this.players) {
        if (p === v || p.dead || (v.team !== null && p.team === v.team)) continue;
        d = Math.min(d, Math.abs(p.x - sx));
      }
      if (d > bestD) { bestD = d; best = sx; }
    }
    return best;
  }

  // Score per side: { key, name, color, kos, alive, players }
  sides() {
    const map = new Map();
    for (const p of this.players) {
      const key = this.format.teams ? `team${p.team}` : `p${p.id}`;
      if (!map.has(key)) map.set(key, {
        key, players: [], kos: 0, deaths: 0, alive: false,
        name: this.format.teams ? `${TEAM_NAMES[p.team]} Team` : p.name, color: p.color,
      });
      const s = map.get(key);
      s.players.push(p); s.kos += p.kos; s.deaths += p.deaths;
      if (!p.out) s.alive = true;
    }
    return [...map.values()];
  }

  checkWin() {
    if (this.over) return;
    const sides = this.sides();
    if (this.win.target && sides.some((s) => s.kos >= this.win.target)) this.finish();
    if (this.win.lives && sides.filter((s) => s.alive).length <= 1) this.finish();
  }

  finish() {
    if (this.over) return;
    this.over = true;
    this.endIn = END_DELAY;
  }

  computeResult() {
    const sides = this.sides();
    const score = (s) => (this.win.lives ? (s.alive ? 1e6 : 0) + s.players.reduce((n, p) => n + Math.max(0, p.lives), 0) * 1000 + s.kos
      : s.kos * 1000 - s.deaths);
    sides.sort((a, b) => score(b) - score(a));
    const draw = sides.length > 1 && score(sides[0]) === score(sides[1]);
    return { winner: draw ? null : sides[0], sides };
  }

  // Clock text for the HUD.
  clockText() {
    if (this.win.seconds) {
      const s = Math.ceil(this.timeLeft / 60);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    return this.win.target ? `First to ${this.win.target}` : 'Last one standing';
  }
}
