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
    ['Z', 'Flame Stomp', 'Stomp: a fire shockwave races along the ground both ways, launching anyone it passes under. In the air: slam down first.'],
    ['X', 'Fireballs', 'Hold to conjure up to 3 orbiting fireballs, tap X to throw each. Explode on impact or near an enemy.'],
    ['C', 'Flame Wall', 'A wall of fire for 3 s (power 40): weak shots burn up in it, water makes a steam screen, enemies inside burn.'],
    ['A', 'Lightning', 'Brief wind-up, then an instant bolt (power 35). Fire\'s answer to Water: electrifies water attacks and shocks the water bender.'],
    ['S', 'Fire Jet', 'Hold to fly on flame jets.'],
    ['V', 'Inferno Ascension', 'Power up, explode, then 8 s ascended: full mana, cooldowns twice as fast.'],
  ],
  earth: [
    ['Z', 'Earth Grip', 'A stone hand bursts from the ground under the nearest enemy and holds their feet for 1 s (6 dmg): no walking, jumping or jetting. Smash the hand (power 25) to break free.'],
    ['X', 'Stones', 'Hold to rip up to 3 stones from the ground that orbit you, tap X to hurl each.'],
    ['C', 'Stone Wall', 'A pillar bursts up in front of you. Down+C: under your own feet, launching you.'],
    ['A', 'Rock Parry', 'A 0.4 s counter stance behind a stone slab. Any attack that hits you in that window is absorbed and a stone pillar erupts under the attacker (14, launches them). Whiff it and you can\'t attack for 0.5 s.'],
    ['S', 'Sand Jet / Surf', 'Hold: surf a sand wave on the ground, or jet through the air.'],
    ['V', 'Continental Rift', 'The ground cracks around the nearest enemy, collapses into a deep chasm, then the sides slam shut: 45 damage to anyone caught inside.'],
  ],
  water: [
    ['Z', 'Water Bullets', 'A rapid burst of 4 small water shots. Each one puts out a fire attack it meets.'],
    ['X', 'Ice Spears', 'Hold to draw water into up to 3 orbiting ice spears, tap X to fire each. A hit pins them in ice for 0.4 s, so the next spear lands.'],
    ['C', 'Tidal Wave', 'A wave of real water rolls along the ground: pushes enemies, drowns fire, leaves water to fight in.'],
    ['A', 'Erosion Jet', 'Hold: a high-pressure jet (power 65) that washes stone, earth and sand away. Water\'s answer to Earth.'],
    ['S', 'Riptide', 'Hold to fly on a water jet. Faster and cheaper from inside water.'],
    ['V', 'Glacial Cataclysm', 'A tsunami that freezes mid-air, then shatters into an ice-shard storm.'],
  ],
  air: [
    ['Z', 'Wind Blades', 'Two fast crescents of air along your aim (power 9 each, 5 dmg + a shove). Air beats water: they scatter water attacks into mist, and redirect fire shots they meet.'],
    ['X', 'Air Cannons', 'Hold to compress up to 3 orbiting air balls, tap X to fire each: bursts into a wind shockwave.'],
    ['C', 'Tornado', 'Aimable: travels along the ground, flies diagonally, or carries you up (Down).'],
    ['A', 'Sonic Boom', 'A quick wind-up, then a supersonic shockwave cone (power 35, sonic beats earth: x2 vs stone). Shatters stone attacks, pulverizes rock to sand, blasts enemies away (10-18) and stuns 0.5 s. Air\'s answer to Earth.'],
    ['S', 'Air Flight', 'Hold to ride the wind, leaving afterimages.'],
    ['V', 'Wind Dragon', 'A serpent of wind tears across the map carrying debris, then dives into a huge blast.'],
  ],
};

// [name, how, result, bender or null for anyone / the world]
export const COMBOS = [
  ['Battering Ram', 'Stone Wall (C) → Sand Jet / Surf (S) into the pillar', 'The whole pillar fires forward as a ram.', 'earth'],
  ['Pillar Launch', 'Down + Stone Wall (C)', 'The pillar erupts under your feet and launches you skyward.', 'earth'],
  ['Ice Lock', 'Ice Spear (X) → Ice Spear → Ice Spear', 'Each spear pins them in ice for the next one: a 3-hit combo.', 'water'],
  ['Wave Rider', 'Tidal Wave (C) → Riptide (S) inside it', 'Riptide is faster and cheaper from inside water: ride your own wave in.', 'water'],
  ['Wall Breaker', 'Erosion Jet (A) on a Stone Wall', 'The jet chisels through stone: no hiding behind earth walls.', 'water'],
  ['Volley', 'Hold X for 3 orbs → jet or jump into position → tap X three times', 'Three shots from three angles while you move, before they can react.', null],
  ['Shocking Water', 'Lightning (Fire A) into water', 'The whole connected body of water is electrified: anyone in it gets shocked.', 'fire'],
  ['Grip & Ram', 'Earth Grip (Z) → Stone Wall (C) → Surf (S) into the pillar', 'Hold them in place, raise a wall, then ram them while they can\'t dodge.', 'earth'],
  ['Counter Juggle', 'Rock Parry (A) → Stones (X) while they fly', 'The counter pillar launches them: hurl stones at them in the air.', 'earth'],
  ['Into the Rift', 'Earth Grip (Z) → Continental Rift (V)', 'Held in place, they can\'t escape the chasm before it slams shut.', 'earth'],
  ['Glassmaker', 'Lightning on sand', 'Sand fuses into glass.', 'fire'],
  ['Fire Tornado', 'Tornado (Air C) through fire', 'The tornado catches fire and flings flames out of the top.', 'air'],
  ['Waterspout', 'Tornado (Air C) through water', 'The tornado becomes a waterspout.', 'air'],
  ['Pulverize', 'Sonic Boom (Air A) on rock, glass or obsidian', 'Turns it to sand: loose ground to throw, surf or suck into a tornado.', 'air'],
  ['Wall Breaker', 'Sonic Boom (Air A) on a Stone Wall or stones', 'Sonic beats earth: the wall turns to sand and the stones shatter.', 'air'],
  ['Stun Combo', 'Sonic Boom (A) → Wind Blades (Z) / Air Cannon (X)', 'They\'re stunned for half a second: free hits.', 'air'],
  ['Steam Screen', 'Flame Wall (Fire C) hit by water', 'The water boils into a cloud of scalding steam between you.', 'fire'],
  ['Obsidian', 'Water or ice meets lava', 'Lava hardens into obsidian (and steam).', null],
  ['Steam', 'Fire meets water or ice', 'Turns into steam.', null],
  ['Glass', 'Lava touches sand', 'The sand melts into glass.', null],
  ['Mud', 'Water soaks into earth', 'The earth turns to mud.', null],
  ['Rubble', 'Explosions on stone', 'Stone crumbles into loose rubble.', null],
];
