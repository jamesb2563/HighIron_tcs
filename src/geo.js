// Small geodesy helpers. Coordinates are [lat, lon] arrays in degrees; distances in metres.

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a -> b, degrees 0..360 clockwise from north. */
export function bearing(a, b) {
  const p1 = toRad(a[0]);
  const p2 = toRad(b[0]);
  const dl = toRad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function angleDiff(b1, b2) {
  const d = Math.abs(b1 - b2) % 360;
  return d > 180 ? 360 - d : d;
}

export function polylineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += haversine(coords[i - 1], coords[i]);
  return len;
}

/** Point at distance d (m) along a polyline. Clamps to the ends. */
export function pointAlong(coords, d) {
  if (d <= 0) return coords[0].slice();
  for (let i = 1; i < coords.length; i++) {
    const seg = haversine(coords[i - 1], coords[i]);
    if (d <= seg) {
      const t = seg === 0 ? 0 : d / seg;
      return [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      ];
    }
    d -= seg;
  }
  return coords[coords.length - 1].slice();
}

/** Sub-polyline between distances d0 < d1 along coords. */
export function sliceAlong(coords, d0, d1) {
  if (d1 < d0) [d0, d1] = [d1, d0];
  const out = [pointAlong(coords, d0)];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += haversine(coords[i - 1], coords[i]);
    if (acc > d0 && acc < d1) out.push(coords[i].slice());
    if (acc >= d1) break;
  }
  out.push(pointAlong(coords, d1));
  return out;
}
