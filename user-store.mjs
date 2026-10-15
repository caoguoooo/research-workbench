import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { accountRecord } from './auth-store.mjs';
import { ArchiveError } from './competitor-store.mjs';

const key = username => String(username || '').normalize('NFKC').toLocaleLowerCase();
const roles = new Set(['admin', 'viewer']);
const states = new Set(['pending', 'active', 'disabled', 'deleted']);
export const publicUser = (record, primary = false) => ({ username: record.username, role: primary ? 'admin' : record.role, status: primary ? 'active' : record.status, createdAt: record.createdAt || null, primary });

export async function createUserStore(dataRoot, getPrimary) {
  const filename = path.join(dataRoot, 'users.json');
  let users = [];
  let queue = Promise.resolve();
  try {
    const bytes = await readFile(filename);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('用户文件过大');
    const saved = JSON.parse(bytes);
    if (saved.version !== 1 || !Array.isArray(saved.users) || saved.users.length > 1000) throw new Error('用户文件格式不正确');
    const seen = new Set();
    for (const user of saved.users) {
      if (!user || !/^[\p{L}\p{N}_.-]{3,32}$/u.test(user.username) || !roles.has(user.role) || !states.has(user.status) || !/^[0-9a-f]{48}$/.test(user.salt) || !/^[0-9a-f]{128}$/.test(user.hash) || !Number.isSafeInteger(user.revision) || user.revision < 1 || seen.has(key(user.username))) throw new Error('用户文件格式不正确');
      seen.add(key(user.username));
    }
    users = saved.users;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const find = username => {
    const primary = getPrimary();
    if (primary && key(primary.username) === key(username)) return primary;
    return users.find(user => user.status !== 'deleted' && key(user.username) === key(username)) || null;
  };
  function mutate(change) {
    const pending = queue.then(async () => {
      const next = structuredClone(users);
      const result = change(next);
      await mkdir(dataRoot, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, users: next }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, filename);
      } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      users = next;
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }
  return {
    find,
    isPrimary: username => !!getPrimary() && key(getPrimary().username) === key(username),
    list() {
      return [...(getPrimary() ? [publicUser(getPrimary(), true)] : []), ...users.filter(user => user.status !== 'deleted' && (!getPrimary() || key(user.username) !== key(getPrimary().username))).map(user => publicUser(user))];
    },
    register(username, password) {
      let credentials;
      try { credentials = accountRecord(String(username || '').trim(), password); }
      catch (error) { throw new ArchiveError(error.message); }
      return mutate(next => {
        if (find(credentials.username) || users.some(user => key(user.username) === key(credentials.username))) throw new ArchiveError('该账号已注册，请更换账号或联系管理员', 409);
        if (next.length >= 1000) throw new ArchiveError('用户数量已达上限，请联系管理员', 409);
        const record = { ...credentials, role: 'viewer', status: 'pending', createdAt: new Date().toISOString(), revision: 1 };
        next.push(record);
        return publicUser(record);
      });
    },
    update(username, input, actor) {
      return mutate(next => {
        const currentActor = find(actor);
        if (!currentActor || currentActor.status && currentActor.status !== 'active' || !this.isPrimary(actor) && currentActor.role !== 'admin') throw new ArchiveError('需要管理员权限', 403);
        if (this.isPrimary(username)) throw new ArchiveError('初始管理员仅可通过修改密码管理凭据', 403);
        const record = next.find(user => key(user.username) === key(username));
        if (!record || record.status === 'deleted') throw new ArchiveError('用户不存在', 404);
        if (!Object.keys(input).length || Object.keys(input).some(name => !['role', 'status', 'password'].includes(name))) throw new ArchiveError('用户设置格式不正确');
        if (input.role !== undefined && !roles.has(input.role) || input.status !== undefined && (!states.has(input.status) || input.status === 'deleted')) throw new ArchiveError('角色或状态不正确');
        if (key(username) === key(actor)) throw new ArchiveError('请由其他管理员调整你的角色或状态；修改自己的密码请使用修改密码入口', 403);
        if (input.password !== undefined) {
          let credentials;
          try { credentials = accountRecord(record.username, input.password); }
          catch (error) { throw new ArchiveError(error.message); }
          Object.assign(record, credentials);
        }
        if (input.role !== undefined) record.role = input.role;
        if (input.status !== undefined) record.status = input.status;
        if (record.status === 'pending') record.role = 'viewer';
        record.revision++;
        return publicUser(record);
      });
    },
    remove(username, actor) {
      return mutate(next => {
        const currentActor = find(actor);
        if (!currentActor || currentActor.status && currentActor.status !== 'active' || !this.isPrimary(actor) && currentActor.role !== 'admin') throw new ArchiveError('需要管理员权限', 403);
        if (this.isPrimary(username)) throw new ArchiveError('不能删除初始管理员', 403);
        if (key(username) === key(actor)) throw new ArchiveError('不能删除当前登录账号', 403);
        const record = next.find(user => key(user.username) === key(username));
        if (!record || record.status === 'deleted') throw new ArchiveError('用户不存在', 404);
        // Reserve the username so a new account cannot inherit historical records.
        record.status = 'deleted'; record.revision++; record.deletedAt = new Date().toISOString();
        return record.username;
      });
    },
    changePassword(username, credentials) {
      return mutate(next => {
        const record = next.find(user => key(user.username) === key(username));
        if (!record || record.status !== 'active') throw new ArchiveError('登录已失效，请重新登录', 401);
        Object.assign(record, credentials);
        record.revision++;
      });
    }
  };
}
