// Tunable game constants, gathered in one place. Lengths are world units,
// areas are square world units, speeds are the m/s shown on the HUD.

export const ORE = {
  countMin: 3,             // nuggets per asteroid
  countMax: 6,
  sizeMin: 10,             // nugget diameter
  sizeMax: 25,
  verticesMin: 5,          // corners of a nugget's crystal outline
  verticesMax: 8,
  surfaceMargin: 25,       // rock between the surface and a nugget when the asteroid forms
  depthMax: 130,           // deepest a nugget's center lies below the surface
  spacing: 20,             // smallest gap between two nuggets
  revealExposure: .15,     // share of a nugget's outline open to space before it shows
  detachExposure: .6,      // share open to space before it breaks free of its rock
  minRockPiece: 35,        // rock bits smaller than this stay stuck to a freed nugget as crust
  densityFactor: 1,        // ore density relative to rock; above 1 makes ore-bearing pieces heavier
  cleanTolerance: 1        // rock area below which a nugget counts as clean
};

export const SHIP = {
  fuelCapacity: 100,
  ammoCapacity: 60,
  hullMax: 100,
  cargoCapacity: 1500,     // area of material (ore plus attached rock) the hold takes
  fireInterval: .38,       // seconds between rounds while the trigger is held
  fuelPerSecond: 2.5,      // main-engine burn; turning uses reaction wheels and is free
  // Thrust and turning torque are sized for the empty ship, so a load slows both.
  // 0: a load slows turning fully by its inertia; 1: the ship turns as if empty.
  loadTurnShare: .25
};

// Two rigid grappling poles, one on each wing. A pole grabs a piece its tip
// touches; the piece then moves as part of the ship.
export const POLES = {
  length: 30,              // reach from the mount when fully extended
  mountX: 9,               // mount on each wing, ship coordinates (bow is +y)
  mountY: -6,
  angle: 55,               // degrees out from the bow
  extendTime: .25,         // seconds to extend or retract
  grabReach: 2,            // tip-to-surface distance that grabs
  maxGrabSpeed: 30,        // highest speed relative to the piece that still grabs it
  maxArea: 1500,           // heaviest piece a pole holds (area of ore plus rock)
  stowMaxArea: 900         // largest piece that retracting a pole stows in the hold
};

export const ECONOMY = {
  oreValue: 1              // credits per unit of ore area; attached rock pays nothing
};

export const STATION = {
  position: { x: -640, y: -25 },
  radius: 70,              // docking ring
  maxDockSpeed: 25         // must be slower than this to dock
};

// Development switches.
export const DEBUG = {
  showOre: false,          // start with buried ore drawn (toggle with SHOW ORE)
  unlimitedFuel: true,     // thrust burns no fuel
  unlimitedAmmo: true      // firing spends no rounds
};
