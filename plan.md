# Belt Prospector — plan

## Core loop (one run)

1. Launch from the **station** with limited fuel, ammo and cargo space.
2. Fly out into the belt. Rocks get richer, and more dangerous, the farther you go.
3. Use **scanners** to spot ore veins inside the rock, then shoot carefully to cut out ore-rich chunks.
4. **Scoop** small ore fragments into the hold, or **tow** big ones.
5. Fly home. Without drag, every burn outbound has to be cancelled by a burn back, so fuel is the main tension.
6. Sell the cargo, buy upgrades, and push deeper on the next run.

Failure: you run out of fuel or your hull breaks. A rescue tug brings you back, but
you lose your cargo (or your ship, in a hardcore mode).

## Milestones

### M0: Separate "game" from "demo" (small)

- `main.js` currently holds rendering, input and the game state all together. Split it into:
  - `game.js`: run state (fuel, ammo, hull, cargo, credits) plus the rules, with no
    Three.js dependency, so it can be tested with `node --test` the same way `Simulation` is.
  - `hud.js`: the DOM overlay for the gauges.
- Keep `physics.js` / `fracture.js` mostly as they are. The game layer sits on top of them.

### M1: Hidden ore and collection (implemented)

- **Ore nuggets** are hard convex crystals buried in the rock (`ore.js`,
  placed by `placeOre`). A rock's shape includes the ore it holds; fracture
  treats ore as solid rock, then hands each nugget **whole** to the piece that
  held most of it. Ore is never cut.
- **No clues**: a nugget is invisible until enough of its outline faces open
  space (`ORE.revealExposure`), then stays revealed.
- **Rounds stop at ore**: a drilling round detonates against buried ore; a
  round striking exposed ore blows against it in the open and pushes it.
- **Breaking free**: once most of a nugget faces open space
  (`ORE.detachExposure`) it separates from its rock. Rock too small to stand
  alone (`ORE.minRockPiece`) stays stuck to it as crust. A nugget can also fly
  off still embedded in a fragment.
- **Scoop** ore-bearing pieces (clean or dirty) by touching them with the bow
  at low relative speed. Attached rock takes hold space and costs a cleaning
  fee at the station; shooting the rock off first pays more.
- **Station** docking ring: arrive slowly to sell, refuel and rearm.
- All tunables live in `config.js` (ORE, SHIP, SCOOP, ECONOMY, STATION).
- Open: does it feel good? Tune nugget depth/size, reveal and detach shares,
  fee, by playtesting.

### M2: The belt

- **Seeded procedural generation** in chunks (e.g. 2000×2000 world-unit sectors),
  generated deterministically from `randomGenerator(seed + sectorId)`.
  `makeAsteroid(seed)` already takes a seed.
- **Streaming / sleeping**: the biggest technical change. Space is unbounded and
  nothing ever disappears, so a belt full of rocks would kill the 960 Hz substep
  budget. Bodies more than N units from the ship get serialized (shape, pose,
  velocity) and removed from Matter, then restored when you come back. Fragments
  you've already broken stay broken.
- **Depth zones**: the farther from the station, the bigger the rocks, the richer
  the veins, the faster the spin, the denser the field.
- **Navigation**: minimap/radar, a direction-and-distance marker for the station,
  and a velocity vector shown relative to the station (essential when there's no drag).

### M3: Ship and economy

- **Cargo mass is added to the ship body.** A full hold turns slower and needs
  more fuel to stop.
- Station shop between runs:
  - Fuel tank, engine thrust, turning torque
  - Cargo capacity
  - Ammo types: **deep drill** (longer drill depth), **shaped charge** (bigger
    crater), **cutter** (shallow, precise)
  - Scanner (shows veins through rock, range)
  - Tractor beam (tows large chunks on a spring constraint; their mass pulls on you)
  - Hull plating
- Persistence: a `localStorage` save (credits, upgrades, unlocked zones).

### M4: Hazards and materials

- **Hull damage**: the ship is currently indestructible. Add HP that takes damage
  from the impact impulse in `reboundRockContacts`, so careless blasts that throw
  debris back at you hurt.
- **Materials** by vein/rock type, applied as parameters to the fracture:
  - Ice: shatters wide (lower shatter threshold), cheap but plentiful
  - Metal: drill depth shrinks sharply, so you have to cut around it
  - Volatiles: a blast inside them triggers a second detonation (chain reactions)
- Fast-spinning rocks, drifting debris fields, and maybe a "micro-meteor storm"
  event that forces you home.

### M5: Polish and meta

- Contracts at the station ("deliver 1 intact chunk of >500 area", "clear a lane").
- Sound, particles for ore sparkle and scooping, screen shake.
- Optional: a daily seed plus a leaderboard as the first step toward online play.

## Technical risks

| Risk | Mitigation |
|---|---|
| Performance with many bodies (120 Hz × 8 substeps) | Sector streaming in M2; scoop or merge tiny debris; measure early with `tests/frame-pacing.html` |
| Debris explosion: every shot creates 2–4 new bodies | Auto-scoop or "dust out" fragments below the minimum area after N seconds (a deliberate rule, not silent material removal) |
| Ore metadata has to follow repeated splits | Keep veins in the original local frame and recompute per piece in the worker every time; no inheritance logic needed |
| Fuel tuning without drag can feel punishing | Make the station velocity indicator and a "brake assist" upgrade available early |

## Open decisions

1. **Roguelite or persistent?** Losing the ship on death (tense, short runs) versus
   losing only the cargo (relaxed, longer progression). Suggested: lose cargo,
   with hardcore mode as an option.
2. **Tractor beam** for towing pieces too large to scoop: later unlock (M3).
