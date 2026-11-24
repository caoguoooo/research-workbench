import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ArchiveError } from './competitor-store.mjs';

export const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INDEX_LIMIT = 10 * 1024 * 1024;
const FORMATS = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function label(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ArchiveError(`请填写${field}（最多 120 字）`);
  }
  return value.trim();
}

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value) throw new ArchiveError('请选择有效的拍摄日期');
  return value;
}

const visiblePhotos = group => group.photos.filter(photo => !photo.removedAt);
function cover(group) {
  const photos = visiblePhotos(group);
  return photos.find(photo => photo.id === group.coverId) || photos[0] || null;
}

export async function createProjectLibrary(dataRoot) {
  const index = path.join(dataRoot, 'project-library.json');
  const root = path.join(dataRoot, 'project-files');
  let projects = [];
  let queue = Promise.resolve();

  try {
    const bytes = await readFile(index);
    if (bytes.length > INDEX_LIMIT) throw new Error('项目资料索引过大');
    const saved = JSON.parse(bytes);
    if (saved.version !== 1 || !Array.isArray(saved.projects)) throw new Error('项目资料索引格式不正确');
    projects = saved.projects;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  async function persist(next) {
    const content = JSON.stringify({ version: 1, projects: next });
    if (Buffer.byteLength(content) > INDEX_LIMIT) throw new ArchiveError('项目资料索引已满', 413);
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const temporary = `${index}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, index);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    projects = next;
  }

  function mutate(change) {
    const pending = queue.then(async () => change(structuredClone(projects)));
    queue = pending.catch(() => {});
    return pending;
  }

  function find(id, records = projects) {
    const project = records.find(project => project.id === id);
    if (!project) throw new ArchiveError('项目不存在', 404);
    return project;
  }

  function getPhoto(project, id) {
    for (const group of project.groups) {
      const photo = group.photos.find(photo => photo.id === id && !photo.removedAt);
      if (photo) return { group, photo };
    }
    throw new ArchiveError('照片不存在', 404);
  }

  const photoUrl = (projectId, photoId, view) => `/api/internal-projects/${projectId}/aerial/${photoId}?view=${view}`;
  function detail(project) {
    return {
      id: project.id,
      name: project.name,
      groups: project.groups.map(group => ({
        date: group.date,
        title: group.title,
        coverId: cover(group)?.id || null,
        photos: visiblePhotos(group).map(photo => ({
          id: photo.id, name: photo.name, kind: photo.kind,
          thumbnailUrl: photoUrl(project.id, photo.id, 'thumbnail'),
          previewUrl: photoUrl(project.id, photo.id, 'preview'),
          originalUrl: photoUrl(project.id, photo.id, 'original')
        }))
      })).filter(group => group.photos.length).sort((a, b) => b.date.localeCompare(a.date))
    };
  }

  return {
    list() {
      return projects.map(project => {
        const groups = [...project.groups].sort((a, b) => b.date.localeCompare(a.date));
        const latestCover = groups.map(cover).find(Boolean);
        return {
          id: project.id, name: project.name,
          photoCount: groups.reduce((count, group) => count + visiblePhotos(group).length, 0),
          thumbnailUrl: latestCover ? photoUrl(project.id, latestCover.id, 'thumbnail') : null
        };
      }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    },
    get(id) { return detail(find(id)); },
    save(input, id) {
      const name = label(input.name, '项目名称');
      return mutate(async next => {
        if (next.some(project => project.id !== id && project.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
          throw new ArchiveError('已有同名项目', 409);
        }
        const project = id ? find(id, next) : { id: randomUUID(), name, groups: [] };
        project.name = name;
        if (!id) next.push(project);
        await persist(next);
        return detail(project);
      });
    },
    async upload(projectId, bytes, { name, date, kind, uploadId }) {
      const existingProject = find(projectId);
      name = label(name, '照片名称');
      date = day(date);
      if (!['photo', 'panorama'].includes(kind)) throw new ArchiveError('请选择照片类型');
      if (!PROJECT_ID.test(uploadId)) throw new ArchiveError('照片上传编号无效');
      if (existingProject.groups.some(group => group.photos.some(photo => photo.uploadId === uploadId))) {
        return detail(existingProject);
      }
      let type, thumbnail, preview;
      try {
        const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 80_000_000, animated: true });
        const metadata = await image.metadata();
        type = FORMATS[metadata.format];
        if (!type || (metadata.pages || 1) > 1) throw new Error('Invalid image');
        const { width, height } = metadata.autoOrient;
        if (kind === 'panorama' && (type !== 'image/jpeg' || width !== height * 2)) {
          throw new ArchiveError('360° 全景需要宽高比为 2:1 的球形 JPG', 422);
        }
        thumbnail = await image.clone().rotate().resize(480, 320, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        if (kind === 'panorama') {
          preview = await image.clone().rotate().resize(4096, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
        }
      } catch (error) {
        if (error instanceof ArchiveError) throw error;
        throw new ArchiveError('无法读取图片，请选择完整的 JPG、PNG 或 WebP（最多 8000 万像素）', 422);
      }
      return mutate(async next => {
        const project = find(projectId, next);
        if (project.groups.some(group => group.photos.some(photo => photo.uploadId === uploadId))) return detail(project);
        let group = project.groups.find(group => group.date === date);
        if (!group) {
          group = { date, title: '', coverId: null, photos: [] };
          project.groups.push(group);
        }
        const photo = { id: randomUUID(), uploadId, name, kind, type };
        const directory = path.join(root, projectId, photo.id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try {
          await writeFile(path.join(directory, 'original'), bytes, { flag: 'wx', mode: 0o600 });
          await writeFile(path.join(directory, 'thumbnail.webp'), thumbnail, { flag: 'wx', mode: 0o600 });
          if (preview) await writeFile(path.join(directory, 'preview.jpg'), preview, { flag: 'wx', mode: 0o600 });
          group.photos.push(photo);
          await persist(next);
        } catch (error) {
          await rm(directory, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        return detail(project);
      });
    },
    updateGroup(id, date, input) {
      const title = label(input.title, '相册名称');
      return mutate(async next => {
        const project = find(id, next);
        const group = project.groups.find(group => group.date === date && visiblePhotos(group).length);
        if (!group) throw new ArchiveError('该拍摄日期暂无照片', 404);
        group.title = title;
        await persist(next);
        return detail(project);
      });
    },
    updatePhoto(id, photoId, input) {
      const { name, action } = input;
      if (action !== undefined && !['cover', 'earlier', 'later', 'remove'].includes(action)) throw new ArchiveError('照片操作无效');
      if (action === undefined && name === undefined) throw new ArchiveError('请选择照片操作');
      return mutate(async next => {
        const project = find(id, next);
        const { group, photo } = getPhoto(project, photoId);
        if (name !== undefined) photo.name = label(name, '照片名称');
        if (action === 'cover') group.coverId = photo.id;
        if (action === 'remove') photo.removedAt = new Date().toISOString();
        if (action === 'earlier' || action === 'later') {
          const photos = visiblePhotos(group);
          const neighbor = photos[photos.indexOf(photo) + (action === 'earlier' ? -1 : 1)];
          if (neighbor) {
            const from = group.photos.indexOf(photo), to = group.photos.indexOf(neighbor);
            [group.photos[from], group.photos[to]] = [group.photos[to], group.photos[from]];
          }
        }
        await persist(next);
        return detail(project);
      });
    },
    async fileInfo(id, photoId, view) {
      const { photo } = getPhoto(find(id), photoId);
      if (!PROJECT_ID.test(id) || !PROJECT_ID.test(photoId)) throw new ArchiveError('照片不存在', 404);
      const thumbnail = view === 'thumbnail', panorama = view === 'preview' && photo.kind === 'panorama';
      const stored = thumbnail ? 'thumbnail.webp' : panorama ? 'preview.jpg' : 'original';
      try {
        const base = await realpath(root);
        const filename = await realpath(path.join(base, id, photoId, stored));
        if (!filename.startsWith(base + path.sep)) throw new ArchiveError('照片不存在', 404);
        return { filename, name: photo.name, type: thumbnail ? 'image/webp' : panorama ? 'image/jpeg' : photo.type };
      } catch (error) {
        if (error.code === 'ENOENT') throw new ArchiveError('照片原件不存在', 404);
        throw error;
      }
    }
  };
}
