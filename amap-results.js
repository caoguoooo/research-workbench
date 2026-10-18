import { validLocation, educationSchoolType } from './project-details.js';
import { toWGS84 } from './map-coordinates.js';

export function amapError(value) {
  const code = typeof value === 'string' ? value : value?.info || value?.infocode || '';
  const messages = {
    INVALID_USER_KEY: '高德 Key 无效，请检查设置。',
    USERKEY_PLAT_NOMATCH: 'Key 类型不符，请使用 Web 端（JS API）Key。',
    INVALID_USER_SCODE: '安全密钥不匹配，请填写这个 JS API Key 对应的 securityJsCode。',
    INVALID_USER_DOMAIN: '当前域名未获授权，请在高德控制台检查 Key 的域名白名单。',
    INVALID_USER_SIGNATURE: '高德安全校验失败，请检查 Key 和安全密钥是否配套。',
    SERVICE_NOT_AVAILABLE: '高德账号尚未开通此服务，请检查服务权限。',
    DAILY_QUERY_OVER_LIMIT: '高德今日服务额度不足。',
    ACCESS_TOO_FREQUENT: '高德调用频率受限，请稍后重试。'
  };
  return messages[code] || '高德查询失败，请检测已保存配置并检查服务权限、域名白名单和额度。';
}

export function amapPlaces(pois, category) {
  return (Array.isArray(pois) ? pois : []).flatMap(poi => {
    const schoolType = category === 'education' ? educationSchoolType(poi) : null;
    if (category === 'education' && !schoolType) return [];
    const value = poi.location;
    const location = { lng: Number(value?.getLng?.() ?? value?.lng), lat: Number(value?.getLat?.() ?? value?.lat) };
    if (!value || !validLocation(location) || typeof poi.name !== 'string') return [];
    return [{ name: poi.name.slice(0, 100), category, ...(schoolType ? { schoolType } : {}), address: [poi.pname, poi.cityname, poi.adname, poi.address].filter(v => typeof v === 'string').join(' ').slice(0, 200), location: toWGS84(location), sourceUrl: /^[a-z0-9]+$/i.test(poi.id || '') ? `https://www.amap.com/place/${poi.id}` : 'https://www.amap.com/' }];
  });
}
