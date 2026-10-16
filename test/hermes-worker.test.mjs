import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp,readFile,writeFile,rm,stat,unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHermesDispatch } from '../hermes-dispatch.mjs';
import { HermesWorker } from '../integration/hermes-worker.mjs';

async function fixture(run) {
  const queue = await mkdtemp(path.join(tmpdir(),'hermes-worker-test-'));
  const token = 'a'.repeat(64), key = 'worker-test-key-no-real-credentials';
  const task = { id:randomUUID(),status:'pending',name:'研究测试楼盘',city:'重庆',instructions:'核对公开资料' };
  const calls = [], result = { project:{name:task.name,city:task.city,summary:'模拟结果'},report:'模拟研究正文',sources:[{title:'模拟公开来源',url:'https://example.com/project'}] };
  let mode = 'success',polls = 0,submitted = 0;
  const server = http.createServer(async (req,res) => {
    let raw='';for await(const chunk of req)raw+=chunk;
    calls.push({url:req.url,auth:req.headers.authorization,body:raw?JSON.parse(raw):null,key:req.headers['idempotency-key']});
    res.setHeader('Content-Type','application/json');
    const respond = value => res.end(JSON.stringify(value));
    if(req.url.startsWith('/api/agent/'))assert.equal(req.headers.authorization,`Bearer ${token}`);
    else assert.equal(req.headers.authorization,`Bearer ${key}`);
    if(req.url==='/api/agent/task')return respond({task});
    if(req.url==='/api/agent/result'&&mode==='reject'){res.statusCode=400;return respond({error:'invalid result fixture'});}
    if(req.url==='/api/agent/result'){assert.deepEqual(JSON.parse(raw),result);submitted++;task.status='submitted';return respond({status:'submitted'});}
    if(req.url==='/v1/runs')return respond({run_id:'run_test',status:'started'});
    if(req.url==='/v1/runs/run_test/stop')return respond({status:'cancelled'});
    if(req.url==='/v1/runs/run_test'){
      polls++;
      if(mode==='transient'&&polls===1){res.statusCode=503;return respond({error:'test restart'});}
      if(mode==='cancel'){await unlink(path.join(queue,task.id+'.job.json'));return respond({status:'running'});}
      return respond({status:'completed',output:mode==='invalid'?'没有联网结果':JSON.stringify(result)});
    }
    res.statusCode=404;respond({error:'unknown test route'});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const dispatch=createHermesDispatch(queue);
  const worker=()=>new HermesWorker({queue,key,workbench:base,hermes:base,poll:1,budget:1000});
  try{await dispatch.enqueue(task,token);await run({queue,task,token,key,calls,dispatch,worker,setMode:value=>{mode=value},submitted:()=>submitted});}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(queue,{recursive:true,force:true});}
}

test('worker researches with no task credential in the prompt and submits without approval',()=>fixture(async s=>{
  assert.equal((await stat(path.join(s.queue,s.task.id+'.job.json'))).mode&0o777,0o600);
  await s.worker().cycle();
  assert.equal(s.submitted(),1);
  assert.equal((await s.dispatch.status(s.task.id)).state,'submitted');
  assert.equal((await s.dispatch.info()).online,true);
  const call=s.calls.find(c=>c.url==='/v1/runs');
  assert.ok(call.key.startsWith('workbench-'));
  assert.equal(JSON.stringify(call.body).includes(s.token),false);
  assert.equal(JSON.stringify(call.body).includes(s.key),false);
  assert.equal(s.calls.some(c=>/review|competitors/.test(c.url)),false);
  await assert.rejects(readFile(path.join(s.queue,s.task.id+'.job.json')),{code:'ENOENT'});
}));

test('worker resumes the saved Hermes run after a temporary outage without creating another paid run',()=>fixture(async s=>{
  s.setMode('transient');
  await assert.rejects(s.worker().cycle());
  assert.equal((await s.dispatch.status(s.task.id)).state,'running');
  await s.worker().cycle();
  assert.equal(s.submitted(),1);
  assert.equal(s.calls.filter(c=>c.url==='/v1/runs').length,1);
}));

test('unstructured model output fails without submitting or silently inventing sources',()=>fixture(async s=>{
  s.setMode('invalid');await s.worker().cycle();
  assert.equal(s.submitted(),0);
  assert.equal((await s.dispatch.status(s.task.id)).state,'failed');
}));

test('cancelled queue jobs stop their Hermes run and cannot submit results',()=>fixture(async s=>{
  s.setMode('cancel');await s.worker().cycle();
  assert.equal(s.submitted(),0);
  assert.equal(s.calls.some(c=>c.url==='/v1/runs/run_test/stop'),true);
}));


test('rejected research keeps the run ID and failing API route without exposing credentials',()=>fixture(async s=>{
  s.setMode('reject');await s.worker().cycle();
  assert.equal(s.submitted(),0);
  const status=JSON.parse(await readFile(path.join(s.queue,s.task.id+'.status.json'),'utf8'));
  assert.equal(status.state,'failed');assert.equal(status.runId,'run_test');
  assert.equal(status.route,'/api/agent/result');assert.equal(status.reason,'http_400');
  assert.equal(JSON.stringify(status).includes(s.token),false);
  assert.equal(JSON.stringify(status).includes(s.key),false);
}));
