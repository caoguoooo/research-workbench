import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

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
