import { mkdir, readFile, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const messages = { queued:'等待 Hermes 执行',running:'Hermes 正在研究',submitted:'研究已提交，请审核',failed:'执行失败，可重试',cancelled:'任务已撤销' };
export function createHermesDispatch(directory = process.env.WORKBENCH_HERMES_OUTBOX) {
  const root = directory ? path.resolve(directory) : null;
  const filename = (id, suffix) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('研究任务编号无效');
    return path.join(root, `${id}.${suffix}.json`);
  };
  async function atomic(file, data) {
    await mkdir(root,{ recursive:true,mode:0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp,JSON.stringify(data),{ mode:0o600,flag:'wx' });
    await rename(temp,file);
  }
  async function read(file) {
    try {
      const entry = await lstat(file);
      if (!entry.isFile() || entry.size > 32*1024) return null;
      return JSON.parse(await readFile(file,'utf8'));
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  async function status(id) {
    if (!root) return null;
    const record = await read(filename(id,'status'));
    if (!record || !Object.hasOwn(messages,record.state)) return null;
    return { state:record.state,message:messages[record.state],updatedAt:record.updatedAt };
  }
  return {
    enabled:!!root,
    status,
    async info() {
      if (!root) return { enabled:false,online:false };
      const heartbeat = await read(path.join(root,'worker.json'));
      return { enabled:true,online:!!heartbeat && Date.now()-Date.parse(heartbeat.updatedAt) < 45_000 };
    },
    async enqueue(task, token) {
      if (!root) return null;
      if (task.status !== 'pending' || !/^[0-9a-f]{64}$/.test(token)) throw new Error('只有待执行任务可以交给 Hermes');
      const job = filename(task.id,'job');
      const updatedAt = new Date().toISOString();
      await atomic(filename(task.id,'status'),{ state:'queued',updatedAt });
      try { await atomic(job,{ version:1,taskId:task.id,token,createdAt:updatedAt }); }
      catch (error) {
        await atomic(filename(task.id,'status'),{ state:'failed',updatedAt }).catch(() => {});
        throw error;
      }
      return status(task.id);
    },
    async cancel(id) {
      if (!root) return;
      await unlink(filename(id,'job')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await atomic(filename(id,'status'),{ state:'cancelled',updatedAt:new Date().toISOString() });
    }
  };
}
