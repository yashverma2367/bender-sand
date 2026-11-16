// Content for the in-game "How to Play" screen: controls, every bender's moves, and combos.
// Keep this in sync with abilities.js when moves change.

export const CONTROLS = [
  ['Move / aim', 'Arrows (P1) · I J K L (P2) · stick · touch joystick. Attacks aim 8 ways: forward, up, down and diagonals.'],
  ['Jump', 'Up (when no attack key is held) · A on gamepad · JUMP on touch. Air benders double-jump and glide (hold Up).'],
  ['Moves', 'Z X C A S V (P1) · U O P H N M (P2) · gamepad X Y RB LB B RT.'],
  ['Element orbs (X)', 'Hold X to form up to 3 orbs that circle you (longer hold = more). Let go and they keep orbiting while you move. Each tap of X throws one along your aim. Unused orbs fade after 7 s.'],
  ['Jets', 'Hold S to fly along the arrows until you let go or run out of mana.'],
  ['Mana', 'Orange bar: moves cost mana, it refills on its own.'],
  ['Ultimate', 'Purple bar: fills only by dealing damage. Full = V unleashes your ultimate.'],
];

// [key, name, description]
export const MOVES = {
  fire: [
    ['Z', 'Lightning', 'Short wind-up, then an instant bolt along your aim. Fuses sand to glass, electrifies water.'],
    ['X', 'Fireballs', 'Hold to conjure up to 3 orbiting fireballs, tap X to throw each. Explode on impact or near an enemy.'],
    ['C', 'Kick Barrage', 'Three flaming kicks, each firing a fire crescent. Cuts and ignites wood.'],
    ['A', 'Plasma Lance', 'Hold 4 s for a lance that pierces everything across the map. Let go early and it fizzles.'],
    ['S', 'Fire Jet', 'Hold to fly on flame jets.'],
    ['V', 'Inferno Ascension', 'Power up, explode, then 8 s ascended: full mana, cooldowns twice as fast.'],
  ],
  earth: [
    ['Z', 'Magma Surge', 'The ground ahead erupts in a lava geyser that cools into rock. Aim up for taller.'],
    ['X', 'Stones', 'Hold to rip up to 3 stones from the ground that orbit you, tap X to hurl each.'],
    ['C', 'Stone Wall', 'A pillar bursts up in front of you. Down+C: under your own feet, launching you.'],
    ['A', 'Stone Cage', 'Rock walls and a roof slam shut around the nearest enemy.'],
    ['S', 'Sand Jet / Surf', 'Hold: surf a sand wave on the ground, or jet through the air.'],
    ['V', 'Tectonic Rupture', 'A fissure of 12 growing stone spikes races forward, then shatters.'],
  ],
  water: [
    ['Z', 'Water Whip', 'A lash of water ~45 cells along your aim. Press again quickly for a second lash that yanks them toward you.'],
    ['X', 'Ice Spears', 'Hold to draw water into up to 3 orbiting ice spears, tap X to fire each. A hit pins them in ice for 0.4 s, so the next spear lands.'],
    ['C', 'Bubble Trap', 'A water orb that traps the first enemy it hits: they float helplessly, drowning, for 2 s.'],
    ['A', 'Flash Freeze', 'Everything within ~40 cells freezes; enemies are frozen solid for 2 s. Hit a frozen enemy to shatter the ice for +10 damage.'],
    ['S', 'Riptide', 'Hold to fly on a water jet. Faster and cheaper from inside water.'],
    ['V', 'Glacial Cataclysm', 'A tsunami that freezes mid-air, then shatters into an ice-shard storm.'],
  ],
  air: [
    ['Z', 'Vacuum Sphere', 'A sphere that sucks in everything nearby, then pops and flings it all outward.'],
    ['X', 'Air Cannons', 'Hold to compress up to 3 orbiting air balls, tap X to fire each: bursts into a wind shockwave.'],
    ['C', 'Tornado', 'Aimable: travels along the ground, flies diagonally, or carries you up (Down).'],
    ['A', 'Sonic Clap', 'Hold 2.5 s: a cone that turns rock to powder, blasts everything away and stuns 1 s.'],
    ['S', 'Air Flight', 'Hold to ride the wind, leaving afterimages.'],
    ['V', 'Wind Dragon', 'A serpent of wind tears across the map carrying debris, then dives into a huge blast.'],
  ],
};

// [name, how, result, bender or null for anyone / the world]
export const COMBOS = [
  ['Battering Ram', 'Stone Wall (C) → Sand Jet / Surf (S) into the pillar', 'The whole pillar fires forward as a ram.', 'earth'],
  ['Pillar Launch', 'Down + Stone Wall (C)', 'The pillar erupts under your feet and launches you skyward.', 'earth'],
  ['Whip Snap', 'Water Whip (Z) → Z again', 'The second lash yanks the enemy right in front of you: follow with Flash Freeze or a spear.', 'water'],
  ['Shatter', 'Flash Freeze (A) → hit them with anything', 'The ice shatters for +10 bonus damage.', 'water'],
  ['Ice Lock', 'Ice Spear (X) → Ice Spear → Ice Spear', 'Each spear pins them in ice for the next one: a 3-hit combo.', 'water'],
  ['Frozen Bubble', 'Bubble Trap (C) → Flash Freeze (A)', 'The trapped enemy freezes solid inside the bubble for 3 s, at any range.', 'water'],
  ['Volley', 'Hold X for 3 orbs → jet or jump into position → tap X three times', 'Three shots from three angles while you move, before they can react.', null],
  ['Shocking Water', 'Lightning (Fire Z) into water', 'The whole connected body of water is electrified: anyone in it gets shocked.', 'fire'],
  ['Glassmaker', 'Lightning on sand', 'Sand fuses into glass.', 'fire'],
  ['Fire Tornado', 'Tornado (Air C) through fire', 'The tornado catches fire and flings flames out of the top.', 'air'],
  ['Waterspout', 'Tornado (Air C) through water', 'The tornado becomes a waterspout.', 'air'],
  ['Debris Bomb', 'Vacuum Sphere (Air Z) near sand, water, fire or rubble', 'It packs it all into one ball that bursts outward.', 'air'],
  ['Pulverize', 'Sonic Clap (Air A) on rock, glass or obsidian', 'Turns it to sand: loose ground to throw, surf or suck into a tornado.', 'air'],
  ['Ice Bridge', 'Flash Freeze (Water A) on water', 'Water turns to ice you can stand on. Lava turns to obsidian.', 'water'],
  ['Woodcutter', 'Kick Barrage (Fire C) through trees, plants or rope bridges', 'Cuts and ignites them.', 'fire'],
  ['Obsidian', 'Water or ice meets lava', 'Lava hardens into obsidian (and steam).', null],
  ['Steam', 'Fire meets water or ice', 'Turns into steam.', null],
  ['Glass', 'Lava touches sand', 'The sand melts into glass.', null],
  ['Mud', 'Water soaks into earth', 'The earth turns to mud.', null],
  ['Rubble', 'Explosions on stone', 'Stone crumbles into loose rubble.', null],
];
