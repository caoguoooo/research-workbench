import { mkdir, access, cp, readdir, chown, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';

process.umask(0o077);
const dataRoot = path.resolve(process.env.WORKBENCH_DATA_DIR || '/data');
const backupRoot = path.resolve(process.env.WORKBENCH_BACKUP_DIR || '/backups');
const seedRoot = path.resolve(process.env.WORKBENCH_SEED_DIR || '/seed');
const exists = async filename => { try { await access(filename); return true; } catch { return false; } };
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await mkdir(backupRoot, { recursive: true, mode: 0o700 });
if (!(await exists(path.join(dataRoot, 'workbench.sqlite'))) && !(await exists(path.join(dataRoot, 'competitors.json'))) && await exists(path.join(seedRoot, 'competitors.json'))) {
  await cp(path.join(seedRoot, 'competitors.json'), path.join(dataRoot, 'competitors.json'), { errorOnExist: true, force: false });
  if (await exists(path.join(seedRoot, 'competitor-files'))) await cp(path.join(seedRoot, 'competitor-files'), path.join(dataRoot, 'competitor-files'), { recursive: true, errorOnExist: true, force: false });
  console.log('已导入竞品档案和图片；账号及 AI 密钥未导入。');
}
async function permissions(filename) {
  const info = await lstat(filename);
  if (info.isSymbolicLink()) throw new Error('资料目录包含符号链接，请移除后重新初始化');
  await chmod(filename, info.isDirectory() ? 0o700 : 0o600);
  if (process.getuid?.() === 0) await chown(filename, 1000, 1000);
  if (info.isDirectory()) for (const name of await readdir(filename)) await permissions(path.join(filename, name));
}
await permissions(dataRoot);
await permissions(backupRoot);
console.log('资料和备份目录已准备。');
