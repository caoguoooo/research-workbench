import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ArchiveError } from './competitor-store.mjs';
import { validLocation } from './project-details.js';

export function createMapSettingsStore(root) {
  const filename = path.join(root, 'map-settings.json');
  let queue = Promise.resolve();
  const read = async () => { try { return JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { key: '' }; throw error; } };
  const publicValue = value => ({ configured: !!value.key, jsConfigured: !!(value.jsKey && value.securityJsCode), jsKeyConfigured: !!value.jsKey, securityConfigured: !!value.securityJsCode });
  return {
    getCredentials: read,
    async getPublic() { return publicValue(await read()); },
    save(input) {
      const pending = queue.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || ['clear', 'clearJS'].some(name => input[name] !== undefined && typeof input[name] !== 'boolean')) throw new ArchiveError('地图设置格式不正确');
        for (const field of ['key', 'jsKey', 'securityJsCode']) if (input[field] !== undefined && typeof input[field] !== 'string') throw new ArchiveError('地图设置格式不正确');
        const current = await read();
        const key = input.clear ? '' : input.key || current.key || '';
        const jsKey = input.clearJS ? '' : input.jsKey || current.jsKey || '';
        const securityJsCode = input.clearJS ? '' : input.securityJsCode || current.securityJsCode || '';
        if (typeof jsKey !== 'string' || (jsKey && !/^[a-f0-9]{32}$/i.test(jsKey))) throw new ArchiveError('请填写 32 位高德 Web 端（JS API）Key');
        if (typeof securityJsCode !== 'string' || (securityJsCode && !/^[a-f0-9]{32}$/i.test(securityJsCode))) throw new ArchiveError('请填写 32 位高德安全密钥 securityJsCode');
        if (!!jsKey !== !!securityJsCode) throw new ArchiveError('JS API Key 和对应的安全密钥需要一起填写');
        if (jsKey && jsKey !== current.jsKey && current.securityJsCode && !input.securityJsCode) throw new ArchiveError('更换 JS API Key 时请同时填写对应的安全密钥');
        if (typeof key !== 'string' || (key && !/^[a-f0-9]{32}$/i.test(key))) throw new ArchiveError('请填写 32 位高德 Web 服务 Key');
        await mkdir(root, { recursive: true, mode: 0o700 });
        const temporary = `${filename}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ key, jsKey, securityJsCode }), { mode: 0o600 }); await rename(temporary, filename);
        return publicValue({ key, jsKey, securityJsCode });
      });
      queue = pending.catch(() => {}); return pending;
    }
  };
}

export { toGCJ02, toWGS84 } from './map-coordinates.js';
import { toGCJ02, toWGS84 } from './map-coordinates.js';

export function createMapService(getCredentials, fetcher = fetch) {
  let active = false;
  async function lookup(endpoint, params) {
    const { key } = await getCredentials();
    if (!key) throw new ArchiveError('请先在设置中填写高德 Web 服务 Key');
    const url = new URL(`https://restapi.amap.com/v3/${endpoint}`);
    for (const [name, value] of Object.entries({ ...params, key, output: 'JSON' })) url.searchParams.set(name, String(value));
    let value;
    try {
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Upstream status');
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      try { while (true) { const { done, value: bytes } = await reader.read(); if (done) break; size += bytes.length; if (size > 1024 * 1024) throw new Error('Oversized'); chunks.push(bytes); } }
      finally { await reader.cancel().catch(() => {}); }
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new ArchiveError('高德服务暂时无法连接，请稍后重试', 502); }
    if (value.status !== '1') {
      const messages = { '10001': '高德 Key 无效，请检查设置', '10004': '高德调用频率受限，请稍后重试', '10003': '高德服务额度不足', '10005': '高德 Key 的 IP 白名单不允许当前服务器', '10009': '请使用高德 Web 服务类型的 Key', '10044': '高德账号或服务权限不足' };
      throw new ArchiveError(messages[value.infocode] || '高德服务未完成查询，请检查 Key 类型、服务权限和额度', 502);
    }
    return value;
  }
  function place(poi, category) {
    if (typeof poi.location !== 'string') return null;
    const [lng, lat] = poi.location.split(',').map(Number), coordinates = { lng, lat };
    if (!validLocation(coordinates) || typeof poi.name !== 'string') return null;
    return { name: poi.name.slice(0, 100), category, address: [poi.pname, poi.cityname, poi.adname, typeof poi.address === 'string' ? poi.address : ''].filter(x => typeof x === 'string').join(' ').slice(0, 200), location: toWGS84(coordinates), sourceUrl: typeof poi.id === 'string' && /^[a-z0-9]+$/i.test(poi.id) ? `https://www.amap.com/place/${poi.id}` : 'https://www.amap.com/' };
  }
  async function exclusive(action) {
    if (active) throw new ArchiveError('正在查询地图，请稍后重试', 429);
    active = true; try { return await action(); } finally { active = false; }
  }
  return {
    search(item, query) { return exclusive(async () => {
      if (query !== undefined && (typeof query !== 'string' || query.trim().length > 200 || !query.trim())) throw new ArchiveError('请输入有效的楼盘名称或地址');
      const result = await lookup('place/text', { keywords: query || item.name, city: item.city || '', citylimit: 'true', offset: 10, page: 1, extensions: 'base' });
      return { places: (result.pois || []).map(poi => place(poi, 'project')).filter(Boolean), attribution: '高德地图' };
    }); },
    nearby(item) { return exclusive(async () => {
      if (!validLocation(item.amenities?.location)) throw new ArchiveError('请先定位楼盘，再查询周边配套');
      const center = toGCJ02(item.amenities.location), places = [];
      for (const [category, types] of [['transport', '150500|150700'], ['education', '141200|141500'], ['shopping', '060100|060400'], ['medical', '090100']]) {
        const result = await lookup('place/around', { location: `${center.lng},${center.lat}`, types, radius: 2000, sortrule: 'distance', offset: 10, page: 1, extensions: 'base' });
        places.push(...(result.pois || []).map(poi => place(poi, category)).filter(Boolean));
      }
      return { places, attribution: '高德地图', radius: 2000 };
    }); }
  };
}
