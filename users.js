import { displayName, renderUserAvatar } from './profile.js';
const $ = id => document.getElementById(id);
const roleNames = { admin: '管理员', viewer: '普通用户' };
const statusNames = { pending: '待审核', active: '正常', disabled: '已停用' };
const node = (tag, className = '', text = '') => {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
};
async function request(url, input, method = 'PATCH') {
  const response = await fetch(url, { headers: { 'X-Workbench-Request': '1', ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { method, body: JSON.stringify(input) } : {}) });
  const result = await response.json();
  if (response.status === 401) window.location.replace('/login?expired=1');
  if (!response.ok) throw new Error(result.error || '用户管理暂不可用');
  return result;
}
export function lastLoginPresentation(value, now = Date.now()) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return { text: '暂无登录记录', title: '启用此功能后，将记录成功登录时间', dateTime: '' };
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  const units = [[365 * 86400, '年'], [30 * 86400, '个月'], [86400, '天'], [3600, '小时'], [60, '分钟']];
  const unit = units.find(([size]) => seconds >= size);
  return {
    text: unit ? `${Math.floor(seconds / unit[0])}${unit[1]}前` : '刚刚',
    title: '最后登录：' + new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(timestamp) + '（北京时间）',
    dateTime: new Date(timestamp).toISOString()
  };
}

function updateLoginTime(time, value) {
  const info = lastLoginPresentation(value);
  time.textContent = info.text;
  if (info.dateTime) time.dateTime = info.dateTime;
  time.title = info.title;
  time.setAttribute('aria-label', info.dateTime ? `${info.text}，${info.title}` : info.text);
}
function loginTimeNode(value) {
  const time = node('time', 'user-last-login');
  updateLoginTime(time, value);
  return time;
}
export function initUserManagement(currentUser, openProfile) {
  const view = $('users-view'), list = $('users-list'), error = $('users-error'), dialog = $('user-password-dialog'), form = $('user-password-form');
  const deleteDialog = $('delete-user-dialog'), deleteForm = $('delete-user-form');
  let deleting = null;
  let items = [], generation = 0, busy = false, target = null, timeRefresh = null;
  function message(value = '') { error.textContent = value; error.hidden = !value; }
  function select(values, selected, label) {
    const field = node('select'); field.setAttribute('aria-label', label);
    for (const [value, text] of Object.entries(values)) field.add(new Option(text, value));
    field.value = selected; return field;
  }
  async function update(username, input) {
    if (busy || currentUser.role !== 'admin') return;
    const version = generation; busy = true; message(); render();
    try {
      const { item } = await request(`/api/admin/users/${encodeURIComponent(username)}`, input);
      if (version !== generation) return;
      items = items.map(user => user.username === item.username ? item : user);
      $('users-notice').textContent = '用户设置已保存，相关账号需重新登录。';
    } catch (failure) { if (version === generation) message(failure.message); }
    finally { busy = false; if (version === generation) render(); else if (!view.hidden) load(); }
  }
  function render() {
    const query = $('users-search').value.trim().toLocaleLowerCase(), status = $('users-filter').value;
    $('users-count').textContent = `${items.length} 个用户 · ${items.filter(user => user.status === 'pending').length} 个待审核`;
    list.replaceChildren();
    for (const user of items.filter(user => (!query || `${user.username} ${user.nickname || ''}`.toLocaleLowerCase().includes(query)) && (!status || user.status === status))) {
      const row = node('form', 'user-row'); row.dataset.username = user.username;
      const identity = node('button', 'user-identity-button'); identity.type = 'button'; identity.disabled = busy;
      const avatar = node('span', 'user-avatar'); renderUserAvatar(avatar, user);
      const copy = node('span', 'user-identity'); copy.append(node('strong', '', displayName(user)));
      copy.append(loginTimeNode(user.lastLoginAt));
      if (user.nickname) copy.append(node('small', '', `账号：${user.username}`));
      identity.append(avatar, copy); identity.addEventListener('click', () => { if (!busy) openProfile(user); });
      const badges = [roleNames[user.role], statusNames[user.status]];
      if (user.primary) badges.push('初始管理员');
      if (user.username === currentUser.username) badges.push('当前账号');
      copy.append(node('small', '', badges.join(' · ')));
      const role = select(roleNames, user.role, `${user.username}的角色`), state = select(statusNames, user.status, `${user.username}的状态`);
      const actions = node('div', 'user-actions'), save = node('button', 'archive-secondary', user.status === 'pending' ? '批准注册' : '保存'); save.type = 'submit';
      if (user.status === 'pending') state.value = 'active';
      const reset = node('button', 'archive-text-button', '重设密码'); reset.type = 'button';
      const locked = user.primary || user.username === currentUser.username;
      for (const field of [role, state, save, reset]) field.disabled = busy || locked;
      const profile = node('button', 'archive-text-button', '编辑资料'); profile.type = 'button'; profile.disabled = busy;
      profile.addEventListener('click', () => { if (!busy) openProfile(user); });
      const remove = node('button', 'archive-text-button user-delete', '删除'); remove.type = 'button'; remove.disabled = busy || locked;
      remove.setAttribute('aria-label', `删除用户${user.username}`);
      remove.addEventListener('click', () => {
        if (busy || locked) return;
        deleting = user.username;
        $('delete-user-description').textContent = `确认删除“${displayName(user)}（${user.username}）”？删除后该账号无法登录，已归档的项目资料仍保留。`;
        $('delete-user-error').hidden = true; deleteDialog.showModal();
      });
      actions.append(save, profile, reset, remove); row.append(identity, role, state, actions);
      row.addEventListener('submit', event => { event.preventDefault(); if (!locked) update(user.username, { role: role.value, status: state.value }); });
      reset.addEventListener('click', () => {
        if (busy || locked) return;
        target = user.username; form.reset(); $('user-password-error').hidden = true;
        $('user-password-title').textContent = `重设 ${user.username} 的密码`;
        dialog.showModal(); form.elements.password.focus();
      });
      list.append(row);
    }
    if (!list.children.length) list.append(node('p', 'archive-hint', '没有匹配的用户。'));
  }
  async function load() {
    const version = ++generation; message(); $('users-notice').textContent = '';
    try {
      const result = await request('/api/admin/users');
      if (version !== generation) return;
      items = result.items; render();
    } catch (failure) { if (version === generation) message(failure.message); }
  }
  for (const id of ['users-search', 'users-filter']) $(id).addEventListener('input', render);
  $('users-refresh').addEventListener('click', () => { if (!busy) load(); });
  dialog.querySelectorAll('[data-close-user-password]').forEach(button => button.addEventListener('click', () => { if (!busy) dialog.close(); }));
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { form.reset(); target = null; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !target || !form.reportValidity()) return;
    const password = form.elements.password.value, confirm = form.elements.confirmPassword.value;
    if (password !== confirm) { $('user-password-error').textContent = '两次密码不一致'; $('user-password-error').hidden = false; return; }
    const username = target;
    form.querySelectorAll('input,button').forEach(field => { field.disabled = true; });
    await update(username, { password });
    form.querySelectorAll('input,button').forEach(field => { field.disabled = false; });
    form.reset();
    if (error.hidden) dialog.close();
    else { $('user-password-error').textContent = error.textContent; $('user-password-error').hidden = false; }
  });
  deleteDialog.querySelectorAll('[data-close-delete-user]').forEach(button => button.addEventListener('click', () => { if (!busy) deleteDialog.close(); }));
  deleteDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  deleteDialog.addEventListener('close', () => { deleting = null; });
  deleteForm.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !deleting) return;
    const username = deleting, version = generation; busy = true;
    deleteForm.querySelectorAll('button').forEach(button => { button.disabled = true; });
    render();
    try {
      await request(`/api/admin/users/${encodeURIComponent(username)}`, {}, 'DELETE');
      items = items.filter(user => user.username !== username);
      if (version === generation) $('users-notice').textContent = '用户已删除，原有登录已失效。';
      deleteDialog.close();
    } catch (failure) {
      if (version === generation) { $('delete-user-error').textContent = failure.message; $('delete-user-error').hidden = false; }
    } finally {
      busy = false; deleteForm.querySelectorAll('button').forEach(button => { button.disabled = false; });
      if (version === generation) render(); else if (!view.hidden) load();
    }
  });
  return {
    profileUpdated(profile) { items = items.map(user => user.username === profile.username ? { ...user, nickname: profile.nickname, avatarUrl: profile.avatarUrl } : user); if (!view.hidden) render(); },
    show() {
      if (currentUser.role !== 'admin') return;
      view.hidden = false; load();
      clearInterval(timeRefresh);
      timeRefresh = setInterval(() => { for (const time of list.querySelectorAll('.user-last-login')) updateLoginTime(time, time.dateTime); }, 60_000);
    },
    hide() { generation++; clearInterval(timeRefresh); timeRefresh = null; view.hidden = true; if (dialog.open) dialog.close(); if (deleteDialog.open) deleteDialog.close(); }
  };
}
