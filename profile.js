const $ = id => document.getElementById(id);
export function displayName(user) { return user.nickname?.trim() || user.username; }
export function renderUserAvatar(container, user) {
  container.replaceChildren();
  const fallback = document.createElement('span'); fallback.textContent = [...displayName(user)][0]?.toLocaleUpperCase() || 'U'; container.append(fallback);
  if (user.avatarUrl) {
    const image = document.createElement('img'); image.alt = ''; image.src = user.avatarUrl;
    image.addEventListener('load', () => { fallback.hidden = true; });
    image.addEventListener('error', () => { image.hidden = true; fallback.hidden = false; });
    container.append(image);
  }
}
async function request(url, { method = 'GET', body, file } = {}) {
  const response = await fetch(url, { method, headers: { 'X-Workbench-Request': '1', ...(file ? { 'Content-Type': file.type || 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) }, ...(file ? { body: file } : body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (response.status === 401) window.location.replace('/login?expired=1');
  if (!response.ok) throw new Error(result.error || '个人资料保存失败');
  return result.profile;
}
export function initUserProfile(currentUser, onUpdated) {
  const dialog = $('profile-dialog'), form = $('profile-form'), error = $('profile-error'), fileInput = $('profile-avatar-input');
  let user = null, file = null, clear = false, previewUrl = '', busy = false;
  function message(text = '') { error.textContent = text; error.hidden = !text; }
  function releasePreview() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = ''; }
  function preview() {
    releasePreview();
    if (file) previewUrl = URL.createObjectURL(file);
    renderUserAvatar($('profile-avatar-preview'), { ...user, nickname: form.elements.nickname.value, avatarUrl: previewUrl || (clear ? '' : user.avatarUrl) });
  }
  function close() { if (!busy) dialog.close(); }
  dialog.querySelectorAll('[data-close-profile]').forEach(button => button.addEventListener('click', close));
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { releasePreview(); form.reset(); user = null; file = null; clear = false; message(); });
  fileInput.addEventListener('change', () => {
    const selected = fileInput.files[0]; if (!selected) return;
    if (selected.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) { message('请选择 5 MB 以内的 JPG、PNG 或 WebP 图片'); fileInput.value = ''; return; }
    file = selected; clear = false; message(); preview();
  });
  $('profile-avatar-clear').addEventListener('click', () => { file = null; clear = true; fileInput.value = ''; message(); preview(); });
  form.elements.nickname.addEventListener('input', preview);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !user || !form.reportValidity()) return;
    busy = true; message(); form.querySelectorAll('button,input').forEach(field => { field.disabled = true; });
    const own = user.username === currentUser.username;
    const base = own ? '/api/account' : `/api/admin/users/${encodeURIComponent(user.username)}`;
    try {
      let result = await request(`${base}/profile`, { method: 'PATCH', body: { nickname: form.elements.nickname.value.trim() } });
      user = { ...user, ...result }; onUpdated(user);
      if (file || clear) {
        result = await request(`${base}/avatar`, { method: file ? 'POST' : 'DELETE', ...(file ? { file } : {}) });
        user = { ...user, ...result }; onUpdated(user);
      }
      busy = false; close();
    } catch (failure) { message(failure.message); }
    finally { busy = false; form.querySelectorAll('button,input').forEach(field => { field.disabled = false; }); }
  });
  return {
    open(value = currentUser) {
      if (busy || value.username !== currentUser.username && currentUser.role !== 'admin') return;
      user = { ...value }; file = null; clear = false; form.reset(); message();
      $('profile-title').textContent = value.username === currentUser.username ? '个人资料' : '编辑用户资料';
      $('profile-username').textContent = `账号：${value.username}`;
      form.elements.nickname.value = value.nickname || ''; preview(); dialog.showModal(); form.elements.nickname.focus();
    }
  };
}
