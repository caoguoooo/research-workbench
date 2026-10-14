export function initAIChat() {
  const $ = id => document.getElementById(id);
  const dialog = $('ai-chat-dialog');
  const input = $('ai-chat-input');
  const model = $('ai-chat-model');
  const log = $('ai-chat-messages');
  const empty = $('ai-chat-empty');
  const send = $('ai-chat-send');
  const organize = $('ai-chat-organize');
  const stop = $('ai-chat-stop');
  const newChat = $('ai-chat-new');
  const web = $('ai-chat-web');
  const historyButton = $('ai-chat-history');
  const historyList = $('ai-chat-history-list');
  const collectForm = $('ai-collect-form');
  let opener = $('open-ai-chat');
  let conversationId = null;
  let historyLoaded = false;
  let loadingHistory = false;
  let history = [];
  let pending = null;
  let archiveSaving = false;
  let modelsLoaded = false;
  let loadingModels = null;

  function error(message = '') {
    $('ai-chat-error').textContent = message;
    $('ai-chat-error-wrap').hidden = !message;
  }

  function busy(value) {
    const locked = value || archiveSaving || loadingHistory;
    send.disabled = locked;
    organize.disabled = locked;
    input.readOnly = locked;
    model.disabled = locked;
    web.disabled = locked;
    newChat.disabled = locked;
    historyButton.disabled = locked;
    collectForm.querySelectorAll('input,button').forEach(field => { field.disabled = locked; });
    log.querySelectorAll('.ai-draft-form button').forEach(button => { button.disabled = locked; });
    stop.hidden = !value;
    log.setAttribute('aria-busy', String(value));
  }

  web.addEventListener('change', () => { $('ai-chat-mode').textContent = web.checked ? '联网检索 · 可保存到档案' : '文字整理 · 可保存到档案'; });

  function showReply(bubble, result) {
    if (result.failed) {
      bubble.querySelector('span').textContent = 'AI · 未完成';
      bubble.classList.add('ai-chat-failed');
    }
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

  function showDraft(bubble, draft) {
    bubble.querySelector('span').textContent = 'AI · 竞品档案草稿';
    bubble.querySelector('p').textContent = draft.collection ? `${draft.collection.visualStatus === 'completed' ? '已将实际预览送交视觉模型，推荐仅供参考。' : '未完成视觉筛选，请人工看图。'}检查归属、清晰度、水印与授权后选图并分类；确认后下载来源文件，原文件至少 1600×600 像素。网页文件是否为拍摄原图无法确认时会如实标记。网络资料不记为实地踩盘。` : '检查项目名称和城市后保存。图片需后续上传，网络资料不记为实地踩盘。';
    const form = document.createElement('form');
    form.className = 'ai-draft-form';
    const fields = { name:['楼盘名称',100], city:['城市',60], district:['区域',60], address:['地址',200], developer:['开发商',100], status:['销售状态',40], positioning:['项目定位',500], summary:['项目概况',3000] };
    const extra = document.createElement('details');
    const extraTitle = document.createElement('summary');
    extraTitle.textContent = '检查及编辑基础信息'; extra.append(extraTitle);
    for (const [name, [title, max]] of Object.entries(fields)) {
      const label = document.createElement('label');
      label.textContent = title;
      const field = document.createElement(['positioning','summary'].includes(name) ? 'textarea' : 'input');
      field.name = name;
      field.maxLength = max;
      field.value = draft.project[name];
      field.required = ['name','city'].includes(name);
      if (field.tagName === 'TEXTAREA') field.rows = name === 'summary' ? 3 : 2;
      label.append(field);
      if (['name','city'].includes(name)) form.append(label);
      else extra.append(label);
    }
    form.append(extra);
    const report = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `查看整理资料 · ${draft.floorplans.length} 个户型位置`;
    const text = document.createElement('p');
    text.textContent = draft.research.report + '\n\n户型资料\n' + draft.floorplans.map(slot => [slot.label, slot.area || '面积待补充', slot.rooms || '房型待补充', slot.notes].filter(Boolean).join(' · ')).join('\n');
    report.append(summary, text);
    if (draft.research.sources.length) {
      const list = document.createElement('ol');
      for (const source of draft.research.sources) {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = source.url; link.textContent = source.title;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        li.append(link); list.append(li);
      }
      report.append(list);
    }
    form.append(report);
    if (draft.collection) {
      const gallery = document.createElement('div');
      gallery.className = 'ai-collect-images';
      for (const image of draft.collection.images) {
        const card = document.createElement('div');
        const preview = document.createElement('img');
        preview.src = `/api/ai/collection/image?draftId=${encodeURIComponent(draft.draftId)}&imageId=${encodeURIComponent(image.id)}`;
        preview.alt = image.description || '候选图片';
        preview.loading = 'lazy';
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.name = 'imageIds'; checkbox.value = image.id; checkbox.checked = false;
        if (draft.savedId) checkbox.checked = draft.collection.selectedImageIds?.includes(image.id) === true;
        label.append(checkbox,document.createTextNode('选择此图'));
        const classification = document.createElement('select');
        classification.dataset.imageChoice = image.id;
        classification.setAttribute('aria-label','图片分类和关联户型');
        const options = [['','请选择分类'],['masterplan','总规划'],['renderings','效果图 / 实景'],...draft.floorplans.map((slot,i) => [`floorplan-${String(i+1).padStart(2,'0')}`,slot.label])];
        for (const [value,text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; classification.append(option); }
        classification.value = image.slotId || (image.category === '效果图' ? 'renderings' : '');
        const metadata = document.createElement('p');
        metadata.textContent = `${image.width || '?'} × ${image.height || '?'} · ${image.originalStatus === 'commons-original' ? 'Commons 原图有来源校验' : '网页来源文件，原图身份未确认'}\n作者：${image.author || '未知'}\n许可：${image.license?.name || '未知'}${image.license?.attributionRequired ? ' · 查看署名要求' : ''}\n视觉：${image.visualReview?.status === 'completed' ? image.visualReview.reason : '未完成，需人工检查'}\n水印：${({ present:'模型观察到水印',absent:'模型未观察到水印（仍需检查）',unknown:'未确认' })[image.visualReview?.watermark] || '未确认'}`;
        if (image.license?.restrictions) metadata.textContent += '\n许可限制：'+image.license.restrictions;
        const source = document.createElement('a');
        source.href = image.sourceUrl; source.textContent = '查看原网页 ↗'; source.target = '_blank'; source.rel = 'noopener noreferrer';
        preview.addEventListener('error',() => { if (!draft.savedId) checkbox.checked = false; preview.hidden = true; });
        card.append(preview,label,classification,metadata,source);
        if (image.license?.url) {
          const license = document.createElement('a'); license.href = image.license.url; license.textContent = '许可条款 ↗'; license.target = '_blank'; license.rel = 'noopener noreferrer'; card.append(license);
        }
        gallery.append(card);
      }
      form.append(gallery);
      if (draft.collection.images.length) {
        const review = document.createElement('label'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.name = 'imagesReviewed';
        review.append(checkbox,document.createTextNode('我已查看所选图片，确认项目归属、无不适用水印，并已核查许可/获授权（公开可见不等于商用许可）。不选图可仅保存文字。'));
        form.append(review);
      }
      for (const message of draft.collection.warnings) {
        const notice = document.createElement('p'); notice.textContent = message; form.append(notice);
      }
    }
    const warning = document.createElement('p');
    warning.className = 'ai-draft-error'; warning.setAttribute('role','alert'); warning.hidden = true;
    const button = document.createElement('button');
    button.type = 'submit'; button.className = 'archive-primary'; button.textContent = '保存到竞品档案';
    form.append(warning, button);
    function savedState(id) {
      draft.savedId = id;
      button.type = 'button';
      button.textContent = '已保存 · 查看档案';
      form.querySelectorAll('input,textarea,select').forEach(field => { field.disabled = true; });
      button.onclick = () => { dialog.close(); document.dispatchEvent(new CustomEvent('ai-competitor-saved', { detail:{ id } })); };
    }
    if (draft.savedId) savedState(draft.savedId);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending || archiveSaving || !form.reportValidity()) return;
      archiveSaving = true; busy(false); warning.hidden = true;
      const values = new FormData(form);
      const imageIds = values.getAll('imageIds');
      const imagesReviewed = values.has('imagesReviewed');
      const imageChoices = [...form.querySelectorAll('[data-image-choice]')].filter(field => imageIds.includes(field.dataset.imageChoice)).map(field => ({ id:field.dataset.imageChoice,category:field.value === 'masterplan' ? '总规划' : field.value === 'renderings' ? '效果图' : field.value.startsWith('floorplan-') ? '户型图' : '',slotId:field.value === 'renderings' ? '' : field.value }));
      if (imageIds.length > 6 || (imageIds.length && !imagesReviewed) || imageChoices.some(choice => !choice.category)) {
        warning.textContent = '最多选择 6 张，并填写分类及勾选看图与授权确认。'; warning.hidden = false;
        archiveSaving = false; busy(!!pending); return;
      }
      const project = Object.fromEntries([...values].filter(([name]) => !['imageIds','imagesReviewed'].includes(name)));
      form.querySelectorAll('input,textarea').forEach(field => { field.readOnly = true; });
      form.querySelectorAll('[name="imageIds"]').forEach(field => { field.disabled = true; });
      form.querySelectorAll('select,[name="imagesReviewed"]').forEach(field => { field.disabled = true; });
      button.textContent = '正在保存…';
      try {
        const result = await api('/api/ai/archive', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ draftId:draft.draftId, project, ...(draft.collection ? {imageIds,imageChoices,imagesReviewed} : {}) }) });
        if (draft.collection) draft.collection.selectedImageIds = imageIds;
        savedState(result.item.id);
        dialog.close();
        document.dispatchEvent(new CustomEvent('ai-competitor-saved', { detail:{ id:result.item.id } }));
      } catch (failure) {
        warning.textContent = failure.message; warning.hidden = false;
        button.textContent = '保存到竞品档案';
        form.querySelectorAll('input,textarea').forEach(field => { field.readOnly = false; });
        form.querySelectorAll('[name="imageIds"]').forEach(field => { field.disabled = false; });
        form.querySelectorAll('select,[name="imagesReviewed"]').forEach(field => { field.disabled = false; });
      } finally { archiveSaving = false; busy(!!pending); }
    });
    bubble.append(form);
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
    const timeout = AbortSignal.timeout(url === '/api/ai/collect' ? 420000 : url === '/api/ai/chat' ? 195000 : 20000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(url, { ...options, signal, headers: { ...options.headers, 'X-Workbench-Request': '1' } });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.replace('/login?expired=1');
      throw new Error('登录已失效，请重新登录');
    }
    if (!response.ok) {
      const failure = new Error(data.error || 'AI 请求失败，请重试');
      failure.conversationId = data.conversationId;
      throw failure;
    }
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
      if (!model.value) {
        const preferred = ['gpt-5.2','gpt-4o','gpt-5.4-mini'];
        const chatModels = result.models.filter(id => !/(image|realtime|audio|auto-review)/i.test(id));
        model.value = preferred.find(id => chatModels.includes(id)) || (chatModels.length === 1 ? chatModels[0] : '');
      }
      modelsLoaded = true;
    } catch (failure) {
      if (!controller.signal.aborted && !pending && !model.value.trim()) error(failure.message);
    } finally { if (loadingModels === controller) loadingModels = null; }
  }

  function renderConversation(current) {
    conversationId = current?.id || null;
    history = (current?.messages || []).filter(message => !message.failed && !message.result?.failed).map(({role,content}) => ({role,content}));
    log.querySelectorAll('.ai-chat-message').forEach(node => node.remove());
    empty.hidden = (current?.messages || []).length > 0;
    for (const message of current?.messages || []) {
      const bubble = append(message.role, message.content);
      if (message.result?.draft) showDraft(bubble, message.result.draft);
      else if (message.result) showReply(bubble, message.result);
    }
    if (current?.model) model.value = current.model;
    if (current) web.checked = current.webSearch;
    web.dispatchEvent(new Event('change'));
    log.scrollTop = log.scrollHeight;
  }
  async function restoreHistory(id = null) {
    if (loadingHistory || pending || archiveSaving) return;
    loadingHistory = true; busy(false); error();
    try {
      const result = id ? await api('/api/ai/conversations/select', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id}) }) : await api('/api/ai/conversations');
      renderConversation(result.current);
      historyLoaded = true;
      historyList.hidden = true;
    } catch (failure) { error(failure.message); }
    finally { loadingHistory = false; busy(!!pending); }
  }
  historyButton.addEventListener('click', async () => {
    if (!historyList.hidden) { historyList.hidden = true; return; }
    if (loadingHistory || pending || archiveSaving) return;
    loadingHistory = true; busy(false); error();
    try {
      const result = await api('/api/ai/conversations');
      historyList.replaceChildren();
      for (const item of result.items) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = item.title;
        button.title = item.title;
        button.setAttribute('aria-current',String(item.id === conversationId));
        button.addEventListener('click', () => { if (!loadingHistory && !pending && !archiveSaving) restoreHistory(item.id); });
        historyList.append(button);
      }
      if (!result.items.length) historyList.textContent = '暂无历史对话';
      historyList.hidden = false;
    } catch (failure) { error(failure.message); }
    finally { loadingHistory = false; busy(!!pending); }
  });

  $('open-ai-chat').addEventListener('click', () => {
    opener = $('open-ai-chat');
    collectForm.hidden = true;
    dialog.showModal();
    input.focus();
    if (!historyLoaded) restoreHistory();
    loadModels();
  });
  $('open-ai-collect').addEventListener('click', () => {
    opener = $('open-ai-collect');
    collectForm.hidden = false;
    dialog.showModal();
    collectForm.querySelector('[name="city"]').focus();
    if (!historyLoaded) restoreHistory();
    loadModels();
  });
  collectForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || archiveSaving || loadingHistory || !collectForm.reportValidity()) return;
    if (!model.value.trim()) { error('请选择或输入支持联网检索的模型名称'); model.focus(); return; }
    const target = Object.fromEntries(new FormData(collectForm));
    target.model = model.value.trim();
    const controller = new AbortController();
    pending = controller; busy(true); error();
    renderConversation(null);
    append('user',`自动收集：${target.city} ${target.district} ${target.name}`);
    const waiting = append('assistant','正在检索真实来源、验证候选图片并尝试视觉筛选…视觉失败会保留候选供人工确认，不会自动入库。');
    try {
      const result = await api('/api/ai/collect',{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify(target),signal:controller.signal });
      controller.signal.throwIfAborted();
      showDraft(waiting,result.draft);
      conversationId = result.conversationId; historyLoaded = true;
      history = [{ role:'user',content:`收集 ${target.city} ${target.name}` },{ role:'assistant',content:result.draft.research.report }];
      web.checked = true; web.dispatchEvent(new Event('change'));
      collectForm.hidden = true;
    } catch (failure) {
      const reason = controller.signal.aborted ? '已停止收集，可以重新尝试。' : failure.name === 'TimeoutError' ? '收集超时，请重试或更换模型。' : failure.message;
      waiting.querySelector('span').textContent = 'AI · 未完成'; waiting.querySelector('p').textContent = reason;
      waiting.classList.add('ai-chat-failed'); error(reason);
    } finally {
      if (pending === controller) { pending = null; busy(false); }
      log.scrollTop = log.scrollHeight;
    }
  });
  $('ai-chat-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    loadingModels?.abort();
    opener.focus();
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
  newChat.addEventListener('click', async () => {
    if (loadingHistory || pending || archiveSaving) return;
    loadingHistory = true; busy(false); error();
    try {
      const result = await api('/api/ai/conversations', { method:'POST' });
      renderConversation(result.current); historyLoaded = true;
      input.value = ''; historyList.hidden = true;
      input.focus();
    } catch (failure) { error(failure.message); }
    finally { loadingHistory = false; busy(!!pending); }
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
    const archiveDraft = event.submitter === organize;
    const content = input.value.trim() || (archiveDraft && history.length ? '将以上已确认的项目资料整理成一份竞品档案。' : '');
    if (pending || archiveSaving || loadingHistory) return;
    if (!content) { error('请输入楼盘名称和城市，或粘贴项目资料'); input.focus(); return; }
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
      const result = await api('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, model: model.value.trim(), webSearch: web.checked, archiveDraft, messages: [...previous, message] }), signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (result.draft) showDraft(waiting, result.draft);
      else showReply(waiting, result);
      const reply = result.draft ? `${result.draft.project.name} · ${result.draft.project.city}\n${result.draft.project.summary}\n${result.draft.research.report}` : result.reply;
      history = [...previous, message, { role:'assistant', content:reply }];
      conversationId = result.conversationId;
      historyLoaded = true;
      log.scrollTop = log.scrollHeight;
    } catch (failure) {
      if (failure.conversationId) { conversationId = failure.conversationId; historyLoaded = true; }
      const reason = controller.signal.aborted ? '已停止，可以修改内容后重新发送。' : failure.name === 'TimeoutError' ? 'AI 等待超时，请重试或更换模型。' : failure.message;
      waiting.querySelector('span').textContent = 'AI · 未完成';
      waiting.querySelector('p').textContent = reason;
      waiting.classList.add('ai-chat-failed');
      empty.hidden = true;
      input.value = content;
      error(reason);
      log.scrollTop = log.scrollHeight;
    } finally {
      if (pending === controller) { pending = null; busy(false); if (dialog.open) input.focus(); }
    }
  });
}
