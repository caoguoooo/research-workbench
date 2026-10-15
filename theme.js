export function initTheme() {
  const buttons = [...document.querySelectorAll('[data-theme-toggle]')];
  function apply(theme, save = false) {
    const dark = theme === 'dark';
    document.body.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    for (const button of buttons) {
      button.setAttribute('aria-checked', String(dark));
      button.setAttribute('aria-label', dark ? '切换为亮色模式' : '切换为暗色模式');
      button.title = dark ? '切换为亮色模式' : '切换为暗色模式';
    }
    if (save) { try { localStorage.setItem('workbench-theme', dark ? 'dark' : 'light'); } catch {} }
  }
  let initial = 'light';
  try { initial = localStorage.getItem('workbench-theme') || localStorage.getItem('cyj-theme') || 'light'; } catch {}
  apply(initial);
  for (const button of buttons) {
    button.addEventListener('click', () => apply(document.body.dataset.theme === 'dark' ? 'light' : 'dark', true));
    button.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); apply(event.key === 'ArrowRight' ? 'dark' : 'light', true); }
    });
  }
  window.addEventListener('storage', event => { if (event.key === 'workbench-theme') apply(event.newValue); });
}
