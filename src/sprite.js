// Bender sprite at sand-grid resolution (1 pixel = 1 cell), driven by a joint-angle skeleton.
// Poses are angles (forward kinematics): body lean, thigh angle + knee bend, upper-arm + forearm
// angles. 12-frame sprint modeled on a reference run cycle, fighting stances, leap / tuck / fall,
// hero landing, swim, air flip. A verlet rope (scarf / cape / ponytail) trails behind.
//
// Sprite space: grid cells, x forward (facing right), y DOWN, origin = the feet row at the body's
// center column. Angles in degrees, 0 = pointing straight down, + = swung forward.
// "near" limbs are drawn on top in full color, "far" limbs behind and darker.

// Everything is designed at the original 3x12 size and scaled up by S (joint positions are
// multiplied after solving, so every pose keeps its exact shape).
export const S = 1.5;
export const BODY_W = 5; // collision box
export const BODY_H = 18;

const TORSO = 4, THIGH = 3.2, SHIN = 3.2, UARM = 2.2, FARM = 2.2;
const AIR_HIP = -6.5;     // hip height for airborne poses
const PIVOT = -6;         // rotation center (y) for flips / swimming
const FLIP_TICKS = 18;
const ROPE_GRAVITY = 0.12, ROPE_DAMPING = 0.85;
const DEG = Math.PI / 180;

// ---------- poses ----------
// legs: [near, far] each [thigh angle, knee bend]. arms: [near, far] each [upper angle, forearm angle].
// lean: torso angle. head: extra head tilt. air: hip fixed instead of planted on the lowest foot.

// Sprint, one leg's 12 frames (the other leg is 6 frames behind): long stance, leg fully
// extended behind, high heel kick, high knee drive.
const RUN_LEG = [
  [30, 15],   // contact, foot ahead
  [18, 20],   // load
  [4, 22],    // under body
  [-14, 16],  // push
  [-32, 10],  // extension behind
  [-44, 28],  // toe-off
  [-38, 80],  // heel kick
  [-16, 112], // heel high, knee coming through
  [12, 112],  // knee forward, heel tucked
  [44, 92],   // knee drive
  [56, 52],   // shin extending
  [44, 24],   // reach
];
const RUN_LIFT = [0, 0, 0, 0, 0, -0.6, 0, 0, 0, 0, 0, -0.6]; // small hop at toe-off (planting handles the dip)

// How far the planted foot travels backward from frame i to i+1, computed from RUN_LEG with the
// same kinematics. Advancing the cycle by speed / stride[i] keeps the planted foot still.
const RUN_STRIDE = RUN_LEG.map((_, i) => {
  const foot = ([th, bend]) => {
    const a2 = th - bend;
    return [Math.sin(th * DEG) * THIGH + Math.sin(a2 * DEG) * SHIN, Math.cos(th * DEG) * THIGH + Math.cos(a2 * DEG) * SHIN];
  };
  const a = foot(RUN_LEG[i]), b = foot(RUN_LEG[(i + 6) % 12]);
  const planted = a[1] >= b[1] ? i : (i + 6) % 12;
  return Math.max(0.3, foot(RUN_LEG[planted])[0] - foot(RUN_LEG[(planted + 1) % 12])[0]) * S;
});

// Idle stances: both feet planted (leg IK), hip height, feet x [near, far].
const STANCES = {
  // Fire: boxer guard, weight forward, both fists up by the chin
  guard: { lean: 10, head: 2, hip: 5.9, feet: [2, -1.5], arms: [[52, 150], [30, 160]] },
  // Earth: low wide horse stance, fists chambered at the hips
  wide: { lean: 0, head: 0, hip: 5.5, feet: [2.5, -2.5], arms: [[-20, 75], [-30, 65]] },
  // Water: long front stance, lead palm forward and low, back hand drawn back
  flow: { lean: 8, head: 2, hip: 5.9, feet: [2, -1.5], arms: [[50, 70], [-45, -15]] },
  // Air: upright and light, hands relaxed low
  light: { lean: 2, head: 0, hip: 6.2, feet: [1, -1], arms: [[15, 40], [-15, -5]] },
};
const LEAP = { lean: 24, head: 6, air: true, legs: [[72, 96], [-30, 20]], arms: [[130, 160], [-100, -88]] };
const TUCK = { lean: 34, head: 6, air: true, legs: [[96, 128], [74, 124]], arms: [[60, 128], [28, 124]] };
// Fall: crouched, ready to land. Front knee up, back leg tucked behind, front arm reaching
// forward-down and back arm trailing for balance. Arm angles flutter slightly in pose().
const FALL = { lean: 18, head: 6, air: true, legs: [[42, 72], [-4, 48]], arms: [[62, 34], [-72, -52]] };
// Braced against wind while being dragged: feet wide and planted (sliding), body leaning into
// the wind. Wind from the front: forearms up shielding the face. From behind: arms thrown
// forward fighting for balance.
const WIND_DRAG = 0.4;
const BRACE_FRONT = { lean: 26, head: 6, hip: 5.2, feet: [2, -2.5], arms: [[64, 160], [44, 150]] };
const BRACE_BACK = { lean: -20, head: 10, hip: 5.2, feet: [2.5, -2], arms: [[104, 124], [84, 110]] };
const LAND = { lean: 46, head: 6, legs: [[82, 88], [-12, 100]], arms: [[18, 8], [-124, -142]] };

// Upper-body poses while casting a move (legs keep doing whatever they were doing).
// aim: the near arm (and far arm when both) tilts with the aim (up / down arrows).
const CAST_POSES = {
  punch: { lean: 20, aim: 1, arms: [[92, 90], [-20, 120]] },     // straight punch, other fist chambered
  palms: { lean: 16, aim: 2, arms: [[88, 90], [80, 92]] },        // double palm strike
  charge: { lean: -4, arms: [[-50, 10], [-60, 0]] },              // hands pulled back to the hip
  jet: { lean: 14, aim: 2, arms: [[94, 92], [70, 96]] },          // arm thrust out, other bracing
  guard: { arms: [[60, 165], [40, 150]] },                         // forearms crossed up front
  dash: { lean: 70, head: -12, arms: [[-100, -96], [-100, -96]] }, // superhero flight
  sky: { lean: -6, arms: [[172, 178], [160, 170]] },              // both arms raised
  lift: { lean: -4, arms: [[120, 150], [100, 140]] },             // palms up, raising the ground
  slam: { lean: 28, arms: [[30, 4], [14, -6]] },                   // fists driven down at the ground
  surf: { lean: 16, arms: [[100, 108], [-96, -88]] },             // arms out for balance
  wave: { lean: 22, arms: [[140, 120], [120, 110]] },              // both arms sweeping up and forward
  slash: { lean: 18, aim: 1, arms: [[100, 100], [-40, -10]] },      // downward sweep finish, other arm back
  slashUp: { lean: 10, arms: [[150, 160], [-30, 0]] },             // upward sweep finish, arm high
  heal: { lean: 4, arms: [[60, 150], [40, 140]] },                 // hands cupped at the chest
  powerup: { lean: -8, head: -6, arms: [[-28, 38], [-38, 28]] },  // fists clenched at the sides, chest out, roaring
  spin: { lean: 0, arms: [[100, 96], [-100, -96]] },               // arms flung wide, spinning the air
};
let castOverride = null; // set by updateAnim while a cast pose is active

// ---------- kinematics ----------
const dirDown = (a) => [Math.sin(a * DEG), Math.cos(a * DEG)];

// Two-bone leg IK: hip at (0, -h), foot at (fx, 0). Knee bends forward. Returns [thigh, bend].
function legIK(fx, h) {
  const d = Math.min(THIGH + SHIN - 0.01, Math.hypot(fx, h));
  const phi = Math.atan2(fx, h) / DEG;
  const a = Math.acos((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d)) / DEG;
  const th = phi + a;
  const [kx, ky] = dirDown(th);
  const shin = Math.atan2(fx - kx * THIGH, h - ky * THIGH) / DEG;
  return [th, th - shin];
}

function rotP([x, y], r) {
  if (!r) return [x, y];
  const c = Math.cos(r * DEG), s = Math.sin(r * DEG), dy = y - PIVOT;
  return [x * c - dy * s, PIVOT + x * s + dy * c];
}

function solve(pose, lift = 0, rot = 0) {
  const ov = castOverride;
  if (ov) {
    const tilt = ov.tilt || 0;
    // Aimed arms point along the aim: horizontal = 90deg, so add the tilt (+90 up, -90 down).
    const arms = ov.arms.map(([u, f], k) => (k < ov.aim ? [90 + tilt, 90 + tilt] : [u, f]));
    pose = { ...pose, arms, lean: ov.lean ?? pose.lean, head: ov.head ?? pose.head };
  }
  const leg = ([th, bend]) => {
    const [tx, ty] = dirDown(th);
    const knee = [tx * THIGH, ty * THIGH];
    const a2 = th - bend;
    const [sx, sy] = dirDown(a2);
    return { knee, foot: [knee[0] + sx * SHIN, knee[1] + sy * SHIN], shin: a2 };
  };
  // Stances give foot positions (IK, both feet planted); other poses give joint angles.
  const legs = (pose.feet ? pose.feet.map((fx) => legIK(fx, pose.hip - lift)) : pose.legs).map(leg);
  // Plant the lowest foot on the feet row (or hang at a fixed height when airborne).
  const low = Math.max(...legs.map((l) => l.foot[1]));
  const hipY = pose.feet ? -(pose.hip - lift) : (pose.air ? AIR_HIP : -low) + lift;
  for (const l of legs) { l.knee[1] += hipY; l.foot[1] += hipY; }

  const hip = [0, hipY];
  const [lx, ly] = dirDown(pose.lean);
  const neck = [lx * TORSO, hipY - ly * TORSO];
  const shoulder = [neck[0] - lx * 0.6, neck[1] + ly * 0.6];
  const hl = pose.lean + pose.head;
  const [hx, hy] = dirDown(hl);
  const head = [neck[0] + hx * 1.2, neck[1] - hy * 1.2]; // head block's lower-front cell
  const arm = ([a1, a2]) => {
    const [ux, uy] = dirDown(a1), [fx, fy] = dirDown(a2);
    const elbow = [shoulder[0] + ux * UARM, shoulder[1] + uy * UARM];
    return { elbow, hand: [elbow[0] + fx * FARM, elbow[1] + fy * FARM] };
  };
  const arms = pose.arms.map(arm);

  const R = (pt) => { const [x, y] = rotP(pt, rot); return [x * S, y * S]; }; // rotate, then scale up
  return {
    hip: R(hip), neck: R(neck), shoulder: R(shoulder), head: R(head), lean: pose.lean, rot,
    legs: legs.map((l) => ({ knee: R(l.knee), foot: R(l.foot), shin: l.shin + rot })),
    arms: arms.map((a) => ({ elbow: R(a.elbow), hand: R(a.hand) })),
  };
}

// ---------- animation state ----------
export function createAnim(p) {
  const n = p.def.rope ? Math.round(p.def.rope.len * S) : 0;
  const a = {
    t: 0, phase: 0, land: 0, flip: 0, prevDouble: false, blink: 0, state: 'idle', n,
    rx: new Float32Array(n + 1), ry: new Float32Array(n + 1),
    rox: new Float32Array(n + 1), roy: new Float32Array(n + 1),
  };
  a.j = solve(STANCES[p.def.stance]);
  if (n) {
    const [ax, ay] = ropeAnchor(p, a);
    for (let k = 0; k <= n; k++) {
      a.rx[k] = a.rox[k] = ax - p.facing * k * 0.5;
      a.ry[k] = a.roy[k] = ay + k * 0.8;
    }
  }
  return a;
}

// impact: downward speed on the tick the body touched ground (0 otherwise).
export function updateAnim(p, env, impact) {
  const a = p.anim;
  a.t++;
  if (impact > 0.5) a.land = impact > 1.6 ? 12 : 4;
  else if (a.land > 0) a.land--;
  if (a.blink > 0) a.blink--;
  else if (Math.random() < 1 / 200) a.blink = 6;
  if (p.usedDouble && !a.prevDouble) a.flip = FLIP_TICKS;
  a.prevDouble = p.usedDouble;
  if (p.onGround || env.submerged) a.flip = 0;

  // Run only when the player is pushing a direction AND moving that way. Being shoved by strong
  // wind (no input, or losing against it) is a braced slide instead.
  const moving = Math.abs(p.vx) > 0.08;
  const running = p.onGround && moving && p.moveDir !== 0 && Math.sign(p.vx) === p.moveDir;
  const dragged = p.onGround && moving && !running && Math.abs(p.windX || 0) > WIND_DRAG;
  if (dragged) a.windSide = -Math.sign(p.vx) * p.facing; // +1: wind hits the front, -1: the back
  a.state = env.submerged ? 'swim'
    : a.flip > 0 ? 'flip'
    : !p.onGround ? (p.vy < -0.35 ? 'leap' : p.vy > 0.35 ? 'fall' : 'tuck')
    : a.land > 0 ? 'land'
    : running ? 'run'
    : dragged || (a.state === 'brace' && moving) ? 'brace' : 'idle';

  if (a.state === 'run') a.phase += Math.abs(p.vx) / RUN_STRIDE[Math.floor(a.phase) % 12];
  else if (a.state === 'swim') a.phase += 0.15;

  const cp = p.cast && CAST_POSES[p.cast.pose];
  castOverride = cp ? { ...cp, aim: cp.aim || 0, tilt: p.aimTilt || 0 } : null;
  a.j = pose(a, p);
  castOverride = null;
  if (a.flip > 0) a.flip--;
  if (a.n) updateRope(p, a, env.submerged);
}

function pose(a, p) {
  switch (a.state) {
    case 'run': {
      // Blend between neighbouring frames so the planted foot moves exactly with the ground.
      const ph = a.phase % 12, i = Math.floor(ph), t = ph - i;
      const leg = (k) => {
        const [a0, b0] = RUN_LEG[k % 12], [a1, b1] = RUN_LEG[(k + 1) % 12];
        return [a0 + (a1 - a0) * t, b0 + (b1 - b0) * t];
      };
      const sway = Math.sin((ph / 12) * Math.PI * 4) * 3; // tiny arm bob, twice per cycle
      // Ninja run: deep lean, both arms swept straight back. Same angles for both arms, so the
      // far arm sits exactly behind the near one and only one shows.
      const arms = [-80 + sway, -86 + sway];
      return solve({
        lean: 58, head: -6,
        legs: [leg(i), leg(i + 6)],
        arms: [arms, arms],
      }, RUN_LIFT[i]);
    }
    case 'leap': return solve(LEAP);
    case 'tuck': return solve(TUCK);
    case 'fall': {
      const fl = Math.sin(a.t * 0.9) * 6; // arms flutter in the wind
      return solve({ ...FALL, arms: FALL.arms.map(([u, f]) => [u + fl, f + fl * 1.5]) });
    }
    case 'land': return solve(LAND);
    case 'brace': {
      const st = a.windSide > 0 ? BRACE_FRONT : BRACE_BACK;
      const j = Math.sin(a.t * 1.3) * 5; // arms buffeted by the gusts
      return solve({ ...st, arms: st.arms.map(([u, f]) => [u + j, f - j]) });
    }
    case 'flip': return solve(TUCK, 0, (1 - a.flip / FLIP_TICKS) * 360);
    case 'swim': {
      const s = Math.sin(a.phase), c = Math.cos(a.phase);
      const moving = Math.abs(p.vx) > 0.1 || Math.abs(p.vy) > 0.3;
      return solve({
        lean: 0, head: 0, air: true,
        legs: [[8 + s * 16, 12], [8 - s * 16, 12]],
        arms: [[170 + c * 30, 176 + c * 30], [20 - c * 30, 30 - c * 30]],
      }, 0, moving ? 70 : 0);
    }
    default: {
      // Breathing: hip sinks ~1 cell and rises over ~1.7 s (knees flex, feet stay planted),
      // arms drift a few degrees with it.
      const st = STANCES[p.def.stance];
      const b = 0.5 - 0.5 * Math.cos((a.t / 100) * Math.PI * 2);
      const sway = b * 6;
      return solve({ ...st, arms: st.arms.map(([u, f]) => [u - sway, f - sway]) }, b * 0.7);
    }
  }
}

// ---------- rope (grid cells, world space) ----------
// Body center column / feet row in world cells. Kept fractional so every joint is rounded once,
// in world space (no jitter between the body and a planted foot).
function origin(p) {
  return [p.x + BODY_W / 2, p.y + BODY_H - 0.5];
}

function ropeAnchor(p, a) {
  const from = p.def.rope.from;
  const [bx, by] = from === 'head'
    ? [a.j.head[0] - 2.5, a.j.head[1] - 1]
    : [a.j.neck[0] - 1.5, a.j.neck[1] + (from === 'shoulder' ? 1.5 : 0)];
  const [ox, oy] = origin(p);
  return [ox + bx * p.facing, oy + by];
}

function updateRope(p, a, submerged) {
  const { rx, ry, rox, roy, n } = a;
  const [ax, ay] = ropeAnchor(p, a);
  const [wx, wy] = p.grid.windAt(p.x + BODY_W / 2, p.y + 6);
  const grav = submerged ? 0.03 : ROPE_GRAVITY;
  rx[0] = ax; ry[0] = ay;
  for (let k = 1; k <= n; k++) {
    const vx = (rx[k] - rox[k]) * ROPE_DAMPING;
    const vy = (ry[k] - roy[k]) * ROPE_DAMPING;
    rox[k] = rx[k]; roy[k] = ry[k];
    rx[k] += vx + wx * 0.08 + (k === n ? Math.sin(a.t * 0.3) * 0.04 : 0); // tail flutter
    ry[k] += vy + grav + wy * 0.08;
  }
  for (let iter = 0; iter < 3; iter++) {
    for (let k = 1; k <= n; k++) {
      const dx = rx[k] - rx[k - 1], dy = ry[k] - ry[k - 1];
      const d = Math.hypot(dx, dy);
      if (d > 1) { rx[k] = rx[k - 1] + dx / d; ry[k] = ry[k - 1] + dy / d; }
    }
  }
}

// ---------- drawing ----------
// px(x, y, color) writes one world pixel.
// pal: packed H S E B T L C F (boots) + darker far-side D (B), K (L), Z (S), G (F).
export function drawSprite(p, px, pal, flash, white) {
  const a = p.anim, f = p.facing, d = p.def, J = a.j;
  const [ox, oy] = origin(p);
  const col = (c) => (flash ? white : c);
  // Local sprite point -> world pixel.
  const wx = (x) => Math.floor(ox + x * f), wy = (y) => Math.floor(oy + y);
  const P = ([x, y], c) => px(wx(x), wy(y), col(c));
  // Pixel line between endpoints (Bresenham in world pixels: no gaps, no doubled corners).
  const line = (p0, p1, c) => {
    let x0 = wx(p0[0]), y0 = wy(p0[1]);
    const x1 = wx(p1[0]), y1 = wy(p1[1]);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      px(x0, y0, col(c));
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  // 2px-thick limb: a second line next to it, offset toward the back for upright segments and
  // downward for flatter ones, so it thickens cleanly at any angle.
  const thick = (p0, p1, c) => {
    line(p0, p1, c);
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const off = Math.abs(dy) >= Math.abs(dx) ? [-1, 0] : [0, 1];
    line([p0[0] + off[0], p0[1] + off[1]], [p1[0] + off[0], p1[1] + off[1]], c);
  };
  // Toe: one pixel off the foot, forward when the shin is upright, pointing down when kicked back.
  const toe = (l, c) => { // boot: the foot pixel plus a toe, 2 wide
    const s = l.shin * DEG, tx = l.foot[0] + Math.cos(s) * 1.5, ty = Math.min(0, l.foot[1] - Math.sin(s));
    P([tx, ty], c); P([l.foot[0], Math.min(0, l.foot[1])], c);
  };

  // Rope (world coords), behind everything.
  for (let k = 1; k <= a.n; k++) {
    const x0 = a.rx[k - 1], y0 = a.ry[k - 1], x1 = a.rx[k], y1 = a.ry[k];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let s = 0; s <= steps; s++) {
      px(Math.floor(x0 + ((x1 - x0) * s) / steps), Math.floor(y0 + ((y1 - y0) * s) / steps), col(pal.C));
    }
  }

  // Far limbs (dark).
  const fa = J.arms[1], fl = J.legs[1];
  thick(J.shoulder, fa.elbow, pal.D); thick(fa.elbow, fa.hand, pal.Z);
  thick(J.hip, fl.knee, pal.K); thick(fl.knee, fl.foot, pal.K); toe(fl, pal.G);

  // Torso: 3px thick (two more lines toward the back), belt at the hip.
  const back = J.rot ? [-Math.cos(J.rot * DEG), -Math.sin(J.rot * DEG)] : [-1, 0];
  const bk = (pt, k = 1) => [pt[0] + back[0] * k, pt[1] + back[1] * k];
  line(bk(J.hip, 2), bk(J.neck, 2), pal.B);
  line(bk(J.hip), bk(J.neck), pal.B);
  line(J.hip, J.neck, pal.B);
  P(J.hip, pal.T); P(bk(J.hip), pal.T); P(bk(J.hip, 2), pal.T);
  if (d.robe) { // robe skirt: two rows below the belt, flaring back when moving fast
    for (let r = 1; r <= 2; r++) { P([J.hip[0], J.hip[1] + r], pal.B); P([J.hip[0] - 1, J.hip[1] + r], pal.B); }
    if (a.state === 'run' || a.state === 'leap' || a.state === 'fall') { P([J.hip[0] - 2, J.hip[1] + 1], pal.B); P([J.hip[0] - 3, J.hip[1] + 2], pal.B); }
  }

  // Head: 3x3 block. Hair on top and at the back, face at the front with an eye.
  // Headband: a band across the forehead. Hood wraps the back; topknot is a bun on top.
  const [hx, hy] = J.head;
  for (let x = -2; x <= 0; x++) P([hx + x, hy - 2], pal.H);   // hair
  P([hx - 2, hy - 1], pal.H); P([hx - 1, hy - 1], pal.S); P([hx, hy - 1], a.blink ? pal.S : pal.E); // eye row
  P([hx - 2, hy], d.hood ? pal.H : pal.S); P([hx - 1, hy], pal.S); P([hx, hy], pal.S);
  if (d.headband) { P([hx - 1, hy - 2], pal.T); P([hx, hy - 2], pal.T); P([hx - 3, hy - 2], pal.T); }
  if (d.hood) { P([hx - 3, hy - 1], pal.H); P([hx - 3, hy], pal.H); P([hx - 2, hy - 3], pal.H); P([hx - 1, hy - 3], pal.H); }
  if (d.topknot) P([hx - 1, hy - 3], pal.H);

  // Near limbs (full color) on top.
  const na = J.arms[0], nl = J.legs[0];
  thick(J.hip, nl.knee, pal.L); thick(nl.knee, nl.foot, pal.L); toe(nl, pal.F);
  thick(J.shoulder, na.elbow, pal.B); thick(na.elbow, na.hand, pal.S);
}
