// Online sessions on top of signal.js (room codes) and net.js (snapshots).
//   HostSession  - opens a room, keeps the lobby (up to 4 players), streams snapshots to guests.
//   GuestSession - joins by code, receives lobby / match / snapshots, sends its input.
// Two data channels per guest: 'ctl' (lobby, start, results, input; small JSON) and
// 'snap' (compressed binary snapshots). Both reliable + ordered: snapshots are diffs.
import { hostRoom, joinRoom } from './signal.js';
import { SnapEncoder, cellCodes, windCodes, pack, unpack, inputBits, playerVisual } from './net.js';
import { readyMask } from './abilities.js';

export const MAX_PLAYERS = 4;
const SNAP_BACKLOG = 1 << 20; // skip a snapshot for a guest whose connection is this far behind

const sendJSON = (ch, msg) => { if (ch && ch.readyState === 'open') ch.send(JSON.stringify(msg)); };

// ---------------- host ----------------
export class HostSession {
  // hooks: { onLobby(), onGuestLeft(name, guest) }
  constructor(grid, hooks) {
    this.grid = grid;
    this.hooks = hooks;
    this.guests = [];   // { id, name, type, team, pc, ctl, snap, enc, input: { bits, jumps }, busy, gone }
    this.me = { name: 'Host', type: 'fire', team: 0 };
    this.bots = [];     // { name, type, team, level } CPU fighters the host added
    this.cfg = { format: 'ffa', win: 'kos', map: 'random', customKey: 'off' };
    this.inMatch = false;
    this.room = null;
    this.cur = { cells: new Uint16Array(grid.w * grid.h), wind: new Uint8Array(grid.fw * grid.fh) };
  }

  async open() {
    this.room = await hostRoom((pc, name, id) => this.addGuest(pc, name, id));
    return this.room.code;
  }

  addGuest(pc, name, id) {
    const g = { id, name, type: 'water', team: 1, pc, ctl: null, snap: null, enc: new SnapEncoder(this.grid), input: { bits: 0, jumps: 0 }, busy: 0, gone: false };
    pc.ondatachannel = (e) => {
      const ch = e.channel; ch.binaryType = 'arraybuffer';
      if (ch.label === 'ctl') {
        g.ctl = ch;
        ch.onmessage = (m) => this.onGuestMessage(g, JSON.parse(m.data));
        ch.onclose = () => this.dropGuest(g);
        ch.onopen = () => this.admit(g);
        if (ch.readyState === 'open') this.admit(g);
      } else g.snap = ch;
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.dropGuest(g);
    };
  }

  admit(g) {
    if (g.admitted) return;
    g.admitted = true;
    if (this.inMatch || this.guests.length + this.bots.length + 1 >= MAX_PLAYERS) {
      sendJSON(g.ctl, { k: 'closed', why: this.inMatch ? 'That match has already started' : 'Room is full (4 players)' });
      setTimeout(() => g.pc.close(), 500);
      return;
    }
    const taken = new Set([this.me.type, ...this.guests.map((x) => x.type)]);
    g.type = ['water', 'earth', 'air', 'fire'].find((t) => !taken.has(t)) || 'water';
    g.team = this.guests.length % 2 === 0 ? 1 : 0;
    this.guests.push(g);
    this.lobbyChanged();
  }

  dropGuest(g) {
    if (g.gone) return;
    g.gone = true;
    g.input.bits = 0;
    try { g.pc.close(); } catch { /* already closed */ }
    if (!this.inMatch) this.guests = this.guests.filter((x) => x !== g);
    this.hooks.onGuestLeft?.(g.name, g);
    this.lobbyChanged();
  }

  onGuestMessage(g, m) {
    if (m.k === 'in') { g.input.bits = m.b | 0; g.input.jumps = m.j | 0; }
    else if (m.k === 'bye') this.dropGuest(g);
    else if (m.k === 'type' && !this.inMatch && ['fire', 'water', 'earth', 'air'].includes(m.type)) { g.type = m.type; this.lobbyChanged(); }
    else if (m.k === 'name' && !this.inMatch) { g.name = String(m.name || 'Guest').slice(0, 12); this.lobbyChanged(); }
  }

  // Lobby as everyone sees it. Slot 0 is the host.
  lobby() {
    return {
      code: this.room?.code, cfg: this.cfg,
      players: [{ ...this.me, host: true }, ...this.guests.filter((g) => !g.gone).map((g) => ({ name: g.name, type: g.type, team: g.team })),
        ...this.bots.map((b) => ({ name: b.name, type: b.type, team: b.team, cpu: b.level }))],
    };
  }

  // Lobby slot k (0 = host, then guests, then bots) -> edit / add (k = -1) / remove (change = null) a CPU.
  editBot(k, change) {
    const live = this.guests.filter((g) => !g.gone).length;
    if (k < 0) {
      if (1 + live + this.bots.length >= MAX_PLAYERS) return;
      const taken = new Set([this.me.type, ...this.guests.map((g) => g.type), ...this.bots.map((b) => b.type)]);
      const type = ['earth', 'air', 'water', 'fire'].find((t) => !taken.has(t)) || 'earth';
      this.bots.push({ name: `CPU ${this.bots.length + 1}`, type, team: (live + this.bots.length) % 2 === 0 ? 1 : 0, level: 'normal' });
    } else {
      const i = k - 1 - live;
      if (!this.bots[i]) return;
      if (change === null) this.bots.splice(i, 1); else Object.assign(this.bots[i], change);
    }
    this.lobbyChanged();
  }

  lobbyChanged() {
    const l = this.lobby();
    this.guests.forEach((g, k) => sendJSON(g.ctl, { k: 'lobby', lobby: l, you: k + 1, inMatch: this.inMatch }));
    this.hooks.onLobby?.();
  }

  // Slots for Match: the host plays with 'local' input, guests with 'net' input.
  slots() {
    const live = this.guests.filter((g) => !g.gone);
    return [
      { name: this.me.name, type: this.me.type, team: this.me.team, source: 'local' },
      ...live.map((g) => ({ name: g.name, type: g.type, team: g.team, source: 'net', net: g.input })),
      ...this.bots.map((b) => ({ name: b.name, type: b.type, team: b.team, source: 'cpu-' + b.level })),
    ];
  }

  // Everyone switches to the match; snapshots restart from an empty map.
  startMatch(mapId) {
    this.guests = this.guests.filter((g) => !g.gone);
    this.inMatch = true;
    this.room?.lock();
    for (const g of this.guests) { g.enc.reset(); sendJSON(g.ctl, { k: 'start', cfg: { ...this.cfg, map: mapId } }); }
  }

  backToLobby() {
    this.inMatch = false;
    this.guests = this.guests.filter((g) => !g.gone);
    this.room?.unlock();
    for (const g of this.guests) sendJSON(g.ctl, { k: 'lobbyback' });
    this.lobbyChanged();
  }

  sendResults(result) {
    const r = {
      winner: result.winner ? { name: result.winner.name, color: result.winner.color, type: result.winner.players[0] && result.winner.players[0].type } : null,
      sides: result.sides.map((s) => ({ players: s.players.map((p) => ({ name: p.name, type: p.type, kos: p.kos, deaths: p.deaths, color: p.color })) })),
    };
    for (const g of this.guests) sendJSON(g.ctl, { k: 'results', result: r });
  }

  // Called every other tick during a match.
  sendSnapshot(world, match, fx, sounds = []) {
    const live = this.guests.filter((g) => !g.gone && g.snap && g.snap.readyState === 'open');
    if (!live.length) return;
    cellCodes(this.grid, this.cur.cells);
    windCodes(this.grid, this.cur.wind);
    const json = {
      p: world.players.map(playerVisual),
      h: {
        clock: match.clockText(), cd: match.countdown, over: match.over, t: match.t, lives: !!match.win.lives,
        feed: match.feed.slice(-5).map((f) => ({ text: f.text, color: f.color })),
        players: match.players.map((p) => ({ name: p.name, color: p.color, out: p.out, lives: p.lives, kos: p.kos, type: p.type, rd: p.dead ? 0 : readyMask(p), orbN: p.orbs ? p.orbs.list.length : 0 })),
      },
      fx, paused: fx.paused, s: sounds,
    };
    for (const g of live) {
      if (g.busy > 2 || g.snap.bufferedAmount > SNAP_BACKLOG) continue; // let it catch up (diff stays valid)
      const bytes = g.enc.encode(this.cur, world.particles, json);
      g.busy++;
      g.chain = (g.chain || Promise.resolve()).then(() => pack(bytes)).then((z) => {
        g.busy--;
        if (g.snap.readyState === 'open') { g.snap.send(z); g.sent = (g.sent || 0) + z.length; }
      }).catch(() => { g.busy--; });
    }
  }

  close() {
    for (const g of this.guests) { sendJSON(g.ctl, { k: 'closed', why: 'Host closed the room' }); setTimeout(() => g.pc.close(), 300); }
    this.guests = [];
    this.room?.close();
    this.room = null;
  }
}

// ---------------- guest ----------------
export class GuestSession {
  // hooks: { onLobby(lobby, you, inMatch), onStart(cfg), onSnapshot(bytes), onResults(r), onLobbyBack(), onClosed(why) }
  constructor(hooks) { this.hooks = hooks; this.jumps = 0; this.lastBits = -1; this.lastSent = 0; this.chain = Promise.resolve(); }

  async join(code, name, type, status) {
    const { pc, ctl, snap } = await joinRoom(code, name, status);
    this.pc = pc; this.ctl = ctl; this.snap = snap;
    ctl.onmessage = (m) => this.onMessage(JSON.parse(m.data));
    snap.onmessage = (m) => { this.chain = this.chain.then(() => unpack(m.data)).then((b) => this.hooks.onSnapshot(b)).catch(console.warn); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && !this.left) this.hooks.onClosed('Lost connection to the host');
    };
    sendJSON(ctl, { k: 'type', type });
    sendJSON(ctl, { k: 'name', name });
  }

  onMessage(m) {
    if (m.k === 'lobby') this.hooks.onLobby(m.lobby, m.you, m.inMatch);
    else if (m.k === 'start') this.hooks.onStart(m.cfg);
    else if (m.k === 'results') this.hooks.onResults(m.result);
    else if (m.k === 'lobbyback') this.hooks.onLobbyBack();
    else if (m.k === 'closed') { this.left = true; this.hooks.onClosed(m.why); }
  }

  setType(type) { sendJSON(this.ctl, { k: 'type', type }); }

  // Every tick: send on change (and at least every 250 ms in case).
  sendInput(inp, now) {
    if (inp.jump) this.jumps++;
    const b = inputBits(inp);
    if (b === this.lastBits && !inp.jump && now - this.lastSent < 250) return;
    this.lastBits = b; this.lastSent = now;
    sendJSON(this.ctl, { k: 'in', b, j: this.jumps });
  }

  leave() {
    this.left = true;
    sendJSON(this.ctl, { k: 'bye' });
    const pc = this.pc;
    setTimeout(() => { try { pc?.close(); } catch { /* closed */ } }, 200); // let the goodbye go out
  }
}
