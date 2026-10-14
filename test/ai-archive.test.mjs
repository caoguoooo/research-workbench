import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArchiveReply, createArchiveDrafts } from '../ai-archive.mjs';

const structured = { ready:true, project:{ name:'演示竞品', city:'成都', summary:'用户提供的项目资料', positioning:'改善住宅' }, floorplans:[{ label:'A 户型', area:'105㎡', rooms:'三室两厅' }], sections:{ planning:'容积率待补充', prices:'价格待补充，未提供日期', pending:'总规划及图片待补充' } };
const reply = () => ({ reply:JSON.stringify(structured), model:'test-model' });

test('AI draft validation refuses ambiguity and malformed output, preserves unknowns, and ignores invented sources', () => {
  assert.throws(() => parseArchiveReply({ reply:'{"ready":false,"question":"请确认城市"}' }), error => error.status === 422);
  assert.throws(() => parseArchiveReply({ reply:'这是自由文字' }), error => error.status === 502);
  assert.throws(() => parseArchiveReply({ reply:JSON.stringify({ ...structured, project:{ name:'项目', city:'待补充' } }) }), /城市/);
  assert.throws(() => parseArchiveReply({ reply:JSON.stringify({ ...structured, floorplans:[{ area:105 }] }) }), /格式/);
  const parsed = parseArchiveReply({ ...reply(), reply:JSON.stringify({ ...structured, sources:[{ url:'javascript:alert(1)' }] }), sources:[{ url:'https://example.com/source', title:'真实检索来源' }], searched:true });
  assert.equal(parsed.floorplans.length,3);
  assert.equal(parsed.floorplans[1].area,'');
  assert.equal(parsed.research.searched,true);
  assert.match(parsed.research.report,/待补充/);
  assert.equal(parsed.research.sources.length,1);
  assert.equal(parsed.research.sources[0].url,'https://example.com/source');
});

test('Drafts are user-bound and expire; failed saves can retry and double saves do not duplicate records', async () => {
  let clock = 1000, calls = 0, release;
  const store = createArchiveDrafts(async input => { calls++; if (!input.project.city) throw new Error('missing city'); await new Promise(resolve => { release=resolve; }); return { id:'saved', ...input.project }; }, { now:()=>clock });
  const draft = store.add('alice',reply());
  await assert.rejects(store.save('bob',{ draftId:draft.draftId, project:structured.project }), error => error.status === 410);
  await assert.rejects(store.save('alice',{ draftId:draft.draftId, project:{ city:'' } }));
  const saving = store.save('alice',{ draftId:draft.draftId, project:structured.project });
  await assert.rejects(store.save('alice',{ draftId:draft.draftId, project:structured.project }), error => error.status === 429);
  release(); const saved=await saving;
  assert.deepEqual(await store.save('alice',{ draftId:draft.draftId, project:structured.project }),saved);
  assert.equal(calls,2);
  clock += 30*60*1000;
  await assert.rejects(store.save('alice',{ draftId:draft.draftId }), error => error.status === 410);
});

for (const [index, storage] of ['json','sqlite'].entries()) test(`AI organize → preview → archive is authenticated, atomic and survives restart (${storage})`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-ai-archive-'));
  const port = 39054+index*2, providerPort=port+1;
  const base=`http://127.0.0.1:${port}`;
  let malformed=false, providerCalls=0;
  const provider = http.createServer(async (req,res) => {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks)); providerCalls++;
    const content=malformed ? '错误的自由文本' : JSON.stringify(structured);
    assert.match(body.instructions || body.messages[0].content,/JSON/);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url.endsWith('/responses') ? { status:'completed', output:[{ type:'web_search_call', status:'completed', action:{ sources:[{ url:'https://example.com/project',title:'项目官方资料' }] } },{ type:'message',role:'assistant',content:[{ type:'output_text',text:content,annotations:[] }] }] } : { choices:[{ message:{ content } }] }));
  });
  provider.listen(providerPort,'127.0.0.1'); await once(provider,'listening');
  let child;
  async function start() {
    child=spawn(process.execPath,['server.mjs'],{ cwd:fileURLToPath(new URL('../',import.meta.url)), env:{ ...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),WORKBENCH_DATA_DIR:dir,WORKBENCH_STORAGE:storage,WORKBENCH_ALLOW_EMPTY_PASSWORD:'false',WORKBENCH_HOME_VISUAL:'false' },stdio:['ignore','pipe','pipe'] });
    await new Promise((resolve,reject)=>{ child.stdout.once('data',resolve); child.once('error',reject); child.once('exit',code=>reject(new Error(`server exit ${code}`))); });
  }
  async function stop() { if (child?.exitCode === null) { const exit=once(child,'exit'); child.kill(); await exit; } }
  let cookie;
  const account={ username:'archive-user',password:'test-only-pass' };
  const post=(url,body,extra={})=>fetch(base+url,{ method:'POST',headers:{ 'Content-Type':'application/json',Origin:base,...(cookie?{ Cookie:cookie }:{}),...extra },body:JSON.stringify(body) });
  async function login() { const result=await post('/api/login',account); assert.equal(result.status,200); cookie=result.headers.get('set-cookie').split(';')[0]; }
  const list=async()=>await (await fetch(base+'/api/competitors',{ headers:{ Cookie:cookie } })).json();
  try {
    await start();
    assert.equal((await post('/api/ai/archive',{ draftId:'fake' })).status,401);
    assert.equal((await post('/api/setup',account)).status,201); await login();
    assert.equal((await post('/api/ai/archive',{}, { Origin:'https://untrusted.example' })).status,403);
    await fetch(base+'/api/settings/ai',{ method:'PATCH',headers:{ Cookie:cookie,Origin:base,'Content-Type':'application/json' },body:JSON.stringify({ baseUrl:`http://127.0.0.1:${providerPort}/v1`,token:'test-provider-token' }) });
    const input={ model:'test-model',archiveDraft:true,webSearch:true,messages:[{ role:'user',content:'整理成都演示竞品' }] };
    const response=await post('/api/ai/chat',input); assert.equal(response.status,200);
    const {draft,conversationId}=await response.json();
    assert.equal((await list()).items.length,0,'generation never writes records');
    assert.equal(draft.floorplans.length,3);
    assert.equal(draft.research.sources[0].url,'https://example.com/project');
    const saveInput={ draftId:draft.draftId,project:{ ...draft.project,district:'用户确认区域' } };
    const savedResponse=await post('/api/ai/archive',saveInput); assert.equal(savedResponse.status,201);
    const item=(await savedResponse.json()).item;
    assert.equal(item.city,'成都'); assert.equal(item.district,'用户确认区域');
    assert.equal(item.visits.length,0); assert.equal(item.files.length,0);
    assert.equal(item.floorplans[0].area,'105㎡');
    assert.equal(item.aiResearch.searched,true);
    assert.equal((await post('/api/ai/archive',saveInput)).status,201);
    assert.equal((await list()).items.length,1);
    const duplicate=(await (await post('/api/ai/chat',input)).json()).draft;
    assert.equal((await post('/api/ai/archive',{ draftId:duplicate.draftId,project:{ ...duplicate.project,city:'成都市' } })).status,409);
    malformed=true;
    assert.equal((await post('/api/ai/chat',input)).status,502);
    assert.equal((await list()).items.length,1);
    assert.equal(providerCalls,3,'saving does not make extra AI requests');
    await stop(); await start(); await login();
    const persisted=(await list()).items[0];
    assert.equal(persisted.id,item.id); assert.equal(persisted.aiResearch.sources.length,1);
    assert.equal(persisted.floorplans.length,3); assert.equal(persisted.summary,structured.project.summary);
    assert.equal((await post('/api/ai/archive',saveInput)).status,201,'persisted draft remains usable after restart');
    const conversations=await (await fetch(base+'/api/ai/conversations',{ headers:{ Cookie:cookie } })).json();
    assert.equal(conversations.items.length,3,'failed AI output is also retained as a visible error conversation');
    const restored=await (await fetch(base+'/api/ai/conversations?id='+conversationId,{ headers:{ Cookie:cookie } })).json();
    assert.equal(restored.current.messages[1].result.draft.savedId,item.id);
    assert.equal(restored.current.messages[1].result.draft.project.district,'用户确认区域');
    assert.equal((await post('/api/ai/archive',{ draftId:duplicate.draftId,project:{ ...duplicate.project,name:'重启后保存的草稿' } })).status,201);
    const serialized=JSON.stringify((await list()).items);
    assert.equal(serialized.includes('test-provider-token'),false);
    if (storage==='json') assert.match(await readFile(path.join(dir,'competitors.json'),'utf8'),/AI|规划指标/);
  } finally { await stop(); provider.closeAllConnections(); await new Promise(resolve=>provider.close(resolve)); await rm(dir,{ recursive:true,force:true }); }
});
