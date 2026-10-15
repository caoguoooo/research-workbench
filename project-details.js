export const BASIC_INFO_FIELDS = [
  ['primaryLayouts', '主力户型', 400], ['decoration', '装修状况', 100],
  ['features', '项目特色', 500], ['plotRatio', '容积率', 80],
  ['greenRate', '绿化率', 80], ['openingDate', '开盘时间', 100],
  ['deliveryDate', '交房时间', 100]
];

export const AMENITY_CATEGORIES = [['transport', '交通'], ['education', '教育'], ['shopping', '商业'], ['medical', '医疗']];

// Older archives retain their original text; inferred values are saved only after editing.
export function inferredBasicInfo(item) {
  const summary = item.summary || '';
  const take = pattern => summary.match(pattern)?.[1]?.trim() || '';
  const layouts = [...new Set((item.floorplans || []).filter(slot => slot.area).map(slot => [slot.rooms, slot.area].filter(Boolean).join(' / ')))];
  const inferred = {
    primaryLayouts: layouts.slice(0, 6).join('、'),
    decoration: take(/装修(?:状况)?[：:]\s*([^；。\n]+)/),
    features: take(/项目特色[：:]\s*([^；。\n]+)/),
    plotRatio: take(/容积率[：:]?\s*([\d.]+)/),
    greenRate: take(/绿化率[：:]?\s*([\d.]+[%％]?)/),
    openingDate: take(/开盘(?:记录|时间)?[：:]\s*([^；。\n（(]+)/),
    deliveryDate: take(/(?:交付记录|交房时间|交付时间)[：:]\s*([^；。\n（(]+)/)
  };
  return { ...inferred, ...(item.basicInfo || {}) };
}

export function validLocation(location) {
  return !!location && typeof location.lat === 'number' && typeof location.lng === 'number' &&
    Number.isFinite(location.lat) && Number.isFinite(location.lng) &&
    Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180;
}

export function distanceMeters(a, b) {
  if (!validLocation(a) || !validLocation(b)) return null;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function distanceLabel(meters) {
  return meters === null ? '未定位' : meters < 1000 ? `${Math.round(meters)} 米` : `${(meters / 1000).toFixed(1)} 公里`;
}
