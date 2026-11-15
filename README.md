# Simulador — Analog site sandbox

A browser 3D digital twin of one 20 m site, built from six site variables, with four pieces of hardware tested on
it: a rover, a suited crew member with an electrodynamic dust shield, a lander LiDAR scan and an ISRU ice drill, on
the Moon, Mars and Earth analog sites. All values shown are simulated, not taken from datasets.

The app lives in [`nasa-3d-sandbox/`](nasa-3d-sandbox/).

## Run

```bash
cd nasa-3d-sandbox
npm install
npm run dev
```

## Checks

```bash
cd nasa-3d-sandbox
npx tsc --noEmit
npx vitest run
npm run build
```

Benchmark: open the built app with `?bench=1` (about 3 minutes, keep the tab visible).

## Documents

- [`docs/art-direction.md`](nasa-3d-sandbox/docs/art-direction.md) — look, type, motion and performance contract.
- [`docs/gait-sources.md`](nasa-3d-sandbox/docs/gait-sources.md) — sources for the suit gait model.
- [`docs/spec-n1-n7-physics.md`](nasa-3d-sandbox/docs/spec-n1-n7-physics.md) — next physics contract, on hold.
- [`odd/tasks/digital-twin-sandbox.md`](nasa-3d-sandbox/odd/tasks/digital-twin-sandbox.md) — tasks, evidence and
  progress.

Stack: Vite, TypeScript, three.js, three-mesh-bvh, three.quarks, simplex-noise.
