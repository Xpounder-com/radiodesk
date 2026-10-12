import test from 'node:test';
import assert from 'node:assert/strict';
import { EARTH_MEAN_RADIUS_KM, greatCirclePath, maidenheadDecode, maidenheadEncode, solarElevation, solarPosition, solarTerminator } from '../src/propagation/index.ts';

function near(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
}

test('Maidenhead known cells and case-insensitive centre coordinates', () => {
  assert.equal(maidenheadEncode(0, 0), 'JJ00aa');
  assert.equal(maidenheadEncode(41.8781, -87.6298, 4), 'EN61'); // Chicago.
  assert.equal(maidenheadEncode(51.5074, -0.1278, 4), 'IO91'); // London.
  const grid = maidenheadDecode(' fn31pr ');
  assert.equal(grid.locator, 'FN31pr');
  near(grid.latitude, 41 + 17 / 24 + 1 / 48);
  near(grid.longitude, -74 + 15 / 12 + 1 / 24);
  near(grid.latitudeSpanDegrees, 1 / 24); near(grid.longitudeSpanDegrees, 1 / 12);
  const worldOrigin = maidenheadDecode('AA');
  near(worldOrigin.longitude, -170); near(worldOrigin.latitude, -85);
  for (const bad of ['', 'ZZ00aa', 'FN3', 'FN31zz', 'FN31aa1', '1234', '<script>']) assert.throws(() => maidenheadDecode(bad), RangeError);
});

test('locator area containment and centres round-trip at every supported precision', () => {
  for (const point of [ { latitude: 41.8781, longitude: -87.6298 }, { latitude: -33.8688, longitude: 151.2093 }, { latitude: -89.9999, longitude: -179.9999 }, { latitude: 89.9999, longitude: 179.9999 } ]) {
    for (const precision of [2, 4, 6, 8, 10]) {
      const locator = maidenheadEncode(point.latitude, point.longitude, precision);
      const decoded = maidenheadDecode(locator);
      assert.equal(maidenheadEncode(decoded.latitude, decoded.longitude, precision), locator);
      assert.ok(point.latitude >= decoded.bounds.south && point.latitude < decoded.bounds.north);
      assert.ok(point.longitude >= decoded.bounds.west && point.longitude < decoded.bounds.east);
    }
  }
  assert.equal(maidenheadEncode(0, 180), maidenheadEncode(0, -180));
  assert.equal(maidenheadEncode(90, 0, 2), 'JR');
  assert.throws(() => maidenheadEncode(91, 0), RangeError);
  assert.throws(() => maidenheadEncode(0, 0, 5), RangeError);
});

test('equatorial quarter circumference, initial/reverse bearings and long path', () => {
  const path = greatCirclePath({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 });
  near(path.distanceKm, 10_007.557221017962, 1e-8);
  assert.equal(path.initialBearingDegrees, 90); assert.equal(path.reverseBearingDegrees, 270);
  assert.equal(path.longPathBearingDegrees, 270);
  near(path.longPathDistanceKm, 3 * path.distanceKm, 1e-8);
  const meridian = greatCirclePath({ latitude: -45, longitude: 30 }, { latitude: 45, longitude: 30 });
  near(meridian.distanceKm, path.distanceKm); assert.equal(meridian.initialBearingDegrees, 0);
  const same = greatCirclePath({ latitude: 5, longitude: 12 }, { latitude: 5, longitude: 12 });
  assert.equal(same.distanceKm, 0); assert.equal(same.initialBearingDegrees, null);
  const antipodal = greatCirclePath({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
  near(antipodal.distanceKm, Math.PI * EARTH_MEAN_RADIUS_KM); assert.equal(antipodal.initialBearingDegrees, null);
  for (const latitude of [10, 40, 70]) {
    const offEquator = greatCirclePath({ latitude, longitude: 12 }, { latitude: -latitude, longitude: -168 });
    near(offEquator.distanceKm, Math.PI * EARTH_MEAN_RADIUS_KM, 1e-8);
    assert.equal(offEquator.initialBearingDegrees, null);
  }
});

test('antimeridian distance uses the short great-circle arc', () => {
  const path = greatCirclePath({ latitude: 0, longitude: 179 }, { latitude: 0, longitude: -179 });
  near(path.centralAngleDegrees, 2); near(path.distanceKm, 222.3901604670658, 1e-8);
  near(path.initialBearingDegrees!, 90);
  const londonNewYork = greatCirclePath({ latitude: 51.5074, longitude: -0.1278 }, { latitude: 40.7128, longitude: -74.006 });
  near(londonNewYork.distanceKm, 5570.23, 1);
  near(londonNewYork.initialBearingDegrees!, 288.33, 0.1);
  assert.throws(() => greatCirclePath({ latitude: 0, longitude: 181 }, { latitude: 0, longitude: 0 }), RangeError);
});

test('UTC solar geometry follows equinox and solstice declination references', () => {
  const june = solarPosition(new Date('2025-06-21T12:00:00Z'));
  near(june.declinationDegrees, 23.44, 0.1);
  const december = solarPosition(new Date('2025-12-21T12:00:00Z'));
  near(december.declinationDegrees, -23.44, 0.1);
  const equinox = solarPosition(new Date('2025-03-20T12:00:00Z'));
  near(equinox.declinationDegrees, 0, 0.6);
  near(equinox.equationOfTimeMinutes, -7.5, 1);
  const sixHoursLater = solarPosition(new Date('2025-06-21T18:00:00Z'));
  near(sixHoursLater.subsolar.longitude - june.subsolar.longitude, -90, 0.05);
  assert.equal(solarPosition(new Date('2024-12-31T12:00:00Z')).dayOfYear, 366);
  assert.throws(() => solarPosition(new Date('invalid')), RangeError);
});

test('subsolar, antisolar and terminator elevations obey geometric constraints', () => {
  const date = new Date('2025-09-22T18:00:00Z');
  const sun = solarPosition(date).subsolar;
  near(solarElevation(sun, date), 90, 1e-6);
  const oppositeLongitude = sun.longitude >= 0 ? sun.longitude - 180 : sun.longitude + 180;
  near(solarElevation({ latitude: -sun.latitude, longitude: oppositeLongitude }, date), -90, 1e-6);
  for (const altitude of [0, -6, -12, -18]) {
    const ring = solarTerminator(date, 180, altitude);
    assert.equal(ring.length, 181);
    for (const point of ring) near(solarElevation(point, date), altitude, 1e-9);
    near(ring[0]!.latitude, ring.at(-1)!.latitude, 1e-9); near(ring[0]!.longitude, ring.at(-1)!.longitude, 1e-9);
  }
  assert.throws(() => solarTerminator(date, 2), RangeError);
  assert.throws(() => solarTerminator(date, 180, -20), RangeError);
});
