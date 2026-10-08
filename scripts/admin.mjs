import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountRecord, saveAccount } from '../auth-store.mjs';

process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(root, 'data'));
const args = process.argv.slice(2);
const username = args[args.indexOf('--username') + 1];
if (!args.includes('--username') || !username || username.startsWith('--')) throw new Error('请提供 --username 账号名称');

async function passwordPrompt(label) {
  if (!process.stdin.isTTY) throw new Error('请使用交互终端输入密码；自动化初始化可使用 WORKBENCH_ADMIN_PASSWORD_FILE');
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (failure) => {
      process.stdin.off('data', handler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      failure ? reject(failure) : resolve(value);
    };
    const handler = buffer => {
      for (const character of buffer.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('已取消'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') { if (value) { value = [...value].slice(0, -1).join(''); process.stdout.write('\b \b'); } }
        else if (character >= ' ' && value.length < 128) { value += character; process.stdout.write('*'); }
      }
    };
    process.stdin.on('data', handler);
  });
}
let password;
if (process.env.WORKBENCH_ADMIN_PASSWORD_FILE) password = (await readFile(process.env.WORKBENCH_ADMIN_PASSWORD_FILE, 'utf8')).replace(/\r?\n$/, '');
else {
  password = await passwordPrompt('密码（至少10位）：');
  const repeat = await passwordPrompt('再次输入：');
  if (password !== repeat) throw new Error('两次密码不一致');
}
const record = accountRecord(username, password);
try { await saveAccount(dataRoot, record, args.includes('--reset')); }
catch (error) { if (error.code === 'EEXIST') throw new Error('账号已存在；如需重置，请停止服务后明确添加 --reset'); throw error; }
console.log('账号已保存。请启动或重启后端服务。');
