/**
 * Suited gait model (pure: no DOM, no WebGL, no allocation in `solveGait`).
 *
 * Sources are listed in docs/gait-sources.md. Every constant below cites one of them or carries the literal mark
 * "not verified". Outline:
 * 1. Each gait has a comfortable speed from dynamic similarity, v = sqrt(Fr · g · L) (Minetti 2001).
 * 2. The automatic choice is the gait with the lower cost of transport at its own comfortable speed (bouncing gaits
 *    become far cheaper at lunar g: Rader, Newman & Carr 2007; Minetti group), restricted by the suited
 *    walk-to-bouncing transition at the Apollo number Ap* = 0.68 (Carr & McGee 2009).
 * 3. Slope and roughness slow the walker; a slip margin from tan(slope) against an assumed boot friction stops it.
 */

export type Gait = 'stand' | 'walk' | 'lope' | 'run';

/** Numeric gait code for the HUD (telemetry fields are numeric). */
export const GAIT_CODE: Readonly<Record<Gait, number>> = { stand: 0, walk: 1, lope: 2, run: 3 };

// ------------------------------------------------------------------------------------------- Constants

/** Standard Earth surface gravity (m/s²), reference of the Minetti 2001 scaling v_planet = v_earth·sqrt(g/g_earth). */
export const G_EARTH = 9.81;
/** Lunar surface gravity (m/s²), as used by Carr & McGee 2009 for the Apollo Froude numbers. */
export const G_MOON = 1.62;
/** Mars surface gravity (m/s²). Mars suited gait has no data: values are Fr-scaling extrapolations (gait-sources.md). */
export const G_MARS = 3.71;

/** A7LB suit (Apollo 15–17), wet mass (kg). Carr & McGee 2009. */
export const SUIT_MASS_A7LB_WET_KG = 96.0;
/** Crew body mass (kg). not verified. */
export const CREW_BODY_MASS_KG = 80;

/** Suited walk to bouncing-gait transition, Apollo number Ap* = 0.68 ± 0.20. Carr & McGee 2009. */
export const AP_TRANSITION = 0.68;
/** Lope stays selected down to this fraction of Ap* once chosen (hysteresis band). not verified. */
const AP_HYSTERESIS = 0.9;

/** Apollo 11 suited lunar run speed estimate (m/s). Carr & McGee 2009. */
export const APOLLO11_LUNAR_RUN_SPEED = 0.89;
/** Apollo 16 suited lunar running metabolic rates, two conditions (W). Carr & McGee 2009. */
export const APOLLO16_RUN_METABOLIC_MIN_W = 326;
export const APOLLO16_RUN_METABOLIC_MAX_W = 429;

/**
 * Comfortable lope Froude number: the Apollo 11 speed estimate at lunar g with the 0.92 m suit leg of the rig,
 * Fr = 0.89² / (1.62 · 0.92) ≈ 0.53. Derived from Carr & McGee 2009; the leg length is the rig's (AssetBuilder).
 */
export const LOPE_COMFORT_FR = (APOLLO11_LUNAR_RUN_SPEED * APOLLO11_LUNAR_RUN_SPEED) / (G_MOON * 0.92);
/**
 * Comfortable walk, as an Apollo number: the Fr ≈ 0.25 preferred-walking rule of thumb (not verified) held as
 * Ap = Fr / M with M = 1 unsuited, so the suit's carried mass slows the walk (Carr & McGee 2009 premise).
 */
export const WALK_COMFORT_AP = 0.25;
/**
 * Walking Froude number rises in reduced gravity (limb swing does not scale): Kram, Domingo & Ferris 1997
 * (qualitative). The exponent of (g_earth / g) is not verified.
 */
export const WALK_LOW_G_EXPONENT = 0.1;
/** Comfortable run Froude number (kept for completeness; never chosen automatically). not verified. */
export const RUN_COMFORT_FR = 1.0;

/**
 * Cost of transport per kg of transported mass, COT = c·g + b (J kg⁻¹ m⁻¹): a gravity part (support and lift) and
 * a gravity-independent part (suit joint torques, limb swing). Values not verified; tuned so the lunar lope lands
 * in the Apollo 16 range and the walk/lope cost crossover sits between lunar and Mars gravity, which matches the
 * qualitative finding that bouncing gaits are far cheaper at lunar g (Rader, Newman & Carr 2007).
 */
const COT_WALK_G = 0.2; // not verified
const COT_WALK_B = 1.6; // not verified
const COT_LOPE_G = 0.4; // not verified
const COT_LOPE_B = 1.14; // not verified
const COT_RUN_G = 0.42; // not verified
const COT_RUN_B = 1.3; // not verified
/** Resting metabolic rate of the suited crew member (W). not verified. */
export const REST_METABOLIC_W = 100;
/** Muscle efficiency for positive work uphill. not verified. */
const UPHILL_EFFICIENCY = 0.25;

/** Boot-regolith friction coefficient. not verified. */
export const BOOT_FRICTION = 0.7;
/** Friction already used by push-off on level ground (horizontal / vertical ground force). not verified. */
export const GAIT_FRICTION_USE = 0.1;
/** Speed loss at TRI = 1 (fraction). not verified. */
const ROUGHNESS_SPEED_PENALTY = 0.1;

/** Relative stride length λ / L = 2.3 · Fr^0.3 (Alexander's dynamic-similarity fit). not verified. */
const STRIDE_COEFF = 2.3;
const STRIDE_EXPONENT = 0.3;
/** Walk duty factor = clamp(0.68 − 0.4·Fr, 0.55, 0.68). not verified. */
const WALK_DUTY_MAX = 0.68;
const WALK_DUTY_MIN = 0.55;
/** Lope duty factor per foot; trail and lead contacts follow each other, then one flight. not verified. */
const LOPE_DUTY = 0.35;
/** Run duty factor = clamp(0.4 − 0.1·Fr, 0.25, 0.4); two flights per stride. not verified. */
const RUN_DUTY_MAX = 0.4;
const RUN_DUTY_MIN = 0.25;

/** Boot kick speed at footfall = 0.6·v + 0.25 (m/s). not verified. */
const PUFF_KICK_RATIO = 0.6;
const PUFF_KICK_BASE = 0.25;
/** Ballistic range (m) that gives a full-size puff. not verified. */
const PUFF_FULL_RANGE_M = 0.4;
export const PUFF_MAX_COUNT = 16;

// ------------------------------------------------------------------------------------------- Types

export interface GaitInputs {
  /** Surface gravity (m/s²). */
  gravity: number;
  /** Hip joint to sole (m). */
  legLength: number;
  suitMassKg: number;
  bodyMassKg: number;
  /** Slope along the heading (deg), uphill positive. */
  slopeDeg: number;
  /** Terrain roughness index TRI, 0..1. */
  roughness: number;
  /** Boot-ground friction coefficient. */
  friction: number;
  /** Gait held before this evaluation (hysteresis); 'stand' when none. */
  previousGait: Gait;
  /** Forces one gait ('walk' | 'lope' | 'run'); null for the automatic choice. */
  forceGait: Gait | null;
}

export interface GaitState {
  gait: Gait;
  /** True when the slip margin is exhausted: the walker must stop and turn away. */
  stopped: boolean;
  /** m/s */
  speed: number;
  /** Steps per minute (two steps per stride). */
  cadence: number;
  /** Strides per second (Hz). */
  strideFrequency: number;
  /** One full stride, two steps (m). */
  strideLength: number;
  /** Fraction of the stride one foot is on the ground. */
  dutyFactor: number;
  /** Airborne time per stride (s); 0 for the walk. */
  flightTime: number;
  froude: number;
  apollo: number;
  /** 1 − required / available friction; ≤ 0 means a slip. */
  slipMargin: number;
  /** Estimated gross metabolic rate (W). */
  metabolicW: number;
  /** Human share of the transported mass, M. */
  massFraction: number;
}

export function createGaitInputs(overrides: Partial<GaitInputs> = {}): GaitInputs {
  return {
    gravity: G_MOON,
    legLength: 0.92,
    suitMassKg: SUIT_MASS_A7LB_WET_KG,
    bodyMassKg: CREW_BODY_MASS_KG,
    slopeDeg: 0,
    roughness: 0,
    friction: BOOT_FRICTION,
    previousGait: 'stand',
    forceGait: null,
    ...overrides,
  };
}

export function createGaitState(): GaitState {
  return {
    gait: 'stand',
    stopped: false,
    speed: 0,
    cadence: 0,
    strideFrequency: 0,
    strideLength: 0,
    dutyFactor: 1,
    flightTime: 0,
    froude: 0,
    apollo: 0,
    slipMargin: 1,
    metabolicW: REST_METABOLIC_W,
    massFraction: 1,
  };
}

// ------------------------------------------------------------------------------------------- Formulas

const DEG = Math.PI / 180;

/** Fr = v² / (g·L). Carr & McGee 2009. */
export function froudeNumber(speed: number, gravity: number, legLength: number): number {
  return (speed * speed) / (gravity * legLength);
}

/** Ap = Fr / M. Carr & McGee 2009. */
export function apolloNumber(froude: number, massFraction: number): number {
  return froude / massFraction;
}

/** M = human mass / (human + suit), the fraction of the transported mass carried by the human. Carr & McGee 2009. */
export function humanMassFraction(bodyMassKg: number, suitMassKg: number): number {
  return bodyMassKg / (bodyMassKg + suitMassKg);
}

/** 1 − (|tan slope| + push-off use) / friction. Symmetric up and down. Friction values not verified. */
export function slipMargin(slopeDeg: number, friction: number): number {
  return 1 - (Math.abs(Math.tan(slopeDeg * DEG)) + GAIT_FRICTION_USE) / friction;
}

/**
 * Speed factor on a slope, sqrt(1 − h²) with h = |tan slope| / (friction − push-off use): gentle grades barely slow
 * the walker, the factor reaches 0 at the slip limit. Shape not verified.
 */
export function slopeSpeedFactor(slopeDeg: number, friction: number): number {
  const h = Math.min(1, Math.abs(Math.tan(slopeDeg * DEG)) / Math.max(1e-6, friction - GAIT_FRICTION_USE));
  return Math.sqrt(1 - h * h);
}

/** Comfortable Froude number of a gait at gravity g for human mass fraction M. */
function comfortFroude(gait: Gait, gravity: number, massFraction: number): number {
  if (gait === 'lope') return LOPE_COMFORT_FR;
  if (gait === 'run') return RUN_COMFORT_FR;
  if (gait === 'walk') return WALK_COMFORT_AP * massFraction * Math.pow(G_EARTH / gravity, WALK_LOW_G_EXPONENT);
  return 0;
}

/** Cost of transport (J kg⁻¹ m⁻¹) of a gait at gravity g. Not verified (see the constants). */
export function costOfTransport(gait: Gait, gravity: number): number {
  if (gait === 'walk') return COT_WALK_G * gravity + COT_WALK_B;
  if (gait === 'lope') return COT_LOPE_G * gravity + COT_LOPE_B;
  if (gait === 'run') return COT_RUN_G * gravity + COT_RUN_B;
  return 0;
}

function dutyFactorOf(gait: Gait, froude: number): number {
  if (gait === 'walk') return Math.min(WALK_DUTY_MAX, Math.max(WALK_DUTY_MIN, WALK_DUTY_MAX - 0.4 * froude));
  if (gait === 'lope') return LOPE_DUTY;
  if (gait === 'run') return Math.min(RUN_DUTY_MAX, Math.max(RUN_DUTY_MIN, RUN_DUTY_MAX - 0.1 * froude));
  return 1;
}

/**
 * Solves the gait for the inputs and writes it into `out` (no allocation). Deterministic.
 */
export function solveGait(inp: GaitInputs, out: GaitState): GaitState {
  const g = inp.gravity;
  const L = inp.legLength;
  const m = humanMassFraction(inp.bodyMassKg, inp.suitMassKg);
  const totalMass = inp.bodyMassKg + inp.suitMassKg;
  const margin = slipMargin(inp.slopeDeg, inp.friction);
  out.massFraction = m;
  out.slipMargin = margin;

  if (margin <= 0) {
    out.gait = 'stand';
    out.stopped = true;
    out.speed = 0;
    out.cadence = 0;
    out.strideFrequency = 0;
    out.strideLength = 0;
    out.dutyFactor = 1;
    out.flightTime = 0;
    out.froude = 0;
    out.apollo = 0;
    out.metabolicW = REST_METABOLIC_W;
    return out;
  }

  // Speed penalties (not verified): slope headroom against the friction left after push-off, and roughness.
  const rough = inp.roughness < 0 ? 0 : inp.roughness > 1 ? 1 : inp.roughness;
  const factor = slopeSpeedFactor(inp.slopeDeg, inp.friction) * (1 - ROUGHNESS_SPEED_PENALTY * rough);
  const scale = Math.sqrt(g * L);

  let gait: Gait;
  if (inp.forceGait !== null && inp.forceGait !== 'stand') {
    gait = inp.forceGait;
  } else {
    gait = costOfTransport('lope', g) < costOfTransport('walk', g) ? 'lope' : 'walk';
    if (gait === 'lope') {
      // A bouncing gait below the suited transition is not observed: fall back to the walk.
      const vLope = Math.sqrt(comfortFroude('lope', g, m)) * scale * factor;
      const threshold = AP_TRANSITION * (inp.previousGait === 'lope' ? AP_HYSTERESIS : 1);
      if (apolloNumber(froudeNumber(vLope, g, L), m) < threshold) gait = 'walk';
    }
  }

  let speed = Math.sqrt(comfortFroude(gait, g, m)) * scale * factor;
  if (gait === 'walk') {
    // An inverted-pendulum walk stays below the transition.
    const vMax = Math.sqrt(AP_TRANSITION * m * g * L) * 0.98;
    if (speed > vMax) speed = vMax;
  }
  const fr = froudeNumber(speed, g, L);
  const stride = STRIDE_COEFF * L * Math.pow(fr, STRIDE_EXPONENT);
  const freq = stride > 1e-9 ? speed / stride : 0;
  const duty = dutyFactorOf(gait, fr);

  out.gait = gait;
  out.stopped = false;
  out.speed = speed;
  out.strideLength = stride;
  out.strideFrequency = freq;
  out.cadence = freq * 120;
  out.dutyFactor = duty;
  out.flightTime = gait === 'walk' || freq <= 0 ? 0 : Math.max(0, 1 - 2 * duty) / freq;
  out.froude = fr;
  out.apollo = apolloNumber(fr, m);
  const sinS = Math.sin(inp.slopeDeg * DEG);
  const climbW = sinS > 0 ? (totalMass * g * speed * sinS) / UPHILL_EFFICIENCY : 0;
  out.metabolicW = REST_METABOLIC_W + costOfTransport(gait, g) * totalMass * speed + climbW;
  return out;
}

// ------------------------------------------------------------------------------------------- Footfall dust

export interface PuffParams {
  /** Boot kick speed (m/s). */
  kickSpeed: number;
  /** Ballistic range of the kicked dust at 45° in vacuum, v²/g (m). */
  range: number;
  /** Ballistic flight time at 45°, sqrt(2)·v/g (s), clamped for display. */
  life: number;
  /** Number of motes. */
  count: number;
  /** Mote size (m). */
  size: number;
}

export function createPuffParams(): PuffParams {
  return { kickSpeed: 0, range: 0, life: 0, count: 0, size: 0 };
}

/**
 * Dust thrown at a footfall: ejecta fly ballistically, so range and flight time grow with kick speed and fall with
 * gravity (no drag: a vacuum model, not verified for Mars or Earth air). Kick constants not verified.
 */
export function footfallPuff(speed: number, gravity: number, out: PuffParams): PuffParams {
  const kick = PUFF_KICK_RATIO * Math.max(0, speed) + PUFF_KICK_BASE;
  const range = (kick * kick) / gravity;
  const s = Math.min(1, range / PUFF_FULL_RANGE_M);
  out.kickSpeed = kick;
  out.range = range;
  out.life = Math.min(1.6, Math.max(0.25, (Math.SQRT2 * kick) / gravity));
  out.count = Math.round(2 + (PUFF_MAX_COUNT - 2) * s);
  out.size = 0.05 + 0.1 * s;
  return out;
}
