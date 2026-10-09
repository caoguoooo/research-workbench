import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIClient } from '../ai-client.mjs';
import { decodeResponse, readWebReply } from '../ai-web-response.mjs';

const completed = {
  status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://example.com/source', title: '公开资料' }, { url: 'javascript:alert(1)' }] } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '重庆。[来源]', annotations: [{ type: 'url_citation', start_index: 3, end_index: 7, url: 'https://example.com/source', title: '项目来源' }, { type: 'url_citation', url: 'https://user:pass@example.com/private' }] }] }
  ]
};

test('web requests use Responses and decode streamed citations without exposing credentials', async () => {
  let call;
  const events = [
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.completed', response: completed }
  ].map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  const client = createAIClient(() => ({ baseUrl: 'https://example.com/v1', token: 'test-only-secret' }), {
    fetchImpl: async (url, options) => { call = { url, options }; return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } }); }
  });
  const result = await client.chat({ model: 'demo', webSearch: true, messages: [{ role: 'user', content: '重庆某项目' }] });
  assert.equal(call.url, 'https://example.com/v1/responses');
  const body = JSON.parse(call.options.body);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.input[0].content[0].text, '重庆某项目');
  assert.equal(result.searched, true);
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.citations, [{ url: 'https://example.com/source', start: 3, end: 7 }]);
  assert.equal(JSON.stringify(result).includes('test-only-secret'), false);
});

test('web results require actual completed searches and usable sources; truncated or failed streams reject', () => {
  assert.deepEqual(decodeResponse(JSON.stringify(completed)), completed);
  const noSearch = structuredClone(completed); noSearch.output.shift();
  assert.throws(() => readWebReply(noSearch, 'demo'), /实际联网检索/);
  const noSources = structuredClone(completed); noSources.output[0].action.sources = []; noSources.output[1].content[0].annotations = [];
  assert.throws(() => readWebReply(noSources, 'demo'), /来源链接/);
  const incomplete = structuredClone(completed); incomplete.status = 'incomplete';
  assert.throws(() => readWebReply(incomplete, 'demo'), /未完成/);
  assert.throws(() => decodeResponse('event: response.created\ndata: {"type":"response.created"}\n\n'), /完整结果/);
  assert.throws(() => decodeResponse('data: {"type":"error","error":{"message":"test-only-secret"}}\n\n'), error => !error.message.includes('test-only-secret'));
});

test('web options are validated and provider quota errors do not become successful search replies', async () => {
  let calls = 0;
  const client = createAIClient(() => ({ baseUrl: 'https://example.com/v1', token: 'test-only-secret' }), { fetchImpl: async () => { calls++; return new Response('test-only-secret', { status: 429 }); } });
  await assert.rejects(client.chat({ model: 'demo', webSearch: 'true', messages: [{ role: 'user', content: '资料' }] }), error => error.status === 400);
  assert.equal(calls, 0);
  await assert.rejects(client.chat({ model: 'demo', webSearch: true, messages: [{ role: 'user', content: '资料' }] }), error => error.status === 502 && !error.message.includes('test-only-secret'));
});
