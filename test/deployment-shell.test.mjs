import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const failure of ['backup', 'health', 'none']) test(`upgrade preserves site configuration and restores service on ${failure}`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-shell-'));
  const install = path.join(directory, 'site'), bin = path.join(directory, 'bin'), log = path.join(directory, 'calls.jsonl');
  await mkdir(install); await mkdir(bin);
  const config = 'name: retained-site\nservices:\n  app:\n    image: old-image:0.1.8\n    ports: ["127.0.0.1:18899:3000"]\n';
  await writeFile(path.join(install, 'compose.yaml'), config);
  const mock = `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path'; import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2),env=process.env;
fs.appendFileSync(env.MOCK_LOG,JSON.stringify(args)+'\\n');
const runtime=path.join(env.MOCK_INSTALL,'runtime');
const current=()=>{try{return /^    image: (.+)$/m.exec(fs.readFileSync(path.join(runtime,'release.yaml'),'utf8'))[1]}catch{return 'old-image:0.1.8'}};
if(args[0]==='image')process.exit(0);
if(args[0]==='run'){
 const i=args.indexOf('scripts/release-state.mjs');if(i<0)process.exit(9);
 process.stdout.write(execFileSync(process.execPath,[env.MOCK_HELPER,runtime,...args.slice(i+2)],{encoding:'utf8'}));process.exit(0);
}
if(args[0]!=='compose')process.exit(9);
if(args.includes('--images')){console.log(current());process.exit(0)}
if(args.includes('ps')){console.log('running-id');process.exit(0)}
if(args.includes('scripts/backup.mjs')){if(env.MOCK_FAILURE==='backup')process.exit(1);console.log(JSON.stringify({destination:'/backups/test'}));process.exit(0)}
if(args.includes('exec')&&env.MOCK_FAILURE==='health'&&current()!=='old-image:0.1.8')process.exit(1);
process.exit(0);
`;
  await writeFile(path.join(bin, 'docker'), mock); await chmod(path.join(bin, 'docker'), 0o755);
  await writeFile(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(bin, 'sleep'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_LOG: log, MOCK_INSTALL: install, MOCK_HELPER: path.join(root, 'scripts/release-state.mjs'), MOCK_FAILURE: failure };
  try {
    const result = spawnSync('sh', [path.join(root, 'workbench.sh'), 'upgrade', install], { env, encoding: 'utf8' });
    assert.equal(result.status, failure === 'none' ? 0 : 1, result.stderr);
    assert.equal(await readFile(path.join(install, 'compose.yaml'), 'utf8'), config);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const backup = calls.findIndex(call => call.includes('scripts/backup.mjs'));
    const activate = calls.findIndex(call => call.includes('activate'));
    assert.ok(backup >= 0);
    if (failure === 'backup') { assert.equal(activate, -1); assert.ok(calls.some(call => call.includes('up'))); }
    else {
      assert.ok(activate > backup);
      const text = await readFile(path.join(install, 'runtime/release.yaml'), 'utf8');
      const state = JSON.parse(text.split('\n')[0].slice('x-workbench-release: '.length));
      assert.equal(state.current.image, failure === 'health' ? 'old-image:0.1.8' : 'caoguoooo-workbench:0.2.0');
      if (failure === 'none') execFileSync('sh', [path.join(install, 'workbench.sh'), 'rollback'], { env, encoding: 'utf8' });
      else assert.ok(calls.some(call => call.includes('rollback')));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
