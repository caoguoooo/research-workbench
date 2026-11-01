const $ = id => document.getElementById(id);
function el(tag, className = '', content) { const node = document.createElement(tag); node.className = className; if (content !== undefined) node.textContent = content; return node; }
function button(label, action, className = 'archive-text-button') { const node = el('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; }
function option(label, value) { const node = el('option', '', label); node.value = value; return node; }
function link(label, url, className = 'policy-link') { const node = el('a', className, label); node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node; }
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'X-Workbench-Request': '1', ...options.headers } });
  if (response.status === 401) { location.assign('/login'); throw new Error('登录已失效，请重新登录'); }
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作失败，请重试'); return result;
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function initPolicyLibrary({ canEdit = false } = {}) {
  const view = $('policy-view'), form = $('policy-form'), editor = $('policy-editor'), manager = $('policy-directory-dialog');
  let cities = [], items = [], cityId = '', typeId = '', selectedId = '', editingId = '', uploadQueue = [], saving = false, managing = false, sequence = 0;
  const expanded = new Set();
  const city = id => cities.find(entry => entry.id === id);
  const placementLabel = entry => `${city(entry.cityId)?.name || ''} / ${city(entry.cityId)?.types.find(type => type.id === entry.typeId)?.name || ''}`;
  function message(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
  function notice(text = '', error = false) { message('policy-notice', text); $('policy-notice').classList.toggle('is-error', error); }
  async function load() {
    const revision = ++sequence; view.setAttribute('aria-busy', 'true');
    try { const result = await request('/api/policies'); if (revision !== sequence) return false; cities = result.cities; items = result.items; render(); return true; }
    catch (error) { if (revision === sequence) notice(error.message, true); return false; }
    finally { if (revision === sequence) view.setAttribute('aria-busy', 'false'); }
  }
  function visible(item) {
    const query = $('policy-search').value.trim().toLocaleLowerCase(), status = $('policy-status-filter').value;
    return item.placements.some(entry => entry.cityId === cityId && (!typeId || entry.typeId === typeId)) && (!status || item.status === status) && (!query || `${item.title} ${item.number} ${item.issuer} ${item.keywords.join(' ')} ${item.note}`.toLocaleLowerCase().includes(query));
  }
  function choose(nextCity, nextType = '') { cityId = nextCity; typeId = nextType; selectedId = ''; expanded.add(cityId); render(); }
  function renderTree() {
    const tree = $('policy-tree'); tree.replaceChildren();
    for (const entry of cities) {
      const group = el('details', 'policy-city'); group.open = expanded.has(entry.id) || entry.id === cityId;
      group.addEventListener('toggle', () => group.open ? expanded.add(entry.id) : expanded.delete(entry.id));
      const summary = el('summary'); summary.append(el('span', '', entry.name), el('small', '', items.filter(item => item.placements.some(place => place.cityId === entry.id)).length)); group.append(summary);
      const all = button('城市文件', () => choose(entry.id), 'policy-type'); all.setAttribute('aria-pressed', String(cityId === entry.id && !typeId)); group.append(all);
      for (const type of entry.types) {
        const row = button('', () => choose(entry.id, type.id), 'policy-type'); row.append(el('span', '', type.name), el('small', '', items.filter(item => item.placements.some(place => place.typeId === type.id)).length)); row.setAttribute('aria-pressed', String(typeId === type.id)); group.append(row);
      }
      tree.append(group);
    }
    if (!cities.length) tree.append(el('p', 'archive-hint', '暂无城市目录'));
  }
  function badge(status) { return el('span', `policy-status policy-status-${{ '现行': 'current', '已废止': 'retired', '待核实': 'pending' }[status]}`, status); }
  function render() {
    if (!city(cityId)) { cityId = cities[0]?.id || ''; typeId = ''; }
    if (typeId && !city(cityId)?.types.some(type => type.id === typeId)) typeId = '';
    renderTree(); $('policy-add').disabled = !cities.some(entry => entry.types.length);
    $('policy-breadcrumb').textContent = typeId ? placementLabel({ cityId, typeId }) : city(cityId)?.name || '政策规范';
    const records = items.filter(visible); $('policy-count').textContent = `${records.length} 份文件`;
    const list = $('policy-list'), detail = $('policy-detail'), selected = items.find(item => item.id === selectedId);
    list.hidden = !!selected; detail.hidden = !selected;
    if (selected) { renderDetail(selected); return; }
    selectedId = ''; list.replaceChildren();
    for (const item of records) {
      const row = button('', () => { selectedId = item.id; render(); }, 'policy-document');
      const mark = el('span', 'policy-document-icon', item.files.some(file => file.type === 'application/pdf') ? 'PDF' : 'DOC'); mark.setAttribute('aria-hidden', 'true');
      const body = el('span', 'policy-document-body'); body.append(el('strong', '', item.title), el('small', '', [item.number, item.issuer, item.publishedAt].filter(Boolean).join(' · ') || '文件信息待补充'));
      const end = el('span', 'policy-document-end'); end.append(badge(item.status), el('small', '', item.files.length ? `${item.files.length} 个附件` : '未上传原文')); row.append(mark, body, end); list.append(row);
    }
    if (!records.length) { const empty = el('div', 'policy-empty'); empty.append(el('span', 'detail-index', 'DOCUMENTS'), el('h2', '', $('policy-search').value || $('policy-status-filter').value ? '没有匹配的文件' : '尚未归档文件'), el('p', '', canEdit ? '选择城市与规范种类，添加原文和文件信息。' : '文件归档后将在这里显示。')); if (canEdit) empty.append(button('添加文件 ＋', () => openEditor(), 'archive-secondary')); list.append(empty); }
  }
  function renderDetail(item) {
    const detail = $('policy-detail'); detail.replaceChildren(); detail.append(button('← 文件列表', () => { selectedId = ''; render(); }));
    const heading = el('div', 'policy-detail-heading'), title = el('div'); title.append(badge(item.status), el('h2', '', item.title)); heading.append(title);
    if (canEdit) { const actions = el('div', 'asset-actions'); actions.append(button('编辑', () => openEditor(item), 'archive-secondary'), button('移至回收站', async () => {
      try { await request(`/api/policies/${item.id}`, { method: 'DELETE' }); selectedId = ''; notice('已移至回收站。'); await load(); } catch (error) { notice(error.message, true); }
    })); heading.append(actions); } detail.append(heading);
    const facts = el('dl', 'policy-facts');
    for (const [label, value] of [['文号', item.number], ['发布单位', item.issuer], ['发布日期', item.publishedAt], ['实施日期', item.effectiveAt]]) { const cell = el('div'); cell.append(el('dt', '', label), el('dd', '', value || '—')); facts.append(cell); } detail.append(facts);
    const places = el('div', 'policy-detail-section'); places.append(el('h3', '', '适用目录')); const chips = el('div', 'policy-tags');
    for (const placement of item.placements) chips.append(button(placementLabel(placement), () => { cityId = placement.cityId; typeId = placement.typeId; expanded.add(cityId); render(); }, 'policy-placement-chip')); places.append(chips); detail.append(places);
    if (item.sourceUrl) { const source = el('div', 'policy-detail-section'); source.append(el('h3', '', '来源网址'), link('打开原始来源 ↗', item.sourceUrl)); detail.append(source); }
    if (item.keywords.length) { const tags = el('div', 'policy-tags'); item.keywords.forEach(tag => tags.append(el('span', 'asset-tag', tag))); detail.append(tags); }
    if (item.note) { const notes = el('section', 'policy-detail-section'); notes.append(el('h3', '', '备注 / 要点'), el('p', 'policy-note', item.note)); detail.append(notes); }
    const old = items.find(entry => entry.id === item.replacesId), newer = items.filter(entry => entry.replacesId === item.id);
    if (old || newer.length || item.replacesId) {
      const versions = el('section', 'policy-detail-section'); versions.append(el('h3', '', '版本关联'));
      if (old) versions.append(button(`替代：${old.title} ↗`, () => { selectedId = old.id; render(); }, 'policy-version-link'));
      else if (item.replacesId) versions.append(el('p', 'archive-hint', '关联的旧版本已移至回收站'));
      newer.forEach(entry => versions.append(button(`后续版本：${entry.title} ↗`, () => { selectedId = entry.id; render(); }, 'policy-version-link'))); detail.append(versions);
    }
    const files = el('section', 'policy-detail-section'); files.append(el('h3', '', '原文与附件'));
    for (const file of item.files) {
      const row = el('div', 'policy-file-row'), info = el('div'); info.append(el('strong', '', file.name), el('small', '', `${(file.size / 1024 / 1024).toFixed(2)} MB`)); const actions = el('div', 'asset-actions');
      if (file.type === 'application/pdf' || file.type.startsWith('image/')) actions.append(link('预览 ↗', file.url));
      actions.append(link('下载', `${file.url}?download=1`));
      if (canEdit) actions.append(button('移除', async () => { try { const result = await request(file.url, { method: 'DELETE' }); items = items.map(entry => entry.id === item.id ? result.item : entry); render(); notice('附件已移除，原件仍保留在资料目录中。'); } catch (error) { notice(error.message, true); } }));
      row.append(info, actions); files.append(row);
    }
    if (!item.files.length) files.append(el('p', 'archive-hint', '暂无原文附件')); if (canEdit) files.append(button('上传附件 ＋', () => { openEditor(item); $('policy-upload-files').focus(); }, 'archive-secondary')); detail.append(files);
  }
  function addPlacement(placement = {}) {
    const row = el('div', 'policy-placement-row'), citiesSelect = el('select'), typesSelect = el('select'); citiesSelect.setAttribute('aria-label', '归属城市'); typesSelect.setAttribute('aria-label', '规范种类'); citiesSelect.required = true; typesSelect.required = true;
    citiesSelect.append(...cities.map(entry => option(entry.name, entry.id))); citiesSelect.value = city(placement.cityId)?.id || cityId || cities[0]?.id || '';
    const refresh = preferred => { typesSelect.replaceChildren(...(city(citiesSelect.value)?.types || []).map(type => option(type.name, type.id))); if (preferred && [...typesSelect.options].some(entry => entry.value === preferred)) typesSelect.value = preferred; };
    refresh(placement.typeId); citiesSelect.addEventListener('change', () => refresh());
    const cityLabel = el('label', 'archive-field', '城市'); cityLabel.append(citiesSelect); const typeLabel = el('label', 'archive-field', '规范种类'); typeLabel.append(typesSelect);
    row.append(cityLabel, typeLabel, button('移除', () => { if ($('policy-placements').children.length > 1) row.remove(); else message('policy-editor-error', '至少保留一个归属目录。'); })); $('policy-placements').append(row);
  }
  function openEditor(item) {
    if (!canEdit) return;
    if (!cities.some(entry => entry.types.length)) { notice('请先在管理目录中添加城市和规范种类。'); return; }
    form.reset(); editingId = item?.id || ''; uploadQueue = []; message('policy-editor-error'); message('policy-save-progress'); $('policy-editor-title').textContent = item ? '编辑文件' : '添加文件';
    for (const key of ['title', 'number', 'issuer', 'publishedAt', 'effectiveAt', 'status', 'sourceUrl', 'note']) form.elements[key].value = item?.[key] || (key === 'status' ? '待核实' : '');
    form.elements.keywords.value = item?.keywords.join('，') || '';
    form.elements.replacesId.replaceChildren(option('无', ''), ...items.filter(entry => entry.id !== item?.id).map(entry => option(entry.title, entry.id))); if (item?.replacesId && !items.some(entry => entry.id === item.replacesId)) form.elements.replacesId.append(option('旧版本（回收站）', item.replacesId)); form.elements.replacesId.value = item?.replacesId || '';
    $('policy-placements').replaceChildren(); (item?.placements || [{ cityId, typeId }]).forEach(addPlacement); editor.showModal();
  }
  $('policy-add-placement').addEventListener('click', () => { if ($('policy-placements').children.length < 30) addPlacement(); else message('policy-editor-error', '最多关联 30 个目录。'); });
  $('policy-upload-files').addEventListener('change', event => { uploadQueue = [...event.target.files]; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!canEdit || saving) return; message('policy-editor-error');
    if (uploadQueue.some(file => file.size > 25 * 1024 * 1024)) { message('policy-editor-error', '单个文件不能超过 25 MB。'); return; }
    const input = Object.fromEntries(new FormData(form)); input.placements = [...$('policy-placements').children].map(row => { const [city, type] = row.querySelectorAll('select'); return { cityId: city.value, typeId: type.value }; });
    saving = true; [...form.elements].forEach(node => { node.disabled = true; });
    let saved = false;
    try {
      const result = await request(editingId ? `/api/policies/${editingId}` : '/api/policies', json(editingId ? 'PATCH' : 'POST', input)); editingId = result.item.id; selectedId = editingId; saved = true;
      while (uploadQueue.length) { const file = uploadQueue[0]; message('policy-save-progress', `正在上传：${file.name}`); await request(`/api/policies/${editingId}/files?${new URLSearchParams({ name: file.name })}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }); uploadQueue.shift(); }
      cityId = input.placements[0].cityId; typeId = input.placements[0].typeId; editor.close(); notice('文件已归档。');
    } catch (error) { message('policy-editor-error', `${saved ? '文件信息已保存，尚未成功上传的附件可重试。' : ''}${error.message}`); }
    finally { saving = false; [...form.elements].forEach(node => { node.disabled = false; }); message('policy-save-progress'); await load(); }
  });
  function renderManager() {
    const field = $('policy-managed-city'), previous = field.value; field.replaceChildren(...cities.map(entry => option(entry.name, entry.id))); field.value = city(previous)?.id || cityId || cities[0]?.id || '';
    const entry = city(field.value); $('policy-city-edit').replaceChildren(); $('policy-type-rows').replaceChildren(); $('policy-type-add').hidden = !entry;
    if (!entry) return;
    function row(value, kind) {
      const container = el('form', 'policy-directory-row'), input = el('input'); input.value = value.name; input.maxLength = 40; input.required = true; input.setAttribute('aria-label', kind === 'City' ? '修改城市名称' : '修改规范种类名称');
      const save = el('button', 'archive-secondary', '保存名称'); save.type = 'submit'; container.append(input, save, button('删除', () => directoryChange({ action: `delete${kind}`, cityId: entry.id, ...(kind === 'Type' ? { typeId: value.id } : {}) })));
      container.addEventListener('submit', event => { event.preventDefault(); void directoryChange({ action: `rename${kind}`, name: input.value, cityId: entry.id, ...(kind === 'Type' ? { typeId: value.id } : {}) }); }); return container;
    }
    $('policy-city-edit').append(row(entry, 'City')); for (const type of entry.types) $('policy-type-rows').append(row(type, 'Type'));
  }
  async function directoryChange(input) {
    if (!canEdit || managing) return; managing = true; message('policy-directory-error'); manager.querySelectorAll('button,input,select').forEach(node => { node.disabled = true; });
    try { const result = await request('/api/policy-directory', json('POST', input)); cities = result.cities; $('policy-city-name').value = ''; $('policy-type-name').value = ''; render(); renderManager(); }
    catch (error) { message('policy-directory-error', error.message); }
    finally { managing = false; manager.querySelectorAll('button,input,select').forEach(node => { node.disabled = false; }); }
  }
  async function renderTrash() {
    message('policy-trash-error');
    try { const result = await request('/api/policies?deleted=true'); const list = $('policy-trash-list'); list.replaceChildren();
      for (const item of result.items) { const row = el('div', 'asset-trash-row'); row.append(el('strong', '', item.title), button('恢复', async () => { try { await request(`/api/policies/${item.id}/restore`, { method: 'POST' }); await load(); await renderTrash(); } catch (error) { message('policy-trash-error', error.message); } }, 'archive-secondary')); list.append(row); }
      if (!result.items.length) list.append(el('p', 'archive-hint', '回收站为空'));
    } catch (error) { message('policy-trash-error', error.message); }
  }
  $('policy-manage').addEventListener('click', () => { if (canEdit) { message('policy-directory-error'); renderManager(); manager.showModal(); } });
  $('policy-managed-city').addEventListener('change', renderManager);
  $('policy-city-add').addEventListener('submit', event => { event.preventDefault(); void directoryChange({ action: 'addCity', name: $('policy-city-name').value }); });
  $('policy-type-add').addEventListener('submit', event => { event.preventDefault(); void directoryChange({ action: 'addType', cityId: $('policy-managed-city').value, name: $('policy-type-name').value }); });
  $('policy-trash').addEventListener('click', () => { if (canEdit) { $('policy-trash-dialog').showModal(); void renderTrash(); } });
  $('policy-add').addEventListener('click', () => openEditor());
  for (const id of ['policy-search', 'policy-status-filter']) $(id).addEventListener(id.endsWith('filter') ? 'change' : 'input', () => { selectedId = ''; render(); });
  document.querySelectorAll('[data-policy-close]').forEach(node => node.addEventListener('click', () => { if (!saving && !managing) node.closest('dialog').close(); }));
  editor.addEventListener('cancel', event => { if (saving) event.preventDefault(); }); manager.addEventListener('cancel', event => { if (managing) event.preventDefault(); });
  void load();
  return {
    async show(subsection = '', recordId = '') { view.hidden = false; notice(); if (await load() && recordId && !view.hidden) { const item = items.find(entry => entry.id === recordId); if (item) { $('policy-search').value = ''; $('policy-status-filter').value = ''; cityId = item.placements[0].cityId; typeId = item.placements[0].typeId; selectedId = item.id; expanded.add(cityId); render(); } } },
    hide() { view.hidden = true; },
    searchOptions() { return items.map(item => ({ key: 'policy', title: item.title, recordId: item.id, group: '政策规范', searchText: `${item.title} ${item.number} ${item.issuer} ${item.keywords.join(' ')} ${item.placements.map(placementLabel).join(' ')}` })); }
  };
}
