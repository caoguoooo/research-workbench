export function initAIChat() {
  const $ = id => document.getElementById(id);
  const dialog = $('ai-chat-dialog');
  const input = $('ai-chat-input');
  const model = $('ai-chat-model');
  const log = $('ai-chat-messages');
  const empty = $('ai-chat-empty');
  const send = $('ai-chat-send');
  const stop = $('ai-chat-stop');
  const newChat = $('ai-chat-new');
  const web = $('ai-chat-web');
  let history = [];
  let pending = null;
  let modelsLoaded = false;
  let loadingModels = null;

  function error(message = '') {
    $('ai-chat-error').textContent = message;
    $('ai-chat-error-wrap').hidden = !message;
  }

  function busy(value) {
    send.disabled = value;
    input.readOnly = value;
    model.disabled = value;
    web.disabled = value;
    newChat.disabled = value;
    stop.hidden = !value;
    log.setAttribute('aria-busy', String(value));
  }

  web.addEventListener('change', () => { $('ai-chat-mode').textContent = web.checked ? '联网检索 · 生成草稿' : '文字整理 · 生成草稿'; });

  function showReply(bubble, result) {
    const content = bubble.querySelector('p');
    content.replaceChildren();
    let offset = 0;
    const sources = result.sources || [];
    for (const cite of (result.citations || []).sort((a, b) => a.start - b.start)) {
      const index = sources.findIndex(source => source.url === cite.url);
      if (index < 0 || cite.start < offset || cite.end > result.reply.length) continue;
      content.append(document.createTextNode(result.reply.slice(offset, cite.start)));
      const link = document.createElement('a');
      link.href = cite.url;
      link.textContent = `[${index + 1}]`;
      link.title = sources[index].title;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      content.append(link);
      offset = cite.end;
    }
    content.append(document.createTextNode(result.reply.slice(offset)));
    if (result.searched) {
      bubble.querySelector('span').textContent = `AI · 已联网检索 · ${sources.length} 个来源`;
      const details = document.createElement('details');
      details.className = 'ai-chat-sources';
      const summary = document.createElement('summary');
      summary.textContent = '查看来源';
      const list = document.createElement('ol');
      for (const source of sources) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.textContent = source.title;
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        item.append(link);
        list.append(item);
      }
      details.append(summary, list);
      bubble.append(details);
    }
  }

  function append(role, text) {
    empty.hidden = true;
    const bubble = document.createElement('div');
    bubble.className = `ai-chat-message ai-chat-${role}`;
    const label = document.createElement('span');
    label.textContent = role === 'user' ? '你' : 'AI';
    const content = document.createElement('p');
    content.textContent = text;
    bubble.append(label, content);
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...options.headers, 'X-Workbench-Request': '1' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'AI 请求失败，请重试');
    return data;
  }

  async function loadModels() {
    if (modelsLoaded || loadingModels) return;
    const controller = new AbortController();
    loadingModels = controller;
    try {
      const result = await api('/api/ai/models', { signal: controller.signal });
      $('ai-model-options').replaceChildren();
      for (const id of result.models) {
        const option = document.createElement('option');
        option.value = id;
        $('ai-model-options').append(option);
      }
      // With several models the user chooses, rather than silently using an arbitrary one.
      if (!model.value && result.models.length === 1) model.value = result.models[0];
      modelsLoaded = true;
    } catch (failure) {
      if (!controller.signal.aborted && !pending && !model.value.trim()) error(failure.message);
    } finally { if (loadingModels === controller) loadingModels = null; }
  }

  $('open-ai-chat').addEventListener('click', () => {
    error();
    dialog.showModal();
    input.focus();
    loadModels();
  });
  $('ai-chat-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    pending?.abort();
    loadingModels?.abort();
    $('open-ai-chat').focus();
  });
  $('ai-chat-settings').addEventListener('click', () => {
    dialog.close();
    $('settings-button').click();
  });
  document.addEventListener('ai-settings-updated', () => {
    loadingModels?.abort();
    loadingModels = null;
    modelsLoaded = false;
    model.value = '';
    $('ai-model-options').replaceChildren();
  });
  newChat.addEventListener('click', () => {
    history = [];
    log.querySelectorAll('.ai-chat-message').forEach(node => node.remove());
    empty.hidden = false;
    input.value = '';
    error();
    input.focus();
  });
  stop.addEventListener('click', () => pending?.abort());
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('ai-chat-form').requestSubmit();
    }
  });
  $('ai-chat-form').addEventListener('submit', async event => {
    event.preventDefault();
    const content = input.value.trim();
    if (pending || !content) return;
    if (!model.value.trim()) { error('请选择或输入服务提供的模型名称'); model.focus(); return; }
    error();
    const controller = new AbortController();
    pending = controller;
    busy(true);
    const message = { role: 'user', content };
    const previous = history.slice(-18);
    while (previous.length && previous.reduce((total, item) => total + item.content.length, content.length) > 48000) previous.splice(0, 2);
    const userBubble = append('user', content);
    const waiting = append('assistant', web.checked ? '正在联网检索和整理…' : '正在整理…');
    input.value = '';
    try {
      const result = await api('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.value.trim(), webSearch: web.checked, messages: [...previous, message] }), signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      showReply(waiting, result);
      history = [...previous, message, { role: 'assistant', content: result.reply }];
      log.scrollTop = log.scrollHeight;
    } catch (failure) {
      userBubble.remove();
      waiting.remove();
      empty.hidden = history.length > 0;
      input.value = content;
      if (dialog.open) error(controller.signal.aborted ? '已停止，可以修改内容后重新发送。' : failure.message);
    } finally {
      if (pending === controller) { pending = null; busy(false); if (dialog.open) input.focus(); }
    }
  });
}
