import { mkdir, cp, access, writeFile } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(root, 'data'));
const backupRoot = path.resolve(process.env.WORKBENCH_BACKUP_DIR || path.join(root, 'backups'));
const destination = path.join(backupRoot, `workbench-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(destination, { recursive: true, mode: 0o700 });
const exists = async filename => { try { await access(filename); return true; } catch { return false; } };
if (await exists(path.join(dataRoot, 'workbench.sqlite'))) {
  const db = new DatabaseSync(path.join(dataRoot, 'workbench.sqlite'), { readOnly: true });
  try { await backup(db, path.join(destination, 'workbench.sqlite')); } finally { db.close(); }
}
for (const name of ['auth.json', 'users.json', 'user-profiles.json', 'user-avatars', 'ai-settings.json', 'map-settings.json', 'ai-conversations.json', 'competitors.json', 'competitor-files', 'cache']) {
  if (await exists(path.join(dataRoot, name))) await cp(path.join(dataRoot, name), path.join(destination, name), { recursive: true, errorOnExist: true, force: false });
}
await writeFile(path.join(destination, 'backup-info.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), storage: await exists(path.join(destination, 'workbench.sqlite')) ? 'sqlite' : 'json' }, null, 2), { mode: 0o600 });
console.log(process.argv.includes('--json') ? JSON.stringify({ destination }) : `备份已保存：${destination}`);
