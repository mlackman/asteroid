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

### M1: Ore and collection (the question that matters most: is cutting ore fun?)

- **Ore veins as polygons in the asteroid's local coordinates.** Texture coordinates
  already stay in the original asteroid's frame, so a fragment's ore content =
  `area(clip(fragmentShape, veinPolygons))`. Compute it in the worker inside
  `prepareFracture` and send it back as metadata with each piece. Value comes from
  the actual geometry.
- Render veins by baking them into the rock texture (glinting metallic streaks).
  Because UVs stay in the original frame, the veins line up automatically on every fragment.
- **Scoop**: fragments under an area threshold that touch the ship's nose get
  absorbed. Add value × mass to cargo and remove the body.
- **Fuel and ammo**: thrust burns fuel, every shot costs ammo. HUD bars.
- **Station**: a static body. Docking (slow approach inside a radius) sells cargo and refuels.
- One hand-built asteroid with 2–3 veins. Playtest it.
- Done when: you cut out a vein, pick up the pieces, sell them, and the numbers make sense.

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
2. **Scoop only, or a tractor beam from the start?** Scoop only is simpler for M1;
   the tractor beam is a fun later unlock.
