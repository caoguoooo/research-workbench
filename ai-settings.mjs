import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ArchiveError } from './competitor-store.mjs';

export function createAISettingsStore(dataRoot) {
  const filename = path.join(dataRoot, 'ai-settings.json');
  let queue = Promise.resolve();

  async function read() {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { baseUrl: '', token: '' }; throw error; }
  }

  function publicSettings(value) {
    return { baseUrl: value.baseUrl || '', hasToken: !!value.token };
  }

  return {
    // Server-only accessor. Never serialize its result into an HTTP response.
    async getCredentials() { return read(); },
    async getPublic() { return publicSettings(await read()); },
    save(input) {
      const pending = queue.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('设置格式不正确');
        const current = await read();
        const next = { ...current };
        if (input.baseUrl !== undefined && input.baseUrl !== '') {
          if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048) throw new ArchiveError('BASE_URL 格式不正确');
          let url;
          try { url = new URL(input.baseUrl.trim()); } catch { throw new ArchiveError('请填写完整的 BASE_URL'); }
          const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
          if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
            throw new ArchiveError('BASE_URL 需为 HTTPS 地址；本地接口可用 HTTP，地址中不能带账号、查询参数或片段');
          }
          next.baseUrl = url.href.replace(/\/$/, '');
          if (current.baseUrl && current.token && new URL(current.baseUrl).origin !== url.origin && !input.token) {
            throw new ArchiveError('更换接口地址时，请同时填写该接口的 TOKEN');
          }
        }
        if (input.token !== undefined && input.token !== '') {
          if (typeof input.token !== 'string' || input.token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(input.token)) throw new ArchiveError('TOKEN 格式不正确');
          next.token = input.token;
        }
        await mkdir(dataRoot, { recursive: true, mode: 0o700 });
        const temporary = `${filename}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, filename);
        return publicSettings(next);
      });
      queue = pending.catch(() => {});
      return pending;
    }
  };
}
