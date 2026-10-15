import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const safeImage = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(value);
export async function changeRelease(directory, action, input = {}) {
  const override = path.join(directory, 'release.yaml');
  let state = null;
  try { const raw = await readFile(override, 'utf8');
    const line = raw.split('\n').find(line => line.startsWith('x-workbench-release: '));
    if (!line) throw new Error('版本配置不是由升级工具创建，不能覆盖');
    state = JSON.parse(line.slice('x-workbench-release: '.length)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (action === 'activate') {
    if (!/^\d+\.\d+\.\d+$/.test(input.version) || !safeImage(input.image) || !safeImage(input.previousImage) || typeof input.backup !== 'string' || input.backup.length > 1024) throw new Error('升级状态格式不正确');
    if (state && state.current.image !== input.previousImage) throw new Error('当前镜像与升级记录不一致，请先核对现场配置');
    if (state?.current.version === input.version) throw new Error('已经是该版本');
    state = { version: 1, current: { version: input.version, image: input.image, dataSchema: 1 }, previous: state?.current || { version: 'legacy', image: input.previousImage, dataSchema: 1 }, backup: input.backup, changedAt: new Date().toISOString() };
  } else if (action === 'rollback' || action === 'previous') {
    if (!state?.previous || state.previous.dataSchema !== state.current?.dataSchema || state.current.dataSchema !== 1 || !safeImage(state.previous.image) || !safeImage(state.current.image)) throw new Error('没有兼容的回退记录；如涉及数据格式升级，请从独立备份恢复');
    if (action === 'previous') return state.previous;
    state = { ...state, current: state.previous, previous: state.current, changedAt: new Date().toISOString() };
  } else throw new Error('不支持的版本操作');
  await mkdir(directory, { recursive: true });
  async function atomic(filename, content) {
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, content, { flag: 'wx', mode: 0o644 }); await rename(temporary, filename);
  }
  await atomic(override, `x-workbench-release: ${JSON.stringify(state)}\nservices:\n  app:\n    image: ${state.current.image}\n`);
  return state;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, action, ...args] = process.argv.slice(2);
  const result = await changeRelease(directory, action, action === 'activate' ? { version: args[0], image: args[1], previousImage: args[2], backup: args[3] } : {});
  console.log(action === 'previous' ? result.image : JSON.stringify(result));
}
