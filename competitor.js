import { BASIC_INFO_FIELDS, inferredBasicInfo } from './project-details.js';
import { initAmenities } from './amenities.js';

const $ = id => document.getElementById(id);

function element(tag, className = '', content = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = content;
  return node;
}

function display(value, fallback = '待补充') {
  return value?.trim() || fallback;
}

function cleanDisplayText(value = '') {
  return String(value)
    .replace(/^\s*(?:公开资料整理(?:时间)?|资料整理时间)\s*[·：:]?[^\n]*$/gm, '')
    .replace(/[（(][^（）()\n]*(?:公开资料|公开地址|门户待核实|实际待核实|公开页标注)[^（）()\n]*[）)]/g, '')
    .replace(/公开页(?:面)?标注(?:为)?/g, '')
    .replace(/\s*[·；;，,]?\s*实际待核实/g, '')
    .replace(/\s*·\s*公开竞品资料/g, '')
    .replace(/公开宣传图，带家具布置[；。]?/g, '')
    .replace(/房型和面积以该图及对应来源为参考，适用分期\/楼栋、可变空间及交付标准待核实[。]?/g, '')
    .replace(/本次为公开网络资料整理，不生成实地踩盘记录[；。]?/g, '')
    .replace(/宣传图不代表已核验报批图纸，当前可售房源及实际价格需更新核实[。]?/g, '')
    .replace(/公开资料有该户型，但暂未找到符合要求的带家具布置宣传原图；墙线图和平台测绘图已排除，待补原图[。]?/g, '待补户型图。')
    .replace(/^[ \t]*[•；。]+[ \t]*$/gm, '')
    .replace(/待核实：[；。\s]*(?=\n|$)/g, '')
    .replace(/[ \t]*[·；][ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function renderLinkedText(container, text) {
  container.replaceChildren();
  let offset = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'，。；、！？（）]+/g)) {
    const url = match[0].replace(/[.,;!?)\]}]+$/, '');
    container.append(document.createTextNode(text.slice(offset, match.index)));
    const link = element('a', 'archive-inline-link', url);
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    container.append(link);
    offset = match.index + url.length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

function fileSize(size) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...options.headers, 'X-Workbench-Request': '1' } });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace('/login?expired=1');
    throw new Error('登录已失效，请重新登录');
  }
  if (!response.ok) throw new Error(result.error || '操作失败，请重试');
  return result;
}

function formValues(form) {
  return Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, String(value).trim()]));
}

function setFormValues(form, values) {
  for (const field of form.elements) {
    if (field.tagName === 'SELECT' && values[field.name] && ![...field.options].some(option => option.value === values[field.name])) field.add(new Option(cleanDisplayText(values[field.name]), values[field.name]));
    if (field.name) field.value = values[field.name] || '';
  }
}

function showError(id, message) {
  const node = $(id);
  node.textContent = message;
  node.hidden = !message;
}

const CHONGQING_COUNTIES = ['江津', '璧山', '永川', '合川', '长寿', '綦江', '万盛', '大足', '铜梁', '潼南', '荣昌', '涪陵', '南川', '万州', '开州', '梁平', '黔江', '武隆', '垫江', '丰都', '忠县', '云阳', '奉节', '巫山', '巫溪', '城口', '石柱', '秀山', '酉阳', '彭水'];

function cityLabel(value, district = '') {
  const city = String(value || '').trim().replace(/市$/, '');
  if (city !== '重庆') return city || '未分类';
  const area = String(district || '').trim().replace(/^重庆市?\s*/, '');
  const county = CHONGQING_COUNTIES.some(name => new RegExp(`^${name}(?:区|县|土家族苗族自治县|土家族自治县|苗族土家族自治县)?(?:$|[\s·/、，,]|[（(])`).test(area));
  return county ? '重庆区县' : '重庆主城';
}

function districtLabel(value) {
  return cleanDisplayText(value).replace(/\s+/g, ' ').trim() || '未划分区位';
}

function districtKey(city, district) {
  return JSON.stringify([city, district]);
}

export function groupCompetitorsByDistrict(records) {
  const districts = new Map();
  for (const item of records) {
    const district = districtLabel(item.district);
    if (!districts.has(district)) districts.set(district, []);
    districts.get(district).push(item);
  }
  return [...districts].map(([district, items]) => ({ district, items })).sort((a, b) => {
    if (a.items.length !== b.items.length) return b.items.length - a.items.length;
    if (a.district === '未划分区位') return b.district === '未划分区位' ? 0 : 1;
    if (b.district === '未划分区位') return -1;
    return a.district.localeCompare(b.district, 'zh-CN');
  });
}

export function groupCompetitorsByCity(records, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  const cities = new Map();
  for (const item of records) {
    const city = cityLabel(item.city, item.district);
    if (needle && ![item.name, item.city, city, item.district, item.developer].join(' ').toLocaleLowerCase().includes(needle)) continue;
    if (!cities.has(city)) cities.set(city, []);
    cities.get(city).push(item);
  }
  return [...cities].map(([city, items]) => ({ city, items })).sort((a, b) => {
    if (a.city.startsWith('重庆') && b.city.startsWith('重庆') && a.city !== b.city) return a.city === '重庆主城' ? -1 : b.city === '重庆主城' ? 1 : a.city.localeCompare(b.city, 'zh-CN');
    if (a.city === '未分类') return b.city === '未分类' ? 0 : 1;
    if (b.city === '未分类') return -1;
    return a.city.localeCompare(b.city, 'zh-CN');
  });
}

export function initCompetitorArchive(onBack, { canEdit = true } = {}) {
  const view = $('competitor-view');
  const list = $('competitor-list');
  const empty = $('competitor-empty');
  const detail = $('competitor-detail');
  const search = $('competitor-search');
  const projectDialog = $('competitor-dialog');
  const projectForm = $('competitor-form');
  const floorplanDialog = $('floorplan-dialog');
  const floorplanForm = $('floorplan-form');
  const visualInput = $('visual-file-input');
  const imageViewer = $('archive-image-viewer');
  const fullImage = $('archive-image-full');
  const deleteDialog = $('delete-competitor-dialog');
  const trashDialog = $('competitor-trash-dialog');
  const researchDialog = $('competitor-research-dialog');
  const researchForm = $('competitor-research-form');
  let editingResearch = null;
  let records = [];
  let selectedId = null;
  let pendingSection = '';
  let pendingVisual = null;
  const collapsedCities = new Set();
  const collapsedDistricts = new Set();

  const amenitiesView = initAmenities({ request, onSaved: async () => { await load(); setStatus('周边配套已保存'); } });

  function selected() {
    return records.find(item => item.id === selectedId);
  }

  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const groups = groupCompetitorsByCity(records, query);
    const count = groups.reduce((total, group) => total + group.items.length, 0);
    $('competitor-count').textContent = `${groups.length} 个分类 · ${count} 个竞品${query ? '符合搜索' : ''}`;
    list.replaceChildren();
    if (!count) {
      list.append(element('p', 'archive-list-empty', query ? '没有匹配的竞品' : '还没有竞品档案'));
      return;
    }
    for (const group of groups) {
      const cityGroup = element('details', 'archive-city-group');
      cityGroup.open = !!query || !collapsedCities.has(group.city);
      const heading = element('summary', 'archive-city-heading');
      heading.append(element('span', 'archive-city-name', group.city), element('span', 'archive-city-count', `${group.items.length}`));
      const projects = element('div', 'archive-city-projects');
      cityGroup.append(heading, projects);
      cityGroup.addEventListener('toggle', () => {
        if (!cityGroup.isConnected || query) return;
        if (cityGroup.open) collapsedCities.delete(group.city);
        else collapsedCities.add(group.city);
      });
      list.append(cityGroup);
      for (const district of groupCompetitorsByDistrict(group.items)) {
        const key = districtKey(group.city, district.district);
        const districtGroup = element('details', 'archive-district-group');
        districtGroup.open = !!query || !collapsedDistricts.has(key);
        const districtHeading = element('summary', 'archive-district-heading');
        districtHeading.append(element('span', 'archive-district-name', district.district), element('span', 'archive-district-count', `${district.items.length}`));
        const districtProjects = element('div', 'archive-district-projects');
        districtGroup.append(districtHeading, districtProjects);
        districtGroup.addEventListener('toggle', () => {
          if (!districtGroup.isConnected || query) return;
          if (districtGroup.open) collapsedDistricts.delete(key);
          else collapsedDistricts.add(key);
        });
        projects.append(districtGroup);
        for (const item of district.items) {
          const button = element('button', `archive-list-item${item.id === selectedId ? ' is-selected' : ''}`);
          button.type = 'button';
          button.append(element('strong', '', item.name));
          button.addEventListener('click', () => select(item.id));
          const row = element('div', 'archive-list-row');
          const remove = element('button', 'archive-list-delete', '删除');
          remove.type = 'button';
          remove.setAttribute('aria-label', `删除${item.name}档案`);
          remove.addEventListener('click', () => openDeleteDialog(item));
          row.append(button);
          if (canEdit) row.append(remove);
          districtProjects.append(row);
        }
      }
    }
  }

  function addFact(label, value) {
    const pair = element('div', 'archive-fact');
    pair.append(element('dt', '', label), element('dd', '', display(value)));
    $('competitor-facts').append(pair);
  }

  function fileUrl(item, file) {
    return `/api/competitors/${encodeURIComponent(item.id)}/files/${encodeURIComponent(file.id)}`;
  }

  function previewImage(item, file, label = file.name) {
    $('archive-image-title').textContent = label;
    fullImage.alt = label;
    fullImage.hidden = false;
    $('archive-image-error').hidden = true;
    fullImage.src = fileUrl(item, file);
    imageViewer.showModal();
    document.body.classList.add('image-preview-open');
  }

  $('archive-image-close').addEventListener('click', () => imageViewer.close());
  imageViewer.addEventListener('click', event => {
    if (event.target === imageViewer || event.target.classList.contains('archive-image-stage')) imageViewer.close();
  });
  imageViewer.addEventListener('close', () => {
    document.body.classList.remove('image-preview-open');
    fullImage.removeAttribute('src');
  });
  fullImage.addEventListener('error', () => {
    if (!imageViewer.open || !fullImage.hasAttribute('src')) return;
    fullImage.hidden = true;
    $('archive-image-error').hidden = false;
  });

  function chooseVisual(category, slotId = '', replaceId = '') {
    if (!selected()) return;
    pendingVisual = { competitorId: selectedId, category, slotId, replaceId };
    showError('visual-error', '');
    visualInput.value = '';
    visualInput.click();
  }

  async function deleteRendering(item, file) {
    if (!canEdit || !window.confirm('删除这张效果图？')) return;
    try {
      await request(`/api/competitors/${item.id}/files/${file.id}`, { method: 'DELETE' });
      await load();
    } catch (error) { showError('visual-error', error.message); }
  }

  function visualCard(item, file, label, kind, index, actions = []) {
    const card = element('article', `archive-visual-card archive-visual-${kind}`);
    const frame = element('div', 'archive-visual-frame');
    if (file && file.type?.startsWith('image/')) {
      const image = element('img', 'archive-visual-image');
      image.src = fileUrl(item, file);
      image.alt = label;
      image.loading = 'lazy';
      const preview = element('button', 'archive-image-trigger');
      preview.type = 'button';
      preview.setAttribute('aria-label', `放大查看${label}`);
      preview.append(image);
      preview.addEventListener('click', () => previewImage(item, file, label));
      frame.append(preview);
    } else {
      const placeholder = element('div', 'archive-visual-placeholder');
      placeholder.append(element('span', 'archive-visual-number', index), element('span', 'archive-visual-caption', file ? 'PDF / FILE' : 'IMAGE PLACEHOLDER'));
      frame.append(placeholder);
    }
    if (file) {
      const open = element('a', 'archive-visual-open', '查看原文件 ↗');
      open.href = fileUrl(item, file);
      open.target = '_blank';
      open.rel = 'noopener';
      frame.append(open);
    }
    card.append(frame);
    const footer = element('div', 'archive-visual-footer');
    const info = element('div', 'archive-visual-info');
    info.append(element('strong', '', label));
    if (file?.sourceUrl) {
      const source = element('a','','图片来源 ↗');
      source.href = file.sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer';
      info.append(source);
    }
    footer.append(info);
    if (canEdit && actions.length) {
      const controls = element('div', 'archive-visual-actions');
      for (const [text, action] of actions) {
        const button = element('button', 'archive-text-button', text);
        button.type = 'button';
        button.addEventListener('click', action);
        controls.append(button);
      }
      footer.append(controls);
    }
    card.append(footer);
    return card;
  }

  function renderVisuals(item) {
    const masterplan = [...item.files].reverse().find(file => file.category === '总规划' && file.slotId === 'masterplan');
    $('masterplan-card').replaceChildren(visualCard(item, masterplan, '总规划', 'masterplan', '01', [[masterplan ? '替换' : '上传', () => chooseVisual('总规划', 'masterplan')]]));

    const renderings = item.files.filter(file => file.category === '效果图').slice(0, 6);
    $('upload-rendering').disabled = renderings.length >= 6;
    $('upload-rendering').textContent = renderings.length >= 6 ? '已达 6 张' : `添加效果图 +（${renderings.length}/6）`;
    const renderingGrid = $('rendering-grid');
    renderingGrid.replaceChildren();
    for (let index = 0; index < Math.max(3, renderings.length); index += 1) {
      const file = renderings[index];
      renderingGrid.append(visualCard(item, file, `效果图 ${String(index + 1).padStart(2, '0')}`, 'rendering', String(index + 1).padStart(2, '0'), file ? [['修改', () => chooseVisual('效果图', '', file.id)], ['删除', () => deleteRendering(item, file)]] : [['上传', () => chooseVisual('效果图')]]));
    }

    const floorplanGrid = $('floorplan-grid');
    floorplanGrid.replaceChildren();
    for (const [index, slot] of item.floorplans.entries()) {
      const file = [...item.files].reverse().find(entry => entry.category === '户型图' && entry.slotId === slot.id);
      const card = visualCard(item, file, slot.label, 'floorplan', String(index + 1).padStart(2, '0'), [
        ['编辑', () => openFloorplanDialog(slot)],
        [file ? '替换图纸' : '上传图纸', () => chooseVisual('户型图', slot.id)]
      ]);
      const details = [slot.area, slot.rooms].filter(Boolean).join(' · ');
      const notes = cleanDisplayText(slot.notes || '');
      if (details || notes) {
        const meta = element('p', 'archive-floorplan-meta', [details, notes].filter(Boolean).join(' · '));
        card.append(meta);
      }
      floorplanGrid.append(card);
    }
  }

  function renderFiles(item) {
    const container = $('file-list');
    container.replaceChildren();
    const visitSelect = $('file-visit');
    const previousVisit = visitSelect.value;
    visitSelect.replaceChildren(new Option('不关联踩盘', ''));
    for (const visit of [...item.visits].sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))) {
      visitSelect.add(new Option(`踩盘 · ${visit.visitedAt}`, visit.id));
    }
    visitSelect.value = item.visits.some(visit => visit.id === previousVisit) ? previousVisit : '';
    if (!item.files.length) {
      container.append(element('p', 'archive-section-empty', '暂无附件'));
      return;
    }
    for (const file of [...item.files].reverse()) {
      const row = element('a', 'archive-file-row');
      row.href = fileUrl(item, file);
      row.target = '_blank';
      row.rel = 'noopener';
      if (file.type?.startsWith('image/')) {
        const image = element('img', 'archive-file-thumb');
        image.src = row.href;
        image.alt = '';
        image.loading = 'lazy';
        row.append(image);
        row.addEventListener('click', event => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          previewImage(item, file);
        });
      } else row.append(element('span', 'archive-file-icon', '↗'));
      const info = element('span', 'archive-file-info');
      const linkedVisit = item.visits.find(visit => visit.id === file.visitId);
      const floorplan = item.floorplans.find(slot => slot.id === file.slotId);
      info.append(element('strong', '', file.name), element('small', '', `${file.category}${floorplan ? ` / ${floorplan.label}` : ''} · ${fileSize(file.size)} · ${linkedVisit ? `踩盘 ${linkedVisit.visitedAt} · ` : ''}${file.uploadedAt.slice(0, 10)}`));
      row.append(info, element('span', 'archive-file-open', file.type?.startsWith('image/') ? '放大查看' : '打开 ↗'));
      container.append(row);
    }
  }

  function renderDetail() {
    const item = selected();
    empty.hidden = !!item;
    detail.hidden = !item;
    if (!item) {
      empty.querySelector('h2').textContent = records.length ? '选择一份竞品档案' : '从第一份竞品档案开始';
      empty.querySelector('p').textContent = records.length ? '左侧列出了已归档的楼盘。' : '建立楼盘概况后，可持续添加踩盘记录和原始资料。';
      return;
    }
    const overview = $('competitor-overview');
    if (overview.dataset.projectId !== item.id) overview.open = false;
    overview.dataset.projectId = item.id;
    $('competitor-name').textContent = item.name;
    $('competitor-location').textContent = [item.city, item.district, item.address].map(value => cleanDisplayText(value || '')).filter(Boolean).join(' · ');
    $('competitor-facts').replaceChildren();
    const info = inferredBasicInfo(item);
    addFact('主力户型', info.primaryLayouts);
    addFact('装修状况', info.decoration);
    addFact('项目特色', info.features);
    addFact('项目地址', cleanDisplayText(item.address || ''));
    addFact('开发商', item.developer);
    addFact('开盘时间', info.openingDate);
    addFact('容积率', info.plotRatio);
    addFact('绿化率', info.greenRate);
    addFact('交房时间', info.deliveryDate);
    addFact('销售状态', cleanDisplayText(item.status || ''));
    addFact('项目定位', cleanDisplayText(item.positioning || ''));
    renderLinkedText($('competitor-summary'), display(cleanDisplayText(item.summary || ''), '暂无项目概况'));
    const research = item.aiResearch;
    const researchView = $('competitor-ai-research');
    if (researchView.dataset.projectId !== item.id) researchView.open = false;
    researchView.dataset.projectId = item.id;
    renderLinkedText($('competitor-ai-report'), cleanDisplayText(research?.report || '') || '暂无研究资料');
    const attachments = $('competitor-files');
    if (attachments.dataset.projectId !== item.id) attachments.open = false;
    attachments.dataset.projectId = item.id;
    const sourceList = $('competitor-ai-sources');
    sourceList.replaceChildren();
    for (const source of research?.sources || []) {
      const li = element('li');
      const link = element('a', '', source.title);
      link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      li.append(link); sourceList.append(li);
    }
    for (const source of research?.imageSources || []) {
      const li = element('li');
      const link = element('a','',`${source.category}来源`);
      link.href = source.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
      li.append(link); sourceList.append(li);
    }
    renderVisuals(item);
    amenitiesView.render(item);
    renderFiles(item);
  }

  function select(id) {
    selectedId = id;
    const item = selected();
    if (item) {
      const city = cityLabel(item.city, item.district);
      collapsedCities.delete(city);
      collapsedDistricts.delete(districtKey(city, districtLabel(item.district)));
    }
    renderList();
    renderDetail();
  }

  async function load() {
    try {
      const result = await request('/api/competitors');
      records = result.items;
      if (selectedId && !records.some(item => item.id === selectedId)) selectedId = null;
      if (!selectedId && records.length) selectedId = records[0].id;
      renderList();
      renderDetail();
      if (pendingSection) {
        const target = { '项目概况': 'competitor-overview', '周边配套': 'competitor-amenities', '价格动态': 'competitor-overview', '产品户型': 'competitor-floorplans', '图片影像': 'competitor-visuals' }[pendingSection];
        pendingSection = '';
        if (target && selected()) requestAnimationFrame(() => $(target).scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    } catch (error) {
      list.replaceChildren(element('p', 'archive-list-empty', error.message));
      $('competitor-count').textContent = '加载失败';
    }
  }

  function openProjectDialog(item = null) {
    projectForm.reset();
    showError('competitor-form-error', '');
    projectDialog.dataset.editId = item?.id || '';
    $('competitor-dialog-title').textContent = item ? '编辑竞品概况' : '新建竞品档案';
    $('competitor-save').textContent = item ? '保存修改' : '保存档案';
    if (item) setFormValues(projectForm, { ...item, ...Object.fromEntries(Object.entries(inferredBasicInfo(item)).map(([key, value]) => ['info_' + key, value])) });
    projectDialog.showModal();
    projectForm.querySelector('[name="name"]').focus();
  }

  function setStatus(message) {
    const status = $('archive-status');
    status.textContent = message;
    status.hidden = !message;
  }

  function openDeleteDialog(item) {
    showError('delete-competitor-error', '');
    deleteDialog.dataset.recordId = item.id;
    $('delete-competitor-description').textContent = `“${item.name}”及其 ${item.files.length} 个附件、${item.visits.length} 条踩盘记录将移入回收站，可随时恢复。`;
    deleteDialog.showModal();
  }

  async function loadTrash() {
    const container = $('competitor-trash-list');
    container.replaceChildren(element('p', 'archive-section-empty', '加载中…'));
    showError('competitor-trash-error', '');
    try {
      const result = await request('/api/competitors?deleted=true');
      container.replaceChildren();
      if (!result.items.length) container.append(element('p', 'archive-section-empty', '回收站为空'));
      for (const item of result.items) {
        const row = element('div', 'archive-trash-row');
        const info = element('div', 'archive-trash-info');
        const deletedOn = new Date(item.deletedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
        info.append(element('strong', '', item.name), element('span', '', `${deletedOn} 删除 · ${item.files.length} 个附件 · ${item.visits.length} 条踩盘记录`));
        const restore = element('button', 'archive-secondary', '恢复');
        restore.type = 'button';
        restore.setAttribute('aria-label', `恢复${item.name}档案`);
        restore.addEventListener('click', async () => {
          restore.disabled = true;
          restore.textContent = '恢复中…';
          showError('competitor-trash-error', '');
          try {
            await request(`/api/competitors/${item.id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            selectedId = item.id;
            search.value = '';
            setStatus(`已恢复“${item.name}”。`);
            await load();
            await loadTrash();
            trashDialog.querySelector('[data-close-dialog]').focus();
          } catch (error) {
            showError('competitor-trash-error', error.message);
            restore.disabled = false;
            restore.textContent = '恢复';
          }
        });
        row.append(info, restore);
        container.append(row);
      }
    } catch (error) {
      container.replaceChildren();
      showError('competitor-trash-error', error.message);
    }
  }

  $('delete-competitor-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('delete-competitor-confirm');
    button.disabled = true;
    showError('delete-competitor-error', '');
    try {
      const id = deleteDialog.dataset.recordId;
      const item = records.find(record => record.id === id);
      await request(`/api/competitors/${id}`, { method: 'DELETE' });
      deleteDialog.close();
      setStatus(`已将“${item?.name || '档案'}”移入回收站。`);
      await load();
      $('trash-competitors').focus();
    } catch (error) {
      showError('delete-competitor-error', error.message);
    } finally {
      button.disabled = false;
    }
  });

  function openFloorplanDialog(slot = null) {
    floorplanForm.reset();
    showError('floorplan-form-error', '');
    floorplanDialog.dataset.slotId = slot?.id || '';
    $('floorplan-dialog-title').textContent = slot ? '编辑户型信息' : '新增户型';
    if (slot) setFormValues(floorplanForm, slot);
    else floorplanForm.querySelector('[name="label"]').value = `户型 ${String((selected()?.floorplans.length || 3) + 1).padStart(2, '0')}`;
    floorplanDialog.showModal();
    floorplanForm.querySelector('[name="label"]').focus();
  }

  projectForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!projectForm.reportValidity()) return;
    showError('competitor-form-error', '');
    const button = $('competitor-save');
    button.disabled = true;
    try {
      const id = projectDialog.dataset.editId;
      const values = formValues(projectForm);
      values.basicInfo = Object.fromEntries(BASIC_INFO_FIELDS.map(([key]) => { const value = values['info_' + key]; delete values['info_' + key]; return [key, value]; }));
      const result = await request(id ? `/api/competitors/${id}` : '/api/competitors', {
        method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values)
      });
      selectedId = result.item.id;
      projectDialog.close();
      await load();
    } catch (error) {
      showError('competitor-form-error', error.message);
    } finally {
      button.disabled = false;
    }
  });

  floorplanForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!floorplanForm.reportValidity() || !selectedId) return;
    showError('floorplan-form-error', '');
    const button = $('floorplan-save');
    button.disabled = true;
    try {
      const slotId = floorplanDialog.dataset.slotId;
      const url = `/api/competitors/${selectedId}/floorplans${slotId ? `/${encodeURIComponent(slotId)}` : ''}`;
      await request(url, { method: slotId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formValues(floorplanForm)) });
      floorplanDialog.close();
      await load();
    } catch (error) {
      showError('floorplan-form-error', error.message);
    } finally {
      button.disabled = false;
    }
  });

  $('edit-competitor-research').addEventListener('click', () => {
    const item = selected();
    if (!item) return;
    editingResearch = { id: item.id, expectedReport: item.aiResearch?.report || '' };
    $('competitor-research-input').value = cleanDisplayText(editingResearch.expectedReport);
    showError('competitor-research-error', '');
    researchDialog.showModal();
    $('competitor-research-input').focus();
  });
  researchForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!editingResearch || !researchForm.reportValidity()) return;
    const target = editingResearch;
    const field = $('competitor-research-input');
    const buttons = [...researchDialog.querySelectorAll('button')];
    buttons.forEach(node => node.disabled = true);
    field.readOnly = true;
    showError('competitor-research-error', '');
    try {
      await request(`/api/competitors/${target.id}/research`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report: field.value, expectedReport: target.expectedReport }) });
      researchDialog.close();
      await load();
      if (selectedId === target.id) $('competitor-ai-research').open = true;
      setStatus('研究资料已保存');
    } catch (error) {
      showError('competitor-research-error', error.message);
    } finally {
      buttons.forEach(node => node.disabled = false);
      field.readOnly = false;
    }
  });
  researchDialog.addEventListener('cancel', event => { if ($('competitor-research-save').disabled) event.preventDefault(); });
  researchDialog.addEventListener('close', () => { editingResearch = null; });

  visualInput.addEventListener('change', async () => {
    const file = visualInput.files[0];
    const target = pendingVisual;
    if (!file || !target) return;
    showError('visual-error', '');
    if (file.size > 25 * 1024 * 1024) return showError('visual-error', '单个文件不能超过 25 MB');
    try {
      const query = new URLSearchParams({ name: file.name, category: target.category });
      if (target.slotId) query.set('slotId', target.slotId);
      const endpoint = `/api/competitors/${target.competitorId}/files` + (target.replaceId ? '/' + target.replaceId : '');
      await request(`${endpoint}?${query}`, { method: target.replaceId ? 'PUT' : 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      await load();
    } catch (error) {
      showError('visual-error', error.message);
    } finally {
      visualInput.value = '';
      pendingVisual = null;
    }
  });

  $('file-input').addEventListener('change', event => {
    $('file-name').textContent = event.target.files[0]?.name || '选择文件';
  });
  $('file-upload-form').addEventListener('submit', async event => {
    event.preventDefault();
    const file = $('file-input').files[0];
    if (!file || !selectedId) return;
    showError('file-error', '');
    if (file.size > 25 * 1024 * 1024) return showError('file-error', '单个附件不能超过 25 MB');
    const button = $('file-upload-button');
    button.disabled = true;
    button.textContent = '上传中…';
    try {
      const query = new URLSearchParams({ name: file.name, category: $('file-category').value });
      if ($('file-visit').value) query.set('visitId', $('file-visit').value);
      await request(`/api/competitors/${selectedId}/files?${query}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      $('file-upload-form').reset();
      $('file-name').textContent = '选择文件';
      await load();
    } catch (error) {
      showError('file-error', error.message);
    } finally {
      button.disabled = false;
      button.textContent = '上传';
    }
  });

  $('new-competitor').addEventListener('click', () => openProjectDialog());
  $('edit-competitor').addEventListener('click', () => { if (selected()) openProjectDialog(selected()); });
  $('delete-competitor').addEventListener('click', () => { if (selected()) openDeleteDialog(selected()); });
  $('trash-competitors').addEventListener('click', () => { trashDialog.showModal(); loadTrash(); });
  $('upload-masterplan').addEventListener('click', () => chooseVisual('总规划', 'masterplan'));
  $('refresh-competitor-maps').addEventListener('click', async () => {
    const button = $('refresh-competitor-maps'), progress = $('map-refresh-progress'), targets = records.map(item => structuredClone(item));
    button.disabled = true; let saved = 0; const pending = [];
    try {
      for (const [index, item] of targets.entries()) {
        progress.textContent = `正在更新 ${index + 1}/${targets.length}：${item.name}`;
        try {
          const result = await request('/api/maps/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: item.id }) });
          if (!result.matched) { pending.push(item.name + '（' + result.reason + '）'); continue; }
          await request(`/api/competitors/${item.id}/amenities`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amenities: result.amenities, expectedAmenities: JSON.stringify(item.amenities || null) }) });
          saved++;
        } catch (error) { pending.push(item.name + '（' + error.message + '）'); }
      }
      await load(); progress.textContent = `地图资料已更新 ${saved}/${targets.length} 个项目。` + (pending.length ? '待处理：' + pending.join('；') : '');
    } finally { button.disabled = false; }
  });
  $('upload-rendering').addEventListener('click', () => chooseVisual('效果图'));
  $('new-floorplan').addEventListener('click', () => { if (selected()) openFloorplanDialog(); });
  $('competitor-back').addEventListener('click', onBack);
  search.addEventListener('input', renderList);
  for (const dialog of [projectDialog, floorplanDialog, deleteDialog, trashDialog, researchDialog]) {
    dialog.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('click', event => { if (event.target === dialog && !(dialog === researchDialog && $('competitor-research-save').disabled)) dialog.close(); });
  }

  load();

  return {
    show(subsection = '', id = null) {
      view.hidden = false;
      $('competitor-overview').open = false;
      if (id) {
        selectedId = id;
        const item = selected();
        if (item) {
          const city = cityLabel(item.city, item.district);
          collapsedCities.delete(city);
          collapsedDistricts.delete(districtKey(city, districtLabel(item.district)));
        }
      }
      pendingSection = subsection;
      load();
    },
    hide() { view.hidden = true; amenitiesView.hide(); },
    searchOptions() { return records.map(item => ({ key: 'competitor', title: item.name, subsection: '', group: '竞品档案', recordId: item.id, searchText: [item.name, item.city, cityLabel(item.city, item.district), item.district, item.developer].join(' ') })); }
  };
}
