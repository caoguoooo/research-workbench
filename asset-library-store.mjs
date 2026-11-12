import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ArchiveError } from './competitor-store.mjs';

export const ASSET_CATEGORIES = ['规划彩总', '立面效果', '大门', '示范区景观'];
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_INDEX_BYTES = 20 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function text(value, max, label, multiline = false) {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || value.length > max || controls.test(value)) throw new ArchiveError(`${label}格式不正确`);
  return value.trim();
}
export function normalizeBoardUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ArchiveError('请粘贴完整的 Pinterest 画板网址'); }
  const hosts = ['pinterest.com', 'www.pinterest.com', 'cn.pinterest.com', 'pinterest.co.uk', 'www.pinterest.co.uk', 'www.pinterest.fr', 'www.pinterest.de', 'www.pinterest.jp'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password) throw new ArchiveError('请使用 https://www.pinterest.com/用户名/画板名/ 格式的网址');
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw new ArchiveError('画板网址格式不正确'); }
  if (parts.length !== 2 || ['pin', 'ideas', 'search', 'business', 'settings', 'today'].includes(parts[0].toLowerCase()) || parts.some(part => part.length > 160 || !/^[\p{L}\p{N}_-]+$/u.test(part))) throw new ArchiveError('请使用画板网址，而不是单张 Pin 或短链接');
  return `https://www.pinterest.com/${parts.map(encodeURIComponent).join('/')}/`;
}
function categoryName(value) {
  const name = text(value, 30, '分类名称');
  if (!name) throw new ArchiveError('请填写分类名称');
  return name;
}
function fields(input, categories) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('素材格式不正确');
  const title = text(input.title ?? '', 120, '名称');
  if (!title) throw new ArchiveError('请填写素材名称');
  if (!categories.includes(input.category)) throw new ArchiveError('分类不存在，请重新选择素材分类');
  const tags = typeof input.tags === 'string' ? input.tags.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean) : input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 12) throw new ArchiveError('最多添加 12 个标签');
  const sourceUrl = text(input.sourceUrl ?? '', 2000, '来源网址');
  if (sourceUrl) {
    let url; try { url = new URL(sourceUrl); } catch { throw new ArchiveError('来源网址格式不正确'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ArchiveError('来源网址只支持 HTTP 或 HTTPS');
  }
  return { title, category: input.category, project: text(input.project ?? '', 120, '项目名称'), tags: [...new Set(tags.map(tag => text(tag, 30, '标签')))].filter(Boolean), note: text(input.note ?? '', 1200, '笔记', true), sourceUrl };
}

export async function createAssetLibraryStore(dataRoot) {
  const filename = path.join(dataRoot, 'asset-library.json'), filesRoot = path.join(dataRoot, 'asset-files');
  let items = [], categories = [...ASSET_CATEGORIES], queue = Promise.resolve();
  try {
    const raw = await readFile(filename);
    if (raw.length > MAX_ASSET_INDEX_BYTES) throw new Error('素材索引过大');
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.items)) throw new Error('素材索引格式不正确');
    // Old indexes have no category list; retain their four initial categories and every referenced name.
    categories = saved.categories === undefined ? [...new Set([...ASSET_CATEGORIES, ...saved.items.map(item => item.category)])] : saved.categories;
    if (!Array.isArray(categories) || categories.length > 100 || categories.some(name => categoryName(name) !== name) || new Set(categories.map(name => name.toLocaleLowerCase())).size !== categories.length) throw new Error('素材分类格式不正确');
    const seen = new Set();
    for (const item of saved.items) {
      if (!uuid.test(item.id) || seen.has(item.id) || !['image', 'board'].includes(item.kind)) throw new Error('素材记录格式不正确');
      fields(item, categories);
      if (item.kind === 'board') normalizeBoardUrl(item.boardUrl);
      else if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(item.storedName) || !/^[0-9a-f-]{36}\.webp$/.test(item.thumbnail)) throw new Error('素材文件格式不正确');
      seen.add(item.id);
    }
    items = saved.items;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  function mutate(action) { const result = queue.then(action); queue = result.catch(() => {}); return result; }
  async function persist(next, nextCategories = categories) {
    const content = JSON.stringify({ version: 1, categories: nextCategories, items: next });
    if (Buffer.byteLength(content) > MAX_ASSET_INDEX_BYTES) throw new ArchiveError('素材索引容量已满，本次修改未保存，请先导出并整理资料', 413);
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await rename(temporary, filename); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    items = next;
    categories = [...nextCategories];
  }
  function checkCategory(name) { if (!categories.includes(name)) throw new ArchiveError('分类已变更，请重新选择素材分类', 409); }
  function uniqueCategory(name, previous = null) {
    if (categories.some(entry => entry !== previous && entry.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new ArchiveError('分类名称已存在', 409);
  }
  function find(id, deleted = false) {
    const item = items.find(item => item.id === id && (deleted || !item.deletedAt));
    if (!item) throw new ArchiveError('素材不存在', 404);
    return item;
  }
  const publicItem = item => {
    const { storedName, thumbnail, ...entry } = item;
    return { ...entry, ...(item.kind === 'image' ? { imageUrl: `/api/assets/${item.id}/image`, thumbnailUrl: `/api/assets/${item.id}/thumbnail` } : {}) };
  };
  return {
    categories() { return [...categories]; },
    addCategory(value) {
      const name = categoryName(value);
      return mutate(async () => {
        uniqueCategory(name);
        if (categories.length >= 100) throw new ArchiveError('最多支持 100 个素材分类');
        await persist(items, [...categories, name]); return [...categories];
      });
    },
    renameCategory(value, nextValue) {
      const name = categoryName(value), nextName = categoryName(nextValue);
      return mutate(async () => {
        checkCategory(name); uniqueCategory(nextName, name);
        await persist(items.map(item => item.category === name ? { ...item, category: nextName } : item), categories.map(entry => entry === name ? nextName : entry));
        return [...categories];
      });
    },
    removeCategory(value, targetValue = '') {
      const name = categoryName(value), target = targetValue ? categoryName(targetValue) : '';
      return mutate(async () => {
        checkCategory(name);
        if (target) { checkCategory(target); if (target === name) throw new ArchiveError('请选择另一个分类接收素材'); }
        if (items.some(item => item.category === name) && !target) throw new ArchiveError('此分类仍有素材（含回收站），请选择转移分类后再删除', 409);
        await persist(items.map(item => item.category === name ? { ...item, category: target } : item), categories.filter(entry => entry !== name));
        return [...categories];
      });
    },
    list({ deletedOnly = false } = {}) { return items.filter(item => !!item.deletedAt === deletedOnly).map(publicItem).reverse(); },
    get(id) { return publicItem(find(id)); },
    addBoard(input) {
      const metadata = fields(input, categories), boardUrl = normalizeBoardUrl(input.boardUrl);
      return mutate(async () => {
        checkCategory(metadata.category);
        if (items.some(item => item.boardUrl === boardUrl && !item.deletedAt)) throw new ArchiveError('此画板已关联，可编辑现有记录的分类', 409);
        const now = new Date().toISOString(), item = { ...metadata, id: randomUUID(), kind: 'board', boardUrl, createdAt: now, updatedAt: now, deletedAt: null };
        await persist([...items, item]); return publicItem(item);
      });
    },
    async upload(input, bytes, originalName) {
      const metadata = fields(input, categories);
      if (!bytes?.length || bytes.length > MAX_ASSET_BYTES) throw new ArchiveError('单张图片不能超过 25 MB', 413);
      let info, thumbnail;
      try {
        info = await sharp(bytes, { limitInputPixels: 60_000_000, failOn: 'warning' }).metadata();
        if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages || 1) > 1) throw new Error('format');
        // Decode the complete image before accepting an original; retain original bytes for download.
        thumbnail = await sharp(bytes, { limitInputPixels: 60_000_000, failOn: 'warning' }).rotate().resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
      } catch { throw new ArchiveError('请选择完整的 JPG、PNG 或 WebP 静态图片'); }
      const id = randomUUID(), extension = { jpeg: 'jpg', png: 'png', webp: 'webp' }[info.format];
      const storedName = `${id}.${extension}`, thumbName = `${id}.webp`, now = new Date().toISOString();
      const rotated = [5, 6, 7, 8].includes(info.orientation);
      const item = { ...metadata, id, kind: 'image', originalName: text(originalName || metadata.title, 255, '文件名'), storedName, thumbnail: thumbName, type: `image/${info.format}`, size: bytes.length, width: rotated ? info.height : info.width, height: rotated ? info.width : info.height, createdAt: now, updatedAt: now, deletedAt: null };
      return mutate(async () => {
        checkCategory(metadata.category);
        await mkdir(path.join(filesRoot, 'originals'), { recursive: true, mode: 0o700 });
        await mkdir(path.join(filesRoot, 'thumbnails'), { recursive: true, mode: 0o700 });
        const original = path.join(filesRoot, 'originals', storedName), thumb = path.join(filesRoot, 'thumbnails', thumbName);
        try {
          await writeFile(original, bytes, { flag: 'wx', mode: 0o600 }); await writeFile(thumb, thumbnail, { flag: 'wx', mode: 0o600 });
          await persist([...items, item]);
        } catch (error) { await unlink(original).catch(() => {}); await unlink(thumb).catch(() => {}); throw error; }
        return publicItem(item);
      });
    },
    update(id, input) {
      const metadata = fields(input, categories);
      return mutate(async () => {
        checkCategory(metadata.category);
        const previous = find(id), boardUrl = previous.kind === 'board' ? normalizeBoardUrl(input.boardUrl ?? previous.boardUrl) : null;
        if (boardUrl && items.some(item => item.id !== id && item.boardUrl === boardUrl && !item.deletedAt)) throw new ArchiveError('此画板已关联', 409);
        const item = { ...previous, ...metadata, ...(boardUrl ? { boardUrl } : {}), updatedAt: new Date().toISOString() };
        await persist(items.map(entry => entry.id === id ? item : entry)); return publicItem(item);
      });
    },
    remove(id) { return mutate(async () => { find(id); await persist(items.map(item => item.id === id ? { ...item, deletedAt: new Date().toISOString() } : item)); }); },
    restore(id) { return mutate(async () => {
      const item = find(id, true);
      if (item.kind === 'board' && items.some(entry => entry.id !== id && !entry.deletedAt && entry.boardUrl === item.boardUrl)) throw new ArchiveError('相同画板已存在，请先处理重复画板', 409);
      const restored = { ...item, deletedAt: null };
      await persist(items.map(entry => entry.id === id ? restored : entry)); return publicItem(restored);
    }); },
    async image(id, thumbnail = false) {
      const file = await this.imageFile(id, thumbnail);
      return { bytes: await readFile(file.filename), type: file.type, name: file.name };
    },
    async imageFile(id, thumbnail = false) {
      const item = find(id);
      if (item.kind !== 'image') throw new ArchiveError('此素材没有本地图片', 404);
      const base = await realpath(filesRoot), resolved = await realpath(path.join(base, thumbnail ? 'thumbnails' : 'originals', thumbnail ? item.thumbnail : item.storedName)).catch(error => { if (error.code === 'ENOENT') throw new ArchiveError('图片文件不存在', 404); throw error; });
      if (!resolved.startsWith(base + path.sep)) throw new ArchiveError('图片路径不正确', 404);
      return { filename: resolved, type: thumbnail ? 'image/webp' : item.type, name: item.originalName };
    }
  };
}
