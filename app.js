import { initCompetitorArchive } from './competitor.js';
import { initAIChat } from './ai-chat.js';

initAIChat();

const categories = {
  policy: { title: '政策规范', index: '01 / RULES & POLICY', description: '按政策、规划与技术依据整理，方便追溯适用范围和版本。', subsections: ['政策文件', '规划条件', '技术规范', '官方解读'] },
  competitor: { title: '竞品档案', index: '02 / COMPETITOR FILES', description: '把竞品的基础信息、踩盘记录和产品变化放在一起。', subsections: ['项目概况', '踩盘记录', '价格动态', '产品户型', '图片影像'] },
  project: { title: '项目资料', index: '03 / INTERNAL PROJECTS', description: '围绕内部项目归集定位研究、方案设计和过程版本。', subsections: ['项目概况', '定位研究', '规划设计', '过程文件', '版本归档'] },
  assets: { title: '素材库', index: '04 / VISUAL ASSETS', description: '统一查找项目影像、地图、图纸和汇报素材。', subsections: ['航拍现场', '区位地图', '效果图', '图纸附件', '汇报素材'] }
};

const home = document.getElementById('home-view');
const detail = document.getElementById('category-view');
const detailList = document.getElementById('detail-subcategories');
const crumb = document.getElementById('current-crumb');
const sideLinks = [...document.querySelectorAll('.nav-link')];
const competitorArchive = initCompetitorArchive(() => renderCategory('home'));
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
    document.getElementById('detail-description').textContent = category.description;
    detailList.replaceChildren();
    category.subsections.forEach((name, index) => {
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
    selectSubsection(subsection);
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
  ...category.subsections.map(subsection => ({ key, title: subsection, subsection, group: category.title }))
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
  const available = Math.max(0, document.documentElement.clientHeight - top - 12);
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
    const { image } = await response.json();
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
loadHomeVisual();
setInterval(() => { if (!document.hidden) loadHomeVisual(); }, 15 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadHomeVisual(); });

const homeMessage = document.getElementById('home-message');
const messageInput = document.getElementById('message-input');
const settingsDialog = document.getElementById('settings-dialog');
const aiBaseUrl = document.getElementById('ai-base-url');
const aiToken = document.getElementById('ai-token');
const settingsError = document.getElementById('settings-error');
const settingsSave = document.getElementById('settings-save');
let settingsGeneration = 0;
let tokenChanged = false;
aiToken.addEventListener('input', () => { tokenChanged = true; });

async function settingsRequest(options = {}) {
  const response = await fetch('/api/settings/ai', { ...options, headers: { ...options.headers, 'X-Workbench-Request': '1' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '无法保存设置');
  return result;
}
homeMessage.textContent = readPreference(storageKeys.message, defaultMessage);
document.getElementById('settings-button').addEventListener('click', async () => {
  const generation = ++settingsGeneration;
  messageInput.value = homeMessage.textContent;
  aiBaseUrl.value = '';
  aiToken.value = '';
  tokenChanged = false;
  settingsError.hidden = true;
  settingsSave.disabled = true;
  aiBaseUrl.disabled = true;
  aiToken.disabled = true;
  settingsDialog.hidden = false;
  messageInput.focus();
  try {
    const saved = await settingsRequest();
    if (generation !== settingsGeneration) return;
    aiBaseUrl.value = saved.baseUrl;
    aiToken.value = saved.hasToken ? '********' : '';
    aiBaseUrl.disabled = false;
    aiToken.disabled = false;
    settingsSave.disabled = false;
  } catch (error) {
    if (generation !== settingsGeneration) return;
    settingsError.textContent = error.message;
    settingsError.hidden = false;
  }
});
function closeSettings() {
  ++settingsGeneration;
  settingsDialog.hidden = true;
  aiBaseUrl.value = '';
  aiToken.value = '';
  document.getElementById('settings-button').focus();
}
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-cancel').addEventListener('click', closeSettings);
settingsDialog.addEventListener('click', event => { if (event.target === settingsDialog) closeSettings(); });
settingsDialog.addEventListener('keydown', event => { if (event.key === 'Escape') closeSettings(); });
document.getElementById('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (settingsSave.disabled) return;
  const generation = settingsGeneration;
  settingsSave.disabled = true;
  settingsError.hidden = true;
  const input = { baseUrl: aiBaseUrl.value.trim() };
  if (tokenChanged) input.token = aiToken.value.trim();
  try {
    await settingsRequest({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    document.dispatchEvent(new Event('ai-settings-updated'));
    if (generation !== settingsGeneration) return;
    const message = messageInput.value.trim() || defaultMessage;
    homeMessage.textContent = message;
    savePreference(storageKeys.message, message);
    closeSettings();
  } catch (error) {
    if (generation !== settingsGeneration) return;
    settingsError.textContent = error.message;
    settingsError.hidden = false;
  } finally { if (generation === settingsGeneration) settingsSave.disabled = false; }
});

const themeToggle = document.getElementById('theme-toggle');
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.body.dataset.theme = dark ? 'dark' : 'light';
  themeToggle.textContent = dark ? '浅色' : '深色';
  themeToggle.setAttribute('aria-pressed', String(dark));
}
applyTheme(readPreference(storageKeys.theme, 'light'));
themeToggle.addEventListener('click', () => {
  const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  savePreference(storageKeys.theme, next);
});

document.getElementById('logout-button').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: '{}' });
  window.location.assign('/login');
});

fetch('/api/status').then(response => response.json()).then(status => {
  if (!status.authenticated) return window.location.replace('/login');
  document.getElementById('user-pill').textContent = status.username;
}).catch(() => {});

renderCategory('home');
