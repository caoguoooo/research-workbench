import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPinterestSettings, createPinterestService, downloadPinterest, pinterestURL } from '../pinterest-service.mjs';

test('Pinterest proxy settings validate, persist and remain separate from other integrations', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-pinterest-'));
  try {
    const settings = createPinterestSettings(dir);
    assert.deepEqual(await settings.get(), { proxyUrl: '' });
    for (const proxyUrl of ['socks5://127.0.0.1:7890', 'http://a:password@host:123', 'http://host:123/path', 'http://host:123?url=x']) await assert.rejects(settings.save({ proxyUrl }));
    await settings.save({ proxyUrl: 'http://192.168.31.70:7890/' });
    assert.equal((await createPinterestSettings(dir).get()).proxyUrl, 'http://192.168.31.70:7890');
    assert.equal(JSON.parse(await readFile(path.join(dir, 'pinterest-settings.json'), 'utf8')).proxyUrl, 'http://192.168.31.70:7890');
    for (const url of ['https://127.0.0.1/private', 'https://i.pinimg.com.evil.test/a.jpg', 'https://www.pinterest.com/a/', 'http://i.pinimg.com/a.jpg', 'https://i.pinimg.com:8080/a.jpg', 'https://u:p@i.pinimg.com/a.jpg']) assert.throws(() => pinterestURL(url));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Pinterest public board previews and images both use the configured proxy, deduplicate requests and reject unrelated images', async () => {
  let proxyUrl = 'http://192.168.31.70:7890'; const calls = [];
  const widget = { status: 'success', data: { board: { name: '彩总模板' }, pins: [
    { id: '123456789', description: '<img onerror=alert(1)>', images: { '564x': { url: 'https://i.pinimg.com/564x/test.jpg', width: 564, height: 300 } } },
    { id: '987654321', images: { '564x': { url: 'https://evil.test/image.jpg' } } }
  ] } };
  const service = createPinterestService({ get: async () => ({ proxyUrl }) }, async (url, proxy) => {
    calls.push({ url, proxy });
    return url.includes('pidgets') ? { bytes: Buffer.from(JSON.stringify(widget)), type: 'application/json' } : { bytes: Buffer.from([0xff, 0xd8, 0xff]), type: 'image/jpeg' };
  });
  const item = { id: 'board-id', title: '画板', boardUrl: 'https://www.pinterest.com/user/board/' };
  const [a, b] = await Promise.all([service.preview(item), service.preview(item)]);
  assert.deepEqual(a, b); assert.equal(calls.length, 1); assert.equal(a.pins.length, 1);
  assert.equal(a.pins[0].imageUrl, '/api/assets/board-id/pinterest-image/123456789');
  assert.equal(a.pins[0].title, '<img onerror=alert(1)>');
  await service.image(item, '123456789'); await service.image(item, '123456789');
  assert.equal(calls.length, 2); assert(calls.every(call => call.proxy === proxyUrl));
  await assert.rejects(service.image(item, '987654321'), /不存在/);
  proxyUrl = 'http://another-proxy:7890'; service.clear(); await service.preview(item);
  assert.equal(calls.at(-1).proxy, proxyUrl);
  proxyUrl = ''; await assert.rejects(service.preview(item), /代理服务器/);
});

test('Pinterest downloader uses CONNECT to the allowed hostname and never falls back when a proxy refuses it', async () => {
  let destination;
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => { destination = req.url; socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n'); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  try {
    await assert.rejects(downloadPinterest('https://widgets.pinterest.com/v3/test', `http://127.0.0.1:${proxy.address().port}`), /代理连接失败/);
    assert.equal(destination, 'widgets.pinterest.com:443');
    await assert.rejects(downloadPinterest('https://evil.test/path', `http://127.0.0.1:${proxy.address().port}`), /不受支持/);
  } finally { await new Promise(resolve => proxy.close(resolve)); }
});
