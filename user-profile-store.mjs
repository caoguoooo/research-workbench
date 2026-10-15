import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ArchiveError } from './competitor-store.mjs';

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export async function createUserProfileStore(dataRoot) {
  const filename = path.join(dataRoot, 'user-profiles.json'), avatars = path.join(dataRoot, 'user-avatars');
  let profiles = [], queue = Promise.resolve();
  try {
    const raw = await readFile(filename);
    if (raw.length > 2 * 1024 * 1024) throw new Error('用户资料文件过大');
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.profiles)) throw new Error('用户资料格式不正确');
    const seen = new Set();
    for (const profile of saved.profiles) {
      if (!profile || typeof profile.username !== 'string' || seen.has(profile.username) || typeof profile.nickname !== 'string' || profile.nickname.length > 40 || profile.avatar && !/^[0-9a-f-]{36}$/.test(profile.avatar)) throw new Error('用户资料格式不正确');
      seen.add(profile.username);
    }
    profiles = saved.profiles;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const get = username => {
    const profile = profiles.find(item => item.username === username);
    return { nickname: profile?.nickname || '', avatarUrl: profile?.avatar ? `/api/users/${encodeURIComponent(username)}/avatar?v=${profile.avatar}` : '' };
  };
  async function persist(next) {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ version: 1, profiles: next }), { flag: 'wx', mode: 0o600 }); await rename(temporary, filename); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    profiles = next;
  }
  function mutate(action) {
    const pending = queue.then(action); queue = pending.catch(() => {}); return pending;
  }
  async function replaceAvatar(username, content) {
    const next = structuredClone(profiles), old = next.find(item => item.username === username);
    const entry = old || { username, nickname: '' };
    if (!old) next.push(entry);
    const previous = entry.avatar, avatar = content ? randomUUID() : null;
    if (avatar) {
      await mkdir(avatars, { recursive: true, mode: 0o700 });
      await writeFile(path.join(avatars, `${avatar}.webp`), content, { flag: 'wx', mode: 0o600 });
      entry.avatar = avatar;
    } else delete entry.avatar;
    try { await persist(next); }
    catch (error) { if (avatar) await unlink(path.join(avatars, `${avatar}.webp`)).catch(() => {}); throw error; }
    if (previous) await unlink(path.join(avatars, `${previous}.webp`)).catch(() => {});
    return get(username);
  }
  return {
    get,
    update(username, input) {
      if (!input || Object.keys(input).length !== 1 || typeof input.nickname !== 'string' || input.nickname.length > 40 || /[\u0000-\u001f\u007f]/.test(input.nickname)) throw new ArchiveError('昵称最多 40 个字符，不能包含换行或控制字符');
      return mutate(async () => {
        const next = structuredClone(profiles), entry = next.find(item => item.username === username);
        if (entry) entry.nickname = input.nickname.trim();
        else next.push({ username, nickname: input.nickname.trim() });
        await persist(next); return get(username);
      });
    },
    async upload(username, bytes) {
      if (!bytes?.length || bytes.length > MAX_AVATAR_BYTES) throw new ArchiveError('头像文件不能超过 5 MB', 413);
      let content;
      try {
        const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
        const metadata = await image.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('unsupported');
        content = await image.rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
      } catch { throw new ArchiveError('请选择完整的 JPG、PNG 或 WebP 图片'); }
      return mutate(() => replaceAvatar(username, content));
    },
    clearAvatar(username) { return mutate(() => replaceAvatar(username, null)); },
    async image(username) {
      const entry = profiles.find(item => item.username === username);
      if (!entry?.avatar) return null;
      try { return await readFile(path.join(avatars, `${entry.avatar}.webp`)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    remove(username) {
      return mutate(async () => {
        const previous = profiles.find(item => item.username === username)?.avatar;
        await persist(profiles.filter(item => item.username !== username));
        if (previous) await unlink(path.join(avatars, `${previous}.webp`)).catch(() => {});
      });
    }
  };
}
