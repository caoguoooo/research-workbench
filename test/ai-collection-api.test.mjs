import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const png = await sharp({ create:{ width:2000,height:1200,channels:3,background:'#497daf' } }).png().toBuffer();
const narrow = await sharp(png).resize(1599,1200).png().toBuffer();
const short = await sharp(png).resize(2000,599).png().toBuffer();
const changed = await sharp({ create:{ width:2000,height:1200,channels:3,background:'#ba7448' } }).png().toBuffer();
const structured = { ready:true,project:{ name:'测试楼盘',city:'成都' },floorplans:[{ label:'A户型',area:'105㎡' }],sections:{ prices:'2026-10-12 价格待补充' } };
const preload = `
  import https from 'node:https';
  import dns from 'node:dns/promises';
  import { syncBuiltinESMExports } from 'node:module';
  import { EventEmitter } from 'node:events';
  import { Readable } from 'node:stream';
  import { readFile, appendFile } from 'node:fs/promises';
  dns.lookup = async () => [{ address:'8.8.8.8',family:4 }];
  https.request = (url,options,callback) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(async () => {
      try {
        options.signal?.throwIfAborted();
        if (url.hostname !== 'estate.example.com' || !['/project','/masterplan.png','/floorplan.png'].includes(url.pathname)) throw new Error('Unexpected mocked download');
        const mode = await readFile(process.env.WORKBENCH_DATA_DIR+'/download-mode','utf8');
        await appendFile(process.env.WORKBENCH_DATA_DIR+'/download-log',url.pathname+'\\n');
        const page = url.pathname === '/project';
        const html = mode === 'empty' ? '<p>No images</p>' : '<img src="/masterplan.png" alt="项目总规划"><img src="/floorplan.png" alt="A户型">';
        const sample = url.pathname === '/floorplan.png' && ['narrow','short','changed','invalid','truncated'].includes(mode) ? mode : 'valid';
        const bytes = page ? Buffer.from(html) : await readFile(process.env.WORKBENCH_DATA_DIR+'/fixture-'+sample+'.bin');
        const stream = Readable.from([bytes]);
        stream.statusCode = 200;
        stream.headers = { 'content-type':page ? 'text/html' : mode === 'mismatch' && url.pathname === '/floorplan.png' ? 'image/jpeg' : 'image/png' };
        callback(stream);
      } catch (error) { req.emit('error',error); }
    });
    return req;
  };
  syncBuiltinESMExports();
`;

for (const [index,storage] of ['json','sqlite'].entries()) for (const scenario of ['selected','manual','invalid-original','text-only']) test(`Collect → reviewed archive → restart: ${scenario} (${storage})`,{ timeout:30000 },async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-collect-api-'));
  const port = 39060+index;
  const base = `http://127.0.0.1:${port}`;
  let providerCalls = 0;
  let providerFailure;
  const visualIDs = [];
  const provider = http.createServer(async (req,res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); providerCalls++;
      res.setHeader('Content-Type','application/json');
      if (req.url.endsWith('/responses')) {
        assert.equal(body.tool_choice,'required');
        res.end(JSON.stringify({ status:'completed',output:[{ type:'web_search_call',status:'completed',action:{ sources:[{ url:'https://estate.example.com/project',title:'项目官网' }] } },{ type:'message',role:'assistant',content:[{ type:'output_text',text:JSON.stringify(structured),annotations:[] }] }] }));
      } else {
        assert.equal(req.url,'/v1/chat/completions');
        const content = body.messages.find(message => message.role === 'user').content;
        assert.ok(Array.isArray(content),'visual request must be multimodal');
        const payload = JSON.parse(content.find(part => part.type === 'text').text);
        assert.equal(payload.project.name,structured.project.name);
        assert.equal(payload.candidates.length,2);
        const images = content.filter(part => part.type === 'image_url');
        assert.equal(images.length,payload.candidates.length);
        for (const candidate of payload.candidates) {
          assert.match(candidate.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          visualIDs.push(candidate.id);
        }
        assert.equal(new Set(visualIDs).size,visualIDs.length);
        for (const image of images) {
          assert.match(image.image_url.url,/^data:image\/jpeg;base64,/);
          const encoded = image.image_url.url.split(',')[1];
          const bytes = Buffer.from(encoded,'base64');
          assert.equal(bytes.toString('base64'),encoded);
          const metadata = await sharp(bytes).metadata();
          assert.equal(metadata.format,'jpeg');
          assert.equal(metadata.width,1000); assert.equal(metadata.height,600);
          await sharp(bytes).raw().toBuffer();
        }
        if (scenario === 'manual') {
          res.statusCode = 502;
          res.end(JSON.stringify({ error:{ message:'private provider detail: test-provider-token' } }));
        } else res.end(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ images:[{ id:payload.candidates[0].id,category:'总规划' },{ id:payload.candidates[1].id,category:'户型图',floorplanIndex:0 }] }) } }] }));
      }
    } catch (error) {
      providerFailure = error;
      res.statusCode = 500; res.end(JSON.stringify({ error:'Mock assertion failed' }));
    }
  });
  let child, cookie;
  const account = { username:'collector-user',password:'test-only-pass' };
  const post = (url,body,headers={}) => fetch(base+url,{ method:'POST',headers:{ 'Content-Type':'application/json',Origin:base,'X-Workbench-Request':'1',...(cookie ? { Cookie:cookie } : {}),...headers },body:JSON.stringify(body) });
  const get = url => fetch(base+url,{ headers:cookie ? { Cookie:cookie } : {} });
  async function start() {
    child = spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'server.mjs'],{ cwd:fileURLToPath(new URL('../',import.meta.url)),env:{ ...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:'',WORKBENCH_DATA_DIR:dir,WORKBENCH_STORAGE:storage,WORKBENCH_HOME_VISUAL:'false',WORKBENCH_ALLOW_EMPTY_PASSWORD:'false',WORKBENCH_TRUST_PROXY:'false',WORKBENCH_IMAGE_PROXY:'' },stdio:['ignore','pipe','pipe'] });
    let errors = ''; child.stderr.on('data',chunk => { errors += chunk; });
    await new Promise((resolve,reject) => { child.stdout.once('data',resolve); child.once('error',reject); child.once('exit',code => reject(new Error(`server exit ${code}: ${errors}`))); });
  }
  async function stop() {
    if (child?.exitCode === null) { const exited = once(child,'exit'); child.kill(); await exited; }
  }
  async function login() {
    const response = await post('/api/login',account);
    assert.equal(response.status,200);
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  try {
    for (const [name,bytes] of Object.entries({ valid:png,narrow,short,changed,invalid:Buffer.from('<html>private upstream detail</html>'),truncated:png.subarray(0,Math.floor(png.length/2)) })) {
      await writeFile(path.join(dir,'fixture-'+name+'.bin'),bytes);
    }
    await writeFile(path.join(dir,'download-mode'),scenario === 'text-only' ? 'empty' : 'valid');
    await writeFile(path.join(dir,'download-log'),'');
    provider.listen(0,'127.0.0.1'); await once(provider,'listening');
    await start();
    const input = { city:'成都',name:'测试楼盘',model:'test-model' };
    assert.equal((await post('/api/ai/collect',input)).status,401);
    assert.equal((await post('/api/ai/archive',{ draftId:'unowned',imagesReviewed:true })).status,401);
    assert.equal((await get('/api/ai/collection/image?draftId=fake&imageId=fake')).status,401);
    assert.equal((await post('/api/setup',account)).status,201); await login();
    assert.equal((await post('/api/ai/collect',input,{ Origin:'https://untrusted.example' })).status,403);
    assert.equal((await post('/api/ai/collect',input,{ 'Content-Type':'text/plain' })).status,415);
    assert.equal((await get('/api/ai/collect')).status,405);
    assert.equal((await post('/api/ai/collect',{ ...input,city:'' })).status,400);
    assert.equal(providerCalls,0);
    const settings = await fetch(base+'/api/settings/ai',{ method:'PATCH',headers:{ Cookie:cookie,Origin:base,'X-Workbench-Request':'1','Content-Type':'application/json' },body:JSON.stringify({ baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,token:'test-provider-token' }) });
    assert.equal(settings.status,200);
    const response = await post('/api/ai/collect',input);
    assert.equal(response.status,200,await response.clone().text());
    const { draft,conversationId } = await response.json();
    assert.ifError(providerFailure);
    assert.equal(JSON.stringify(draft).includes('test-provider-token'),false);
    assert.equal(JSON.stringify(draft).includes('private provider detail'),false);
    if (scenario === 'text-only') {
      assert.equal(draft.collection.images.length,0);
      assert.equal(providerCalls,1);
      const saved = await post('/api/ai/archive',{ draftId:draft.draftId,project:draft.project });
      assert.equal(saved.status,201,await saved.clone().text());
      assert.equal((await saved.json()).item.files.length,0);
      assert.equal(providerCalls,1);
      return;
    }
    assert.equal(draft.collection.images.length,2);
    assert.deepEqual(draft.collection.images.map(image => image.id),visualIDs);
    assert.equal(draft.collection.visualStatus,scenario === 'manual' ? 'unavailable' : 'completed');
    if (scenario === 'manual') {
      for (const image of draft.collection.images) {
        assert.equal(image.category,''); assert.equal(image.slotId,'');
        assert.equal(image.visualReview.status,'unavailable');
      }
      assert.match(draft.collection.warnings.join(' '),/人工/);
    }
    assert.equal((await (await get('/api/competitors')).json()).items.length,0);
    const cache = path.join(dir,'cache','ai-collection');
    const previewNames = draft.collection.images.map(image => image.id+'.bin').sort();
    assert.deepEqual((await readdir(cache)).sort(),previewNames);
    const initialDownloads = (await readFile(path.join(dir,'download-log'),'utf8')).trim().split('\n');
    assert.deepEqual(initialDownloads,['/project','/masterplan.png','/floorplan.png'],'collection downloads candidates but does not prepare originals');
    const selected = draft.collection.images[1];
    const previewURL = `/api/ai/collection/image?draftId=${draft.draftId}&imageId=${selected.id}`;
    const preview = await get(previewURL);
    assert.equal(preview.status,200); assert.equal(preview.headers.get('content-type'),'image/jpeg');
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    const metadata = await sharp(previewBytes).metadata();
    assert.equal(metadata.format,'jpeg');
    assert.equal(metadata.width,1000); assert.equal(metadata.height,600);
    await sharp(previewBytes).raw().toBuffer();
    assert.equal((await get(`/api/ai/collection/image?draftId=${draft.draftId}&imageId=unowned`)).status,404);
    assert.equal((await get(`/api/ai/collection/image?draftId=unowned&imageId=${selected.id}`)).status,410);
    await stop(); await start(); await login();
    const restartedPreview = await get(previewURL);
    assert.equal(restartedPreview.status,200,'unsaved images survive restart');
    assert.equal(restartedPreview.headers.get('content-type'),'image/jpeg');
    await sharp(Buffer.from(await restartedPreview.arrayBuffer())).raw().toBuffer();
    const history = await (await get('/api/ai/conversations?id='+conversationId)).json();
    assert.deepEqual(history.current.messages[1].result.draft.collection.images,draft.collection.images);
    const saveInput = { draftId:draft.draftId,project:draft.project,imagesReviewed:true,imageIds:[selected.id],...(scenario === 'manual' ? { imageChoices:[{ id:selected.id,category:'户型图',slotId:'floorplan-01' }] } : {}) };
    for (const imagesReviewed of [undefined,false,'true',1,null]) {
      const invalid = { ...saveInput,imagesReviewed };
      assert.equal((await post('/api/ai/archive',invalid)).status,400);
    }
    for (const imageIds of [['unowned'],[selected.id,selected.id]]) {
      assert.equal((await post('/api/ai/archive',{ ...saveInput,imageIds })).status,400);
    }
    assert.equal((await post('/api/ai/archive',{ ...saveInput,imageChoices:[{ id:'unowned',category:'效果图',slotId:'' }] })).status,400);
    assert.equal((await post('/api/ai/archive',{ ...saveInput,imageChoices:[{ id:selected.id,category:'户型图',slotId:'floorplan-99' }] })).status,400);
    assert.deepEqual((await readdir(cache)).sort(),previewNames);
    assert.deepEqual((await readFile(path.join(dir,'download-log'),'utf8')).trim().split('\n'),initialDownloads,'rejected review does not download originals');
    if (scenario === 'invalid-original') {
      for (const mode of ['narrow','short','changed','invalid','truncated','mismatch']) {
        await writeFile(path.join(dir,'download-mode'),mode);
        const failed = await post('/api/ai/archive',{ ...saveInput,imageIds:draft.collection.images.map(image => image.id) });
        assert.equal(failed.status,422,await failed.clone().text());
        const failure = await failed.json();
        assert.match(failure.error,/未保存档案/);
        assert.equal(JSON.stringify(failure).includes('private upstream detail'),false);
        assert.equal((await (await get('/api/competitors')).json()).items.length,0);
        assert.deepEqual((await readdir(cache)).sort(),previewNames,'partial original cache removed while previews survive');
        assert.equal((await get(previewURL)).status,200);
        const unsaved = await (await get('/api/ai/conversations?id='+conversationId)).json();
        assert.equal(unsaved.current.messages[1].result.draft.savedId,undefined);
        assert.equal(providerCalls,2);
      }
      await writeFile(path.join(dir,'download-mode'),'valid');
    }
    const beforeSaveDownloads = (await readFile(path.join(dir,'download-log'),'utf8')).trim().split('\n');
    const saved = await post('/api/ai/archive',saveInput);
    assert.equal(saved.status,201,await saved.clone().text());
    const item = (await saved.json()).item;
    assert.equal(item.files.length,1); assert.equal(item.files[0].slotId,'floorplan-01');
    assert.equal(item.files[0].cacheImageId,selected.id);
    assert.equal(item.files[0].category,'户型图');
    assert.equal(item.files[0].type,'image/png');
    assert.equal(item.files[0].size,png.length);
    assert.equal(item.visits.length,0); assert.equal(item.files[0].sourceUrl,'https://estate.example.com/project');
    assert.deepEqual((await readdir(cache)).sort(),previewNames,'saving removes original caches but retains previews');
    const afterSaveDownloads = (await readFile(path.join(dir,'download-log'),'utf8')).trim().split('\n');
    assert.deepEqual(afterSaveDownloads,[...beforeSaveDownloads,'/floorplan.png'],'only selected original is downloaded after confirmation');
    assert.equal((await get(previewURL)).status,200,'saved preview remains accessible');
    assert.equal((await post('/api/ai/archive',saveInput)).status,201);
    assert.deepEqual((await readFile(path.join(dir,'download-log'),'utf8')).trim().split('\n'),afterSaveDownloads,'idempotent save does not redownload originals');
    assert.equal(providerCalls,2,'archive saving does not request the AI provider');
    await stop(); await start(); await login();
    const restored = await (await get('/api/ai/conversations?id='+conversationId)).json();
    assert.equal(restored.current.messages[1].result.draft.savedId,item.id);
    assert.deepEqual(restored.current.messages[1].result.draft.collection.selectedImageIds,[selected.id]);
    const resaved = await post('/api/ai/archive',saveInput);
    assert.equal(resaved.status,201,await resaved.clone().text());
    assert.equal((await resaved.json()).item.id,item.id);
    assert.deepEqual((await readFile(path.join(dir,'download-log'),'utf8')).trim().split('\n'),afterSaveDownloads,'saved draft remains idempotent after restart');
    const attachment = await get(`/api/competitors/${item.id}/files/${item.files[0].id}`);
    assert.equal(attachment.status,200);
    assert.equal(attachment.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await attachment.arrayBuffer()),png);
    assert.deepEqual((await readdir(cache)).sort(),previewNames);
    const savedPreview = await get(previewURL);
    assert.equal(savedPreview.status,200,'saved preview survives restart');
    assert.equal(savedPreview.headers.get('content-type'),'image/jpeg');
    await sharp(Buffer.from(await savedPreview.arrayBuffer())).raw().toBuffer();
    const all = await (await get('/api/competitors')).json();
    assert.equal(all.items.length,1); assert.equal(JSON.stringify(all).includes('test-provider-token'),false);
    assert.ifError(providerFailure);
  } finally {
    await stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(dir,{ recursive:true,force:true });
  }
});
