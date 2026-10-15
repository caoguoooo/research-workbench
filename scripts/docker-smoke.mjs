import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = process.argv[2];
if (!/^caoguoooo-workbench:\d+\.\d+\.\d+$/.test(image || '')) throw new Error('Provide the built version image');
const directory = await mkdtemp(path.join(tmpdir(), 'workbench-docker-smoke-'));
const name = `workbench-smoke-${Date.now()}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const compose = args => docker(['compose', '--project-directory', directory, '-f', path.join(directory, 'compose.yaml'), ...(stateReady ? ['-f', path.join(directory, 'runtime/release.yaml')] : []), ...args]);
let stateReady = false;
const previous = `${image}-smoke-old`;
try {
  await mkdir(path.join(directory, 'runtime/data'), { recursive: true }); await mkdir(path.join(directory, 'runtime/backups'));
  docker(['tag', image, previous]);
  const config = `name: ${name}\nservices:\n  app:\n    image: ${previous}\n    container_name: ${name}\n    environment:\n      NODE_ENV: production\n      HOST: 127.0.0.1\n      WORKBENCH_STORAGE: sqlite\n      WORKBENCH_HOME_VISUAL: 'false'\n      WORKBENCH_DATA_DIR: /data\n      WORKBENCH_BACKUP_DIR: /backups\n    volumes:\n      - ./runtime/data:/data\n      - ./runtime/backups:/backups\n    read_only: true\n    tmpfs: [/tmp]\n`;
  await writeFile(path.join(directory, 'compose.yaml'), config);
  compose(['run', '--rm', '-T', '--user', '0:0', 'app', 'node', 'scripts/prepare-data.mjs']);
  compose(['run', '--rm', '-T', 'app', 'node', '--input-type=module', '-e', "import {accountRecord,saveAccount} from './auth-store.mjs'; await saveAccount('/data',accountRecord('ci-admin','ci-smoke-password')); "]);
  compose(['up', '-d']);
  for (let i = 0; i < 30; i++) {
    try { compose(['exec', '-T', 'app', 'node', '-e', "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]); break; }
    catch (error) { if (i === 29) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  compose(['exec', '-T', 'app', 'node', '--input-type=module', '-e', `import assert from 'node:assert/strict'; const base='http://127.0.0.1:3000'; let r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Request':'1'},body:JSON.stringify({username:'ci-admin',password:'ci-smoke-password'})}); assert.equal(r.status,200); const cookie=r.headers.get('set-cookie').split(';')[0]; for(const file of ['/app','/profile.js','/users.js','/competitor.js','/amenities.js','/vendor/leaflet/leaflet.js'])assert.equal((await fetch(base+file,{headers:{Cookie:cookie}})).status,200,file); r=await fetch(base+'/api/competitors',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Workbench-Request':'1'},body:JSON.stringify({name:'upgrade-smoke-project'})}); assert.equal(r.status,201);`]);
  execFileSync('sh', [path.join(root, 'workbench.sh'), 'upgrade', directory], { cwd: root, encoding: 'utf8', stdio: 'pipe' }); stateReady = true;
  assert.equal(await readFile(path.join(directory, 'compose.yaml'), 'utf8'), config);
  assert.match(compose(['config', '--images']).trim(), new RegExp(image.replaceAll('.', '\\.')));
  execFileSync('sh', [path.join(directory, 'workbench.sh'), 'rollback'], { encoding: 'utf8', stdio: 'pipe' });
  assert.equal(compose(['config', '--images']).trim(), previous);
  compose(['exec', '-T', 'app', 'node', '--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; import assert from 'node:assert/strict'; const db=new DatabaseSync('/data/workbench.sqlite',{readOnly:true}); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competitors').get().n,1); db.close();`]);
  console.log('Container assets, production login, data preservation, upgrade and rollback verified.');
} catch (error) {
  process.stderr.write(error.stderr?.toString() || error.stack || String(error));
  try { process.stderr.write(compose(['logs', '--tail', '60', 'app'])); } catch {}
  throw error;
} finally {
  try { compose(['down', '--remove-orphans']); } catch {}
  try { docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--mount', `type=bind,src=${directory},dst=/smoke`, image, 'node', '--input-type=module', '-e', "import {rm} from 'node:fs/promises';await rm('/smoke/runtime',{recursive:true,force:true});"]); } catch {}
  await rm(directory, { recursive: true, force: true });
}
