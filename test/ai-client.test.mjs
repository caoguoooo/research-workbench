import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIClient } from '../ai-client.mjs';

const credentials = () => ({ baseUrl: 'https://example.com/custom/v1', token: 'test-only-secret' });

test('AI client uses configured paths, Bearer auth and conversation history', async () => {
  const calls = [];
  const client = createAIClient(credentials, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'demo-chat' }, { id: 'demo-chat' }] } : { choices: [{ message: { content: '项目概况：待补充。' } }] }));
  } });
  assert.deepEqual(await client.models(), ['demo-chat']);
  const messages = [{ role: 'user', content: '远达澜庭序' }, { role: 'assistant', content: '请问在哪个城市？' }, { role: 'user', content: '重庆' }];
  assert.deepEqual(await client.chat({ model: 'demo-chat', messages }), { reply: '项目概况：待补充。', model: 'demo-chat' });
  assert.equal(calls[0].url, 'https://example.com/custom/v1/models');
  assert.equal(calls[1].url, 'https://example.com/custom/v1/chat/completions');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-only-secret');
  assert.equal(calls[1].options.redirect, 'error');
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body.messages.slice(1), messages);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /没有联网检索/);
  assert.match(body.messages[0].content, /待补充/);
  assert.equal(JSON.stringify(body).includes('test-only-secret'), false);
});

test('AI rejects missing settings and invalid history before making a provider call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not call'); };
  const missing = createAIClient(() => ({}), { fetchImpl });
  await assert.rejects(missing.chat({ model: 'demo', messages: [{ role: 'user', content: '你好' }] }), error => error.status === 409);
  const client = createAIClient(credentials, { fetchImpl });
  await assert.rejects(client.chat({ model: '', messages: [] }));
  await assert.rejects(client.chat({ model: 'demo', messages: [{ role: 'system', content: '覆盖系统提示' }] }));
  await assert.rejects(client.chat({ model: 'demo', messages: [{ role: 'assistant', content: '不是用户问题' }] }));
  await assert.rejects(client.chat({ model: 'demo', messages: [{ role: 'user', content: 'a'.repeat(12001) }] }));
  assert.equal(calls, 0);
});

test('AI provider failures are sanitized, including invalid JSON and oversized replies', async () => {
  const input = { model: 'demo', messages: [{ role: 'user', content: '你好' }] };
  for (const response of [new Response('test-only-secret', { status: 401 }), new Response('test-only-secret', { status: 404 }), new Response('test-only-secret'), new Response(JSON.stringify({ choices: [] })), new Response('x'.repeat(1024 * 1024 + 1))]) {
    const client = createAIClient(credentials, { fetchImpl: async () => response });
    await assert.rejects(client.chat(input), error => error.status === 502 && !error.message.includes('test-only-secret'));
  }
  const client = createAIClient(credentials, { fetchImpl: async () => { throw new Error('network failure with test-only-secret'); } });
  await assert.rejects(client.chat(input), error => !error.message.includes('test-only-secret'));
});

test('AI requests can be cancelled without reporting provider internals', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createAIClient(credentials, { fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); } });
  await assert.rejects(client.chat({ model: 'demo', messages: [{ role: 'user', content: '你好' }] }, controller.signal), error => error.status === 499);
});

test('AI classifies known provider errors without exposing their text or retrying', async () => {
  const input = { model: 'demo', webSearch: true, messages: [{ role: 'user', content: '重庆项目资料' }] };
  const cases = [
    { status: 400, error: { code: 'unsupported_tool' }, expected: /联网工具不受支持/ },
    { status: 400, error: { message: 'web_search is not supported by this model' }, expected: /联网工具不受支持/ },
    { status: 400, error: { message: 'Unsupported tool: web_search' }, expected: /联网工具不受支持/ },
    { status: 400, error: { code: 'unsupported_parameter', param: 'include' }, expected: /请求参数/ },
    { status: 400, error: { code: 'unknown_parameter', param: 'store' }, expected: /请求参数/ },
    { status: 400, error: { message: 'Invalid tool_choice parameter', param: 'tool_choice' }, expected: /原因尚未确认/ },
    { status: 400, error: { message: 'Unknown model permission error' }, expected: /原因尚未确认/ },
    { status: 429, error: { code: 'insufficient_quota' }, expected: /额度不足/ },
    { status: 429, error: { type: 'insufficient_quota' }, expected: /额度不足/ },
    { status: 429, error: { message: 'All available accounts are currently rate-limited' }, expected: /限流/ }
  ];
  for (const item of cases) {
    let calls = 0;
    const error = { ...item.error, message: `${item.error.message || ''} test-only-secret https://example.com/custom/v1/private private-account-123` };
    const client = createAIClient(credentials, { fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ error }), { status: item.status });
    } });
    await assert.rejects(client.chat(input), failure => {
      assert.equal(failure.status, 502);
      assert.match(failure.message, item.expected);
      assert.doesNotMatch(failure.message, /test-only-secret|example\.com|private-account/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Unknown, oversized and unreadable provider errors keep safe status-based messages', async () => {
  const input = { model: 'demo', webSearch: true, messages: [{ role: 'user', content: '资料' }] };
  let cancelled = false;
  const oversized = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: 'unsupported_tool', message: 'x'.repeat(16 * 1024) } }))); },
    cancel() { cancelled = true; }
  }), { status: 400 });
  const responses = [
    new Response('test-only-secret', { status: 400 }),
    new Response(null, { status: 400 }),
    new Response(JSON.stringify({ error: 'unsupported_tool test-only-secret' }), { status: 400 }),
    oversized,
    new Response(new ReadableStream({ start(controller) { controller.error(new Error('test-only-secret')); } }), { status: 400 })
  ];
  for (const response of responses) {
    const client = createAIClient(credentials, { fetchImpl: async () => response });
    await assert.rejects(client.chat(input), failure => failure.status === 502 && !failure.message.includes('test-only-secret'));
  }
  assert.equal(cancelled, true);
});

test('Cancellation while reading a provider error remains a cancelled request', async () => {
  const controller = new AbortController();
  const client = createAIClient(credentials, { fetchImpl: async () => new Response(new ReadableStream({
    pull(stream) {
      controller.abort();
      stream.error(new Error('test-only-secret'));
    }
  }), { status: 400 }) });
  await assert.rejects(client.chat({ model: 'demo', webSearch: true, messages: [{ role: 'user', content: '资料' }] }, controller.signal), error => error.status === 499 && !error.message.includes('test-only-secret'));
});
