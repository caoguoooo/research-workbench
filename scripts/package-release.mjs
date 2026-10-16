import { mkdir, readFile, writeFile, readdir, copyFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set(['Dockerfile', 'compose.yaml', 'workbench.sh', '.dockerignore', '.gitignore', 'package.json', 'package-lock.json', 'README.md', 'BACKEND.md', 'DEPLOYMENT.md', 'CHANGELOG.md', 'styles.css', 'favicon.svg', 'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png']);
export async function collectReleaseFiles(source) {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '@eaDir' || entry.name === '.DS_Store') continue;
      const relative = path.posix.join(prefix, entry.name), absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`发布文件不允许符号链接：${relative}`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (allowed.has(entry.name) || entry.isFile() && /\.(mjs|js|html)$/.test(entry.name)) {
      if ((await lstat(path.join(source, entry.name))).isSymbolicLink()) throw new Error('发布文件不允许符号链接');
      files.push(entry.name);
    }
  }
  for (const folder of ['scripts', 'test', 'vendor', '.github', 'integration']) {
    try { await visit(path.join(source, folder), folder); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files.sort();
}
export async function packageRelease(source = root, output = path.join(root, 'releases')) {
  const { version } = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本号格式不正确');
  const name = `caoguoooo-workbench-${version}`, staging = path.join(output, `${name}-${Date.now()}`), bundle = path.join(staging, name);
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  const hashes = [];
  for (const relative of await collectReleaseFiles(source)) {
    const destination = path.join(bundle, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(source, relative), destination);
    hashes.push({ path: relative, sha256: createHash('sha256').update(await readFile(destination)).digest('hex') });
  }
  const manifest = { version, packageType: 'program-only', dataSchema: 1, architectures: ['amd64'], generatedAt: new Date().toISOString(), files: hashes };
  await writeFile(path.join(bundle, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
  const archive = path.join(output, `${name}.tar.gz`);
  execFileSync('tar', [...(process.platform === 'darwin' ? ['--no-xattrs', '--disable-copyfile'] : []), '-czf', archive, '-C', staging, name], { env: { ...process.env, COPYFILE_DISABLE: '1', COPY_EXTENDED_ATTRIBUTES_DISABLE: '1' } });
  return { version, archive, bundle, fileCount: hashes.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await packageRelease(), null, 2));
