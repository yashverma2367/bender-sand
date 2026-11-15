// On-screen controls for phones / tablets: a virtual joystick (left thumb: move, aim, swim) and
// buttons (right thumb: jump + the six moves, labelled with the current bender's move names).
// Fills `touchState`, which input.js reads as the 'touch' input source. Multi-touch: every control
// tracks its own finger, so you can run, jump and hold a charge move at the same time.

export const touchState = { left: false, right: false, up: false, down: false, jumpDown: false, held: {} };

export const isTouchDevice = (typeof window !== 'undefined') && (
  window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
  || new URLSearchParams(window.location.search).has('touch'));

const MOVE_NAMES = {
  fire: { basic: 'Lightning', heavy: 'Blast', special: 'Torrent', defense: 'Lance', mobility: 'Dash', ultimate: 'Ascend' },
  earth: { basic: 'Magma', heavy: 'Boulder', special: 'Wall', defense: 'Cage', mobility: 'Surf', ultimate: 'Rupture' },
  water: { basic: 'Heal', heavy: 'Spear', special: 'Stream', defense: 'Freeze', mobility: 'Riptide', ultimate: 'Cataclysm' },
  air: { basic: 'Vacuum', heavy: 'Cannon', special: 'Tornado', defense: 'Clap', mobility: 'Step', ultimate: 'Dragon' },
};
// Button layout (grid cells), right thumb: ultimate top, moves around jump.
const BUTTONS = [
  ['ultimate', 'V', 'tb-ult'], ['defense', 'A', ''], ['special', 'C', ''],
  ['heavy', 'X', ''], ['basic', 'Z', ''], ['mobility', 'S', ''], ['jump', '', 'tb-jump'],
];

export function createTouchControls(root, { onPause }) {
  const wrap = document.createElement('div');
  wrap.className = 'touch';
  wrap.innerHTML = `
    <div class="stick"><div class="knob"></div></div>
    <div class="tbtns">${BUTTONS.map(([id, key, cls]) => `<button class="tb ${cls}" data-id="${id}"><b>${id === 'jump' ? 'JUMP' : ''}</b><i>${key}</i></button>`).join('')}</div>
    <button class="tpause">&#10074;&#10074;</button>`;
  root.append(wrap);

  // ---- joystick ----
  const stick = wrap.querySelector('.stick'), knob = wrap.querySelector('.knob');
  let stickId = null;
  const setStick = (dx, dy) => {
    const m = Math.hypot(dx, dy), k = m > 1 ? 1 / m : 1;
    const travel = stick.clientWidth * 0.27;
    knob.style.transform = `translate(${dx * k * travel}px, ${dy * k * travel}px)`;
    touchState.left = dx < -0.35; touchState.right = dx > 0.35;
    touchState.up = dy < -0.45; touchState.down = dy > 0.45;
  };
  const stickMove = (e) => {
    const r = stick.getBoundingClientRect(), R = r.width / 2;
    setStick((e.clientX - r.left - R) / R, (e.clientY - r.top - R) / R);
  };
  stick.addEventListener('pointerdown', (e) => { e.preventDefault(); stickId = e.pointerId; stick.setPointerCapture(e.pointerId); stickMove(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) stickMove(e); });
  const stickEnd = (e) => { if (e.pointerId === stickId) { stickId = null; setStick(0, 0); } };
  stick.addEventListener('pointerup', stickEnd);
  stick.addEventListener('pointercancel', stickEnd);

  // ---- buttons (press and hold) ----
  for (const b of wrap.querySelectorAll('.tb')) {
    const id = b.dataset.id;
    const set = (on) => { if (id === 'jump') touchState.jumpDown = on; else touchState.held[id] = on; b.classList.toggle('down', on); };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); set(true); });
    b.addEventListener('pointerup', () => set(false));
    b.addEventListener('pointercancel', () => set(false));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  wrap.querySelector('.tpause').addEventListener('pointerdown', (e) => { e.preventDefault(); onPause(); });

  let labelsFor = null;
  return {
    show(on) {
      wrap.style.display = on ? 'block' : 'none';
      if (!on) { setStick(0, 0); touchState.jumpDown = false; touchState.held = {}; for (const b of wrap.querySelectorAll('.tb')) b.classList.remove('down'); }
    },
    // Label the buttons with this bender's move names.
    setBender(type) {
      if (type === labelsFor || !MOVE_NAMES[type]) return;
      labelsFor = type;
      for (const b of wrap.querySelectorAll('.tb')) if (b.dataset.id !== 'jump') b.querySelector('b').textContent = MOVE_NAMES[type][b.dataset.id];
    },
  };
}
