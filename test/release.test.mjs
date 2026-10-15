import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { packageRelease } from '../scripts/package-release.mjs';
import { changeRelease } from '../scripts/release-state.mjs';

test('program release never scans or includes operational data and produces a hashed manifest', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'workbench-package-source-')), output = await mkdtemp(path.join(tmpdir(), 'workbench-package-output-'));
  try {
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    await writeFile(path.join(source, 'server.mjs'), 'export const ok = true;');
    await mkdir(path.join(source, 'scripts')); await writeFile(path.join(source, 'scripts/admin.mjs'), 'export const test = true;');
    for (const directory of ['data', 'runtime', 'demo-data', 'outputs', 'releases', 'backups', 'node_modules']) { await mkdir(path.join(source, directory)); await writeFile(path.join(source, directory, 'auth.json'), 'SENSITIVE-NEVER-PUBLISH'); }
    await writeFile(path.join(source, 'auth.json'), 'SENSITIVE-NEVER-PUBLISH');
    const result = await packageRelease(source, output);
    const entries = execFileSync('tar', ['-tzf', result.archive], { encoding: 'utf8' });
    assert.doesNotMatch(entries, /auth\.json|demo-data|runtime|node_modules|backups/);
    const manifest = JSON.parse(await readFile(path.join(result.bundle, 'release-manifest.json'), 'utf8'));
    assert.equal(manifest.packageType, 'program-only'); assert.equal(manifest.dataSchema, 1);
    assert.deepEqual(manifest.files.map(file => file.path), ['package.json', 'scripts/admin.mjs', 'server.mjs']);
    assert.ok(manifest.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)));
  } finally { await rm(source, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});

test('version selection is atomic with its recovery state, never rewrites site compose, and refuses incompatible rollback', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-release-state-'));
  try {
    const original = 'services:\n  app:\n    ports: ["127.0.0.1:18899:3000"]\n';
    await writeFile(path.join(directory, 'compose.yaml'), original);
    const current = await changeRelease(directory, 'activate', { version: '0.2.0', image: 'caoguoooo-workbench:0.2.0', previousImage: 'caoguoooo-workbench:demo-0.1.8', backup: '/backups/test' });
    const text = await readFile(path.join(directory, 'release.yaml'), 'utf8'); assert.match(text, /image: caoguoooo-workbench:0.2.0/);
    assert.deepEqual(JSON.parse(text.split('\n')[0].slice('x-workbench-release: '.length)), current);
    assert.equal((await changeRelease(directory, 'previous')).image, 'caoguoooo-workbench:demo-0.1.8');
    await assert.rejects(changeRelease(directory, 'activate', { version: '0.2.1', image: 'caoguoooo-workbench:0.2.1', previousImage: 'wrong-image', backup: 'x' }), /不一致/);
    const old = await changeRelease(directory, 'rollback'); assert.equal(old.current.image, 'caoguoooo-workbench:demo-0.1.8');
    assert.equal(await readFile(path.join(directory, 'compose.yaml'), 'utf8'), original);
    const incompatible = { ...old, previous: { ...old.previous, dataSchema: 2 } };
    await writeFile(path.join(directory, 'release.yaml'), `x-workbench-release: ${JSON.stringify(incompatible)}\n`);
    await assert.rejects(changeRelease(directory, 'rollback'), /兼容/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
