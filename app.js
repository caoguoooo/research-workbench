import { createAMapFrame } from './amap-bridge.js';
import { initUserProfile, displayName, renderUserAvatar } from './profile.js';
import { initUserManagement } from './users.js';
const currentUser = await fetch('/api/status').then(response => response.json());
if (!currentUser.authenticated) { window.location.replace('/login'); throw new Error('请先登录'); }
document.body.dataset.role = currentUser.role;

import { initTheme } from './theme.js';
import { initCompetitorArchive } from './competitor.js';

const categories = {
  policy: { title: '政策规范', index: '01 / RULES & POLICY', description: '按政策、规划与技术依据整理，方便追溯适用范围和版本。', subsections: ['政策文件', '规划条件', '技术规范', '官方解读'] },
  competitor: { title: '竞品档案', index: '02 / COMPETITOR FILES', description: '把竞品的基础信息、项目图像和周边配套放在一起。', subsections: ['项目概况', '周边配套', '价格动态', '产品户型', '图片影像'] },
  project: { title: '项目资料', index: '03 / INTERNAL PROJECTS', description: '围绕内部项目归集定位研究、方案设计和过程版本。', subsections: ['项目概况', '定位研究', '规划设计', '过程文件', '版本归档'] },
  assets: { title: '素材库', index: '04 / VISUAL ASSETS', description: '统一查找项目影像、地图、图纸和汇报素材。', subsections: ['航拍现场', '区位地图', '效果图', '图纸附件', '汇报素材'] }
};

const home = document.getElementById('home-view');
const detail = document.getElementById('category-view');
const detailList = document.getElementById('detail-subcategories');
const crumb = document.getElementById('current-crumb');
const sideLinks = [...document.querySelectorAll('.nav-link')];
const competitorArchive = initCompetitorArchive(() => renderCategory('home'), { canEdit: currentUser.role === 'admin' });
const userManagement = initUserManagement(currentUser, user => profileEditor.open(user));
const profileEditor = initUserProfile(currentUser, user => { updateHeaderProfile(user); userManagement.profileUpdated(user); });
function updateHeaderProfile(user = currentUser) {
  if (user.username !== currentUser.username) return;
  Object.assign(currentUser, { nickname: user.nickname || '', avatarUrl: user.avatarUrl || '' });
  document.getElementById('user-pill').textContent = displayName(currentUser);
  document.getElementById('account-profile-button').title = `${displayName(currentUser)} · ${currentUser.username}`;
  renderUserAvatar(document.getElementById('header-avatar'), currentUser);
}
document.getElementById('account-profile-button').addEventListener('click', () => profileEditor.open());
document.getElementById('open-profile').addEventListener('click', () => { closeSettings(); profileEditor.open(); });
let currentCategory = 'home';
const storageKeys = { message: 'workbench-home-message', theme: 'workbench-theme' };
const defaultMessage = 'Ideas begin here.';

function readPreference(key, fallback) {
  try { return localStorage.getItem(key) || localStorage.getItem(key.replace('workbench-', 'cyj-')) || fallback; } catch { return fallback; }
}

function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Private browsing can disable storage. */ }
}

function renderCategory(key, subsection = '', recordId = null) {
  if (key === 'users' && currentUser.role !== 'admin') return;
  if (key !== 'users') userManagement.hide();
  if (key === 'home') {
    currentCategory = 'home';
    home.hidden = false;
    detail.hidden = true;
    competitorArchive.hide();
    crumb.textContent = '资料总览';
    requestAnimationFrame(fitHomeImage);
  } else if (key === 'competitor') {
    currentCategory = key;
    home.hidden = true;
    detail.hidden = true;
    competitorArchive.show(subsection, recordId);
    crumb.textContent = '竞品档案';
  } else if (key === 'users') {
    currentCategory = key;
    home.hidden = true; detail.hidden = true; competitorArchive.hide();
    userManagement.show(); crumb.textContent = '用户管理';
  } else {
    const category = categories[key];
    if (!category) return;
    currentCategory = key;
    home.hidden = true;
    detail.hidden = false;
    competitorArchive.hide();
    crumb.textContent = category.title;
    document.getElementById('detail-index').textContent = category.index;
    document.getElementById('detail-title').textContent = category.title;
    const comingSoon = currentUser.role === 'viewer' && ['project', 'policy', 'assets'].includes(key);
    document.getElementById('detail-description').textContent = category.description;
    document.getElementById('detail-description').hidden = comingSoon;
    document.getElementById('category-coming-soon').hidden = !comingSoon;
    document.getElementById('category-detail-layout').hidden = comingSoon;
    detailList.replaceChildren();
    (comingSoon ? [] : category.subsections).forEach((name, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'detail-subitem';
      button.dataset.subsection = name;
      button.innerHTML = `<span class="subitem-number">${String(index + 1).padStart(2, '0')}</span><span class="subitem-name"></span><span class="subitem-arrow" aria-hidden="true">↗</span>`;
      button.querySelector('.subitem-name').textContent = name;
      button.setAttribute('aria-pressed', String(name === subsection));
      button.addEventListener('click', () => selectSubsection(name));
      detailList.append(button);
    });
    if (!comingSoon) selectSubsection(subsection);
  }
  sideLinks.forEach(link => link.classList.toggle('is-active', link.dataset.target === key));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function selectSubsection(name) {
  detailList.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.subsection === name)));
  document.getElementById('detail-aside-title').textContent = name ? `${name} · 资料待导入` : '资料待导入';
  document.getElementById('detail-aside-text').textContent = name ? `“${name}”的文件和记录将在导入后显示。` : '选择左侧栏目，查看对应的文件与记录。';
}

document.querySelectorAll('[data-target]').forEach(button => {
  button.addEventListener('click', () => renderCategory(button.dataset.target, button.dataset.sub || ''));
});
document.getElementById('back-home').addEventListener('click', () => renderCategory('home'));

const search = document.getElementById('global-search');
const searchResults = document.getElementById('search-results');
const categorySearchOptions = Object.entries(categories).flatMap(([key, category]) => [
  { key, title: category.title, subsection: '', group: '分类' },
  ...(currentUser.role === 'viewer' && ['project', 'policy', 'assets'].includes(key) ? [] : category.subsections.map(subsection => ({ key, title: subsection, subsection, group: category.title })))
]);
let visibleResults = [];

function openSearchResult(option) {
  renderCategory(option.key, option.subsection, option.recordId);
  search.value = '';
  searchResults.hidden = true;
  search.blur();
}

function renderSearchResults() {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) {
    searchResults.hidden = true;
    visibleResults = [];
    return;
  }
  visibleResults = [...categorySearchOptions, ...competitorArchive.searchOptions()].filter(option => `${option.searchText || option.title} ${option.group}`.toLocaleLowerCase().includes(query)).slice(0, 8);
  searchResults.replaceChildren();
  if (visibleResults.length) {
    visibleResults.forEach(option => {
      const button = document.createElement('button');
      button.type = 'button';
      const title = document.createElement('span');
      title.textContent = option.title;
      const group = document.createElement('small');
      group.textContent = option.group;
      button.append(title, group);
      button.addEventListener('click', () => openSearchResult(option));
      searchResults.append(button);
    });
  } else {
    const empty = document.createElement('p');
    empty.textContent = '没有匹配的栏目';
    searchResults.append(empty);
  }
  searchResults.hidden = false;
}

search.addEventListener('input', renderSearchResults);
search.addEventListener('focus', renderSearchResults);
search.addEventListener('keydown', event => {
  if (event.key === 'Enter' && visibleResults.length) {
    event.preventDefault();
    openSearchResult(visibleResults[0]);
  }
  if (event.key === 'Escape') searchResults.hidden = true;
});
document.addEventListener('click', event => {
  if (!event.target.closest('.header-search-wrap')) searchResults.hidden = true;
});

const timeLine = document.getElementById('time-line');
function updateTime() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(now);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(now);
  timeLine.textContent = `${date} · ${time}`;
}
updateTime();
setInterval(updateTime, 30_000);

const dailyImage = document.getElementById('home-visual-image');
const dailyPlaceholder = document.getElementById('home-visual-placeholder');
const dailySource = document.getElementById('home-visual-source');
const dailyCaption = document.getElementById('home-visual-caption');
const dailyTitle = document.getElementById('home-visual-title');
const dailyVisual = document.querySelector('.feature-visual');
function fitHomeImage() {
  if (home.hidden) return;
  const top = dailyVisual.getBoundingClientRect().top + window.scrollY;
  const available = Math.max(0, document.documentElement.clientHeight - top - 38);
  dailyVisual.style.setProperty('--home-image-room', `${available}px`);
}
const homeLayoutObserver = new ResizeObserver(fitHomeImage);
homeLayoutObserver.observe(document.querySelector('.home-intro'));
homeLayoutObserver.observe(document.querySelector('.app-header'));
window.addEventListener('resize', fitHomeImage);
let dailyImageUrl = '';
let dailyImageAttempts = 0;
dailyImage.addEventListener('load', () => { dailyImage.hidden = false; dailyPlaceholder.hidden = true; dailySource.hidden = false; dailyCaption.hidden = false; });
dailyImage.addEventListener('error', () => { dailyImageUrl = ''; dailyImage.hidden = true; dailyPlaceholder.hidden = false; dailySource.hidden = true; dailyCaption.hidden = true; document.getElementById('home-visual-status').textContent = '配图暂不可用'; });
async function loadHomeVisual() {
  try {
    const response = await fetch('/api/home-visual');
    if (!response.ok) return;
    const { image, status } = await response.json();
    const updated = document.getElementById('home-visual-updated');
    updated.textContent = status?.error || (image ? '更新于 ' + new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(image.updatedAt)) : '每日自动更新');
    if (!image) {
      document.getElementById('home-visual-status').textContent = '配图暂未更新';
      if (dailyImageAttempts++ < 6) setTimeout(loadHomeVisual, 5000);
      return;
    }
    dailySource.href = image.sourceUrl;
    dailySource.title = image.title;
    dailyImage.alt = image.title;
    dailyTitle.textContent = image.title;
    if (dailyImageUrl !== image.url) { dailyImageUrl = image.url; dailyImage.src = image.url; }
  } catch { /* Retain the visible image while the backend is unavailable. */ }
}
document.getElementById('home-visual-refresh').addEventListener('click', async () => {
  const button = document.getElementById('home-visual-refresh'), label = document.getElementById('home-visual-updated');
  button.disabled = true; label.textContent = '正在更新配图…';
  try {
    const response = await fetch('/api/home-visual/refresh', { method: 'POST', headers: { 'X-Workbench-Request': '1' } });
    if (response.status === 401) return window.location.replace('/login?expired=1');
    const value = await response.json(); if (!response.ok) throw new Error(value.error || '配图更新失败');
    await loadHomeVisual();
  } catch (error) { label.textContent = error.message; }
  finally { button.disabled = false; }
});
loadHomeVisual();
setInterval(() => { if (!document.hidden) loadHomeVisual(); }, 15 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadHomeVisual(); });

const homeMessage = document.getElementById('home-message');
const messageInput = document.getElementById('message-input');
const settingsDialog = document.getElementById('settings-dialog');
homeMessage.textContent = readPreference(storageKeys.message, defaultMessage);
let settingsRevision = 0;
document.getElementById('settings-button').addEventListener('click', async () => {
  const revision = ++settingsRevision;
  for (const id of ['map-api-key', 'map-js-key', 'map-security-code']) document.getElementById(id).value = '';
  for (const id of ['clear-map-key', 'clear-map-js']) document.getElementById(id).checked = false;
  document.getElementById('map-test-status').textContent = '';
  document.getElementById('settings-error').hidden = true;
  messageInput.value = homeMessage.textContent;
  settingsDialog.hidden = false;
  messageInput.focus();
  if (currentUser.role !== 'admin') return;
  try {
    const response = await fetch('/api/settings/maps');
    if (response.status === 401) return window.location.replace('/login?expired=1');
    if (!response.ok) throw new Error('无法读取地图设置');
    const value = await response.json();
    if (revision === settingsRevision) showMapSettings(value);
  } catch (error) {
    if (revision === settingsRevision) { document.getElementById('settings-error').textContent = error.message; document.getElementById('settings-error').hidden = false; }
  }
});
function closeSettings() {
  settingsRevision++;
  for (const id of ['map-api-key', 'map-js-key', 'map-security-code']) document.getElementById(id).value = '';
  settingsDialog.hidden = true;
  document.getElementById('settings-button').focus();
}
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-cancel').addEventListener('click', closeSettings);
settingsDialog.addEventListener('click', event => { if (event.target === settingsDialog) closeSettings(); });
settingsDialog.addEventListener('keydown', event => { if (event.key === 'Escape') closeSettings(); });
function showMapSettings(value, clear = false) {
  for (const [id, configured, label] of [['map-api-key', value.configured, '填写高德 Web 服务 Key'], ['map-js-key', value.jsKeyConfigured, '填写 JS API Key'], ['map-security-code', value.securityConfigured, '填写同一个 Key 对应的安全密钥']]) {
    const field = document.getElementById(id); if (clear) field.value = ''; field.placeholder = configured ? '********************************' : label;
  }
  for (const id of ['clear-map-key', 'clear-map-js']) document.getElementById(id).checked = false;
}
async function saveMapSettings() {
  const key = document.getElementById('map-api-key').value.trim(), jsKey = document.getElementById('map-js-key').value.trim(), securityJsCode = document.getElementById('map-security-code').value.trim();
  const clear = document.getElementById('clear-map-key').checked, clearJS = document.getElementById('clear-map-js').checked;
  if (!key && !jsKey && !securityJsCode && !clear && !clearJS) return;
  const response = await fetch('/api/settings/maps', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ key, jsKey, securityJsCode, clear, clearJS }) });
  if (response.status === 401) { window.location.replace('/login?expired=1'); throw new Error('请重新登录。'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '地图设置保存失败');
  showMapSettings(result, true); window.dispatchEvent(new Event('workbench-map-settings-changed'));
}
document.getElementById('map-test').addEventListener('click', async () => {
  const button = document.getElementById('map-test'), save = document.getElementById('settings-save'), message = document.getElementById('map-test-status');
  button.disabled = true; save.disabled = true; message.textContent = '正在保存并检测地图…';
  let bridge, container;
  try {
    await saveMapSettings();
    container = document.createElement('div'); container.hidden = true; document.body.append(container);
    bridge = createAMapFrame(container); await bridge.request('check');
    message.textContent = '高德地图加载及地点查询正常。';
  } catch (error) { message.textContent = error.message; }
  finally { bridge?.destroy(); container?.remove(); button.disabled = false; save.disabled = false; }
});
document.getElementById('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('settings-save'), error = document.getElementById('settings-error');
  button.disabled = true; error.hidden = true;
  try {
    if (currentUser.role === 'admin') await saveMapSettings();
    const message = messageInput.value.trim() || defaultMessage;
    homeMessage.textContent = message; savePreference(storageKeys.message, message); closeSettings();
  } catch (failure) { error.textContent = failure.message; error.hidden = false; }
  finally { button.disabled = false; }
});


const passwordDialog = document.getElementById('password-dialog');
const passwordForm = document.getElementById('password-form');
const passwordError = document.getElementById('password-error');
let changingPassword = false;
function clearPasswords() { passwordForm.reset(); passwordError.hidden = true; }
function closePassword() {
  if (changingPassword) return;
  passwordDialog.hidden = true;
  clearPasswords();
  document.getElementById('settings-button').focus();
}
document.getElementById('open-user-management').addEventListener('click', () => { closeSettings(); renderCategory('users'); });

document.getElementById('open-password-change').addEventListener('click', () => {
  closeSettings();
  clearPasswords();
  passwordDialog.hidden = false;
  document.getElementById('current-password').focus();
});
document.getElementById('password-close').addEventListener('click', closePassword);
document.getElementById('password-cancel').addEventListener('click', closePassword);
passwordDialog.addEventListener('click', event => { if (event.target === passwordDialog) closePassword(); });
passwordDialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closePassword(); } });
passwordForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (changingPassword || !passwordForm.reportValidity()) return;
  passwordError.hidden = true;
  const input = Object.fromEntries(new FormData(passwordForm));
  if (input.newPassword !== input.confirmPassword) {
    passwordError.textContent = '两次新密码不一致';
    passwordError.hidden = false;
    return;
  }
  changingPassword = true;
  passwordForm.querySelectorAll('button').forEach(button => { button.disabled = true; });
  passwordForm.querySelectorAll('input').forEach(field => { field.readOnly = true; });
  try {
    const response = await fetch('/api/account/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify(input) });
    const result = await response.json();
    if (response.status === 401) { clearPasswords(); window.location.replace('/login'); return; }
    if (!response.ok) throw new Error(result.error || '无法修改密码，请重试');
    clearPasswords();
    window.location.replace('/login?passwordChanged=1');
  } catch (error) {
    passwordError.textContent = error.message;
    passwordError.hidden = false;
  } finally {
    changingPassword = false;
    passwordForm.querySelectorAll('button').forEach(button => { button.disabled = false; });
    passwordForm.querySelectorAll('input').forEach(field => { field.readOnly = false; });
  }
});
initTheme();

// Keep native scrolling and dragging, but only show each thumb while its area scrolls.
const scrollbarTimers = new WeakMap();
document.addEventListener('scroll', event => {
  const area = event.target === document ? document.documentElement : event.target;
  if (area !== document.documentElement && !area.matches?.('.archive-sidebar,.archive-content')) return;
  clearTimeout(scrollbarTimers.get(area));
  area.classList.add('is-scrolling');
  scrollbarTimers.set(area, setTimeout(() => {
    area.classList.remove('is-scrolling');
    scrollbarTimers.delete(area);
  }, 800));
}, { capture: true, passive: true });

document.getElementById('logout-button').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: '{}' });
  window.location.assign('/login');
});

updateHeaderProfile();
document.getElementById('user-pill').title = currentUser.role === 'admin' ? '管理员' : '普通用户 · 只读';
document.getElementById('account-role').textContent = `${currentUser.username} · ${currentUser.role === 'admin' ? '管理员' : '普通用户 · 只读'}`;

renderCategory('home');
