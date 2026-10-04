// Run state and game rules. Independent of rendering and of the physics
// engine: the game decides which controls reach the simulation, and the
// simulation stays a pure physical model. Tunables live in config.js.
import { SHIP, ECONOMY, STATION, DEBUG } from './config.js?v=20261004';
export { SHIP };

// What delivered material pays. Rock stuck to the ore pays nothing; it only
// costs hold space and mass on the way home.
export function payout({ oreArea }, economy = ECONOMY) {
  return oreArea * economy.oreValue;
}

// One fixed simulation step as the page runs it: the rules decide which
// controls reach the ship, then the physics advances.
export function stepGame(game, simulation, keys, dt) {
  const { controls, fire } = game.update(keys, dt);
  if (fire) simulation.fire();
  simulation.step(controls);
}

export class Game {
  constructor(ship = SHIP, station = STATION, debug = DEBUG) {
    this.ship = { ...ship };
    this.station = station;
    this.debug = debug;
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
    this.docked = false;
  }
  get cargoMass() { return this.cargo.reduce((sum, item) => sum + item.oreArea + item.rockArea, 0); }
  get cargoValue() { return this.cargo.reduce((sum, item) => sum + payout(item), 0); }
  // Fire on the press as well as while held: a brief tap must not disappear
  // between simulation steps.
  tryFire() {
    if (this.fireCooldown > 0 || this.ammo <= 0) return false;
    if (!this.debug.unlimitedAmmo) this.ammo--;
    this.fireCooldown = this.ship.fireInterval;
    return true;
  }
  // Advance the rules by one simulation step. Returns the controls the ship may
  // actually use and whether a held trigger fires a round this step.
  update(keys, dt) {
    this.fireCooldown -= dt;
    const controls = new Set(keys);
    this.thrusting = controls.has('KeyW') && this.fuel > 0;
    if (!this.thrusting) controls.delete('KeyW');
    else if (!this.debug.unlimitedFuel) this.fuel = Math.max(0, this.fuel - this.ship.fuelPerSecond * dt);
    const fire = keys.has('Space') && this.tryFire();
    return { controls, fire };
  }
  // Stow a piece in the hold if it fits. Rock stuck to the ore
  // takes space too.
  collect(item) {
    if (this.cargoMass + item.oreArea + item.rockArea > this.ship.cargoCapacity) return false;
    this.cargo.push({ oreArea: item.oreArea, rockArea: item.rockArea });
    return true;
  }
  // Called each frame with the ship's distance from the station, its speed and
  // the ore-bearing pieces it carries on its poles. Arriving slowly inside the
  // ring docks once: the hold and the carried pieces are sold and the ship
  // refuelled and rearmed. Leaving the ring allows the next docking.
  updateDocking(distance, speed, carried = []) {
    if (distance > this.station.radius) { this.docked = false; return null; }
    if (this.docked || speed > this.station.maxDockSpeed) return null;
    this.docked = true;
    const sale = { items: this.cargo.length + carried.length, credits: this.cargoValue + carried.reduce((sum, item) => sum + payout(item), 0) };
    this.credits += sale.credits;
    this.cargo = [];
    this.fuel = this.ship.fuelCapacity;
    this.ammo = this.ship.ammoCapacity;
    return sale;
  }
}
