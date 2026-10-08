import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function passwordHash(password, salt) { return scryptSync(password, salt, 64).toString('hex'); }
export function verifyPassword(record, password) {
  if (typeof password !== 'string' || password.length > 128 || typeof record?.salt !== 'string' || !/^[0-9a-f]{128}$/.test(record?.hash || '')) return false;
  return timingSafeEqual(Buffer.from(passwordHash(password, record.salt), 'hex'), Buffer.from(record.hash, 'hex'));
}
export function accountRecord(username, password, allowEmpty = false) {
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) throw new Error('账号需为 3–32 位字母、数字、中文、点、下划线或连字符');
  if (typeof password !== 'string' || (!(allowEmpty && password === '') && (password.length < 10 || password.length > 128))) throw new Error('密码需为 10–128 位');
  const salt = randomBytes(24).toString('hex');
  return { username, salt, hash: passwordHash(password, salt) };
}
export async function readAccount(dataRoot) {
  try { return JSON.parse(await readFile(path.join(dataRoot, 'auth.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function saveAccount(dataRoot, record, replace = false) {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const filename = path.join(dataRoot, 'auth.json');
  if (!replace) return writeFile(filename, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  const temporary = filename + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, filename);
}
