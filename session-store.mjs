import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const SESSION_AGE = 12 * 60 * 60 * 1000;
export const REMEMBER_AGE = 7 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');

export async function createSessionStore(dataRoot, getAccount, { now = Date.now, realm = 'production', maxSessions = 100 } = {}) {
  const filename = path.join(dataRoot, 'remembered-sessions.json');
  const fingerprint = () => digest(JSON.stringify([realm, getAccount()?.username, getAccount()?.salt, getAccount()?.hash]));
  let records = new Map();
  let queue = Promise.resolve();
  function valid(record) {
    const account = getAccount();
    return account && record.username === account.username && record.fingerprint === fingerprint() && Number.isSafeInteger(record.createdAt) && Number.isSafeInteger(record.expires) && record.expires > now() && record.expires <= record.createdAt + (record.remembered ? REMEMBER_AGE : SESSION_AGE);
  }
  try {
    const raw = await readFile(filename);
    if (raw.length > 1024 * 1024) throw new Error('登录记录文件过大');
    const saved = JSON.parse(raw.toString('utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error('登录记录格式不正确');
    for (const record of saved.sessions.slice(-maxSessions)) {
      if (/^[0-9a-f]{64}$/.test(record?.id || '') && record.remembered === true && valid(record)) records.set(record.id, record);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  async function persist(next) {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, sessions: [...next.values()].filter(record => record.remembered) }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  function mutate(change) {
    const result = queue.then(async () => {
      const next = new Map(records);
      for (const [id, record] of next) if (!valid(record)) next.delete(id);
      const value = change(next);
      const previous = [...records.values()].filter(record => record.remembered);
      const current = [...next.values()].filter(record => record.remembered);
      if (JSON.stringify(previous) !== JSON.stringify(current)) await persist(next);
      records = next;
      return value;
    });
    queue = result.catch(() => {});
    return result;
  }
  return {
    async create(username, remembered = false) {
      if (!getAccount() || username !== getAccount().username) throw new Error('登录账号无效');
      const token = randomBytes(32).toString('hex');
      await mutate(next => {
        while (next.size >= maxSessions) next.delete(next.keys().next().value);
        const createdAt = now();
        const id = digest(token);
        next.set(id, { id, username, fingerprint: fingerprint(), remembered, createdAt, expires: createdAt + (remembered ? REMEMBER_AGE : SESSION_AGE) });
      });
      return token;
    },
    get(token) {
      if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
      const record = records.get(digest(token));
      return record && valid(record) ? { username: record.username } : null;
    },
    revoke(token) { return mutate(next => { if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)) next.delete(digest(token)); }); },
    prune() { return mutate(() => {}); }
  };
}
