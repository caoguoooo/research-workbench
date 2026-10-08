import path from 'node:path';

export function runtimeConfig(env = process.env, root = process.cwd()) {
  const production = env.NODE_ENV === 'production';
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为有效端口');
  const passwordOptional = env.CYJ_ALLOW_EMPTY_PASSWORD === 'true';
  if (passwordOptional && (production || !['127.0.0.1', 'localhost', '::1'].includes(host))) throw new Error('空密码预览只能在本机开发模式使用');
  let publicOrigin = '';
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_ORIGIN 应为完整 HTTPS 网站地址，不含路径');
    publicOrigin = url.origin;
  }
  if (production && !publicOrigin) throw new Error('正式版本需要设置 PUBLIC_ORIGIN，例如 https://workspace.example.com');
  return { production, host, port, passwordOptional, publicOrigin, trustProxy: env.CYJ_TRUST_PROXY === 'true', dataRoot: path.resolve(env.CYJ_DATA_DIR || path.join(root, 'data')) };
}

export function validOrigin(req, config) {
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return false;
  const expected = config.publicOrigin || `http://${req.headers.host}`;
  return !req.headers.origin || req.headers.origin === expected;
}
