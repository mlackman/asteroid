# Regolith — asteroid fracture demo

A single HTML page and vanilla JavaScript modules. Three.js renders a 2D scene;
Matter.js supplies rigid-body collisions. Pinned libraries are included locally,
so the demo does not need internet access or a build step.

## Run

```sh
cd /Users/mlackman/projects/space-game
python3 -m http.server 8000 --bind 127.0.0.1
```

Open http://localhost:8000 in a desktop browser with WebGL enabled.

- **W**: thrust. Release it to coast; there is no drag, gravity, or speed cap.
- **A / S**: apply left/right turning torque (D also turns right). Rotation keeps
  its momentum; use the opposite key to stop it.
- **Space**: fire from the tip of the V. Hold to fire every 0.38 seconds.
- **R**: reset the original asteroid and ship.
- **P** or **Pause**: pause/resume.
- **Scroll**: zoom. The camera follows the ship while keeping the nearby asteroid
  in view.
- **Fracture map**: reveal the rock's interlocking polygon cells.

## How fracture works

The large irregular polygon is partitioned into a seeded Voronoi tessellation.
Every cell keeps its original geometry and texture coordinates. A blast removes
3–6 neighboring cells (including the short drill corridor), and creates matching
physical fragments. No rock area disappears: placing the fragments back at their
original transforms exactly reconstructs the asteroid. If a blast breaks a neck,
any disconnected region becomes its own compound rigid body.

Swept segment collision checks keep fast bullets from skipping the surface.
They drill at 80 world units/second to a random depth of 14–34 units, or stop at
the first cavity, then explode. Fragments inherit the parent body's translation
and rotation and receive small off-center outward impulses; the retained rock
receives the corresponding recoil. The asteroid, fragments, and ship all collide.
The physics advances at a fixed 120 Hz with no air or contact friction.

This is an approximate fracture simulation: cracks follow precomputed cells,
there is no material stress solver, and the V-shaped ship cannot be destroyed.
Space is unbounded; fragments never wrap, vanish, or turn into score.

## Checks

```sh
node --experimental-default-type=module --test tests/*.test.js
```

The tests cover polygon-area conservation, shared-edge connectivity, shallow
penetration, frictionless motion, collision response, and repeated excavation.

## Libraries

- [Three.js](https://threejs.org/) 0.180.0 — MIT (see `vendor/THREE-LICENSE.txt`)
- [Matter.js](https://brm.io/matter-js/) 0.20.0 — MIT (see `vendor/MATTER-LICENSE.txt`)
