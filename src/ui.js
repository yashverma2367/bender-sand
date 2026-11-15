// Toolbar (grouped rows) + status line.
import { TOOLS, GROUPS } from './elements.js';
import { BENDER_TYPES, MAX_HP } from './benders.js';

export function buildUI(state, player, { onSelect, onClear, onPause, onHeat, onBender, maps = [], onMap }) {
  const bar = document.getElementById('toolbar');
  const stats = document.getElementById('stats');
  const buttons = new Map();
  const rows = new Map();

  for (const g of ['Map', 'Bender', ...GROUPS]) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="label">${g}</span>`;
    bar.appendChild(row);
    rows.set(g, row);
  }

  function button(row, html, cls, onclick) {
    const b = document.createElement('button');
    b.className = 'tool' + (cls ? ' ' + cls : '');
    b.innerHTML = html;
    b.onclick = onclick;
    row.appendChild(b);
    return b;
  }

  for (const t of TOOLS) {
    const html = `<span class="swatch" style="background:${t.colors[0]}"></span>${t.name}<kbd>${t.key.toUpperCase()}</kbd>`;
    const b = button(rows.get(t.group), html, t.id === 0 ? 'eraser' : '', () => onSelect(t.id));
    buttons.set(t.id, b);
  }

  const benderButtons = new Map();
  for (const [id, d] of Object.entries(BENDER_TYPES)) {
    const html = `<span class="swatch" style="background:${d.palette.B}"></span>${d.name}`;
    benderButtons.set(id, button(rows.get('Bender'), html, '', () => onBender(id)));
  }

  const mapButtons = new Map();
  for (const m of maps) mapButtons.set(m.id, button(rows.get('Map'), m.name, '', () => onMap(m)));

  const tools = rows.get('Tools');
  const pauseBtn = button(tools, '', 'action', onPause);
  const heatBtn = button(tools, 'Heat view<kbd>H</kbd>', 'action', onHeat);
  button(tools, 'Clear<kbd>⌫</kbd>', 'action', onClear);

  return {
    refresh() {
      buttons.forEach((b, id) => b.classList.toggle('active', id === state.selected));
      pauseBtn.innerHTML = (state.paused ? 'Play' : 'Pause') + '<kbd>Space</kbd>';
      heatBtn.classList.toggle('active', state.heatView);
      benderButtons.forEach((b, id) => b.classList.toggle('active', id === player.type));
      mapButtons.forEach((b, id) => b.classList.toggle('active', id === state.map));
      const who = `${player.def.name} bender ` +
        (player.dead ? `· respawning`
          : `HP ${Math.ceil(player.hp)} · energy ${Math.floor(player.energy)} · ult ${player.ult >= 100 ? 'READY' : Math.floor(player.ult) + '%'}`);
      stats.textContent = `${who} · ${state.fps} fps · ${state.count} cells · ${state.particles || 0} flying · brush ${state.brush}` +
        (state.paused ? ' · paused' : '') + (state.heatView ? ' · heat view' : '');
    },
  };
}
