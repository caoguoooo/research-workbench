import { createArchiveDrafts } from './ai-archive.mjs';
import { createAIConversationStore } from './ai-conversation-store.mjs';
import http from 'node:http';
import { readFile, mkdir, writeFile, unlink, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ArchiveError, addFile, addFloorplan, addVisit, createAICompetitor, createCompetitor, deleteCompetitor, getCompetitor, initializeArchive, listCompetitors, restoreCompetitor, updateCompetitor, updateCompetitorResearch, updateCompetitorAmenities, updateFloorplan, updateVisit } from './competitor-store.mjs';
import { createAISettingsStore } from './ai-settings.mjs';
import { createAIClient } from './ai-client.mjs';
import { collectionInput, createCompetitorCollector } from './ai-collection.mjs';
import { runtimeConfig, validOrigin } from './runtime-config.mjs';
import { createHomeVisualStore } from './home-visual.mjs';
import { accountRecord, readAccount, saveAccount, verifyPassword } from './auth-store.mjs';
import { createUserProfileStore, MAX_AVATAR_BYTES } from './user-profile-store.mjs';
import { createUserStore } from './user-store.mjs';
import { createSessionStore, REMEMBER_AGE } from './session-store.mjs';
import { createResearchTask, getAgentTask, listResearchTasks, reviewResearchTask, rotateResearchToken, submitResearchResult } from './research-tasks.mjs';
import { createHermesDispatch } from './hermes-dispatch.mjs';
import { createMapSettingsStore, createMapService } from './map-service.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = runtimeConfig(process.env, root);
const dataRoot = config.dataRoot;
process.umask(0o077);
const aiSettings = createAISettingsStore(dataRoot);
const mapSettings = createMapSettingsStore(dataRoot);
const mapService = createMapService(() => mapSettings.getCredentials());
const aiClient = createAIClient(() => aiSettings.getCredentials());
const collector = createCompetitorCollector(dataRoot,aiClient);
const aiBusy = new Set();
const competitorFilesPath = path.join(dataRoot, 'competitor-files');
const { host, port } = config;
const allowEmptyPassword = config.passwordOptional;
const attempts = new Map();
const agentRequests = new Map();
const hermesDispatch = createHermesDispatch();
const dispatchLocks = new Set();
const aiConversations = createAIConversationStore(dataRoot);
const archiveDrafts = createArchiveDrafts(async draft => {
  if ([...await listCompetitors(),...await listCompetitors({ deletedOnly:true })].some(item => item.aiResearch?.draftId === draft.draftId)) return createAICompetitor(draft);
  const prepared = await collector.prepare(draft);
  try { return await createAICompetitor(prepared); }
  finally { await collector.discard({ images:prepared.selectedImages }); }
}, { persistence:aiConversations });
const maxBody = 16 * 1024;
const maxFile = 25 * 1024 * 1024;
let activeUploads = 0;
let auth = await readAccount(dataRoot);
let authQueue = Promise.resolve();
function serializeAuth(action) {
  const pending = authQueue.then(action);
  authQueue = pending.catch(() => {});
  return pending;
}
if (config.production && (!auth || !/^[0-9a-f]{128}$/.test(auth.hash || '') || !/^[0-9a-f]{48}$/.test(auth.salt || '') || verifyPassword(auth, ''))) throw new Error('正式版本需要先在服务器本机初始化非空密码账号，请运行 npm run admin:init');
const users = await createUserStore(dataRoot, () => auth);
const userProfiles = await createUserProfileStore(dataRoot);
const sessions = await createSessionStore(dataRoot, username => users.find(username), { realm: config.production ? 'production' : 'development' });
await initializeArchive();
const homeVisual = await createHomeVisualStore(dataRoot);

function responseHeaders(headers = {}) {
  return {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...headers
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, responseHeaders(headers));
  res.end(body);
}

function json(res, status, value, headers) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function redirect(res, location) {
  send(res, 302, '', { Location: location });
}

function getSession(req) {
  const match = /(?:^|; )workbench_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!match) return null;
  const record = sessions.get(match[1]);
  if (!record) return null;
  return { token: match[1], username: record.username, role: users.isPrimary(record.username) ? 'admin' : users.find(record.username).role };
}

async function readBody(req, limit = maxBody) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new Error('请求内容过大'); }
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ArchiveError('请求格式不正确');
  return body;
}

async function readFileBody(req, limit = maxFile) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new ArchiveError(limit === MAX_AVATAR_BYTES ? '头像文件不能超过 5 MB' : '单个附件不能超过 25 MB', 413); }
    chunks.push(chunk);
  }
  if (!size) throw new ArchiveError('请选择要上传的文件');
  return Buffer.concat(chunks);
}

const inlineFileTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

function safeFileType(value) {
  const type = String(value || '').toLowerCase().split(';')[0].trim();
  return inlineFileTypes.has(type) ? type : 'application/octet-stream';
}

async function handleCompetitorRequest(req, res, url, session) {
  const match = /^\/api\/competitors(?:\/([0-9a-f-]{36})(?:\/(visits|files|floorplans|restore|research|amenities)(?:\/([0-9a-f-]{36}|floorplan-\d{2}))?)?)?$/.exec(url.pathname);
  if (!match) return false;
  if (!session) {
    json(res, 401, { error: '请先登录' });
    return true;
  }
  const [, id, section, childId] = match;
  if (req.method === 'GET' && !id) {
    json(res, 200, { items: await listCompetitors({ deletedOnly: url.searchParams.get('deleted') === 'true' }) });
    return true;
  }
  if (req.method === 'GET' && id && !section) {
    json(res, 200, { item: await getCompetitor(id) });
    return true;
  }
  if (req.method === 'GET' && id && section === 'files' && childId) {
    const item = await getCompetitor(id);
    const file = item.files.find(entry => entry.id === childId);
    if (!file) throw new ArchiveError('找不到这个附件', 404);
    let filename;
    let info;
    try {
      const basePath = await realpath(competitorFilesPath);
      filename = await realpath(path.resolve(competitorFilesPath, file.storedName));
      if (!filename.startsWith(basePath + path.sep)) throw new ArchiveError('附件路径不正确', 404);
      info = await stat(filename);
      if (!info.isFile()) throw new ArchiveError('附件文件不存在', 404);
    }
    catch (error) { if (error.code === 'ENOENT') throw new ArchiveError('附件文件不存在', 404); throw error; }
    const inline = inlineFileTypes.has(file.type);
    const headers = {
      'Content-Type': inline ? file.type : 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", '%27')}`
    };
    let start = 0;
    let end = info.size - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || (!range[1] && !range[2])) { send(res, 416, '', { 'Content-Range': `bytes */${info.size}` }); return true; }
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
      else { const suffix = Number(range[2]); if (suffix <= 0) { send(res, 416, '', { 'Content-Range': `bytes */${info.size}` }); return true; } start = Math.max(0, info.size - suffix); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { send(res, 416, '', { 'Content-Range': `bytes */${info.size}` }); return true; }
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(req.headers.range ? 206 : 200, responseHeaders(headers));
    await pipeline(createReadStream(filename, { start, end }), res);
    return true;
  }
  if (!allowedOrigin(req)) throw new ArchiveError('请求来源无效', 403);
  if (section === 'amenities') {
    if (!id || childId || req.method !== 'PATCH') throw new ArchiveError('不支持这个操作', 405);
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ArchiveError('仅接受 JSON 请求', 415);
    json(res, 200, { item: await updateCompetitorAmenities(id, await readBody(req, 512 * 1024)) });
    return true;
  }
  if (section === 'research') {
    if (!id || childId || req.method !== 'PATCH') throw new ArchiveError('不支持这个操作', 405);
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ArchiveError('仅接受 JSON 请求', 415);
    json(res, 200, { item: await updateCompetitorResearch(id, await readBody(req, 1024 * 1024), session.username) });
    return true;
  }
  if (req.method === 'DELETE' && id && !section) {
    await deleteCompetitor(id);
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && id && section === 'files' && !childId) {
    if (activeUploads >= 3) throw new ArchiveError('正在上传其他资料，请稍后重试', 429);
    activeUploads++;
    try {
    await getCompetitor(id);
    const name = url.searchParams.get('name');
    const category = url.searchParams.get('category');
    const visitId = url.searchParams.get('visitId');
    const slotId = url.searchParams.get('slotId');
    if (visitId && !/^[0-9a-f-]{36}$/.test(visitId)) throw new ArchiveError('踩盘记录编号不正确');
    if (slotId && !/^(masterplan|floorplan-\d{2}|[0-9a-f-]{36})$/.test(slotId)) throw new ArchiveError('图像位置编号不正确');
    const type = safeFileType(req.headers['content-type']);
    const content = await readFileBody(req);
    const fileId = randomUUID();
    const folder = category === '总规划' ? 'masterplan'
      : category === '效果图' ? 'renderings'
      : category === '户型图' ? path.join('floorplans', slotId || 'unassigned')
      : visitId ? path.join('visits', visitId) : 'documents';
    const storedName = path.join(id, folder, `${fileId}.bin`);
    await mkdir(path.join(competitorFilesPath, id, folder), { recursive: true, mode: 0o700 });
    await writeFile(path.join(competitorFilesPath, storedName), content, { flag: 'wx', mode: 0o600 });
    try {
      const file = await addFile(id, { id: fileId, name, category, visitId, slotId, type, size: content.length, storedName });
      json(res, 201, { file });
    } catch (error) {
      await unlink(path.join(competitorFilesPath, storedName));
      throw error;
    }
    return true;
    } finally { activeUploads--; }
  }
  if (['POST', 'PATCH'].includes(req.method)) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ArchiveError('仅接受 JSON 请求', 415);
    const body = await readBody(req, !section ? 32 * 1024 : maxBody);
    if (req.method === 'POST' && !id) json(res, 201, { item: await createCompetitor(body) });
    else if (req.method === 'POST' && id && section === 'restore' && !childId) json(res, 200, { item: await restoreCompetitor(id) });
    else if (req.method === 'PATCH' && id && !section) json(res, 200, { item: await updateCompetitor(id, body) });
    else if (req.method === 'POST' && id && section === 'visits' && !childId) json(res, 201, { visit: await addVisit(id, body) });
    else if (req.method === 'PATCH' && id && section === 'visits' && childId) json(res, 200, { visit: await updateVisit(id, childId, body) });
    else if (req.method === 'POST' && id && section === 'floorplans' && !childId) json(res, 201, { floorplan: await addFloorplan(id, body) });
    else if (req.method === 'PATCH' && id && section === 'floorplans' && childId) json(res, 200, { floorplan: await updateFloorplan(id, childId, body) });
    else throw new ArchiveError('找不到这个操作', 404);
    return true;
  }
  throw new ArchiveError('不支持这个操作', 405);
}

function allowedOrigin(req) {
  return validOrigin(req, config);
}

async function staticFile(res, filename, type) {
  try {
    const content = await readFile(path.join(root, filename));
    send(res, 200, content, { 'Content-Type': type });
  } catch (error) {
    if (error.code === 'ENOENT') send(res, 404, 'Not found');
    else throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const session = getSession(req);
    res.setHeader('X-Request-ID', randomUUID());

    // Deny by default: viewers may read archives and manage only their own profile and password.
    if (session?.role === 'viewer' && pathname.startsWith('/api/')) {
      const publicRead = ['/api/status', '/api/home-visual', '/api/home-visual/image', '/api/account/profile'].includes(pathname) || /^\/api\/competitors(?:\/[0-9a-f-]{36}(?:\/files\/[0-9a-f-]{36})?)?$/.test(pathname);
      const ownAccount = req.method === 'POST' && ['/api/logout', '/api/account/password', '/api/account/avatar'].includes(pathname) || req.method === 'PATCH' && pathname === '/api/account/profile' || req.method === 'DELETE' && pathname === '/api/account/avatar';
      const avatarRead = /^\/api\/users\/[^/]+\/avatar$/.test(pathname);
      const archiveTrash = pathname === '/api/competitors' && url.searchParams.get('deleted') === 'true';
      if (!(req.method === 'GET' && (publicRead || avatarRead) && !archiveTrash) && !ownAccount) throw new ArchiveError('普通用户仅可浏览资料，此操作需要管理员权限', 403);
    }
    const avatarRead = /^\/api\/users\/([^/]+)\/avatar$/.exec(pathname);
    if (avatarRead && req.method === 'GET') {
      if (!session) throw new ArchiveError('请先登录', 401);
      const account = users.find(decodeURIComponent(avatarRead[1]));
      if (!account || session.role !== 'admin' && account.status && account.status !== 'active') throw new ArchiveError('头像不存在', 404);
      const bytes = await userProfiles.image(account.username);
      return bytes ? send(res, 200, bytes, { 'Content-Type': 'image/webp' }) : json(res, 404, { error: '头像不存在' });
    }
    const adminProfile = /^\/api\/admin\/users\/([^/]+)\/(profile|avatar)$/.exec(pathname);
    if (['/api/account/profile', '/api/account/avatar'].includes(pathname) || adminProfile) {
      if (!session) throw new ArchiveError('请先登录', 401);
      if (adminProfile && session.role !== 'admin') throw new ArchiveError('需要管理员权限', 403);
      const username = adminProfile ? decodeURIComponent(adminProfile[1]) : session.username;
      const target = users.find(username);
      if (!target) throw new ArchiveError('用户不存在', 404);
      const section = adminProfile ? adminProfile[2] : pathname.split('/').at(-1);
      if (section === 'profile' && req.method === 'GET' && !adminProfile) return json(res, 200, { profile: { username: target.username, ...userProfiles.get(target.username) } });
      if (!allowedOrigin(req)) throw new ArchiveError('请求来源无效', 403);
      if (!(section === 'profile' && req.method === 'PATCH' || section === 'avatar' && ['POST', 'DELETE'].includes(req.method))) throw new ArchiveError('不支持这个操作', 405);
      if (section === 'profile' && req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ArchiveError('仅接受 JSON 请求', 415);
      const uploading = section === 'avatar' && req.method === 'POST';
      if (uploading && activeUploads >= 3) throw new ArchiveError('正在上传其他资料，请稍后重试', 429);
      if (uploading) activeUploads++;
      try {
      const input = section === 'profile' ? await readBody(req) : req.method === 'POST' ? await readFileBody(req, MAX_AVATAR_BYTES) : null;
      return await serializeAuth(async () => {
        const current = getSession(req);
        if (!current) throw new ArchiveError('登录已失效，请重新登录', 401);
        if (adminProfile && current.role !== 'admin') throw new ArchiveError('需要管理员权限', 403);
        if (!users.find(target.username)) throw new ArchiveError('用户不存在', 404);
        const profile = section === 'profile' ? await userProfiles.update(target.username, input) : req.method === 'POST' ? await userProfiles.upload(target.username, input) : await userProfiles.clearAvatar(target.username);
        return json(res, 200, { profile: { username: target.username, ...profile } });
      });
      } finally { if (uploading) activeUploads--; }
    }
    if (pathname === '/api/admin/users' || pathname.startsWith('/api/admin/users/')) {
      if (!session) throw new ArchiveError('请先登录', 401);
      if (session.role !== 'admin') throw new ArchiveError('需要管理员权限', 403);
      if (pathname === '/api/admin/users' && req.method === 'GET') return json(res, 200, { items: users.list().map(user => ({ ...user, ...userProfiles.get(user.username) })) });
      if (!['PATCH', 'DELETE'].includes(req.method) || pathname === '/api/admin/users') throw new ArchiveError('不支持这个操作', 405);
      if (!allowedOrigin(req)) throw new ArchiveError('请求来源无效', 403);
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ArchiveError('仅接受 JSON 请求', 415);
      const username = decodeURIComponent(pathname.slice('/api/admin/users/'.length));
      const body = await readBody(req);
      return await serializeAuth(async () => {
        const current = getSession(req);
        if (!current) throw new ArchiveError('登录已失效，请重新登录', 401);
        if (current.role !== 'admin') throw new ArchiveError('需要管理员权限', 403);
        if (req.method === 'DELETE') {
          const removed = await users.remove(username, current.username);
          await userProfiles.remove(removed);
          await sessions.prune();
          return json(res, 200, { ok: true });
        }
        const user = await users.update(username, body, current.username);
        await sessions.prune();
        return json(res, 200, { item: { ...user, ...userProfiles.get(user.username) } });
      });
    }

    if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'GET' && pathname === '/') return redirect(res, session ? '/app' : '/login');
    if (req.method === 'GET' && pathname === '/login') return session ? redirect(res, '/app') : staticFile(res, 'login.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && pathname === '/app') return session ? staticFile(res, 'app.html', 'text/html; charset=utf-8') : redirect(res, '/login');
    if (req.method === 'GET' && pathname === '/styles.css') return staticFile(res, 'styles.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && pathname === '/login.js') return staticFile(res, 'login.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && pathname === '/theme.js') return staticFile(res, 'theme.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && pathname === '/app.js') return session ? staticFile(res, 'app.js', 'text/javascript; charset=utf-8') : send(res, 401, 'Unauthorized');
    if (req.method === 'GET' && pathname === '/competitor.js') return session ? staticFile(res, 'competitor.js', 'text/javascript; charset=utf-8') : send(res, 401, 'Unauthorized');
    if (req.method === 'GET' && ['/research-tasks.js', '/users.js', '/profile.js'].includes(pathname)) return session ? staticFile(res, pathname.slice(1), 'text/javascript; charset=utf-8') : send(res, 401, 'Unauthorized');
    if (req.method === 'GET' && ['/project-details.js', '/amenities.js'].includes(pathname)) return session ? staticFile(res, pathname.slice(1), 'text/javascript; charset=utf-8') : send(res, 401, 'Unauthorized');
    if (req.method === 'GET' && ['/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css'].includes(pathname)) return session ? staticFile(res, pathname.slice(1), pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8') : send(res, 401, 'Unauthorized');
    if (pathname.startsWith('/api/agent/')) {
      const key = req.socket.remoteAddress || 'local';
      const now = Date.now();
      for (const [address, entry] of agentRequests) if (entry.until <= now) agentRequests.delete(address);
      const entry = agentRequests.get(key) || { count:0,until:now+60_000 };
      if (entry.count >= 60 || (!agentRequests.has(key) && agentRequests.size >= 1000)) throw new ArchiveError('代理请求过于频繁，请稍后重试',429);
      entry.count++;
      agentRequests.set(key,entry);
      if (req.headers.origin || req.headers['sec-fetch-site']) throw new ArchiveError('代理接口仅供服务端调用',403);
      const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')?.[1];
      const task = await getAgentTask(token);
      if (pathname === '/api/agent/task' && req.method === 'GET') return json(res,200,{ task });
      if (pathname === '/api/agent/result' && req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ArchiveError('仅接受 JSON 请求',415);
        return json(res,200,await submitResearchResult(token,await readBody(req,128*1024)));
      }
      throw new ArchiveError('找不到这个代理操作',404);
    }
    if (pathname === '/api/research-tasks' || pathname.startsWith('/api/research-tasks/')) {
      if (!session) throw new ArchiveError('请先登录',401);
      if (pathname === '/api/research-tasks' && req.method === 'GET') {
        const tasks = await listResearchTasks();
        return json(res,200,{ items:await Promise.all(tasks.map(async task => ({ ...task,dispatch:await hermesDispatch.status(task.id) }))),hermes:await hermesDispatch.info() });
      }
      if (!allowedOrigin(req)) throw new ArchiveError('请求来源无效',403);
      if (req.method !== 'POST') throw new ArchiveError('不支持这个操作',405);
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ArchiveError('仅接受 JSON 请求',415);
      const body = await readBody(req);
      async function dispatchResult(result) {
        try { result.task.dispatch = await hermesDispatch.enqueue(result.task,result.token); }
        catch { result.task.dispatch = { state:'failed',message:'任务已创建，但未能交给 Hermes。请重试。' }; }
        return result;
      }
      if (pathname === '/api/research-tasks') return json(res,201,await dispatchResult(await createResearchTask(body,session.username)));
      const match = /^\/api\/research-tasks\/([0-9a-f-]{36})\/(review|token|dispatch)$/.exec(pathname);
      if (!match) throw new ArchiveError('找不到研究任务操作',404);
      const id = match[1];
      if (match[2] === 'review') {
        const result = await reviewResearchTask(id,body,session.username);
        if (body.action === 'reject') await hermesDispatch.cancel(id);
        return json(res,200,result);
      }
      if (dispatchLocks.has(id)) throw new ArchiveError('任务正在提交，请稍后刷新',409);
      dispatchLocks.add(id);
      try {
        if (match[2] === 'dispatch') {
          if (!hermesDispatch.enabled) throw new ArchiveError('尚未配置 Hermes 执行服务',409);
          const state = await hermesDispatch.status(id);
          if (['queued','running'].includes(state?.state)) throw new ArchiveError('任务已交给 Hermes，请等待执行或撤销后重建',409);
          return json(res,200,await dispatchResult(await rotateResearchToken(id)));
        }
        if (match[2] === 'token') return json(res,200,await dispatchResult(await rotateResearchToken(id)));
      } finally { dispatchLocks.delete(id); }
    }
    if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { setupRequired: !auth, authenticated: !!session, username: session?.username || null, ...(session ? userProfiles.get(session.username) : {}), role: session?.role || null, registrationOpen: !!auth, passwordOptional: allowEmptyPassword });
    if (pathname === '/api/account/password') {
      if (!session) return json(res, 401, { error: '请先登录' });
      if (req.method !== 'POST') return json(res, 405, { error: '不支持这个操作' });
      if (!allowedOrigin(req)) return json(res, 403, { error: '请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '仅接受 JSON 请求' });
      const body = await readBody(req);
      return await serializeAuth(async () => {
        if (!getSession(req)) throw new ArchiveError('登录已失效，请重新登录', 401);
        const account = users.find(session.username);
        const { currentPassword, newPassword, confirmPassword } = body;
        if (typeof currentPassword !== 'string' || currentPassword.length > 128 || typeof newPassword !== 'string' || typeof confirmPassword !== 'string') throw new ArchiveError('密码格式不正确');
        if (newPassword.length < 8 || newPassword.length > 128) throw new ArchiveError('新密码需为 8–128 位');
        if (newPassword !== confirmPassword) throw new ArchiveError('两次新密码不一致');
        const key = `password:${account.username}`;
        const now = Date.now();
        const trial = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
        if (trial.until <= now) { trial.count = 0; trial.until = now + 15 * 60 * 1000; }
        if (trial.count >= 10) throw new ArchiveError('当前密码尝试次数过多，请稍后再试', 429);
        if (!verifyPassword(account, currentPassword)) {
          trial.count += 1;
          attempts.set(key, trial);
          throw new ArchiveError('当前密码不正确');
        }
        if (verifyPassword(account, newPassword)) throw new ArchiveError('新密码不能与当前密码相同');
        const next = accountRecord(account.username, newPassword);
        if (users.isPrimary(account.username)) {
          await saveAccount(dataRoot, next, true);
          auth = next;
        } else await users.changePassword(account.username, next);
        attempts.delete(key);
        // The changed credential fingerprint invalidates every session immediately.
        await sessions.prune().catch(() => { console.error(JSON.stringify({ event: 'session_cleanup_error' })); });
        return json(res, 200, { ok: true }, { 'Set-Cookie': `workbench_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${config.production ? '; Secure' : ''}` });
      });
    }
    if (req.method === 'GET' && ['/api/home-visual', '/api/home-visual/image'].includes(pathname)) {
      if (!session) return json(res, 401, { error: '请先登录' });
      if (pathname === '/api/home-visual') return json(res, 200, homeVisual.get());
      const image = await homeVisual.image();
      return image ? send(res, 200, image.bytes, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=3600' }) : send(res, 404, 'Image not available');
    }
    if (pathname === '/api/settings/maps') {
      if (!session) return json(res, 401, { error: '请先登录' });
      if (req.method === 'GET') return json(res, 200, await mapSettings.getPublic());
      if (req.method !== 'PATCH') return json(res, 405, { error: '不支持这个操作' });
      if (!allowedOrigin(req)) return json(res, 403, { error: '请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '仅接受 JSON 请求' });
      return json(res, 200, await mapSettings.save(await readBody(req)));
    }
    if (['/api/maps/search', '/api/maps/nearby'].includes(pathname)) {
      if (!session) return json(res, 401, { error: '请先登录' });
      if (req.method !== 'POST') return json(res, 405, { error: '不支持这个操作' });
      if (!allowedOrigin(req)) return json(res, 403, { error: '请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '仅接受 JSON 请求' });
      const body = await readBody(req);
      if (typeof body.projectId !== 'string') throw new ArchiveError('请选择楼盘');
      const item = await getCompetitor(body.projectId);
      return json(res, 200, pathname.endsWith('/search') ? await mapService.search(item, body.query) : await mapService.nearby(item));
    }
    if (pathname === '/api/settings/ai') {
      if (!session) return json(res, 401, { error: '请先登录' });
      if (req.method === 'GET') return json(res, 200, await aiSettings.getPublic());
      if (req.method !== 'PATCH') return json(res, 405, { error: '不支持这个操作' });
      if (!allowedOrigin(req)) return json(res, 403, { error: '请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '仅接受 JSON 请求' });
      return json(res, 200, await aiSettings.save(await readBody(req)));
    }
    if (pathname === '/api/ai/conversations/select') {
      if (!session) return json(res, 401, { error:'请先登录' });
      if (req.method !== 'POST') return json(res, 405, { error:'不支持这个操作' });
      if (!allowedOrigin(req)) return json(res, 403, { error:'请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error:'仅接受 JSON 请求' });
      const body = await readBody(req);
      if (typeof body?.id !== 'string') throw new ArchiveError('对话编号不正确');
      return json(res, 200, { current:await aiConversations.select(session.username, body.id) });
    }
    if (pathname === '/api/ai/conversations') {
      if (!session) return json(res, 401, { error:'请先登录' });
      if (req.method === 'GET') return json(res, 200, await aiConversations.list(session.username, url.searchParams.get('id')));
      if (req.method !== 'POST') return json(res, 405, { error:'不支持这个操作' });
      if (!allowedOrigin(req)) return json(res, 403, { error:'请求来源无效' });
      return json(res, 201, { current:await aiConversations.create(session.username) });
    }
    if (pathname === '/api/ai/archive') {
      if (!session) return json(res, 401, { error:'请先登录' });
      if (req.method !== 'POST') return json(res, 405, { error:'不支持这个操作' });
      if (!allowedOrigin(req)) return json(res, 403, { error:'请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error:'仅接受 JSON 请求' });
      const body = await readBody(req);
      return json(res, 201, { item:await archiveDrafts.save(session.username, body) });
    }
    if (pathname === '/api/ai/collection/image' && req.method === 'GET') {
      if (!session) return json(res,401,{ error:'请先登录' });
      const draft = await archiveDrafts.get(session.username,url.searchParams.get('draftId'));
      const image = draft.collection?.images.find(image => image.id === url.searchParams.get('imageId'));
      if (!image) throw new ArchiveError('找不到这张草稿图片',404);
      const result = await collector.image(image);
      return send(res,200,result.bytes,{ 'Content-Type':result.type });
    }
    if (pathname === '/api/ai/collect') {
      if (!session) return json(res,401,{ error:'请先登录' });
      if (req.method !== 'POST') return json(res,405,{ error:'不支持这个操作' });
      if (!allowedOrigin(req)) return json(res,403,{ error:'请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res,415,{ error:'仅接受 JSON 请求' });
      if (aiBusy.has(session.username)) throw new ArchiveError('AI 正在处理，请等待或停止当前任务',429);
      const input = collectionInput(await readBody(req));
      if (aiBusy.has(session.username)) throw new ArchiveError('AI 正在处理，请等待或停止当前任务',429);
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close',abort); aiBusy.add(session.username);
      let collected, draftId, persisted = false;
      try {
        await aiConversations.check(session.username,null);
        collected = await collector.collect(input,controller.signal);
        const { result,message,collection } = collected;
        controller.signal.throwIfAborted();
        if (!getSession(req)) throw new ArchiveError('登录已失效，请重新登录',401);
        const draft = archiveDrafts.add(session.username,result,collection);
        draftId = draft.draftId;
        const conversation = await aiConversations.append(session.username,null,message,{draft},{ model:input.model,webSearch:true });
        persisted = true;
        if (!res.destroyed) json(res,200,{ draft,conversationId:conversation.id });
      } finally {
        if (!persisted && collected) {
          archiveDrafts.discard(session.username,draftId);
          await collector.discard(collected.collection);
        }
        res.removeListener('close',abort); aiBusy.delete(session.username);
      }
      return;
    }
    if (['/api/ai/models', '/api/ai/chat'].includes(pathname)) {
      if (!session) return json(res, 401, { error: '请先登录' });
      if (!allowedOrigin(req)) return json(res, 403, { error: '请求来源无效' });
      const modelRequest = pathname === '/api/ai/models' && req.method === 'GET';
      const chatRequest = pathname === '/api/ai/chat' && req.method === 'POST';
      if (!modelRequest && !chatRequest) return json(res, 405, { error: '不支持这个操作' });
      if (chatRequest && req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '仅接受 JSON 请求' });
      if (chatRequest && aiBusy.has(session.username)) return json(res, 429, { error: 'AI 正在回复，请等待或停止当前对话' });
      const body = chatRequest ? await readBody(req, 256 * 1024) : null;
      if (chatRequest && aiBusy.has(session.username)) return json(res, 429, { error: 'AI 正在回复，请等待或停止当前对话' });
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      if (chatRequest) aiBusy.add(session.username);
      try {
        if (chatRequest) await aiConversations.check(session.username, body?.conversationId);
        let result = modelRequest ? { models: await aiClient.models(controller.signal) } : await aiClient.chat(body, controller.signal);
        if (!modelRequest && body.archiveDraft && !res.destroyed) result = { draft:archiveDrafts.add(session.username, result) };
        if (!modelRequest && !res.destroyed) {
          if (!getSession(req)) throw new ArchiveError('登录已失效，请重新登录', 401);
        const account = users.find(session.username);
          const conversation = await aiConversations.append(session.username, body.conversationId, body.messages.at(-1), result, { model:body.model, webSearch:body.webSearch });
          result = { ...result, conversationId:conversation.id };
        }
        if (!res.destroyed) json(res, 200, result);
      } catch (failure) {
        if (chatRequest && failure instanceof ArchiveError && failure.status >= 500 && !controller.signal.aborted && !res.destroyed && getSession(req)) {
          const message = body?.messages?.at(-1);
          if (message?.role === 'user' && typeof message.content === 'string' && message.content.length <= 12000) {
            const conversation = await aiConversations.append(session.username, body.conversationId, message, { reply:failure.message,failed:true }, { model:body.model,webSearch:body.webSearch });
            json(res, failure.status, { error:failure.message,conversationId:conversation.id });
            return;
          }
        }
        throw failure;
      } finally {
        res.removeListener('close', abort);
        if (chatRequest) aiBusy.delete(session.username);
      }
      return;
    }
    if (await handleCompetitorRequest(req, res, url, session)) return;

    if (req.method === 'POST' && ['/api/setup', '/api/login', '/api/logout', '/api/register'].includes(pathname)) {
      if (!allowedOrigin(req)) return json(res, 403, { error: '请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '仅接受 JSON 请求' });
      const body = await readBody(req);

      if (pathname === '/api/register') {
        if (!auth) throw new ArchiveError('请先由管理员初始化工作台', 409);
        const key = `register:${req.socket.remoteAddress || 'local'}`;
        const now = Date.now();
        const trial = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
        if (trial.until <= now) { trial.count = 0; trial.until = now + 15 * 60 * 1000; }
        if (trial.count >= 10) throw new ArchiveError('注册请求过于频繁，请稍后再试', 429);
        trial.count++; attempts.set(key, trial);
        if (attempts.size > 1000) attempts.delete(attempts.keys().next().value);
        if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password !== body.confirmPassword) throw new ArchiveError('请填写账号并确认两次密码一致');
        const item = await serializeAuth(() => users.register(body.username, body.password));
        return json(res, 201, { ok: true, item, message: '注册成功，请等待管理员审核后登录。' });
      }

      if (pathname === '/api/setup') {
        if (config.production) return json(res, 403, { error: '正式版本请在服务器本机初始化账号' });
        if (auth) return json(res, 409, { error: '管理员账号已经创建' });
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        let record;
        try { record = accountRecord(username, password, allowEmptyPassword); }
        catch (error) { return json(res, 400, { error: error.message }); }
        try {
          await saveAccount(dataRoot, record);
        } catch (error) {
          if (error.code === 'EEXIST') return json(res, 409, { error: '管理员账号已经创建' });
          throw error;
        }
        auth = record;
        return json(res, 201, { ok: true });
      }

      if (pathname === '/api/login') {
        return await serializeAuth(async () => {
        if (!auth) return json(res, 409, { error: '请先创建管理员账号' });
        if (body.remember !== undefined && typeof body.remember !== 'boolean') throw new ArchiveError('记住登录选项格式不正确');
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
        const key = config.trustProxy && isIP(forwarded) ? forwarded : req.socket.remoteAddress || 'local';
        const now = Date.now();
        const trial = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
        if (trial.until < now) { trial.count = 0; trial.until = now + 15 * 60 * 1000; }
        if (trial.count >= 10) return json(res, 429, { error: '尝试次数过多，请稍后再试' });
        const username = String(body.username || '');
        const password = String(body.password || '');
        if (password.length > 128 || username.length > 32) return json(res, 401, { error: '账号或密码不正确' });
        const account = users.find(username);
        const validPassword = account && ((allowEmptyPassword && users.isPrimary(account.username) && password === '') || (password !== '' && verifyPassword(account, password)));
        const valid = !!validPassword;
        if (!valid) {
          trial.count += 1;
          attempts.set(key, trial);
          if (attempts.size > 1000) attempts.delete(attempts.keys().next().value);
          return json(res, 401, { error: '账号或密码不正确' });
        }
        if (account.status && account.status !== 'active') return json(res, 403, { error: account.status === 'pending' ? '账号正在等待管理员审核' : '账号已被停用，请联系管理员' });
        attempts.delete(key);
        const remembered = body.remember === true;
        if (remembered && password === '') throw new ArchiveError('记住登录需要使用非空密码');
        const token = await sessions.create(account.username, remembered);
        return json(res, 200, { ok: true }, { 'Set-Cookie': `workbench_session=${token}; HttpOnly; SameSite=Strict; Path=/${remembered ? `; Max-Age=${REMEMBER_AGE / 1000}` : ''}${config.production ? '; Secure' : ''}` });
        });
      }

      if (session) await sessions.revoke(session.token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `workbench_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${config.production ? '; Secure' : ''}` });
    }

    send(res, 404, 'Not found');
  } catch (error) {
    if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
    if (error instanceof ArchiveError) return json(res, error.status, { error: error.message });
    if (error instanceof SyntaxError) return json(res, 400, { error: '请求格式不正确' });
    if (error.message === '请求内容过大') return json(res, 413, { error: error.message });
    console.error(JSON.stringify({ event: 'request_error', name: error.name, code: error.code || 'UNKNOWN' }));
    json(res, 500, { error: '服务器暂时无法处理请求' });
  }
});

server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.maxRequestsPerSocket = 100;
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
  sessions.prune().catch(() => { console.error(JSON.stringify({ event: 'session_cleanup_error' })); });
}, 60_000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 10_000).unref();
});
server.once('close', () => homeVisual.stop());
server.listen(port, host, () => {
  console.log(`caoguoooo-workbench：http://${host}:${port}`);
  if (process.env.WORKBENCH_HOME_VISUAL !== 'false') homeVisual.start();
});
