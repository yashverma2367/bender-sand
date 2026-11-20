// Entry: canvas, modes (menu / custom sandbox / match), input, fixed-timestep loop.
//   menu     - main menu & match setup over an idle map
//   sandbox  - "Custom": one bender (keyboard 1) plus every painting / dev tool
//   match    - local or hosted online match (2-4 benders, no painting tools unless online Custom)
//   guest    - joined someone's online match: render the host's snapshots, send our input
import { Grid } from './grid.js';
import { TOOLS, EL, WIND_TOOL, KIND, Kind } from './elements.js';
import { createRenderer } from './render.js';
import { Player, BENDER_TYPES, MAX_HP } from './benders.js';
import { Particles } from './particles.js';
import { updateAbilities, explode, creditDamage, channelInfo, readyMask, slotInfo } from './abilities.js';
import { createMoveBar } from './movebar.js';
import { initPhysics, resetPhysics, stepPhysics, setBursts, scanPipes } from './physics.js';
import * as sfx from './sfx.js';
import { setTrack, musicState } from './music.js';
import { juice, stepJuice, resetJuice, slowmo, cinematic, ULT_NAMES } from './juice.js';
import { buildUI } from './ui.js';
import { MAPS, LAB_MAP, loadMap } from './maps.js';
import { Match } from './match.js';
import { createScreens } from './hud.js';
import { attachKeyboard, createInput, sampleInput, isDown, GAME_KEYS } from './input.js';
import { createTouchControls, isTouchDevice } from './touch.js';
import { HostSession, GuestSession } from './online.js';
import { applySnapshot } from './net.js';
import { onlineConfigured } from './signal.js';
import { stepProjectiles, resolveClashes, clearClash, lastEntries } from './clash.js';
import { createLab } from './lab.js';
import { Bot } from './bot.js';

// World size follows the map (medium 840 x 472, large 1120 x 630). Matches show a camera that
// follows the fight; menus / Custom show the whole map.
let W = 560, H = 315;
const TICK_MS = 1000 / 60;
const MAX_BRUSH = 30;
const WIND_STRENGTH = 0.8; // force per grid cell of mouse drag

const canvas = document.getElementById('game');
const stage = document.getElementById('stage');
const toolbarEl = document.getElementById('toolbar');
const statsEl = document.getElementById('stats');
const helpEl = document.getElementById('help');

const grid = new Grid(W, H);
const renderer = createRenderer(grid, canvas);
const particles = new Particles(grid);

// Screen shake (CSS offset) and flash (CSS brightness), both decaying every frame.
let shake = 0, flash = 0;
const fx = {
  shake: (n) => { shake = Math.max(shake, n); },
  flash: (n) => { flash = Math.max(flash, n); },
};
const world = { grid, particles, fx, player: null, players: [] };
particles.onImpact = (x, y, r, type, owner) => explode(world, x, y, r, type, r >= 6, true, owner);
initPhysics(world);                                                      // collapses, dust, shockwaves, splashes
Player.world = world;
Player.particles = particles;                                           // dust puffs
particles.bodies = world.players;                                        // projectiles can hit benders
particles.onHit = (attackerId, victim, dmg) => creditDamage(world, attackerId, dmg); // ...and charge the attacker's ult

const state = { mode: 'menu', selected: EL.SAND, brush: 4, paused: false, heatView: false, debugView: false, fps: 0, count: 0, map: null };
let match = null, lastMatch = null, resultsShown = false, matchOverSeen = false;
let mapTick = null; // live map hazards (the subway train)
const mapEnv = { fx, players: world.players };
let tickCount = 0;

const sandboxPlayer = new Player(grid, 'fire');
const sandboxSource = isTouchDevice ? 'touch' : 'kb1';
const sandboxInput = createInput();
attachKeyboard();

// ---------- online ----------
let net = null;    // HostSession while hosting
let guest = null;  // GuestSession while joined to someone
const guestView = { players: [], hud: null, since: 0, you: 1, lobby: null };
const guestInput = createInput();
const onlineCustom = () => state.mode === 'match' && !!net && !!match && !!match.cfg.custom;

// ---------- view ----------
const view = { x: 0, y: 0, w: W, h: H };
renderer.setView(view);
canvas.style.aspectRatio = `${W} / ${H}`;
// In matches a camera follows the action: your bender (several local players: framed together,
// zooming out as they spread apart up to MAX_ZOOM), online guests their own bender, spectators
// (only bots alive) everyone. Menus and Custom show the whole map.
const MOVEBAR_H = 118;
const HUD_STRIP = 64;              // desktop: the strip above the map for the HUD (index.html body.play #stage)             // desktop: screen pixels kept under the map for the move bar
const SHOW_FULL_MAP = false;       // matches: a camera following the fight (true: always the whole map)
const MIN_VIEW_AREA = 560 * 315;   // the closest the camera gets: as much as the old small maps showed
// View size (cells) for a screen of this aspect ratio: exactly a quarter of the map's area.
function baseViewFor(aspect) {
  let h = Math.round(Math.sqrt(MIN_VIEW_AREA / aspect)), w = Math.round(h * aspect);
  if (w > W) { w = W; h = Math.round(W / aspect); }
  if (h > H) { h = H; w = Math.min(W, Math.round(H * aspect)); }
  return [w, h];
}
let camMode = false, camX = 0, camY = 0, camSnap = true, camZoom = 1, baseW = W, baseH = H;
const isHuman = (p) => !!p.source && !p.source.startsWith('cpu') && p.source !== 'net';
function camTargets() {
  if (state.mode === 'guest') {
    const me = guestView.players[guestView.you];
    return me && !me.dead ? [me] : guestView.players.filter((q) => !q.dead);
  }
  const humans = world.players.filter((p) => !p.dead && isHuman(p));
  if (humans.length) return humans;
  if (world.players.some(isHuman)) return []; // you're respawning: hold the camera still
  return world.players.filter((p) => !p.dead);
}
function updateCamera() {
  if (!camMode) return;
  let tx = camX + view.w / 2, ty = camY + view.h / 2, want = camZoom;
  if (lab.active) { want = Math.min(W / baseW, H / baseH, Math.max(1, 680 / baseW)); tx = 330; ty = 150; }
  else {
    const list = camTargets();
    if (list.length) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of list) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x + 5); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y + 18); }
      tx = (x0 + x1) / 2; ty = (y0 + y1) / 2;
      want = Math.max(1, (x1 - x0 + 140) / baseW, (y1 - y0 + 100) / baseH);
      want = Math.min(want, Math.max(W / baseW, H / baseH)); // zoom out as far as the whole map, no further
    }
  }
  if (camSnap) camZoom = want; else camZoom += (want - camZoom) * 0.05;
  camZoom = Math.min(camZoom, Math.max(W / baseW, H / baseH));
  const vw = Math.min(W, Math.round(baseW * camZoom)), vh = Math.min(H, Math.round(baseH * camZoom));
  if (vw !== view.w || vh !== view.h) { view.w = vw; view.h = vh; renderer.setView(view); }
  const cx = tx - view.w / 2, cy = ty - view.h * (isTouchDevice ? 0.42 : 0.55); // a bit more room above
  if (camSnap) { camX = cx; camY = cy; camSnap = false; }
  camX += (cx - camX) * 0.12; camY += (cy - camY) * 0.12;
  camX = Math.max(0, Math.min(W - view.w, camX)); camY = Math.max(0, Math.min(H - view.h, camY));
  view.x = Math.round(camX); view.y = Math.round(camY);
  sfx.setListener(view.x + view.w / 2, view.w); // sounds pan / fade relative to the camera
}

// The map just changed (maybe its size): the camera starts over on it.
function worldResized() {
  W = grid.w; H = grid.h;
  camSnap = true;
  if (!camMode) { view.x = 0; view.y = 0; view.w = W; view.h = H; renderer.setView(view); }
}

function layout() { // the canvas gets more room when the sandbox toolbar is hidden
  const playingNow = state.mode === 'match' || state.mode === 'guest';
  const cam = playingNow && !SHOW_FULL_MAP;
  if (cam !== camMode) camSnap = true;
  camMode = cam;
  document.body.classList.toggle('cam', cam && isTouchDevice);
  if (cam && isTouchDevice) { // full screen, zoomed in, following the player
    const sw = window.innerWidth, sh = window.innerHeight;
    [baseW, baseH] = baseViewFor(sw / sh);
    view.w = baseW; view.h = baseH; camZoom = 1;
    renderer.setView(view);
    canvas.style.aspectRatio = 'auto';
    stage.style.width = '';
    toolbarEl.style.display = statsEl.style.display = helpEl.style.display = 'none';
    document.body.classList.add('playing');
    updateCamera();
    return;
  }
  const sandbox = state.mode === 'sandbox' || onlineCustom();
  const play = playingNow && !isTouchDevice && !sandbox; // full-screen match: map + move bar only
  document.body.classList.toggle('play', play);
  const reserve = sandbox ? 290 : play ? Math.max(40, moveBar.height() || MOVEBAR_H) + HUD_STRIP : isTouchDevice ? 16 : 70;
  let aspect = W / H;
  if (cam) { // desktop camera: a quarter of the map, shaped like the window
    aspect = Math.max(1.4, Math.min(3.2, (window.innerWidth - 32) / Math.max(200, window.innerHeight - reserve)));
    [baseW, baseH] = baseViewFor(aspect);
    view.w = baseW; view.h = baseH; camZoom = 1;
    renderer.setView(view);
    updateCamera();
  } else {
    view.x = 0; view.y = 0; view.w = W; view.h = H;
    renderer.setView(view);
    sfx.setListener(W / 2, W);
  }
  canvas.style.aspectRatio = `${view.w} / ${view.h}`;
  stage.style.width = `min(calc(100vw - ${play ? 0 : isTouchDevice ? 8 : 32}px), calc((100vh - ${reserve}px) * ${aspect.toFixed(3)}))`;
  document.body.classList.toggle('playing', playingNow);
  for (const k of [0, 1]) if (toolbarEl.children[k]) toolbarEl.children[k].style.display = net ? 'none' : ''; // map / bender rows: Custom only
  canvas.style.width = '100%';
  toolbarEl.style.display = sandbox ? '' : 'none';
  statsEl.style.display = sandbox ? '' : 'none';
  helpEl.style.display = sandbox ? '' : 'none';
}

// ---------- modes ----------
function setPlayers(list) {
  world.players.length = 0;
  world.players.push(...list);
  world.player = list[0] || null;
}

function useMap(m) {
  const { spawns, tick } = loadMap(grid, particles, m); // (resizes the world to the map)
  worldResized();
  resetPhysics();
  scanPipes(); // remember every gas line / water main / cable so breaking one bursts (and place cars, barrels)
  state.map = m.id;
  mapTick = tick || null;
  return spawns;
}

function startSandbox() {
  resetJuice(); clearClash();
  state.mode = 'sandbox'; state.paused = false;
  match = null;
  sandboxPlayer.team = null;
  setPlayers([sandboxPlayer]);
  sandboxPlayer.spawnX = useMap(MAPS[0])[0];
  sandboxPlayer.spawn();
  layout(); ui.refresh();
}

function startMatch(cfg, slots) {
  goFullscreen(true); // (started from a click, so the browser allows it)
  resetJuice(); clearClash(); matchOverSeen = false;
  lastMatch = { cfg, slots };
  state.mode = 'match'; state.paused = false; resultsShown = false;
  match = new Match(world, cfg, slots);
  match.players.forEach((p, k) => {
    p.input = createInput();
    if (slots[k].net) p.input.net = slots[k].net;
    p.bot = p.source.startsWith('cpu') ? new Bot(p, p.source.slice(4)) : null;
  });
  setPlayers(match.players);
  match.start(useMap(cfg.map));
  layout();
}

function toMenu() {
  resetJuice(); clearClash(); if (lab) lab.stop();
  state.mode = 'menu'; state.paused = false;
  match = null;
  setPlayers([]);
  useMap(MAPS[0]); // a map behind the menu
  layout();
  screens.updateHUD(null);
}

// Pause / back, shared by Esc and the touch pause button.
function pauseOrBack() {
  if (state.mode === 'guest' && !screens.menuOpen()) screens.showOnlinePause(false);
  else if (state.mode === 'match' && net && !screens.menuOpen()) { state.paused = true; screens.showOnlinePause(true); }
  else if (state.mode === 'match' && !screens.menuOpen()) { state.paused = true; screens.showPause(); }
  else if (state.mode === 'sandbox') { toMenu(); screens.showMain(); }
}

const touch = isTouchDevice ? createTouchControls(document.body, { onPause: () => pauseOrBack() }) : null;
// Desktop move bar: the moves of every player on this computer, under the map.
const moveBar = createMoveBar(document.getElementById('movebar'), { onFullscreen: () => goFullscreen(!(document.fullscreenElement || document.webkitFullscreenElement)) });
function updateMoveBar() {
  const playing = (state.mode === 'match' || state.mode === 'guest') && !isTouchDevice;
  if (!playing) { moveBar.hide(); return; }
  let list;
  if (state.mode === 'guest') {
    const me = guestView.players[guestView.you], hp = guestView.hud && guestView.hud.players[guestView.you];
    list = me && hp ? [{ name: hp.name, color: me.color, tag: me.tag, type: me.type, source: 'local', mask: hp.rd || 0, ult: me.ult, dead: me.dead }] : [];
  } else {
    list = world.players.filter(isHuman).map((p) => ({ name: p.name, color: p.color, tag: p.tag, type: p.type, source: p.source,
      mask: p.dead ? 0 : readyMask(p), ult: p.ult, dead: p.dead, ...slotInfo(p) }));
  }
  if (moveBar.update(list)) layout(); // the bar changed size: re-fit the map above it
}

// Matches take the whole screen (browser fullscreen); F toggles it.
function goFullscreen(on = true) {
  if (isTouchDevice) return;
  const el = document.documentElement, fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (on && !fsEl) Promise.resolve((el.requestFullscreen || el.webkitRequestFullscreen).call(el)).catch(() => {}); // (Safari: webkit-)
    else if (!on && fsEl) Promise.resolve((document.exitFullscreen || document.webkitExitFullscreen).call(document)).catch(() => {});
  } catch { /* not supported */ }
}
document.addEventListener('fullscreenchange', () => layout());
document.addEventListener('webkitfullscreenchange', () => layout());

function updateTouch() { // on-screen controls only while actually playing
  if (!touch) return;
  const tp = state.mode === 'sandbox' ? sandboxPlayer
    : state.mode === 'guest' ? guestView.players[guestView.you]
    : world.players.find((p) => p.source === 'touch' || p.source === 'local');
  touch.show(!!tp && !screens.menuOpen() && !state.paused);
  if (tp) touch.setBender(tp.type);
}

const lab = createLab({ world, getMatch: () => match });
const screens = createScreens(stage, MAPS, {
  onSandbox: startSandbox,
  onStartMatch: startMatch,
  onResume: () => { state.paused = false; },
  onRematch: () => {
    if (!lastMatch) return;
    if (net) { net.startMatch(lastMatch.cfg.map.id); startMatch(lastMatch.cfg, net.slots()); net.baseline(); }
    else startMatch(lastMatch.cfg, lastMatch.slots);
  },
  onQuit: toMenu,
  onHostOnline: hostOnline,
  onLab: () => {
    startMatch({ format: 'duel', win: 'training', map: LAB_MAP, training: true, infinite: true, lab: true },
      [{ name: 'You', type: lab.me, source: 'local', team: 0 }, { name: 'Dummy', type: 'water', source: 'cpu-dummy', team: 1 }]);
    lab.start();
  },
  onStartTraining: (t) => startMatch(
    { format: 'duel', win: 'training', map: MAPS.find((m) => m.id === t.map) || MAPS[0], training: true, infinite: t.infinite },
    [{ name: 'You', type: t.type, source: 'local', team: 0 }, { name: 'Dummy', type: t.dummy, source: 'cpu-' + t.mode, team: 1 }]),
  onJoinOnline: joinOnline,
  onOnlineLobby: () => { if (net) { toMenu(); net.backToLobby(); showHostLobby(); } },
  onOnlineLeave: leaveOnline,
});

// ---------- hosting ----------
function showHostLobby() {
  if (!net || net.inMatch) return;
  screens.showLobby(net.lobby(), {
    isHost: true, you: 0,
    onCfg: (c) => { net.cfg = c; net.lobbyChanged(); },
    onType: (t) => { net.me.type = t; net.lobbyChanged(); },
    onName: (n) => { net.me.name = n; net.lobbyChanged(); },
    onTeam: (k, t) => {
      const live = net.guests.filter((g) => !g.gone);
      if (k === 0) net.me.team = t; else if (live[k - 1]) live[k - 1].team = t; else { net.editBot(k, { team: t }); return; }
      net.lobbyChanged();
    },
    onBot: (k, change) => net.editBot(k, change),
    onStart: () => {
      const c = net.cfg;
      const map = c.map === 'random' ? MAPS[(Math.random() * MAPS.length) | 0] : MAPS.find((m) => m.id === c.map);
      net.startMatch(map.id);
      screens.hideMenu();
      startMatch({ format: c.format, win: c.win, map, custom: c.customKey === 'on', online: true }, net.slots());
      net.baseline(); // guests build the same map themselves
    },
    onLeave: leaveOnline,
  });
}

async function hostOnline() {
  if (!onlineConfigured()) { screens.showOnlineSetupNeeded(); return; }
  if (net) net.close();
  net = new HostSession(grid, {
    onLobby: () => { if (state.mode === 'menu') showHostLobby(); },
    onGuestLeft: (name) => { if (match) match.feed.push({ text: `${name} left`, color: '#9aa0ae', t: match.t }); },
  });
  net.me.name = screens.online.name || 'Host';
  net.me.type = screens.online.type;
  screens.showOnlineMessage('HOSTING', 'creating room...');
  try { await net.open(); showHostLobby(); }
  catch (e) { net = null; screens.showOnlineMessage('COULD NOT HOST', e.message || String(e)); }
}

function leaveOnline() {
  if (net) { net.close(); net = null; }
  if (guest) { guest.leave(); guest = null; }
  toMenu(); screens.showMain();
}

// ---------- joining ----------
function showGuestLobby(status = '') {
  if (!guest || !guestView.lobby) return;
  screens.showLobby(guestView.lobby, {
    isHost: false, you: guestView.you, status,
    onType: (t) => guest.setType(t), onLeave: leaveOnline,
  });
}

async function joinOnline(code, name, type, status) {
  if (!onlineConfigured()) throw new Error('Online is not set up yet (see ONLINE.md)');
  if (guest) guest.leave();
  const g = new GuestSession({
    onLobby: (lobby, you) => { guestView.lobby = lobby; guestView.you = you; if (state.mode !== 'guest') showGuestLobby(); },
    onStart: (cfg) => {
      guestView.map = cfg && cfg.map;
      state.mode = 'guest'; state.paused = false; match = null; mapTick = null; resultsShown = false;
      setPlayers([]);
      loadMap(grid, particles, MAPS.find((m) => m.id === guestView.map) || MAPS[0]); // same map locally; snapshots send only changes
      worldResized(); resetPhysics(); scanPipes(); // (same cars and barrels as the host)
      Object.assign(guestView, { players: [], hud: null, since: 0 });
      screens.hideMenu(); layout();
    },
    onSnapshot: (bytes) => {
      if (state.mode !== 'guest') return;
      const j = applySnapshot(bytes, grid, particles);
      guestView.players = j.p.map(guestPlayer);
      setBursts(j.cb); // clash bursts are drawn locally from the host's list
      guestView.hud = j.h;
      guestView.since = 0;
      if (j.s) for (const [n, x, sz] of j.s) playEvent(n, x, sz);
      if (j.fx) {
        shake = Math.max(shake, j.fx.shake || 0); flash = Math.max(flash, j.fx.flash || 0);
        juice.popups = (j.fx.pu || []).map(([x, y, text, color, life]) => ({ x, y, text, color, life }));
      }
    },
    onResults: (r) => screens.showResults({ result: r }, 'guest'),
    onLobbyBack: () => { toMenu(); showGuestLobby(); },
    onClosed: (why) => { if (guest) guest.leave(); guest = null; toMenu(); screens.showOnlineMessage('DISCONNECTED', why); },
  });
  await g.join(code, name, type, status);
  guest = g;
  if (guestView.lobby) showGuestLobby(); else screens.showOnlineMessage('CONNECTED', 'waiting for the lobby...');
}

// Snapshot player -> object the renderer can draw.
function guestPlayer(v) {
  return {
    x: v.x, y: v.y, vx: v.vx, vy: v.vy, facing: v.f, type: v.t, color: v.c, tag: v.g, dead: !!v.d,
    invulnT: v.iv, flash: v.fl, frozenT: v.fz, waterFormT: v.wf, rag: v.rg ? { x: v.rg[0], y: v.rg[1], a: v.rg[2] } : null, flameHair: !!v.fh, hp: v.hp, energy: v.en, ult: v.u, air: v.a,
    def: BENDER_TYPES[v.t], afterimages: v.ai, channel: v.ch ? { slot: v.ch[0], t: v.ch[1] } : null,
    anim: { j: v.an.j, n: v.an.n, rx: v.an.rx, ry: v.an.ry, state: v.an.s, t: v.an.t, blink: 0 },
  };
}

// HUD data for a guest, shaped like a Match.
function guestHud() {
  const h = guestView.hud;
  if (!h) return null;
  return {
    clockText: () => h.clock, countdown: h.cd, over: h.over, result: null, t: h.t, win: { lives: h.lives }, feed: h.feed,
    players: h.players.map((p, k) => ({ ...p, dead: guestView.players[k]?.dead, hp: guestView.players[k]?.hp ?? 0, ult: guestView.players[k]?.ult ?? 0 })),
  };
}

function guestTick(now) {
  guest.sendInput(sampleInput('local', guestInput), now);
  if (guestView.since++ < 3) { // between snapshots: keep things moving
    for (let i = 0; i < particles.n; i++) { particles.x[i] += particles.vx[i]; particles.y[i] += particles.vy[i]; }
    for (const p of guestView.players) if (!p.dead) { p.x += p.vx; p.y += p.vy; }
  }
}

// ---------- sandbox toolbar (Custom mode only) ----------
const ui = buildUI(state, sandboxPlayer, {
  onSelect: (id) => { state.selected = id; ui.refresh(); },
  onClear: () => { grid.clear(); particles.clear(); },
  onPause: () => { state.paused = !state.paused; ui.refresh(); },
  onHeat: () => { state.heatView = !state.heatView; ui.refresh(); },
  onBender: (type) => { sandboxPlayer.setType(type); ui.refresh(); },
  maps: MAPS,
  onMap: (m) => { sandboxPlayer.spawnX = useMap(m)[0]; sandboxPlayer.spawn(); ui.refresh(); },
});

// ---------- mouse painting (Custom mode only) ----------
const mouse = { x: 0, y: 0, inside: false, down: false, erase: false };
const tools = () => state.mode === 'sandbox' || onlineCustom();
const toolPlayer = () => (state.mode === 'sandbox' ? sandboxPlayer : world.players[0]);

function toGrid(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: view.x + Math.floor(((e.clientX - r.left) / r.width) * view.w),
    y: view.y + Math.floor(((e.clientY - r.top) / r.height) * view.h),
  };
}
const tool = () => (mouse.erase ? EL.EMPTY : state.selected);

function paintLine(x0, y0, x1, y1) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let s = 0; s <= steps; s++) {
    grid.paint(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps), state.brush, tool());
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (!tools()) return;
  canvas.setPointerCapture(e.pointerId);
  const p = toGrid(e);
  Object.assign(mouse, p, { down: true, inside: true, erase: e.button === 2 });
  if (tool() !== WIND_TOOL) grid.paint(p.x, p.y, state.brush, tool());
});
canvas.addEventListener('pointermove', (e) => {
  const p = toGrid(e);
  if (mouse.down && tools()) {
    if (tool() === WIND_TOOL) grid.addWind(p.x, p.y, state.brush, (p.x - mouse.x) * WIND_STRENGTH, (p.y - mouse.y) * WIND_STRENGTH);
    else paintLine(mouse.x, mouse.y, p.x, p.y);
  }
  mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
});
const release = () => { mouse.down = false; };
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', () => { mouse.inside = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  if (!tools()) return;
  e.preventDefault();
  state.brush = Math.max(0, Math.min(MAX_BRUSH, state.brush + (e.deltaY < 0 ? 1 : -1)));
  ui.refresh();
}, { passive: false });

// The debug view's label + legend, top-left of the map.
const debugBadge = document.createElement('div');
debugBadge.className = 'debugbadge';
debugBadge.hidden = true;
debugBadge.innerHTML = '<b>DEBUG</b> wind + heat · <span class="dbg-heat"></span> cold → hot · <i style="color:#ff6a6a">■</i> high pressure <i style="color:#7aa0ff">■</i> vacuum · P to close';
stage.append(debugBadge);

// ---------- keys ----------
const keyToTool = new Map(TOOLS.map((t) => [t.key, t.id]));
const BENDER_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'z', 'x', 'c', 'a', 's', 'v', 'p']);

window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  const k = e.key.toLowerCase();
  if (GAME_KEYS.has(k) || k === ' ') e.preventDefault();

  if (k === 'escape') { pauseOrBack(); return; }
  // Debug view (any mode, online too): wind arrows + heat vision + air pressure. P, or F2 when a
  // second player on this keyboard is using P as an attack key.
  const pTaken = state.mode === 'match' && world.players.some((p) => p.source === 'kb2');
  if ((k === 'p' && !pTaken) || k === 'f2') { e.preventDefault(); state.debugView = !state.debugView; debugBadge.hidden = !state.debugView; return; }
  if (k === 'f' && !tools() && (state.mode === 'match' || state.mode === 'guest')) { goFullscreen(!(document.fullscreenElement || document.webkitFullscreenElement)); return; }
  if (!tools() || BENDER_KEYS.has(k)) return;

  // Custom mode: painting / dev keys. (Bender controls are read from the keyboard state.)
  if (keyToTool.has(k)) state.selected = keyToTool.get(k);
  else if (k === ' ') state.paused = !state.paused;
  else if (k === 'backspace') { grid.clear(); particles.clear(); }
  else if (k === 'h') state.heatView = !state.heatView;
  else if (k === 'u') toolPlayer().ult = 100; // testing: fill the ultimate (it normally charges only from damage dealt)
  else if (k === 'k') toolPlayer().damage(toolPlayer().hp);
  else if (k === '[') state.brush = Math.max(0, state.brush - 1);
  else if (k === ']') state.brush = Math.min(MAX_BRUSH, state.brush + 1);
  else return;
  ui.refresh();
});

// ---------- particle test hose (Custom mode: hold P) ----------
function hose(p, inp) {
  if (p.dead) return;
  let t = state.selected;
  if (t === 0 || t === WIND_TOOL) t = EL.SAND;
  const aim = inp.up ? -1.6 : inp.down ? 0.6 : -0.6;
  for (let k = 0; k < 2; k++) {
    particles.spawn(p.x + 2.5 + p.facing * 3, p.y + 6, p.facing * (2.6 + Math.random() * 0.8) + p.vx, aim + (Math.random() - 0.5) * 0.6,
      t, { bounces: KIND[t] === Kind.POWDER || KIND[t] === Kind.STATIC ? 2 : 0 });
  }
}

// ---------- simulation tick ----------
function tick() {
  if (tools() && mouse.down && tool() !== WIND_TOOL) grid.paint(mouse.x, mouse.y, state.brush, tool());
  grid.step();
  grid.sweepStrays(); // floating debris crumbles and falls
  stepPhysics();      // collapsing buildings, dust, shockwaves
  if (mapTick) mapTick(grid, particles, tickCount++, mapEnv);
  if (match) match.tick();
  if (tools() && isDown('p')) hose(toolPlayer(), sandboxInput);
  particles.step();
  for (const p of world.players) {
    const inp = state.mode === 'sandbox' ? sampleInput(sandboxSource, sandboxInput) : p.bot ? p.bot.update(world) : sampleInput(p.source, p.input);
    p.update(inp);
    updateAbilities(p, inp, world);
    particles.defaultOwner = 0; // particles spawned outside a bender's moves belong to nobody
  }
  lab.tick();               // Clash Lab emitters (when open)
  stepProjectiles(world);   // clash-engine projectiles (fireballs, stones, ice spears ...)
  resolveClashes(world);    // attacks that touched this tick react with each other
  if (match && match.cfg.training) trainingTick(match);
  if (match && match.over && !match.result) victoryTick(match);
  if (match && match.over && !matchOverSeen) { matchOverSeen = true; slowmo(90, 0.3); } // the final KO in slow motion
  if (match && match.result && !resultsShown) {
    resultsShown = true;
    screens.showResults(match, net ? 'host' : undefined);
    if (net) net.sendResults(match.result);
  }
}

// ---------- training ----------
// Optional no-cooldowns / ultimate for you; the dummy heals after 2 s without a hit; damage within
// 1 s of the previous hit adds up into the combo counter.
function trainingTick(m) {
  const me = m.players[0], d = m.players[1];
  if (!me || !d) return;
  if (m.cfg.infinite && !me.dead) { if (!me.channel) for (const k in me.cd) if (me.cd[k] > 2) me.cd[k] = 2; me.ult = 100; }
  m.combo = m.combo || 0; m.best = m.best || 0;
  const prev = d.trainHp ?? d.hp;
  if (!d.dead && d.hp < prev) {
    if (!(m.comboT > 0)) m.combo = 0; // a new combo starts
    m.combo += prev - d.hp; m.comboT = 60; d.quietT = 0;
    m.best = Math.max(m.best, m.combo);
  } else if (m.comboT > 0) m.comboT--;
  if (!d.dead && ++d.quietT > 120 && d.hp < MAX_HP) d.hp = Math.min(MAX_HP, d.hp + 2);
  d.trainHp = d.dead ? MAX_HP : d.hp;
}

// ---------- victory moment ----------
// Between the final KO and the results: the winners power up with an element celebration.
function victoryTick(m) {
  const res = m.computeResult();
  if (!res.winner) return;
  m.t % 2 === 0 && res.winner.players.forEach((p) => {
    if (p.dead) return;
    p.cast = { pose: 'powerup', t: 4 }; p.invulnT = Math.max(p.invulnT || 0, 4); p.stunT = Math.max(p.stunT || 0, 2);
    const cx = p.x + 2.5, cy = p.y + 9, a = m.t * 0.25;
    for (let k = 0; k < 3; k++) {
      const r = Math.random();
      if (p.type === 'fire') particles.spawn(cx + (r - 0.5) * 6, cy + 6, (r - 0.5) * 0.8, -2.5 - Math.random() * 1.5, EL.FIRE, { ghost: true, gravity: 0.04, life: 30 });
      else if (p.type === 'earth') particles.spawn(cx + (r - 0.5) * 14, cy + 7, 0, -1.2 - Math.random(), EL.STONE, { ghost: true, gravity: 0.03, life: 28 });
      else if (p.type === 'water') particles.spawn(cx + Math.cos(a + k * 2.1) * 6, cy + 6 - (m.t % 40) * 0.4, Math.cos(a + k * 2.1) * 0.3, -0.6, EL.WATER, { ghost: true, gravity: 0, life: 24 });
      else particles.spawn(cx + Math.cos(a + k * 2.1) * (4 + k * 2), cy + Math.sin(a + k * 2.1) * 6, -Math.sin(a + k * 2.1) * 1.2, Math.cos(a + k * 2.1) * 0.8 - 0.3, EL.STEAM, { ghost: true, gravity: -0.01, life: 20 });
    }
  });
}

// ---------- loop ----------
let last = performance.now(), acc = 0, frames = 0, statTime = last, netTicks = 0;
let netSounds = []; // sound events waiting for the next snapshot

// Sounds: play what the simulation emitted this frame (only while actually playing, so the idle
// menu map stays quiet), hum the held-move loops, and beep the countdown.
let lastCount = -1, lastOver = false;
// A sound event, or a 'cine:<type>:<color>' ultimate cinematic (slow-mo, darken, name banner).
function playEvent(n, x, s) {
  if (n.startsWith('cine:')) {
    const [, type, color] = n.split(':');
    cinematic(type, color);
    screens.showCine(ULT_NAMES[type] || 'ULTIMATE', color);
    sfx.play('ultcine', x);
    return;
  }
  sfx.play(n, x, s);
}
function sounds() {
  const playing = state.mode === 'sandbox' || state.mode === 'match' || state.mode === 'guest';
  // Music: the fight track while a match is on, the calm track everywhere else.
  const over = state.mode === 'guest' ? guestView.hud && guestView.hud.over : match && match.over;
  setTrack((state.mode === 'match' || state.mode === 'guest') && !over ? 'fight' : 'menu');
  sfx.ambient(playing ? (state.mode === 'guest' ? guestView.map : state.map) : null);
  const events = sfx.drain();
  if (playing && !state.paused) for (const [n, x, s] of events) playEvent(n, x, s);
  if (net && match) netSounds.push(...events.slice(0, 40 - netSounds.length));
  const list = playing && !state.paused ? (state.mode === 'guest' ? guestView.players : world.players) : [];
  sfx.updateLoops(list.map((p, k) => { const c = !p.dead && channelInfo(p.type, p.channel); return { id: k, key: c && c.key, prog: c ? c.prog : 0, x: p.x }; }));
  const m = state.mode === 'guest' ? guestView.hud && { countdown: guestView.hud.cd, over: guestView.hud.over } : match;
  if (!m || !playing) { lastCount = -1; lastOver = false; return; }
  const n = m.countdown > 0 ? Math.ceil(m.countdown / 60) : 0;
  if (n !== lastCount) { if (n > 0) sfx.play('beep'); else if (lastCount > 0) sfx.play('fight'); lastCount = n; }
  if (m.over && !lastOver) sfx.play('game');
  lastOver = !!m.over;
}

function frame(now) {
  const host = state.mode !== 'guest'; // guests just show the host's (already slowed) stream
  acc += Math.min(now - last, 250) * (host && juice.slowT > 0 ? juice.slowRate : 1);
  last = now;
  let steps = 0;
  while (acc >= TICK_MS && steps < 4) {
    if (host && juice.hitstop > 0 && !state.paused) { juice.hitstop--; acc -= TICK_MS; steps++; continue; } // freeze-frame
    if (state.mode === 'guest') { if (guest) guestTick(now); }
    else if (!state.paused) tick();
    acc -= TICK_MS;
    steps++;
  }
  // Online host: one snapshot per frame at most, about 20 a second (every 3 ticks), so a slow frame
  // that runs several ticks doesn't also encode several snapshots.
  netTicks += steps;
  if (net && match && netTicks >= 3) { netTicks = 0; net.sendSnapshot(world, match, { shake, flash, paused: state.paused, pu: juice.popups.map((q) => [Math.round(q.x), Math.round(q.y), q.text, q.color, q.life]) }, netSounds); netSounds = []; }
  if (steps === 4) acc = 0; // too slow: drop backlog instead of spiraling
  if (host) stepJuice();

  sounds();
  updateCamera();
  renderer.draw(state.heatView, state.debugView && !state.heatView);
  if (tools() && mouse.inside) renderer.drawBrush(mouse.x, mouse.y, state.brush);
  renderer.present(state.heatView ? null : state.mode === 'guest' ? guestView.players : world.players, particles, lab.active ? lastEntries : null, state.mode === 'guest' ? null : lastEntries);
  // Brightness: flashes brighten, an ultimate cinematic darkens the world for a moment.
  const cineDim = juice.cine ? Math.max(0.5, 1 - 0.5 * Math.min(1, juice.cine.t / 6, (60 - juice.cine.t) / 15)) : 1;
  if (state.mode === 'guest' && juice.cine && ++juice.cine.t > 70) juice.cine = null; // guests age it here
  if (flash > 0) flash--;
  const bright = (1 + flash * 0.25) * cineDim;
  canvas.style.filter = bright === 1 ? '' : `brightness(${bright.toFixed(2)})`;
  if (shake > 0.2) {
    const sx = (Math.random() - 0.5) * shake * 2, sy = (Math.random() - 0.5) * shake * 2;
    canvas.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    shake *= 0.85;
  } else if (shake) { shake = 0; canvas.style.transform = ''; }

  frames++;
  if (frames % 4 === 0) { screens.updateHUD(state.mode === 'guest' ? guestHud() : match); updateTouch(); updateMoveBar(); }
  if (now - statTime >= 500) {
    state.fps = Math.round((frames * 1000) / (now - statTime));
    state.count = grid.count();
    state.particles = particles.n;
    frames = 0;
    statTime = now;
    if (state.mode === 'sandbox') ui.refresh();
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', layout);
toMenu();
screens.showMain();
requestAnimationFrame(frame);

// Test hook: ?debug exposes the internals to the console.
if (new URLSearchParams(window.location.search).has('debug')) {
  window.__bs = { startMatch, MAPS, useMap, layout, view, musicState, juice, Bot, sfx, state, world, grid, particles, get net() { return net; }, get guest() { return guest; }, guestView, get match() { return match; } };
}
