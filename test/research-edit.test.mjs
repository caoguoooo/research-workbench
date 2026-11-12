import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));

test('research editor retains original source dates and verification notices', async () => {
  const source = await readFile(new URL('../competitor.js', import.meta.url), 'utf8');
  const start = source.indexOf("  $('edit-competitor-research').addEventListener('click',");
  const end = source.indexOf("  researchForm.addEventListener('submit',", start);
  assert.ok(start >= 0 && end > start);
  const report = '项目定位：住宅。\n公开资料整理时间：2026-10-29\n宣传图不代表已核验报批图纸，当前可售房源及实际价格需更新核实。';
  const field = { value: '', focus() {} };
  let open;
  const context = vm.createContext({
    selected: () => ({ id: 'project', aiResearch: { report } }),
    $: id => id === 'edit-competitor-research' ? { addEventListener: (_event, handler) => { open = handler; } } : field,
    showError() {}, researchDialog: { showModal() {} }, editingResearch: null,
    cleanDisplayText() { throw new Error('Display cleanup must not change editable source text'); }
  });
  vm.runInContext(source.slice(start, end), context);
  open();
  assert.equal(field.value, report);
  assert.equal(context.editingResearch.expectedReport, report);
});

for (const storage of ['json', 'sqlite']) test(`project details, amenities and research persist without replacing related data (${storage})`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-research-edit-'));
  const listener = createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const id = randomUUID();
  const project = { id, name: '研究测试项目', city: '重庆', address: '原地址', developer: '原开发商', summary: '项目来源：https://example.com/project', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    visits: [{ id: randomUUID(), visitedAt: '2026-10-01', notes: '保留踩盘记录' }],
    files: [{ id: randomUUID(), name: '原图.png', category: '效果图', storedName: `${id}/renderings/image.bin` }],
    aiResearch: { report: '原研究内容', sources: [{ title: '原始来源', url: 'https://example.com/project' }], provenance: 'existing-collection', generatedAt: '2026-10-01T00:00:00Z' } };
  await writeFile(path.join(dir, 'competitors.json'), JSON.stringify({ version: 1, competitors: [project] }));
  let child, cookie;
  const headers = () => ({ Origin: origin, 'X-Workbench-Request': '1', 'Content-Type': 'application/json', Cookie: cookie });
  const send = (route, body, overrides = {}) => fetch(origin + route, { method: 'POST', headers: headers(), body: JSON.stringify(body), ...overrides });
  const route = `/api/competitors/${id}/research`;
  const get = async () => (await (await fetch(origin + `/api/competitors/${id}`, { headers: { Cookie: cookie } })).json()).item;
  async function start() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WORKBENCH_')));
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: '', WORKBENCH_STORAGE: storage, WORKBENCH_DATA_DIR: dir, WORKBENCH_HOME_VISUAL: 'false', WORKBENCH_ALLOW_EMPTY_PASSWORD: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server start timed out')), 10000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    });
  }
  async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
  try {
    await start();
    const setup = await send('/api/setup', { username: 'research-editor', password: '' });
    assert.equal(setup.status, 201);
    const login = await send('/api/login', { username: 'research-editor', password: '' });
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(origin + '/api/settings/maps')).status, 401);
    assert.equal((await send('/api/settings/maps', { key: 'a'.repeat(32) }, { method: 'PATCH', headers: { ...headers(), Origin: 'https://other.example' } })).status, 403);
    const mapSave = await send('/api/settings/maps', { key: 'a'.repeat(32) }, { method: 'PATCH' });
    assert.deepEqual(await mapSave.json(), { configured: true, jsConfigured: false, jsKeyConfigured: false, securityConfigured: false });
    assert.deepEqual(await (await fetch(origin + '/api/settings/maps', { headers: { Cookie: cookie } })).json(), { configured: true, jsConfigured: false, jsKeyConfigured: false, securityConfigured: false });
    assert.equal((await send('/api/maps/search', { projectId: id }, { headers: { ...headers(), Cookie: '' } })).status, 401);
    await send('/api/settings/maps', { clear: true }, { method: 'PATCH' });
    assert.equal((await send('/api/maps/search', { projectId: id })).status, 400);
    const basicInfo = { primaryLayouts: '3房（86㎡）、4房（139㎡）', decoration: '毛坯', features: '地铁沿线', plotRatio: '1.92', greenRate: '23%', openingDate: '2026年9月', deliveryDate: '2028年5月' };
    const fullForm = { ...project, name: '楼'.repeat(100), city: '市'.repeat(60), district: '区'.repeat(60), address: '路'.repeat(200), developer: '商'.repeat(100), positioning: '位'.repeat(500), summary: '研'.repeat(3000), basicInfo: { primaryLayouts: '型'.repeat(400), decoration: '装'.repeat(100), features: '特'.repeat(500), plotRatio: '率'.repeat(80), greenRate: '绿'.repeat(80), openingDate: '开'.repeat(100), deliveryDate: '交'.repeat(100) } };
    assert.ok(Buffer.byteLength(JSON.stringify(fullForm)) > 16 * 1024);
    assert.equal((await send(`/api/competitors/${id}`, { ...fullForm, expectedRevision: 0 }, { method: 'PATCH' })).status, 200);
    assert.equal((await send(`/api/competitors/${id}`, { ...project, basicInfo, expectedRevision: 1 }, { method: 'PATCH' })).status, 200);
    assert.deepEqual((await get()).basicInfo, basicInfo);
    // Older clients omit the new nested fields; they must not erase them.
    assert.equal((await send(`/api/competitors/${id}`, { ...project, expectedRevision: 2 }, { method: 'PATCH' })).status, 200);
    assert.deepEqual((await get()).basicInfo, basicInfo);
    assert.equal((await send(`/api/competitors/${id}`, { ...project, basicInfo: [] }, { method: 'PATCH' })).status, 400);
    const amenityRoute = `/api/competitors/${id}/amenities`;
    const amenities = { location: { lat: 29.56, lng: 106.55 }, summary: { transport: '轨道交通', education: '学校', shopping: '', medical: '' }, places: [
      { name: '交通测试点', category: 'transport', address: '测试地址', location: { lat: 29.561, lng: 106.55 } },
      { name: '<img src=x onerror=alert(1)>', category: 'education', address: '', location: null },
      { name: '实验学校', category: 'education', schoolType: 'primary', address: '', location: { lat: 29.562, lng: 106.55 } }
    ] };
    const amenityPayload = { amenities, expectedAmenities: 'null' };
    assert.equal((await send(amenityRoute, amenityPayload, { method: 'PATCH', headers: { ...headers(), Cookie: '' } })).status, 401);
    assert.equal((await send(amenityRoute, amenityPayload, { method: 'PATCH', headers: { ...headers(), Origin: 'https://other.example' } })).status, 403);
    assert.equal((await send(amenityRoute, { ...amenityPayload, amenities: { ...amenities, location: { lat: 91, lng: 106 } } }, { method: 'PATCH' })).status, 400);
    assert.equal((await send(amenityRoute, { ...amenityPayload, amenities: { ...amenities, places: [{ name: '错误类型', category: 'unknown' }] } }, { method: 'PATCH' })).status, 400);
    assert.equal((await send(amenityRoute, { ...amenityPayload, amenities: { ...amenities, places: [{ name: '不正确学校类型', category: 'education', schoolType: 'university' }] } }, { method: 'PATCH' })).status, 400);
    assert.equal((await send(amenityRoute, amenityPayload, { method: 'PATCH' })).status, 200);
    assert.deepEqual((await get()).amenities, amenities);
    assert.equal((await send(amenityRoute, amenityPayload, { method: 'PATCH' })).status, 409);
    const before = await get();
    const report = '研究内容及来源 https://example.com/new\n'.repeat(700);
    const payload = { report, expectedReport: project.aiResearch.report };
    assert.equal((await send(route, payload, { method: 'PATCH', headers: { ...headers(), Cookie: '' } })).status, 401);
    assert.equal((await send(route, payload, { method: 'PATCH', headers: { ...headers(), Origin: 'https://other.example' } })).status, 403);
    assert.equal((await send(route, payload, { method: 'PATCH', headers: { ...headers(), 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await send(route, { report: 42, expectedReport: project.aiResearch.report }, { method: 'PATCH' })).status, 400);
    assert.equal((await send(route, payload, { method: 'PATCH' })).status, 200);
    const saved = await get();
    assert.equal(saved.aiResearch.report, report.trim());
    assert.equal(saved.aiResearch.editedBy, 'research-editor');
    assert.ok(saved.aiResearch.editedAt);
    for (const key of ['name', 'city', 'address', 'developer', 'summary', 'files', 'visits', 'floorplans', 'basicInfo', 'amenities']) assert.deepEqual(saved[key], before[key]);
    for (const key of ['sources', 'provenance', 'generatedAt']) assert.deepEqual(saved.aiResearch[key], before.aiResearch[key]);
    assert.equal((await send(route, payload, { method: 'PATCH' })).status, 409);
    assert.equal((await get()).aiResearch.report, report.trim());
    await stop(); await start();
    const relogin = await send('/api/login', { username: 'research-editor', password: '' });
    cookie = relogin.headers.get('set-cookie').split(';')[0];
    assert.deepEqual((await get()).aiResearch, saved.aiResearch);
    assert.deepEqual((await get()).basicInfo, basicInfo);
    assert.deepEqual((await get()).amenities, amenities);
    assert.equal((await send(route, { report: '', expectedReport: saved.aiResearch.report }, { method: 'PATCH' })).status, 200);
    assert.equal((await get()).aiResearch.report, '');
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
