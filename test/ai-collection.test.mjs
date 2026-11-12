import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { mkdtemp, rm, readdir, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPublicDownloader, isPublicAddress, extractImageCandidates, collectionInput, createCompetitorCollector } from '../ai-collection.mjs';
import { createAIClient } from '../ai-client.mjs';
import { createArchiveDrafts } from '../ai-archive.mjs';
import { createAIConversationStore } from '../ai-conversation-store.mjs';
import { createPublicDownloader as publicDownloader, isPublicAddress as publicAddress } from '../public-download.mjs';

const png = await sharp({ create:{ width:2000,height:1200,channels:3,background:'#497daf' } }).png().toBuffer();
const structured = { ready:true,project:{ name:'测试楼盘',city:'成都' },floorplans:[{ label:'A户型',area:'105㎡' }],sections:{ prices:'2026-10-12 价格待补充' } };
const reply = () => ({ reply:JSON.stringify(structured),model:'test-model',searched:true,sources:[{ url:'https://estate.example.com/project',title:'成都测试楼盘官方页面' }] });
const input = { city:'成都',name:'测试楼盘',district:'高新区',model:'test-model' };

function mockRequest(responses,calls) {
  return (url,options,callback) => {
    const req = new EventEmitter();
    req.end = () => {
      calls.push({ url:url.href,options });
      queueMicrotask(() => {
        const response = responses.shift();
        const stream = Readable.from(response?.bytes ? [response.bytes] : []);
        stream.statusCode = response?.status || 200;
        stream.headers = response?.headers || { 'content-type':'text/html' };
        callback(stream);
      });
    };
    return req;
  };
}

test('Public downloads reject internal, mapped, reserved and rebinding addresses and pin public DNS', async () => {
  assert.equal(createPublicDownloader,publicDownloader);
  assert.equal(isPublicAddress,publicAddress);
  for (const ip of ['0.0.0.0','10.0.0.1','127.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','100.64.0.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(ip),false,ip);
  for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip),true,ip);
  let requests = 0;
  const rejecting = createPublicDownloader({ lookupImpl:async () => [{ address:'127.0.0.1',family:4 }],requestImpl:() => { requests++; } });
  for (const url of ['https://public.example.com/','https://127.0.0.1/','https://[::1]/','https://2130706433/','http://public.example.com/','https://user:pass@public.example.com/','https://public.example.com:444/']) await assert.rejects(rejecting(url,100));
  assert.equal(requests,0);
  const calls = [];
  let lookups = 0;
  const download = createPublicDownloader({ lookupImpl:async () => { lookups++; return [{ address:'8.8.8.8',family:4 }]; },requestImpl:mockRequest([{ bytes:Buffer.from('ok') }],calls) });
  assert.equal((await download('https://public.example.com/',100)).bytes.toString(),'ok');
  calls[0].options.lookup('public.example.com',{},(err,address,family) => { assert.equal(err,null); assert.equal(address,'8.8.8.8'); assert.equal(family,4); });
  calls[0].options.lookup('public.example.com',{ all:true },(err,addresses) => { assert.deepEqual(addresses,[{ address:'8.8.8.8',family:4 }]); });
  assert.equal(lookups,1);
  assert.equal(calls[0].options.agent,false);
  assert.equal(calls[0].options.headers.Authorization,undefined);
  const relocated = createPublicDownloader({ lookupImpl:async () => [{ address:'8.8.8.8',family:4 }],requestImpl:mockRequest([{ status:302,headers:{ location:'/project/details/' } },{ bytes:Buffer.from('page') }],[]) });
  assert.equal((await relocated('https://public.example.com/start',100)).url,'https://public.example.com/project/details/');
  const redirectCalls = [];
  const redirected = createPublicDownloader({ lookupImpl:async host => [{ address:host.startsWith('private') ? '10.0.0.1' : '8.8.8.8',family:4 }],requestImpl:mockRequest([{ status:302,headers:{ location:'https://private.example.com/' } }],redirectCalls) });
  await assert.rejects(redirected('https://public.example.com/',100));
  assert.equal(redirectCalls.length,1);
  const mixed = createPublicDownloader({ lookupImpl:async () => [{ address:'8.8.8.8',family:4 },{ address:'::ffff:127.0.0.1',family:6 }],requestImpl:mockRequest([],[]) });
  await assert.rejects(mixed('https://public.example.com/',100));
});

test('Downloads enforce redirects, byte limits, failures and cancellation', async () => {
  const lookupImpl = async () => [{ address:'8.8.8.8',family:4 }];
  for (const response of [{ bytes:Buffer.alloc(101) },{ status:403 },{ headers:{ 'content-length':'101' } },{ status:302,headers:{} }]) {
    const download = createPublicDownloader({ lookupImpl,requestImpl:mockRequest([response],[]) });
    await assert.rejects(download('https://public.example.com/',100));
  }
  const loops = Array.from({ length:4 },() => ({ status:302,headers:{ location:'/again' } }));
  await assert.rejects(createPublicDownloader({ lookupImpl,requestImpl:mockRequest(loops,[]) })('https://public.example.com/',100),/redirects/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createPublicDownloader({ lookupImpl,requestImpl:mockRequest([],[]) })('https://public.example.com/',100,controller.signal));
  const stalled = createPublicDownloader({ lookupImpl:() => new Promise(() => {}),requestImpl:mockRequest([],[]) });
  const pending = stalled('https://public.example.com/',100,AbortSignal.timeout(10));
  const keepAlive = setInterval(() => {},1000);
  try { await assert.rejects(pending); } finally { clearInterval(keepAlive); }
});

test('Image extraction only accepts actual HTTPS page candidates and excludes scripts and small logos', () => {
  const source = reply().sources[0];
  const images = extractImageCandidates(`<script><img src="https://evil.example.com/x.png"></script><img width="40" src="/logo.png"><img src="/site.png?a=1&amp;b=2" alt="项目总规划"><img data-src="https://images.example.com/a.jpg" alt="A户型"><img src="http://127.0.0.1/a"><meta property="og:image" content="/site.png?a=1&amp;b=2"><img src="javascript:alert(1)">`,source);
  assert.equal(images.length,2);
  assert.equal(images[0].url,'https://estate.example.com/site.png?a=1&b=2');
  assert.equal(images[0].description,'项目总规划');
  assert.equal(images[1].sourceUrl,source.url);
  assert.throws(() => collectionInput({ ...input,city:'' }));
  assert.throws(() => collectionInput({ ...input,model:['wrong'] }));
  const responsive = extractImageCandidates('<picture><source srcset="/small.webp 240w, /large.webp 1200w"><img data-original="relative.png"></picture><img data-srcset="/lazy.png 2x">',{ ...source,pageUrl:'https://estate.example.com/new/path/' });
  assert.deepEqual(responsive.map(image => image.url),['https://estate.example.com/large.webp','https://estate.example.com/new/path/relative.png','https://estate.example.com/lazy.png']);
  assert.equal(responsive[1].sourceUrl,source.url);
});

test('Redirected source pages resolve relative images without changing their search provenance', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-collection-redirect-'));
  const downloaded = [];
  try {
    const collector = createCompetitorCollector(dir,{ chat:async () => reply(),selectImages:async (_model,_project,candidates) => [{ id:candidates[0].id,category:'效果图' }] },{ download:async url => {
      downloaded.push(url);
      return url.endsWith('/project') ? { url:'https://estate.example.com/new/page/',type:'text/html',bytes:Buffer.from('<img src="relative.png">') } : { type:'image/png',bytes:png };
    } });
    const output = await collector.collect(input);
    assert.equal(downloaded[1],'https://estate.example.com/new/page/relative.png');
    const image = output.collection.images[0];
    assert.equal(image.sourceUrl,reply().sources[0].url);
    await collector.discard(output.collection);
    await writeFile(path.join(dir,'private.bin'),png);
    await symlink(path.join(dir,'private.bin'),path.join(dir,'cache','ai-collection',image.id+'.bin'));
    await assert.rejects(collector.image(image),error => error.status === 404);
  } finally { await rm(dir,{ recursive:true,force:true }); }
});

test('Collection fully downloads candidates before UUID visual selection and keeps partial failures as warnings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-collection-'));
  const downloads = [], calls = [];
  const client = {
    async chat(value) { calls.push(value); return reply(); },
    async selectImages(model,project,candidates) {
      assert.equal(project.name,'测试楼盘'); assert.equal(model,'test-model');
      assert.equal(candidates.length,2);
      assert.equal(downloads.length,4,'all candidates are downloaded before visual selection');
      for (const candidate of candidates) {
        assert.match(candidate.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.match(candidate.dataUrl,/^data:image\/jpeg;base64,/);
        const bytes = Buffer.from(candidate.dataUrl.split(',')[1],'base64');
        const metadata = await sharp(bytes).metadata();
        assert.equal(metadata.format,'jpeg');
        assert.equal(metadata.width,1000); assert.equal(metadata.height,600);
        await sharp(bytes).raw().toBuffer();
      }
      return [{ id:randomUUID(),category:'总规划',url:'https://evil.example.com/' },{ id:candidates[0].id,category:'总规划' },{ id:candidates[0].id,category:'效果图' },{ id:candidates[1].id,category:'户型图',floorplanIndex:0 }];
    }
  };
  const collector = createCompetitorCollector(dir,client,{ download:async (url,limit) => {
    downloads.push({url,limit});
    if (url.endsWith('/project')) return { type:'text/html',bytes:Buffer.from('<img src="/site.png" alt="总规划"><img src="/a.png" alt="A户型"><img src="/bad.png" alt="效果图">') };
    return url.endsWith('/bad.png') ? { type:'image/png',bytes:Buffer.from('<svg onload="alert(1)"/>') } : { type:'image/png',bytes:png };
  } });
  try {
    const output = await collector.collect(input);
    assert.equal(calls[0].webSearch,true); assert.equal(calls[0].archiveDraft,true);
    assert.equal(output.collection.images.length,2);
    assert.equal(output.collection.visualStatus,'completed');
    assert.equal(output.collection.images[0].slotId,'masterplan');
    assert.equal(output.collection.images[1].slotId,'floorplan-01');
    assert.equal(downloads.some(item => item.url.includes('evil')),false);
    assert.equal(downloads.filter(item => item.url.endsWith('/site.png')).length,1);
    assert.match(output.collection.warnings.join(' '),/下载失败/);
    const image = await collector.image(output.collection.images[0]);
    assert.equal(image.type,'image/jpeg');
    const metadata = await sharp(image.bytes).metadata();
    assert.equal(metadata.format,'jpeg');
    assert.equal(metadata.width,1000); assert.equal(metadata.height,600);
    await sharp(image.bytes).raw().toBuffer();
    assert.equal(output.collection.images[0].verification.fullDecode,true);
    assert.equal(output.collection.images[0].verification.sha256,createHash('sha256').update(png).digest('hex'));
    assert.equal((await readdir(path.join(dir,'cache','ai-collection'))).length,2);
    await assert.rejects(collector.image({ id:'../../auth.json' }));
    const conversations = createAIConversationStore(dir);
    let captured;
    const drafts = createArchiveDrafts(async value => { captured=value; return {id:'saved',...value.project}; },{ persistence:conversations });
    const draft = drafts.add('alice',output.result,output.collection);
    await conversations.append('alice',null,output.message,{draft},{model:input.model,webSearch:true});
    await assert.rejects(drafts.get('bob',draft.draftId),error => error.status===410);
    await assert.rejects(drafts.save('alice',{ draftId:draft.draftId,project:draft.project,imagesReviewed:true,imageIds:['unowned'] }));
    await drafts.save('alice',{ draftId:draft.draftId,project:draft.project,imagesReviewed:true,imageIds:[draft.collection.images[1].id] });
    assert.equal(captured.selectedImages.length,1);
    assert.equal(captured.selectedImages[0].slotId,'floorplan-01');
    const restored = createArchiveDrafts(async () => {},{persistence:createAIConversationStore(dir)});
    const persisted = await restored.get('alice',draft.draftId);
    assert.deepEqual(persisted.collection.images,draft.collection.images);
    await assert.rejects(restored.get('bob',draft.draftId),error => error.status===410);
    assert.equal((await createCompetitorCollector(dir,client).image(persisted.collection.images[1])).type,'image/jpeg');
  } finally { await rm(dir,{ recursive:true,force:true }); }
});

test('Image selection uses JSON candidates, exposes no token and rejects malformed selections', async () => {
  let body;
  const client = createAIClient(() => ({ baseUrl:'https://provider.example.com/v1',token:'test-secret' }),{ fetchImpl:async (_url,options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices:[{ message:{ content:'{"images":[]}' } }] }));
  } });
  const preview = await sharp(png).resize({ width:1000,height:800,fit:'inside' }).jpeg().toBuffer();
  const candidates = [{ id:randomUUID(),description:'A户型',width:2000,height:1200,dataUrl:'data:image/jpeg;base64,'+preview.toString('base64') }];
  assert.deepEqual(await client.selectImages('demo',structured.project,candidates),[]);
  assert.match(body.messages[0].content,/仅为资料/);
  const content = body.messages.find(message => message.role === 'user').content;
  assert.ok(Array.isArray(content));
  const payload = JSON.parse(content.find(part => part.type === 'text').text);
  assert.deepEqual(payload.candidates.map(candidate => candidate.id),candidates.map(candidate => candidate.id));
  const images = content.filter(part => part.type === 'image_url');
  assert.equal(images.length,candidates.length);
  assert.equal(images[0].image_url.url,candidates[0].dataUrl);
  assert.equal((await sharp(Buffer.from(images[0].image_url.url.split(',')[1],'base64')).metadata()).format,'jpeg');
  assert.equal(JSON.stringify(body).includes('test-secret'),false);
  const invalid = createAIClient(() => ({ baseUrl:'https://provider.example.com/v1',token:'test-secret' }),{ fetchImpl:async () => new Response(JSON.stringify({choices:[{message:{content:'wrong'}}]})) });
  await assert.rejects(invalid.selectImages('demo',structured.project,candidates),error => error.status===502);
});

test('Failed visual selection preserves candidates for manual classification without leaking provider errors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-collection-errors-'));
  try {
    let visualCalls = 0;
    const client = { chat:async () => reply(),selectImages:async () => { visualCalls++; throw new Error('private provider detail'); } };
    const collector = createCompetitorCollector(dir,client,{ download:async url => url.endsWith('/project') ? { type:'text/html',bytes:Buffer.from('<img src="/x.png">') } : { type:'image/png',bytes:png } });
    const output = await collector.collect(input);
    assert.equal(visualCalls,1);
    assert.equal(output.collection.images.length,1);
    assert.equal(output.collection.visualStatus,'unavailable');
    const image = output.collection.images[0];
    assert.equal(image.category,''); assert.equal(image.slotId,'');
    assert.equal(image.visualReview.status,'unavailable');
    assert.equal((await collector.image(image)).type,'image/jpeg');
    assert.equal(JSON.stringify(output).includes('private provider detail'),false);
    assert.match(output.collection.warnings.join(' '),/人工/);
    let captured;
    const drafts = createArchiveDrafts(async draft => { captured = await collector.prepare(draft); return { id:'manual',...draft.project }; });
    const draft = drafts.add('alice',output.result,output.collection);
    await drafts.save('alice',{ draftId:draft.draftId,project:draft.project,imagesReviewed:true,imageIds:[image.id],imageChoices:[{ id:image.id,category:'户型图',slotId:'floorplan-01' }] });
    assert.equal(captured.selectedImages[0].category,'户型图');
    assert.equal(captured.selectedImages[0].slotId,'floorplan-01');
    assert.equal(captured.selectedImages[0].cacheImageId,image.id);
    assert.deepEqual((await collector.image(captured.selectedImages[0])).bytes,png);
    await collector.discard({ images:captured.selectedImages });
    assert.equal((await collector.image(image)).type,'image/jpeg');
    await assert.rejects(collector.collect({ ...input,city:'上海' }),error => error.status===422);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(collector.collect(input,controller.signal),error => error.status===499);
    const broken = createCompetitorCollector(dir,client,{ download:async () => { throw new Error('blocked'); } });
    assert.match((await broken.collect(input)).collection.warnings.join(' '),/未找到/);
  } finally { await rm(dir,{ recursive:true,force:true }); }
});

test('Archive image review is explicit for selected images; text-only drafts need no review', async () => {
  const images = [
    { id:randomUUID(),category:'总规划',slotId:'masterplan' },
    { id:randomUUID(),category:'户型图',slotId:'floorplan-01' },
    { id:randomUUID(),category:'',slotId:'' }
  ];
  const saved = [];
  const drafts = createArchiveDrafts(async draft => { saved.push(draft); return { id:randomUUID(),...draft.project }; });
  const draft = drafts.add('alice',reply(),{ images,warnings:[] });
  const base = { draftId:draft.draftId,project:draft.project,imageIds:[images[0].id] };
  for (const imagesReviewed of [undefined,false,'true',1,null,{},[]]) {
    await assert.rejects(drafts.save('alice',{ ...base,...(imagesReviewed === undefined ? {} : { imagesReviewed }) }),error => error.status===400);
  }
  await assert.rejects(drafts.save('bob',{ ...base,imagesReviewed:true }),error => error.status===410);
  const foreign = { id:randomUUID(),category:'效果图',slotId:'' };
  drafts.add('bob',reply(),{ images:[foreign],warnings:[] });
  await assert.rejects(drafts.save('alice',{ ...base,imagesReviewed:true,imageIds:[foreign.id] }),error => error.status===400);
  for (const imageIds of [[images[0].id,images[0].id],['unowned'],'wrong']) {
    await assert.rejects(drafts.save('alice',{ ...base,imageIds,imagesReviewed:true }),error => error.status===400);
  }
  for (const imageChoices of [
    'wrong',
    [{ id:randomUUID(),category:'效果图',slotId:'' }],
    [{ id:images[0].id,category:'航拍',slotId:'' }],
    [{ id:images[0].id,category:'总规划',slotId:'floorplan-01' }],
    [{ id:images[0].id,category:'户型图',slotId:'floorplan-99' }],
    [{ id:images[0].id,category:'效果图',slotId:'masterplan' }],
    [{ id:images[0].id,category:'总规划',slotId:'masterplan' },{ id:images[0].id,category:'效果图',slotId:'' }]
  ]) await assert.rejects(drafts.save('alice',{ ...base,imagesReviewed:true,imageChoices }),error => error.status===400);
  await assert.rejects(drafts.save('alice',{ ...base,imageIds:images.slice(0,2).map(image => image.id),imagesReviewed:true,imageChoices:images.slice(0,2).map(image => ({ id:image.id,category:'总规划',slotId:'masterplan' })) }),error => error.status===400);
  await assert.rejects(drafts.save('alice',{ ...base,imageIds:[images[2].id],imagesReviewed:true }),error => error.status===400);
  assert.equal(saved.length,0);
  await drafts.save('alice',{ ...base,imagesReviewed:true });
  assert.deepEqual(saved[0].selectedImages,[images[0]],'omitted choices retain existing classifications');
  const omitted = drafts.add('alice',reply(),{ images,warnings:[] });
  await drafts.save('alice',{ draftId:omitted.draftId,project:omitted.project,imagesReviewed:true,imageIds:[] });
  assert.deepEqual(saved[1].selectedImages,[]);
  for (const collection of [undefined,{ images:[],warnings:[] }]) {
    const text = drafts.add('alice',reply(),collection);
    await drafts.save('alice',{ draftId:text.draftId,project:text.project });
    assert.deepEqual(saved.at(-1).selectedImages,[]);
  }
});

test('Only fully decoded candidates at least 600×400 become previews', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-collection-validation-'));
  const boundary = await sharp({ create:{ width:600,height:400,channels:3,background:'#497daf' } }).png().toBuffer();
  const narrow = await sharp(png).resize(599,400).png().toBuffer();
  const short = await sharp(png).resize(600,399).png().toBuffer();
  const tall = await sharp(png).resize(1200,2000).png().toBuffer();
  const samples = new Map([
    ['/boundary.png',{ type:'image/png',bytes:boundary }],
    ['/tall.png',{ type:'image/png',bytes:tall }],
    ['/narrow.png',{ type:'image/png',bytes:narrow }],
    ['/short.png',{ type:'image/png',bytes:short }],
    ['/truncated.png',{ type:'image/png',bytes:png.subarray(0,Math.floor(png.length/2)) }],
    ['/mismatch.png',{ type:'image/jpeg',bytes:png }],
    ['/html.png',{ type:'image/png',bytes:Buffer.from('<html>not an image</html>') }]
  ]);
  try {
    const collector = createCompetitorCollector(dir,{ chat:async () => reply(),selectImages:async (_model,_project,candidates) => {
      assert.equal(candidates.length,2);
      assert.equal(candidates[0].width,600); assert.equal(candidates[0].height,400);
      return candidates.map(candidate => ({ id:candidate.id,category:'效果图' }));
    } },{ download:async url => url.endsWith('/project') ? { type:'text/html',bytes:Buffer.from([...samples.keys()].map(src => `<img src="${src}">`).join('')) } : samples.get(new URL(url).pathname) });
    const output = await collector.collect(input);
    assert.equal(output.collection.images.length,2);
    assert.equal(output.collection.visualStatus,'completed');
    assert.equal(output.collection.warnings.length,5);
    assert.equal((await readdir(path.join(dir,'cache','ai-collection'))).length,2);
    const preview = await collector.image(output.collection.images[0]);
    assert.equal(preview.type,'image/jpeg');
    const metadata = await sharp(preview.bytes).metadata();
    assert.equal(metadata.width,600); assert.equal(metadata.height,400);
    await sharp(preview.bytes).raw().toBuffer();
    const portrait = await collector.image(output.collection.images[1]);
    const portraitMetadata = await sharp(portrait.bytes).metadata();
    assert.equal(portrait.type,'image/jpeg');
    assert.equal(portraitMetadata.format,'jpeg');
    assert.equal(portraitMetadata.width,480); assert.equal(portraitMetadata.height,800);
    await sharp(portrait.bytes).raw().toBuffer();
  } finally { await rm(dir,{ recursive:true,force:true }); }
});

test('Prepare downloads only confirmed originals, preserves PNG bytes and leaves previews independently cached', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-collection-prepare-'));
  const downloads = [];
  try {
    const collector = createCompetitorCollector(dir,{ chat:async () => reply(),selectImages:async (_model,_project,candidates) => candidates.map(candidate => ({ id:candidate.id,category:'效果图' })) },{ download:async url => {
      downloads.push(url);
      return url.endsWith('/project') ? { type:'text/html',bytes:Buffer.from('<img src="/a.png"><img src="/b.png">') } : { type:'image/png',bytes:png,url };
    } });
    const output = await collector.collect(input);
    const preview = output.collection.images[0];
    assert.equal(downloads.length,3);
    const empty = { selectedImages:[] };
    assert.equal(await collector.prepare(empty),empty);
    assert.equal(downloads.length,3);
    const prepared = await collector.prepare({ selectedImages:[preview] });
    assert.equal(downloads.length,4);
    assert.equal(downloads[3],preview.imageUrl);
    const original = prepared.selectedImages[0];
    assert.notEqual(original.id,preview.id);
    assert.equal(original.cacheImageId,preview.id);
    assert.equal(original.type,'image/png');
    assert.equal(original.width,2000); assert.equal(original.height,1200);
    assert.equal(original.originalBytesPreserved,true);
    assert.equal(original.verification.sha256,preview.verification.sha256);
    assert.deepEqual((await collector.image(original)).bytes,png);
    assert.equal((await readdir(path.join(dir,'cache','ai-collection'))).length,3);
    await collector.discard({ images:prepared.selectedImages });
    assert.deepEqual((await readdir(path.join(dir,'cache','ai-collection'))).sort(),output.collection.images.map(image => image.id+'.bin').sort());
    assert.equal((await collector.image(preview)).type,'image/jpeg');
  } finally { await rm(dir,{ recursive:true,force:true }); }
});

for (const [width,height] of [[600,400],[400,600],[1400,900],[700,1050]]) test(`Preview and save accept ${width}×${height} without altering source bytes`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-collection-original-boundary-'));
  const original = await sharp(png).resize(width,height).png().toBuffer();
  try {
    const collector = createCompetitorCollector(dir,{ chat:async () => reply(),selectImages:async (_model,_project,candidates) => [{ id:candidates[0].id,category:'效果图' }] },{ download:async url => url.endsWith('/project') ? { type:'text/html',bytes:Buffer.from('<img src="/a.png">') } : { type:'image/png',bytes:original } });
    const output = await collector.collect(input);
    const prepared = await collector.prepare({ selectedImages:output.collection.images });
    assert.equal(prepared.selectedImages[0].width,width);
    assert.equal(prepared.selectedImages[0].height,height);
    assert.equal(output.collection.images[0].quality.level,'limited');
    assert.deepEqual((await collector.image(prepared.selectedImages[0])).bytes,original);
  } finally { await rm(dir,{ recursive:true,force:true }); }
});

test('Prepare rejects small, changed or invalid originals and cleans partial original caches, not previews', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-collection-original-errors-'));
  let saving = false, replacement;
  try {
    const collector = createCompetitorCollector(dir,{ chat:async () => reply(),selectImages:async (_model,_project,candidates) => candidates.map(candidate => ({ id:candidate.id,category:'效果图' })) },{ download:async url => {
      if (url.endsWith('/project')) return { type:'text/html',bytes:Buffer.from('<img src="/a.png"><img src="/b.png">') };
      return saving && url.endsWith('/b.png') ? replacement : { type:'image/png',bytes:png };
    } });
    const output = await collector.collect(input);
    const before = (await readdir(path.join(dir,'cache','ai-collection'))).sort();
    const changed = await sharp({ create:{ width:2000,height:1200,channels:3,background:'#ba7448' } }).png().toBuffer();
    const narrow = await sharp(png).resize(599,400).png().toBuffer();
    const short = await sharp(png).resize(2000,399).png().toBuffer();
    saving = true;
    for (const sample of [
      { type:'image/png',bytes:narrow },{ type:'image/png',bytes:short },
      { type:'image/png',bytes:changed },{ type:'image/jpeg',bytes:png },
      { type:'image/png',bytes:png.subarray(0,Math.floor(png.length/2)) },
      { type:'image/png',bytes:Buffer.from('<svg/>') }
    ]) {
      replacement = sample;
      await assert.rejects(collector.prepare({ selectedImages:output.collection.images }),error => error.status===422 && /未保存档案/.test(error.message));
      assert.deepEqual((await readdir(path.join(dir,'cache','ai-collection'))).sort(),before);
      assert.equal((await collector.image(output.collection.images[0])).type,'image/jpeg');
    }
    replacement = { type:'image/png',bytes:png };
    const retry = await collector.prepare({ selectedImages:output.collection.images });
    assert.equal(retry.selectedImages.length,2);
  } finally { await rm(dir,{ recursive:true,force:true }); }
});

for (const storage of ['json','sqlite']) test(`Confirmed images commit with the archive and preserve sources without duplicates (${storage})`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'workbench-collected-save-'));
  const cache = path.join(dir,'cache','ai-collection');
  const image = { id:'11111111-1111-4111-8111-111111111111',cacheImageId:randomUUID(),category:'户型图',slotId:'floorplan-01',type:'image/png',name:'A.png',sourceUrl:'https://estate.example.com/project',imageUrl:'https://images.example.com/a.png' };
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const root = new URL('../',import.meta.url);
  const code = `
    const assert = (await import('node:assert/strict')).default;
    const { readFile, readdir, symlink } = await import('node:fs/promises');
    const { createAICompetitor, listCompetitors } = await import('./competitor-store.mjs');
    const { parseArchiveReply } = await import('./ai-archive.mjs');
    const image = ${JSON.stringify(image)};
    const draft = {...parseArchiveReply(${JSON.stringify(reply())}),draftId:'test-draft',selectedImages:[image],collection:{images:[image],warnings:[]}};
    const first = await createAICompetitor(draft);
    assert.equal(first.files.length,1); assert.equal(first.files[0].sourceUrl,image.sourceUrl);
    assert.equal(first.files[0].cacheImageId,image.cacheImageId);
    assert.equal(first.files[0].type,'image/png');
    assert.equal(first.files[0].slotId,'floorplan-01'); assert.equal(first.visits.length,0);
    assert.equal(first.aiResearch.imageSources[0].imageUrl,image.imageUrl);
    assert.deepEqual(await readFile(process.env.WORKBENCH_DATA_DIR+'/competitor-files/'+first.files[0].storedName),Buffer.from('${png.toString('base64')}','base64'));
    assert.equal((await createAICompetitor(draft)).id,first.id);
    assert.equal((await listCompetitors()).length,1);
    await assert.rejects(createAICompetitor({...draft,draftId:'conflict'}),error=>error.status===409);
    assert.equal((await listCompetitors())[0].files.length,1);
    await assert.rejects(createAICompetitor({...draft,draftId:'missing',project:{...draft.project,name:'另一个楼盘'},selectedImages:[{...image,id:'22222222-2222-4222-8222-222222222222'}]}),error=>error.status===410);
    await symlink(process.env.WORKBENCH_DATA_DIR+'/competitors-private.bin',process.env.WORKBENCH_DATA_DIR+'/cache/ai-collection/33333333-3333-4333-8333-333333333333.bin');
    await assert.rejects(createAICompetitor({...draft,draftId:'linked',project:{...draft.project,name:'另一个楼盘'},selectedImages:[{...image,id:'33333333-3333-4333-8333-333333333333'}]}),error=>error.status===404);
    assert.equal((await listCompetitors()).length,1);
  `;
  try {
    await mkdir(cache,{ recursive:true }); await writeFile(path.join(cache,image.id+'.bin'),png);
    await writeFile(path.join(dir,'competitors-private.bin'),png);
    const child = spawn(process.execPath,['--input-type=module','-e',code],{ cwd:root,env:{ ...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PUBLIC_ORIGIN:'',WORKBENCH_DATA_DIR:dir,WORKBENCH_STORAGE:storage,WORKBENCH_HOME_VISUAL:'false',WORKBENCH_TRUST_PROXY:'false',WORKBENCH_IMAGE_PROXY:'' },stdio:['ignore','pipe','pipe'] });
    let errors = ''; child.stderr.on('data',chunk => { errors += chunk; });
    const [exit] = await once(child,'exit'); assert.equal(exit,0,errors);
    const top = await readdir(path.join(dir,'competitor-files'));
    let count=0;
    for (const project of top) {
      const entries = await readdir(path.join(dir,'competitor-files',project,'floorplans','floorplan-01'));
      count += entries.length;
    }
    assert.equal(count,1,'failed conflicting save leaves no extra attachment bytes');
  } finally { await rm(dir,{ recursive:true,force:true }); }
});
