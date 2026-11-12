import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {accountRecord,saveAccount} from '../auth-store.mjs';
for(const storage of ['json','sqlite'])test(`${storage}: bad image replacements and stale overview forms leave the valid archive intact`,async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-review-fixes-'));
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const account={username:'review-admin',password:'review-only-2026'};await saveAccount(dir,accountRecord(account.username,account.password));
 const origin=`http://127.0.0.1:${port}`;let child,cookie;
 const request=(url,method='GET',body,extra={})=>fetch(origin+url,{method,headers:{Origin:'https://review.example','X-Workbench-Request':'1',...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
 async function start(){child=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:'https://review.example',WORKBENCH_DATA_DIR:dir,WORKBENCH_REFERENCES_DIR:path.join(dir,'references'),WORKBENCH_STORAGE:storage,WORKBENCH_HOME_VISUAL:'false',WORKBENCH_ALLOW_EMPTY_PASSWORD:'false',WORKBENCH_TRUST_PROXY:'false'},stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('Server exited '+code);})]);const login=await request('/api/login','POST',account);assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];}
 async function stop(){if(child?.exitCode===null){child.kill();await once(child,'exit');}}
 try{
  await start();let response=await request('/api/competitors','POST',{name:'隔离回归项目',city:'测试城市',developer:'原开发商'});assert.equal(response.status,201);const original=(await response.json()).item;
  const base='/api/competitors/'+original.id,query=new URLSearchParams({name:'valid.png',category:'效果图'});
  const png=await sharp({create:{width:900,height:600,channels:3,background:'#618191'}}).png().toBuffer();
  const upload=(body,type='image/png',replaceId='')=>fetch(origin+base+'/files'+(replaceId?'/'+replaceId:'')+'?'+query,{method:replaceId?'PUT':'POST',headers:{Cookie:cookie,Origin:'https://review.example','X-Workbench-Request':'1','Content-Type':type},body});
  response=await upload(png);assert.equal(response.status,201);const file=(await response.json()).file;assert.equal(file.verification.fullDecode,true);
  for(const [bytes,mime]of [[Buffer.from('not-an-image'),'image/png'],[png.subarray(0,40),'image/png'],[png,'image/jpeg'],[Buffer.from('%PDF-1.4'),'application/pdf']])assert.equal((await upload(bytes,mime,file.id)).status,422);
  const directory=path.join(dir,'competitor-files',original.id,'renderings');assert.deepEqual(await readdir(directory),[file.id+'.bin']);assert.deepEqual(await readFile(path.join(directory,file.id+'.bin')),png);
  let saved=(await(await request(base)).json()).item;assert.equal(saved.files[0].id,file.id);assert.equal(saved.overviewRevision,0);
  const listing=await(await request('/api/competitors?view=directory')).json();
  assert.equal(listing.items.length,1);assert.equal(listing.items[0].fileCount,1);assert.equal(listing.items[0].visitCount,0);
  for(const field of ['files','visits','floorplans','summary','aiResearch','amenities','basicInfo'])assert.equal(Object.hasOwn(listing.items[0],field),false);
  const a={...saved,developer:'页面A的新开发商',expectedRevision:0},b={...saved,summary:'页面B的新概况',expectedRevision:0};
  assert.equal((await request(base,'PATCH',a)).status,200);assert.equal((await request(base,'PATCH',b)).status,409);assert.equal((await request(base,'PATCH',original)).status,428);
  saved=(await(await request(base)).json()).item;assert.equal(saved.developer,a.developer);assert.equal(saved.overviewRevision,1);assert.equal(saved.files[0].id,file.id);
  assert.equal((await request(base,'PATCH',{...saved,summary:b.summary,expectedRevision:1})).status,200);
  await stop();await start();saved=(await(await request(base)).json()).item;assert.equal(saved.overviewRevision,2);assert.equal(saved.developer,a.developer);assert.equal(saved.summary,b.summary);
  for(let i=0;i<10;i++)assert.equal((await request('/api/login','POST',{username:'unknown-user',password:'wrong-password'},{'X-Forwarded-For':'203.0.113.10'})).status,401);
  assert.equal((await request('/api/login','POST',{username:'unknown-user',password:'wrong-password'},{'X-Forwarded-For':'203.0.113.99'})).status,429);
  assert.equal((await request('/api/login','POST',account,{'X-Forwarded-For':'203.0.113.20'})).status,200);
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
