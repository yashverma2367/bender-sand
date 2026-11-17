// Content for the in-game "How to Play" screen: controls, every bender's moves, and combos.
// Keep this in sync with abilities.js when moves change.

export const CONTROLS = [
  ['Move / aim', 'Arrows (P1) · I J K L (P2) · stick · touch joystick. Attacks aim 8 ways: forward, up, down and diagonals.'],
  ['Jump', 'Up (when no attack key is held) · A on gamepad · JUMP on touch. Air benders double-jump and glide (hold Up).'],
  ['Moves', 'Z X C A S V (P1) · U O P H N M (P2) · gamepad X Y RB LB B RT.'],
  ['Element orbs (X)', 'Hold X to form up to 3 orbs that circle you (longer hold = more). Let go and they keep orbiting while you move. Each tap of X throws one along your aim. Unused orbs fade after 7 s.'],
  ['Jets', 'Hold S to fly along the arrows for up to 2 s, then it cools down.'],
  ['Cooldowns', 'No mana: every move just has a cooldown. The bar under each button refills; lit = ready.'],
  ['Ultimate', 'Purple bar: fills only by dealing damage. Full = V unleashes your ultimate.'],
];

// [key, name, description]
export const MOVES = {
  fire: [
    ['Z', 'Blaze Wall', 'Stomp: a huge wall of fire (power 45) rolls forward along the ground. Weaker attacks passing through burn up; anyone it hits is scorched (14) and thrown. In the air: slam down first.'],
    ['X', 'Fireballs', 'Hold to conjure up to 3 orbiting fireballs, tap X to throw each. Explode on impact or near an enemy, and the spot keeps burning for 4 s.'],
    ['C', 'Lava Stomp', 'Stomp: the ground in front of you melts into real lava out to ~80 cells. Anyone on it is scorched and keeps burning; it flows, boils water and cools back to stone.'],
    ['A', 'Lightning', 'Brief wind-up, then an instant bolt (power 35). Fire\'s answer to Water: electrifies water attacks and shocks the water bender.'],
    ['S', 'Fire Jet', 'Hold to fly on flame jets.'],
    ['V', 'Inferno Ascension', 'Power up, explode, then 8 s ascended: cooldowns twice as fast.'],
  ],
  earth: [
    ['Z', 'Boulder', 'A huge rock tears out of the ground, then you punch it along your aim at supersonic speed (power 55). Big blast; leaves a pile of sand and mud.'],
    ['X', 'Stones', 'Hold to rip up to 3 stones from the ground that orbit you, tap X to hurl each. Each leaves sand and mud where it lands.'],
    ['C', 'Earth Wall', 'Hold: a stone wall bursts out of the ground in front of you, grows up, and turns with the arrows. It is built from the earth behind you (ground, street, rubble) and stops when that runs out.'],
    ['A', 'Rock Parry', 'A 0.4 s counter stance behind a stone slab. Any attack that hits you in that window is absorbed and a stone pillar erupts under the attacker (14, launches them). Whiff it and you can\'t attack for 0.5 s.'],
    ['S', 'Sand Jet / Surf', 'Hold: surf a sand wave on the ground, or jet through the air.'],
    ['V', 'Continental Rift', 'The ground cracks around the nearest enemy, collapses into a deep chasm, then the sides slam shut: 45 damage to anyone caught inside.'],
  ],
  water: [
    ['Z', 'Water Form', 'For 1/3 s your body turns to water: every attack passes straight through you. Time it right as a hit lands to get the cooldown back.'],
    ['X', 'Ice Spears', 'Hold for up to 3 orbiting ice spears, tap X to fire each. Each hit bursts into a frost bloom of real ice spikes that freeze anyone they reach (0.7 s); a spear into a frozen enemy shatters them (+12).'],
    ['C', 'Tidal Wave', 'Hold: pull in every bit of water nearby (further the longer you hold). Release: a wave sized by it crashes forward, pulverizing walls and ground in its path and growing from the rubble.'],
    ['A', 'Vine Dome', 'Hold: plants weave a dome around you and nothing that hits you does damage. Fire burns it, attacks of power 50+ tear it down; it regrows while held. You can\'t move inside.'],
    ['S', 'Riptide', 'Hold to fly on a water jet. Faster and cheaper from inside water.'],
    ['V', 'Glacial Cataclysm', 'A tsunami that freezes mid-air, then shatters into an ice-shard storm.'],
  ],
  air: [
    ['Z', 'Wind Blades', 'Two fast crescents of air along your aim (power 9 each, 5 dmg + a shove). Air beats water: they scatter water attacks into mist. (Fire beats air: a blade just feeds a fireball.)'],
    ['X', 'Air Cannons', 'Hold to compress up to 3 orbiting air balls, tap X to fire each: bursts into a wind shockwave.'],
    ['C', 'Tornado', 'Aimable: travels along the ground, flies diagonally, or carries you up (Down).'],
    ['A', 'Sonic Boom', 'A quick wind-up, then a supersonic shockwave cone (power 22, sonic beats earth: x2 vs stone, but a Boulder plows through). Shatters stone attacks, pulverizes rock to sand, blasts enemies away (10-18) and stuns 0.5 s. Air\'s answer to Earth.'],
    ['S', 'Air Flight', 'Hold to ride the wind, leaving afterimages.'],
    ['V', 'Wind Dragon', 'A serpent of wind tears across the map carrying debris, then dives into a huge blast.'],
  ],
};

// [name, how, result, bender or null for anyone / the world]
export const COMBOS = [
  ['Bridge', 'Earth Wall (C) aimed sideways or up', 'Steer it into a walkway or a ramp to climb buildings.', 'earth'],
  ['Shatter', 'Ice Spear (X) → Ice Spear', 'The first spear\'s frost bloom freezes them, the second shatters the ice for +12.', 'water'],
  ['Wave Rider', 'Tidal Wave (C) → Riptide (S) inside it', 'Riptide is faster and cheaper from inside water: ride your own wave in.', 'water'],
  ['Flood the City', 'Tidal Wave (C) held near the harbor, fountain or sewer', 'More water in reach = a bigger wave that cuts through whole buildings.', 'water'],
  ['Slip Through', 'Water Form (Z) as a boulder, spear or blast hits you', 'It passes through you and you get the move back.', 'water'],
  ['Volley', 'Hold X for 3 orbs → jet or jump into position → tap X three times', 'Three shots from three angles while you move, before they can react.', null],
  ['Shocking Water', 'Lightning (Fire A) into water', 'The whole connected body of water is electrified: anyone in it gets shocked.', 'fire'],
  ['Dig Out', 'Earth Wall (C) on the street', 'The street behind you is sucked into the wall: you open a hole down into the subway.', 'earth'],
  ['Counter Juggle', 'Rock Parry (A) → Stones (X) while they fly', 'The counter pillar launches them: hurl stones at them in the air.', 'earth'],
  ['Glassmaker', 'Lightning on sand', 'Sand fuses into glass.', 'fire'],
  ['Fire Tornado', 'Tornado (Air C) through fire', 'The tornado catches fire and flings flames out of the top.', 'air'],
  ['Waterspout', 'Tornado (Air C) through water', 'The tornado becomes a waterspout.', 'air'],
  ['Pulverize', 'Sonic Boom (Air A) on rock, glass or obsidian', 'Turns it to sand: loose ground to throw, surf or suck into a tornado.', 'air'],
  ['Wall Breaker', 'Sonic Boom (Air A) on an Earth Wall or stones', 'Sonic beats earth: the wall turns to sand and the stones shatter.', 'air'],
  ['Stun Combo', 'Sonic Boom (A) → Wind Blades (Z) / Air Cannon (X)', 'They\'re stunned for half a second: free hits.', 'air'],
  ['Steam Screen', 'Blaze Wall (Fire Z) hit by water', 'The water boils into a cloud of scalding steam between you.', 'fire'],
  ['Moat of Fire', 'Lava Stomp (C) → Blaze Wall (Z)', 'Melt the ground, then roll a wall of fire over it: nowhere to stand.', 'fire'],
  ['Obsidian Trap', 'Lava Stomp (C) into a Tidal Wave or water', 'Lava + water turns to obsidian and steam: the wave is stopped cold.', 'fire'],
  ['Obsidian', 'Water or ice meets lava', 'Lava hardens into obsidian (and steam).', null],
  ['Steam', 'Fire meets water or ice', 'Turns into steam.', null],
  ['Glass', 'Lava touches sand', 'The sand melts into glass.', null],
  ['Mud', 'Water soaks into earth', 'The earth turns to mud.', null],
  ['Rubble', 'Explosions on stone', 'Stone crumbles into loose rubble.', null],
];
