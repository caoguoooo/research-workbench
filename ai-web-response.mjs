import { ArchiveError } from './competitor-store.mjs';

export function decodeResponse(raw) {
  try { return JSON.parse(raw); } catch { /* Some gateways require a streamed Responses request. */ }
  let completed;
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    let event;
    try { event = JSON.parse(data); } catch { throw new ArchiveError('联网接口返回了无法解析的事件，请检查接口兼容性', 502); }
    if (event.type === 'error' || event.type === 'response.failed') throw new ArchiveError('联网检索未完成，请稍后重试或检查模型权限', 502);
    if (event.type === 'response.completed') completed = event.response;
  }
  if (!completed) throw new ArchiveError('联网接口没有返回完整结果，请检查 Responses 接口兼容性', 502);
  return completed;
}

function sourceURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function readWebReply(result, model) {
  if (!result || result.error || result.status !== 'completed' || !Array.isArray(result.output)) throw new ArchiveError('联网检索未完成，请稍后重试', 502);
  const calls = result.output.filter(item => item.type === 'web_search_call' && item.status === 'completed');
  if (!calls.length) throw new ArchiveError('接口没有返回实际联网检索记录，请检查该模型是否支持 web_search', 502);
  const sources = new Map();
  function addSource(value) {
    const url = sourceURL(value?.url);
    if (!url || (!sources.has(url) && sources.size >= 24)) return null;
    if (!sources.has(url)) sources.set(url, { url, title: String(value.title || new URL(url).hostname).slice(0, 180) });
    return url;
  }
  const citations = [];
  let reply = '';
  for (const item of result.output.filter(item => item.type === 'message' && item.role === 'assistant')) {
    for (const part of item.content || []) {
      if (part.type !== 'output_text' || typeof part.text !== 'string') continue;
      const offset = reply.length + (reply ? 1 : 0);
      reply += (reply ? '\n' : '') + part.text;
      for (const annotation of (part.annotations || []).slice(0, 100)) {
        if (annotation.type !== 'url_citation') continue;
        const url = addSource(annotation);
        if (url && Number.isInteger(annotation.start_index) && Number.isInteger(annotation.end_index) && annotation.start_index >= 0 && annotation.end_index > annotation.start_index && annotation.end_index <= part.text.length) {
          citations.push({ url, start: offset + annotation.start_index, end: offset + annotation.end_index });
        }
      }
    }
  }
  for (const call of calls) for (const source of call.action?.sources || []) addSource(source);
  if (!reply.trim() || reply.length > 12000) throw new ArchiveError('联网回复为空或过长，请缩小资料范围后重试', 502);
  if (!sources.size) throw new ArchiveError('搜索没有返回可核对的来源链接，请换一个支持来源引用的模型', 502);
  return { reply, model, searched: true, sources: [...sources.values()], citations, researchedAt: new Date().toISOString() };
}
