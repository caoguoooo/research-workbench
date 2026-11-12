import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAssetLibraryStore,MAX_ASSET_INDEX_BYTES} from '../asset-library-store.mjs';
import {createPolicyStore,MAX_POLICY_INDEX_BYTES} from '../policy-store.mjs';
const pad=(data,limit)=>{data.items[0].legacyNote='';const base=JSON.stringify(data);data.items[0].legacyNote='x'.repeat(limit-128-Buffer.byteLength(base));return JSON.stringify(data);};
test('asset capacity failures preserve the previous readable index and in-memory records',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-asset-capacity-'));
 try{let store=await createAssetLibraryStore(dir);await store.addBoard({title:'既有画板',category:'大门',boardUrl:'https://www.pinterest.com/designer/old/'});const filename=path.join(dir,'asset-library.json');const before=pad(JSON.parse(await readFile(filename,'utf8')),MAX_ASSET_INDEX_BYTES);await writeFile(filename,before);store=await createAssetLibraryStore(dir);
 await assert.rejects(store.addBoard({title:'新画板',category:'大门',boardUrl:'https://www.pinterest.com/designer/new/'}),e=>e.status===413);assert.equal(await readFile(filename,'utf8'),before);assert.equal(store.list().length,1);assert.equal((await createAssetLibraryStore(dir)).list().length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('policy capacity failures preserve records, directory and a restartable index',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-policy-capacity-'));
 try{let store=await createPolicyStore(dir);const city=store.directory()[0];const input={title:'原规范',placements:[{cityId:city.id,typeId:city.types[0].id}]};await store.save(input);const filename=path.join(dir,'policy-library.json');const before=pad(JSON.parse(await readFile(filename,'utf8')),MAX_POLICY_INDEX_BYTES);await writeFile(filename,before);store=await createPolicyStore(dir);
 await assert.rejects(store.save({...input,title:'新规范'}),e=>e.status===413);assert.equal(await readFile(filename,'utf8'),before);assert.equal(store.list().length,1);assert.equal((await createPolicyStore(dir)).list().length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
