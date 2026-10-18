export const BASIC_INFO_FIELDS = [
  ['primaryLayouts', '主力户型', 400], ['decoration', '装修状况', 100],
  ['features', '项目特色', 500], ['plotRatio', '容积率', 80],
  ['greenRate', '绿化率', 80], ['openingDate', '开盘时间', 100],
  ['deliveryDate', '交房时间', 100]
];

export const AMENITY_CATEGORIES = [['transport', '交通'], ['education', '教育'], ['shopping', '商业'], ['medical', '医疗']];

// AMap POI subtypes: middle school, primary school and kindergarten only.
export const SCHOOL_TYPES = { '141202': 'secondary', '141203': 'primary', '141204': 'kindergarten' };
export const AMAP_NEARBY_TYPES = [['transport', '150500|150700'], ['education', Object.keys(SCHOOL_TYPES).join('|')], ['shopping', '060100|060400'], ['medical', '090100']];

export function educationSchoolType(place) {
  const name = String(place?.name || '').normalize('NFKC');
  if (/(驾校|驾驶|培训|辅导|补习|早教|托育|职业|中专|技工|技校|职校|职高|成人教育|继续教育|老年大学|停车场|公交站|地铁站|校服|文具|食堂|宿舍|门卫)/.test(name) || /[东西南北正]门[)）]?(?:$|[(（])/.test(name)) return null;
  const codes = typeof place?.typecode === 'string' ? place.typecode.split(/[|;,]/).map(code => code.trim()).filter(code => /^\d{6}$/.test(code)) : [];
  if (codes.length) return codes.map(code => SCHOOL_TYPES[code]).find(Boolean) || null;
  const type = typeof place?.type === 'string' ? place.type.split(/[;|]/).map(part => part.trim()) : [];
  for (const [label, kind] of [['幼儿园', 'kindergarten'], ['小学', 'primary'], ['中学', 'secondary']]) if (type.includes(label)) return kind;
  if (type.some(label => /高等院校|大学|成人教育|职业|驾校|培训|内部设施/.test(label))) return null;
  if (Object.values(SCHOOL_TYPES).includes(place?.schoolType)) return place.schoolType;
  if (/幼儿园/.test(name)) return 'kindergarten';
  if (/小学|附小/.test(name)) return 'primary';
  if (/中学|初中|高中|附中|九年一贯/.test(name)) return 'secondary';
  return null;
}

export function isVisibleAmenity(place) {
  return place?.category !== 'education' || !!educationSchoolType(place);
}

export function educationSummary(amenities) {
  const text = amenities?.summary?.education || '', marker = '高德周边（2公里）：';
  if (!text.includes(marker)) return text;
  const original = text.slice(0, text.indexOf(marker)).trim();
  const names = (amenities.places || []).filter(place => place.category === 'education' && isVisibleAmenity(place)).slice(0, 6).map(place => place.name);
  return [original, marker + (names.join('、') || '未收集到幼儿园、小学或中学配套')].filter(Boolean).join('\n');
}


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
