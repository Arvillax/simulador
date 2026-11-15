import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshLambertMaterial,
} from 'three';
import type { Texture } from 'three';
import { STRATA_BOUNDS_M } from './AssetBuilder.ts';
import type { Rgb } from './BodyLook.ts';
import { PLOT_SIZE, TERRAIN_SEGMENTS } from './TerrainGenerator.ts';

/** Thickness of the block below its lowest edge point (m). The bottom is flat. */
export const BLOCK_MIN_THICKNESS_M = 2.4;
/** Strata boundaries by depth below the local surface (m): the drill strata, then deeper beds. */
export const WALL_STRATA_BOUNDS_M: readonly number[] = [...STRATA_BOUNDS_M.slice(1), 3, 5.5, 9, 14];
/** The rim line sits this far above the cut edge so it never z-fights with the terrain (m). */
const RIM_LIFT_M = 0.012;
/** Tone of each bed between the light and the dark band colour (one more entry than boundaries). */
const STRATA_TONE: readonly number[] = [0, 0.42, 0.72, 0.5, 0.86, 0.62, 0.93, 0.76];

const EDGE = TERRAIN_SEGMENTS + 1;
const COLUMNS = EDGE * 4;

function glslFloats(values: readonly number[]): string {
  return values.map((v) => v.toFixed(3)).join(', ');
}

const VERTEX_PARS = /* glsl */ `
attribute vec2 aWall;
varying float vWallDepth;
varying float vWallAlong;
`;

// aWall.x is the surface height of the column: its difference with the vertex height is the depth below the
// local surface, 0 on the top row. Interpolating it over the two triangles of a quad is exact.
const VERTEX_MAIN = /* glsl */ `
vWallDepth = aWall.x - position.y;
vWallAlong = aWall.y;
`;

const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uDetail;
uniform vec3 uBandLight;
uniform vec3 uBandDark;
uniform vec3 uIceTint;
uniform float uIce;
varying float vWallDepth;
varying float vWallAlong;
const float STRATA_BOUNDS[${WALL_STRATA_BOUNDS_M.length}] = float[${WALL_STRATA_BOUNDS_M.length}]( ${glslFloats(WALL_STRATA_BOUNDS_M)} );
const float STRATA_TONE[${STRATA_TONE.length}] = float[${STRATA_TONE.length}]( ${glslFloats(STRATA_TONE)} );
`;

// Beds by depth with a thin darker line at each boundary (anti-aliased with fwidth), horizontal sediment
// streaks from the shared detail texture, ice tint below the dry top layer, and a slow darkening with depth.
const FRAGMENT_TINT = /* glsl */ `
float wallDepth = max( vWallDepth, 0.0 );
float wallAa = max( fwidth( wallDepth ), 0.0001 );
int wallBed = 0;
float wallLine = 0.0;
for ( int i = 0; i < ${WALL_STRATA_BOUNDS_M.length}; i ++ ) {
	float wallDist = wallDepth - STRATA_BOUNDS[ i ];
	if ( wallDist >= 0.0 ) wallBed = i + 1;
	wallLine = max( wallLine, 1.0 - smoothstep( 0.005, 0.005 + 1.5 * wallAa, abs( wallDist ) ) );
}
float wallGrain = texture2D( uDetail, vec2( vWallAlong * 0.19, wallDepth * 1.9 ) ).r;
vec3 wallTint = mix( uBandLight, uBandDark, STRATA_TONE[ wallBed ] );
wallTint = mix( wallTint, uIceTint, uIce * step( STRATA_BOUNDS[ 0 ], wallDepth ) * ( 0.3 + 0.3 * wallGrain ) );
wallTint *= 0.82 + 0.34 * wallGrain;
wallTint *= 1.0 - 0.5 * wallLine;
wallTint *= 1.0 - 0.4 * smoothstep( 2.0, 12.0, wallDepth );
diffuseColor.rgb = wallTint;
`;

/** Mean of the sediment-grain term of FRAGMENT_TINT (0.82 + 0.34 · grain, grain ≈ 0.5). */
const MEAN_GRAIN_GAIN = 0.99;
/** Ice tint of the beds below the dry top layer (the uIceTint value before the gain). */
const ICE_TINT: readonly number[] = [0.62, 0.74, 0.86];

/**
 * CPU mirror of the wall shader bed colour for one bed (0 = top bed), from the same palette and inputs as
 * setPalette, without the grain streaks and boundary lines. Used to tint the drill strata like the walls.
 * Writes linear RGB into out (no allocation).
 */
export function strataBandRgb(bed: number, low: Rgb, high: Rgb, ice: number, gain: number, out: Rgb): Rgb {
  const tone = STRATA_TONE[Math.min(Math.max(bed, 0), STRATA_TONE.length - 1)];
  const dark = 0.5 * gain;
  const iceMix = bed >= 1 ? ice * 0.45 : 0;
  for (let c = 0; c < 3; c++) {
    const band = high[c] * gain * (1 - tone) + low[c] * dark * tone;
    out[c] = (band * (1 - iceMix) + ICE_TINT[c] * gain * iceMix) * MEAN_GRAIN_GAIN;
  }
  return out;
}

/**
 * The cut block: four side walls under the terrain edge (one mesh, one draw call) and one rim line on the cut
 * edge (one draw call). Both are separate objects with a no-op raycast, so they never enter the terrain BVH or
 * the LiDAR raycasts. The bottom face is omitted: the orbit clamp keeps the camera above the horizon.
 */
export class BlockWalls {
  readonly mesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  readonly rim: LineLoop<BufferGeometry, LineBasicMaterial>;
  /** Elevation of the flat bottom after the last update (m). */
  bottomY = -BLOCK_MIN_THICKNESS_M;
  private readonly source = new Int32Array(COLUMNS);
  private readonly positions = new Float32Array(COLUMNS * 2 * 3);
  private readonly wall = new Float32Array(COLUMNS * 2 * 2);
  private readonly rimPositions = new Float32Array(COLUMNS * 3);
  private readonly positionAttr: BufferAttribute;
  private readonly wallAttr: BufferAttribute;
  private readonly rimAttr: BufferAttribute;
  private readonly uniforms: {
    uDetail: { value: Texture };
    uBandLight: { value: Color };
    uBandDark: { value: Color };
    uIceTint: { value: Color };
    uIce: { value: number };
  };

  /** `terrainPositions` is the terrain vertex array (x and z are copied once; heights on every update). */
  constructor(terrainPositions: Float32Array, detail: Texture) {
    this.uniforms = {
      uDetail: { value: detail },
      uBandLight: { value: new Color(0.5, 0.5, 0.5) },
      uBandDark: { value: new Color(0.15, 0.15, 0.15) },
      uIceTint: { value: new Color(0.62, 0.74, 0.86) },
      uIce: { value: 0 },
    };
    const normals = new Float32Array(COLUMNS * 2 * 3);
    const indices = new Uint16Array((EDGE - 1) * 4 * 6);
    const step = PLOT_SIZE / TERRAIN_SEGMENTS;
    let column = 0;
    let quad = 0;
    // Sides in loop order (+z, +x, -z, -x). Walking each side this way makes the outward face counter-clockwise.
    for (let side = 0; side < 4; side++) {
      const nx = side === 1 ? 1 : side === 3 ? -1 : 0;
      const nz = side === 0 ? 1 : side === 2 ? -1 : 0;
      for (let k = 0; k < EDGE; k++) {
        const ix = side === 0 ? k : side === 1 ? EDGE - 1 : side === 2 ? EDGE - 1 - k : 0;
        const iz = side === 0 ? EDGE - 1 : side === 1 ? EDGE - 1 - k : side === 2 ? 0 : k;
        const src = iz * EDGE + ix;
        this.source[column] = src;
        const x = terrainPositions[src * 3];
        const z = terrainPositions[src * 3 + 2];
        const along = side * PLOT_SIZE + k * step;
        for (let row = 0; row < 2; row++) {
          const v = column + row * COLUMNS;
          this.positions[v * 3] = x;
          this.positions[v * 3 + 2] = z;
          normals[v * 3] = nx;
          normals[v * 3 + 2] = nz;
          this.wall[v * 2 + 1] = along;
        }
        this.rimPositions[column * 3] = x;
        this.rimPositions[column * 3 + 2] = z;
        if (k < EDGE - 1) {
          const t0 = column;
          const t1 = column + 1;
          const b0 = column + COLUMNS;
          const b1 = column + 1 + COLUMNS;
          indices.set([t0, b0, b1, t0, b1, t1], quad * 6);
          quad++;
        }
        column++;
      }
    }

    const geometry = new BufferGeometry();
    this.positionAttr = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.wallAttr = new BufferAttribute(this.wall, 2).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('aWall', this.wallAttr);
    geometry.setIndex(new BufferAttribute(indices, 1));

    const material = new MeshLambertMaterial({ color: 0xffffff });
    material.name = 'block-walls';
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
        .replace('#include <map_fragment>', FRAGMENT_TINT);
    };
    material.customProgramCacheKey = () => 'block-walls';

    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'block-walls';
    this.mesh.frustumCulled = false; // heights change with every synthesis; the block is always framed
    this.mesh.matrixAutoUpdate = false;
    this.mesh.raycast = () => {};

    const rimGeometry = new BufferGeometry();
    this.rimAttr = new BufferAttribute(this.rimPositions, 3).setUsage(DynamicDrawUsage);
    rimGeometry.setAttribute('position', this.rimAttr);
    this.rim = new LineLoop(rimGeometry, new LineBasicMaterial({ color: 0xb8c7d6, fog: false, toneMapped: false }));
    this.rim.name = 'block-rim';
    this.rim.frustumCulled = false;
    this.rim.matrixAutoUpdate = false;
    this.rim.raycast = () => {};

    this.update(terrainPositions);
  }

  /** Copies the terrain edge heights into the wall top row and the rim (about 3 000 writes per synthesis). */
  update(terrainPositions: Float32Array): void {
    const source = this.source;
    const positions = this.positions;
    const wall = this.wall;
    const rim = this.rimPositions;
    let lowest = Infinity;
    for (let c = 0; c < COLUMNS; c++) {
      const y = terrainPositions[source[c] * 3 + 1];
      positions[c * 3 + 1] = y;
      wall[c * 2] = y;
      wall[(c + COLUMNS) * 2] = y;
      rim[c * 3 + 1] = y + RIM_LIFT_M;
      if (y < lowest) lowest = y;
    }
    const bottom = lowest - BLOCK_MIN_THICKNESS_M;
    for (let c = COLUMNS; c < COLUMNS * 2; c++) positions[c * 3 + 1] = bottom;
    this.bottomY = bottom;
    this.positionAttr.needsUpdate = true;
    this.wallAttr.needsUpdate = true;
    this.rimAttr.needsUpdate = true;
  }

  /**
   * Bed colours from the terrain palette. `ice` (0..1) tints the beds below the dry top layer; `gain` scales
   * the wall albedo so a low sun that hits the cut face head-on does not burn the strata to white.
   */
  setPalette(low: Rgb, high: Rgb, ice: number, gain: number): void {
    const dark = 0.5 * gain;
    this.uniforms.uBandLight.value.setRGB(high[0] * gain, high[1] * gain, high[2] * gain);
    this.uniforms.uBandDark.value.setRGB(low[0] * dark, low[1] * dark, low[2] * dark);
    this.uniforms.uIceTint.value.setRGB(0.62 * gain, 0.74 * gain, 0.86 * gain);
    this.uniforms.uIce.value = ice;
  }
}
