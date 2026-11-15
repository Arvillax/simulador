# Especificación Física y de Implementación 3D — Simulador Hardware-Terreno (N1–N7)

> Copia textual de la especificación entregada por el usuario el 2026-11-14. Estado: **en espera** — no se
> implementa hasta que el usuario lo indique. Las observaciones del agente están al final, separadas del texto
> original.

> **Propósito:** Contrato técnico único para implementar el motor físico-analítico en tiempo real (`JavaScript / TypeScript + Three.js` a 60 FPS) que evalúa 4 sistemas espaciales sobre análogos terrestres, Luna y Marte.
> **Base científica:** Investigación verificada `I-01` + `I-01-R1` (NASA NTRS, JPL, USGS, Honeybee Robotics y literatura revisada por pares).

---

## 0. Reglas obligatorias de implementación

1. **SI estricto dentro del motor:** Todas las fórmulas internas operan en `m`, `kg`, `s`, `N`, `Pa`, `J`, `W`, `rad`, `K`. Cualquier dato tabulado en `kPa`, `kN`, `MPa`, `GPa`, `mm`, `µm`, `g/cm^3` o `deg` **debe convertirse al entrar al motor**.
2. **Paso temporal estable (`dt`):** Limitar `dt = Math.min(rawDt, 1 / 30)` para evitar inestabilidades numéricas si la pestaña pierde foco.
3. **Prohibido inventar constantes:** Donde la literatura no tiene fórmula cerrada (ej. `Delta_T -> TI` sin albedo/atmósfera, o `% SiO2 -> Bekker`), usar exactamente los *lookup tables* y reglas híbridas definidas en la Sección 2.
4. **Brecha de escala explícita:** Los rasters de entrada (`N1..N3`) pueden provenir de celdas agregadas (~200 m – 1.7 km), mientras que rovers, `HDA` y taladros operan a escala local (`0.05 m – 100 m`). El motor evalúa la **realización local parametrizada** del punto seleccionado y debe declararlo en la telemetría.

---

## 1. Contrato de Entrada / Salida

### 1.1 Entradas por coordenada y contexto de escenario

```ts
export type TargetBody = 'earth' | 'moon' | 'mars';

export interface TerrainInputs {
  N1_slopeDeg: number;          // Pendiente topográfica theta [deg] (0..90)
  N2_roughnessRmsM: number;     // Rugosidad superficial sigma_RMS [m] (>= 0)
  N3_reliefM: number;           // Relieve relativo Delta_H en ventana fija [m] (>= 0)
  N4_silicaPct: number;         // Contenido de SiO2 [% en peso] (típico 40..78)
  N5_diurnalTempRangeK: number; // Amplitud térmica diurna Delta_T [K] (> 0)
  N6_solarIllumFrac: number;    // Fracción de iluminación solar I_sol [0..1] (solo Luna)
  N7_saltationTimeFrac: number; // Fracción del tiempo sobre umbral f_Q [0..1] (solo Marte; NO es Shields Theta)
}

export interface ScenarioParams {
  body: TargetBody;
  // Parámetros no incluidos en N1..N7 necesarios para cerrar modelos físicos:
  surfaceTempK: number;         // Temperatura superficial actual [K] (ej. 100..390 K Luna; 150..290 K Marte)
  albedoOverride?: number;      // Si se omite, se estima desde N4
  marsWindFrictionVelMs?: number; // u_* [m/s] (ej. 0..3.5 m/s en Marte)
  marsDustTau?: number;         // Espesor óptico atmosférico tau (típico 0.2..0.9)
  sunElevationDeg: number;      // Ángulo de elevación solar [deg] (1.5..5 deg típico Polo Sur Lunar)
  iceContentPct: number;        // % en peso de hielo intersticial [0..15] (crítico en polos lunares)
  regolithDepthM: number;       // Espesor de regolito suelto sobre roca madre [m] (ej. 0.05..2.0 m)
  roverProfile: 'perseverance' | 'curiosity' | 'viper';
  edsActive: boolean;           // Escudo electrodinámico encendido (Modo 2)
  missionElapsedSols: number;   // Tiempo acumulado de exposición a polvo [sols/días]
}
```

### 1.2 Constantes planetarias

| Cuerpo | `g` (`m/s^2`) | `P_atm` (`Pa` / `torr`) | `rho_f` gas (`kg/m^3`) |
| :--- | :--- | :--- | :--- |
| `'earth'` | `9.81` | `101325 Pa` (`760 torr`) | `1.225` |
| `'moon'` | `1.62` | `0 Pa` (`< 1e-4 torr`, vacío) | `0.0` |
| `'mars'` | `3.72` | `610 Pa` (`4.58 torr` nominal; rango `4.5–6.0 torr`) | `0.017` (`0.015–0.020`) |

### 1.3 Salida unificada de telemetría (por frame)

Cada modo devuelve `{ status: 'green' | 'yellow' | 'red', metrics: Record<string, number | string | boolean>, alerts: string[] }` para alimentar el HUD, el semáforo NASA y las transformaciones de Three.js.

---

## 2. Módulo 0 — Diccionario de Traducción Geofísica (`N4`, `N5` → Suelo y Roca)

### 2.1 De `N5` (`Delta_T`) a Inercia Térmica (`I`), Conductividad (`k`) y Grano (`d50`)

1. **Inercia térmica aparente (`ATI` → `I`):**
   - No existe ecuación analítica cerrada que despeje `I` solo desde `Delta_T` sin `albedo (A)`, `insolación` y `opacidad atmosférica`.
   - Aproximación operativa para el simulador:
     ```text
     A_eff = albedoOverride ?? albedoFromSilica(N4_silicaPct)
     ATI = (1 - A_eff) / max(N5_diurnalTempRangeK, 1.0)
     ```
   - Escalar `I` (`J/(m^2*K*s^0.5)`) según el cuerpo mediante calibración lineal `I = alpha * ATI + beta` acotada a rangos planetarios físicos (`Luna: 30..120`, `Marte polvo/arena: 30..350`, `Marte costra/roca: 350..1200`).

2. **Tamaño de grano (`d50`) y conductividad (`k`) — Marte (`P_torr = 4.5..6.0`, válido solo si `I < 350` y `k < 0.1`):**
   - Presley & Christensen (1997) / Fergason et al. (2006), con `C = 0.0015`, `K_p = 8.1e4 torr`, `rho_b * c = 1.0e6 J/(m^3*K)`:
     ```text
     exp_d = -0.11 * log10(P_torr / 81000)       // Para P_torr = 4.6 -> exp_d ≈ +0.467
     k_reg = I^2 / 1.0e6                         // [W/(m*K)]
     d_um  = (k_reg / (0.0015 * P_torr^0.6))^(1 / exp_d)   // [µm]
     d50_m = clamp(d_um * 1e-6, 1e-6, 0.01)      // [m]
     ```

3. **Conductividad (`k`) y densidad (`rho_b(z)`) — Luna (`P = 0`, Hayne et al. 2017):**
   - La ecuación marciana se anula en vacío (`P = 0`). Usar el perfil lunar con profundidad `z` (`m`), `rho_s = 1100 kg/m^3`, `rho_d = 1800 kg/m^3`, `H = 0.06 m`, `K_s = 7.4e-4 W/(m*K)`, `K_d = 3.4e-3 W/(m*K)`, `chi = 2.7`:
     ```text
     rho_b(z) = rho_d - (rho_d - rho_s) * exp(-z / H)                 // [kg/m^3]
     K_c(z)   = K_d - (K_d - K_s) * ((rho_d - rho_b(z)) / (rho_d - rho_s))
     k_reg(z, T) = K_c(z) * (1 + chi * (T / 350)^3)                  // [W/(m*K)]
     c_p(T) = -3.6125 + 2.7431*T + 2.3616e-3*T^2 - 1.234e-5*T^3 + 8.9093e-9*T^4  // [J/(kg*K)]
     ```
   - Si se requiere perfil hiperbólico Apollo (Carrier et al. 1991, `z_cm` en cm):
     ```text
     rho_b_kgm3(z_cm) = 1920 * ((z_cm + 12.2) / (z_cm + 18))
     ```

### 2.2 De `N4` (`% SiO2`) a Mineralogía, Dureza, `UCS` y Albedo PBR

No existe una única curva continua universal para rocas/regolitos; usar clasificación por rango de `SiO2` con interpolación suave entre extremos:

| Clase | `N4` (`% SiO2`) | `Mohs` | Dureza mineral discreta (Broz et al. 2006, `GPa`) | `UCS` roca intacta (`MPa`) | Albedo normal / PBR base | Densidad roca (`kg/m^3`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Máfica** (basalto / mares / MGS-1) | `<= 53%` | `5.5–6.6` | Plagioclasa/ortoclasa `6.87` | `100–400` (`30–150` fracturada) | `0.06–0.16` (mare DSNE `0.26`) | `2900–3100` |
| **Intermedia** (andesita) | `53–65%` | `5.8–6.8` | Interpolado | `100–300` | `0.16–0.30` | `2750–2900` |
| **Félsica** (granito / riolita) | `> 65%` | `6.0–7.0` | Cuarzo `12.2` | `100–250` (diseño `225`, microfisurada `68–111`) | `0.33–0.45` | `2600–2750` |

- **Regla de hielo intersticial (regiones polares):**
  - El regolito seco suelto (`JSC-1A`) tiene `UCS_reg ≈ 0 Pa`, pero saturado con `12.8 wt%` agua a `80 K` alcanza `100e6 Pa` (`100 MPa`), y con `10 wt%` a `193 K` (`-80 °C`) alcanza `42e6 Pa` (`42 MPa`).
  - Parametrización en el motor: `UCS_regolith = (iceContentPct / 12.8) * 100e6 * clamp((273.15 - surfaceTempK) / 193, 0, 1)` (capado a `100e6 Pa`).

### 2.3 Tabla discreta de parámetros Bekker-Wong (convertidos a SI)

> **Corrección aplicada respecto a `I-01`:** En `p = (k_c / b + k_phi) * z^n`, `k_c` tiene unidades `N/m^(n+1)` y `k_phi` tiene unidades `N/m^(n+2)`. Todos los valores abajo ya están en `Pa`, `rad`, `N`, `m`.

| Clase de suelo (criterio de selección) | `c` (`Pa`) | `phi` (`rad`) | `k_c` (`N/m^(n+1)`) | `k_phi` (`N/m^(n+2)`) | `n` (`-`) | `K` (`m`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Lunar In Situ (Apollo)** (`body='moon'`, `I < 100`) | `170` | `35.0 * PI/180` | `1400` | `820000` | `1.0` | `0.018` |
| **Simulante Lunar JSC-1A / GRC-3** (`body='moon'`, `I >= 100`) | `1700` | `44.9 * PI/180` | `23200` | `606700` | `1.0` | `0.0235` |
| **Arena suelta / M90 (Marte)** (`body='mars'`, `I < 180`) | `270` | `32.0 * PI/180` | `572100` | `4915300` | `0.793` | `0.0254` |
| **Regolito Marciano MGS-1 / Dry Sand** (`body='mars'`, `180 <= I < 350`) | `380` | `39.7 * PI/180` | `102000` | `5301000` | `0.793` | `0.025` |
| **Costra / Duricrust ES-3** (`body='mars'`, `I >= 350`) | `3200` | `31.0 * PI/180` | `2020000` | `5301000` | `0.84` | `0.020` |
| **Arena seca terrestre** (`body='earth'`) | `100` | `36.0 * PI/180` | `102000` | `5301000` | `0.793` | `0.025` |

---

## 3. Modo 1 — Locomoción de Rovers (Rocker-Bogie y Bekker-Wong)

### 3.1 Perfiles de hardware

| Perfil | `N_wheels` | Masa `m_rover` (`kg`) | Radio rueda `r` (`m`) | Ancho rueda `b` (`m`) | Grouser `h_g` (`m`) | Despeje chasis (`m`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `'perseverance'` | `6` | `1025` | `0.2625` (`D = 0.525`) | `0.40` | `0.0` (tread ~mm) | `0.60` |
| `'curiosity'` | `6` | `899` | `0.250` (`D = 0.50`) | `0.40` | `0.0` | `0.60` |
| `'viper'` | `4` | `430` | `0.250` (`D = 0.50`) | `0.22` | `0.025` | `0.07–0.43` (nominal `0.30`) |

### 3.2 Ecuaciones evaluadas por frame (`dt`)

```text
theta = N1_slopeDeg * PI / 180
W = (m_rover / N_wheels) * g * cos(theta)                // Carga normal por rueda [N]

// 1. Hundimiento estático (Bekker)
z0 = (3 * W / ((3 - n) * (k_c + b * k_phi) * sqrt(2 * r)))^(2 / (2 * n + 1))

// 2. Hundimiento dinámico por patinaje (slip-sinkage, Ding)
// Usando exponente efectivo N_dyn = n + n_1 * s (n_1 típico 0.2..0.4) o término aditivo zeta * s:
z = clamp(z0 + zeta * s, 0.001, r * 0.95)                // zeta típico ~ 0.05..0.15 m

// 3. Resistencia a la compactación [N]
R_c = ((k_c + b * k_phi) / (n + 1)) * z^(n + 1)

// 4. Área de contacto y tracción bruta de Janosi-Hanamoto [N]
theta_f = acos(1 - z / r)                                // [rad]
L = r * theta_f                                          // Longitud arco contacto [m]
A = b * L                                                // Área [m^2]
s_eff = max(s, 1e-4)
H = (A * c + W * tan(phi)) * (1 - (K / (s_eff * L)) * (1 - exp(-s_eff * L / K)))

// 5. Empuje neto (Drawbar Pull) en pendiente theta [N]
DP = H - R_c - (m_rover / N_wheels) * g * sin(theta)

// 6. Cinemática longitudinal y wheel slip ratio s in [0, 1]
r_eff = r + 0.5 * h_g
// En régimen de equilibrio/búsqueda o integración de velocidad v:
a_long = (N_wheels * DP) / m_rover
v = max(0, v + a_long * dt)
v_wheel = r_eff * omega_cmd
s = clamp((v_wheel - v) / max(v_wheel, 1e-5), 0, 1)
```

> **Advertencia lunar (NASA GRC):** Si los parámetros de suelo provienen de ensayos en `1 g`, `DP` real en `1/6 g` puede ser `>= 20%` menor y `z` hasta `40%` mayor. En `body === 'moon'`, mostrar esa advertencia cuando `s > 0.20`.

### 3.3 Qué controla visualmente en Three.js

1. **Hundimiento (`z`):** Desplazar cada malla de rueda hacia `-z` dentro del suelo y generar/oscurecer la huella de rodada con profundidad `z`.
2. **Deslizamiento (`s`):** Rotar la rueda con `omega_cmd * dt` mientras el chasis avanza solo `v * dt = r_eff * omega_cmd * (1 - s) * dt` (cuando `s -> 1`, las ruedas giran rápido patinando en el sitio mientras `z` aumenta).
3. **Articulación *rocker-bogie*:** Muestrear altura del terreno bajo las ruedas frontales, medias y traseras (inyectando ondulación sinusoidal/fractal de amplitud `N2_roughnessRmsM` y escala `N3_reliefM` sobre la rampa de pendiente `N1`) y resolver los ángulos del *rocker*, *bogie* y barra diferencial central.

### 3.4 Umbrales NASA (Semáforo Modo 1)

| Misión / Perfil | Variable | Verde | Amarillo | Rojo |
| :--- | :--- | :--- | :--- | :--- |
| `curiosity` / `perseverance` | Pendiente `N1` | `<= 20 deg` | `20 a 30 deg` | `> 30 deg` (vuelco estático `45 deg`) |
| `curiosity` | *Wheel slip* `s` | `< 0.20` | `0.20 a 0.59` | `>= 0.60` (paro VO Fast limit; stall corriente `~2.5 A` en `ROB-20-0040_R3`) |
| `perseverance` | *Wheel slip* `s` | `< 0.40` | `0.40 a 0.59` | `>= 0.60` default (`>= 0.80` con *Local Slip Tables*) |
| `curiosity` / `perseverance` | Obstáculo / despeje | `<= 0.40 m` (`<= 0.20 m` MSL) | `0.40–0.525 m` (`0.20–0.50 m` MSL) | `> 0.525–0.60 m` (`> 0.60 m` vientre) |
| `viper` | Pendiente `N1` | `<= 10 deg` | `10 a 15 deg` | `> 15 deg` (límite de diseño) |
| `viper` | Obstáculo / despeje | `<= 0.15 m` | `0.15 a 0.20 m` | `> 0.20 m` (escalón límite; `LuVo` limita tramos `< 6 m` si falla odometría) |

---

## 4. Modo 2 — Trajes Espaciales (`AxEMU`) y Paneles Solares (`EDS` + Saltación)

### 4.1 Ecuaciones evaluadas por frame (`dt`)

1. **Saltación eólica y transporte de masa (solo `body === 'mars'`):**
   - Velocidad de fricción umbral de fluido (Shao & Lu 2000), `rho_p = 2650 kg/m^3`, `gamma = 3.0e-4 N/m`:
     ```text
     u_star_ft = sqrt(0.0123 * ((rho_p * g * d50_m / rho_f) + (gamma / (rho_f * d50_m))))
     ```
   - Esfuerzo cortante umbral efectivo con `N7` (`f_Q = N7_saltationTimeFrac`, Martin & Kok 2018):
     ```text
     tau_ft = rho_f * u_star_ft^2
     tau_it = 0.2 * tau_ft         // Umbral de impacto menor por histéresis (0.1x..0.8x en Marte)
     tau_th = f_Q * tau_it + (1 - f_Q) * tau_ft
     u_star_eff = sqrt(tau_th / rho_f)
     ```
   - Número de Shields adimensional (para telemetría usando `u_*` del viento):
     ```text
     Theta_shields = (rho_f * u_star^2) / ((rho_p - rho_f) * g * d50_m)
     ```
   - Flujo horizontal de masa (White 1979):
     ```text
     Q_salt = (u_star > u_star_eff) ? 2.61 * (rho_f / g) * (u_star - u_star_eff) * (u_star + u_star_eff)^2 : 0  // [kg/(m*s)]
     ```

2. **Atenuación solar por polvo, `EDS` y potencia neta:**
   - Factor de transmisión por polvo depositado (`DF` en `[0, 1]`):
     ```text
     // d_rate = 0.0020 / sol (InSight/MER base; escalar suavemente con f_Q si hay saltación activa)
     DF_uncleaned = exp(-d_rate * missionElapsedSols)
     ```
   - Limpieza del Escudo Electrodinámico (`EDS` de NASA KSC, `4.0 kV`, `10 Hz` onda cuadrada en MISSE-11):
     ```text
     eta_EDS = (body === 'moon') ? 0.90 : 0.85   // 75..95% en paneles PV (>98% en ópticos ITO)
     DF_eff = edsActive ? (1 - (1 - DF_uncleaned) * (1 - eta_EDS)) : DF_uncleaned
     P_EDS = edsActive ? 3.0 : 0.0               // 2..4 W consumo de fuente HVPS
     ```
   - **Potencia instantánea vs. energía media (corrección de escala temporal de `I-01`):**
     ```text
     // No mezclar cos(theta_inc) instantáneo con la fracción temporal N6 en una sola multiplicación:
     S_0 = 1361                                  // [W/m^2] a 1 UA (en Marte dividir por (1.524)^2 -> ~586 W/m^2 * exp(-tau/cos(z)))
     eta_PV = 0.30
     sunOn = (body === 'moon') ? (sunElevationDeg > 0 && N6_solarIllumFrac > 0 ? 1 : 0) : (sunElevationDeg > 0 ? 1 : 0)
     P_inst = sunOn * S_local * A_panel * eta_PV * max(0, sin(sunElevationDeg * PI/180)) * DF_eff - P_EDS
     // Para balance de energía diario/orbital usar la fracción lunar N6:
     P_cycle_avg = (body === 'moon') ? N6_solarIllumFrac * (S_0 * A_panel * eta_PV * DF_eff) - P_EDS : P_inst
     ```

3. **Desgaste abrasivo en sello rotativo (Archard) y tejido del traje (`AxEMU`):**
   - **Sello PTFE (Archard):** `V_wear += k_ptfe * F_N * v_slide * dt`, con `k_ptfe = 1e-11 m^3/J` (rango `1e-13..1e-9`) y `mu = 0.20` (lunar) a `0.38` (marciano).
   - **Textil `Orthofabric` (`ICES-2025-56`):** No usar `K` de Archard. Escalar el índice de daño abrasivo (`0..1`) con el tiempo de exposición, presión de contacto y dureza mineral de `N4` (`6.87 GPa` máfico vs. `12.2 GPa` cuarzo félsico):
     - A daño `= 1.0` (equivalente a ensayo de 8 h en tambor rotatorio NASA con polvo angular): `tensileRemainingPct = 50%` (respecto a `500 lbf`) y `dustInfiltrationGm2 = 165 g/m^2`.

### 4.2 Qué controla visualmente en Three.js

- **Partículas eólicas:** Emitir estela de polvo rasante con densidad proporcional a `Q_salt` cuando `u_star > u_star_eff` (Marte).
- **Paneles solares + EDS:** Mezclar textura/rugosidad de polvo sobre las celdas según `(1 - DF_eff)` y, al activar `edsActive`, animar un frente de onda viajera (`10 Hz`) que barre partículas fuera del panel reduciendo la capa a `DF_eff`.
- **Traje `AxEMU`:** Incrementar mapa de suciedad/desgaste en rodillas, guantes y juntas según `dustInfiltrationGm2` y `tensileRemainingPct`.

### 4.3 Umbrales NASA (Semáforo Modo 2)

| Subsistema | Variable | Verde | Amarillo | Rojo |
| :--- | :--- | :--- | :--- | :--- |
| Paneles solares | `DF_eff` (transmitancia polvo) | `> 0.70` | `0.45 a 0.70` | `<= 0.25` (fin de misión por energía) |
| Traje `AxEMU` / `Orthofabric` | Tracción residual / infiltración | Tracción `>= 500 lbf`, corte `>= ANSI A5` | Pérdida tracción `< 50%`, corte `ANSI A2` | Pérdida tracción `>= 50%` o infiltración `>= 165 g/m^2` |

---

## 5. Modo 3 — Aterrizaje Autónomo LiDAR (`HDA` — `ALHAT` / `SPLICE` / `Mars 2020 TRN`)

### 5.1 Lógica y ecuaciones evaluadas por frame (`dt`)

1. **Huella de aterrizaje (*landing footprint*) y peligros:**
   - Diámetro de huella según perfil: `3.4 m` (`ALHAT`), `6.0 m` (`SPLICE`), `5.0 m` (`CLPS Griffin`). Mapa DEM local `100 m` de diámetro a resolución `0.05 m/px` (`SPLICE`) o `60 x 60 m` a `0.10 m/px` (`ALHAT`).
   - Estimación de altura máxima de peligro bajo patas desde `N2` y `N3`:
     ```text
     h_hazard_est = max(3.0 * N2_roughnessRmsM, N3_reliefM)   // [m] (ALHAT usa regla 6 * sigma_range para detección >= 0.30 m)
     ```
2. **Sombra rasante polar e índice LiDAR vs. cámara óptica (`N6`, `sunElevationDeg`):**
   - Longitud de sombra detrás de un obstáculo de altura `h`:
     ```text
     L_shadow = h / tan(max(sunElevationDeg, 0.5) * PI / 180) // A 5 deg: 11.4 * h; a 1.5 deg: 38.2 * h
     ```
   - Desempeño de sensores en descenso (`altitudeM` de `1000 m -> 0 m`):
     - **Cámara óptica pasiva (`TRN`):** Si `body === 'moon' && N6_solarIllumFrac === 0`, falla total (`100%` pérdida de correlación). Con `sunElevationDeg < 10 deg`, error estéreo crece fuertemente; el estéreo pasivo solo resuelve rocas/pendiente a `altitudeM <= 100 m`.
     - **LiDAR activo (`SPLICE`/`ALHAT`):** `0%` de degradación en `N6 = 0` (`PSR`), manteniendo precisión de rango `0.01 m` (`SPLICE`) a `0.05–0.08 m` (`ALHAT`) desde `400–1000 m` de altitud.

### 5.2 Qué controla visualmente en Three.js

- Descenso vertical del módulo (`1000 m -> 0 m`) con **cono de barrido LiDAR** proyectado sobre el terreno.
- Malla semántica superpuesta en la huella circular (`3.4–6.0 m`): **Verde** si `N1` y `h_hazard_est` pasan el filtro, **Rojo** si no, calculando vector de *divert* horizontal hacia el punto seguro más cercano.
- Luz direccional solar rasante (`sunElevationDeg = 1.5–5 deg`) generando sombras de longitud `L_shadow` y panel comparativo `Cámara Óptica (ciega/saturada en sombra)` vs. `Nube LiDAR 3D (intacta)`.

### 5.3 Umbrales NASA (Semáforo Modo 3)

> **Corrección aplicada respecto a `I-01`:** En `ALHAT`, `>= 5 deg` y `>= 0.30 m` definen el **peligro rechazado**, no lo admisible. No usar códigos `HDL-S-R-0040/0041` como si fueran requisitos de Starship HLS.

| Sistema | Variable | Verde (Apto) | Amarillo (Precaución) | Rojo (Rechazo HDA) |
| :--- | :--- | :--- | :--- | :--- |
| Todos (`ALHAT` / `SPLICE` / `CLPS` / `M2020`) | Pendiente `N1` | `< 5 deg` | `5 a 10 deg` (`ALHAT` ya rechaza; `CLPS` tolera `< 10`; `SPLICE` estructura `20`) | `>= 5 deg` (`ALHAT` / sitios `LOLA`), `>= 10 deg` (`CLPS`), `> 20 deg` (`SPLICE` / `M2020`) |
| `ALHAT` / `SPLICE` / `CLPS` / `M2020` | Roca / rugosidad / relieve (`N2`, `N3`) | `< 0.20 m` | `0.20 a 0.29 m` | `>= 0.30 m` (`ALHAT` / `SPLICE`), `> 0.50 m` (`M2020`), `>= 0.20 m` (`CLPS` a 100 m) |

---

## 6. Modo 4 — Perforación y Extracción ISRU (`TRIDENT` / Honeybee Robotics)

### 6.1 Especificaciones `TRIDENT` (SI)

- Profundidad máxima: `1.0 m` en segmentos (*bites*) de `0.10 m`.
- Diámetro de broca: `d_b = 0.0254 m` (`A_b = PI * d_b^2 / 4 = 5.067e-4 m^2`).
- Actuación nominal/límite: `N_rpm = 100` (`max 120`), `WOB_nom = 100 N` (`low-power max 200 N`, `act max 500 N`), `E_blow = 2.0 J/golpe`, `BPM_nom = 729` (`max 972`), `T_r ≈ 0.7`, `EFF_M ≈ 0.15` (ajustado de `UCS / MSE` observado en Honeybee `40–45 MPa -> 426–880 MJ/m^3`).
- Potencia: `50 W` rotativa nominal, `~100 W` combinada operativa, `200 W` límite máximo. Torque *stall*: `16.0 N*m`.

### 6.2 Ecuaciones evaluadas por frame (`dt`)

```text
// 1. Resistencia efectiva en profundidad actual z_drill (0..1.0 m)
UCS_eff = (z_drill < regolithDepthM) ? max(UCS_regolith, 1e5) : UCS_rock_Pa

// 2. Torque en la broca (Pessier & Fear 1992) y potencia total
// T_auger por corte de regolito no tiene fórmula cerrada en TRIDENT; modelar arrastre incremental por profundidad
T_bit = mu_bit * WOB * d_b / 3 + k_auger * rho_b * z_drill   // [N*m]
P_rot = 2 * PI * (N_rpm / 60) * T_bit                        // [W]
P_perc = T_r * E_blow * (BPM / 60)                           // [W]
P_total = P_rot + P_perc                                     // [W]

// 3. Tasa de penetración ROP [m/s] y Energía Específica Mecánica MSE [Pa]
ROP = (EFF_M * P_total) / (A_b * UCS_eff)
// En modo normal: si T_bit >= 16.0 N*m o P_total >= 200 W -> bit stall (ROP = 0)
MSE = (WOB / A_b) + (P_total / (A_b * max(ROP, 1e-6)))       // Dividir entre 1e6 para MJ/m^3

// 4. Calentamiento por fricción en vacío (Luna)
q_fric = (0.9 * P_rot) / A_interface                         // [W/m^2]
Delta_T_bit = (q_lin / (4 * PI * max(k_reg, 1e-4))) * ln(max(t_bite / t_0, 1.0))
T_bit_C = (surfaceTempK - 273.15) + Delta_T_bit
```

- **Regla de `N2` (`sigma_RMS`):** No entra en `MSE` ni `ROP`; si `N2 > 0.05 m`, reduce la estabilidad inicial del *footpad* y aumenta probabilidad de *chipping* en los primeros centímetros.
- **Lógica térmica diferenciada Luna vs. Marte (corrección de `I-01-R1`):**
  - **Luna (`TRIDENT`, `DOI 10.3847/PSJ/ae0b51`):** **NO existe corte de software a `-5 °C`.** El regolito helado opera `< -100 °C` (`broca ~ -70 °C`) y el calor se disipa retrayendo el taladro cada `0.10 m` (*bite-sampling*). El **cabezal/caja de percusión (`T_head`)** sí exige precalentamiento `> 0 °C` porque la grasa `Braycote 601EF` inhibe la percusión `< 0 °C` y bloquea el motor a `-70 °C`.
  - **Marte (`Icebreaker`, `DOI 10.1089/ast.2013.1038`):** Sí aplica corte de software `T_bit_C <= 0 °C` (pruebas a `-5 °C`) para evitar fundir hielo marciano.

### 6.3 Qué controla visualmente en Three.js

- Avance vertical del sinfín (`z_drill += ROP * dt`) con rotación (`N_rpm`) y micro-vibración axial (`BPM`).
- Cada `0.10 m` de avance nuevo, activar secuencia automática de retracción (*bite-sampling*) para descargar recortes en superficie y resetear `t_bite` (enfriamiento).
- Color de emisión térmica en la broca según `T_bit_C`, y detención visual + alerta roja si `T_bit >= 16 N*m`, `P_total >= 200 W` o `T_head < 0 °C`.

### 6.4 Umbrales NASA (Semáforo Modo 4)

| Variable | Verde | Amarillo | Rojo (Paro / Stall) |
| :--- | :--- | :--- | :--- |
| Potencia `P_total` | `50 a 100 W` | `100 a 150 W` (o `199 W`) | `>= 200 W` |
| Torque `T_bit` | `< 10 N*m` | `10 a 15 N*m` | `>= 16.0 N*m` (*bit stall*, ej. Bishop Tuff) |
| `WOB` | `<= 100 N` | `100 a 200 N` | `> 500 N` |
| Temp. Cabezal `T_head` | `> 0 °C` | Cercana a `0 °C` | `< 0 °C` (inhibe percusión) / `-70 °C` (stall Braycote) |
| Temp. Broca `T_bit_C` | Luna: `< -70 °C` (escenario `< -100 °C`) · Marte: `< -5 °C` | Luna: calentamiento entre *bites* · Marte: `-5 a 0 °C` | Luna: pérdida térmica sin retracción · Marte: `> 0 °C` (sublima/funde hielo) |

---

## 7. Criterios de Aceptación para el Agente Implementador

1. **Pruebas unitarias de física pura (sin DOM ni Three.js):**
   - Verificar que con `JSC-1A` (`g = 1.62 m/s^2`, `theta = 0 deg`) y `s = 0.2`, `z0`, `R_c`, `H` y `DP` dan unidades en `m` y `N` consistentes (sin errores de `1000x` por `kN/kPa`).
   - Verificar que `Presley & Christensen` a `P = 4.6 torr`, `I = 180` devuelve `d50` en el rango `100–200 µm`, y que para `body === 'moon'` (`P = 0`) conmuta automáticamente al modelo de Hayne (2017) sin producir `NaN`/`Infinity`.
   - Verificar que `ALHAT` marca `status = 'green'` para `N1 = 4.9 deg, N2 = 0.05 m, N3 = 0.20 m` y `status = 'red'` para `N1 = 5.0 deg` o `h_hazard >= 0.30 m`.
   - Verificar que `TRIDENT` dispara *bite-sampling* cada `0.10 m`, detiene con *stall* si `T_bit >= 16 N*m`, y aplica el corte `0 °C` en broca solo para Marte (no para Luna).
2. **Desacoplamiento:** El módulo de física (`physics/*.ts`) debe exportarse como funciones puras independientes del renderizado (`scene/*.ts`).

---

## Observaciones del agente (2026-11-14, sin implementar)

Revisión de consistencia hecha a mano; no es una verificación contra las fuentes primarias.

1. **Constantes sin valor**, que la regla 0.3 prohíbe inventar: `alpha` y `beta` de `I = alpha·ATI + beta`,
   `albedoFromSilica` (la tabla da rangos, no una función), `zeta` o `n_1` (solo rangos), `omega_cmd`, `A_panel`,
   `S_local` en la Luna, `mu_bit`, `k_auger`, `A_interface`, `q_lin`, `t_0`, `UCS_rock_Pa` dentro de cada rango, el
   modelo de `T_head` y la escala de `d_rate` con `f_Q`.
2. **Contrato distinto al de la instrucción anterior:** antes `targetBody: 'MOON' | 'MARS'` y N7 como "Número de
   Shields"; aquí `'earth' | 'moon' | 'mars'` y N7 como `f_Q` ("NO es Shields Theta"). Esta especificación es la más
   reciente.
3. **Presley & Christensen:** con `P = 4.6 torr` e `I = 180` la fórmula da `d50 ≈ 101 µm` (101.7 µm a
   4.58 torr). Pasa el criterio (100–200 µm), pero queda en el borde: a `6.0 torr`, el tope del rango de la tabla
   1.2, da `≈ 81 µm` y no lo cumple. La prueba tiene que fijar la presión.
4. **Potencia solar en el polo lunar:** `P_inst` usa `sin(elevación)`, que corresponde a un panel horizontal. Con el
   sol a 1.5–5° da 3–9 % de la potencia. Los paneles verticales que siguen al sol (lo habitual en el polo sur)
   recibirían casi el 100 %. Hay que decidir qué geometría de panel se modela.
5. **Semáforo del modo 3:** el verde (< 5°), el amarillo (5–10°) y el rojo (≥ 5° en ALHAT) se pisan. Hace falta
   elegir el perfil (ALHAT / SPLICE / CLPS / M2020) antes de evaluar el semáforo.
6. **Rendimiento:** la física por cuadro son decenas de operaciones escalares (< 0.05 ms). El riesgo está en la
   escena: un DEM local de 100 m a 0.05 m/px son 2000 × 2000 = 4 M muestras (unos 8 M triángulos), algo que no
   entra como malla a 60 FPS en una GPU integrada. Tiene que muestrearse como función, o como malla con LOD
   alrededor de la huella. También son caras las sombras rasantes con `DirectionalLight.castShadow` (shadow map) y
   el descenso de 1000 m a 0 m (pide LOD de cámara).
