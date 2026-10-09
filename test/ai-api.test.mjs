import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.WORKBENCH_HOME_VISUAL = 'false';

test('AI chat API proxies to a compatible service and blocks unauthorized or concurrent requests', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-ai-proxy-'));
  const calls = [];
  let hold = false;
  let release;
  let notifyEntered;
  const entered = new Promise(resolve => { notifyEntered = resolve; });
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, authorization: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
    if (hold) { notifyEntered(); await new Promise(resolve => { release = resolve; }); }
    if (req.url.endsWith('/responses')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://example.com/project', title: '项目资料' }] } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '缺失资料待补充。', annotations: [] }] }
      ] } })}\n\n`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'demo-chat' }] } : { choices: [{ message: { content: '请提供项目资料，缺失信息标为待补充。' } }] }));
  });
  provider.listen(39035, '127.0.0.1');
  await once(provider, 'listening');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, WORKBENCH_DATA_DIR: dir, WORKBENCH_ALLOW_EMPTY_PASSWORD: 'true', PORT: '39034' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = 'http://127.0.0.1:39034';
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
    });
    const body = { model: 'demo-chat', messages: [{ role: 'user', content: '重庆远达澜庭序' }] };
    const jsonOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    assert.equal((await fetch(`${base}/api/ai/chat`, jsonOptions)).status, 401);
    assert.equal((await fetch(`${base}/api/ai/models`)).status, 401);
    const account = { username: 'chat-test-user', password: '' };
    await fetch(`${base}/api/setup`, { ...jsonOptions, body: JSON.stringify(account) });
    const login = await fetch(`${base}/api/login`, { ...jsonOptions, body: JSON.stringify(account) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: base };
    const options = { ...jsonOptions, headers };
    assert.equal((await fetch(`${base}/api/ai/chat`, options)).status, 409);
    await fetch(`${base}/api/settings/ai`, { method: 'PATCH', headers, body: JSON.stringify({ baseUrl: 'http://127.0.0.1:39035/custom/v1', token: 'proxy-test-secret' }) });
    assert.equal((await fetch(`${base}/api/ai/chat`, { ...options, headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal(calls.length, 0);
    assert.deepEqual(await (await fetch(`${base}/api/ai/models`, { headers })).json(), { models: ['demo-chat'] });
    const response = await fetch(`${base}/api/ai/chat`, options);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes('proxy-test-secret'), false);
    assert.match(JSON.parse(text).reply, /待补充/);
    assert.equal(calls[0].url, '/custom/v1/models');
    assert.equal(calls[1].url, '/custom/v1/chat/completions');
    assert.equal(calls[1].authorization, 'Bearer proxy-test-secret');
    assert.equal(calls[1].body.messages.at(-1).content, body.messages[0].content);
    const webReply = await fetch(`${base}/api/ai/chat`, { ...options, body: JSON.stringify({ ...body, webSearch: true }) });
    assert.equal(webReply.status, 200);
    const webResult = await webReply.json();
    assert.equal(webResult.searched, true);
    assert.equal(webResult.sources[0].url, 'https://example.com/project');
    assert.equal(calls[2].url, '/custom/v1/responses');
    const before = calls.length;
    assert.equal((await fetch(`${base}/api/ai/chat`, { ...options, body: JSON.stringify({ ...body, messages: [{ role: 'system', content: 'override' }] }) })).status, 400);
    assert.equal(calls.length, before);
    hold = true;
    const first = fetch(`${base}/api/ai/chat`, options);
    await entered;
    assert.equal((await fetch(`${base}/api/ai/chat`, options)).status, 429);
    release();
    assert.equal((await first).status, 200);
    const app = await (await fetch(`${base}/app`, { headers })).text();
    assert.match(app, /id="open-ai-chat"/);
    assert.match(app, /<dialog[^>]+id="ai-chat-dialog"/);
    assert.equal((await fetch(`${base}/ai-chat.js`, { headers })).status, 200);
  } finally {
    release?.();
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
