import { touchState } from './touch.js';
import { bitsToInput } from './net.js';

// Player input sources. Every source produces the same input object each tick:
//   { left, right, up, down, jump, held: { basic, heavy, special, defense, mobility, ultimate } }
// Sources: two keyboard layouts sharing one keyboard, and up to 4 gamepads. (Online players
// will be another source that fills the same object from the network.)

export const INPUT_SOURCES = {
  kb1: 'Keyboard 1 (arrows + Z X C A S V)',
  kb2: 'Keyboard 2 (I J K L + U O P H N M)',
  pad0: 'Gamepad 1', pad1: 'Gamepad 2', pad2: 'Gamepad 3', pad3: 'Gamepad 4',
  touch: 'Touch screen',
};

// key = KeyboardEvent.key lowercased
export const KEYMAPS = {
  kb1: { left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown',
    basic: 'z', heavy: 'x', special: 'c', defense: 'a', mobility: 's', ultimate: 'v' },
  kb2: { left: 'j', right: 'l', up: 'i', down: 'k',
    basic: 'u', heavy: 'o', special: 'p', defense: 'h', mobility: 'n', ultimate: 'm' },
};
const SLOTS = ['basic', 'heavy', 'special', 'defense', 'mobility', 'ultimate'];

// Standard gamepad layout: A jump, X/Y/RB/LB/B/RT for the six moves, stick or d-pad to move/aim.
const PAD = { jump: 0, basic: 2, heavy: 3, special: 5, defense: 4, mobility: 1, ultimate: 7 };
const DEAD = 0.45;

const down = new Set();
let attached = false;

// Keys used by any layout, so the page doesn't scroll / type while playing.
export const GAME_KEYS = new Set(Object.values(KEYMAPS).flatMap((m) => Object.values(m)));

export function attachKeyboard() {
  if (attached) return;
  attached = true;
  window.addEventListener('keydown', (e) => down.add(e.key.toLowerCase()));
  window.addEventListener('keyup', (e) => down.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => down.clear());
}

// On-screen buttons (desktop move bar): press / release a key as if typed.
export function virtualKey(key, on) { if (on) down.add(key); else down.delete(key); }

export function isDown(key) {
  return down.has(key);
}

export function createInput() {
  return { left: false, right: false, up: false, down: false, jump: false, held: {}, _upWas: false, _jumpWas: false };
}

// Fill `inp` from its source for this tick.
export function sampleInput(source, inp) {
  if (source === 'local') return sampleLocal(inp);
  if (source === 'net') return sampleNet(inp);
  let up = false;
  if (KEYMAPS[source]) {
    const m = KEYMAPS[source];
    inp.left = down.has(m.left); inp.right = down.has(m.right);
    up = down.has(m.up); inp.down = down.has(m.down);
    for (const s of SLOTS) inp.held[s] = down.has(m[s]);
    // Up jumps on the press, unless an attack key is held (then Up is just aiming).
    inp.jump = up && !inp._upWas && !SLOTS.some((s) => inp.held[s]);
  } else if (source.startsWith('pad')) {
    const pad = navigator.getGamepads ? navigator.getGamepads()[+source.slice(3)] : null;
    const b = (i) => !!(pad && pad.buttons[i] && pad.buttons[i].pressed);
    const ax = pad ? pad.axes[0] || 0 : 0, ay = pad ? pad.axes[1] || 0 : 0;
    inp.left = ax < -DEAD || b(14); inp.right = ax > DEAD || b(15);
    up = ay < -DEAD || b(12); inp.down = ay > DEAD || b(13);
    for (const s of SLOTS) inp.held[s] = b(PAD[s]);
    const jumpBtn = b(PAD.jump);
    inp.jump = jumpBtn && !inp._jumpWas;
    inp._jumpWas = jumpBtn;
    up = up || jumpBtn; // holding A also swims / glides
  } else if (source === 'touch') { // on-screen joystick + buttons (touch.js)
    inp.left = touchState.left; inp.right = touchState.right; inp.down = touchState.down;
    for (const s of SLOTS) inp.held[s] = !!touchState.held[s];
    inp.jump = touchState.jumpDown && !inp._jumpWas;
    inp._jumpWas = touchState.jumpDown;
    up = touchState.up || touchState.jumpDown; // holding jump also swims / glides
  } else {
    inp.left = inp.right = inp.down = inp.jump = false;
    for (const s of SLOTS) inp.held[s] = false;
  }
  inp.up = up;
  inp._upWas = up;
  return inp;
}

// Online: this device's own player. Keyboard 1, gamepad 1 and the touch screen all work at once.
const LOCAL_SUBS = ['kb1', 'pad0', 'touch'];
function sampleLocal(inp) {
  inp._subs = inp._subs || LOCAL_SUBS.map(() => createInput());
  const subs = LOCAL_SUBS.map((s, k) => sampleInput(s, inp._subs[k]));
  for (const f of ['left', 'right', 'up', 'down', 'jump']) inp[f] = subs.some((s) => s[f]);
  for (const s of SLOTS) inp.held[s] = subs.some((x) => x.held[s]);
  return inp;
}

// Online: a remote guest. inp.net = { bits, jumps } is filled from the network; every increase of
// the jump counter is one jump press (so a press can't be lost between snapshots).
function sampleNet(inp) {
  const n = inp.net || { bits: 0, jumps: 0 };
  bitsToInput(n.bits, inp);
  inp.jump = inp._jumps !== undefined && n.jumps !== inp._jumps;
  inp._jumps = n.jumps;
  return inp;
}
