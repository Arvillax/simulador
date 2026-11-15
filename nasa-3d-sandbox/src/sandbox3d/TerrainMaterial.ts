import { Color, MeshLambertMaterial, Vector2 } from 'three';
import type { Texture } from 'three';

/** Uniforms of the terrain tint. Colours are linear; all values are written in place, never replaced. */
export interface TerrainUniforms {
  readonly uDetail: { value: Texture };
  /** Tint of hollows and compacted ground. */
  readonly uTintLow: { value: Color };
  /** Tint of crests and loose dust. */
  readonly uTintHigh: { value: Color };
  /** Tint of steep faces (dust slides off, darker ground shows). */
  readonly uTintSteep: { value: Color };
  /** x = tan(mean slope), y = 1 / relief amplitude (1/m): height is measured against the mean plane. */
  readonly uRelief: { value: Vector2 };
  /** Micro-relief strength of the fine and the broad detail lookups. */
  readonly uBump: { value: Vector2 };
}

const VERTEX_PARS = /* glsl */ `
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;
`;

// The terrain mesh has an identity world matrix, so object space is world space.
const VERTEX_MAIN = /* glsl */ `
vTerrainPos = position;
vTerrainNormal = normal;
`;

const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uDetail;
uniform vec3 uTintLow;
uniform vec3 uTintHigh;
uniform vec3 uTintSteep;
uniform vec2 uRelief;
uniform vec2 uBump;
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;
`;

// Tint from height above the mean plane, slope (world normal) and two lookups of the tiling detail texture at
// incommensurate scales (1.37 m and 7.3 m), so the tiling never reads as a pattern. No per-vertex colour.
const FRAGMENT_TINT = /* glsl */ `
vec4 detFine = texture2D( uDetail, vTerrainPos.xz * 0.73 );
vec4 detBroad = texture2D( uDetail, vTerrainPos.xz * 0.137 + vec2( 0.31, 0.67 ) );
float terrainRelief = clamp( ( vTerrainPos.y - vTerrainPos.x * uRelief.x ) * uRelief.y * 0.5 + 0.5, 0.0, 1.0 );
float terrainSteep = smoothstep( 0.04, 0.3, 1.0 - normalize( vTerrainNormal ).y );
float terrainTone = clamp( terrainRelief * 0.55 + detBroad.a * 0.4 + detFine.r * 0.25 - 0.12, 0.0, 1.0 );
vec3 terrainTint = mix( uTintLow, uTintHigh, terrainTone );
terrainTint = mix( terrainTint, uTintSteep, terrainSteep * 0.75 );
diffuseColor.rgb = terrainTint * ( 0.86 + 0.28 * detFine.r );
`;

// Micro-relief: the stored slope of the detail height tilts the shading normal (world x/z into view space).
const FRAGMENT_NORMAL = /* glsl */ `
vec2 terrainBump = ( detFine.gb - 0.5 ) * uBump.x + ( detBroad.gb - 0.5 ) * uBump.y;
normal = normalize( normal - mat3( viewMatrix ) * vec3( terrainBump.x, 0.0, terrainBump.y ) );
`;

/**
 * Terrain material: Lambert (the cheapest lit model with shadows, fog and tone mapping) extended through
 * onBeforeCompile. Replaces the previous MeshStandardMaterial, whose specular term bought nothing on regolith.
 */
export function createTerrainMaterial(detail: Texture): { material: MeshLambertMaterial; uniforms: TerrainUniforms } {
  const uniforms: TerrainUniforms = {
    uDetail: { value: detail },
    uTintLow: { value: new Color(0.2, 0.2, 0.2) },
    uTintHigh: { value: new Color(0.5, 0.5, 0.5) },
    uTintSteep: { value: new Color(0.15, 0.15, 0.15) },
    uRelief: { value: new Vector2(0, 1) },
    uBump: { value: new Vector2(1.5, 0.9) },
  };
  const material = new MeshLambertMaterial({ color: 0xffffff });
  material.name = 'terrain-tint';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', FRAGMENT_TINT)
      .replace('#include <normal_fragment_maps>', FRAGMENT_NORMAL);
  };
  material.customProgramCacheKey = () => 'terrain-tint';
  return { material, uniforms };
}
