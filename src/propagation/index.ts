/** Offline geometry, not an ionospheric or HF propagation forecast. */
export interface Coordinates { latitude: number; longitude: number }
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
export const EARTH_MEAN_RADIUS_KM = 6371.0088;

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function coordinates(point: Coordinates): void {
  finite(point.latitude, 'latitude'); finite(point.longitude, 'longitude');
  if (point.latitude < -90 || point.latitude > 90) throw new RangeError('latitude must be between -90 and 90 degrees');
  if (point.longitude < -180 || point.longitude > 180) throw new RangeError('longitude must be between -180 and 180 degrees');
}

function normalizeLongitude(degrees: number): number { return ((degrees + 180) % 360 + 360) % 360 - 180; }
function normalizeBearing(degrees: number): number { return ((degrees % 360) + 360) % 360; }

/** Maidenhead fields, squares, subsquares and extensions, 2/4/6/8/10 characters. */
export function maidenheadEncode(latitude: number, longitude: number, precision = 6): string {
  coordinates({ latitude, longitude });
  if (![2, 4, 6, 8, 10].includes(precision)) throw new RangeError('precision must be 2, 4, 6, 8 or 10 characters');
  // +180 is the same meridian as -180. The north pole belongs to the top cell.
  let x = normalizeLongitude(longitude) + 180;
  let y = Math.min(latitude + 90, 180 - 1e-10);
  let longitudeSpan = 360, latitudeSpan = 180;
  let locator = '';
  for (let pair = 0; pair < precision / 2; pair++) {
    const radix = pair === 0 ? 18 : pair % 2 === 1 ? 10 : 24;
    longitudeSpan /= radix; latitudeSpan /= radix;
    const longitudeIndex = Math.min(radix - 1, Math.max(0, Math.floor(x / longitudeSpan)));
    const latitudeIndex = Math.min(radix - 1, Math.max(0, Math.floor(y / latitudeSpan)));
    if (pair % 2 === 1) locator += `${longitudeIndex}${latitudeIndex}`;
    else {
      const offset = pair === 0 ? 65 : 97;
      locator += String.fromCharCode(offset + longitudeIndex, offset + latitudeIndex);
    }
    x -= longitudeIndex * longitudeSpan; y -= latitudeIndex * latitudeSpan;
    // Remove harmless negative remainders caused by floating-point subtraction.
    x = Math.max(0, x); y = Math.max(0, y);
  }
  return locator;
}

/** Returns the cell centre and bounds. A locator represents an area, not a GPS fix. */
export function maidenheadDecode(locator: string) {
  const normalized = locator.trim().toUpperCase();
  if (!/^[A-R]{2}(?:[0-9]{2}(?:[A-X]{2}(?:[0-9]{2}(?:[A-X]{2})?)?)?)?$/.test(normalized)) throw new RangeError('Invalid Maidenhead locator; expected 2, 4, 6, 8 or 10 characters');
  let west = -180, south = -90;
  let longitudeSpan = 360, latitudeSpan = 180;
  for (let pair = 0; pair < normalized.length / 2; pair++) {
    const radix = pair === 0 ? 18 : pair % 2 === 1 ? 10 : 24;
    longitudeSpan /= radix; latitudeSpan /= radix;
    const offset = pair % 2 === 1 ? 48 : 65;
    west += (normalized.charCodeAt(pair * 2) - offset) * longitudeSpan;
    south += (normalized.charCodeAt(pair * 2 + 1) - offset) * latitudeSpan;
  }
  return {
    locator: normalized.slice(0, 4) + normalized.slice(4).toLowerCase(),
    latitude: south + latitudeSpan / 2,
    longitude: west + longitudeSpan / 2,
    bounds: { south, north: south + latitudeSpan, west, east: west + longitudeSpan },
    latitudeSpanDegrees: latitudeSpan,
    longitudeSpanDegrees: longitudeSpan,
  };
}

/** Spherical great-circle short path and the complementary long path. */
export function greatCirclePath(from: Coordinates, to: Coordinates) {
  coordinates(from); coordinates(to);
  const lat1 = from.latitude * RAD, lat2 = to.latitude * RAD;
  const deltaLat = lat2 - lat1;
  const deltaLon = normalizeLongitude(to.longitude - from.longitude) * RAD;
  const haversine = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  let centralAngle = 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, haversine))), Math.sqrt(Math.max(0, 1 - haversine)));
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  // There is no unique initial bearing for coincident or antipodal locations.
  const crossMagnitude = Math.hypot(x, y);
  // The haversine rounds close to 1 at antipodes; atan2 retains the small
  // cross-product angle and avoids inventing a bearing from that roundoff.
  if (haversine > 0.999999999999) {
    const dot = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    centralAngle = Math.atan2(crossMagnitude, dot);
  }
  const ambiguous = crossMagnitude < 1e-12;
  const initialBearingDegrees = ambiguous ? null : normalizeBearing(Math.atan2(y, x) * DEG);
  const reverseY = -Math.sin(deltaLon) * Math.cos(lat1);
  const reverseX = Math.cos(lat2) * Math.sin(lat1) - Math.sin(lat2) * Math.cos(lat1) * Math.cos(deltaLon);
  const reverseBearingDegrees = ambiguous ? null : normalizeBearing(Math.atan2(reverseY, reverseX) * DEG);
  return {
    distanceKm: EARTH_MEAN_RADIUS_KM * centralAngle,
    distanceMiles: EARTH_MEAN_RADIUS_KM * centralAngle / 1.609344,
    centralAngleDegrees: centralAngle * DEG,
    initialBearingDegrees,
    reverseBearingDegrees,
    longPathDistanceKm: EARTH_MEAN_RADIUS_KM * (2 * Math.PI - centralAngle),
    longPathBearingDegrees: initialBearingDegrees === null ? null : normalizeBearing(initialBearingDegrees + 180),
  };
}

function validDate(date: Date): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new RangeError('date must be a valid Date');
}

/** NOAA fractional-year approximation, evaluated from UTC, geometric solar position. */
export function solarPosition(date: Date) {
  validDate(date);
  const year = date.getUTCFullYear();
  const start = new Date(date.getTime());
  start.setUTCMonth(0, 1); start.setUTCHours(0, 0, 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86_400_000) + 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600 + date.getUTCMilliseconds() / 3_600_000;
  const gamma = 2 * Math.PI / (leap ? 366 : 365) * (dayOfYear - 1 + (hour - 12) / 24);
  const equationOfTimeMinutes = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declinationRadians = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const latitude = declinationRadians * DEG;
  const longitude = normalizeLongitude((720 - hour * 60 - equationOfTimeMinutes) / 4);
  return { timestamp: date.toISOString(), dayOfYear, equationOfTimeMinutes, declinationDegrees: latitude, subsolar: { latitude, longitude } };
}

/** Geometric centre-of-sun altitude; no refraction, terrain, or apparent sunrise correction. */
export function solarElevation(point: Coordinates, date: Date): number {
  coordinates(point);
  const sun = solarPosition(date).subsolar;
  const cosineZenith = Math.sin(point.latitude * RAD) * Math.sin(sun.latitude * RAD) + Math.cos(point.latitude * RAD) * Math.cos(sun.latitude * RAD) * Math.cos((point.longitude - sun.longitude) * RAD);
  return Math.asin(Math.min(1, Math.max(-1, cosineZenith))) * DEG;
}

/** Ordered terminator ring, optionally at civil/nautical/astronomical twilight altitude. */
export function solarTerminator(date: Date, samples = 180, solarAltitudeDegrees = 0): Coordinates[] {
  validDate(date);
  if (!Number.isInteger(samples) || samples < 12 || samples > 1440) throw new RangeError('samples must be an integer from 12 to 1440');
  finite(solarAltitudeDegrees, 'solarAltitudeDegrees');
  if (solarAltitudeDegrees < -18 || solarAltitudeDegrees > 0) throw new RangeError('solarAltitudeDegrees must be between -18 and 0');
  const sun = solarPosition(date).subsolar;
  const lat = sun.latitude * RAD, lon = sun.longitude * RAD;
  const s = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const u = [-Math.sin(lon), Math.cos(lon), 0];
  const v = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const alongSun = Math.sin(solarAltitudeDegrees * RAD);
  const perpendicular = Math.cos(solarAltitudeDegrees * RAD);
  const points: Coordinates[] = [];
  for (let i = 0; i <= samples; i++) {
    const theta = 2 * Math.PI * i / samples;
    const x = alongSun * s[0]! + perpendicular * (Math.cos(theta) * u[0]! + Math.sin(theta) * v[0]!);
    const y = alongSun * s[1]! + perpendicular * (Math.cos(theta) * u[1]! + Math.sin(theta) * v[1]!);
    const z = alongSun * s[2]! + perpendicular * (Math.cos(theta) * u[2]! + Math.sin(theta) * v[2]!);
    points.push({ latitude: Math.asin(Math.min(1, Math.max(-1, z))) * DEG, longitude: normalizeLongitude(Math.atan2(y, x) * DEG) });
  }
  return points;
}
