import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../research-tasks.js', import.meta.url), 'utf8'))
  .replace('export function initResearchTasks', 'function initResearchTasks');
const html = await readFile(new URL('../app.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// 只实现研究面板实际使用的 DOM；禁止 innerHTML，避免把不安全渲染误判为文本。
class Node {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = this.disabled = this.checked = this.readOnly = false;
    this.type = this.tagName === 'INPUT' ? 'text' : '';
    this.name = this.className = this._value = this._text = '';
    this._selected = null;
  }
  get children() { return this.childNodes.filter(node => node.tagName !== '#TEXT'); }
  get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
  get selectedIndex() { return this.options.indexOf(this._selected); }
  get value() { return this.tagName === 'SELECT' ? this._selected?.value ?? '' : this._value; }
  set value(value) {
    if (this.tagName === 'SELECT') this._selected = this.options.find(option => option.value === String(value)) ?? null;
    else this._value = String(value);
  }
  get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(_) { throw new Error('研究 UI 不得使用 innerHTML 渲染代理内容'); }
  append(...nodes) {
    this.childNodes.push(...nodes.map(node => typeof node === 'string' ? textNode(node) : node));
    if (this.tagName === 'SELECT' && !this._selected) this._selected = this.options[0] ?? null;
  }
  replaceChildren(...nodes) { this.childNodes = []; this._text = ''; this._selected = null; this.append(...nodes); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    const property = { readonly: 'readOnly', class: 'className' }[name] || name;
    this[property] = ['hidden', 'disabled', 'readonly', 'checked', 'required', 'open'].includes(name) ? true : String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  async emit(type) {
    if (type === 'click' && this.disabled) return;
    await Promise.all((this.listeners.get(type) || []).map(listener => listener({
      target: this, currentTarget: this, preventDefault() {}
    })));
  }
  click() { return this.emit('click'); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  querySelectorAll(selector) {
    const matches = node => {
      const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
      const className = selector.match(/\.([\w-]+)/)?.[1];
      const name = selector.match(/\[name="([^"]+)"\]/)?.[1];
      return (!tag || node.tagName === tag.toUpperCase()) &&
        (!className || node.className.split(/\s+/).includes(className)) &&
        (!name || node.name === name) && (!selector.endsWith(':checked') || node.checked);
    };
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
function textNode(text) { const node = new Node('#text'); node.textContent = text; return node; }
function option(text, value) { const node = new Node('option'); node.textContent = text; node.value = value; return node; }

function fixture() {
  const ids = new Map(), root = new Node('main'), stack = [root];
  const section = html.slice(html.indexOf('<section id="research-view"'), html.indexOf('<section id="category-view"'));
  for (const token of section.matchAll(/<\/([\w-]+)\s*>|<([\w-]+)([^>]*)>|([^<]+)/g)) {
    if (token[1]) { stack.pop(); continue; }
    if (token[4]) { stack.at(-1).append(textNode(token[4])); continue; }
    const node = new Node(token[2]);
    for (const attr of token[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '');
    if (node.id) ids.set(node.id, node);
    stack.at(-1).append(node);
    if (!['INPUT', 'BR', 'HR', 'IMG'].includes(node.tagName)) stack.push(node);
  }
  const form = ids.get('research-create');
  form.elements = Object.fromEntries(form.querySelectorAll('input').concat(form.querySelectorAll('select'), form.querySelectorAll('textarea')).map(node => [node.name, node]));
  return { ids, document: { getElementById: id => ids.get(id) ?? null, createElement: tag => new Node(tag), createTextNode: textNode } };
}

const task = (id, extra = {}) => ({
  id, name: `楼盘 ${id}`, city: '成都', status: 'pending', targetId: '', instructions: '',
  createdAt: '2026-10-14T00:00:00Z', expiresAt: '2026-10-21T00:00:00Z', ...extra
});
const project = { id: 'project-1', name: '已有楼盘', city: '重庆' };
const token = 'test-only-credential-not-a-real-secret';
function harness({ tasks = [task('existing')], projects = [project], route, hermes } = {}) {
  const { ids, document } = fixture();
  const state = { tasks, projects, hermes }, calls = [], copied = [], timers = [];
  const clipboard = { writeText: async value => { copied.push(value); } };
  const context = vm.createContext({
    setInterval: callback => { timers.push(callback); return timers.length; },
    document, Option: option,
    FormData: class {
      constructor(form) { this.entries = Object.values(form.elements).filter(node => node.name && !node.disabled).map(node => [node.name, node.value]); }
      [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
    },
    location: { origin: 'http://127.0.0.1:3000' }, navigator: { clipboard },
    window: { confirm: () => true, location: { replace: () => assert.fail('不应发生登录跳转') } },
    fetch: async (url, init) => {
      assert.ok(['/api/research-tasks', '/api/competitors'].includes(url) || /^\/api\/research-tasks\/[^/]+\/(review|dispatch)$/.test(url), `未模拟的请求：${url}`);
      assert.equal(init.headers['X-Workbench-Request'], '1');
      const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      let result;
      if (route) result = await route(call, state);
      if (result === undefined) {
        if (url === '/api/competitors') result = { items: state.projects };
        else if (init.method === 'GET') result = { items: state.tasks, hermes:state.hermes };
        else {
          const created = task('created', call.body);
          state.tasks = [created, ...state.tasks];
          result = { task: created, token };
        }
      }
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    }
  });
  vm.runInContext(`${source}\nglobalThis.initResearchTasks = initResearchTasks;`, context, { filename: 'research-tasks.js' });
  const api = context.initResearchTasks(() => assert.fail('不应打开档案'));
  const get = id => { assert.ok(ids.has(id), `app.html 缺少 #${id}`); return ids.get(id); };
  return {
    api, get, state, calls, copied, clipboard, timers,
    async show() { api.show(); await tick(); },
    async click(id) { await get(id).click(); await tick(); },
    async create() {
      get('research-create').elements.name.value = '新建楼盘';
      get('research-create').elements.city.value = '成都';
      await get('research-create').emit('submit'); await tick();
      assert.equal(get('research-error').hidden, true, get('research-error').textContent);
    }
  };
}
function assertCleared(ui) {
  assert.equal(ui.get('research-token').value, '', '隐藏后不得保留凭据');
  assert.equal(ui.get('research-credentials').hidden, true);
  assert.equal(ui.get('research-token').type, 'password');
  assert.equal(ui.get('research-toggle-token').textContent, '显示凭据');
}

test('show 加载 tasks/projects，差异默认未选，代理内容仅作为文本，来源链接隔离 opener', async () => {
  const payload = '<img src=x onerror="alert(1)">';
  const submitted = task('submitted', {
    status: 'submitted', name: payload, instructions: payload,
    baseline: { summary: payload, aiResearch: { report: payload } },
    result: { project: { summary: payload, developer: '代理开发商' }, report: payload, sources: [{ title: payload, url: 'https://example.com/source' }] }
  });
  const ui = harness({ tasks: [submitted] });
  await ui.show();
  assert.equal(ui.get('research-view').hidden, false);
  assert.deepEqual(ui.calls.map(({ url, method }) => [url, method]), [['/api/research-tasks', 'GET'], ['/api/competitors', 'GET']]);
  assert.equal(ui.get('research-count').textContent, '1 个任务 · 1 个待审核');
  assert.deepEqual(ui.get('research-target').options.map(node => node.value), ['', project.id]);
  const detail = ui.get('research-detail');
  const fields = detail.querySelectorAll('input[name="fields"]');
  assert.equal(fields.length, 2);
  assert.deepEqual(fields.map(node => node.value), ['summary', 'developer']);
  for (const checkbox of detail.querySelectorAll('input')) {
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, false);
  }
  assert.equal(detail.querySelector('h2').textContent, payload);
  assert.ok(detail.querySelectorAll('p').some(node => node.textContent === payload));
  assert.ok(detail.querySelectorAll('span').some(node => node.textContent === `提交：${payload}（无变化）`));
  assert.equal(detail.querySelectorAll('img').length, 0);
  const link = detail.querySelector('a');
  assert.equal(link.textContent, payload);
  assert.equal(link.href, 'https://example.com/source');
  assert.equal(link.target, '_blank');
  assert.deepEqual(link.rel.split(/\s+/).sort(), ['noopener', 'noreferrer']);
});

test('创建任务提交表单，返回凭据默认 password 且只读', async () => {
  const ui = harness(); await ui.show(); await ui.create();
  assert.deepEqual(ui.calls.at(-1).body, { targetId: '', name: '新建楼盘', city: '成都', instructions: '' });
  assert.equal(ui.get('research-token').value, token);
  assert.equal(ui.get('research-token').type, 'password');
  assert.equal(ui.get('research-token').readOnly, true);
  assert.equal(ui.get('research-credentials').hidden, false);
  assert.equal(ui.get('research-create-panel').open, false);
});

for (const choice of ['none', 'summary', 'report']) {
  test(`审核选择 ${choice}：仅提交勾选内容，未选择时留在页面提示`, async () => {
    const submitted = task('submitted', {
      status: 'submitted',
      result: { project: { summary: '新概况', developer: '不选中的开发商' }, report: '新报告', sources: [] }
    });
    const ui = harness({ tasks: [submitted], route: call => {
      if (call.url.endsWith('/review')) return { task: { ...submitted, status: 'approved', savedId: 'saved-project' } };
    } });
    await ui.show();
    const form = ui.get('research-detail').querySelector('form');
    const fields = form.querySelectorAll('input[name="fields"]');
    if (choice === 'summary') fields[0].checked = true;
    if (choice === 'report') form.querySelector('input[name="includeReport"]').checked = true;
    form.querySelectorAll('input').find(input => input.required).checked = true;
    await form.emit('submit'); await tick();
    const writes = ui.calls.filter(call => call.method === 'POST');
    if (choice === 'none') {
      assert.equal(writes.length, 0);
      assert.equal(ui.get('research-error').hidden, false);
      assert.match(ui.get('research-error').textContent, /至少勾选/);
    } else {
      assert.equal(writes.length, 1);
      assert.equal(writes[0].url, '/api/research-tasks/submitted/review');
      assert.deepEqual(writes[0].body, { action: 'approve', fields: choice === 'summary' ? ['summary'] : [], includeReport: choice === 'report' });
      assert.equal(ui.get('research-detail').querySelectorAll('input').every(input => input.disabled), true);
    }
  });
}

test('切换另一任务清空凭据并隐藏 credentials', async () => {
  const ui = harness(); await ui.show(); await ui.create();
  await ui.get('research-list').querySelectorAll('button')[1].click();
  assert.equal(ui.get('research-detail').querySelector('h2').textContent, '楼盘 existing');
  assert.equal(ui.get('research-token').value, '', '切换任务仍保留上一任务 token');
  assert.equal(ui.get('research-credentials').hidden, true);
});

test('显示凭据按钮切换 password/text 和显示凭据/隐藏凭据文案', async () => {
  const ui = harness(); await ui.show(); await ui.create();
  assert.equal(ui.get('research-toggle-token').textContent, '显示凭据');
  await ui.click('research-toggle-token');
  assert.equal(ui.get('research-token').type, 'text');
  assert.equal(ui.get('research-toggle-token').textContent, '隐藏凭据');
  assert.equal(ui.get('research-token').value, token);
  await ui.click('research-toggle-token');
  assert.equal(ui.get('research-token').type, 'password');
  assert.equal(ui.get('research-toggle-token').textContent, '显示凭据');
});

for (const mode of ['clear', 'hide']) {
  test(`${mode} 清空已显示的 token，并重置 password 与按钮文案`, async () => {
    const ui = harness(); await ui.show(); await ui.create();
    await ui.click('research-toggle-token');
    assert.equal(ui.get('research-token').type, 'text');
    if (mode === 'clear') await ui.click('research-hide-token');
    else ui.api.hide();
    assertCleared(ui);
    if (mode === 'hide') assert.equal(ui.get('research-view').hidden, true);
  });
}

test('剪贴板成功复制当前凭据', async () => {
  const ui = harness(); await ui.show(); await ui.create();
  await ui.click('research-copy-token');
  assert.deepEqual(ui.copied, [token]);
  assert.match(ui.get('research-copy-token').textContent, /已复制/);
});

test('clipboard 异步成功前 hide，不更新复制按钮、不恢复旧凭据', async () => {
  const ui = harness(); await ui.show(); await ui.create();
  const pending = deferred();
  ui.clipboard.writeText = value => { assert.equal(value, token); return pending.promise; };
  const copying = ui.get('research-copy-token').click();
  ui.api.hide();
  const label = ui.get('research-copy-token').textContent;
  pending.resolve(); await copying; await tick();
  assert.equal(ui.get('research-copy-token').textContent, label, '已隐藏页面被过期 clipboard 回调更新');
  assert.equal(ui.get('research-token').value, '');
  assert.equal(ui.get('research-credentials').hidden, true);
});

test('clipboard 失败提示点击显示凭据手动复制，不自动明文显示', async () => {
  const ui = harness(); await ui.show(); await ui.create();
  ui.clipboard.writeText = async () => { throw new Error('clipboard denied'); };
  await ui.click('research-copy-token');
  assert.equal(ui.get('research-error').hidden, false);
  assert.match(ui.get('research-error').textContent, /显示凭据/);
  assert.match(ui.get('research-error').textContent, /手动复制/);
  assert.equal(ui.get('research-token').type, 'password');
  await ui.click('research-toggle-token');
  assert.equal(ui.get('research-token').type, 'text');
  assert.equal(ui.get('research-token').value, token);
});

test('clipboard 异步失败前 hide，不显示过期错误或聚焦旧凭据', async () => {
  const ui = harness(); await ui.show(); await ui.create();
  const pending = deferred();
  ui.clipboard.writeText = () => pending.promise;
  const copying = ui.get('research-copy-token').click();
  ui.api.hide(); pending.reject(new Error('clipboard denied'));
  await copying; await tick();
  assert.equal(ui.get('research-error').hidden, true);
  assert.notEqual(ui.get('research-token').focused, true);
  assert.equal(ui.get('research-token').value, '');
});

test('更新目标被 refresh 移除，select 回退空值，name/city 取消只读并清空', async () => {
  const ui = harness(); await ui.show();
  const select = ui.get('research-target'), fields = ui.get('research-create').elements;
  select.value = project.id; await select.emit('change');
  assert.equal(fields.name.value, project.name);
  assert.equal(fields.city.value, project.city);
  assert.equal(fields.name.readOnly, true);
  assert.equal(fields.city.readOnly, true);
  ui.state.projects = [];
  await ui.click('research-refresh');
  assert.equal(select.value, '');
  assert.equal(select.selectedIndex, 0);
  for (const key of ['name', 'city']) {
    assert.equal(fields[key].readOnly, false, `${key} 在目标移除后仍只读`);
    assert.equal(fields[key].value, '', `${key} 在目标移除后仍保留旧档案内容`);
  }
});

test('没有更新目标时 refresh 保留普通新建草稿', async () => {
  const ui = harness(); await ui.show();
  const fields = ui.get('research-create').elements;
  fields.name.value = '未提交草稿'; fields.city.value = '绵阳'; fields.instructions.value = '保留研究要求';
  await ui.click('research-refresh');
  assert.equal(ui.get('research-target').value, '');
  assert.equal(fields.name.value, '未提交草稿');
  assert.equal(fields.city.value, '绵阳');
  assert.equal(fields.instructions.value, '保留研究要求');
  assert.equal(fields.name.readOnly, false);
  assert.equal(fields.city.readOnly, false);
});

test('刷新保留仍存在的更新目标，并从新 options 重新应用档案字段', async () => {
  const ui = harness(); await ui.show();
  const select = ui.get('research-target'), fields = ui.get('research-create').elements;
  select.value = project.id; await select.emit('change');
  ui.state.projects = [{ ...project, name: '更新后的名称', city: '德阳' }];
  await ui.click('research-refresh');
  assert.equal(select.value, project.id);
  assert.equal(fields.name.value, '更新后的名称');
  assert.equal(fields.city.value, '德阳');
  assert.equal(fields.name.readOnly, true);
});

test('hide→show 使旧加载失效；perform 完成后重新加载，不污染新页面', async () => {
  const oldTasks = deferred(), oldProjects = deferred(), newTasks = deferred(), newProjects = deferred();
  const queues = { '/api/research-tasks': [oldTasks, newTasks], '/api/competitors': [oldProjects, newProjects] };
  const ui = harness({ route: ({ url, method }) => {
    assert.equal(method, 'GET');
    const next = queues[url].shift();
    assert.ok(next, `重复发起了非预期加载：${url}`);
    return next.promise;
  } });
  ui.api.show();
  assert.equal(ui.calls.length, 2);
  ui.api.hide(); ui.api.show();
  assert.equal(ui.calls.length, 2, 'busy 时应由旧 perform 完成后补载');
  oldTasks.resolve({ items: [task('stale')] });
  oldProjects.resolve({ items: [{ id: 'stale-project', name: '过期档案', city: '旧城' }] });
  await tick();
  assert.equal(ui.calls.length, 4, 'generation 变化后没有补载新页面');
  assert.equal(ui.get('research-list').textContent.includes('stale'), false);
  assert.deepEqual(ui.get('research-target').options.map(node => node.value), ['']);
  newTasks.resolve({ items: [task('fresh')] });
  newProjects.resolve({ items: [project] });
  await tick();
  assert.equal(ui.get('research-view').hidden, false);
  assert.equal(ui.get('research-detail').querySelector('h2').textContent, '楼盘 fresh');
  assert.deepEqual(ui.get('research-target').options.map(node => node.value), ['', project.id]);
  assert.equal(ui.get('research-view').getAttribute('aria-busy'), null);
  assert.ok(ui.get('research-view').querySelectorAll('button').every(node => !node.disabled));
});

test('connected Hermes shows automatic dispatch and refreshes pending tasks without exposing credentials', async () => {
  const ui = harness({ hermes:{ enabled:true,online:true } });
  await ui.show();
  assert.match(ui.get('research-count').textContent,/Hermes 已连接/);
  await ui.create();
  assert.equal(ui.get('research-credentials').hidden,true);
  const count = ui.calls.length;
  ui.timers[0](); await tick();
  assert.ok(ui.calls.length > count);
  ui.api.hide();
  const hiddenCount = ui.calls.length;
  ui.timers[0](); await tick();
  assert.equal(ui.calls.length,hiddenCount);
});
