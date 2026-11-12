import { mkdir, readFile, rename, writeFile, unlink, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectRaster, MAX_IMAGE_BYTES } from './image-raster.mjs';
import { BASIC_INFO_FIELDS, AMENITY_CATEGORIES, validLocation, SCHOOL_TYPES } from './project-details.js';

export class ArchiveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const dataRoot = path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'));
const filePath = path.join(dataRoot, 'competitors.json');
const referencesRoot = path.resolve(process.env.WORKBENCH_REFERENCES_DIR || path.join(dataRoot,'assets','references'));
const storage = process.env.WORKBENCH_STORAGE || (process.env.NODE_ENV === 'production' ? 'sqlite' : 'json');
if (!['sqlite', 'json'].includes(storage)) throw new Error('WORKBENCH_STORAGE 仅支持 sqlite 或 json');
const repository = storage === 'sqlite' ? (await import('./sqlite-repository.mjs')).createSQLiteRepository(dataRoot, normalizeArchive) : null;
let writeQueue = Promise.resolve();

function text(value, label, max, required = false) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new ArchiveError(`请填写${label}`);
  if (result.length > max) throw new ArchiveError(`${label}不能超过 ${max} 字`);
  return result;
}

function date(value, label) {
  const result = text(value, label, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) {
    throw new ArchiveError(`${label}格式不正确`);
  }
  return result;
}

function competitorFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('档案内容格式不正确');
  return {
    name: text(input.name, '楼盘名称', 100, true),
    city: text(input.city, '城市', 60),
    district: text(input.district, '区域', 60),
    address: text(input.address, '地址', 200),
    developer: text(input.developer, '开发商', 100),
    status: text(input.status, '销售状态', 40),
    positioning: text(input.positioning, '项目定位', 500),
    summary: text(input.summary, '项目概况', 3000),
    ...(Object.hasOwn(input, 'basicInfo') ? { basicInfo: basicInfoFields(input.basicInfo) } : {})
  };
}

function basicInfoFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('项目基本信息格式不正确');
  return Object.fromEntries(BASIC_INFO_FIELDS.map(([key, label, max]) => [key, text(input[key], label, max)]));
}

function locationFields(input) {
  if (input === null || input === undefined) return null;
  if (!validLocation(input)) throw new ArchiveError('请填写有效的经纬度');
  return { lat: input.lat, lng: input.lng };
}

function amenityFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('周边配套格式不正确');
  if (!Array.isArray(input.places) || input.places.length > 100) throw new ArchiveError('配套点位不能超过 100 个');
  if (!input.summary || typeof input.summary !== 'object' || Array.isArray(input.summary)) throw new ArchiveError('配套说明格式不正确');
  return {
    location: locationFields(input.location),
    summary: Object.fromEntries(AMENITY_CATEGORIES.map(([key, label]) => [key, text(input.summary[key], label, 2000)])),
    places: input.places.map(place => {
      if (!place || !AMENITY_CATEGORIES.some(([key]) => place.category === key)) throw new ArchiveError('请选择有效的配套分类');
      if (place.schoolType !== undefined && (place.category !== 'education' || !Object.values(SCHOOL_TYPES).includes(place.schoolType))) throw new ArchiveError('教育配套学校类型不正确');
      const source = text(place.sourceUrl, '配套来源', 2048);
      if (source && !/^https:\/\/www\.amap\.com\/(?:place\/[a-z0-9]+)?$/i.test(source)) throw new ArchiveError('配套来源地址不正确');
      return { name: text(place.name, '配套名称', 100, true), category: place.category, ...(place.schoolType ? { schoolType: place.schoolType } : {}), address: text(place.address, '配套地址', 200), location: locationFields(place.location), ...(source ? { sourceUrl: source } : {}) };
    })
  };
}

function visitFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('踩盘记录格式不正确');
  return {
    visitedAt: date(input.visitedAt, '踩盘日期'),
    observer: text(input.observer, '踩盘人', 80),
    priceSummary: text(input.priceSummary, '价格信息', 1000),
    products: text(input.products, '产品户型', 1500),
    notes: text(input.notes, '现场观察', 5000)
  };
}

function defaultFloorplans() {
  return [1, 2, 3].map(number => ({
    id: `floorplan-${String(number).padStart(2, '0')}`,
    label: `户型 ${String(number).padStart(2, '0')}`,
    area: '',
    rooms: '',
    notes: ''
  }));
}

function floorplanFields(input, fallbackLabel) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('户型内容格式不正确');
  return {
    label: text(input.label || fallbackLabel, '户型名称', 80, true),
    area: text(input.area, '建筑面积', 40),
    rooms: text(input.rooms, '房型', 40),
    notes: text(input.notes, '户型备注', 500)
  };
}

function normalizeArchive(archive) {
    if (archive.version !== 1 || !Array.isArray(archive.competitors)) throw new Error('竞品档案数据格式不正确');
    for (const item of archive.competitors) {
      if (!Array.isArray(item.files) || !Array.isArray(item.visits)) throw new Error('竞品关联数据格式不正确');
      if (!Array.isArray(item.floorplans)) item.floorplans = defaultFloorplans();
      for (const fallback of defaultFloorplans()) {
        if (item.floorplans.length >= 3) break;
        if (!item.floorplans.some(slot => slot.id === fallback.id)) item.floorplans.push(fallback);
      }
      const occupied = new Set(item.files.filter(file => file.category === '户型图' && file.slotId).map(file => file.slotId));
      for (const file of item.files.filter(file => file.category === '户型图' && !file.slotId)) {
        let available = item.floorplans.find(slot => !occupied.has(slot.id));
        if (!available && item.floorplans.length < 24) {
          const number = item.floorplans.length + 1;
          available = { id: `floorplan-${String(number).padStart(2, '0')}`, label: `户型 ${String(number).padStart(2, '0')}`, area: '', rooms: '', notes: '' };
          item.floorplans.push(available);
        }
        if (available) { file.slotId = available.id; occupied.add(available.id); }
      }
    }
    return archive;
}

export async function initializeArchive() { if (repository) await repository.initialize(); }

export async function readArchive() {
  if (repository) return repository.read();
  try {
    const archive = JSON.parse(await readFile(filePath, 'utf8'));
    return normalizeArchive(archive);
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, competitors: [] };
    throw error;
  }
}

async function saveArchive(archive) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(archive, null, 2), { mode: 0o600 });
  await rename(temporary, filePath);
}

function mutate(change) {
  if (repository) return repository.mutate(change);
  const pending = writeQueue.then(async () => {
    const archive = await readArchive();
    const result = change(archive.competitors, archive);
    await saveArchive(archive);
    return result;
  });
  writeQueue = pending.catch(() => {});
  return pending;
}

function findCompetitor(items, id, includeDeleted = false) {
  const item = items.find(entry => entry.id === id && (includeDeleted || !entry.deletedAt));
  if (!item) throw new ArchiveError('找不到这份竞品档案', 404);
  return item;
}

export function mutateResearchArchive(change) {
  return mutate((items, archive) => change(archive, { competitorFields, defaultFloorplans, findCompetitor }));
}

export async function listCompetitors({ deletedOnly = false, summaryOnly = false } = {}) {
  if (repository && summaryOnly) return repository.listSummaries({ deletedOnly });
  const archive = await readArchive();
  return archive.competitors.filter(item => deletedOnly ? !!item.deletedAt : !item.deletedAt)
    .sort((a, b) => (deletedOnly ? b.deletedAt.localeCompare(a.deletedAt) : b.updatedAt.localeCompare(a.updatedAt)))
    .map(item => summaryOnly ? {
      id: item.id, name: item.name, city: item.city || '', district: item.district || '', developer: item.developer || '',
      updatedAt: item.updatedAt, deletedAt: item.deletedAt || null, overviewRevision: item.overviewRevision || 0,
      fileCount: item.files.length, visitCount: item.visits.length
    } : ({ ...item, overviewRevision: item.overviewRevision || 0 }));
}

export async function getCompetitor(id) {
  const item = repository ? await repository.get(id) : findCompetitor((await readArchive()).competitors, id);
  if (!item || item.deletedAt) throw new ArchiveError('找不到这份竞品档案', 404);
  return { ...item, overviewRevision: item.overviewRevision || 0 };
}

export function createCompetitor(input) {
  const fields = competitorFields(input);
  return mutate(items => {
    const now = new Date().toISOString();
    const item = { id: randomUUID(), ...fields, floorplans: defaultFloorplans(), visits: [], files: [], createdAt: now, updatedAt: now };
    items.push(item);
    return item;
  });
}

// Create the project and all AI research fields in one storage transaction.
export async function createAICompetitor(draft) {
  const fields = competitorFields(draft.project);
  if (!fields.city) throw new ArchiveError('请填写城市');
  const floorplans = draft.floorplans.map((slot, i) => ({ id:`floorplan-${String(i+1).padStart(2,'0')}`, ...floorplanFields(slot, `户型 ${i+1}`) }));
  const key = value => value.trim().replace(/市$/, '').replace(/\s+/g, '').toLocaleLowerCase();
  const existing = (await readArchive()).competitors.find(item => item.aiResearch?.draftId === draft.draftId);
  if (existing) {
    if (existing.deletedAt) throw new ArchiveError('该档案已在回收站，请先恢复',409);
    return existing;
  }
  if ((draft.selectedImages || []).filter(image => image.category === '效果图').length > 6) throw new ArchiveError('一个楼盘最多保存 6 张效果图');
  const id = randomUUID(), files = [], written = [];
  try {
    for (const image of draft.selectedImages || []) {
      if (!/^[0-9a-f-]{36}$/.test(image.id) || !['总规划','效果图','户型图'].includes(image.category) || (image.category === '总规划' && image.slotId !== 'masterplan') || (image.category === '户型图' && !floorplans.some(slot => slot.id === image.slotId)) || (image.category === '效果图' && image.slotId)) throw new ArchiveError('草稿图片关联不正确');
      let content;
      try {
        const base = await realpath(path.join(dataRoot,'cache','ai-collection'));
        const filename = await realpath(path.join(base,image.id+'.bin'));
        if (!filename.startsWith(base+path.sep)) throw new ArchiveError('草稿图片路径不正确',404);
        const info = await stat(filename);
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new ArchiveError('草稿图片不可用',410);
        content = await readFile(filename);
        if (content.length > MAX_IMAGE_BYTES) throw new ArchiveError('草稿图片不可用',410);
      }
      catch (error) { if (error.code === 'ENOENT') throw new ArchiveError('草稿图片已不可用，请取消选择或重新收集',410); throw error; }
      const checked = await inspectRaster(content,image.type);
      if (image.verification && checked.sha256 !== image.verification.sha256) throw new ArchiveError('草稿原文件校验不一致',410);
      const fileId = randomUUID();
      const folder = image.category === '总规划' ? 'masterplan' : image.category === '效果图' ? 'renderings' : path.join('floorplans',image.slotId);
      const storedName = path.join(id,folder,fileId+'.bin');
      const filename = path.join(dataRoot,'competitor-files',storedName);
      await mkdir(path.dirname(filename),{ recursive:true,mode:0o700 });
      await writeFile(filename,content,{ flag:'wx',mode:0o600 }); written.push(filename);
      const referenceName = `${fileId}-${checked.sha256.slice(0,12)}.${checked.format === 'jpeg' ? 'jpg' : checked.format}`;
      const metadata = { width:checked.width,height:checked.height,author:image.author || '',license:image.license || { name:'未知' },visualReview:image.visualReview || { status:'unavailable' },verification:checked,originalStatus:image.originalStatus || 'source-file-unconfirmed',originalBytesPreserved:true,humanConfirmedAt:image.humanConfirmedAt || null,downloadedAt:image.downloadedAt || null,downloadedUrl:image.downloadedUrl || image.imageUrl,referenceName };
      await mkdir(referencesRoot,{ recursive:true,mode:0o700 });
      const referencePath = path.join(referencesRoot,referenceName), recordPath = referencePath+'.json';
      await writeFile(referencePath,content,{ flag:'wx',mode:0o600 }); written.push(referencePath);
      await writeFile(recordPath,JSON.stringify({ ...metadata,sourcePage:image.sourceUrl,imageUrl:image.imageUrl,category:image.category,projectId:id,draftId:draft.draftId },null,2)+'\n',{ flag:'wx',mode:0o600 }); written.push(recordPath);
      files.push({ id:fileId,cacheImageId:image.cacheImageId || image.id,name:image.name,category:image.category,slotId:image.slotId || null,visitId:null,type:image.type,size:content.length,storedName,sourceUrl:image.sourceUrl,imageUrl:image.imageUrl,...metadata,uploadedAt:new Date().toISOString() });
    }
    const saved = await mutate(items => {
      const previous = items.find(item => item.aiResearch?.draftId === draft.draftId);
      if (previous) {
        if (previous.deletedAt) throw new ArchiveError('该档案已在回收站，请先恢复', 409);
        return previous;
      }
      if (items.some(item => !item.deletedAt && key(item.name) === key(fields.name) && key(item.city || '') === key(fields.city))) throw new ArchiveError('该城市已有同名竞品档案，请检查名称；不会自动覆盖已有资料', 409);
      const now = new Date().toISOString();
      const item = { id, ...fields, floorplans, files, visits:[], aiResearch:{ ...draft.research, ...(draft.collection ? { imageSources:files.map(({ category,sourceUrl,imageUrl }) => ({ category,sourceUrl,imageUrl })),collectionWarnings:draft.collection.warnings } : {}), draftId:draft.draftId }, createdAt:now, updatedAt:now };
      items.push(item);
      return item;
    });
    if (saved.id !== id) await Promise.all(written.map(filename => unlink(filename)));
    return saved;
  } catch (error) {
    await Promise.all(written.map(filename => unlink(filename).catch(() => {})));
    throw error;
  }
}

export function updateCompetitor(id, input) {
  const fields = competitorFields(input);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new ArchiveError('请刷新页面后重新打开概况编辑，当前输入已保留', 428);
  return mutate(items => {
    const item = findCompetitor(items, id);
    const revision = item.overviewRevision || 0;
    if (revision !== input.expectedRevision) throw new ArchiveError('这份概况已被其他页面更新，当前输入已保留。请复制需保留的内容，重新打开后核对', 409);
    if (revision >= Number.MAX_SAFE_INTEGER) throw new ArchiveError('概况版本已超过限制', 409);
    item.overviewRevision = revision + 1;
    Object.assign(item, fields, { updatedAt: new Date().toISOString() });
    return item;
  });
}

export function updateCompetitorResearch(id, input, editor) {
  if (!input || typeof input.report !== 'string' || typeof input.expectedReport !== 'string') throw new ArchiveError('研究资料格式不正确');
  const report = text(input.report, '研究资料', 100000);
  if (input.expectedReport.length > 100000) throw new ArchiveError('研究资料版本过长');
  return mutate(items => {
    const item = findCompetitor(items, id);
    if ((item.aiResearch?.report || '') !== input.expectedReport) throw new ArchiveError('研究资料已更新，请关闭编辑窗口后重新打开', 409);
    const now = new Date().toISOString();
    item.aiResearch = { ...(item.aiResearch || { sources: [], provenance: 'user-authored', generatedAt: now }), report, editedAt: now, editedBy: text(editor, '编辑人', 80, true) };
    item.updatedAt = now;
    return item;
  });
}

export function updateCompetitorAmenities(id, input) {
  if (!input || typeof input.expectedAmenities !== 'string' || input.expectedAmenities.length > 128000) throw new ArchiveError('周边配套版本格式不正确');
  const amenities = amenityFields(input.amenities);
  return mutate(items => {
    const item = findCompetitor(items, id);
    if (JSON.stringify(item.amenities || null) !== input.expectedAmenities) throw new ArchiveError('周边配套已更新，请重新打开后编辑', 409);
    item.amenities = amenities;
    item.updatedAt = new Date().toISOString();
    return item;
  });
}

export function deleteCompetitor(id) {
  return mutate(items => {
    const item = findCompetitor(items, id);
    item.deletedAt = new Date().toISOString();
    item.updatedAt = item.deletedAt;
    return item;
  });
}

export function restoreCompetitor(id) {
  return mutate(items => {
    const item = findCompetitor(items, id, true);
    delete item.deletedAt;
    item.updatedAt = new Date().toISOString();
    return item;
  });
}

export function addVisit(id, input) {
  const fields = visitFields(input);
  return mutate(items => {
    const item = findCompetitor(items, id);
    const visit = { id: randomUUID(), ...fields, createdAt: new Date().toISOString() };
    item.visits.push(visit);
    item.updatedAt = new Date().toISOString();
    return visit;
  });
}

export function updateVisit(id, visitId, input) {
  const fields = visitFields(input);
  return mutate(items => {
    const item = findCompetitor(items, id);
    const visit = item.visits.find(entry => entry.id === visitId);
    if (!visit) throw new ArchiveError('找不到这次踩盘记录', 404);
    Object.assign(visit, fields, { updatedAt: new Date().toISOString() });
    item.updatedAt = new Date().toISOString();
    return visit;
  });
}

export function addFloorplan(id, input) {
  return mutate(items => {
    const item = findCompetitor(items, id);
    if (item.floorplans.length >= 24) throw new ArchiveError('一个楼盘最多可建 24 个户型');
    const floorplan = { id: randomUUID(), ...floorplanFields(input, `户型 ${String(item.floorplans.length + 1).padStart(2, '0')}`) };
    item.floorplans.push(floorplan);
    item.updatedAt = new Date().toISOString();
    return floorplan;
  });
}

export function updateFloorplan(id, floorplanId, input) {
  return mutate(items => {
    const item = findCompetitor(items, id);
    const floorplan = item.floorplans.find(entry => entry.id === floorplanId);
    if (!floorplan) throw new ArchiveError('找不到这个户型', 404);
    Object.assign(floorplan, floorplanFields(input, floorplan.label));
    item.updatedAt = new Date().toISOString();
    return floorplan;
  });
}

export function addFile(id, input) {
  const name = text(input.name, '文件名', 180, true);
  const category = text(input.category, '资料分类', 40, true);
  const allowedCategories = ['踩盘照片', '宣传资料', '价格资料', '总规划', '效果图', '户型图', '其他'];
  if (!allowedCategories.includes(category)) throw new ArchiveError('资料分类不正确');
  const slotId = text(input.slotId, '图像位置', 60);
  return mutate(items => {
    const item = findCompetitor(items, id);
    const replaced = input.replaceId ? item.files.find(file => file.id === input.replaceId && file.category === '效果图') : null;
    if (input.replaceId && (!replaced || category !== '效果图')) throw new ArchiveError('这张效果图已被修改或删除，请刷新后重试', 409);
    if (category === '效果图' && !replaced && item.files.filter(file => file.category === '效果图').length >= 6) throw new ArchiveError('一个楼盘最多保存 6 张效果图，请先删除或替换', 409);
    if (input.visitId && !item.visits.some(visit => visit.id === input.visitId)) throw new ArchiveError('找不到关联的踩盘记录', 404);
    if (category === '总规划' && slotId !== 'masterplan') throw new ArchiveError('总规划图像位置不正确');
    if (category === '户型图' && !item.floorplans.some(floorplan => floorplan.id === slotId)) throw new ArchiveError('请选择有效的户型位置');
    if (!['总规划', '户型图'].includes(category) && slotId) throw new ArchiveError('这类资料不需要图像位置');
    const file = {
      id: input.id,
      name,
      category,
      slotId: slotId || null,
      visitId: input.visitId || null,
      type: input.type,
      size: input.size,
      storedName: input.storedName,
      uploadedAt: new Date().toISOString()
    };
    if (input.verification) Object.assign(file, { verification: input.verification, width: input.verification.width, height: input.verification.height, sha256: input.verification.sha256, originalBytesPreserved: true });
    if (replaced) {
      const index = item.files.indexOf(replaced);
      (item.removedFiles ||= []).push({ ...replaced, removedAt: new Date().toISOString(), replacedBy: file.id });
      item.files.splice(index, 1, file);
    } else item.files.push(file);
    item.updatedAt = new Date().toISOString();
    return file;
  });
}

export function removeRendering(id, fileId) {
  return mutate(items => {
    const item = findCompetitor(items, id);
    const index = item.files.findIndex(file => file.id === fileId && file.category === '效果图');
    if (index < 0) throw new ArchiveError('这张效果图已被修改或删除，请刷新后重试', 409);
    const [file] = item.files.splice(index, 1);
    (item.removedFiles ||= []).push({ ...file, removedAt: new Date().toISOString() });
    item.updatedAt = new Date().toISOString();
    return file;
  });
}
