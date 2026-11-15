# Gait model sources (T9 — suit walking)

Consulted 2026-11-15. Only constants listed here as verified may be used without a "not verified" mark.

## Verified

| Constant | Value | Source |
| :-- | :-- | :-- |
| Froude number | `Fr = v² / (g·L)`, L = leg length | Carr & McGee 2009 |
| Walk-run transition, unsuited, 1 g | Fr* ≈ 0.5 | Kram, Domingo & Ferris 1997 |
| Walk-run transition, unsuited, reduced gravity | occurs at slower absolute speed; at 0.2 g and 0.1 g Fr* is above 0.5 (limb-swing forces) | Kram et al. 1997 |
| Walk-run transition, unsuited, lunar g | Fr* ≈ 0.9 | Carr & McGee 2009 |
| Apollo number | `Ap = Fr / M`, M = fraction of total transported mass carried by the human | Carr & McGee 2009 |
| Walk-run transition, suited, lunar (Apollo gait events) | Fr* = 0.36 ± 0.11; Ap* = 0.68 ± 0.20 (mean ± 95 % CI) | Carr & McGee 2009 |
| Suit mass A7L (Apollo 11–14) | 66.8 kg dry, 81.6 kg wet | Carr & McGee 2009 |
| Suit mass A7LB (Apollo 15–17) | 66.8 kg dry, 96.0 kg wet | Carr & McGee 2009 |
| Lunar suited running metabolic rate (Apollo 16) | 326 W and 429 W in two conditions | Carr & McGee 2009 |
| Lunar suited run speed (Apollo 11 estimate) | about 0.89 m/s (3.2 km/h) | Carr & McGee 2009 |
| Planet speed scaling (dynamic similarity) | `v_planet = v_earth · sqrt(g_planet / g_earth)` | Minetti 2001 (Acta Astronautica 49) |
| Froude number is a good first predictor of optimal walking speed and walk-run transition in other gravities | qualitative | Minetti 2001 |
| Bouncing gaits (skip, lope, hop) become far cheaper at lunar g; Apollo crews mostly used a hopping or skipping "lunar gait" | qualitative | Rader, Newman & Carr 2007 (SAE 2007-01-3134); Pavei et al. / Minetti group |

## Verified qualitatively in T10 (abstract or search summary read; exact figures not read)

| Finding | Source |
| :-- | :-- |
| Skipping is never more economical than running, but the difference becomes marginal at lunar gravity; both bouncing gaits approach the cost of walking on Earth | Pavei, Biancardi & Minetti 2015, J Appl Physiol 119(1):93-100 |
| On the Moon, two-footed hopping costs less than walking, skipping and running | Pavei & Minetti 2016, J Appl Physiol 120 (hopping) |
| Predictive simulation finds skipping more efficient than walking or running at low gravity, and a walk-skip rather than a walk-run transition (two speeds, three gravity levels tested) | Ackermann & van den Bogert, predictive simulation of low-gravity gait |
| Gait transitions in simulated reduced gravity are gradual, without an abrupt change in gait parameters | Ivanenko et al. 2011 (PubMed 21212248) |
| Apollo crews mostly used a loping gait that alternates feet; some preferred skipping; the kangaroo hop was judged less effective for forward travel by Aldrin | Apollo accounts summarised in Discover and Air & Space articles |
| Suited gait on complex lunar terrain may prefer an "Earth gait" for safety over least energy | Kim et al. 2023, Physiol Meas, doi 10.1088/1361-6579/acf993 |

Consequence: the bouncing gaits (lope, skip, two-footed hop) must become cheaper than walking as g drops. No source
gives a walk-to-skip Froude threshold or a speed at Mars gravity; any threshold at 0.38 g is an extrapolation and
must carry the mark "not verified".

## Not verified (use only with the mark "not verified")

- Preferred walking speed at Fr ≈ 0.25 (common rule of thumb; no primary source read).
- Unsuited leg length 0.9 m for a 1.80 m person (anthropometric rule of thumb).
- Slope at which a suited crew member slips or stops; any friction coefficient for regolith-boot contact.
- Metabolic rate of suited walking per planet beyond the Apollo 16 running values.
- Mars suited gait: no suited Mars data exists; Mars values are extrapolated from Fr scaling.

## Model consequences for T9

- Gait speed and cadence scale with `sqrt(g·L)`; stride length grows as g drops.
- Use the suited lunar Fr* = 0.36 (or Ap with M from the suit mass) as the walk to bouncing-gait threshold, not
  0.5. Earth analog sites in a suit: same Ap model with g = 9.81 (mark as extrapolation).
- On the Moon the default gait is the bouncing "lunar gait" (skip/lope) with a visible flight phase; on Mars an
  intermediate walk with longer stride; on Earth an ordinary walk weighed down by the suit.

## Sources

- Kram R, Domingo A, Ferris DP (1997). Effect of reduced gravity on the preferred walk-run transition speed.
  J Exp Biol 200(4):821–826. https://pubmed.ncbi.nlm.nih.gov/9076966/
- Carr CE, McGee J (2009). The Apollo Number: space suits, self-support, and the walk-run transition. PLoS One
  4(8):e6614. https://pmc.ncbi.nlm.nih.gov/articles/PMC2719915
- Minetti AE (2001). Invariant aspects of human locomotion in different gravitational environments. Acta
  Astronautica 49:191–198. https://air.unimi.it/handle/2434/14709
- Rader AA, Newman DJ, Carr CE (2007). Loping: a strategy for reduced gravity human locomotion? SAE 2007-01-3134.
  https://saemobilus.sae.org/papers/loping-a-strategy-reduced-gravity-human-locomotion-2007-01-3134
