# Art direction — Analog Site Sandbox

Status: accepted 2026-11-14. Scope: appearance only (scene look, 3D models, HUD, motion).
The N1–N7 physics contract in `spec-n1-n7-physics.md` stays on hold and is not touched by this work.

## Subject, audience, job

- Subject: a digital twin of one 20 m site, built from six site variables, with four pieces of hardware tested on it
  (rover, suit with EDS, lander LiDAR, ISRU drill) on the Moon, Mars and Earth analogs.
- Audience: Space Apps judges and the team, on laptops with integrated graphics.
- Single job: show how hardware behaves on a site, at 60 FPS, in a picture that reads in five seconds.

## Signature: the site as a cut block

The terrain is drawn as a geologic block diagram: the 20 m patch is a solid block cut out of the ground, with
stratified side walls, lit by the sun of that world and set against its sky. It is the one memorable element.
Everything around it is quiet.

Why: the patch is finite and honest about it (no fake horizon), the walls tie the surface to the subsurface the
drill mode already models, and a block on a plain backdrop is cheap to render.

Rejected: floating dark-glass panels over a full-bleed scene (previous look, generic), an infinite terrain with a
faked horizon (hides that the patch is a 20 m sample), Hasselblad réseau crosses over the viewport (a second
metaphor; removed to keep one signature).

## Tokens

### Chrome palette (CSS custom properties)

| Token | Hex | Role |
| :-- | :-- | :-- |
| `--basalt` | `#131211` | chrome background (solid, never translucent glass) |
| `--basalt-raised` | `#1c1a18` | controls, inset wells |
| `--seam` | `#36322d` | hairlines, slider tracks |
| `--regolith` | `#e4dfd6` | primary text |
| `--dust` | `#9a9388` | secondary text, units, captions |
| `--caution` | `#e3a63b` | status only: caution, and the "simulated values" notice |
| `--limit` | `#e5553b` | status only: limit exceeded, error |

### Body accent (one accent, re-tinted by the current world)

| Body | Value | Name |
| :-- | :-- | :-- |
| Moon | `#b8c7d6` | earthshine |
| Mars | `#e08a4f` | butterscotch |
| Earth | `#7fb69a` | tundra |

`--accent` is set on `:root` from the current body. Accent means "which world". Colour never means status unless it
is `--caution` or `--limit`, and status is always also written in words.

### Type

| Role | Family | Use |
| :-- | :-- | :-- |
| Display | Jost (variable), 500–600, uppercase, tracking 0.08–0.14em | title, mode names, section labels, block label |
| Body | B612 400/700 | control labels, captions, help text |
| Data | B612 Mono 400/700, tabular | every number, unit, telemetry value, FPS |

Reason: Jost follows Futura, the face of Apollo plaques and checklists; B612 was designed for legibility on cockpit
displays. Fonts are self-hosted from `@fontsource` packages (no network at runtime).
Scale (px): 11, 12, 13, 15, 20, 30. Nothing below 11.

### Motion

- `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`; `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`.
- Slider drags, live telemetry and FPS digits: no animation (they change many times per second).
- Mode switch (occasional, spatial consistency): the camera travels to the new framing in 550 ms with the
  ease-in-out curve; telemetry rows cross-fade in 160 ms with a 30 ms stagger; pressed button `scale(0.97)` 120 ms.
  A mode switch from the keyboard is instant.
- World change (occasional, prevents a jarring change): sky, light and terrain tint blend over 500 ms; `--accent`
  transitions `color`, `background-color` and `border-color` in 200 ms `ease`.
- First paint (once): rail, block label, then telemetry enter with `opacity` + 12 px translate, 240 ms, 60 ms apart.
- Only `transform` and `opacity` animate. Never `transition: all`. Hover motion is gated by
  `(hover: hover) and (pointer: fine)`. Under `prefers-reduced-motion` the camera snaps and only opacity fades stay.

## Layout

The chrome is docked, not floating: the canvas only covers the frame, so chrome never hides the scene and fewer
pixels are shaded.

```
>= 900 px wide
+------------+----------------------------------------------+
| TITLE      |                                    [ FPS  ] |
| MODE       |                                    telemetry |
| [1][2]     |              the block                 rows  |
| [3][4]     |                                              |
| SITE       |                                              |
| preset     |                                              |
| 6 sliders  +----------------------------------------------+
| seed  run  | MOON · SOUTH-POLE RIDGE   16° .72 .28 …  SIM |
+------------+----------------------------------------------+
  rail 304 px                 frame               block label 36 px

< 900 px wide: frame on top, block label, then the rail as a bottom drawer
(mode switch always visible; site controls collapse behind a "Site" toggle).
Very small (< 480 px wide or < 320 px high): scene, mode switch and the FPS number only.
```

- Telemetry is set directly on the right edge of the frame over a soft scrim, right-aligned, no box.
- The FPS box keeps every stat the user asked for (FPS, frame ms, 1 % low, worst frame, draw calls, triangles,
  sparkline) and adds the render scale and shadow state, so quality changes are visible, not silent.
- The block label always carries `SIMULATED VALUES · NOT FROM DATASETS` in `--caution`.

## 3D look per world (physically motivated)

| | Moon | Mars | Earth analog |
| :-- | :-- | :-- | :-- |
| Backdrop | black, faint vignette, no stars (a sunlit exposure shows none) | tawny gradient, brighter at the horizon | cold grey-blue gradient |
| Sun | hard, low (pole), white | smaller, softer, warm | medium, neutral |
| Fill | very low (no atmosphere) | strong tawny sky light | medium sky light |
| Haze | none | light dust tint at distance | light |
| Shadows | crisp and long | softer | soft |
| Regolith hue | neutral grey, lightness from albedo | ochre to rust | from the surface class (ice, basalt, ochre) |

- Tone mapping on, exposure per world. The old look clipped the terrain to white.
- Terrain tint comes from the shader (slope, height, a tiling detail texture), not from extra CPU work per synthesis.
- Block walls: strata bands by depth, a crisp rim line on the cut edge.
- Permanently shadowed presets: no direct sun; dim cold fill and the lamps carried by the hardware.
- In lander mode the visible sun must be the same vector the LiDAR solver uses.

## Hardware material kit

One shared set, so all four assets look like one programme: MLI gold foil, white thermal paint, anodised dark
aluminium, bare wheel aluminium, solar cell (procedural grid), gold visor, beta-cloth off-white, one orange marking
colour, emissive lamp. A small procedural environment map is applied to the metal and glass materials only, never
to the terrain. No logos or agency insignia. All geometry and textures are generated in code; no downloads.

## Performance contract ("fluid")

Measured before this work on the test machine (Intel UHD 620, Chrome 156): 60 FPS with a 1759×913 drawing buffer,
but 48–52 FPS (1 % low ~20) with a 1920×1080 buffer. The scene is fill-rate bound, so:

1. A quality governor steps one ordered ladder of (render scale, shadow map) levels from frame times, with
   hysteresis and back-off. Render scale never exceeds `min(devicePixelRatio, 1.5)`.
2. The terrain uses the cheapest lit material that achieves the look.
3. Budgets per mode: <= 90 draw calls (shadow pass included), <= 150 k triangles, one shadow-casting light, no post-processing passes.
4. The rAF loop stays allocation-free. One `WebGLRenderer`. Explicit `three` imports. No `enum`.
5. The benchmark pins the quality level while it measures and records it, so scenarios stay comparable.

## Copy

- Title: "Analog site sandbox". Line under it: "Hardware on terrain built from six site variables."
- Modes: "Rover traverse", "Suit dust · EDS", "Lander scan · LiDAR", "Ice drill · ISRU".
- Controls say what happens: "Pulse EDS", "Pause", "Resume", "Run benchmark (3 min)".
- Sentence case for help text; uppercase only through the display face.
