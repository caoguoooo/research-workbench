import { validLocation } from './project-details.js';
// AMap uses GCJ-02; archives and the existing OpenStreetMap renderer use WGS84.
export function toGCJ02(location) {
  if (!validLocation(location)) throw new Error('项目坐标不正确');
  const { lng, lat } = location;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
  const x = lng - 105, y = lat - 35, pi = Math.PI;
  const common = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  let dy = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x)) + common;
  dy += (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3 + (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
  let dx = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x)) + common;
  dx += (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3 + (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
  const rad = lat / 180 * pi, magic = 1 - .00669342162296594323 * Math.sin(rad) ** 2, sqrt = Math.sqrt(magic);
  return { lat: lat + dy * 180 / ((6378245 * (1 - .00669342162296594323)) / (magic * sqrt) * pi), lng: lng + dx * 180 / (6378245 / sqrt * Math.cos(rad) * pi) };
}

export function toWGS84(location) {
  let result = { ...location };
  for (let i = 0; i < 4; i++) { const offset = toGCJ02(result); result = { lat: result.lat + location.lat - offset.lat, lng: result.lng + location.lng - offset.lng }; }
  return result;
}

