const shell = document.getElementById('login-shell');
const trigger = document.getElementById('cyj-trigger');
const panel = document.getElementById('login-panel');
const form = document.getElementById('login-form');
const username = document.getElementById('username');
const password = document.getElementById('password');
const error = document.getElementById('form-error');
const submit = document.getElementById('login-submit');
const remember = document.getElementById('remember-login');
let setupRequired = false;

try {
  document.body.dataset.theme = (localStorage.getItem('workbench-theme') || localStorage.getItem('cyj-theme')) === 'dark' ? 'dark' : 'light';
} catch {
  document.body.dataset.theme = 'light';
}

function setError(message) {
  error.textContent = message;
  error.hidden = !message;
}

function openForm() {
  shell.classList.add('is-open');
  trigger.setAttribute('aria-expanded', 'true');
  trigger.hidden = true;
  panel.hidden = false;
  username.focus();
}

function closeForm() {
  shell.classList.remove('is-open');
  trigger.setAttribute('aria-expanded', 'false');
  panel.hidden = true;
  trigger.hidden = false;
  setError('');
  trigger.focus();
}

async function loadStatus() {
  try {
    const response = await fetch('/api/status');
    const status = await response.json();
    if (status.authenticated) {
      window.location.replace('/app');
      return;
    }
    setupRequired = status.setupRequired;
    password.required = !status.passwordOptional;
    password.minLength = status.passwordOptional ? 0 : 8;
    password.placeholder = status.passwordOptional ? '可留空' : '输入密码';
    if (!setupRequired && new URLSearchParams(window.location.search).get('expired') === '1') {
      openForm();
      const notice = document.getElementById('login-desc');
      notice.textContent = '登录已失效，请重新登录。';
      notice.hidden = false;
      window.history.replaceState(null, '', '/login');
    }
    if (!setupRequired && new URLSearchParams(window.location.search).get('passwordChanged') === '1') {
      openForm();
      const notice = document.getElementById('login-desc');
      notice.textContent = '密码已修改，请重新登录。';
      notice.hidden = false;
      window.history.replaceState(null, '', '/login');
    }
    if (setupRequired) {
      document.getElementById('login-title').textContent = '创建账号';
      const description = document.getElementById('login-desc');
      description.textContent = status.passwordOptional ? '首次使用，请创建账号，密码可留空。' : '首次使用，请设置至少 8 位密码。';
      description.hidden = false;
      submit.textContent = 'Create account';
      password.autocomplete = 'new-password';
    }
  } catch {
    setError('无法连接服务，请确认服务已启动。');
  }
}

trigger.addEventListener('click', openForm);
document.getElementById('login-back').addEventListener('click', closeForm);
document.getElementById('show-password').addEventListener('click', event => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  event.currentTarget.textContent = visible ? '隐藏' : '显示';
  event.currentTarget.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !panel.hidden) closeForm();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  setError('');
  if (!form.reportValidity()) return;
  submit.disabled = true;
  try {
    const response = await fetch(setupRequired ? '/api/setup' : '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value, remember: remember.checked })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作失败，请重试');
    if (setupRequired) {
      setupRequired = false;
      const loginResponse = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' },
        body: JSON.stringify({ username: username.value.trim(), password: password.value, remember: remember.checked })
      });
      if (!loginResponse.ok) throw new Error('账号已创建，请重新登录');
    }
    window.location.assign('/app');
  } catch (failure) {
    setError(failure.message);
  } finally {
    submit.disabled = false;
  }
});

loadStatus();
