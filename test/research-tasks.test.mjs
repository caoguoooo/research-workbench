import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSQLiteRepository } from '../sqlite-repository.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const week = 7 * 24 * 60 * 60 * 1000;
const projectKeys = ['name', 'city', 'district', 'address', 'developer', 'status', 'positioning', 'summary'];
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6n8AAAAASUVORK5CYII=', 'base64');
const result = (project = { summary: '依据公开资料整理的概况' }) => ({
  project,
  report: '资料日期：2026-10-14。事实与分析分列；价格和规划数据仍待核实。',
  sources: [{ title: '项目公开资料', url: 'https://example.com/project' }]
});

function expectJSON(response, status = 200) {
  assert.equal(response.status, status, response.text);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  return response.value;
}

async function withServer(storage, run) {
  const dir = await mkdtemp(path.join(tmpdir(), `workbench-research-tasks-${storage}-`));
  const port = storage === 'json' ? 39110 : 39111;
  const base = `http://127.0.0.1:${port}`;
  const account = { username: 'research-tester', password: 'research-test-only-password' };
  const tokens = new Set();
  let child, cookie, output = '';

  async function start() {
    output = '';
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: '',
        WORKBENCH_STORAGE: storage, WORKBENCH_DATA_DIR: dir,
        WORKBENCH_REFERENCES_DIR: path.join(dir, 'references'),
        WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false', WORKBENCH_HOME_VISUAL: 'false',
        WORKBENCH_TRUST_PROXY: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', data => { output += data; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Server startup timeout: ${output}`)), 10_000);
      function finish(error) {
        clearTimeout(timer);
        child.stdout.off('data', ready);
        child.off('error', failed);
        child.off('exit', exited);
        if (error) reject(error); else resolve();
      }
      function ready(data) {
        output += data;
        if (output.includes(`http://127.0.0.1:${port}`)) finish();
      }
      function failed(error) { finish(error); }
      function exited(code, signal) { finish(new Error(`Server exited ${code ?? signal}: ${output}`)); }
      child.stdout.on('data', ready);
      child.once('error', failed);
      child.once('exit', exited);
    });
  }

  async function stop() {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }

  async function decode(response) {
    const text = await response.text();
    return { status: response.status, headers: response.headers, text,
      value: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  }

  async function request(route, method = 'GET', body, headers = {}) {
    return decode(await fetch(base + route, {
      method, redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
  }
  const admin = (route, method = 'GET', body, headers = {}) => request(route, method, body, {
    Cookie: cookie || '', Origin: base, 'X-Workbench-Request': '1', ...headers
  });
  const agent = (token, route = '/api/agent/task', body, headers = {}) => request(
    route, body === undefined ? 'GET' : 'POST', body,
    { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }
  );

  function noSecrets(value) {
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, /"(?:token|tokenHash|authorization)"\s*:/i);
    for (const token of tokens) {
      assert.equal(serialized.includes(token), false, 'raw task token must not leak');
      assert.equal(serialized.includes(createHash('sha256').update(token).digest('hex')), false, 'task token hash must not leak');
    }
  }

  async function login() {
    const response = await admin('/api/login', 'POST', account);
    expectJSON(response);
    cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
  }

  async function restart() { await stop(); await start(); await login(); }

  async function issue(input, id) {
    const value = expectJSON(await admin(id ? `/api/research-tasks/${id}/token` : '/api/research-tasks', 'POST', input), id ? 200 : 201);
    assert.match(value.token, /^[0-9a-f]{64}$/);
    tokens.add(value.token);
    noSecrets(value.task);
    assert.ok(Math.abs(Date.parse(value.task.expiresAt) - Date.now() - week) < 5_000, 'task token lifetime is seven days');
    return value;
  }

  async function tasks() {
    const value = expectJSON(await admin('/api/research-tasks'));
    noSecrets(value);
    return value.items;
  }
  async function items() {
    const value = expectJSON(await admin('/api/competitors'));
    noSecrets(value);
    return value.items;
  }
  async function item(id) {
    const value = expectJSON(await admin(`/api/competitors/${id}`));
    noSecrets(value);
    return value.item;
  }
  async function snapshot() {
    if (storage === 'json') return JSON.parse(await readFile(path.join(dir, 'competitors.json'), 'utf8'));
    const repository = createSQLiteRepository(dir);
    try { return await repository.read(); }
    finally { await repository.close(); }
  }
  async function editFixture(change) {
    await stop();
    if (storage === 'json') {
      const archive = JSON.parse(await readFile(path.join(dir, 'competitors.json'), 'utf8'));
      change(archive);
      await writeFile(path.join(dir, 'competitors.json'), JSON.stringify(archive));
    } else {
      const repository = createSQLiteRepository(dir);
      try { await repository.mutate((records, archive) => change(archive)); }
      finally { await repository.close(); }
    }
    await start();
    await login();
  }
  async function upload(id, visitId, slotId) {
    const query = new URLSearchParams({ name: '原始户型图.png', category: '户型图', visitId, slotId });
    return expectJSON(await decode(await fetch(`${base}/api/competitors/${id}/files?${query}`, {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-Workbench-Request': '1', 'Content-Type': 'image/png' },
      body: image, signal: AbortSignal.timeout(10_000)
    })), 201).file;
  }
  async function download(id, fileId) {
    const response = await fetch(`${base}/api/competitors/${id}/files/${fileId}`, {
      headers: { Cookie: cookie }, signal: AbortSignal.timeout(10_000)
    });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  }
  async function seededProject(name) {
    const issued = await issue({ name, city: '成都', instructions: '创建初始研究报告' });
    expectJSON(await agent(issued.token, '/api/agent/result', result({
      summary: '原始概况', district: '原区域', address: '原地址', developer: '原开发商', status: '在售', positioning: '原定位'
    })));
    const saved = expectJSON(await admin(`/api/research-tasks/${issued.task.id}/review`, 'POST', {
      action: 'approve', fields: ['summary', 'district', 'address', 'developer', 'status', 'positioning'], includeReport: true
    })).item;
    const visit = expectJSON(await admin(`/api/competitors/${saved.id}/visits`, 'POST', {
      visitedAt: '2026-10-14', observer: '测试员', notes: '原始踩盘', products: '实地核实的户型'
    }), 201).visit;
    expectJSON(await admin(`/api/competitors/${saved.id}/floorplans/floorplan-01`, 'PATCH', {
      label: '原始 A 户型', area: '105㎡', rooms: '三室两厅', notes: '原始户型说明'
    }));
    expectJSON(await admin(`/api/competitors/${saved.id}/floorplans`, 'POST', {
      label: '扩展户型', area: '140㎡', rooms: '四室两厅', notes: '保留 UUID 户型'
    }), 201);
    const file = await upload(saved.id, visit.id, 'floorplan-01');
    return { item: await item(saved.id), visit, file };
  }

  try {
    await start();
    expectJSON(await admin('/api/setup', 'POST', account), 201);
    await login();
    await run({ base, request, admin, agent, issue, tasks, items, item, snapshot, editFixture,
      restart, noSecrets, seededProject, download });
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
}

for (const storage of ['json', 'sqlite']) {
  test(`Hermes research tasks (${storage})`, { concurrency: false, timeout: 120_000 }, async t => {
    await t.test('create → concurrent submit → concurrent approve → restart is durable and idempotent', () => withServer(storage, async s => {
      const issued = await s.issue({ name: '新建研究楼盘', city: '成都', instructions: '核对公开资料并标记不确定事项' });
      assert.equal(issued.task.status, 'pending');
      assert.equal(Date.parse(issued.task.expiresAt) - Date.parse(issued.task.createdAt), week);
      assert.equal((await s.items()).length, 0);
      const internal = await s.snapshot();
      assert.equal(internal.researchTasks[0].tokenHash, createHash('sha256').update(issued.token).digest('hex'));
      assert.equal(JSON.stringify(internal).includes(issued.token), false, 'storage only retains the task token hash');
      await s.restart();
      const fetched = expectJSON(await s.agent(issued.token));
      s.noSecrets(fetched);
      assert.equal(fetched.task.id, issued.task.id);
      assert.equal(fetched.task.current, null);
      assert.equal(fetched.task.instructions, issued.task.instructions);
      const payload = result({ summary: '新概况', developer: '公开开发商' });
      const submissions = await Promise.all(Array.from({ length: 4 }, () => s.agent(issued.token, '/api/agent/result', payload)));
      const receipt = expectJSON(submissions[0]);
      for (const response of submissions) {
        assert.deepEqual(expectJSON(response), receipt);
        s.noSecrets(response.value);
      }
      assert.equal(receipt.status, 'submitted');
      assert.equal((await s.items()).length, 0, 'agent submissions never write competitor records');
      const submitted = await s.snapshot();
      expectJSON(await s.agent(issued.token, '/api/agent/result', { ...payload, report: '修改后的提交' }), 409);
      assert.deepEqual(await s.snapshot(), submitted, 'conflicting retries must not alter stored results');
      await s.restart();
      assert.equal(expectJSON(await s.agent(issued.token)).task.status, 'submitted');
      assert.deepEqual(expectJSON(await s.agent(issued.token, '/api/agent/result', payload)), receipt);
      const review = { action: 'approve', fields: ['summary', 'developer'], includeReport: true };
      const approvals = await Promise.all(Array.from({ length: 4 }, () => s.admin(`/api/research-tasks/${issued.task.id}/review`, 'POST', review)));
      const approved = expectJSON(approvals[0]);
      for (const response of approvals) {
        assert.deepEqual(expectJSON(response), approved);
        s.noSecrets(response.value);
      }
      assert.equal(approved.task.status, 'approved');
      assert.equal(approved.task.savedId, approved.item.id);
      assert.equal(approved.item.summary, payload.project.summary);
      assert.equal(approved.item.developer, payload.project.developer);
      assert.equal(approved.item.aiResearch.provenance, 'external-agent');
      assert.equal(approved.item.aiResearch.report, payload.report);
      assert.deepEqual(approved.item.aiResearch.sources, payload.sources);
      assert.equal(approved.item.visits.length, 0);
      assert.equal(approved.item.files.length, 0);
      assert.equal(approved.item.floorplans.length, 3);
      assert.equal((await s.items()).length, 1);
      expectJSON(await s.agent(issued.token), 401);
      expectJSON(await s.agent(issued.token, '/api/agent/result', payload), 401);
      const committed = await s.snapshot();
      assert.equal(committed.competitors.length, 1);
      assert.equal(committed.researchTasks[0].savedId, committed.competitors[0].id);
      assert.equal(Object.hasOwn(committed.researchTasks[0], 'tokenHash'), false);
      await s.restart();
      assert.deepEqual(await s.item(approved.item.id), approved.item);
      assert.equal((await s.tasks())[0].status, 'approved');
      assert.deepEqual(expectJSON(await s.admin(`/api/research-tasks/${issued.task.id}/review`, 'POST', review)), approved);
      assert.deepEqual(await s.snapshot(), committed, 'replayed approvals do not create another record or history entry');
      expectJSON(await s.agent(issued.token), 401);
    }));

    await t.test('rotation revokes old tokens; rejection and seven-day expiry revoke pending/submitted access', () => withServer(storage, async s => {
      const first = await s.issue({ name: '重发任务', city: '成都' });
      const second = await s.issue({ name: '隔离任务', city: '成都' });
      const rotated = await s.issue({}, first.task.id);
      assert.notEqual(rotated.token, first.token);
      assert.equal(rotated.task.id, first.task.id);
      expectJSON(await s.agent(first.token), 401);
      expectJSON(await s.agent(first.token, '/api/agent/result', result()), 401);
      assert.equal(expectJSON(await s.agent(rotated.token)).task.id, first.task.id);
      assert.equal(expectJSON(await s.agent(second.token)).task.id, second.task.id);
      const rejected = expectJSON(await s.admin(`/api/research-tasks/${first.task.id}/review`, 'POST', { action: 'reject' }));
      assert.equal(rejected.task.status, 'rejected');
      s.noSecrets(rejected);
      expectJSON(await s.agent(rotated.token), 401);
      expectJSON(await s.agent(rotated.token, '/api/agent/result', result()), 401);
      expectJSON(await s.admin(`/api/research-tasks/${first.task.id}/token`, 'POST', {}), 409);
      expectJSON(await s.admin(`/api/research-tasks/${first.task.id}/review`, 'POST', { action: 'approve', fields: [], includeReport: true }), 409);
      expectJSON(await s.agent(second.token, '/api/agent/result', result()));
      expectJSON(await s.admin(`/api/research-tasks/${second.task.id}/token`, 'POST', {}), 409);
      expectJSON(await s.admin(`/api/research-tasks/${second.task.id}/review`, 'POST', { action: 'reject' }));
      expectJSON(await s.agent(second.token), 401);
      expectJSON(await s.agent(second.token, '/api/agent/result', result()), 401);
      const pending = await s.issue({ name: '过期待执行', city: '成都' });
      const submitted = await s.issue({ name: '过期待审核', city: '成都' });
      expectJSON(await s.agent(submitted.token, '/api/agent/result', result()));
      await s.editFixture(archive => {
        for (const task of archive.researchTasks) {
          if ([pending.task.id, submitted.task.id].includes(task.id)) task.expiresAt = new Date(Date.now() - 1_000).toISOString();
        }
      });
      for (const token of [first.token, rotated.token, second.token, pending.token, submitted.token]) {
        expectJSON(await s.agent(token), 401);
        expectJSON(await s.agent(token, '/api/agent/result', result()), 401);
      }
      assert.equal((await s.items()).length, 0);
      assert.equal((await s.tasks()).length, 4);
    }));

    await t.test('administrator cookies and task Bearer credentials are isolated with 401/403 boundaries', () => withServer(storage, async s => {
      const a = await s.issue({ name: '鉴权任务 A', city: '成都' });
      const b = await s.issue({ name: '鉴权任务 B', city: '成都' });
      for (const [route, method, body] of [
        ['/api/research-tasks', 'GET'], ['/api/research-tasks', 'POST', { name: '越权', city: '成都' }],
        [`/api/research-tasks/${b.task.id}/token`, 'POST', {}],
        [`/api/research-tasks/${b.task.id}/review`, 'POST', { action: 'reject' }],
        ['/api/competitors', 'GET'], ['/api/settings/ai', 'GET'], ['/api/ai/conversations', 'GET'],
        ['/api/account/password', 'POST', { currentPassword: 'fake', newPassword: 'fake-password', confirmPassword: 'fake-password' }]
      ]) {
        expectJSON(await s.request(route, method, body), 401);
        expectJSON(await s.request(route, method, body, { Authorization: `Bearer ${a.token}` }), 401);
      }
      assert.equal(expectJSON(await s.request('/api/status', 'GET', undefined, { Authorization: `Bearer ${a.token}` })).authenticated, false);
      const app = await s.request('/app', 'GET', undefined, { Authorization: `Bearer ${a.token}` });
      assert.equal(app.status, 302);
      assert.equal(app.headers.get('location'), '/login');
      expectJSON(await s.admin('/api/agent/task'), 403);
      expectJSON(await s.admin('/api/agent/task', 'GET', undefined, { Origin: '' }), 401);
      for (const authorization of ['', 'Basic test', `bearer ${a.token}`, `Bearer ${'A'.repeat(64)}`,
        `Bearer ${'a'.repeat(63)}`, `Bearer ${'a'.repeat(65)}`, `Bearer ${'g'.repeat(64)}`, `Bearer ${'0'.repeat(64)}`]) {
        expectJSON(await s.request('/api/agent/task', 'GET', undefined, { Authorization: authorization }), 401);
      }
      expectJSON(await s.request(`/api/agent/task?token=${a.token}`), 401);
      expectJSON(await s.request('/api/agent/task', 'GET', undefined, { Cookie: `token=${a.token}` }), 401);
      expectJSON(await s.agent(null, '/api/agent/result', result()), 401);
      for (const headers of [{ Origin: s.base }, { Origin: 'https://untrusted.example' },
        { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        expectJSON(await s.agent(a.token, '/api/agent/task', undefined, headers), 403);
        expectJSON(await s.agent(a.token, '/api/agent/result', result(), headers), 403);
      }
      for (const [route, body] of [
        ['/api/research-tasks', { name: '跨站任务', city: '成都' }],
        [`/api/research-tasks/${a.task.id}/token`, {}],
        [`/api/research-tasks/${a.task.id}/review`, { action: 'reject' }]
      ]) expectJSON(await s.admin(route, 'POST', body, { Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site' }), 403);
      expectJSON(await s.agent(a.token, '/api/agent/result', result()));
      const listed = await s.tasks();
      assert.equal(listed.find(task => task.id === a.task.id).status, 'submitted');
      assert.equal(listed.find(task => task.id === b.task.id).status, 'pending');
      assert.equal(expectJSON(await s.agent(b.token)).task.id, b.task.id);
      assert.equal((await s.items()).length, 0);
    }));

    await t.test('source URL and result validation reject unsafe input without changing task state', () => withServer(storage, async s => {
      const issued = await s.issue({ name: '来源校验', city: '成都' });
      const before = await s.snapshot();
      for (const url of [
        'javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd',
        'http://localhost/project', 'http://sub.localhost/project', 'http://intranet/project',
        'http://printer.local/project', 'http://service.internal/project', 'http://router.lan/project',
        'http://localhost./project', 'http://printer.local./project', 'http://service.internal./project',
        'http://127.0.0.1/project', 'http://192.168.1.2/project', 'http://10.0.0.1/project',
        'http://127.1/project', 'http://2130706433/project', 'http://[::1]/project',
        'http://[::ffff:127.0.0.1]/project', 'https://user:password@example.com/project',
        'https://user@example.com/project'
      ]) {
        expectJSON(await s.agent(issued.token, '/api/agent/result', { ...result(), sources: [{ title: '拒绝此来源', url }] }), 400);
      }
      for (const payload of [
        { ...result(), project: null }, { ...result(), project: [] }, { ...result(), report: '' },
        { ...result(), sources: [] }, { ...result(), sources: [{ title: '', url: 'https://example.com' }] },
        { ...result(), sources: [{ title: '缺少网址' }] }, result({ summary: 123 }),
        result({ name: '另一个楼盘' }), result({ city: '上海' }),
        { ...result(), report: `不得公开任务凭据 ${issued.token}` }
      ]) expectJSON(await s.agent(issued.token, '/api/agent/result', payload), 400);
      expectJSON(await s.agent(issued.token, '/api/agent/result', result(), { 'Content-Type': 'text/plain' }), 415);
      assert.deepEqual(await s.snapshot(), before);
      assert.equal((await s.tasks())[0].status, 'pending');
      assert.equal((await s.items()).length, 0);
      const valid = { ...result(), sources: [{ title: '公开 HTTP 来源', url: 'http://example.com/source' }, ...result().sources] };
      expectJSON(await s.agent(issued.token, '/api/agent/result', valid));
      assert.deepEqual((await s.tasks())[0].result.sources, valid.sources);
      assert.equal((await s.items()).length, 0);
    }));

    await t.test('oversized admin and agent JSON return 413 and leave storage untouched', () => withServer(storage, async s => {
      const issued = await s.issue({ name: '请求体上限', city: '成都' });
      const before = await s.snapshot();
      expectJSON(await s.admin('/api/research-tasks', 'POST', { name: '过大请求', city: '成都', instructions: 'x'.repeat(17 * 1024) }), 413);
      expectJSON(await s.admin(`/api/research-tasks/${issued.task.id}/review`, 'POST', {
        action: 'reject', padding: 'x'.repeat(17 * 1024)
      }), 413);
      expectJSON(await s.agent(issued.token, '/api/agent/result', { ...result(), report: 'x'.repeat(129 * 1024) }), 413);
      assert.deepEqual(await s.snapshot(), before);
      assert.equal(expectJSON(await s.agent(issued.token)).task.status, 'pending');
    }));

    await t.test('selected fields and optional reports preserve overview, visits, files and legacy/UUID floorplans', () => withServer(storage, async s => {
      const seeded = await s.seededProject('选字段更新楼盘');
      const before = seeded.item;
      const issued = await s.issue({ targetId: before.id, instructions: '只补充有依据的变更' });
      assert.equal(issued.task.targetId, before.id);
      const current = expectJSON(await s.agent(issued.token));
      s.noSecrets(current);
      assert.deepEqual(current.task.current.project, Object.fromEntries(projectKeys.map(key => [key, before[key]])));
      assert.equal(current.task.current.report, before.aiResearch.report);
      const payload = result({ summary: '批准的新概况', developer: '不得覆盖的开发商', address: '不得覆盖的地址',
        floorplans: [], visits: [], files: [], aiResearch: { report: '不得直接写入' } });
      expectJSON(await s.agent(issued.token, '/api/agent/result', payload));
      assert.deepEqual(await s.item(before.id), before);
      const submitted = await s.snapshot();
      for (const invalid of [
        { action: 'invalid', fields: ['summary'], includeReport: false },
        { action: 'approve', fields: ['summary', 'summary'], includeReport: false },
        { action: 'approve', fields: ['positioning'], includeReport: false },
        { action: 'approve', fields: ['files'], includeReport: false },
        { action: 'approve', fields: ['summary'], includeReport: 'true' },
        { action: 'approve', fields: [], includeReport: false }
      ]) expectJSON(await s.admin(`/api/research-tasks/${issued.task.id}/review`, 'POST', invalid), 400);
      assert.deepEqual(await s.snapshot(), submitted, 'invalid review choices must be atomic');
      const review = { action: 'approve', fields: ['summary'], includeReport: false };
      const replies = await Promise.all(Array.from({ length: 3 }, () => s.admin(`/api/research-tasks/${issued.task.id}/review`, 'POST', review)));
      const saved = expectJSON(replies[0]).item;
      for (const reply of replies) assert.deepEqual(expectJSON(reply).item, saved);
      for (const key of projectKeys) assert.equal(saved[key], key === 'summary' ? payload.project.summary : before[key]);
      for (const key of ['floorplans', 'visits', 'files', 'aiResearch']) assert.deepEqual(saved[key], before[key]);
      assert.equal(saved.researchHistory.length, 1);
      assert.equal(saved.researchHistory[0].project.summary, before.summary);
      assert.deepEqual(saved.researchHistory[0].research, before.aiResearch);
      assert.equal(saved.files[0].visitId, seeded.visit.id);
      assert.equal(saved.files[0].slotId, 'floorplan-01');
      assert.deepEqual(await s.download(saved.id, seeded.file.id), image);
      const reportTask = await s.issue({ targetId: saved.id });
      const report = { ...result({ developer: '不选中的开发商' }), report: '仅批准这份新报告' };
      expectJSON(await s.agent(reportTask.token, '/api/agent/result', report));
      const reportSaved = expectJSON(await s.admin(`/api/research-tasks/${reportTask.task.id}/review`, 'POST', {
        action: 'approve', fields: [], includeReport: true
      })).item;
      for (const key of projectKeys) assert.equal(reportSaved[key], saved[key]);
      for (const key of ['floorplans', 'visits', 'files']) assert.deepEqual(reportSaved[key], saved[key]);
      assert.equal(reportSaved.aiResearch.report, report.report);
      assert.equal(reportSaved.aiResearch.provenance, 'external-agent');
      assert.equal(reportSaved.researchHistory.length, 2);
      await s.restart();
      assert.deepEqual(await s.item(saved.id), reportSaved);
      assert.deepEqual(await s.download(saved.id, seeded.file.id), image);
      s.noSecrets(await s.tasks());
      assert.equal((await s.items()).length, 1);
    }));

    await t.test('full-record baseline conflicts roll back task and competitor together, even with unchanged updatedAt', () => withServer(storage, async s => {
      const seeded = await s.seededProject('完整基线冲突楼盘');
      const changes = [
        item => { item.summary = '管理员的新概况'; },
        item => { item.floorplans[0].notes = '人工新增户型说明'; },
        item => { item.visits[0].notes = '人工新增踩盘说明'; },
        item => { item.files[0].name = '人工重命名的户型图.png'; },
        item => { item.aiResearch.report = '管理员新保存的研究报告'; }
      ];
      for (const change of changes) {
        const baseline = await s.item(seeded.item.id);
        const issued = await s.issue({ targetId: baseline.id });
        expectJSON(await s.agent(issued.token, '/api/agent/result', result({ summary: '不应覆盖最新档案' })));
        await s.editFixture(archive => change(archive.competitors.find(item => item.id === baseline.id)));
        assert.equal((await s.item(baseline.id)).updatedAt, baseline.updatedAt);
        const before = await s.snapshot();
        expectJSON(await s.admin(`/api/research-tasks/${issued.task.id}/review`, 'POST', {
          action: 'approve', fields: ['summary'], includeReport: true
        }), 409);
        assert.deepEqual(await s.snapshot(), before, 'conflict must commit neither review status nor archive fields');
        assert.equal((await s.tasks()).find(task => task.id === issued.task.id).status, 'submitted');
        assert.equal(expectJSON(await s.agent(issued.token)).task.status, 'submitted');
        expectJSON(await s.agent(issued.token, '/api/agent/result', result({ summary: '不应覆盖最新档案' })));
        await s.restart();
        assert.deepEqual(await s.snapshot(), before, 'conflict rollback survives restart');
      }
      assert.equal((await s.items()).length, 1);
      assert.deepEqual(await s.download(seeded.item.id, seeded.file.id), image);
    }));

    await t.test('same-city normalized duplicate approval returns 409 without overwriting; another city is distinct', () => withServer(storage, async s => {
      const original = expectJSON(await s.admin('/api/competitors', 'POST', {
        name: '同名楼盘', city: '成都', summary: '原档案不可覆盖'
      }), 201).item;
      const duplicate = await s.issue({ name: '同名 楼盘', city: '成都市' });
      expectJSON(await s.agent(duplicate.token, '/api/agent/result', result()));
      const before = await s.snapshot();
      const review = { action: 'approve', fields: ['summary'], includeReport: true };
      expectJSON(await s.admin(`/api/research-tasks/${duplicate.task.id}/review`, 'POST', review), 409);
      assert.deepEqual(await s.snapshot(), before);
      assert.deepEqual(await s.item(original.id), original);
      assert.equal((await s.tasks()).find(task => task.id === duplicate.task.id).status, 'submitted');
      const otherCity = await s.issue({ name: '同名楼盘', city: '重庆' });
      expectJSON(await s.agent(otherCity.token, '/api/agent/result', result()));
      const approved = expectJSON(await s.admin(`/api/research-tasks/${otherCity.task.id}/review`, 'POST', review));
      s.noSecrets(approved);
      assert.equal(approved.item.city, '重庆');
      assert.equal((await s.items()).length, 2);
      await s.restart();
      assert.deepEqual(await s.item(original.id), original);
      assert.equal((await s.tasks()).find(task => task.id === duplicate.task.id).status, 'submitted');
      assert.equal((await s.items()).length, 2);
    }));
  });
}

test('Hermes frontend removes the old AI chat and collection DOM', async () => {
  const html = await readFile(path.join(root, 'app.html'), 'utf8');
  const obsolete = html.match(/\bid\s*=\s*["'](?:open-ai-(?:chat|collect)|ai-(?:chat|collect)(?:-[\w-]+)?)["']/gi) || [];
  assert.deepEqual(obsolete, [], 'old AI chat/collection controls must be removed rather than hidden');
});
