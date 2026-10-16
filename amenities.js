import { createAMapFrame } from './amap-bridge.js';
import { AMENITY_CATEGORIES, validLocation, distanceMeters, distanceLabel } from './project-details.js';

const $ = id => document.getElementById(id);
const colors = { transport: '#3275ad', education: '#508e89', shopping: '#b78340', medical: '#b86670' };
const cityCenters = { 重庆: [29.563, 106.552], 成都: [30.572, 104.067], 上海: [31.23, 121.474], 北京: [39.904, 116.407] };
function node(tag, className = '', text = '') {
  const value = document.createElement(tag); value.className = className; value.textContent = text; return value;
}

export function initAmenities({ request, onSaved }) {
  const panel = $('amenities-map-panel'), canvas = $('amenities-map'), dialog = $('amenities-dialog'), form = $('amenities-form');
  let project, map, markers, tiles, category = 'all', dirty = true, picking = false, addingPoint = false, measuring = false, measurePoints = [], measureLayer, editing, busy = false;
  const pointMarkers = new Map();
  let amap, mapConfig, mapLoading, mapGeneration = 0;
  const status = message => { $('amenities-map-status').textContent = message; };
  const error = (id, message = '') => { $(id).textContent = message; $(id).hidden = !message; };
  const snapshot = item => JSON.stringify(item.amenities || null);
  const position = () => project?.amenities?.location;

  function resetTools() {
    picking = false; addingPoint = false; measuring = false; measurePoints = [];
    $('amenities-measure').setAttribute('aria-pressed', 'false');
    $('amenities-locate').classList.remove('is-active');
    $('amenities-pick-place').classList.remove('is-active');
    canvas.classList.remove('is-picking');
    if (measureLayer) measureLayer.clearLayers();
    amap?.send('tool', { tool: '' });
  }

  function placeList() {
    const entries = (project?.amenities?.places || []).map((place, index) => ({ place, index, distance: distanceMeters(position(), place.location) }))
      .filter(({ place }) => category === 'all' || category === place.category)
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const list = $('amenities-places'); list.replaceChildren();
    for (const { place, index, distance } of entries) {
      const button = node('button', 'amenities-place'); button.type = 'button';
      const label = node('span', 'amenities-place-copy'); label.append(node('strong', '', place.name));
      if (place.address) label.append(node('small', '', place.address));
      button.append(node('span', `amenities-place-dot amenity-${place.category}`, '●'), label, node('span', 'amenities-distance', distanceLabel(distance)));
      button.addEventListener('click', async () => {
        if (!validLocation(place.location)) { status('这个配套尚未定位，可在“编辑配套”中填写坐标。'); return; }
        await ensureMap();
        if (amap) amap.send('focus', { index });
        if (map) { map.setView([place.location.lat, place.location.lng], 16); pointMarkers.get(index)?.openPopup(); }
      });
      list.append(button);
    }
    if (!entries.length) list.append(node('p', 'amenities-list-empty', '暂无配套点位。'));
  }

  function drawMap() {
    if (!project) return;
    if (amap) {
      dirty = false; resetTools();
      amap.send('render', { project: { name: project.name, city: project.city, amenities: project.amenities }, category, theme: document.body.dataset.theme });
      status(validLocation(position()) ? '高德地图 · 范围圈为 1 公里；列表距离为直线距离。' : '高德地图 · 尚未标记项目位置，可点击高德定位。');
      return;
    }
    if (!map) return;
    dirty = false; markers.clearLayers(); pointMarkers.clear(); resetTools();
    const location = position();
    if (validLocation(location)) {
      const center = [location.lat, location.lng]; map.setView(center, 14);
      window.L.circle(center, { radius: 1000, color: '#7da0c5', weight: 1, dashArray: '5 6', fillOpacity: 0.035, interactive: false }).addTo(markers);
      const popup = node('strong', '', project.name);
      window.L.circleMarker(center, { radius: 9, color: '#fff', weight: 3, fillColor: '#d85556', fillOpacity: 1 }).addTo(markers).bindPopup(popup);
      status('范围圈为 1 公里；列表距离为直线距离。');
    } else {
      const city = String(project.city || '').replace(/市$/, ''), center = cityCenters[city];
      map.setView(center || [35, 105], center ? 11 : 4);
      status(document.body.dataset.role === 'admin' ? '尚未标记项目位置，点击“标记位置”后在地图上选择。' : '尚未标记项目位置。');
    }
    for (const [index, place] of (project.amenities?.places || []).entries()) {
      if (!validLocation(place.location) || (category !== 'all' && category !== place.category)) continue;
      const popup = node('div', 'amenities-popup'); popup.append(node('strong', '', place.name));
      if (place.address) popup.append(node('p', '', place.address));
      popup.append(node('p', '', `距项目 ${distanceLabel(distanceMeters(location, place.location))} · 直线`));
      if (place.sourceUrl) { const source = node('a', '', '高德地图来源 ↗'); source.href = place.sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer'; popup.append(source); }
      const marker = window.L.circleMarker([place.location.lat, place.location.lng], { radius: 6, color: '#fff', weight: 2, fillColor: colors[place.category], fillOpacity: 1 }).bindPopup(popup).addTo(markers);
      pointMarkers.set(index, marker);
    }
  }

  async function handleMapClick(event) {
        if (busy) return;
        if (addingPoint) {
          const location = { lat: Number(event.latlng.lat.toFixed(6)), lng: Number(event.latlng.lng.toFixed(6)) };
          resetTools(); openEditor({ location });
        } else if (picking) {
          const target = project;
          const location = { lat: Number(event.latlng.lat.toFixed(6)), lng: Number(event.latlng.lng.toFixed(6)) };
          const amenities = { summary: {}, places: [], ...target.amenities, location };
          busy = true; error('amenities-error'); status('正在保存项目位置…');
          try {
            await request(`/api/competitors/${target.id}/amenities`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amenities, expectedAmenities: snapshot(target) }) });
            await onSaved();
          } catch (failure) { error('amenities-error', failure.message); }
          finally { busy = false; resetTools(); }
        } else if (measuring) {
          if (measurePoints.length === 2) { measurePoints = []; measureLayer.clearLayers(); }
          measurePoints.push({ lat: event.latlng.lat, lng: event.latlng.lng });
          window.L.circleMarker(event.latlng, { radius: 4, color: '#414b59' }).addTo(measureLayer);
          if (measurePoints.length === 2) {
            window.L.polyline(measurePoints.map(p => [p.lat, p.lng]), { color: '#414b59', weight: 2, dashArray: '5 5' }).addTo(measureLayer);
            status(`直线距离 ${distanceLabel(distanceMeters(...measurePoints))}；再次点击可重新测量。`);
          } else status('请选择测距终点。');
        }
  }
  async function prepareMap(generation) {
    if (mapConfig === undefined) {
      const response = await fetch('/api/maps/client');
      if (response.status === 401) { window.location.replace('/login?expired=1'); throw new Error('请重新登录。'); }
      if (!response.ok) throw new Error('无法读取地图配置，请刷新页面。');
      const value = await response.json();
      if (generation !== mapGeneration) return;
      mapConfig = value;
    }
    if (mapConfig.configured && !amap) {
      if (map) { map.remove(); map = null; }
      amap = createAMapFrame(canvas, {
        onClick(location) { if (validLocation(location)) handleMapClick({ latlng: location }); },
        onStatus: status, onError: status
      });
      await amap.ready;
    }
  }
  async function ensureMap() {
    const generation = mapGeneration;
    try {
      if (!mapLoading) mapLoading = prepareMap(generation).finally(() => { if (generation === mapGeneration) mapLoading = null; });
      await mapLoading;
      if (generation !== mapGeneration) return;
      if (amap) { if (dirty) drawMap(); return; }
      ensureLeaflet();
    } catch (failure) { status(failure.message); }
  }
  function ensureLeaflet() {
    if (!window.L) { status('地图组件未加载，请刷新页面。'); return; }
    if (!map) {
      map = window.L.map(canvas, { scrollWheelZoom: false, zoomControl: true });
      // Only the user's visible viewport is requested; browser HTTP caching remains enabled.
      tiles = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'
      }).addTo(map);
      tiles.on('tileerror', () => status('底图加载失败，可继续编辑配套或在高德地图打开。'));
      markers = window.L.layerGroup().addTo(map); measureLayer = window.L.layerGroup().addTo(map);
      map.on('click', async event => {
        await handleMapClick(event);
      });
    }
    map.invalidateSize(); if (dirty) drawMap();
  }

  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && project) ensureMap();
  });
  observer.observe(canvas);

  function render(item) {
    const changed = project?.id !== item.id;
    project = item; dirty = true; error('amenities-error');
    if (changed) { category = 'all'; resetTools(); }
    $('amenities-map-title').textContent = `${item.name} · 位置及周边`;
    $('amenities-external').href = `https://uri.amap.com/search?keyword=${encodeURIComponent([item.city, item.name].filter(Boolean).join(' '))}`;
    const tabs = $('amenities-tabs'); tabs.replaceChildren();
    for (const [key, label] of [['all', '全部'], ...AMENITY_CATEGORIES]) {
      const button = node('button', '', label); button.type = 'button'; button.setAttribute('aria-pressed', String(category === key));
      button.addEventListener('click', () => { category = key; for (const child of tabs.children) child.setAttribute('aria-pressed', String(child === button)); placeList(); dirty = true; ensureMap(); });
      tabs.append(button);
    }
    const summaries = $('amenities-summary'); summaries.replaceChildren();
    for (const [key, label] of AMENITY_CATEGORIES) {
      const block = node('div'); block.append(node('h4', '', label), node('p', '', item.amenities?.summary?.[key] || '暂无资料')); summaries.append(block);
    }
    placeList();
    const rect = canvas.getBoundingClientRect();
    if (amap || map || rect.width && rect.top < innerHeight && rect.bottom > 0) ensureMap();
  }

  $('amenities-locate').addEventListener('click', async () => {
    if (busy) return; await ensureMap(); const enabled = !picking; resetTools(); picking = enabled;
    $('amenities-locate').classList.toggle('is-active', picking); canvas.classList.toggle('is-picking', picking);
    amap?.send('tool', { tool: picking ? 'pick' : '' });
    status(picking ? '在地图上点击项目所在位置，将保存至本项目。' : '已取消标记。');
  });
  $('amenities-measure').addEventListener('click', async () => {
    await ensureMap(); const enabled = !measuring; resetTools(); measuring = enabled;
    $('amenities-measure').setAttribute('aria-pressed', String(measuring)); canvas.classList.toggle('is-picking', measuring);
    amap?.send('tool', { tool: measuring ? 'measure' : '' });
    status(measuring ? '请选择测距起点。' : '已结束测距。');
  });
  $('amenities-pick-place').addEventListener('click', async () => {
    if (busy) return; await ensureMap(); const enabled = !addingPoint; resetTools(); addingPoint = enabled;
    $('amenities-pick-place').classList.toggle('is-active', addingPoint); canvas.classList.toggle('is-picking', addingPoint);
    amap?.send('tool', { tool: addingPoint ? 'place' : '' });
    status(addingPoint ? '在地图上点击配套位置，再填写名称和分类。' : '已取消添加点位。');
  });
  $('amenities-fullscreen').addEventListener('click', async () => {
    error('amenities-error');
    try { if (document.fullscreenElement === panel) await document.exitFullscreen(); else await panel.requestFullscreen(); }
    catch { error('amenities-error', '浏览器不支持全屏，请放大窗口查看。'); }
  });
  document.addEventListener('fullscreenchange', () => { if (map) requestAnimationFrame(() => map.invalidateSize()); amap?.send('resize'); });

  function coordinateInputs(lngInput, latInput) {
    const lng = lngInput.value.trim(), lat = latInput.value.trim();
    if (!lng && !lat) return null;
    const location = { lng: Number(lng), lat: Number(lat) };
    if (!lng || !lat || !validLocation(location)) throw new Error('请同时填写有效的经度和纬度');
    return location;
  }

  function addPlace(place = {}) {
    const fields = $('amenities-place-fields');
    if (fields.children.length >= 100) { error('amenities-form-error', '最多添加 100 个配套点位'); return; }
    const row = node('fieldset', 'amenities-place-fields'); row.dataset.sourceUrl = place.sourceUrl || ''; row.append(node('legend', '', '配套点位'));
    const categoryInput = node('select'); categoryInput.dataset.field = 'category'; categoryInput.setAttribute('aria-label', '配套分类');
    for (const [key, label] of AMENITY_CATEGORIES) categoryInput.add(new Option(label, key));
    categoryInput.value = place.category || 'transport'; row.append(categoryInput);
    for (const [key, label, max] of [['name', '配套名称', 100], ['address', '地址', 200], ['lng', '经度', 30], ['lat', '纬度', 30]]) {
      const field = node('input'); field.dataset.field = key; field.placeholder = label; field.setAttribute('aria-label', label); field.maxLength = max;
      if (key === 'name') field.required = true;
      if (['lng', 'lat'].includes(key)) { field.type = 'number'; field.step = 'any'; field.min = key === 'lng' ? '-180' : '-90'; field.max = key === 'lng' ? '180' : '90'; }
      field.value = ['lng', 'lat'].includes(key) ? place.location?.[key] ?? '' : place[key] || '';
      row.append(field);
    }
    const remove = node('button', 'archive-text-button', '删除'); remove.type = 'button'; remove.addEventListener('click', () => row.remove()); row.append(remove); fields.append(row);
  }

  function openEditor(newPlace = null) {
    if (!project || busy) return;
    form.reset(); error('amenities-form-error');
    editing = { id: project.id, expectedAmenities: snapshot(project) };
    const data = project.amenities;
    form.elements.lng.value = data?.location?.lng ?? ''; form.elements.lat.value = data?.location?.lat ?? '';
    for (const [key] of AMENITY_CATEGORIES) form.elements[key].value = data?.summary?.[key] || '';
    $('amenities-place-fields').replaceChildren(); for (const place of data?.places || []) addPlace(place);
    if (newPlace) addPlace(newPlace);
    dialog.showModal();
    if (newPlace) $('amenities-place-fields').lastElementChild?.querySelector('[data-field="name"]')?.focus();
  }
  $('edit-amenities').addEventListener('click', () => openEditor());
  $('amenities-add-place').addEventListener('click', () => addPlace());
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!editing || busy || !form.reportValidity()) return;
    error('amenities-form-error');
    let amenities;
    try {
      amenities = { location: coordinateInputs(form.elements.lng, form.elements.lat), summary: Object.fromEntries(AMENITY_CATEGORIES.map(([key]) => [key, form.elements[key].value.trim()])),
        places: [...$('amenities-place-fields').children].map(row => {
          const field = name => row.querySelector(`[data-field="${name}"]`);
          return { category: field('category').value, name: field('name').value.trim(), address: field('address').value.trim(), location: coordinateInputs(field('lng'), field('lat')), ...(row.dataset.sourceUrl ? { sourceUrl: row.dataset.sourceUrl } : {}) };
        }) };
    } catch (failure) { error('amenities-form-error', failure.message); return; }
    const target = editing; busy = true;
    const controls = [...form.querySelectorAll('input,textarea,select,button')]; controls.forEach(control => control.disabled = true);
    try {
      await request(`/api/competitors/${target.id}/amenities`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amenities, expectedAmenities: target.expectedAmenities }) });
      dialog.close(); await onSaved();
    } catch (failure) { error('amenities-form-error', failure.message); }
    finally { busy = false; controls.forEach(control => control.disabled = false); }
  });
  dialog.querySelectorAll('[data-close-amenities]').forEach(button => button.addEventListener('click', () => { if (!busy) dialog.close(); }));
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { editing = null; });
  const lookupDialog = $('amenities-lookup-dialog');
  let lookupContext = null, lookupRevision = 0, lookupSaving = false, candidates = [];
  function lookupError(message = '') { error('amenities-lookup-error', message); }
  function defaultAmenities(item) { return { location: null, summary: {}, places: [], ...structuredClone(item.amenities) }; }
  async function saveLookup(amenities, target) {
    if (lookupSaving) return;
    lookupSaving = true;
    const controls = [...lookupDialog.querySelectorAll('button,input')]; controls.forEach(button => button.disabled = true);
    try {
      await request(`/api/competitors/${target.item.id}/amenities`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amenities, expectedAmenities: target.expectedAmenities }) });
      lookupDialog.close(); await onSaved();
    } catch (failure) { lookupError(failure.message); }
    finally { lookupSaving = false; controls.forEach(button => button.disabled = false); }
  }
  async function runLookup() {
    if (!lookupContext || lookupSaving) return;
    const target = lookupContext, revision = ++lookupRevision;
    const query = $('amenities-lookup-query').value.trim();
    if (target.mode === 'search' && !query) return lookupError('请输入楼盘名称或地址');
    lookupError(); candidates = [];
    $('amenities-lookup-results').replaceChildren(node('p', 'archive-hint', '正在查询高德地图…'));
    $('amenities-lookup-apply').hidden = true;
    try {
      await ensureMap();
      const result = amap ? await amap.request('lookup', { mode: target.mode, project: { name: target.item.name, city: target.item.city, amenities: target.item.amenities }, query })
        : await request(`/api/maps/${target.mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: target.item.id, ...(target.mode === 'search' ? { query } : {}) }) });
      if (revision !== lookupRevision || !lookupDialog.open) return;
      candidates = result.places;
      const results = $('amenities-lookup-results'); results.replaceChildren();
      if (!candidates.length) results.append(node('p', 'archive-hint', '未找到结果，可调整楼盘名称或使用更详细的地址。'));
      for (const [index, place] of candidates.entries()) {
        const row = node(target.mode === 'search' ? 'button' : 'label', 'amenities-lookup-row');
        if (target.mode === 'search') {
          row.type = 'button';
          row.addEventListener('click', () => { const amenities = defaultAmenities(target.item); amenities.location = place.location; saveLookup(amenities, target); });
        } else {
          const check = node('input'); check.type = 'checkbox'; check.value = String(index); row.append(check);
        }
        const copy = node('span'); copy.append(node('strong', '', place.name), node('small', '', place.address));
        row.append(copy);
        if (target.mode === 'nearby') row.append(node('small', '', distanceLabel(distanceMeters(target.item.amenities?.location, place.location))));
        results.append(row);
      }
      $('amenities-lookup-apply').hidden = target.mode !== 'nearby' || !candidates.length;
    } catch (failure) {
      if (revision === lookupRevision) { $('amenities-lookup-results').replaceChildren(); lookupError(failure.message); }
    }
  }
  function openLookup(mode) {
    if (!project || busy || lookupSaving) return;
    resetTools(); lookupError();
    lookupContext = { mode, item: structuredClone(project), expectedAmenities: snapshot(project) };
    $('amenities-lookup-title').textContent = mode === 'search' ? '定位楼盘' : '周边配套候选';
    $('amenities-lookup-query').value = project.name;
    $('amenities-lookup-form').hidden = mode !== 'search';
    $('amenities-lookup-hint').textContent = mode === 'search' ? '高德地图 · 选择与本项目相符的位置后保存。' : '高德地图 · 项目周边 2 公里，勾选后加入档案。';
    lookupDialog.showModal(); runLookup();
  }
  $('amenities-search').addEventListener('click', () => openLookup('search'));
  $('amenities-nearby').addEventListener('click', () => openLookup('nearby'));
  $('amenities-lookup-form').addEventListener('submit', event => { event.preventDefault(); runLookup(); });
  $('amenities-lookup-apply').addEventListener('click', () => {
    if (!lookupContext || lookupSaving) return;
    const selected = [...$('amenities-lookup-results').querySelectorAll('input:checked')].map(input => candidates[Number(input.value)]);
    if (!selected.length) return lookupError('请先勾选需要加入的配套');
    const amenities = defaultAmenities(lookupContext.item);
    for (const place of selected) {
      const found = amenities.places.find(existing => existing.category === place.category && existing.name.replace(/\s/g, '') === place.name.replace(/\s/g, ''));
      if (found) { if (!validLocation(found.location)) found.location = place.location; if (!found.address) found.address = place.address; found.sourceUrl = place.sourceUrl; }
      else amenities.places.push(place);
    }
    if (amenities.places.length > 100) return lookupError('当前项目最多保存 100 个配套点位');
    saveLookup(amenities, lookupContext);
  });
  $('amenities-lookup-close').addEventListener('click', () => { if (!lookupSaving) lookupDialog.close(); });
  lookupDialog.addEventListener('cancel', event => { if (lookupSaving) event.preventDefault(); });
  lookupDialog.addEventListener('close', () => { lookupRevision++; lookupContext = null; candidates = []; $('amenities-lookup-results').replaceChildren(); });
  window.addEventListener('workbench-map-settings-changed', () => {
    mapGeneration++; mapConfig = undefined; mapLoading = null; amap?.destroy(); amap = null;
    if (map) { map.remove(); map = null; } dirty = true;
    if (project) ensureMap();
  });
  new MutationObserver(() => { if (amap && project) { dirty = true; drawMap(); } }).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
  return { render, hide() { resetTools(); } };
}
