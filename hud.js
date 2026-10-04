// DOM overlay: simulation telemetry, ship gauges and the event line.

const $ = selector => document.querySelector(selector);

// Consumables warn when nearly empty; the hold warns when nearly full.
function setGauge(name, value, max, warnWhenFull = false) {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const gauge = $(`#${name}-gauge`);
  gauge.querySelector('.fill').style.width = `${(share * 100).toFixed(1)}%`;
  gauge.classList.toggle('low', warnWhenFull ? share > .8 : share < .2);
}

export function describeBlast(blast, serial) {
  const description = blast.mode === 'split' ? `round passed through · ${blast.count + 1} pieces split along its tunnel`
    : blast.mode === 'shatter' ? `${blast.count} pieces shattered`
    : blast.count ? `${blast.count} pieces released` : 'Too little material for a stable split';
  return `FRACTURE ${String(serial).padStart(3, '0')} · ${description} · ${blast.depth.toFixed(0)} m penetration${blast.revealed > 0 ? ' · ORE EXPOSED' : ''}`;
}

export function showEvent(text) { $('#event').textContent = text; }

export function updateHud(game, simulation) {
  $('#retained').innerHTML = `${(simulation.retainedArea / simulation.totalArea * 100).toFixed(1)}<span>%</span>`;
  $('#fragments').textContent = String(simulation.rocks.length - 1).padStart(3, '0');
  $('#speed').innerHTML = `${(Math.hypot(simulation.ship.velocity.x, simulation.ship.velocity.y) * 60).toFixed(0)}<span> m/s</span>`;
  setGauge('fuel', game.fuel, game.ship.fuelCapacity);
  setGauge('ammo', game.ammo, game.ship.ammoCapacity);
  setGauge('hull', game.hull, game.ship.hullMax);
  setGauge('cargo', game.cargoMass, game.ship.cargoCapacity, true);
  $('#fuel-value').textContent = game.fuel.toFixed(0);
  $('#ammo-value').textContent = String(game.ammo);
  $('#hull-value').textContent = game.hull.toFixed(0);
  $('#cargo-value').textContent = `${game.cargoMass.toFixed(0)}/${game.ship.cargoCapacity}`;
  $('#credits').textContent = `${game.credits.toFixed(0)} CR`;
}
