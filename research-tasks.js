const labels = { name:'楼盘名称',city:'城市',district:'区域',address:'地址',developer:'开发商',status:'销售状态',positioning:'项目定位',summary:'项目概况' };
const statuses = { pending:'待执行',submitted:'待审核',approved:'已入库',rejected:'已拒绝 / 撤销' };
const $ = id => document.getElementById(id);
function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
async function request(url, body) {
  const response = await fetch(url,{ method:body ? 'POST' : 'GET',headers:{ 'X-Workbench-Request':'1',...(body ? { 'Content-Type':'application/json' } : {}) },...(body ? { body:JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (response.status === 401) window.location.replace('/login?expired=1');
  if (!response.ok) throw new Error(result.error || '研究任务请求失败');
  return result;
}
export function initResearchTasks(openArchive) {
  const view = $('research-view');
  const form = $('research-create');
  const targetSelect = $('research-target');
  const detail = $('research-detail');
  const error = $('research-error');
  let tasks = [], projects = [], selectedId = null, busy = false, generation = 0, tokenTaskId = null;
  function clearToken() {
    tokenTaskId = null;
    $('research-token').value = '';
    $('research-token').type = 'password';
    $('research-credentials').hidden = true;
    $('research-copy-token').textContent = '复制凭据';
    $('research-toggle-token').textContent = '显示凭据';
    $('research-toggle-token').setAttribute('aria-pressed','false');
  }
  function showToken(token, taskId) {
    clearToken();
    tokenTaskId = taskId;
    $('research-token').value = token;
    $('research-credentials').hidden = false;
    $('research-copy-token').textContent = '复制凭据';
    $('research-address').textContent = `当前浏览器地址：${location.origin}。Hermes 容器应使用可到达工作台的 HTTPS 地址，或同 Docker 私有网络中的服务名与端口；不能使用容器自己的 127.0.0.1。不要把任务凭据加入 URL。`;
  }
  async function perform(action) {
    if (busy) return;
    const current = generation;
    busy = true;
    error.hidden = true;
    view.setAttribute('aria-busy','true');
    view.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await action(current); }
    catch (failure) { if (current === generation) { error.textContent = failure.message; error.hidden = false; } }
    finally {
      busy = false;
      view.removeAttribute('aria-busy');
      view.querySelectorAll('button').forEach(button => { button.disabled = false; });
      if (current !== generation && !view.hidden) perform(load);
    }
  }
  function updateTarget() {
    const project = projects.find(item => item.id === targetSelect.value);
    for (const key of ['name','city']) {
      form.elements[key].readOnly = !!project;
      form.elements[key].value = project?.[key] || '';
    }
  }
  function renderList() {
    const list = $('research-list');
    list.replaceChildren();
    $('research-count').textContent = `${tasks.length} 个任务 · ${tasks.filter(task => task.status === 'submitted').length} 个待审核`;
    for (const task of tasks) {
      const button = element('button','research-task');
      button.type = 'button';
      button.setAttribute('aria-pressed',String(task.id === selectedId));
      button.append(element('strong','',`${task.city} · ${task.name}`),element('span','archive-hint',`${statuses[task.status]} · ${task.targetId ? '更新档案' : '新建档案'}`));
      button.addEventListener('click',() => { if (!busy) { selectedId = task.id; renderList(); renderDetail(); } });
      list.append(button);
    }
    if (!tasks.length) list.append(element('p','archive-hint','暂无任务。创建后将接入凭据交给 Hermes。'));
  }
  async function review(task, body) {
    await perform(async current => {
      const result = await request(`/api/research-tasks/${task.id}/review`,body);
      if (current !== generation) return;
      tasks = tasks.map(item => item.id === task.id ? result.task : item);
      renderList();
      renderDetail();
      clearToken();
    });
  }
  function renderDetail() {
    detail.replaceChildren();
    const task = tasks.find(item => item.id === selectedId);
    if (!task || task.id !== tokenTaskId || task.status !== 'pending') clearToken();
    if (!task) { detail.append(element('p','archive-hint','选择任务查看状态、资料来源与新旧差异。')); return; }
    detail.append(element('h2','',task.name),element('p','archive-hint',`${task.city} · ${statuses[task.status]} · 创建于 ${task.createdAt.slice(0,10)}`),element('p','archive-prose',task.instructions || '核对公开楼盘资料、信息日期与来源，列明冲突和待补充项。'));
    if (task.status === 'pending') {
      detail.append(element('p','archive-hint',`凭据有效至 ${task.expiresAt.slice(0,10)}；到期后可重发。创建任务不会自动启动 Hermes，需要在其侧配置执行。`));
      const rotate = element('button','archive-secondary','重发接入凭据'); rotate.type = 'button';
      rotate.addEventListener('click',() => perform(async current => {
        const result = await request(`/api/research-tasks/${task.id}/token`,{});
        if (current !== generation) return;
        tasks = tasks.map(item => item.id === task.id ? result.task : item);
        showToken(result.token,task.id);
        renderDetail();
      }));
      detail.append(rotate);
    }
    if (task.result) {
      detail.append(element('p','archive-hint','以下内容由外部代理提交，工作台未独立核验。请核对来源、项目归属及信息日期，再选择要保存的字段。未勾选的字段保持原值。'));
      const reviewForm = element('form','research-review');
      const table = element('div','research-diff');
      for (const [key,value] of Object.entries(task.result.project)) {
        if (!Object.hasOwn(labels,key)) continue;
        const row = element('label','research-diff-row');
        const input = document.createElement('input');
        input.type = 'checkbox'; input.name = 'fields'; input.value = key;
        input.disabled = task.status !== 'submitted';
        const before = task.baseline?.[key] || '';
        row.append(input,element('strong','',labels[key]),element('span','archive-prose',`原值：${before || '（空）'}`),element('span','archive-prose',`提交：${value || '（清空）'}${before === value ? '（无变化）' : ''}`));
        table.append(row);
      }
      reviewForm.append(table);
      const reportChoice = element('label','research-check');
      const includeReport = document.createElement('input'); includeReport.type = 'checkbox'; includeReport.name = 'includeReport'; includeReport.disabled = task.status !== 'submitted';
      reportChoice.append(includeReport,document.createTextNode('保存本次研究报告与来源（替换当前报告，旧报告留存于历史）'));
      reviewForm.append(reportChoice);
      const reports = element('div','research-reports');
      const oldReport = element('details','archive-section'); oldReport.append(element('summary','','原研究报告'),element('p','archive-prose',task.baseline?.aiResearch?.report || '暂无报告'));
      const newReport = element('section','archive-section'); newReport.append(element('h3','','本次提交'),element('p','archive-prose',task.result.report));
      reports.append(oldReport,newReport); reviewForm.append(reports);
      const sources = element('ol','archive-ai-sources');
      for (const source of task.result.sources) {
        const li = element('li');
        const link = element('a','',source.title);
        link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        li.append(link); sources.append(li);
      }
      reviewForm.append(element('h3','','代理提供的来源'),sources);
      if (task.status === 'submitted') {
        const confirm = element('label','research-check');
        const checked = document.createElement('input'); checked.type = 'checkbox'; checked.required = true;
        confirm.append(checked,document.createTextNode('已核对来源和新旧差异，确认保存勾选内容。'));
        const approve = element('button','archive-primary','批准所选变更'); approve.type = 'submit';
        reviewForm.append(confirm,approve);
        reviewForm.addEventListener('submit',event => {
          event.preventDefault();
          const fields = [...reviewForm.querySelectorAll('input[name="fields"]:checked')].map(input => input.value);
          if (!fields.length && !includeReport.checked) {
            error.textContent = '请至少勾选一个变更字段或保存研究报告。'; error.hidden = false;
            return;
          }
          review(task,{ action:'approve',fields,includeReport:includeReport.checked });
        });
      }
      detail.append(reviewForm);
    }
    if (['pending','submitted'].includes(task.status)) {
      const reject = element('button','archive-secondary research-reject','拒绝 / 撤销任务'); reject.type = 'button';
      reject.addEventListener('click',() => { if (window.confirm('撤销后凭据立即失效，已提交结果保留但不入库。继续？')) review(task,{ action:'reject' }); });
      detail.append(reject);
    }
    if (task.savedId) {
      const open = element('button','archive-primary','打开已保存档案'); open.type = 'button';
      open.addEventListener('click',() => openArchive(task.savedId)); detail.append(open);
    }
  }
  async function load(current) {
    const [result,archive] = await Promise.all([request('/api/research-tasks'),request('/api/competitors')]);
    if (current !== generation) return;
    tasks = result.items; projects = archive.items;
    const previous = targetSelect.value;
    targetSelect.replaceChildren(new Option('研究新楼盘',''));
    for (const project of projects) targetSelect.append(new Option(`更新：${project.city || '城市待补充'} · ${project.name}`,project.id));
    if (projects.some(item => item.id === previous)) targetSelect.value = previous;
    if (previous) updateTarget();
    if (!tasks.some(task => task.id === selectedId)) selectedId = tasks[0]?.id || null;
    renderList(); renderDetail();
  }
  targetSelect.addEventListener('change',updateTarget);
  form.addEventListener('submit',event => {
    event.preventDefault();
    perform(async current => {
      const input = Object.fromEntries(new FormData(form));
      const result = await request('/api/research-tasks',input);
      if (current !== generation) return;
      selectedId = result.task.id;
      tasks.unshift(result.task);
      renderList(); renderDetail(); showToken(result.token,result.task.id);
      $('research-create-panel').open = false;
    });
  });
  $('research-refresh').addEventListener('click',() => perform(load));
  $('research-hide-token').addEventListener('click',clearToken);
  $('research-toggle-token').addEventListener('click',() => {
    const visible = $('research-token').type === 'password';
    $('research-token').type = visible ? 'text' : 'password';
    $('research-toggle-token').textContent = visible ? '隐藏凭据' : '显示凭据';
    $('research-toggle-token').setAttribute('aria-pressed',String(visible));
  });
  $('research-copy-token').addEventListener('click',async () => {
    const token = $('research-token').value, current = generation;
    const active = () => current === generation && !view.hidden && $('research-token').value === token;
    try { await navigator.clipboard.writeText(token); if (active()) $('research-copy-token').textContent = '已复制（请勿公开分享）'; }
    catch { if (active()) { error.textContent = '浏览器未开放剪贴板权限，请点击“显示凭据”后手动复制，或通过 HTTPS 打开。'; error.hidden = false; $('research-token').focus(); $('research-token').select(); } }
  });
  return {
    show() { view.hidden = false; perform(load); },
    hide() { if (!view.hidden) generation++; view.hidden = true; clearToken(); }
  };
}
