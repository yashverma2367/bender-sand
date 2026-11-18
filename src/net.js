// Online play, host-authoritative: the host runs the whole simulation; every 2 ticks it sends
// each guest a snapshot = changed grid cells + wind field + all flying particles + player poses +
// HUD, deflate-compressed. Guests only render snapshots and send their input back.
//
// Grid cells are sent as a 12-bit visual code: element (5 bits) + shade (2) + a "look" level
// (5 bits: fire stage, smoke fade, glow heat, burning). That's all the renderer needs, and
// quantizing keeps tiny temperature changes from flooding the connection.
import { EL, IGNITE_T, AMBIENT } from './elements.js';

// ---------- byte writer / reader ----------
class Writer {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.n = 0; }
  need(k) {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf.subarray(0, this.n)); this.buf = b;
  }
  u8(v) { this.need(1); this.buf[this.n++] = v; }
  u16(v) { this.need(2); this.buf[this.n++] = v & 255; this.buf[this.n++] = (v >> 8) & 255; }
  i16(v) { this.u16(v & 0xffff); }
  u32(v) { this.need(4); for (let k = 0; k < 4; k++) this.buf[this.n++] = (v >>> (8 * k)) & 255; }
  varint(v) { while (v >= 128) { this.u8((v & 127) | 128); v >>>= 7; } this.u8(v); }
  bytes(b) { this.need(b.length); this.buf.set(b, this.n); this.n += b.length; }
  done() { return this.buf.subarray(0, this.n); }
}
class Reader {
  constructor(b) { this.b = b; this.p = 0; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.b[this.p] | (this.b[this.p + 1] << 8); this.p += 2; return v; }
  i16() { const v = this.u16(); return v > 32767 ? v - 65536 : v; }
  i8() { const v = this.u8(); return v > 127 ? v - 256 : v; }
  u32() { let v = 0; for (let k = 0; k < 4; k++) v += this.b[this.p++] * 2 ** (8 * k); return v; }
  varint() { let v = 0, s = 0, c; do { c = this.u8(); v += (c & 127) * 2 ** s; s += 7; } while (c & 128); return v; }
}

// ---------- compression ----------
const canDeflate = typeof CompressionStream !== 'undefined';
async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export async function pack(bytes) {
  if (!canDeflate) { const r = new Uint8Array(bytes.length + 1); r[0] = 0; r.set(bytes, 1); return r; }
  const z = await pipe(bytes, new CompressionStream('deflate-raw'));
  const r = new Uint8Array(z.length + 1); r[0] = 1; r.set(z, 1); return r;
}
export async function unpack(bytes) {
  const b = new Uint8Array(bytes);
  return b[0] === 1 ? pipe(b.subarray(1), new DecompressionStream('deflate-raw')) : b.subarray(1);
}

// ---------- cell / wind codes ----------
export function cellCodes(grid, out) {
  const { type, shade, temp, life } = grid;
  for (let i = 0; i < out.length; i++) {
    const t = type[i];
    if (t === 0) { out[i] = 0; continue; }
    let vis = 0;
    if (t === EL.FIRE) { const L = life[i]; vis = L > 30 ? 0 : L > 15 ? 1 : L > 6 ? 2 : 3; }
    else if (t === EL.SMOKE) vis = Math.min(31, life[i] >> 1);
    else if (IGNITE_T[t] !== Infinity && life[i] > 0) vis = 31;
    else if (temp[i] > 350) vis = Math.min(30, (((temp[i] - 350) / 32) | 0) + 1);
    const sh = t === EL.WATER || t === EL.LAVA ? 0 : shade[i]; // their shimmer is done locally
    out[i] = (t & 31) | (sh << 5) | (vis << 7);
  }
  return out;
}
const FIRE_LIFE = [40, 20, 10, 3];
function applyCell(grid, i, c) {
  const t = c & 31, vis = c >> 7;
  grid.type[i] = t; grid.shade[i] = (c >> 5) & 3;
  grid.temp[i] = AMBIENT; grid.life[i] = 0;
  if (t === EL.FIRE) grid.life[i] = FIRE_LIFE[vis] || 3;
  else if (t === EL.SMOKE) grid.life[i] = vis * 2 + 1;
  else if (vis === 31) grid.life[i] = 1;
  else if (vis > 0) grid.temp[i] = 350 + vis * 32 - 16;
}
// Hanging dust density, quantized to a byte per field cell.
export function dustCodes(grid, out) {
  const d = grid.dust;
  for (let f = 0; f < out.length; f++) out[f] = d ? Math.min(255, Math.round(d[f] * 150)) : 0;
  return out;
}
export function windCodes(grid, out) {
  for (let f = 0; f < out.length; f++) {
    const m = Math.abs(grid.vx[f]) + Math.abs(grid.vy[f]);
    out[f] = m <= 0.2 ? 0 : Math.min(15, Math.ceil(m * 2));
  }
  return out;
}

// Runs of changed values: [skip, run, run x value] ...
function writeDiff(w, cur, base, wide) {
  const body = new Writer(4096);
  let i = 0, last = 0;
  const n = cur.length;
  while (i < n) {
    if (cur[i] === base[i]) { i++; continue; }
    let j = i;
    while (j < n && cur[j] !== base[j]) j++;
    body.varint(i - last); body.varint(j - i);
    for (let k = i; k < j; k++) { if (wide) body.u16(cur[k]); else body.u8(cur[k]); base[k] = cur[k]; }
    last = j; i = j;
  }
  const b = body.done();
  w.u32(b.length); w.bytes(b);
}
function readDiff(r, apply, wide) {
  const end = r.p + 4 + r.u32() - 0;
  let idx = 0;
  while (r.p < end) {
    idx += r.varint();
    const run = r.varint();
    for (let k = 0; k < run; k++) apply(idx++, wide ? r.u16() : r.u8());
  }
  r.p = end;
}

const round = (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v && v.constructor === Float32Array ? Array.from(v) : v);
const enc = new TextEncoder(), dec = new TextDecoder();

// Host: one encoder per guest (each remembers what that guest already has).
export class SnapEncoder {
  constructor(grid) {
    this.cells = new Uint16Array(grid.w * grid.h); // baseline: guest starts with an empty map
    this.wind = new Uint8Array(grid.fw * grid.fh);
    this.dust = new Uint8Array(grid.fw * grid.fh);
  }
  reset() { this.cells.fill(0); this.wind.fill(0); this.dust.fill(0); }
  // cur: shared per-tick codes { cells, wind }, particles, json: anything serializable.
  encode(cur, ps, json) {
    const w = new Writer();
    const j = enc.encode(JSON.stringify(json, round));
    w.u32(j.length); w.bytes(j);
    writeDiff(w, cur.cells, this.cells, true);
    writeDiff(w, cur.wind, this.wind, false);
    writeDiff(w, cur.dust, this.dust, false);
    w.u16(ps.n);
    for (let i = 0; i < ps.n; i++) {
      w.i16(Math.round(ps.x[i] * 16)); w.i16(Math.round(ps.y[i] * 16));
      w.u8(Math.max(-127, Math.min(127, Math.round(ps.vx[i] * 8))) & 255);
      w.u8(Math.max(-127, Math.min(127, Math.round(ps.vy[i] * 8))) & 255);
      w.u8(ps.type[i]); w.u8((ps.shade[i] & 3) | (ps.ghost[i] ? 4 : 0));
    }
    return w.done();
  }
}

// Guest: apply one snapshot to the local grid / particle arrays, return its JSON part.
export function applySnapshot(bytes, grid, ps) {
  const r = new Reader(bytes);
  const jl = r.u32();
  const json = JSON.parse(dec.decode(bytes.subarray(r.p, r.p + jl)));
  r.p += jl;
  readDiff(r, (i, c) => applyCell(grid, i, c), true);
  readDiff(r, (f, q) => { grid.vx[f] = q * 0.5; grid.vy[f] = 0; }, false);
  readDiff(r, (f, q) => { if (grid.dust) grid.dust[f] = q / 150; }, false);
  const n = Math.min(r.u16(), ps.max);
  for (let i = 0; i < n; i++) {
    ps.x[i] = r.i16() / 16; ps.y[i] = r.i16() / 16;
    ps.vx[i] = r.i8() / 8; ps.vy[i] = r.i8() / 8;
    ps.type[i] = r.u8(); const s = r.u8(); ps.shade[i] = s & 3; ps.ghost[i] = s & 4 ? 1 : 0;
  }
  ps.n = n;
  return json;
}

// ---------- input (guest -> host) ----------
const SLOTS = ['basic', 'heavy', 'special', 'defense', 'mobility', 'ultimate'];
export function inputBits(inp) {
  let b = (inp.left ? 1 : 0) | (inp.right ? 2 : 0) | (inp.up ? 4 : 0) | (inp.down ? 8 : 0);
  SLOTS.forEach((s, k) => { if (inp.held[s]) b |= 16 << k; });
  return b;
}
export function bitsToInput(bits, inp) {
  inp.left = !!(bits & 1); inp.right = !!(bits & 2); inp.up = !!(bits & 4); inp.down = !!(bits & 8);
  SLOTS.forEach((s, k) => { inp.held[s] = !!(bits & (16 << k)); });
}

// ---------- player visuals (host -> guest) ----------
export function playerVisual(p) {
  const a = p.anim;
  return {
    x: p.x, y: p.y, vx: p.vx, vy: p.vy, f: p.facing, t: p.type, c: p.color, g: p.tag | 0, d: p.dead ? 1 : 0,
    iv: p.invulnT | 0, fl: p.flash | 0, fz: p.frozenT > 0 ? 1 : 0, wf: p.waterFormT > 0 ? 1 : 0, fh: p.flameHair ? 1 : 0,
    hp: p.hp, en: p.energy, u: p.ult, a: p.air, ch: p.channel ? [p.channel.slot, p.channel.t] : 0,
    an: { j: a.j, n: a.n, rx: a.rx, ry: a.ry, s: a.state, t: a.t },
    rg: p.dead && p.rag ? [Math.round(p.rag.x * 10) / 10, Math.round(p.rag.y * 10) / 10, Math.round(p.rag.a * 100) / 100] : 0,
    ai: (p.afterimages || []).map((q) => ({ x: q.x, y: q.y, j: q.j, facing: q.facing, life: q.life, water: q.water ? 1 : 0 })),
  };
}
