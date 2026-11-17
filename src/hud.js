// Screens drawn as HTML over the canvas: main menu, local match setup, pause menu, the in-match
// HUD (player cards, clock, kill feed, countdown / KO banners) and the results screen.
import { BENDER_TYPES, MAX_HP } from './benders.js';
import { FORMATS, WINS, PLAYER_COLORS, TEAM_COLORS, TEAM_NAMES } from './match.js';
import { INPUT_SOURCES } from './input.js';
import { isTouchDevice } from './touch.js';
import { play, isMuted, setMuted } from './sfx.js';
import { musicEnabled, setMusic } from './music.js';
import { CONTROLS, MOVES, COMBOS } from './info.js';
import { readyMask } from './abilities.js';
import { createAnim, updateAnim, drawSprite } from './sprite.js';
import { pack } from './elements.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

export function createScreens(stage, maps, handlers) {
  const BENDER_COLORS = { fire: '#ff6a3d', earth: '#7fbf5a', water: '#4ea8ff', air: '#f2c84b' };
  const menu = el('div', 'overlay menu');
  const hud = el('div', 'hud');
  stage.append(hud, menu);

  const setup = { // remembered between matches
    format: 'ffa', win: 'kos', map: 'random',
    slots: [
      { on: true, name: 'Player 1', type: 'fire', source: isTouchDevice ? 'touch' : 'kb1', team: 0 },
      { on: true, name: 'Player 2', type: 'water', source: isTouchDevice ? 'cpu-normal' : 'kb2', team: 0 },
      { on: false, name: 'Player 3', type: 'earth', source: 'pad0', team: 1 },
      { on: false, name: 'Player 4', type: 'air', source: 'pad1', team: 1 },
    ],
  };

  function show(node) { menu.innerHTML = ''; menu.append(node); menu.style.display = 'flex'; }
  function hideMenu() { menu.style.display = 'none'; menu.innerHTML = ''; }
  function button(text, onclick, cls = '') { const b = el('button', 'btn ' + cls, text); b.onclick = (e) => { play('click'); onclick(e); }; return b; }
  function soundButton() { // Sound + Music toggles side by side
    const row = el('div', 'choice');
    const b = button(isMuted() ? 'Sound: Off' : 'Sound: On', () => { setMuted(!isMuted()); b.textContent = isMuted() ? 'Sound: Off' : 'Sound: On'; });
    const m = button(musicEnabled() ? 'Music: On' : 'Music: Off', () => { setMusic(!musicEnabled()); m.textContent = musicEnabled() ? 'Music: On' : 'Music: Off'; });
    b.style.flex = m.style.flex = '1';
    row.append(b, m);
    return row;
  }

  // ---------- main menu ----------
  function showMain() {
    const box = el('div', 'panel');
    box.append(el('h2', 'title', 'BENDER SAND'), el('div', 'sub', 'elemental sand-sim brawler'));
    box.append(button('Local Match', showSetup, 'primary'));
    box.append(button('Training', showTraining));
    box.append(button('Clash Lab (test attack interactions)', () => { hideMenu(); handlers.onLab(); }));
    box.append(button('Custom (sandbox, all tools)', () => { hideMenu(); handlers.onSandbox(); }));
    box.append(button('Host Online', () => handlers.onHostOnline()));
    box.append(button('Join Online', () => showJoin()));
    box.append(button('How to Play &middot; Combos', () => showInfo('combos', showMain)));
    box.append(soundButton());
    box.append(el('div', 'hint', isTouchDevice ? 'touch: left thumb joystick, right thumb buttons (hold to charge) &middot; play in landscape'
      : 'P1: arrows + Z X C A S V &nbsp;&middot;&nbsp; P2: I J K L + U O P H N M &nbsp;&middot;&nbsp; gamepads: stick + A / X Y RB LB B RT'));
    show(box);
  }

  // ---------- local match setup ----------
  function showSetup() {
    const box = el('div', 'panel wide');
    box.append(el('h2', 'title small', 'LOCAL MATCH'));

    const choice = (label, options, key, onchange) => {
      const row = el('div', 'choice'); row.append(el('span', 'clabel', label));
      for (const [id, o] of Object.entries(options)) {
        const b = button(o.name, () => { setup[key] = id; if (onchange) onchange(); showSetup(); }, setup[key] === id ? 'active' : '');
        row.append(b);
      }
      return row;
    };
    box.append(choice('Format', FORMATS, 'format', () => {
      const f = FORMATS[setup.format];
      setup.slots.forEach((s, k) => { s.on = k < f.min || (s.on && k < f.max); });
      if (f.teams) setup.slots.forEach((s, k) => { s.team = k < 2 ? 0 : 1; });
    }));
    box.append(choice('Win', Object.fromEntries(Object.entries(WINS).filter(([, w]) => !w.hidden)), 'win'));
    if (maps.length > 1) box.append(choice('Map', { random: { name: 'Random' }, ...Object.fromEntries(maps.map((m) => [m.id, m])) }, 'map'));

    const f = FORMATS[setup.format];
    const table = el('div', 'slots');
    setup.slots.forEach((s, k) => {
      const row = el('div', 'slot' + (s.on ? '' : ' off'));
      const color = f.teams ? TEAM_COLORS[s.team] : PLAYER_COLORS[k];
      const toggle = button(s.on ? '&#10003;' : '+', () => {
        const count = setup.slots.filter((x) => x.on).length;
        if (s.on && count <= f.min) return; if (!s.on && count >= f.max) return;
        s.on = !s.on; showSetup();
      }, 'toggle');
      toggle.style.borderColor = color;
      const name = el('input'); name.value = s.name; name.maxLength = 12; name.oninput = () => { s.name = name.value || `Player ${k + 1}`; };
      const sel = (opts, key) => { const d = el('select'); for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; if (s[key] === v) o.selected = true; d.append(o); } d.onchange = () => { s[key] = isNaN(+d.value) ? d.value : +d.value; showSetup(); }; return d; };
      const bb = button('', () => showBenderPicker(s.type, (t) => { s.type = t; showSetup(); }, showSetup, `PLAYER ${k + 1} BENDER`), 'bpick');
      bb.append(portrait(s.type, 2), document.createTextNode(' ' + BENDER_TYPES[s.type].name));
      bb.style.color = BENDER_COLORS[s.type];
      row.append(toggle, name, bb, sel(Object.entries(INPUT_SOURCES), 'source'));
      if (f.teams) row.append(sel([[0, `${TEAM_NAMES[0]} team`], [1, `${TEAM_NAMES[1]} team`]], 'team'));
      table.append(row);
    });
    box.append(table);

    const err = el('div', 'err');
    const active = setup.slots.filter((s) => s.on);
    const problems = [];
    if (active.length < f.min || active.length > f.max) problems.push(`${f.name} needs ${f.min === f.max ? f.min : f.min + '-' + f.max} players`);
    const humans = active.filter((s) => !s.source.startsWith('cpu'));
    if (new Set(humans.map((s) => s.source)).size < humans.length) problems.push('two players share the same controls');
    if (!humans.length) problems.push('at least one human player');
    if (f.teams && active.filter((s) => s.team === 0).length !== 2) problems.push('2v2 needs two players on each team');
    err.textContent = problems.join(' · ');
    box.append(err);

    const actions = el('div', 'actions');
    actions.append(button('Back', showMain), button('Start Match', () => {
      if (problems.length) return;
      const map = setup.map === 'random' ? maps[(Math.random() * maps.length) | 0] : maps.find((m) => m.id === setup.map);
      hideMenu();
      handlers.onStartMatch({ format: setup.format, win: setup.win, map }, active.map((s) => ({ ...s })));
    }, problems.length ? 'disabled' : 'primary'));
    box.append(actions);
    show(box);
  }

  // ---------- pause ----------
  function showPause() {
    const box = el('div', 'panel');
    box.append(el('h2', 'title small', 'PAUSED'));
    box.append(button('Resume', () => { hideMenu(); handlers.onResume(); }, 'primary'));
    box.append(button('Restart Match', () => { hideMenu(); handlers.onRematch(); }));
    box.append(button('How to Play &middot; Combos', () => showInfo('combos', showPause)));
    box.append(soundButton());
    box.append(button('Quit to Menu', () => { handlers.onQuit(); showMain(); }));
    show(box);
  }

  // ---------- results ----------
  // online: undefined (local), 'host' or 'guest'
  function showResults(match, online) {
    const { winner, sides } = match.result;
    const box = el('div', 'panel wide');
    const wType = winner && (winner.type || (winner.players && winner.players[0] && winner.players[0].type));
    if (wType) { const pr = portrait(wType, 7, 'powerup'); pr.classList.add('winner'); pr.style.setProperty('--c', winner.color); box.append(pr); }
    box.append(el('h2', 'title', winner ? `${winner.name} WINS` : 'DRAW'));
    if (winner) box.querySelector('h2').style.color = winner.color;
    const table = el('div', 'results');
    for (const s of sides) for (const p of s.players) {
      const row = el('div', 'rrow');
      row.append(el('span', 'dot', ''), el('span', 'rname', p.name), el('span', 'rtype', BENDER_TYPES[p.type].name),
        el('span', 'rstat', `${p.kos} KOs`), el('span', 'rstat', `${p.deaths} deaths`));
      row.querySelector('.dot').style.background = p.color;
      table.append(row);
    }
    box.append(table);
    const actions = el('div', 'actions');
    if (online === 'host') actions.append(button('Back to Lobby', () => handlers.onOnlineLobby()), button('Rematch', () => { hideMenu(); handlers.onRematch(); }, 'primary'));
    else if (online === 'guest') { box.append(el('div', 'hint', 'waiting for the host: rematch or back to lobby')); actions.append(button('Leave', () => handlers.onOnlineLeave())); }
    else actions.append(button('Menu', () => { handlers.onQuit(); showMain(); }), button('Rematch', () => { hideMenu(); handlers.onRematch(); }, 'primary'));
    box.append(actions);
    show(box);
  }

  // ---------- online ----------
  const benderOptions = () => Object.entries(BENDER_TYPES).map(([id, d]) => [id, d.name]);
  function select(opts, value, onchange) {
    const d = el('select', 'sel');
    for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; if (String(value) === String(v)) o.selected = true; d.append(o); }
    d.onchange = () => onchange(d.value);
    return d;
  }
  const online = { name: localStorage.getItem('bs-name') || '', type: 'fire', code: '' };
  const saveName = () => { try { localStorage.setItem('bs-name', online.name); } catch { /* private mode */ } };

  function showOnlineSetupNeeded() {
    const box = el('div', 'panel');
    box.append(el('h2', 'title small', 'ONLINE NOT SET UP'));
    box.append(el('div', 'hint', 'Online play needs a Firebase Realtime Database URL in <b>src/net-config.js</b>.<br>See ONLINE.md for the 5-minute setup.'));
    box.append(button('Back', showMain));
    show(box);
  }

  function nameInput() {
    const name = el('input', 'txt'); name.placeholder = 'your name'; name.maxLength = 12; name.value = online.name;
    name.oninput = () => { online.name = name.value.trim(); saveName(); };
    return name;
  }

  function showJoin(status = '') {
    const box = el('div', 'panel');
    box.append(el('h2', 'title small', 'JOIN ONLINE'));
    const code = el('input', 'txt code'); code.placeholder = 'ROOM CODE'; code.maxLength = 4; code.value = online.code;
    code.oninput = () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, ''); online.code = code.value; };
    const row = (label, node) => { const r = el('div', 'choice'); r.append(el('span', 'clabel', label), node); return r; };
    box.append(row('Code', code), row('Name', nameInput()), row('Bender', select(benderOptions(), online.type, (v) => { online.type = v; })));
    const st = el('div', 'err', status);
    box.append(st);
    const go = button('Join', async () => {
      if (online.code.length !== 4) { st.textContent = 'enter the 4-letter room code'; return; }
      st.style.color = '#9aa0ae'; st.textContent = 'connecting...';
      try { await handlers.onJoinOnline(online.code, online.name || 'Guest', online.type, (t) => { st.textContent = t; }); }
      catch (e) { st.style.color = ''; st.textContent = e.message || String(e); }
    }, 'primary');
    const actions = el('div', 'actions'); actions.append(button('Back', showMain), go);
    box.append(actions);
    show(box);
    setTimeout(() => code.focus(), 0);
  }

  // lobby: { code, cfg, players: [{ name, type, team, host }] }. ctl: callbacks; host can edit settings.
  function showLobby(lobby, ctl) {
    const host = ctl.isHost;
    const box = el('div', 'panel wide');
    box.append(el('h2', 'title small', 'ONLINE LOBBY'));
    box.append(el('div', 'roomcode', `room code <b>${lobby.code || '....'}</b>`));
    box.append(el('div', 'hint', host ? 'share this code with friends: Join Online, type the code' : 'waiting for the host to start the match'));

    const cfg = lobby.cfg;
    const choice = (label, options, key) => {
      const row = el('div', 'choice'); row.append(el('span', 'clabel', label));
      for (const [id, o] of Object.entries(options)) {
        const b = button(o.name, () => host && ctl.onCfg({ ...cfg, [key]: id }), (cfg[key] === id ? 'active' : '') + (host ? '' : ' static'));
        row.append(b);
      }
      return row;
    };
    box.append(choice('Format', FORMATS, 'format'), choice('Win', WINS, 'win'),
      ...(maps.length > 1 ? [choice('Map', { random: { name: 'Random' }, ...Object.fromEntries(maps.map((m) => [m.id, m])) }, 'map')] : []),
      choice('Tools', { off: { name: 'Normal' }, on: { name: 'Custom (host gets all tools)' } }, 'customKey'));

    const f = FORMATS[cfg.format];
    const table = el('div', 'slots');
    lobby.players.forEach((p, k) => {
      const row = el('div', 'slot');
      const color = f.teams ? TEAM_COLORS[p.team] : PLAYER_COLORS[k];
      const tag = el('span', 'ptag', p.host ? 'HOST' : `P${k + 1}`); tag.style.borderColor = color; tag.style.color = color;
      row.append(tag);
      const mine = k === ctl.you;
      if (p.cpu !== undefined) {
        row.append(el('span', 'pname', p.name));
        if (host) {
          row.append(select(benderOptions(), p.type, (v) => ctl.onBot(k, { type: v })));
          row.append(select([['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], p.cpu, (v) => ctl.onBot(k, { level: v })));
          if (f.teams) row.append(select([[0, `${TEAM_NAMES[0]} team`], [1, `${TEAM_NAMES[1]} team`]], p.team, (v) => ctl.onTeam(k, +v)));
          row.append(button('&times;', () => ctl.onBot(k, null), 'toggle'));
        } else row.append(el('span', 'ptype', `${BENDER_TYPES[p.type]?.name} · CPU ${p.cpu}`));
        table.append(row);
        return;
      }
      if (mine && host) { const n = nameInput(); n.onchange = () => ctl.onName(online.name || 'Host'); row.append(n); }
      else row.append(el('span', 'pname', p.name + (mine ? ' (you)' : '')));
      if (mine) row.append(select(benderOptions(), p.type, (v) => { online.type = v; ctl.onType(v); }));
      else row.append(el('span', 'ptype', BENDER_TYPES[p.type]?.name || p.type));
      if (f.teams) {
        if (host) row.append(select([[0, `${TEAM_NAMES[0]} team`], [1, `${TEAM_NAMES[1]} team`]], p.team, (v) => ctl.onTeam(k, +v)));
        else row.append(el('span', 'ptype', `${TEAM_NAMES[p.team]} team`));
      }
      table.append(row);
    });
    for (let k = lobby.players.length; k < 4; k++) {
      const r = el('div', 'slot off', `<span class="pname">open slot</span>`);
      if (host) { const b = button('+ CPU', () => ctl.onBot(-1, {}), 'addcpu'); r.classList.remove('off'); r.querySelector('.pname').style.opacity = 0.4; r.append(b); }
      table.append(r);
    }
    box.append(table);

    const problems = [];
    const n = lobby.players.length;
    if (n < f.min || n > f.max) problems.push(`${f.name} needs ${f.min === f.max ? f.min : f.min + '-' + f.max} players`);
    if (f.teams && lobby.players.filter((p) => p.team === 0).length !== 2) problems.push('2v2 needs two players on each team');
    box.append(el('div', 'err', host ? problems.join(' · ') : (ctl.status || '')));

    const actions = el('div', 'actions');
    actions.append(button('Leave', () => ctl.onLeave()));
    if (host) actions.append(button('Start Match', () => { if (!problems.length) ctl.onStart(); }, problems.length ? 'disabled' : 'primary'));
    box.append(actions);
    show(box);
  }

  function showOnlineMessage(title, text) {
    const box = el('div', 'panel');
    box.append(el('h2', 'title small', title), el('div', 'hint', text), button('OK', showMain, 'primary'));
    show(box);
  }

  function showOnlinePause(isHost) {
    const box = el('div', 'panel');
    box.append(el('h2', 'title small', isHost ? 'PAUSED' : 'MENU'));
    if (!isHost) box.append(el('div', 'hint', 'the match keeps running'));
    box.append(button('Resume', () => { hideMenu(); handlers.onResume(); }, 'primary'));
    if (isHost) box.append(button('Back to Lobby', () => handlers.onOnlineLobby()));
    box.append(button('How to Play &middot; Combos', () => showInfo('combos', () => showOnlinePause(isHost))));
    box.append(soundButton());
    box.append(button(isHost ? 'Close Room' : 'Leave Match', () => handlers.onOnlineLeave()));
    show(box);
  }

  // ---------- pixel portraits ----------
  // The bender's real sprite (idle, or a cast pose) drawn into a small canvas, scaled up crisp.
  function portrait(type, scale = 6, pose = null) {
    const W = 22, H = 26, cv = el('canvas', 'portrait');
    cv.width = W; cv.height = H; cv.style.width = W * scale + 'px'; cv.style.height = H * scale + 'px';
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), buf = new Uint32Array(img.data.buffer);
    const d = BENDER_TYPES[type], pal = {};
    for (const [k, v] of Object.entries(d.palette)) pal[k] = pack(v);
    const dark = (hex) => { const n = parseInt(hex.slice(1), 16); return pack('#' + [16, 8, 0].map((sh) => Math.round(((n >> sh) & 255) * 0.7).toString(16).padStart(2, '0')).join('')); };
    pal.D = dark(d.palette.B); pal.K = dark(d.palette.L); pal.Z = dark(d.palette.S); pal.G = dark(d.palette.F);
    const p = { x: 8, y: 5, facing: 1, def: d, vx: 0, vy: 0, onGround: true, aimTilt: 0 };
    p.anim = createAnim(p);
    if (pose) {
      p.cast = { pose, t: 10 }; p.moveDir = 0; p.windX = 0; p.usedDouble = false; p.grid = null;
      try { for (let k = 0; k < 12; k++) updateAnim(p, { submerged: false, liquidFrac: 0 }, 0); } catch { p.anim = createAnim(p); } // pose it (idle if that fails)
    }
    drawSprite(p, (x, y, c) => { if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] = c; }, pal, false, pack('#ffffff'));
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // ---------- bender picker cards ----------
  function showBenderPicker(current, onPick, back, title = 'CHOOSE YOUR BENDER') {
    const box = el('div', 'panel wide picker');
    box.append(el('h2', 'title small', title));
    const row = el('div', 'cards4');
    for (const [id, d] of Object.entries(BENDER_TYPES)) {
      const card = el('button', 'bcard' + (id === current ? ' active' : ''));
      card.style.setProperty('--c', BENDER_COLORS[id]);
      card.append(portrait(id, 6), el('div', 'bname', d.name));
      card.append(el('div', 'bmoves', MOVES[id].map(([k, n]) => `<span><kbd>${k}</kbd> ${n}</span>`).join('')));
      card.onclick = () => { play('click'); onPick(id); };
      row.append(card);
    }
    box.append(row);
    const actions = el('div', 'actions'); actions.append(button('Back', back));
    box.append(actions);
    show(box);
  }

  // ---------- training ----------
  const training = { type: 'fire', dummy: 'earth', mode: 'dummy', map: 'city', infinite: true };
  function showTraining() {
    const box = el('div', 'panel wide');
    box.append(el('h2', 'title small', 'TRAINING'));
    const pickRow = (label, key) => {
      const r = el('div', 'choice'); r.append(el('span', 'clabel', label));
      const b = button('', () => showBenderPicker(training[key], (t) => { training[key] = t; showTraining(); }, showTraining, key === 'type' ? 'YOUR BENDER' : 'DUMMY BENDER'));
      b.append(portrait(training[key], 2), document.createTextNode(' ' + BENDER_TYPES[training[key]].name));
      b.style.color = BENDER_COLORS[training[key]];
      r.append(b); return r;
    };
    const opt = (label, options, key) => {
      const r = el('div', 'choice'); r.append(el('span', 'clabel', label));
      for (const [id, name] of options) r.append(button(name, () => { training[key] = id; showTraining(); }, training[key] === id ? 'active' : ''));
      return r;
    };
    box.append(pickRow('You', 'type'), pickRow('Dummy', 'dummy'),
      opt('Dummy', [['dummy', 'Stands still'], ['walker', 'Walks around'], ['easy', 'Fights back (Easy CPU)']], 'mode'),
      ...(maps.length > 1 ? [opt('Map', maps.map((m) => [m.id, m.name]), 'map')] : []),
      opt('Mana', [[true, 'Infinite mana + ultimate'], [false, 'Normal']], 'infinite'));
    box.append(el('div', 'hint', 'combo counter on top · the dummy heals after 2 s without a hit · Esc to leave'));
    const actions = el('div', 'actions');
    actions.append(button('Back', showMain), button('Start Training', () => { hideMenu(); handlers.onStartTraining({ ...training }); }, 'primary'));
    box.append(actions);
    show(box);
  }

  // ---------- how to play: controls / moves / combos ----------
  function showInfo(tab = 'combos', back = showMain, bender = 'fire') {
    const box = el('div', 'panel wide info');
    box.append(el('h2', 'title small', 'HOW TO PLAY'));
    const tabs = el('div', 'choice');
    for (const [id, name] of [['controls', 'Controls'], ['moves', 'Moves'], ['combos', 'Combos']]) {
      tabs.append(button(name, () => showInfo(id, back, bender), tab === id ? 'active' : ''));
    }
    box.append(tabs);
    const body = el('div', 'infobody');
    if (tab === 'controls') {
      for (const [k, v] of CONTROLS) { const r = el('div', 'irow'); r.append(el('span', 'ikey', k), el('span', 'itext', v)); body.append(r); }
    } else if (tab === 'moves') {
      const pick = el('div', 'choice');
      for (const t of Object.keys(MOVES)) {
        const b = button(BENDER_TYPES[t].name, () => showInfo('moves', back, t), bender === t ? 'active' : '');
        b.style.color = BENDER_COLORS[t];
        pick.append(b);
      }
      body.append(pick);
      for (const [k, name, d] of MOVES[bender]) {
        const r = el('div', 'irow');
        r.append(el('kbd', 'ibadge', k), el('span', 'iname', name), el('span', 'itext', d));
        body.append(r);
      }
    } else {
      for (const [name, how, result, who] of COMBOS) {
        const r = el('div', 'combo');
        const tag = el('span', 'ctag', who ? BENDER_TYPES[who].name : 'Anyone');
        tag.style.color = who ? BENDER_COLORS[who] : '#9aa0ae';
        tag.style.borderColor = tag.style.color;
        r.append(el('div', 'chead', ''), el('div', 'chow', how), el('div', 'cres', result));
        r.querySelector('.chead').append(el('b', '', name), tag);
        body.append(r);
      }
    }
    box.append(body);
    const actions = el('div', 'actions');
    actions.append(button('Back', back, 'primary'));
    box.append(actions);
    show(box);
  }

  // ---------- ultimate cinematic banner ----------
  const cine = el('div', 'cine');
  stage.append(cine);
  function showCine(name, color) {
    cine.innerHTML = `<div class="cine-bar" style="--c:${color}"><span>${name}</span></div>`;
    cine.classList.remove('go'); void cine.offsetWidth; cine.classList.add('go');
  }

  // ---------- in-match HUD ----------
  const cards = el('div', 'cards'), clock = el('div', 'clock'), feed = el('div', 'feed'), banner = el('div', 'banner');
  hud.append(cards, clock, feed, banner);

  // Move-ready lights (Z X C A S V) + orbs in hand.
  const PIP_KEYS = ['Z', 'X', 'C', 'A', 'S', 'V'];
  function pips(p) {
    const m = p.rd !== undefined ? p.rd : p.dead ? 0 : readyMask(p);
    const orbs = p.orbN !== undefined ? p.orbN : p.orbs ? p.orbs.list.length : 0;
    return `<div class="pips">${PIP_KEYS.map((k, i) => `<span class="${m & (1 << i) ? 'on' : ''}${i === 5 ? ' ult' : ''}">${k}</span>`).join('')}` +
      (orbs ? `<b class="orbn">${'&#9679;'.repeat(orbs)}</b>` : '') + '</div>';
  }

  function updateHUD(match) {
    if (!match) { hud.style.display = 'none'; return; }
    hud.style.display = 'block';
    clock.textContent = match.clockText();
    cards.innerHTML = '';
    for (const p of match.players) {
      const c = el('div', 'card' + (p.out ? ' out' : ''));
      c.style.borderColor = p.color;
      const lives = match.win.lives ? ` · ${'&#9829;'.repeat(Math.max(0, p.lives))}` : '';
      c.innerHTML = `<div class="cname" style="color:${p.color}">${p.name}</div>` +
        `<div class="cinfo">${BENDER_TYPES[p.type].name} · ${p.kos} KO${lives}</div>` +
        `<div class="bar"><i style="width:${p.dead ? 0 : Math.max(0, (p.hp / MAX_HP) * 100)}%"></i></div>` +
        `<div class="bar ult"><i style="width:${p.ult}%"></i></div>` + pips(p);
      cards.append(c);
    }
    feed.innerHTML = match.feed.slice(-5).map((f) => `<div style="color:${f.color}">${f.text}</div>`).join('');
    const cd = match.countdown;
    banner.textContent = cd > 0 ? String(Math.ceil(cd / 60))
      : match.over && !match.result ? 'GAME!'
      : match.t < 180 + 45 ? 'FIGHT!' : '';
  }

  return { showCine, showInfo, showMain, showSetup, showPause, showResults, showJoin, showLobby, showOnlinePause, showOnlineSetupNeeded, showOnlineMessage, online, hideMenu, updateHUD, menuOpen: () => menu.style.display !== 'none' };
}
