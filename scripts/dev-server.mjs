import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readAccount, verifyPassword } from '../auth-store.mjs';

// Keep an editable preview separate from the installed service and its credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.resolve(process.env.WORKBENCH_DEV_DATA_DIR || path.join(root, 'dev-data'));
if ([path.join(root, 'data'), path.join(root, 'runtime', 'data')].includes(dataRoot)) throw new Error('开发预览请使用独立资料目录，例如 dev-data');
const account = await readAccount(dataRoot);
if (!account || verifyPassword(account, '')) {
  console.error(`请先为开发预览初始化管理员。资料目录：${dataRoot}\nWORKBENCH_DATA_DIR='./dev-data' npm run admin:init -- --username admin\n如使用自定义目录，请将上述资料目录替换为同一路径。`);
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development', HOST: process.env.WORKBENCH_DEV_HOST || '127.0.0.1', PORT: process.env.WORKBENCH_DEV_PORT || '3000', PUBLIC_ORIGIN: '', WORKBENCH_DATA_DIR: dataRoot, WORKBENCH_STORAGE: 'json', WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false', WORKBENCH_HOME_VISUAL: 'false', WORKBENCH_TRUST_PROXY: 'false' },
    stdio: 'inherit'
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 0; });
}
