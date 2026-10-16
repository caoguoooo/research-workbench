export function createAMapFrame(container, { onReady = () => {}, onClick = () => {}, onStatus = () => {}, onError = () => {} } = {}) {
  const frame = document.createElement('iframe'); frame.className = 'amap-frame'; frame.title = '高德地图'; frame.src = '/amap-frame';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  let sequence = 0, disposed = false, failReady, finishReady;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { finishReady = resolve; failReady = reject; });
  ready.catch(() => {});
  const timer = setTimeout(() => failReady(new Error('高德地图加载超时，请刷新页面后重试。')), 25000);
  function receive(event) {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.source !== 'workbench-amap' || disposed) return;
    const data = event.data;
    if (data.type === 'ready') { clearTimeout(timer); finishReady(); onReady(); }
    if (data.type === 'click') onClick(data.location);
    if (data.type === 'status') onStatus(data.message);
    if (data.type === 'error') {
      if (!data.id) { clearTimeout(timer); failReady(new Error(data.message)); onError(data.message); }
      else { const entry = pending.get(data.id); if (entry) { clearTimeout(entry.timer); pending.delete(data.id); entry.reject(new Error(data.message)); } }
    }
    if (data.type === 'result') { const entry = pending.get(data.id); if (entry) { clearTimeout(entry.timer); pending.delete(data.id); entry.resolve(data.result); } }
  }
  window.addEventListener('message', receive); container.append(frame);
  async function send(type, data = {}) { await ready; if (!disposed) frame.contentWindow.postMessage({ source: 'workbench-parent', type, ...data }, location.origin); }
  return {
    ready,
    send(type, data) { send(type, data).catch(error => { if (!disposed) onError(error.message); }); },
    async request(type, data) {
      await ready; if (disposed) throw new Error('地图配置已更新，请重试。');
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('高德查询超时，请稍后重试。')); }, 80000);
        pending.set(id, { resolve, reject, timer });
        frame.contentWindow.postMessage({ source: 'workbench-parent', type, id, ...data }, location.origin);
      });
    },
    destroy() {
      disposed = true; clearTimeout(timer); failReady(new Error('地图配置已更新。'));
      window.removeEventListener('message', receive); frame.remove();
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('地图配置已更新，请重试。')); }
      pending.clear();
    }
  };
}
