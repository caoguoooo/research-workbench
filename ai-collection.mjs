import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ArchiveError } from './competitor-store.mjs';
import { parseArchiveReply } from './ai-archive.mjs';
import { createPublicDownloader, publicURL } from './public-download.mjs';
import { inspectRaster, imagePreview, MAX_IMAGE_BYTES } from './image-raster.mjs';
import { createCommonsImages, checkOriginal } from './commons-images.mjs';
export { createPublicDownloader, isPublicAddress } from './public-download.mjs';

const entities = value => value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi,token => {
  const known = { '&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>' };
  if (known[token.toLowerCase()]) return known[token.toLowerCase()];
  const code = Number(token.toLowerCase().startsWith('&#x') ? '0x'+token.slice(3,-1) : token.slice(2,-1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
});

export function extractImageCandidates(html, source) {
  html = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
  const images = new Map();
  for (const match of html.matchAll(/<(img|meta|source)\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...match[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(item => [item[1].toLowerCase(),entities(item[2] ?? item[3] ?? item[4])]));
    const tag = match[1].toLowerCase();
    const responsive = (attrs['data-srcset'] || attrs.srcset || '').split(',').map(item => item.trim().split(/\s+/)).filter(([url,descriptor]) => url && (!descriptor || /^\d+(?:\.\d+)?[wx]$/.test(descriptor))).sort((a,b) => (parseFloat(b[1]) || 1)-(parseFloat(a[1]) || 1))[0]?.[0];
    const value = tag === 'meta' ? ['og:image','twitter:image'].includes(attrs.property || attrs.name) ? attrs.content : null : responsive || attrs['data-src'] || attrs['data-original'] || attrs.src;
    if (!value || (attrs.width && Number(attrs.width) < 240) || (attrs.height && Number(attrs.height) < 160)) continue;
    let url;
    try { url = publicURL(value,source.pageUrl || source.url).href; } catch { continue; }
    if (images.has(url) || images.size >= 16) continue;
    const context = html.slice(Math.max(0,match.index-180),match.index+match[0].length+180).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').slice(0,360);
    images.set(url,{ url,sourceUrl:source.url,title:source.title,description:(attrs.alt || attrs.title || context).slice(0,360) });
  }
  return [...images.values()];
}

export function collectionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('收集参数不正确');
  const output = {};
  for (const [key,label,max,required] of [['city','城市',60,true],['name','楼盘名称',100,true],['district','区域',60,false],['model','模型名称',200,true],['imageQuery','Commons 图片关键词',300,false]]) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value) || (required && !value.trim())) throw new ArchiveError(`请填写有效的${label}`);
    output[key] = value.trim();
  }
  return output;
}

export function createCompetitorCollector(dataRoot, client, { download = createPublicDownloader() } = {}) {
  const directory = path.join(dataRoot,'cache','ai-collection');
  const commons = createCommonsImages(download);
  let cacheQueue = Promise.resolve();
  const imagePath = id => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new ArchiveError('图片编号不正确',404);
    return path.join(directory,id+'.bin');
  };
  async function cache(id,bytes,signal) {
    const pending = cacheQueue.then(async () => {
      signal?.throwIfAborted();
      let size = 0;
      for (const filename of await readdir(directory)) if (/^[0-9a-f-]{36}\.bin$/.test(filename)) size += (await stat(path.join(directory,filename))).size;
      if (size+bytes.length > 120*1024*1024) throw new ArchiveError('图片草稿缓存已满，现有资料不会删除',429);
      await writeFile(imagePath(id),bytes,{ flag:'wx',mode:0o600 });
    });
    cacheQueue = pending.catch(() => {});
    await pending;
  }
  return {
    async collect(input,signal) {
      const target = collectionInput(input);
      const message = { role:'user',content:`联网收集以下唯一竞品的公开资料并直接整理为档案：${JSON.stringify(target)}。确认项目身份，优先官方、开发商、政府，其次公开房产网站。覆盖基础信息、规划指标、产品户型、价格与信息日期，以及总规划、效果图、户型图来源页面。无法核实的字段留空，冲突列出，不假装已下载图片。` };
      const result = await client.chat({ model:target.model,webSearch:true,archiveDraft:true,messages:[message] },signal);
      const draft = parseArchiveReply(result);
      const cityKey = value => value.replace(/市$/,'').replace(/\s+/g,'');
      if (cityKey(draft.project.city) !== cityKey(target.city)) throw new ArchiveError('检索结果城市不一致，请确认项目身份后重试',422);
      const nameKey = value => value.replace(/[\s·•・]/g,'').toLocaleLowerCase();
      if (nameKey(draft.project.name) !== nameKey(target.name)) throw new ArchiveError('检索结果楼盘名称不一致，请确认项目正式名称后重试',422);
      const images = [], warnings = [], candidates = [], visualCandidates = [];
      let visualStatus = 'unavailable';
      try {
        await mkdir(directory,{ recursive:true,mode:0o700 });
        for (const source of result.sources.slice(0,4)) {
          signal?.throwIfAborted();
          try {
            const page = await download(source.url,1024*1024,signal);
            if (page.type === 'text/html') candidates.push(...extractImageCandidates(page.bytes.toString('utf8'),{ ...source,pageUrl:page.url }));
          } catch { if (signal?.aborted) throw signal.reason; warnings.push('一个来源网页无法安全读取，已保留检索来源，可手动核查。'); }
        }
        if (target.imageQuery) {
          try {
            const found = await commons.search(target.imageQuery,4,signal);
            candidates.unshift(...found.candidates.map(item => ({ url:item.previewUrl,sourceUrl:item.sourcePage,title:item.title,description:item.description,commons:item })));
          } catch { if (signal?.aborted) throw signal.reason; warnings.push('Commons 图片检索失败，已继续检查项目网页。'); }
        }
        const unique = [...new Map(candidates.map(image => [image.url,image])).values()].slice(0,8);
        for (const candidate of unique) {
          signal?.throwIfAborted();
          try {
            const response = await download(candidate.url,MAX_IMAGE_BYTES,signal);
            const checked = await inspectRaster(response.bytes,response.type);
            if (checked.width < 600 || checked.height < 400) throw new Error('Preview too small');
            const preview = await imagePreview(response.bytes), id = randomUUID();
            await cache(id,preview,signal);
            const original = candidate.commons;
            images.push({ id,category:'',slotId:'',name:candidate.title || '来源图片',type:'image/jpeg',size:preview.length,sourceUrl:candidate.sourceUrl,imageUrl:original?.originalUrl || candidate.url,description:candidate.description,width:original?.width || checked.width,height:original?.height || checked.height,author:original?.author || '',license:original?.license || { name:'未知，需联系权利人确认' },commonsPageId:original?.pageId || null,commonsSha1:original?.sha1 || null,originalStatus:original ? 'commons-original' : 'source-file-unconfirmed',verification:checked,visualReview:{ status:'unavailable',reason:'尚未完成视觉筛选',watermark:'unknown' } });
            visualCandidates.push({ id,description:candidate.description,title:candidate.title,width:checked.width,height:checked.height,dataUrl:'data:image/jpeg;base64,'+preview.toString('base64') });
          } catch { if (signal?.aborted) throw signal.reason; warnings.push('一个候选图片下载失败、尺寸不足或无法完整解码，未纳入预览。'); }
        }
        if (visualCandidates.length) {
          let choices = [];
          try {
            choices = await client.selectImages(target.model,{ ...draft.project,floorplans:draft.floorplans },visualCandidates,signal);
            visualStatus = 'completed';
            for (const image of images) image.visualReview = { status:'completed',reason:'模型未推荐；仍需人工核查',watermark:'unknown' };
          } catch { if (signal?.aborted) throw signal.reason; warnings.push('视觉模型未完成筛选，候选已保留，请人工看图、分类并确认。'); }
          const used = new Set(), slots = new Set();
          for (const choice of choices) {
            const candidate = images.find(image => image.id === choice?.id);
            if (!candidate || used.has(candidate.id) || !['总规划','效果图','户型图'].includes(choice.category)) continue;
            const slotId = choice.category === '总规划' ? 'masterplan' : choice.category === '户型图' && Number.isInteger(choice.floorplanIndex) && draft.floorplans[choice.floorplanIndex] ? `floorplan-${String(choice.floorplanIndex+1).padStart(2,'0')}` : '';
            if ((choice.category === '户型图' && !slotId) || (slotId && slots.has(slotId))) continue;
            used.add(candidate.id);
            Object.assign(candidate,{ category:choice.category,slotId,visualReview:{ status:'completed',reason:typeof choice.reason === 'string' ? choice.reason.slice(0,500) : '模型推荐，仍需人工核查',watermark:['present','absent','unknown'].includes(choice.watermark) ? choice.watermark : 'unknown' } });
            if (slotId) slots.add(slotId);
          }
        }
      } catch (error) {
        if (signal?.aborted) {
          await Promise.all(images.map(image => unlink(imagePath(image.id)).catch(() => {})));
          throw new ArchiveError('已停止本次收集',499);
        }
        warnings.push(error instanceof ArchiveError ? error.message : '图片收集未完成，文字草稿仍可保存。');
      }
      if (!images.length) warnings.push('未找到可安全下载并匹配该项目的图片，已保留检索来源。');
      return { result,message,collection:{ target:{ city:target.city,name:target.name,district:target.district },images,warnings,visualStatus } };
    },
    async prepare(draft) {
      if (!draft.selectedImages?.length) return draft;
      const prepared = [];
      try {
        for (const image of draft.selectedImages) {
          const original = image.commonsPageId ? await commons.original(image.commonsPageId) : null;
          if (original && (original.originalUrl !== image.imageUrl || original.sha1 !== image.commonsSha1)) throw new Error('Source identity changed');
          const response = await download(original?.originalUrl || image.imageUrl,MAX_IMAGE_BYTES);
          const checked = await inspectRaster(response.bytes,response.type);
          if (checked.width < 1600 || checked.height < 600) throw new Error('原文件不足 1600×600 像素');
          if (original) checkOriginal(original,checked,1600);
          else if (checked.sha256 !== image.verification.sha256) throw new Error('网页图片已变化，请重新收集');
          const id = randomUUID();
          await cache(id,response.bytes);
          prepared.push({ ...image,id,cacheImageId:image.id,type:response.type,size:response.bytes.length,name:image.category+'.'+(checked.format === 'jpeg' ? 'jpg' : checked.format),width:checked.width,height:checked.height,verification:checked,downloadedUrl:response.url || image.imageUrl,downloadedAt:new Date().toISOString(),originalBytesPreserved:true,humanConfirmedAt:new Date().toISOString(),...(original ? { author:original.author,license:original.license } : {}) });
        }
        return { ...draft,selectedImages:prepared };
      } catch (error) {
        await Promise.all(prepared.map(image => unlink(imagePath(image.id)).catch(() => {})));
        throw new ArchiveError('所选原文件下载或校验失败，未保存档案。请取消该图或重新收集：'+(error.message.includes('原文件') || error.message.includes('网页图片') ? error.message : '来源不可用或内容不匹配'),422);
      }
    },
    async discard(collection) {
      await Promise.all((collection?.images || []).map(image => unlink(imagePath(image.id)).catch(() => {})));
    },
    async image(image) {
      try {
        const base = await realpath(directory);
        const filename = await realpath(imagePath(image.id));
        if (!filename.startsWith(base+path.sep)) throw new ArchiveError('草稿图片路径不正确',404);
        const info = await stat(filename);
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new ArchiveError('草稿图片不可用',410);
        const bytes = await readFile(filename);
        await inspectRaster(bytes,image.type);
        return { bytes,type:image.type };
      }
      catch (error) { if (error.code === 'ENOENT') throw new ArchiveError('草稿图片已不可用，请重新收集或手动上传',410); throw error; }
    }
  };
}
