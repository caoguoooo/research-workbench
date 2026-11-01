import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ArchiveError } from './competitor-store.mjs';
import { normalizeBoardUrl } from './asset-library-store.mjs';
import { proxyURL } from './public-download.mjs';

export function pinterestURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !['widgets.pinterest.com', 'assets.pinterest.com', 'i.pinimg.com', 's.pinimg.com'].includes(url.hostname)) throw new ArchiveError('Pinterest 资源地址不受支持', 400);
  return url;
}
export function createPinterestSettings(dataRoot) {
  const filename = path.join(dataRoot, 'pinterest-settings.json');
  let queue = Promise.resolve();
  async function read() {
    try { const data = JSON.parse(await readFile(filename, 'utf8')); return { proxyUrl: data.proxyUrl || '' }; }
    catch (error) { if (error.code === 'ENOENT') return { proxyUrl: '' }; throw error; }
  }
  return {
    get: read,
    save(input) {
      const result = queue.then(async () => {
        if (!input || typeof input.proxyUrl !== 'string' || input.proxyUrl.length > 500) throw new ArchiveError('请填写代理服务器地址');
        let proxyUrl = input.proxyUrl.trim();
        try { if (proxyUrl) proxyUrl = proxyURL(proxyUrl).href.replace(/\/$/, ''); }
        catch { throw new ArchiveError('代理需为 HTTP 或 HTTPS 地址，不带账号、路径或查询参数'); }
        await mkdir(dataRoot, { recursive: true, mode: 0o700 });
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, JSON.stringify({ proxyUrl }), { mode: 0o600, flag: 'wx' }); await rename(temporary, filename); }
        catch (error) { await unlink(temporary).catch(() => {}); throw error; }
        return { proxyUrl };
      });
      queue = result.catch(() => {}); return result;
    }
  };
}

// Only the explicitly allowed Pinterest widget/CDN hosts can use this tunnel.
// Resolve the remote hostname at the proxy, while TLS still verifies its certificate here.
export async function downloadPinterest(value, proxyAddress, limit = 2 * 1024 * 1024) {
  const proxy = proxyURL(proxyAddress);
  if (!proxy) throw new ArchiveError('请先在设置中保存 Pinterest 代理服务器', 409);
  const signal = AbortSignal.timeout(20_000);
  let url = pinterestURL(value);
  for (let redirect = 0; redirect <= 2; redirect++) {
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = (_options, callback) => {
      const authority = `${url.hostname}:443`;
      const connect = (proxy.protocol === 'https:' ? https : http).request(proxy, { method: 'CONNECT', path: authority, headers: { Host: authority }, agent: false, signal });
      let socket, finished = false;
      const finish = (error, stream) => { if (finished) return; finished = true; if (error) { socket?.destroy(); connect.destroy(); } callback(error, stream); };
      connect.once('error', error => finish(error));
      connect.once('response', res => { res.destroy(); finish(new Error('Proxy refused CONNECT')); });
      connect.once('connect', (res, stream, head) => {
        socket = stream;
        if (res.statusCode !== 200 || head.length || signal.aborted) return finish(new Error('Proxy refused CONNECT'));
        const abort = () => { socket.destroy(); finish(new Error('Timeout')); };
        signal.addEventListener('abort', abort, { once: true });
        socket = tls.connect({ socket: stream, servername: url.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
        socket.once('error', error => finish(error)); socket.once('close', () => signal.removeEventListener('abort', abort));
        socket.once('secureConnect', () => finish(null, socket));
      });
      connect.end();
    };
    try {
      const result = await new Promise((resolve, reject) => {
        const request = https.request(url, { agent, signal, headers: { Accept: 'application/json,image/jpeg,image/png,image/webp', 'Accept-Encoding': 'gzip, br, deflate', 'User-Agent': 'ResearchWorkbench/1.0 PinterestBoardPreview' } }, res => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) { const location = res.headers.location; res.destroy(); resolve({ location }); return; }
          if (res.statusCode !== 200 || Number(res.headers['content-length'] || 0) > limit) { res.destroy(); reject(new Error(`Pinterest HTTP ${res.statusCode}`)); return; }
          let size = 0; const chunks = [];
          res.on('data', chunk => { size += chunk.length; if (size > limit) res.destroy(new Error('Pinterest response too large')); else chunks.push(chunk); });
          res.once('error', reject); res.once('aborted', () => reject(new Error('Pinterest response interrupted')));
          res.once('end', () => {
            try {
              let bytes = Buffer.concat(chunks);
              const encoding = res.headers['content-encoding'];
              const decompress = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync }[encoding];
              if (decompress) bytes = decompress(bytes, { maxOutputLength: limit });
              else if (encoding && encoding !== 'identity') throw new Error('Unsupported encoding');
              if (bytes.length > limit) throw new Error('Pinterest response too large');
              resolve({ bytes, type: String(res.headers['content-type'] || '').split(';')[0] });
            } catch (error) { reject(error); }
          });
        });
        request.once('error', reject); request.end();
      });
      if (result.bytes) return result;
      if (!result.location) throw new Error('Invalid redirect');
      url = pinterestURL(new URL(result.location, url).href);
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      throw new ArchiveError('Pinterest 代理连接失败或请求超时，请检查代理服务及网络后重试', 502);
    } finally { agent.destroy(); }
  }
  throw new ArchiveError('Pinterest 重定向过多', 502);
}

export function createPinterestService(settings, download = downloadPinterest) {
  const boards = new Map(), images = new Map(), pending = new Map();
  let generation = 0;
  async function board(boardUrl) {
    const canonical = normalizeBoardUrl(boardUrl), { proxyUrl } = await settings.get();
    if (!proxyUrl) throw new ArchiveError('请先在设置中保存 Pinterest 代理服务器', 409);
    const key = `${generation}:${proxyUrl}:${canonical}`, cached = boards.get(key);
    if (cached && cached.expires > Date.now()) return cached;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      const pieces = new URL(canonical).pathname.split('/').filter(Boolean);
      const result = await download(`https://widgets.pinterest.com/v3/pidgets/boards/${pieces.join('/')}/pins/`, proxyUrl);
      let data;
      try { data = JSON.parse(result.bytes.toString('utf8')); } catch { throw new ArchiveError('Pinterest 返回了无法读取的画板数据', 502); }
      if (data.status !== 'success' || !Array.isArray(data.data?.pins)) throw new ArchiveError('暂时无法读取此画板，请确认画板公开且网址正确', 502);
      const pins = [];
      for (const pin of data.data.pins.slice(0, 50)) {
        if (!/^\d{5,32}$/.test(String(pin.id))) continue;
        const image = pin.images?.['564x'] || pin.images?.['237x'] || pin.images?.['736x'];
        if (!image?.url) continue;
        try { const url = pinterestURL(image.url); if (!url.hostname.endsWith('.pinimg.com')) continue; } catch { continue; }
        pins.push({ id: String(pin.id), title: String(pin.description || '').slice(0, 300), imageUrl: image.url, width: Number(image.width) || 0, height: Number(image.height) || 0, pinUrl: `https://www.pinterest.com/pin/${pin.id}/` });
      }
      const entry = { name: String(data.data.board?.name || '').slice(0, 120), pins, expires: Date.now() + 5 * 60_000 };
      if (boards.size > 100) boards.delete(boards.keys().next().value);
      boards.set(key, entry); return entry;
    })();
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  }
  return {
    clear() { generation++; boards.clear(); images.clear(); },
    async preview(item) {
      const result = await board(item.boardUrl);
      return { name: result.name || item.title, pins: result.pins.map(pin => ({ ...pin, imageUrl: `/api/assets/${item.id}/pinterest-image/${pin.id}` })), viaProxy: true };
    },
    async image(item, pinId) {
      const result = await board(item.boardUrl), pin = result.pins.find(pin => pin.id === pinId);
      if (!pin) throw new ArchiveError('画板图片不存在，请重新加载画板', 404);
      const { proxyUrl } = await settings.get(), key = `${generation}:${proxyUrl}:${pin.imageUrl}`, cached = images.get(key);
      if (cached && cached.expires > Date.now()) return cached;
      const image = await download(pin.imageUrl, proxyUrl, 8 * 1024 * 1024);
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) throw new ArchiveError('Pinterest 返回的不是可显示的图片', 502);
      // Keep only small previews in memory; this is not a local archive import.
      if (image.bytes.length < 1024 * 1024) { if (images.size >= 32) images.delete(images.keys().next().value); images.set(key, { ...image, expires: Date.now() + 5 * 60_000 }); }
      return image;
    },
    async test(item) {
      if (item) { const result = await board(item.boardUrl); return { ok: true, pinCount: result.pins.length }; }
      const { proxyUrl } = await settings.get();
      await download('https://assets.pinterest.com/js/pinit.js', proxyUrl, 128 * 1024);
      return { ok: true, pinCount: null };
    }
  };
}
