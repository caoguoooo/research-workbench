import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ArchiveError } from './competitor-store.mjs';

export const POLICY_STATUSES = ['待核实', '现行', '已废止'];
export const POLICY_TYPES = ['政策文件', '规划管理', '建筑设计', '消防', '停车配建', '其他'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clone = value => structuredClone(value);
function text(value, max, label, multiline = false) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) throw new ArchiveError(`${label}格式不正确`);
  return value.trim();
}
function name(value) { const result = text(value, 40, '目录名称'); if (!result) throw new ArchiveError('请填写目录名称'); return result; }
function date(value) {
  const result = text(value ?? '', 10, '日期');
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result)) throw new ArchiveError('日期格式不正确');
  return result;
}
function fields(input, cities) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('文件信息格式不正确');
  const title = text(input.title ?? '', 200, '文件名称'); if (!title) throw new ArchiveError('请填写文件名称');
  if (!Array.isArray(input.placements) || !input.placements.length || input.placements.length > 30) throw new ArchiveError('请选择城市和规范种类');
  const placements = input.placements.map(entry => {
    if (!entry || !cities.find(city => city.id === entry.cityId)?.types.some(type => type.id === entry.typeId)) throw new ArchiveError('目录已变更，请重新选择城市和规范种类', 409);
    return { cityId: entry.cityId, typeId: entry.typeId };
  });
  const sourceUrl = text(input.sourceUrl ?? '', 2000, '来源网址');
  if (sourceUrl) { let url; try { url = new URL(sourceUrl); } catch { throw new ArchiveError('来源网址格式不正确'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ArchiveError('来源网址只支持 HTTP 或 HTTPS'); }
  if (!POLICY_STATUSES.includes(input.status ?? '待核实')) throw new ArchiveError('文件状态不正确');
  const keywords = typeof input.keywords === 'string' ? input.keywords.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean) : input.keywords ?? [];
  if (!Array.isArray(keywords) || keywords.length > 15) throw new ArchiveError('最多填写 15 个关键词');
  const replacesId = input.replacesId || '';
  if (replacesId && !uuid.test(replacesId)) throw new ArchiveError('旧版本编号不正确');
  return { title, placements: placements.filter((entry, index) => placements.findIndex(other => entry.cityId === other.cityId && entry.typeId === other.typeId) === index), number: text(input.number ?? '', 120, '文号'), issuer: text(input.issuer ?? '', 160, '发布单位'), publishedAt: date(input.publishedAt), effectiveAt: date(input.effectiveAt), status: input.status ?? '待核实', sourceUrl, keywords: [...new Set(keywords.map(tag => text(tag, 30, '关键词')))].filter(Boolean), note: text(input.note ?? '', 5000, '备注', true), replacesId };
}

export async function createPolicyStore(dataRoot) {
  const filename = path.join(dataRoot, 'policy-library.json'), filesRoot = path.join(dataRoot, 'policy-files');
  let cities = ['全国通用', '重庆', '成都', '西安'].map(city => ({ id: randomUUID(), name: city, types: POLICY_TYPES.map(type => ({ id: randomUUID(), name: type })) })), items = [], queue = Promise.resolve();
  function checkVersion(item, records = items) {
    const seen = new Set([item.id]); let id = item.replacesId;
    while (id) {
      if (seen.has(id)) throw new ArchiveError('版本关联不能形成循环');
      seen.add(id); const older = records.find(record => record.id === id);
      if (!older) throw new ArchiveError('关联的旧版本不存在');
      id = older.replacesId;
    }
  }
  try {
    const raw = await readFile(filename); if (raw.length > 30 * 1024 * 1024) throw new Error('政策规范索引过大');
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.cities) || !Array.isArray(saved.items) || saved.cities.length > 100) throw new Error('政策规范索引格式不正确');
    const ids = new Set(), cityNames = new Set();
    for (const city of saved.cities) {
      if (!uuid.test(city.id) || ids.has(city.id) || name(city.name) !== city.name || cityNames.has(city.name.toLocaleLowerCase()) || !Array.isArray(city.types) || city.types.length > 100) throw new Error('城市目录格式不正确');
      ids.add(city.id); cityNames.add(city.name.toLocaleLowerCase()); const typeNames = new Set();
      for (const type of city.types) { if (!uuid.test(type.id) || ids.has(type.id) || name(type.name) !== type.name || typeNames.has(type.name.toLocaleLowerCase())) throw new Error('规范种类格式不正确'); ids.add(type.id); typeNames.add(type.name.toLocaleLowerCase()); }
    }
    for (const item of saved.items) {
      if (!uuid.test(item.id) || ids.has(item.id) || !Array.isArray(item.files)) throw new Error('规范记录格式不正确');
      ids.add(item.id); fields(item, saved.cities); checkVersion(item, saved.items);
      for (const file of item.files) {
        if (!uuid.test(file.id) || ids.has(file.id) || !new RegExp(`^${file.id}\\.(pdf|jpg|png|webp|doc|docx|xls|xlsx)$`).test(file.storedName) || typeof file.name !== 'string') throw new Error('规范附件格式不正确');
        ids.add(file.id);
      }
    }
    cities = saved.cities; items = saved.items;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const mutate = action => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  async function persist(nextItems = items, nextCities = cities) {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ version: 1, cities: nextCities, items: nextItems }), { mode: 0o600, flag: 'wx' }); await rename(temporary, filename); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    items = nextItems; cities = nextCities;
  }
  const find = (id, deleted = false) => { const item = items.find(item => item.id === id && (deleted || !item.deletedAt)); if (!item) throw new ArchiveError('文件不存在', 404); return item; };
  const publicItem = item => clone({ ...item, files: item.files.filter(file => !file.deletedAt).map(({ storedName, ...file }) => ({ ...file, url: `/api/policies/${item.id}/files/${file.id}` })) });
  function unique(entries, value, id) { if (entries.some(entry => entry.id !== id && entry.name.toLocaleLowerCase() === value.toLocaleLowerCase())) throw new ArchiveError('目录名称已存在', 409); }
  return {
    directory() { return clone(cities); },
    list({ deletedOnly = false } = {}) { return items.filter(item => !!item.deletedAt === deletedOnly).map(publicItem).reverse(); },
    get(id) { return publicItem(find(id)); },
    directoryChange(input) {
      return mutate(async () => {
        const next = clone(cities), city = next.find(entry => entry.id === input.cityId);
        if (input.action === 'addCity') {
          const value = name(input.name); unique(next, value); if (next.length >= 100) throw new ArchiveError('最多支持 100 个城市');
          next.push({ id: randomUUID(), name: value, types: POLICY_TYPES.map(value => ({ id: randomUUID(), name: value })) });
        } else {
          if (!city) throw new ArchiveError('城市不存在', 404);
          if (input.action === 'renameCity') { const value = name(input.name); unique(next, value, city.id); city.name = value; }
          else if (input.action === 'deleteCity') {
            if (items.some(item => item.placements.some(entry => entry.cityId === city.id))) throw new ArchiveError('该城市仍有关联文件（含回收站），请先调整文件归属', 409);
            next.splice(next.indexOf(city), 1);
          } else if (input.action === 'addType') {
            const value = name(input.name); unique(city.types, value); if (city.types.length >= 100) throw new ArchiveError('每个城市最多支持 100 个种类'); city.types.push({ id: randomUUID(), name: value });
          } else {
            const type = city.types.find(entry => entry.id === input.typeId); if (!type) throw new ArchiveError('规范种类不存在', 404);
            if (input.action === 'renameType') { const value = name(input.name); unique(city.types, value, type.id); type.name = value; }
            else if (input.action === 'deleteType') {
              if (items.some(item => item.placements.some(entry => entry.typeId === type.id))) throw new ArchiveError('该种类仍有关联文件（含回收站），请先调整文件归属', 409);
              city.types.splice(city.types.indexOf(type), 1);
            } else throw new ArchiveError('目录操作不正确');
          }
        }
        await persist(items, next); return clone(cities);
      });
    },
    save(input, id = '') {
      return mutate(async () => {
        const previous = id ? find(id) : null, metadata = fields(input, cities);
        const item = { ...(previous || { id: randomUUID(), files: [], createdAt: new Date().toISOString(), deletedAt: null }), ...metadata, updatedAt: new Date().toISOString() };
        checkVersion(item); await persist(previous ? items.map(entry => entry.id === id ? item : entry) : [...items, item]); return publicItem(item);
      });
    },
    remove(id) { return mutate(async () => { find(id); await persist(items.map(item => item.id === id ? { ...item, deletedAt: new Date().toISOString() } : item)); }); },
    restore(id) { return mutate(async () => { const item = { ...find(id, true), deletedAt: null }; await persist(items.map(entry => entry.id === id ? item : entry)); return publicItem(item); }); },
    async upload(id, bytes, suppliedName) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 25 * 1024 * 1024) throw new ArchiveError('文件大小应在 25 MB 以内', 413);
      const originalName = text(suppliedName, 180, '附件名称'); if (!originalName || /[\\/]/.test(originalName)) throw new ArchiveError('附件名称不正确');
      let ext = path.extname(originalName).slice(1).toLowerCase(); if (ext === 'jpeg') ext = 'jpg';
      const types = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
      if (!types[ext]) throw new ArchiveError('支持 PDF、Word、Excel 和 JPG / PNG / WebP 图片');
      if (['jpg', 'png', 'webp'].includes(ext)) {
        try { const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 }); const info = await image.metadata(); if (info.format !== (ext === 'jpg' ? 'jpeg' : ext)) throw new Error(); await image.stats(); } catch { throw new ArchiveError('图片无法完整解码或类型不匹配'); }
      } else if (ext === 'pdf') { if (!bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-') || !bytes.subarray(-2048).includes(Buffer.from('%%EOF'))) throw new ArchiveError('PDF 文件不完整或类型不匹配'); }
      else if (['docx', 'xlsx'].includes(ext) ? !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) : !bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) throw new ArchiveError('Office 文件类型不匹配');
      return mutate(async () => {
        const item = find(id); if (item.files.filter(file => !file.deletedAt).length >= 30) throw new ArchiveError('每份文件最多上传 30 个附件');
        const fileId = randomUUID(), storedName = `${fileId}.${ext}`, file = { id: fileId, storedName, name: originalName, type: types[ext], size: bytes.length, createdAt: new Date().toISOString() };
        await mkdir(filesRoot, { recursive: true, mode: 0o700 }); const destination = path.join(filesRoot, storedName);
        await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
        const next = { ...item, files: [...item.files, file], updatedAt: file.createdAt };
        try { await persist(items.map(entry => entry.id === id ? next : entry)); } catch (error) { await unlink(destination).catch(() => {}); throw error; }
        return publicItem(next);
      });
    },
    removeFile(id, fileId) { return mutate(async () => { const item = find(id); if (!item.files.some(file => file.id === fileId && !file.deletedAt)) throw new ArchiveError('附件不存在', 404); const next = { ...item, files: item.files.map(file => file.id === fileId ? { ...file, deletedAt: new Date().toISOString() } : file), updatedAt: new Date().toISOString() }; await persist(items.map(entry => entry.id === id ? next : entry)); return publicItem(next); }); },
    async file(id, fileId) {
      const file = await this.fileInfo(id, fileId);
      return { bytes: await readFile(file.filename), type: file.type, name: file.name };
    },
    async fileInfo(id, fileId) {
      const file = find(id).files.find(file => file.id === fileId && !file.deletedAt); if (!file) throw new ArchiveError('附件不存在', 404);
      const base = await realpath(filesRoot), destination = await realpath(path.join(filesRoot, file.storedName)).catch(() => { throw new ArchiveError('附件原件不存在', 404); });
      if (!destination.startsWith(base + path.sep)) throw new ArchiveError('附件路径不正确', 403);
      return { filename: destination, type: file.type, name: file.name };
    }
  };
}
