# Engineering calculations and offline path geometry

RadioDesk's engineering modules are pure TypeScript with no runtime dependencies. Public APIs are exported from `src/engineering/index.ts` and `src/propagation/index.ts`. Frequencies use **Hz**, impedances **ohms**, admittances **siemens**, lengths **meters**, inductance **henries**, capacitance **farads**, power **watts**, and coordinates **degrees**. The UI converts MHz, µH, pF and feet at its boundary.

Inputs must be finite and physically valid for the stated model. Invalid inputs throw `RangeError`. Infinite return loss means a perfect match; infinite VSWR means total reflection; zero watts converts to −∞ dBm. A line input that is an open circuit returns `inputImpedanceOhms: null` with `isOpenCircuit: true`. Undefined bearings at coincident or antipodal points are `null`.

## Reflection and transmission lines

For a real positive reference impedance `Z0` and passive complex load `ZL`, `reflectionCoefficient` uses:

```
Γ = (ZL − Z0) / (ZL + Z0)
ρ = |Γ|
VSWR = (1 + ρ) / (1 − ρ)
return loss = −20 log10(ρ) dB
reflected fraction = ρ²
mismatch loss = −10 log10(1 − ρ²) dB
```

`reflectionMetrics` returns the complex coefficient, magnitude, phase, VSWR and power fractions. Negative load resistance is excluded. Open and short loads can be passed as `'open'` and `'short'`. See [University of Illinois transmission-line lecture notes](https://wcchew.ece.illinois.edu/chew/ece350.html) and [ARRL's transmission-line material](https://www.arrl.org/transmission-lines).

`transmissionLineInput({loadOhms, characteristicOhms, frequencyHz, lengthMeters, velocityFactor, attenuationDb?})` transforms reflection through a uniform line:

```
βl = 2π f l / (c VF)
Γin = Γload × 10^(−attenuationDb/10) × exp(−j 2βl)
Zin = Z0 (1 + Γin) / (1 − Γin)
```

Here `attenuationDb` is the matched **one-way loss over the whole line** at the selected frequency. Reflection traverses it twice. Characteristic impedance is assumed real; the approximation is useful for ordinary low-loss RF cable and is not a general complex-`Z0` distributed RLGC solution. Line loss can reduce input VSWR while dissipating power.

## L matching networks

`lMatch(sourceResistanceOhms, loadOhms, frequencyHz)` enumerates ideal reactance solutions for both L orientations. The source resistance and load real part must be positive. The returned topology reads from source to load, and the shunt component is connected to ground. Zero-valued reactances are returned as omitted components.

With `YL = G + jBload`, the series-then-shunt case solves:

```
Btotal = ±sqrt(G/Rs − G²)
Bshunt = Btotal − Bload
Xseries = Btotal Rs/G
```

The shunt-then-series case solves:

```
Xtotal = ±sqrt(Rl(Rs − Rl))
Xseries = Xtotal − Xload
Bshunt = Xtotal/(Rl Rs)
```

Only nonnegative discriminants produce an orientation. Positive series reactance becomes an inductor; negative becomes a capacitor. Positive shunt susceptance becomes a capacitor; negative becomes an inductor. Complex loads can produce two inductors or two capacitors; the routine does not discard those valid solutions. `matchingNetworkInput` evaluates the result by ordinary series/parallel circuit arithmetic. [Analog Devices describes the underlying series/parallel matching method](https://www.analog.com/en/resources/technical-articles/radio-frequency-impedance-matching-calculations-and-simulations.html).

These are single-frequency, lossless solutions. Component Q, voltage/current rating, self resonance, parasitics, layout, load variation and practical component selection are outside the model.

## Butterworth ladders

`butterworthDesign(options)` accepts `kind: 'lowpass' | 'highpass'` with `cutoffHz`, or `kind: 'bandpass'` with `lowerHz` and `upperHz`. All options also require integer prototype `order` from 1 to 15 and equal `impedanceOhms` source/load terminations. The ladder starts with a series element.

For prototype stage `k = 1…n`, `gk = 2 sin((2k−1)π/(2n))`. Low pass values are `Lseries = R gk/ωc` and `Cshunt = gk/(R ωc)`; high pass values are `Cseries = 1/(R ωc gk)` and `Lshunt = R/(ωc gk)`. This is a **doubly terminated** insertion-loss design. See [University of Houston microwave filter lectures](https://courses.egr.uh.edu/ECE/ECE5317/Class%20Notes/Notes%2023%20%205317-6351%20Filter%20Design%20Part%202%20%28General%20Filter%20Design%29.pdf) and [Qucs's own synthesis documentation](https://qucs.sourceforge.net/tech/node96.html).

For band pass, `ω0 = sqrt(ωlower ωupper)` and `B = ωupper − ωlower`. Every series prototype stage becomes a series resonator with `L = R g/B` and `C = B/(R g ω0²)`. Every shunt stage becomes a parallel resonator with `C = g/(R B)` and `L = R B/(g ω0²)`. Physical order is `2n`.

`butterworthResponse(options, frequencyHz)` uses normalised insertion magnitude `1/sqrt(1 + Ω^(2n))`, where `Ω` is `f/fc`, `fc/f`, or `|(f²−f0²)/(f BW)|` for low, high, or band pass. Both band edges have −3.0103 dB insertion response. The calculation uses log-domain arithmetic for deep stopbands. It does not include finite Q or predict the performance of a constructed filter.

## Antennas, feedlines and units

`antennaLengths(frequencyHz, dipoleShorteningFactor?, loopLengthFactor?)` supplies wire **starting dimensions**. Free space wavelength is `c/f`. Default dipole factor reproduces [ARRL's 468/f(MHz) feet formula](https://www.arrl.org/single-band-dipoles); each dipole leg and quarter-wave vertical starting length is half that total. The full-wave loop defaults to a perimeter of one free space wavelength; loop factor is supplied explicitly for a different empirical estimate. Square side and circular diameter follow from that perimeter. A small-loop perimeter bound is `λ/10`.

These are dimensional estimates, not electromagnetic antenna models. They do not solve currents, ground effects, impedance, resonance, gain, pattern, bandwidth or efficiency. Measure and trim in the installed environment.

`feedlineLoss(lengthMeters, attenuationDbPer100Meters, inputWatts=100)` scales user-supplied manufacturer attenuation and uses `Pout/Pin = 10^(−lossDb/10)`, for matched terminations. `feedlineAttenuationDbPer100Meters(frequencyHz, A, B)` optionally evaluates a supplied fit `A sqrt(fMHz) + B fMHz`; there is no built-in cable catalog. Neither method adds a heuristic SWR multiplier.

Power conversion uses `dBm = 10 log10(watts) + 30`. Resistive RMS voltage conversion uses `P = Vrms²/R`. Ideal reactances are `XL = 2πfL` and `XC = −1/(2πfC)`; ideal LC resonance is `1/(2πsqrt(LC))`.

## Maidenhead, paths and daylight

`maidenheadEncode(latitude, longitude, precision=6)` and `maidenheadDecode(locator)` support 2, 4, 6, 8 and 10 characters. Radices are 18, 10, 24, 10, 24. Decode returns the cell centre and bounds, not a precise station location. Longitude +180 normalises to −180 and the north pole is placed in the highest latitude cell. Definitions follow the [IARU Region 1 VHF Handbook, locator sections](https://www.iaru-r1.org/wp-content/uploads/2021/03/VHF_Handbook_V9.01.pdf).

`greatCirclePath(from, to)` uses a spherical Earth of mean radius 6371.0088 km, haversine central angle and the standard initial-bearing `atan2` formula. Long-path distance is the remaining circumference and its initial bearing is opposite the short path. This is geographic geometry; it does not calculate ionospheric ray trajectories or ellipsoidal survey distances.

`solarPosition(date)`, `solarElevation(point, date)` and `solarTerminator(date, samples=180, solarAltitudeDegrees=0)` evaluate UTC using [NOAA's published fractional-year harmonic approximation](https://gml.noaa.gov/grad/solcalc/solareqns.PDF). Equation of time and declination produce the subsolar coordinates. Terminator points lie in the plane perpendicular to the solar vector; −6°, −12° and −18° boundaries are offset circles for twilight.

This is approximate geometric centre-of-sun position. It excludes atmospheric refraction, apparent sunrise correction, terrain, precise astronomical ephemerides and long-term orbital changes. No solar flux, K/A index, MUF, HF band forecast, satellite ephemeris or invented live conditions are included.

The equirectangular map embeds real [Natural Earth 1:110m land polygons](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson). The public-domain GeoJSON is bundled into the single HTML file, so the base map needs no runtime request. Polygon longitudes are unwrapped, repeated at ±360° and clipped at the antimeridian; Antarctica retains its explicit polar closing edge. Translucent night shading preserves the coastlines beneath it. This small-scale cartographic base map is intended for global radio paths, not precise coastal navigation. Asset provenance and licensing are recorded in [source-data.md](source-data.md).

## Verification

`npm test` includes reference reflection values, quarter-wave impedance inversion, half-wave repetition, open/short limits, independent component-level evaluation of L matches, and independent ABCD analysis of synthesised low/high/bandpass ladders. Geometry checks cover known locators, cell containment, antimeridian crossings, quarter-circumference distances, solstice/equinox declination, UTC longitude movement, and solar elevation along terminator/twilight rings. `npm run typecheck` checks the UI and APIs under strict TypeScript.
