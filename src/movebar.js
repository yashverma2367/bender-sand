// Desktop control bar under the map during a match: for every player on this computer, their
// six moves as buttons (key + name), lit when ready, dimmed with a refill bar while cooling down,
// plus the movement keys. Clicking / holding a button presses
// that key, so it doubles as a mouse control.
import { MOVES } from './info.js';
import { KEYMAPS, virtualKey } from './input.js';

const SLOTS = ['basic', 'heavy', 'special', 'defense', 'mobility', 'ultimate'];
const PAD_LABELS = { basic: 'X', heavy: 'Y', special: 'RB', defense: 'LB', mobility: 'B', ultimate: 'RT' };
const KEY_LABEL = (k) => ({ arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' }[k] || k.toUpperCase());

// Keys for an input source: { slots: {slot: label}, keys: {slot: key or null}, move: 'text' }.
function controlsFor(source) {
  const km = KEYMAPS[source === 'local' ? 'kb1' : source];
  if (km) {
    return {
      labels: Object.fromEntries(SLOTS.map((s) => [s, KEY_LABEL(km[s])])),
      keys: Object.fromEntries(SLOTS.map((s) => [s, km[s]])),
      move: `${KEY_LABEL(km.left)} ${KEY_LABEL(km.right)} move · ${KEY_LABEL(km.up)} jump · hold ${KEY_LABEL(km.up)}/${KEY_LABEL(km.down)} while attacking to aim`,
    };
  }
  if (source && source.startsWith('pad')) {
    return { labels: PAD_LABELS, keys: {}, move: 'stick move · A jump · stick aims' };
  }
  return null;
}

export function createMoveBar(el, { onFullscreen } = {}) {
  let sig = '';
  let cards = [];

  function build(list) {
    el.innerHTML = '';
    cards = list.map((p) => {
      const ctl = controlsFor(p.source);
      const card = document.createElement('div');
      card.className = 'mcard';
      card.style.setProperty('--c', p.color || '#e8b04a');
      const head = document.createElement('div');
      head.className = 'mhead';
      head.innerHTML = `<b>${p.tag ? 'P' + p.tag + ' · ' : ''}${p.name || ''}</b><span>${p.type}</span><span class="mmove">${ctl.move}</span>`;
      const row = document.createElement('div');
      row.className = 'mrow';
      const btns = SLOTS.map((s, k) => {
        const [, name] = (MOVES[p.type] || [])[k] || ['', s];
        const b = document.createElement('button');
        b.className = 'mbtn' + (s === 'ultimate' ? ' ult' : '');
        b.innerHTML = `<kbd>${ctl.labels[s]}</kbd><span class="mname">${name}</span><i class="mfill"></i>`;
        const key = ctl.keys[s];
        if (key) { // mouse: press and hold the button = press and hold the key
          const on = (e) => { e.preventDefault(); virtualKey(key, true); b.classList.add('down'); };
          const off = () => { virtualKey(key, false); b.classList.remove('down'); };
          b.addEventListener('pointerdown', on);
          b.addEventListener('pointerup', off);
          b.addEventListener('pointerleave', off);
        }
        b.tabIndex = -1;
        row.append(b);
        return b;
      });
      card.append(head, row);
      el.append(card);
      return { btns };
    });
    if (onFullscreen) { // a full-screen toggle next to the cards
      const fs = document.createElement('button');
      fs.className = 'mbtn fsbtn';
      fs.innerHTML = '<kbd>F</kbd><span class="mname">Fullscreen</span>';
      fs.tabIndex = -1;
      fs.addEventListener('click', onFullscreen);
      el.append(fs);
    }
  }

  // list: [{ name, tag, color, type, source, mask, cd: {slot: 0..1 remaining}, energyLow: {slot: bool}, ult }]
  function update(list) {
    list = list.filter((p) => controlsFor(p.source));
    const show = list.length ? '' : 'none', changed = el.style.display !== show;
    el.style.display = show;
    const s = list.map((p) => `${p.name}|${p.type}|${p.source}|${p.color}`).join(',');
    let rebuilt = false;
    if (s !== sig) { sig = s; build(list); rebuilt = true; }
    list.forEach((p, i) => {
      const c = cards[i];
      if (!c) return;
      SLOTS.forEach((slot, k) => {
        const b = c.btns[k], ready = !!(p.mask & (1 << k));
        b.classList.toggle('ready', ready);
        b.classList.toggle('nomana', !ready && !!(p.low && p.low[slot]));
        const rem = slot === 'ultimate' ? 1 - Math.min(1, (p.ult || 0) / 100) : (p.cd && p.cd[slot]) || 0;
        b.querySelector('.mfill').style.width = `${Math.round((1 - rem) * 100)}%`;
        b.classList.toggle('dead', !!p.dead);
      });
    });
    return rebuilt || changed;
  }

  return { update, hide() { el.style.display = 'none'; sig = ''; }, height: () => (el.style.display === 'none' ? 0 : el.offsetHeight) };
}
