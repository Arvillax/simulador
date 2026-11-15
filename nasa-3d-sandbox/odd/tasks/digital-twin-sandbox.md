# Feature: Digital Twin 3D Sandbox (master plan 2)

Locator: `odd/tasks/digital-twin-sandbox.md` · Engram mirror: `odd/digital-twin-sandbox/tasks`

## Objective

Build the parametric 3D sandbox described in the master plan "plan 2: parametric 3D mini simulator" (kept outside
this repository), drive it with simulated values of the 6-variable vector, add an FPS box, measure performance, and estimate
how performance changes when the sandbox shares the browser with the geospatial viewer, the similarity search engine
and the ETL-derived files.

## Constraints

- Develop only in this repository. Nothing is written to `earth-analogs`, and no `earth-analogs` file is copied here.
- Remote: `github.com/Arvillax/simulador` (public), authorized by the user on 2026-11-15. Before that date nothing
  was uploaded and no git repository existed, by user request.
- Plan budgets: 60 FPS (< 16.67 ms/frame), terrain synthesis < 1 ms, one persistent `WebGLRenderer`,
  zero allocation inside the rAF loop, `pixelRatio <= 1.5`, explicit `three` imports (no `import * as THREE`).
- `tsconfig` uses `erasableSyntaxOnly`: no `enum`, no parameter properties.

## Context facts (from earth-analogs, read-only)

- Viewer library not decided yet (I-14 compares CesiumJS, deck.gl, MapLibre, Three.js; I-13 reports drops to
  10–15 FPS with 10 000 polygons in earlier versions).
- Search engine ("motor Rust/Wasm") location (worker or main thread), memory and latency are not defined.
- The web only reads `metrics.json` ("a few MB", max size pending, ADR-007 Q-2) and meshes (ADR-001).
- HEALPix level 12, land cells only (~2.5 km² per cell, ADR-002).

## Delivery strategy

Until 2026-11-15, `exception-ok`: no git by user request, so no work-unit commits, no PR slices and no native review.
Evidence for T1–T8.2 is recorded here instead. From 2026-11-15 the work lives in `github.com/Arvillax/simulador`;
the first commit is a baseline snapshot of T1–T8.2.

## Tasks

- [x] T1 — Scaffold Vite vanilla-ts project and install the exact plan dependencies. Route: inline (state commands).
  Evidence: create-vite 9.3.4; three 0.187.0, simplex-noise 4.0.3, alea 1.0.1, fast-2d-poisson-disk-sampling 1.0.3,
  three.quarks 0.17.1, three-mesh-bvh 0.9.18, @types/three 0.187.0, typescript ~7.0.2, vite ^8.3.6; 0 vulnerabilities.
- [x] T2 — Core sandbox: bridge, ScratchMath, engine, terrain, rocks, dust, assets, 4 solvers, HUD, FPS box, main,
  styles, unit tests for the pure math. Route: delegated writer (writer trigger: 2+ non-trivial files).
  Evidence: RED observed (5 files "Cannot find module"); `npx vitest run` 5 files / 25 tests pass (parent re-ran);
  `npx tsc --noEmit` exit 0 (parent re-ran); `npm run build` ok, main chunk 866.57 kB raw / 221.14 kB gzip (loaders
  lazy). ~3 300 TS lines. Node-only timing: terrain synthesis ~8 ms per vector change (noise 2.5, normals 3.4, BVH
  refit 2.0, rocks 0.5–2.6), full BVH rebuild ~11.5 ms — the plan's < 1 ms is not met. Library per-frame allocations:
  three-mesh-bvh hit objects (up to 1000/frame in LiDAR), three.quarks `Map.forEach` closure.
- [x] T3 — Benchmark harness and load scenarios: viewer (second WebGL canvas, 10k–200k cells), search engine (main
  thread vs Web Worker, 100k–5M cells × 6 dims), ETL files (`metrics.json` parse 2–32 MB). Route: delegated writer.
  Evidence: 8 test files / 46 tests, tsc ok, production build ok, 23 steps behind `?bench=1`.
- [x] T4 — Typecheck, test, build, and run in the browser. Route: inline (bounded commands).
  Evidence: production preview on 5191 renders; 60 FPS at a 380×221 pane.
- [ ] T5 — Run the benchmark, collect results, analyze. Route: inline (browser tools).
- [ ] T6 — Conclusions: how the sandbox performance is affected with viewer + search + ETL. Route: inline.

## Acceptance criteria

- `npm run build` and the unit tests pass.
- The app runs; the FPS box shows FPS, frame time and 1 % low.
- The 4 modes switch without creating a new renderer.
- The benchmark produces a results table per scenario (FPS, frame-time percentiles, % frames over budget, CPU ms of
  terrain synthesis and solvers).
- Conclusions separate measured facts from estimates and name the test machine.

## Checks

- `npx tsc --noEmit`, `npx vitest run`, `npm run build`, browser run with the benchmark.

## Progress

- 2026-11-14: T1 done. T2 done. Sanity run (dev server on port 5190; 5173 is taken by another local app):
  60 FPS, 1 % low 58.7, CPU 4.2 ms/frame in ROVER, 31 draw calls, ~49.5k triangles, drawing buffer 1759×913
  (pixel ratio 1.5 of 1.75). Test machine: Intel UHD Graphics 620 (ANGLE D3D11), 8 logical cores, 16 GB,
  Chrome 156 inside the Claude desktop app. With the browser pane hidden the loop throttles to ~1 FPS.
- 2026-11-14: T3 writer stopped by an API rate limit mid-task; resumed from its transcript.

- 2026-11-14: T3 done (8 test files / 46 tests, tsc ok, production build ok; served with `vite preview` on 5191).
  First benchmark attempt discarded: the browser pane was hidden and the loop throttled to ~4 FPS.
- 2026-11-14: The user shared the next contract (N1–N7 + `targetBody`) and asked NOT to implement it until told.

## T8 — Visual redesign (appearance only), authorized 2026-11-14

User: the design and modelling look weak; rebuild the designs, keep it fluid and pleasant, keep every earlier
constraint. Direction: `docs/art-direction.md` (frontend-design + animate skills). Physics N1–N7 (T7) stays on hold.
Baseline evidence (production preview, Intel UHD 620): 1280×720 CSS → 1920×1080 buffer → 48–52 FPS, 1 % low ~20;
terrain clipped to white, hardware made of boxes, panels overlap at small viewports.

- [x] T8.1 — Scene foundations: body looks (Moon/Mars/Earth), tone mapping, backdrop, sun + one shadow map, terrain
  shader tint and cut-block walls, rocks, dust sprite, camera travel, quality governor, benchmark quality pin.
  Route: delegated writer (2+ non-trivial files). Test-first for the pure parts (governor, look helpers).
  Evidence (2026-11-15): writer interrupted twice by API rate limits and resumed. New: BodyLook, QualityGovernor,
  Easing (each with tests), BlockWalls, DetailTexture, TerrainMaterial. Parent re-ran: `npx tsc --noEmit` exit 0,
  `npx vitest run` 11 files / 97 tests. Writer: build ok (main 899.73 kB / 232.37 kB gzip); ROVER 59–60 FPS at every
  level incl. L0 (1920×1080 buffer); LIDAR 48 FPS at L0, CPU-bound (raycasts 10.9 ms, dust 7.4 ms); draw calls ROVER 64,
  LIDAR 33, SUIT 30, DRILL 21; ~80 k triangles (stress 134.5 k); synthesis +0.014 ms. Parent screenshots: tone-mapped
  Moon with long shadows, Mars and Earth backdrops. Not measured: SUIT/DRILL FPS; FPS on the final build.
  Deviations: ACES tone mapping; shadowMap.autoUpdate true; block bottom 2.4 m below the lowest edge; dust not tone
  mapped. One base test (searchEngine dataset) got a 30 s timeout: it timed out at 5 s under machine load.
- [x] T8.2 — Hardware models: shared material kit, rover, suit, lander, drill rebuilt procedurally; rig contracts
  and physics dimensions unchanged. Route: delegated writer.
  Evidence (2026-11-15): rover built first (user priority). New HardwareKit, HardwareGeometry (+tests),
  AssetBuilder test. Parent re-ran: tsc exit 0, vitest 13 files / 130 tests. Writer: build ok (930.52 kB /
  242.72 kB gzip), no console errors; draw calls ROVER 37, SUIT 37, LIDAR 24, DRILL 28; triangles 82-93 k
  (stress 136-147 k); per asset rover 16 meshes / 8.5 k tris, suit 16 / 8.2 k, lander 9 / 7.6 k, drill 14 / 3.5 k.
  Suit rig joints added for T9 (pelvis, torso, helmet, hips, knees, ankles, shoulders, elbows, legLength 0.92).
  Parent screenshots: rover reads as flight hardware; suit on Mars reads as an EMU. FPS not measured (pane throttled).
  Risks: drill deck partly buried on rough presets; framing must be re-measured once the HUD rail docks.
- [ ] T8.3 — HUD: docked rail, block label, telemetry column, FPS box, benchmark panel, fonts, motion, responsive
  layout. Route: delegated writer.
- [ ] T8.4 — Verify: tsc, vitest, build; browser screenshots per mode and body; FPS at 1280×720 CSS. Route: inline.

Acceptance: all earlier acceptance criteria still hold; >= 55 FPS steady in every mode at 1280×720 CSS on the test
machine (the governor may lower render scale); <= 90 draw calls (shadow pass included) and <= 150 k triangles per mode; the "simulated
values" notice is always visible; usable at 380 px wide; reduced motion respected.

## T9 — Suit walking driven by the planet (authorized 2026-11-15)

User: "create the simulation of the suit walking according to the planet variables". Inputs: gravity (body) and the
current 6-variable vector (slope, roughness, thermal inertia). The N1–N7 spec defines no gait, so T7 stays on hold
and this task does not wait for it.

Sequencing: T8.2 (models writer, rover first) adds an articulated suit rig (pelvis, hips, knees, ankles, shoulders,
elbows, torso, helmet, legLength). T9 starts after T8.2 returns, in its own writer, so two writers never share files.

- [x] T9.1 — Gait model (pure, test-first): Froude scaling of speed and cadence with g and leg length, gait choice
  (walk / lope / skip) by Froude number, stance and flight phases, slope penalty and slip threshold, metabolic
  estimate. Every constant cites a source or is marked "not verified".
- [x] T9.2 — Gait animation: procedural joint angles from the gait phase, ground-following feet on the height field,
  rock avoidance on an automatic loop across the block, dust puff per footfall from the existing dust system.
- [x] T9.3 — Telemetry and HUD fields: gait, speed, cadence, Froude number, stride, slip margin, metabolic rate.
  Evidence (2026-11-15): GaitModel, GaitPose, WalkPath (+tests), SuitDustSolver, DustSystemQuarks, SandboxEngine.
  Parent re-ran: tsc exit 0, vitest 16 files / 167 tests (one earlier run showed 2 WalkPath timeouts under load;
  the isolated run and the next full run passed). Writer: build ok (949.77 kB / 249.80 kB gzip); planted feet slide
  0 m; draw calls 37; puffs share the dust batch; gait+pose 0.03-0.07 ms per frame; route grid 2.7 ms once per
  site change. Model values on the default vector: Moon lope 0.83 m/s, Mars walk 0.61, Earth walk 0.94.
  Not seen in the browser (pane hidden): FPS and the look of the walk are unverified.
- [ ] T9.4 — Verify: tsc, vitest, build; Moon/Mars/Earth side by side; SUIT mode FPS.

Default decisions (user may change): automatic loop path (deterministic for the benchmark) instead of keyboard
control; the EDS/dust behaviour of SUIT mode stays.

## T10 — Gait must respond to gravity (authorized 2026-11-15)

User: the walk barely changes with gravity; the jumping style should show. Diagnosis (code read): stride depends only
on Froude; the lope comfort speed is one fixed Apollo 11 value; Mars and Earth both walk (Fr ~0.1); no two-footed
hop; the lunar lope is timid (duty fixed 0.35, apex <= 0.15 m); hysteresis keeps the old gait after a gravity
change; the HUD gravity select does not change the world look. Sources: docs/gait-sources.md.

- [ ] T10.1 — Sources for hop/skip/lope by gravity (done by the parent, in docs/gait-sources.md).
- [ ] T10.2 — Gravity wiring: re-evaluate the gait when g changes (no stale hysteresis), HUD gravity select also
  sets the body look. Monotonic sweep tests over g.
- [ ] T10.3 — Continuous model: comfort speed and the Ap threshold depend on g; Mars may lope on flat ground if the
  physics says so; two-footed hop as a fourth gait only where the sources support it.
- [ ] T10.4 — Visible physics: swing period ~ sqrt(L/g), ballistic arc h = g t^2/8, landing knee flexion, arm
  balance, dust ejecta arc scaled with g; HUD shows the gait by name.
- [ ] T10.5 — Verify: sweep tests, Moon/Mars/Earth side by side, SUIT mode FPS with the pane visible.

Route: delegated writer on the Sonnet model (user request).
## Pending, on hold until the user says so

- [ ] T7 — Replace `Float32Array(6)` with `Float32Array(7)` N1–N7 plus `targetBody: 'MOON' | 'MARS'`: N1 slope °,
  N2 roughness m RMS, N3 relative relief m, N4 silica % SiO₂, N5 daily thermal range K (inverse proxy of thermal
  inertia), N6 illumination 0–1 (Moon only, drives the sun elevation), N7 wind / Shields 0–1 (Mars only, drives dust
  force and turbulence). Two-scale terrain (N1 linear + N3 low-frequency wave + N2 simplex octaves), rocks scale with
  N2, two-layer ISRU drill (regolith thickness ∝ N5, substrate MSE ∝ N4 and N2, no permafrost), modes 1–3 remapped.
  The pasted instruction was truncated at the copilot section (`N1_slope_deg`).
  Superseded the same day by the full physics spec, saved verbatim in `docs/spec-n1-n7-physics.md` (body
  `'earth' | 'moon' | 'mars'`, N7 = saltation time fraction f_Q, Bekker-Wong lookup tables, rover profiles, EDS,
  ALHAT/SPLICE, TRIDENT). Reviewer notes at the end of that file: undefined constants, panel geometry at the lunar
  pole, overlapping mode-3 thresholds, and the 100 m @ 0.05 m/px DEM (4 M samples) as the main 60 FPS risk.
  Still on hold until the user says so.

## Next step

T10 gravity-responsive gait (Sonnet writer), then T8.3 HUD and T8.4 verification. T5/T6 follow.
