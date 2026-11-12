import path from 'node:path';
import { isIP } from 'node:net';

export function runtimeConfig(env = process.env, root = process.cwd()) {
  const production = env.NODE_ENV === 'production';
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为有效端口');
  const passwordOptional = env.WORKBENCH_ALLOW_EMPTY_PASSWORD === 'true';
  if (passwordOptional && (production || !['127.0.0.1', 'localhost', '::1'].includes(host))) throw new Error('空密码预览只能在本机开发模式使用');
  let publicOrigin = '';
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_ORIGIN 应为完整 HTTPS 网站地址，不含路径');
    publicOrigin = url.origin;
  }
  const trustedProxies = (env.WORKBENCH_TRUSTED_PROXIES || '127.0.0.1,::1').split(',').map(value => value.trim()).filter(Boolean);
  if (trustedProxies.some(value => !isIP(value))) throw new Error('WORKBENCH_TRUSTED_PROXIES 仅接受逗号分隔的反代 IP 地址');
  return { production, host, port, passwordOptional, publicOrigin, trustProxy: env.WORKBENCH_TRUST_PROXY === 'true', trustedProxies, dataRoot: path.resolve(env.WORKBENCH_DATA_DIR || path.join(root, 'data')) };
}

export function validOrigin(req, config) {
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return false;
  if (config.production && !config.publicOrigin) {
    // Custom headers require CORS preflight across origins; this server does not enable CORS.
    if (req.headers['x-workbench-request'] !== '1') return false;
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.protocol !== 'https:' || origin.origin !== req.headers.origin) return false;
      } catch { return false; }
    }
    return true;
  }
  const expected = config.publicOrigin || `http://${req.headers.host}`;
  return !req.headers.origin || req.headers.origin === expected;
}
