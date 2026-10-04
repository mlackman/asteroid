// Run state and game rules. Independent of rendering and of the physics
// engine: the game decides which controls reach the simulation, and the
// simulation stays a pure physical model.

export const SHIP = { fuelCapacity: 100, ammoCapacity: 60, hullMax: 100, cargoCapacity: 400 };
export const FIRE_INTERVAL = .38;
// Main-engine burn per second of thrust. Turning uses reaction wheels and is free.
export const FUEL_PER_SECOND = 2.5;

export class Game {
  constructor(ship = SHIP) {
    this.ship = { ...ship };
    this.credits = 0;
    this.newRun();
  }
  // A fresh launch from the station: full tanks and an empty hold. Credits carry over.
  newRun() {
    this.fuel = this.ship.fuelCapacity;
    this.ammo = this.ship.ammoCapacity;
    this.hull = this.ship.hullMax;
    this.cargo = [];
    this.fireCooldown = 0;
    this.thrusting = false;
  }
  get cargoMass() { return this.cargo.reduce((sum, item) => sum + item.mass, 0); }
  get cargoValue() { return this.cargo.reduce((sum, item) => sum + item.value, 0); }
  // Fire on the press as well as while held: a brief tap must not disappear
  // between simulation steps.
  tryFire() {
    if (this.fireCooldown > 0 || this.ammo <= 0) return false;
    this.ammo--;
    this.fireCooldown = FIRE_INTERVAL;
    return true;
  }
  // Advance the rules by one simulation step. Returns the controls the ship may
  // actually use and whether a held trigger fires a round this step.
  update(keys, dt) {
    this.fireCooldown -= dt;
    const controls = new Set(keys);
    this.thrusting = controls.has('KeyW') && this.fuel > 0;
    if (this.thrusting) this.fuel = Math.max(0, this.fuel - FUEL_PER_SECOND * dt);
    else controls.delete('KeyW');
    const fire = keys.has('Space') && this.tryFire();
    return { controls, fire };
  }
}
