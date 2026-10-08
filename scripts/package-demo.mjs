import { mkdir, readFile, writeFile, readdir, cp, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const releases = path.join(root, 'releases');
const name = `research-workbench-demo-${version}`;
const staging = path.join(releases, `${name}-${Date.now()}`);
const bundle = path.join(staging, name);
await mkdir(bundle, { recursive: true, mode: 0o700 });
const allowed = ['Dockerfile', 'compose.yaml', 'workbench.sh', '.dockerignore', '.gitignore', '.env.example', 'package.json', 'styles.css', 'README.md', 'BACKEND.md', 'DEPLOYMENT.md'];
for (const filename of await readdir(root)) {
  if (allowed.includes(filename) || /\.(mjs|js|html)$/.test(filename)) await cp(path.join(root, filename), path.join(bundle, filename));
}
for (const folder of ['scripts', 'test']) await cp(path.join(root, folder), path.join(bundle, folder), { recursive: true });
const dataRoot = path.resolve(process.env.CYJ_DATA_DIR || path.join(root, 'data'));
let archive;
try {
  await realpath(path.join(dataRoot, 'workbench.sqlite'));
  const { createSQLiteRepository } = await import('../sqlite-repository.mjs');
  const store = createSQLiteRepository(dataRoot);
  try { archive = await store.read(); } finally { await store.close(); }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  archive = JSON.parse(await readFile(path.join(dataRoot, 'competitors.json'), 'utf8'));
}
if (archive.version !== 1 || !Array.isArray(archive.competitors)) throw new Error('档案格式无效');
const seed = path.join(bundle, 'demo-data');
await mkdir(seed, { mode: 0o700 });
await writeFile(path.join(seed, 'competitors.json'), JSON.stringify(archive, null, 2), { mode: 0o600 });
const filesRoot = await realpath(path.join(dataRoot, 'competitor-files'));
const hashes = [];
for (const item of archive.competitors) for (const file of item.files) {
  const source = await realpath(path.resolve(filesRoot, file.storedName));
  const destination = path.resolve(seed, 'competitor-files', file.storedName);
  if (!source.startsWith(filesRoot + path.sep) || !destination.startsWith(path.join(seed, 'competitor-files') + path.sep)) throw new Error('附件路径不正确');
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination);
  const bytes = await readFile(destination);
  if (bytes.length !== file.size) throw new Error('附件大小校验失败');
  hashes.push({ id: file.id, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(path.join(bundle, 'release-manifest.json'), JSON.stringify({ version, generatedAt: new Date().toISOString(), projectCount: archive.competitors.length, fileCount: hashes.length, excludedCredentials: ['auth.json', 'ai-settings.json', '.env'], fileHashes: hashes }, null, 2));
const archivePath = path.join(releases, `${name}.tar.gz`);
execFileSync('tar', ['-czf', archivePath, '-C', staging, name]);
console.log(JSON.stringify({ archivePath, sourceFolder: bundle, projectCount: archive.competitors.length, fileCount: hashes.length }, null, 2));
