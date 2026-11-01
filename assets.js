const $ = id => document.getElementById(id);
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function link(label, url) {
  const node = el('a', 'asset-link', label);
  node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node;
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'X-Workbench-Request': '1', ...options.headers } });
  if (response.status === 401) { location.assign('/login'); throw new Error('登录已失效，请重新登录'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请重试');
  return result;
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function initAssetLibrary({ canEdit = false } = {}) {
  const view = $('assets-view'), grid = $('asset-grid'), editor = $('asset-editor'), preview = $('asset-preview'), form = $('asset-form');
  let items = [], categories = [], selectedCategory = '', selectedSource = '', editing = null, selected = null, files = [], saving = false, loadSequence = 0, managing = false;
  const categoryTabs = new Map(), sourceTabs = new Map();
  function notice(message, isError = false) {
    const node = $('asset-notice'); node.textContent = message; node.hidden = !message; node.classList.toggle('is-error', isError);
  }
  function tags(node, values) { node.replaceChildren(...values.map(tag => el('span', 'asset-tag', tag))); }
  function renderCategoryTabs() {
    if (!categories.includes(selectedCategory)) selectedCategory = categories[0] || '';
    categoryTabs.clear(); $('asset-tabs').replaceChildren();
    for (const name of categories) {
      const button = el('button', 'asset-tab'); button.type = 'button'; button.append(el('span', '', name), el('small'));
      button.addEventListener('click', () => { selectedCategory = name; render(); }); $('asset-tabs').append(button); categoryTabs.set(name, button);
    }
    const field = form.elements.category, previous = field.value;
    field.replaceChildren(...categories.map(name => { const option = el('option', '', name); option.value = name; return option; }));
    field.value = categories.includes(previous) ? previous : selectedCategory;
    for (const id of ['asset-upload', 'asset-add-board']) $(id).disabled = !categories.length;
  }
  function render() {
    for (const [name, button] of categoryTabs) { button.setAttribute('aria-pressed', String(selectedCategory === name)); button.querySelector('small').textContent = items.filter(item => item.category === name).length; }
    for (const [source, button] of sourceTabs) button.setAttribute('aria-pressed', String(selectedSource === source));
    const query = $('asset-search').value.trim().toLocaleLowerCase();
    const visible = items.filter(item => item.category === selectedCategory && (!selectedSource || item.kind === selectedSource) && `${item.title} ${item.project} ${item.tags.join(' ')} ${item.note}`.toLocaleLowerCase().includes(query));
    $('asset-count').textContent = `${visible.length} 项素材${selectedCategory ? ` · ${selectedCategory}` : ''}`;
    grid.replaceChildren();
    for (const item of visible) {
      const card = el('article', `asset-card ${item.kind === 'board' ? 'asset-board-card' : ''}`);
      const open = el('button', 'asset-card-image'); open.type = 'button'; open.setAttribute('aria-label', `${item.kind === 'board' ? '查看画板' : '放大查看'}：${item.title}`);
      if (item.kind === 'image') {
        const image = el('img'); image.src = item.thumbnailUrl; image.alt = item.title; image.loading = 'lazy'; image.decoding = 'async'; image.width = item.width; image.height = item.height;
        image.addEventListener('error', () => { image.hidden = true; open.append(el('span', 'asset-image-unavailable', '图片暂不可用')); }, { once: true });
        open.append(image);
      } else {
        const art = el('span', 'asset-board-art');
        art.append(el('span', 'asset-board-letter', 'P'), el('span', 'asset-board-label', 'PINTEREST BOARD'), el('strong', '', item.title), el('span', 'asset-board-open', '浏览收藏 ↗'));
        open.append(art);
      }
      open.append(el('span', 'asset-card-category', item.category)); open.addEventListener('click', () => openPreview(item));
      const info = el('div', 'asset-card-info'), heading = el('button', 'asset-card-title', item.title); heading.type = 'button'; heading.addEventListener('click', () => openPreview(item));
      const meta = el('p', 'asset-card-meta', `${item.project || item.category} · ${item.kind === 'board' ? 'Pinterest 画板' : '本地图片'}`);
      const tagList = el('div', 'asset-card-tags'); tags(tagList, item.tags.slice(0, 3)); info.append(heading, meta, tagList); card.append(open, info); grid.append(card);
    }
    $('asset-empty').hidden = visible.length > 0;
    $('asset-empty-title').textContent = !categories.length ? '先建立素材分类' : items.length ? '没有匹配的素材' : '从一张好图开始';
    $('asset-empty-copy').textContent = !categories.length ? canEdit ? '点击管理分类，添加你需要的素材分类。' : '管理员添加分类后，会展示在这里。' : items.length ? '试试其他分类、来源或关键词。' : canEdit ? '上传本地图片，或关联你的 Pinterest 画板。' : '管理员添加图片和画板后，会展示在这里。';
    $('asset-empty-upload').hidden = !canEdit || items.length > 0;
    $('asset-empty-upload').textContent = categories.length ? '上传第一张图片' : '新建素材分类';
  }
  async function load() {
    const sequence = ++loadSequence; grid.setAttribute('aria-busy', 'true');
    try {
      const result = await request('/api/assets');
      if (sequence !== loadSequence) return;
      items = result.items; categories = result.categories; renderCategoryTabs(); render(); return true;
    } catch (error) { if (sequence === loadSequence) notice(error.message, true); return false; }
    finally { if (sequence === loadSequence) grid.setAttribute('aria-busy', 'false'); }
  }
  for (const [name, source] of [['全部来源', ''], ['本地上传', 'image'], ['Pinterest', 'board']]) {
    const button = el('button', '', name); button.type = 'button'; button.addEventListener('click', () => { selectedSource = source; render(); });
    $('asset-sources').append(button); sourceTabs.set(source, button);
  }
  $('asset-search').addEventListener('input', render);
  function showEditor(kind, item = null) {
    if (!canEdit) return;
    if (!categories.length) { notice('请先在管理分类中新增一个分类。'); return; }
    editing = item; files = []; form.reset(); form.dataset.kind = kind;
    $('asset-editor-title').textContent = item ? '编辑素材' : kind === 'board' ? '关联 Pinterest 画板' : '上传图片';
    $('asset-drop').hidden = kind === 'board' || !!item;
    $('asset-board-field').hidden = kind !== 'board'; $('asset-board-hint').hidden = kind !== 'board';
    form.elements.boardUrl.required = kind === 'board'; form.elements.title.required = true;
    form.elements.category.value = selectedCategory || categories[0];
    for (const name of ['title', 'project', 'category', 'note', 'sourceUrl', 'boardUrl']) if (item && item[name] !== undefined) form.elements[name].value = item[name];
    form.elements.tags.value = item?.tags.join('，') || '';
    form.elements.title.placeholder = kind === 'board' ? '例如：现代住宅入口收藏' : '例如：石材柱廊入口';
    $('asset-editor-error').hidden = true; $('asset-file-selection').textContent = ''; $('asset-upload-progress').textContent = '';
    $('asset-files').value = ''; editor.showModal();
  }
  function chooseFiles(chosen) {
    if (saving) return;
    files = [...chosen];
    const invalid = files.find(file => file.size > 25 * 1024 * 1024 || !/\.(jpe?g|png|webp)$/i.test(file.name));
    $('asset-editor-error').hidden = !invalid;
    $('asset-editor-error').textContent = invalid ? `${invalid.name}：请选择不超过 25 MB 的 JPG、PNG 或 WebP 图片。` : '';
    if (invalid) { files = []; return; }
    $('asset-file-selection').textContent = files.length ? `已选择 ${files.length} 张 · ${files.slice(0, 3).map(file => file.name).join('、')}${files.length > 3 ? '…' : ''}` : '';
    form.elements.title.required = files.length <= 1;
    form.elements.title.value = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '').slice(0, 120) : '';
    form.elements.title.placeholder = files.length > 1 ? '留空则使用各图片文件名' : '例如：石材柱廊入口';
  }
  $('asset-files').addEventListener('change', event => chooseFiles(event.target.files));
  $('asset-drop').addEventListener('dragover', event => { event.preventDefault(); $('asset-drop').classList.add('is-dragging'); });
  $('asset-drop').addEventListener('dragleave', () => $('asset-drop').classList.remove('is-dragging'));
  $('asset-drop').addEventListener('drop', event => { event.preventDefault(); $('asset-drop').classList.remove('is-dragging'); chooseFiles(event.dataTransfer.files); });
  $('asset-upload').addEventListener('click', () => showEditor('image'));
  $('asset-empty-upload').addEventListener('click', () => { if (categories.length) showEditor('image'); else openCategories(); });
  $('asset-add-board').addEventListener('click', () => showEditor('board'));
  for (const dialog of [editor, preview, $('asset-trash-dialog'), $('asset-categories-dialog')]) {
    dialog.querySelectorAll('[data-asset-close]').forEach(button => button.addEventListener('click', () => { if (dialog !== editor || !saving) dialog.close(); }));
    dialog.addEventListener('cancel', event => { if (dialog === editor && saving) event.preventDefault(); });
    dialog.addEventListener('click', event => { if (event.target === dialog && !(dialog === editor && saving)) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return;
    if (!editing && form.dataset.kind === 'image' && !files.length) { $('asset-editor-error').textContent = '请先选择图片'; $('asset-editor-error').hidden = false; return; }
    const input = Object.fromEntries(new FormData(form));
    saving = true; form.querySelectorAll('button,input,select,textarea').forEach(node => { node.disabled = true; }); $('asset-editor-error').hidden = true;
    let completed = 0, total = files.length;
    try {
      if (editing) await request(`/api/assets/${editing.id}`, json('PATCH', input));
      else if (form.dataset.kind === 'board') await request('/api/assets', json('POST', input));
      else {
        while (files.length) {
          const file = files[0], title = input.title ? total > 1 ? `${input.title.slice(0, 110)} ${completed + 1}` : input.title : file.name.replace(/\.[^.]+$/, '').slice(0, 120);
          $('asset-upload-progress').textContent = `正在上传 ${completed + 1} / ${total} · ${file.name}`;
          const query = new URLSearchParams({ ...input, title, name: file.name, upload: '1' });
          await request(`/api/assets?${query}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
          files.shift(); completed++;
        }
      }
      editor.close(); selectedSource = ''; selectedCategory = input.category; $('asset-search').value = '';
      notice(editing ? '修改已保存。' : form.dataset.kind === 'board' ? '画板已关联。点击卡片可加载预览或前往 Pinterest。' : `已保存 ${completed} 张图片。`);
      await load();
    } catch (error) {
      $('asset-editor-error').textContent = `${error.message}${completed ? ` 已保存 ${completed} 张，重试将继续剩余图片。` : ''}`; $('asset-editor-error').hidden = false;
      if (completed) { $('asset-file-selection').textContent = `剩余 ${files.length} 张待上传`; await load(); }
    } finally { saving = false; form.querySelectorAll('button,input,select,textarea').forEach(node => { node.disabled = false; }); $('asset-upload-progress').textContent = ''; }
  });
  function openPreview(item) {
    selected = item;
    $('asset-preview-category').textContent = item.category; $('asset-preview-title').textContent = item.title;
    $('asset-preview-source').textContent = item.kind === 'board' ? 'PINTEREST / 画板' : 'LOCAL / 本地图片';
    $('asset-preview-project').textContent = item.project; $('asset-preview-note').textContent = item.note;
    tags($('asset-preview-tags'), item.tags); const stage = $('asset-preview-stage'); stage.replaceChildren();
    const links = $('asset-preview-links'); links.replaceChildren();
    if (item.kind === 'image') {
      const image = el('img'); image.src = item.imageUrl; image.alt = item.title; stage.append(image);
      links.append(link('下载原图 ↓', `${item.imageUrl}?download=1`));
    } else {
      const start = el('div', 'asset-board-intro'); start.append(el('span', 'asset-board-letter', 'P'), el('h3', '', item.title), el('p', '', '通过服务器代理加载 Pinterest 公开画板与图片。'));
      const load = el('button', 'archive-primary', '加载画板'); load.type = 'button';
      const status = el('p', 'asset-board-fallback', '如连接失败，可在“设置 → Pinterest 代理”检测连接。私密画板需前往原站查看。');
      load.addEventListener('click', async () => {
        load.disabled = true; load.textContent = '正在加载…'; status.textContent = '正在通过服务器代理读取画板…';
        try {
          const result = await request(`/api/assets/${item.id}/pinterest`);
          if (!preview.open || selected?.id !== item.id) return;
          const panel = el('div', 'asset-pinterest-panel'), toolbar = el('div', 'asset-pinterest-toolbar');
          toolbar.append(el('span', '', `服务器代理 · ${result.pins.length} 张预览图`));
          const retry = el('button', 'archive-text-button', '重新加载'); retry.type = 'button'; retry.addEventListener('click', () => { stage.replaceChildren(start); load.click(); }); toolbar.append(retry);
          const pictures = el('div', 'asset-pinterest-grid');
          for (const pin of result.pins) {
            const card = link(pin.title || '在 Pinterest 查看 ↗', pin.pinUrl); card.className = 'asset-pin';
            const image = el('img'); image.src = pin.imageUrl; image.alt = pin.title || 'Pinterest 收藏图片'; image.loading = 'lazy';
            image.addEventListener('error', () => { image.hidden = true; card.append(el('span', '', '图片加载失败，点击前往原站 ↗')); }, { once: true });
            card.replaceChildren(image); pictures.append(card);
          }
          if (!result.pins.length) pictures.append(el('p', 'archive-hint', '此画板暂时没有可显示的公开图片。'));
          panel.append(toolbar, pictures); stage.replaceChildren(panel);
        } catch (error) { if (preview.open && selected?.id === item.id) status.textContent = error.message; }
        finally { load.disabled = false; load.textContent = '重新加载画板'; }
      });
      start.append(load, status); stage.append(start);
      links.append(link('打开 Pinterest ↗', item.boardUrl));
    }
    if (item.sourceUrl && item.sourceUrl !== item.boardUrl) links.append(link('查看案例来源 ↗', item.sourceUrl));
    preview.showModal();
  }
  preview.addEventListener('close', () => { $('asset-preview-stage').replaceChildren(); selected = null; });
  $('asset-edit').addEventListener('click', () => { const item = selected; preview.close(); if (item) showEditor(item.kind, item); });
  $('asset-delete').addEventListener('click', async () => {
    if (!selected || !canEdit) return;
    const button = $('asset-delete'); button.disabled = true;
    try { await request(`/api/assets/${selected.id}`, { method: 'DELETE' }); preview.close(); notice('已移至回收站，可随时恢复。'); await load(); }
    catch (error) { notice(error.message, true); preview.close(); }
    finally { button.disabled = false; }
  });
  async function renderTrash() {
    const list = $('asset-trash-list'); list.replaceChildren(); $('asset-trash-error').hidden = true;
    try {
      const { items: deleted } = await request('/api/assets?deleted=true');
      if (!deleted.length) list.append(el('p', 'archive-hint', '回收站为空。'));
      for (const item of deleted) {
        const row = el('div', 'asset-trash-row'), copy = el('div'); copy.append(el('strong', '', item.title), el('small', '', `${item.category} · ${item.kind === 'board' ? 'Pinterest' : '本地图片'}`));
        const restore = el('button', 'archive-secondary', '恢复'); restore.type = 'button'; restore.addEventListener('click', async () => {
          restore.disabled = true;
          try { await request(`/api/assets/${item.id}/restore`, { method: 'POST' }); await renderTrash(); await load(); }
          catch (error) { $('asset-trash-error').textContent = error.message; $('asset-trash-error').hidden = false; restore.disabled = false; }
        }); row.append(copy, restore); list.append(row);
      }
    } catch (error) { $('asset-trash-error').textContent = error.message; $('asset-trash-error').hidden = false; }
  }
  $('asset-trash').addEventListener('click', () => { if (canEdit) { $('asset-trash-dialog').showModal(); renderTrash(); } });
  async function changeCategory(method, input) {
    if (managing) return false;
    const dialog = $('asset-categories-dialog'), error = $('asset-categories-error');
    managing = true; error.hidden = true;
    dialog.querySelectorAll('button,input,select').forEach(node => { node.disabled = true; });
    try {
      await request('/api/asset-categories', json(method, input));
      if (method === 'PATCH' && selectedCategory === input.name) selectedCategory = input.newName.trim();
      if (method === 'POST') selectedCategory = input.name.trim();
      if (method === 'DELETE' && selectedCategory === input.name) selectedCategory = input.targetCategory || '';
      if (!await load()) throw new Error('分类已保存，资料读取失败，请关闭后重试');
      $('asset-category-name').value = ''; renderCategories();
      notice(method === 'POST' ? '分类已添加。' : method === 'PATCH' ? '分类名称已修改。' : '分类已删除，关联素材已保留。');
      return true;
    } catch (failure) { error.textContent = failure.message; error.hidden = false; return false; }
    finally { managing = false; dialog.querySelectorAll('button,input,select').forEach(node => { node.disabled = false; }); }
  }
  function renderCategories() {
    const list = $('asset-categories-list'); list.replaceChildren();
    if (!categories.length) list.append(el('p', 'archive-hint', '还没有分类，可以在上方添加。'));
    for (const name of categories) {
      const row = el('div', 'asset-category-row'), rename = el('form', 'asset-category-rename');
      const input = el('input'); input.value = name; input.maxLength = 30; input.required = true; input.setAttribute('aria-label', `分类名称：${name}`);
      const save = el('button', 'archive-secondary', '保存名称'); save.type = 'submit';
      const remove = el('button', 'archive-text-button', '删除'); remove.type = 'button'; remove.setAttribute('aria-label', `删除分类：${name}`);
      rename.append(input, save, remove); rename.addEventListener('submit', event => { event.preventDefault(); changeCategory('PATCH', { name, newName: input.value }); });
      const deletion = el('form', 'asset-category-removal'); deletion.hidden = true;
      const label = el('label', '', '素材转移到'), target = el('select'); target.setAttribute('aria-label', `删除${name}后的转移分类`);
      const empty = el('option', '', '不转移（仅适用于空分类）'); empty.value = ''; target.append(empty);
      for (const other of categories.filter(entry => entry !== name)) { const option = el('option', '', other); option.value = other; target.append(option); }
      label.append(target);
      const confirm = el('button', 'archive-secondary', '确认删除分类'); confirm.type = 'submit';
      const cancel = el('button', 'archive-text-button', '取消'); cancel.type = 'button'; cancel.addEventListener('click', () => { deletion.hidden = true; remove.setAttribute('aria-expanded', 'false'); });
      remove.setAttribute('aria-expanded', 'false'); remove.addEventListener('click', () => { deletion.hidden = !deletion.hidden; remove.setAttribute('aria-expanded', String(!deletion.hidden)); if (!deletion.hidden) target.focus(); });
      deletion.append(label, confirm, cancel); deletion.addEventListener('submit', event => { event.preventDefault(); changeCategory('DELETE', { name, targetCategory: target.value }); });
      row.append(rename, deletion); list.append(row);
    }
  }
  function openCategories() { if (canEdit) { $('asset-categories-error').hidden = true; renderCategories(); $('asset-categories-dialog').showModal(); } }
  $('asset-manage-categories').addEventListener('click', openCategories);
  $('asset-category-add-form').addEventListener('submit', event => { event.preventDefault(); changeCategory('POST', { name: $('asset-category-name').value }); });
  render(); void load();
  return {
    async show(category = '', recordId = null) { view.hidden = false; if (category) selectedCategory = category; notice(''); if (await load() && recordId && !view.hidden) { const item = items.find(item => item.id === recordId); if (item) openPreview(item); } },
    hide() { view.hidden = true; },
    searchOptions() { return [...categories.map(name => ({ key: 'assets', title: name, subsection: name, group: '素材库' })), ...items.map(item => ({ key: 'assets', recordId: item.id, title: item.title, subsection: item.category, group: '素材库', searchText: `${item.title} ${item.project} ${item.tags.join(' ')}` }))]; }
  };
}
