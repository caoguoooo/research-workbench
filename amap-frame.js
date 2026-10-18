import { validLocation, distanceLabel, distanceMeters, AMAP_NEARBY_TYPES, isVisibleAmenity } from './project-details.js';
import { toGCJ02, toWGS84 } from './map-coordinates.js';
import { amapError, amapPlaces } from './amap-results.js';

const notice = document.getElementById('notice');
const post = value => parent.postMessage({ source: 'workbench-amap', ...value }, location.origin);
const point = value => { const p = toGCJ02(value); return [p.lng, p.lat]; };
const colors = { transport: '#3275ad', education: '#508e89', shopping: '#b78340', medical: '#b86670' };
const cities = { 重庆: [106.552, 29.563], 成都: [104.067, 30.572], 上海: [121.474, 31.23], 北京: [116.407, 39.904] };
let map, item, tool = '', overlays = [], measure = [], measureOverlays = [], markers = new Map(), popup;

async function initialize() {
  const response = await fetch('/api/maps/client');
  if (!response.ok) throw new Error('登录已失效，请刷新页面重新登录。');
  const config = await response.json();
  if (!config.configured) throw new Error('请在设置中填写高德 JS API Key 和对应的安全密钥。');
  window._AMapSecurityConfig = { serviceHost: location.origin + config.serviceHost };
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('高德地图加载超时，请检查网络后重试。')), 20000);
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.key)}&plugin=AMap.PlaceSearch,AMap.Scale,AMap.ToolBar`;
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); reject(new Error('无法加载高德地图，请检查网络或浏览器拦截设置。')); };
    document.head.append(script);
  });
  if (!window.AMap?.Map || !window.AMap?.PlaceSearch) throw new Error(amapError(window.AMap?.info));
  map = new AMap.Map('map', { zoom: 11, center: cities.重庆, viewMode: '2D', scrollWheel: false });
  map.addControl(new AMap.Scale()); map.addControl(new AMap.ToolBar({ position: 'LB' }));
  popup = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -14) });
  map.on('click', event => {
    const location = toWGS84({ lng: event.lnglat.getLng(), lat: event.lnglat.getLat() });
    if (tool === 'measure') {
      if (measure.length === 2) { measure = []; map.remove(measureOverlays); measureOverlays = []; }
      measure.push(location);
      if (measure.length === 2) {
        const line = new AMap.Polyline({ path: measure.map(point), strokeColor: '#67839b', strokeWeight: 2, strokeStyle: 'dashed' });
        measureOverlays.push(line); map.add(line); post({ type: 'status', message: `直线距离 ${distanceLabel(distanceMeters(...measure))}；再次点击可重新测量。` });
      } else post({ type: 'status', message: '请选择测距终点。' });
    } else if (tool) post({ type: 'click', location });
  });
  notice.hidden = true; notice.style.display = 'none'; post({ type: 'ready' });
}
const ready = initialize().catch(error => { notice.textContent = error.message; post({ type: 'error', message: error.message }); throw error; });
ready.catch(() => {});

function resetTool(value = '') {
  tool = value; measure = []; map.remove(measureOverlays); measureOverlays = [];
  map.setDefaultCursor(tool ? 'crosshair' : 'grab');
}
function render(data) {
  item = data.project; map.remove(overlays); overlays = []; markers.clear(); popup.close(); resetTool();
  const dark = data.theme === 'dark'; document.body.dataset.theme = dark ? 'dark' : 'light';
  map.setMapStyle(dark ? 'amap://styles/dark' : 'amap://styles/normal');
  const location = item.amenities?.location;
  if (validLocation(location)) {
    map.setZoomAndCenter(14, point(location));
    const circle = new AMap.Circle({ center: point(location), radius: 1000, strokeColor: '#7da0c5', strokeWeight: 1, strokeStyle: 'dashed', fillOpacity: 0.035 });
    overlays.push(circle); map.add(circle); addMarker(location, item.name, '', true);
  } else {
    const center = cities[String(item.city || '').replace(/市$/, '')]; map.setZoomAndCenter(center ? 11 : 4, center || [105, 35]);
  }
  for (const [index, place] of (item.amenities?.places || []).entries()) {
    if (!isVisibleAmenity(place) || !validLocation(place.location) || data.category !== 'all' && data.category !== place.category) continue;
    markers.set(index, addMarker(place.location, place.name, place.address, false, colors[place.category]));
  }
}
function addMarker(location, name, address, project = false, color) {
  const content = document.createElement('div'); content.className = 'map-marker' + (project ? ' map-project' : '');
  if (color) content.style.setProperty('--marker-color', color);
  const marker = new AMap.Marker({ position: point(location), content, anchor: 'center', title: name });
  const show = () => {
    const content = document.createElement('div'); content.className = 'map-popup';
    const title = document.createElement('strong'); title.textContent = name; content.append(title);
    for (const text of [address, !project && `距项目 ${distanceLabel(distanceMeters(item.amenities?.location, location))} · 直线`].filter(Boolean)) {
      const paragraph = document.createElement('p'); paragraph.textContent = text; content.append(paragraph);
    }
    popup.setContent(content); popup.open(map, marker.getPosition());
  };
  marker.on('click', show); map.add(marker); overlays.push(marker); return { marker, show };
}
function search(options, keyword, center) {
  return new Promise((resolve, reject) => {
    const service = new AMap.PlaceSearch({ pageSize: 10, pageIndex: 1, extensions: 'base', ...options });
    const timer = setTimeout(() => reject(new Error('高德查询超时，请稍后重试。')), 18000);
    const done = (status, result) => { clearTimeout(timer); if (status === 'complete' || status === 'no_data') resolve(result?.poiList?.pois || []); else reject(new Error(amapError(result))); };
    if (center) service.searchNearBy('', center, 2000, done); else service.search(keyword, done);
  });
}
window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.source !== 'workbench-parent') return;
  const { type, id, ...data } = event.data;
  try {
    await ready;
    if (type === 'render') render(data);
    if (type === 'tool') resetTool(data.tool);
    if (type === 'resize') map.resize?.();
    if (type === 'focus') { const value = markers.get(data.index); if (value) { map.setZoomAndCenter(16, value.marker.getPosition()); value.show(); } }
    if (type === 'lookup') {
      const project = data.project; let places = [];
      if (data.mode === 'search') places = amapPlaces(await search({ city: project.city || '', citylimit: true }, data.query || project.name), 'project');
      else {
        if (!validLocation(project.amenities?.location)) throw new Error('请先定位楼盘，再查询周边配套。');
        for (const [category, code] of AMAP_NEARBY_TYPES) {
          places.push(...amapPlaces(await search({ type: code }, '', point(project.amenities.location)), category));
        }
      }
      post({ type: 'result', id, result: { places, attribution: '高德地图', ...(data.mode === 'nearby' ? { radius: 2000 } : {}) } });
    }
    if (type === 'check') {
      await search({ city: '重庆', citylimit: true }, '重庆市政府');
      post({ type: 'result', id, result: { ok: true } });
    }
  } catch (error) { post({ type: 'error', id, message: error.message }); }
});
