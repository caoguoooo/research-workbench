import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ArchiveError } from './competitor-store.mjs';

export function createAIConversationStore(dataRoot) {
  const filename = path.join(dataRoot, 'ai-conversations.json');
  let queue = Promise.resolve();
  const publicItem = item => {
    const { username, ...value } = item;
    return structuredClone(value);
  };
  async function read() {
    try {
      const data = JSON.parse(await readFile(filename, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.conversations)) throw new Error('Invalid conversation storage');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { version:1, conversations:[] }; throw error; }
  }
  function find(data, username, id) {
    const item = data.conversations.find(item => item.id === id && item.username === username);
    if (!item) throw new ArchiveError('找不到这段对话', 404);
    return item;
  }
  function activate(data, username, id) {
    data.active = (data.active || []).filter(item => item.username !== username);
    data.active.push({ username, id });
  }
  function create(data, username) {
    if (data.conversations.filter(item => item.username === username).length >= 50) throw new ArchiveError('最多保留 50 段对话，请先整理现有对话', 409);
    const time = new Date().toISOString();
    const item = { id:randomUUID(), username, title:'新对话', model:'', webSearch:true, messages:[], createdAt:time, updatedAt:time };
    data.conversations.push(item);
    activate(data, username, item.id);
    return item;
  }
  function mutate(change) {
    const pending = queue.then(async () => {
      const data = await read();
      const result = change(data);
      const content = JSON.stringify(data);
      if (Buffer.byteLength(content) > 24*1024*1024) throw new ArchiveError('聊天记录容量已满，暂时无法保存新消息', 409);
      await mkdir(dataRoot, { recursive:true, mode:0o700 });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, content, { mode:0o600, flag:'wx' }); await rename(temporary, filename); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }
  return {
    async list(username, id = null) {
      await queue;
      const data = await read();
      const own = data.conversations.filter(item => item.username === username).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
      const activeId = (data.active || []).find(item => item.username === username)?.id;
      const current = id ? find(data, username, id) : own.find(item => item.id === activeId) || own[0];
      return { items:own.map(({id,title,updatedAt}) => ({id,title,updatedAt})), current:current ? publicItem(current) : null };
    },
    async check(username, id) {
      if (id !== undefined && id !== null && (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new ArchiveError('对话编号不正确');
      await queue;
      const data = await read();
      if (id) {
        const item = find(data, username, id);
        if (item.messages.length >= 200) throw new ArchiveError('这段对话已满，请开启新对话', 409);
      } else if (data.conversations.filter(item => item.username === username).length >= 50) throw new ArchiveError('最多保留 50 段对话', 409);
    },
    create(username) { return mutate(data => publicItem(create(data, username))); },
    select(username, id) {
      return mutate(data => {
        const item = find(data, username, id);
        activate(data, username, item.id);
        return publicItem(item);
      });
    },
    append(username, id, message, result, options) {
      return mutate(data => {
        const item = id ? find(data, username, id) : create(data, username);
        if (item.messages.length >= 200) throw new ArchiveError('这段对话已满，请开启新对话', 409);
        const reply = result.draft ? `${result.draft.project.name} · ${result.draft.project.city}\n${result.draft.project.summary}\n${result.draft.research.report}` : result.reply;
        item.messages.push({ role:'user',content:message.content,...(result.failed ? {failed:true} : {}) },{ role:'assistant',content:reply,result:structuredClone(result) });
        if (item.messages.length === 2) item.title = message.content.replace(/\s+/g,' ').slice(0,60);
        item.model = options.model; item.webSearch = options.webSearch === true;
        item.updatedAt = new Date().toISOString();
        activate(data, username, item.id);
        return publicItem(item);
      });
    },
    async draft(username, draftId) {
      await queue;
      const data = await read();
      for (const item of data.conversations.filter(item => item.username === username)) {
        const draft = item.messages.find(message => message.result?.draft?.draftId === draftId)?.result.draft;
        if (draft) return structuredClone(draft);
      }
      return null;
    },
    markSaved(username, draftId, saved) {
      return mutate(data => {
        for (const item of data.conversations.filter(item => item.username === username)) {
          const draft = item.messages.find(message => message.result?.draft?.draftId === draftId)?.result.draft;
          if (draft) {
            draft.savedId = saved.id;
            draft.project = Object.fromEntries(Object.keys(draft.project).map(key => [key,saved[key]]));
            if (draft.collection) {
              draft.collection.selectedImageIds = (saved.files || []).map(file => file.cacheImageId).filter(Boolean);
              for (const image of draft.collection.images) {
                const file = saved.files?.find(file => file.cacheImageId === image.id);
                if (file) { image.category = file.category; image.slotId = file.slotId || ''; }
              }
            }
            return true;
          }
        }
        return false;
      });
    }
  };
}
