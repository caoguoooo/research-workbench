import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export class ArchiveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const dataRoot = path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'));
const filePath = path.join(dataRoot, 'competitors.json');
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
    summary: text(input.summary, '项目概况', 3000)
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

async function readArchive() {
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
    const result = change(archive.competitors);
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

export async function listCompetitors({ deletedOnly = false } = {}) {
  const archive = await readArchive();
  return archive.competitors.filter(item => deletedOnly ? !!item.deletedAt : !item.deletedAt)
    .sort((a, b) => (deletedOnly ? b.deletedAt.localeCompare(a.deletedAt) : b.updatedAt.localeCompare(a.updatedAt)));
}

export async function getCompetitor(id) {
  return findCompetitor((await readArchive()).competitors, id);
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

export function updateCompetitor(id, input) {
  const fields = competitorFields(input);
  return mutate(items => {
    const item = findCompetitor(items, id);
    Object.assign(item, fields, { updatedAt: new Date().toISOString() });
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
    item.files.push(file);
    item.updatedAt = new Date().toISOString();
    return file;
  });
}
