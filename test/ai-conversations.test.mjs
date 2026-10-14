import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,stat,readFile,writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAIConversationStore } from '../ai-conversation-store.mjs';

const message={ role:'user',content:'整理成都项目' };
const result={ reply:'容积率待补充 [1]',model:'demo',searched:true,sources:[{title:'项目来源',url:'https://example.com/project'}],citations:[{start:7,end:10,url:'https://example.com/project'}] };

test('Conversations persist rich replies and selected model, isolate users, and new conversations retain old records', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'workbench-chat-store-'));
  try {
    let store=createAIConversationStore(dir);
    const first=await store.append('alice',null,message,result,{ model:'demo',webSearch:true });
    assert.equal(first.messages.length,2);
    assert.equal('username' in first,false);
    const empty=await store.create('alice');
    assert.notEqual(empty.id,first.id);
    await Promise.all([store.append('alice',first.id,{ ...message,content:'补充一' },{reply:'回答一'},{model:'demo'}),store.append('alice',first.id,{ ...message,content:'补充二' },{reply:'回答二'},{model:'demo'})]);
    store=createAIConversationStore(dir);
    const restored=await store.list('alice',first.id);
    assert.equal(restored.items.length,2);
    assert.equal(restored.current.messages.length,6);
    assert.deepEqual(restored.current.messages[1].result,result);
    assert.equal(restored.current.model,'demo');
    await store.select('alice',empty.id);
    assert.equal((await createAIConversationStore(dir).list('alice')).current.id,empty.id);
    await store.select('alice',first.id);
    assert.equal((await createAIConversationStore(dir).list('alice')).current.id,first.id);
    assert.equal((await store.list('bob')).items.length,0);
    await assert.rejects(store.list('bob',first.id),error=>error.status===404);
    await assert.rejects(store.check('alice','../../auth.json'),error=>error.status===400);
    if(process.platform!=='win32') assert.equal((await stat(path.join(dir,'ai-conversations.json'))).mode & 0o777,0o600);
    const backupDir=path.join(dir,'backups');
    const child=spawn(process.execPath,['scripts/backup.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,WORKBENCH_DATA_DIR:dir,WORKBENCH_BACKUP_DIR:backupDir},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',data=>output+=data);const [code]=await once(child,'exit');assert.equal(code,0);
    const backup=output.trim().split('：')[1];
    assert.equal(await readFile(path.join(backup,'ai-conversations.json'),'utf8'),await readFile(path.join(dir,'ai-conversations.json'),'utf8'));
    const original=await readFile(path.join(dir,'ai-conversations.json'),'utf8');
    await writeFile(path.join(dir,'ai-conversations.json'),'corrupted');
    await assert.rejects(store.create('alice'));
    assert.equal(await readFile(path.join(dir,'ai-conversations.json'),'utf8'),'corrupted','corruption must not silently erase history');
    await writeFile(path.join(dir,'ai-conversations.json'),original);
    assert.equal((await store.list('alice')).items.length,2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
