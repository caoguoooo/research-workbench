import { AMENITY_CATEGORIES, validLocation, distanceMeters, isVisibleAmenity } from './project-details.js';

const normalize = text => String(text || '').normalize('NFKC').replace(/[\s·•.,，。\-—_()（）]/g, '').toLowerCase();
const core = text => normalize(text).replace(/(?:销售中心|营销中心|售楼处|售楼部|展示中心|接待中心|公园会客厅|建设中)$/g, '');

export function matchMapProject(item, places) {
  const name = core(item.name), city = normalize(item.city).replace(/市$/, '');
  const ranked = places.filter(place => validLocation(place.location) && (!city || normalize(place.address).includes(city)))
    .filter(place => !/(停车场|项目部|物业服务|充电站|[东西南北]门|公交站|地铁站)/.test(place.name))
    .map(place => {
      const candidate = core(place.name);
      let score = candidate === name ? 100 : candidate.includes(name) && name.length >= 3 ? 90 : name.includes(candidate) && candidate.length >= 3 && candidate.length / name.length >= .5 ? 80 : 0;
      if (/(销售中心|营销中心|售楼处|售楼部)/.test(place.name)) score -= 4;
      return { place, score };
    }).filter(result => result.score >= 75).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { reason: '未找到名称和城市均相符的楼盘' };
  const best = ranked[0];
  if (ranked.some(other => other.score >= best.score - 5 && distanceMeters(best.place.location, other.place.location) > 800)) return { reason: '发现不同位置的同名候选，需要人工确认' };
  return { place: best.place };
}

export function mergeMapAmenities(item, location, places) {
  places = places.filter(isVisibleAmenity);
  const manual = (item.amenities?.places || []).filter(place => !place.sourceUrl && isVisibleAmenity(place));
  const merged = new Map(manual.map(place => [place.category + ':' + normalize(place.name), place]));
  for (const place of places) merged.set(place.category + ':' + normalize(place.name), place);
  const summary = { ...item.amenities?.summary };
  for (const [category] of AMENITY_CATEGORIES) {
    const names = places.filter(place => place.category === category).slice(0, 6).map(place => place.name);
    const previous = String(summary[category] || '').replace(/\n?高德周边（2公里）：[\s\S]*$/, '').trim();
    const fresh = names.length ? names.join('、') : '本次未查询到相关配套';
    summary[category] = [previous && !/^暂无/.test(previous) ? previous : '', '高德周边（2公里）：' + fresh].filter(Boolean).join('\n').slice(0, 2000);
  }
  return { location, summary, places: [...merged.values()].slice(0, 100) };
}

export async function collectProjectMap(item, service) {
  let candidates = await service.search(item, normalize(item.name));
  let match = matchMapProject(item, candidates.places);
  if (!match.place && !match.reason.includes('同名')) {
    const name = core(item.name);
    // A developer prefix can hide the official POI. Re-query only a long, shared project suffix; never choose a phase by its rank.
    for (let start = 1; start <= name.length / 2; start++) {
      const alias = name.slice(start);
      if (alias.length < 4 || candidates.places.filter(place => core(place.name).startsWith(alias)).length < 2) continue;
      candidates = await service.search(item, alias);
      match = matchMapProject(item, candidates.places);
      break;
    }
  }
  if (!match.place) return { matched: false, reason: match.reason, candidates: candidates.places };
  const result = await service.nearby({ ...item, amenities: { ...item.amenities, location: match.place.location } });
  return { matched: true, place: match.place, amenities: mergeMapAmenities(item, match.place.location, result.places) };
}
