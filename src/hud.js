// Screens drawn as HTML over the canvas: main menu, local match setup, pause menu, the in-match
// HUD (player cards, clock, kill feed, countdown / KO banners) and the results screen.
import { BENDER_TYPES, MAX_HP } from './benders.js';
import { FORMATS, WINS, PLAYER_COLORS, TEAM_COLORS, TEAM_NAMES } from './match.js';
import { INPUT_SOURCES } from './input.js';
import { isTouchDevice } from './touch.js';
import { play, isMuted, setMuted } from './sfx.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

export function createScreens(stage, maps, handlers) {
  const menu = el('div', 'overlay menu');
  const hud = el('div', 'hud');
  stage.append(hud, menu);

  const setup = { // remembered between matches
    format: 'ffa', win: 'kos', map: 'random',
    slots: [
      { on: true, name: 'Player 1', type: 'fire', source: isTouchDevice ? 'touch' : 'kb1', team: 0 },
      { on: true, name: 'Player 2', type: 'water', source: 'kb2', team: 0 },
      { on: false, name: 'Player 3', type: 'earth', source: 'pad0', team: 1 },
      { on: false, name: 'Player 4', type: 'air', source: 'pad1', team: 1 },
    ],
  };

  function show(node) { menu.innerHTML = ''; menu.append(node); menu.style.display = 'flex'; }
  function hideMenu() { menu.style.display = 'none'; menu.innerHTML = ''; }
  function button(text, onclick, cls = '') { const b = el('button', 'btn ' + cls, text); b.onclick = (e) => { play('click'); onclick(e); }; return b; }
  function soundButton() {
    const b = button(isMuted() ? 'Sound: Off' : 'Sound: On', () => { setMuted(!isMuted()); b.textContent = isMuted() ? 'Sound: Off' : 'Sound: On'; });
    return b;
  }

  // ---------- main menu ----------
  function showMain() {
    const box = el('div', 'panel');
    box.append(el('h2', 'title', 'BENDER SAND'), el('div', 'sub', 'elemental sand-sim brawler'));
    box.append(button('Local Match', showSetup, 'primary'));
    box.append(button('Custom (sandbox, all tools)', () => { hideMenu(); handlers.onSandbox(); }));
    box.append(button('Host Online', () => handlers.onHostOnline()));
    box.append(button('Join Online', () => showJoin()));
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
    box.append(choice('Win', WINS, 'win'));
    box.append(choice('Map', { random: { name: 'Random' }, ...Object.fromEntries(maps.map((m) => [m.id, m])) }, 'map'));

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
      row.append(toggle, name,
        sel(Object.entries(BENDER_TYPES).map(([id, d]) => [id, d.name]), 'type'),
        sel(Object.entries(INPUT_SOURCES), 'source'));
      if (f.teams) row.append(sel([[0, `${TEAM_NAMES[0]} team`], [1, `${TEAM_NAMES[1]} team`]], 'team'));
      table.append(row);
    });
    box.append(table);

    const err = el('div', 'err');
    const active = setup.slots.filter((s) => s.on);
    const problems = [];
    if (active.length < f.min || active.length > f.max) problems.push(`${f.name} needs ${f.min === f.max ? f.min : f.min + '-' + f.max} players`);
    if (new Set(active.map((s) => s.source)).size < active.length) problems.push('two players share the same controls');
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
    box.append(soundButton());
    box.append(button('Quit to Menu', () => { handlers.onQuit(); showMain(); }));
    show(box);
  }

  // ---------- results ----------
  // online: undefined (local), 'host' or 'guest'
  function showResults(match, online) {
    const { winner, sides } = match.result;
    const box = el('div', 'panel wide');
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
      try { await handlers.onJoinOnline(online.code, online.name || 'Guest', online.type); }
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
      choice('Map', { random: { name: 'Random' }, ...Object.fromEntries(maps.map((m) => [m.id, m])) }, 'map'),
      choice('Tools', { off: { name: 'Normal' }, on: { name: 'Custom (host gets all tools)' } }, 'customKey'));

    const f = FORMATS[cfg.format];
    const table = el('div', 'slots');
    lobby.players.forEach((p, k) => {
      const row = el('div', 'slot');
      const color = f.teams ? TEAM_COLORS[p.team] : PLAYER_COLORS[k];
      const tag = el('span', 'ptag', p.host ? 'HOST' : `P${k + 1}`); tag.style.borderColor = color; tag.style.color = color;
      row.append(tag);
      const mine = k === ctl.you;
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
    for (let k = lobby.players.length; k < 4; k++) table.append(el('div', 'slot off', `<span class="pname">open slot</span>`));
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
    box.append(soundButton());
    box.append(button(isHost ? 'Close Room' : 'Leave Match', () => handlers.onOnlineLeave()));
    show(box);
  }

  // ---------- in-match HUD ----------
  const cards = el('div', 'cards'), clock = el('div', 'clock'), feed = el('div', 'feed'), banner = el('div', 'banner');
  hud.append(cards, clock, feed, banner);

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
        `<div class="bar ult"><i style="width:${p.ult}%"></i></div>`;
      cards.append(c);
    }
    feed.innerHTML = match.feed.slice(-5).map((f) => `<div style="color:${f.color}">${f.text}</div>`).join('');
    const cd = match.countdown;
    banner.textContent = cd > 0 ? String(Math.ceil(cd / 60))
      : match.over && !match.result ? 'GAME!'
      : match.t < 180 + 45 ? 'FIGHT!' : '';
  }

  return { showMain, showSetup, showPause, showResults, showJoin, showLobby, showOnlinePause, showOnlineSetupNeeded, showOnlineMessage, online, hideMenu, updateHUD, menuOpen: () => menu.style.display !== 'none' };
}
