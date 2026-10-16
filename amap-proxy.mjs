import { ArchiveError } from './competitor-store.mjs';

export const AMAP_FRAME_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval' https://webapi.amap.com https://*.amap.com https://*.autonavi.com; style-src 'self' 'unsafe-inline' https://*.amap.com https://*.autonavi.com; img-src 'self' data: blob: https://*.amap.com https://*.autonavi.com; connect-src 'self' https://*.amap.com https://*.autonavi.com; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
};

export function mapClientConfig(value) {
  return value.jsKey && value.securityJsCode ? { configured: true, key: value.jsKey, serviceHost: '/_AMapService' } : { configured: false };
}

export function createAMapProxy(getCredentials, fetcher = fetch) {
  let active = 0;
  return async url => {
    const endpoint = url.pathname.slice('/_AMapService'.length);
    if (!['/v3/place/text', '/v3/place/around', '/v3/vectormap', '/v3/log/init', '/v3/ias/verify', '/v4/map/styles', '/v4/map/styles2'].includes(endpoint)) throw new ArchiveError('不支持这个地图服务', 404);
    if (url.search.length > 8192) throw new ArchiveError('地图查询参数过长', 400);
    const callback = url.searchParams.get('callback');
    if (callback && !/^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*$/i.test(callback)) throw new ArchiveError('地图回调参数无效', 400);
    const { jsKey, securityJsCode } = await getCredentials();
    if (!jsKey || !securityJsCode) throw new ArchiveError('请在设置中填写 JS API Key 和对应的安全密钥', 409);
    if (url.searchParams.get('key') !== jsKey) throw new ArchiveError('地图配置已更新，请刷新页面', 409);
    if (active >= 32) throw new ArchiveError('地图查询过于频繁，请稍后重试', 429);
    const target = new URL(endpoint, endpoint.startsWith('/v4/map/') ? 'https://webapi.amap.com' : 'https://restapi.amap.com');
    target.search = url.search;
    target.searchParams.set('key', jsKey);
    target.searchParams.set('jscode', securityJsCode);
    active++;
    try {
      const response = await fetcher(target, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json, text/javascript' } });
      if (!response.ok) throw new Error('Upstream status');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length; if (size > 2 * 1024 * 1024) throw new Error('Oversized');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const body = Buffer.concat(chunks);
      if (body.includes(Buffer.from(securityJsCode))) throw new Error('Sensitive upstream response');
      const type = response.headers.get('content-type')?.split(';')[0].toLowerCase();
      return { body, type: callback ? 'text/javascript; charset=utf-8' : ['application/json', 'image/png', 'image/jpeg', 'image/webp'].includes(type) ? type : 'application/octet-stream' };
    } catch { throw new ArchiveError('高德服务暂时无法连接，请稍后重试', 502); }
    finally { active--; }
  };
}
