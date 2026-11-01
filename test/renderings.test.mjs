import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import sharp from 'sharp';
import {createThumbnailCache} from '../image-raster.mjs';

test('thumbnail cache refreshes changed sources, retains originals and cleans up decode failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-thumbnails-'));
  try {
    const cache = path.join(dir, 'cache'), source = path.join(dir, 'original.png');
    const thumbnail = createThumbnailCache(cache);
    const bytes = await sharp({create:{width:1200,height:900,channels:3,background:'#208477'}}).png().toBuffer();
    await writeFile(source, bytes);
    const info = await stat(source);
    const outputs = await Promise.all(Array.from({length:6}, () => thumbnail(source, info)));
    assert.equal(new Set(outputs).size, 1);
    assert.deepEqual(await readFile(source), bytes);
    assert.equal((await readdir(cache)).length, 1);
    await writeFile(source, await sharp({create:{width:400,height:300,channels:3,background:'#b43c54'}}).png().toBuffer());
    const refreshedInfo = await stat(source);
    const refreshed = await thumbnail(source, refreshedInfo);
    assert.notEqual(refreshed, outputs[0]);
    assert.equal((await sharp(refreshed).metadata()).width, 400);
    await unlink(refreshed);
    await symlink(source, refreshed);
    await assert.rejects(thumbnail(source, refreshedInfo), /Invalid thumbnail cache path/);
    await unlink(refreshed);
    await writeFile(source, Buffer.from('invalid-image'));
    await assert.rejects(thumbnail(source, await stat(source)));
    assert.equal((await readdir(cache)).some(name => name.endsWith('.tmp')), false);
    await assert.rejects(thumbnail(source, {...info,size:26*1024*1024}), /byte limit/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('visual cards request thumbnails while preview and download keep the original URL', async () => {
  const source = await readFile(new URL('../competitor.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function visualCard(');
  const end = source.indexOf('  function renderVisuals(', start);
  assert.ok(start >= 0 && end > start);
  const nodes = [];
  let previewed;
  const item = { id: 'project' }, file = { id: 'image', type: 'image/png' };
  const context = vm.createContext({
    canEdit: false,
    element(tag, className) { const node = { tag, className, append() {}, setAttribute() {}, addEventListener(event, handler) { this[event] = handler; } }; nodes.push(node); return node; },
    fileUrl: () => '/original', previewImage: (...args) => { previewed = args; }
  });
  vm.runInContext(source.slice(start, end), context);
  context.visualCard(item, file, 'Image', 'rendering', '01');
  assert.equal(nodes.find(node => node.tag === 'img').src, '/original?thumbnail=1');
  const image = nodes.find(node => node.tag === 'img');
  let changes = 0, currentSource = image.src;
  Object.defineProperty(image, 'src', { get: () => currentSource, set: value => { changes++; currentSource = value; } });
  image.error();
  assert.equal(image.src, '/original');
  image.error();
  assert.equal(changes, 1, 'An unavailable original must not start a retry loop');
  assert.equal(nodes.find(node => node.tag === 'a').href, '/original');
  nodes.find(node => node.className === 'archive-image-trigger').click();
  assert.equal(previewed[0], item);
  assert.equal(previewed[1], file);
});

for (const backend of ['json', 'sqlite']) test(`${backend}: rendering limit, atomic replacement, stale requests and retained originals`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-renderings-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {randomUUID} from 'node:crypto';
      import * as store from './competitor-store.mjs';
      const item = await store.createCompetitor({name:'效果图验收'});
      const input = () => {const id=randomUUID();return {id,name:'效果图.png',category:'效果图',type:'image/png',size:100,storedName:item.id+'/renderings/'+id+'.bin'}};
      const attempts = await Promise.allSettled(Array.from({length:10},()=>store.addFile(item.id,input())));
      assert.equal(attempts.filter(x=>x.status==='fulfilled').length,6);
      assert.ok(attempts.filter(x=>x.status==='rejected').every(x=>x.reason.status===409));
      const original=(await store.getCompetitor(item.id)).files[0];
      const replacements=await Promise.allSettled([store.addFile(item.id,{...input(),replaceId:original.id}),store.addFile(item.id,{...input(),replaceId:original.id})]);
      assert.equal(replacements.filter(x=>x.status==='fulfilled').length,1);
      let saved=await store.getCompetitor(item.id);
      assert.equal(saved.files.length,6);
      assert.equal(saved.removedFiles.length,1);
      assert.equal(saved.removedFiles[0].storedName,original.storedName);
      assert.ok(saved.removedFiles[0].replacedBy);
      await assert.rejects(store.addFile(item.id,{...input(),replaceId:original.id}),e=>e.status===409);
      const current=saved.files[0];
      await store.removeRendering(item.id,current.id);
      await assert.rejects(store.removeRendering(item.id,current.id),e=>e.status===409);
      await store.addFile(item.id,input());
      saved=await store.getCompetitor(item.id);
      assert.equal(saved.files.length,6);
      assert.equal(saved.removedFiles.length,2);
      const plan=await store.addFile(item.id,{...input(),category:'户型图',slotId:item.floorplans[0].id});
      await assert.rejects(store.removeRendering(item.id,plan.id),e=>e.status===409);
      await assert.rejects(store.addFile(item.id,{...input(),replaceId:plan.id}),e=>e.status===409);
      assert.equal((await store.getCompetitor(item.id)).files.length,7);
    `], {cwd:new URL('../',import.meta.url),env:{...process.env,WORKBENCH_STORAGE:backend,WORKBENCH_DATA_DIR:dir},encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr || result.error?.message);
  } finally {await rm(dir,{recursive:true,force:true});}
});
