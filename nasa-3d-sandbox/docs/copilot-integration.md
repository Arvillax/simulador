# Copilot Integration & N1–N7 Alignment (`feat/copilot-integration`)

Technical handoff for the `nasa-3d-sandbox` 3D simulator changes prepared on branch `feat/copilot-integration` (from `main` `2af8c13`). All existing standalone HUD sliders, presets, and benchmarks remain intact and backwards-compatible.

---

## 1. New Bridge & N1–N7 Contract

### Files
- `src/bridge/copilotContract.ts`
- `src/bridge/copilotContract.test.ts`
- `src/bridge/sandboxDataBridge.ts`
- `src/bridge/sandboxDataBridge.test.ts`

### Capabilities
- **Dual 6D + N1–N7 ingestion (`handleSimulationControl`)**:
  - Accepts `analog` (`AnalogN1N7Payload`), `n1ToN7` (7-element array `[N1..N7]`), 7-element `vector`, or legacy 6-element `vector` (`[slope, tri, thermalInertia, albedo, tempK, ndvi]`).
  - Supports `whatIf` single-variable overrides (`{ variable: 'N1'..'N7', newValue }`) via `applyWhatIfToSiteState(...)` without re-sending the entire payload.
  - Supports `sunlit`, `targetBody` (`'MOON' | 'MARS'` or `'moon' | 'mars' | 'earth'`), `roverProfile` (`'VIPER' | 'PERSEVERANCE' | 'CURIOSITY'`), `lidarProfile` (`'ALHAT' | 'SPLICE' | 'CLPS' | 'M2020'`), and `diurnalPercentiles` (`{ p1, p99 }`) for relative `N5` normalization.
- **Missing-data honesty & ADR-003 guard**:
  - Non-finite / missing variables are recorded explicitly in `siteState.missingVars` (never coerced to `0`).
  - Missing `surfaceTempK` uses a neutral warm fallback (`280 K`) so missing data never fabricates permafrost/ice (`< 265 K`).
  - `NDVI` is forced to `0` on Moon and Mars (ADR-003).
- **Bidirectional transport (`CustomEvent` + `window.postMessage`)**:
  - Listens on both `nasa:simulation-control` and `nasa:copilot-command`, plus `window` `'message'` events validated by `parsePostMessageControl` (with optional origin restriction via `setBridgeParentOrigin(origin)` or `?origin=...`).
  - Emits deduplicated alerts (`1500 ms` cooldown per `code:severity`) on `nasa:sim-telemetry-alert` and `window.parent.postMessage` (when hosted in an iframe).
  - Supports `PULSE_EDS`, `RESET_DUST`, `RETRACT_DRILL_BITE`, `BOOST_DRILL_WOB`, `PAUSE`, and `RESUME` actions.
  - Exposes `getTelemetrySnapshot()` and `addAlertListener(...)`.
- **Mars gravity fix (`src/sandbox3d/BodyLook.ts`)**:
  - `GRAVITY_TOLERANCE` updated to `0.02` so `bodyFromGravity(3.72)` resolves to `'mars'` instead of `'earth'`.

---

## 2. Solver Alignment & Threshold Alerts

### `src/sandbox3d/solvers/ModeSolver.ts`
- `SolverContext` now includes preallocated `site: SitePhysicsState` and `emitAlert` (no per-frame heap allocations).

### `src/sandbox3d/solvers/RoverSolver.ts`
- Adds mission profiles (`VIPER`: `15° / 0.20 m` on Moon; `PERSEVERANCE` / `CURIOSITY`: `30° / 0.525 m` on Mars; slip red threshold `>= 60%`).
- Enforces `NDVI = 0` off Earth.
- Adds `slopeLimitDeg` telemetry field and alerts: `ROVER_SLOPE_EXCEEDED`, `ROVER_SLIP_CRITICAL`, `ROVER_LUNAR_1_6G_CAUTION`, `ROVER_OBSTACLE_EXCEEDED`.

### `src/sandbox3d/solvers/SuitDustSolver.ts`
- Aligns EDS constants to NASA KSC MISSE-11 (`EDS_VOLTAGE_KV = 4.0`, `EDS_FREQUENCY_HZ = 10`, `EDS_POWER_W = 3.0`).
- Couples Mars saltation (`N7`), Moon solar illumination (`N6` + `sunlit`), and `% SiO2` Orthofabric abrasion (`N4`, `wearPct`).
- Adds `resetDust()` and alerts: `SUIT_POWER_CRITICAL`, `SUIT_SOLAR_DEFICIT_PSR`, `SUIT_SILICA_ABRASION`, `SUIT_MARS_SALTATION`.

### `src/sandbox3d/solvers/LidarBvhSolver.ts`
- Adds `lidarLimitsForProfile`: `ALHAT` (`5°` / `0.30 m`), `SPLICE`, `CLPS`, `M2020`, plus `CAUTION` point classification.
- Enforces `NDVI = 0` off Earth and PSR (`!sunlit`) optical blind behavior (`opticalBlindPct = 100%`).
- Emits `LIDAR_PSR_OPTICAL_BLIND` and `LIDAR_ALHAT_HAZARD`.

### `src/sandbox3d/solvers/IsruDrillSolver.ts`
- Aligns TRIDENT parameters (`WOB_N = 100`, `TRIDENT_WOB_BOOST_N = 200`, `TRIDENT_STALL_TORQUE_NM = 16.0`, `TRIDENT_MAX_POWER_W = 200`, `TRIDENT_BITE_STEP_M = 0.1`), `silicaLithologyFactor(N4)`, and `0.10 m` bite retractions.
- Separates lunar cold-head caution (`DRILL_HEAD_TEMP_COLD`, Braycote 601EF) from Mars thermal melt cutoff (`DRILL_MARS_MELT_CUTOFF` when `bitTempC > 0 °C`).
- Adds `retractBite()`, `boostWob()`, and alerts: `DRILL_TORQUE_STALL`, `DRILL_POWER_LIMIT`.

---

## 3. Embed Mode (`?embed=1`) & `mountSandbox(...)` API

### Files
- `src/mountSandbox.ts`
- `src/embed.css`
- `src/main.ts`
- `src/sandbox3d/SandboxEngine.ts`
- `src/sandbox3d/TelemetryHUD.ts`
- `src/style.css`

### Usage
- **Iframe embed**: open with `?embed=1` (and optional `&origin=https://...`). Hides HUD sliders, presets, `#fps-box`, and `BenchPanel`; renders only the 3D canvas plus a non-blocking `.embed-bar` (world/PSR indicator, active mode, `"Simulated / Parametric 3D"` tag, missing-vars badge, and active alert pill).
- **Direct JS module mount**: call `mountSandbox(container, { embed: true, parentOrigin, initialControl })` returning `{ engine, bridge, sendControl, destroy, ... }`. Calling `destroy()` cancels `requestAnimationFrame`, disconnects observers, unregisters bridge listeners, and disposes the WebGL renderer.
- **Standalone HUD**: adds `Reset dust`, `Retract bite`, and `Boost WOB` buttons, syncs with `nasa:copilot-command`, and routes presets cleanly through `handleSimulationControl`.

---

## 4. Verification

Executed in `nasa-3d-sandbox/`:
- `npx tsc --noEmit` — passed (`0` errors)
- `npx vitest run` — `16` test files, `146` tests passed (`0` failed, `0` skipped)
- `npm run build` (`tsc && vite build`) — passed (`118` modules transformed)
