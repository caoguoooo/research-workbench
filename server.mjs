import http from 'node:http';
import { readFile, mkdir, writeFile, unlink, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ArchiveError, addFile, addFloorplan, addVisit, createCompetitor, deleteCompetitor, getCompetitor, initializeArchive, listCompetitors, restoreCompetitor, updateCompetitor, updateFloorplan, updateVisit } from './competitor-store.mjs';
import { createAISettingsStore } from './ai-settings.mjs';
import { createAIClient } from './ai-client.mjs';
import { runtimeConfig, validOrigin } from './runtime-config.mjs';
import { createHomeVisualStore } from './home-visual.mjs';
import { accountRecord, readAccount, saveAccount, verifyPassword } from './auth-store.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = runtimeConfig(process.env, root);
const dataRoot = config.dataRoot;
process.umask(0o077);
const aiSettings = createAISettingsStore(dataRoot);
const aiClient = createAIClient(() => aiSettings.getCredentials());
const aiBusy = new Set();
const competitorFilesPath = path.join(dataRoot, 'competitor-files');
const { host, port } = config;
const allowEmptyPassword = config.passwordOptional;
const sessions = new Map();
const attempts = new Map();
const sessionAge = 12 * 60 * 60 * 1000;
const maxBody = 16 * 1024;
const maxFile = 25 * 1024 * 1024;
let activeUploads = 0;
let auth = await readAccount(dataRoot);
if (config.production && (!auth || !/^[0-9a-f]{128}$/.test(auth.hash || '') || !/^[0-9a-f]{48}$/.test(auth.salt || '') || verifyPassword(auth, ''))) throw new Error('正式版本需要先在服务器本机初始化非空密码账号，请运行 npm run admin:init');
await initializeArchive();
const homeVisual = await createHomeVisualStore(dataRoot);

function responseHeaders(headers = {}) {
  return {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
  if (record.expires < Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  return { token: match[1], username: record.username };
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

async function readFileBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxFile) { req.resume(); throw new ArchiveError('单个附件不能超过 25 MB', 413); }
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
  const match = /^\/api\/competitors(?:\/([0-9a-f-]{36})(?:\/(visits|files|floorplans|restore)(?:\/([0-9a-f-]{36}|floorplan-\d{2}))?)?)?$/.exec(url.pathname);
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
    const body = await readBody(req);
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

    if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'GET' && pathname === '/') return redirect(res, session ? '/app' : '/login');
    if (req.method === 'GET' && pathname === '/login') return session ? redirect(res, '/app') : staticFile(res, 'login.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && pathname === '/app') return session ? staticFile(res, 'app.html', 'text/html; charset=utf-8') : redirect(res, '/login');
    if (req.method === 'GET' && pathname === '/styles.css') return staticFile(res, 'styles.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && pathname === '/login.js') return staticFile(res, 'login.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && pathname === '/app.js') return session ? staticFile(res, 'app.js', 'text/javascript; charset=utf-8') : send(res, 401, 'Unauthorized');
    if (req.method === 'GET' && pathname === '/competitor.js') return session ? staticFile(res, 'competitor.js', 'text/javascript; charset=utf-8') : send(res, 401, 'Unauthorized');
    if (req.method === 'GET' && pathname === '/ai-chat.js') return session ? staticFile(res, 'ai-chat.js', 'text/javascript; charset=utf-8') : send(res, 401, 'Unauthorized');
    if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { setupRequired: !auth, authenticated: !!session, username: session?.username || null, passwordOptional: allowEmptyPassword });
    if (req.method === 'GET' && ['/api/home-visual', '/api/home-visual/image'].includes(pathname)) {
      if (!session) return json(res, 401, { error: '请先登录' });
      if (pathname === '/api/home-visual') return json(res, 200, homeVisual.get());
      const image = await homeVisual.image();
      return image ? send(res, 200, image.bytes, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=3600' }) : send(res, 404, 'Image not available');
    }
    if (pathname === '/api/settings/ai') {
      if (!session) return json(res, 401, { error: '请先登录' });
      if (req.method === 'GET') return json(res, 200, await aiSettings.getPublic());
      if (req.method !== 'PATCH') return json(res, 405, { error: '不支持这个操作' });
      if (!allowedOrigin(req)) return json(res, 403, { error: '请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '仅接受 JSON 请求' });
      return json(res, 200, await aiSettings.save(await readBody(req)));
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
        const result = modelRequest ? { models: await aiClient.models(controller.signal) } : await aiClient.chat(body, controller.signal);
        if (!res.destroyed) json(res, 200, result);
      } finally {
        res.removeListener('close', abort);
        if (chatRequest) aiBusy.delete(session.username);
      }
      return;
    }
    if (await handleCompetitorRequest(req, res, url, session)) return;

    if (req.method === 'POST' && ['/api/setup', '/api/login', '/api/logout'].includes(pathname)) {
      if (!allowedOrigin(req)) return json(res, 403, { error: '请求来源无效' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '仅接受 JSON 请求' });
      const body = await readBody(req);

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
        if (!auth) return json(res, 409, { error: '请先创建管理员账号' });
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
        const key = config.trustProxy && isIP(forwarded) ? forwarded : req.socket.remoteAddress || 'local';
        const now = Date.now();
        const trial = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
        if (trial.until < now) { trial.count = 0; trial.until = now + 15 * 60 * 1000; }
        if (trial.count >= 10) return json(res, 429, { error: '尝试次数过多，请稍后再试' });
        const username = String(body.username || '');
        const password = String(body.password || '');
        if (password.length > 128 || username.length > 32) return json(res, 401, { error: '账号或密码不正确' });
        const validPassword = (allowEmptyPassword && password === '') || (password !== '' && verifyPassword(auth, password));
        const valid = username === auth.username && validPassword;
        if (!valid) {
          trial.count += 1;
          attempts.set(key, trial);
          if (attempts.size > 1000) attempts.delete(attempts.keys().next().value);
          return json(res, 401, { error: '账号或密码不正确' });
        }
        attempts.delete(key);
        const token = randomBytes(32).toString('hex');
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        sessions.set(token, { username, expires: now + sessionAge });
        return json(res, 200, { ok: true }, { 'Set-Cookie': `workbench_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${config.production ? '; Secure' : ''}` });
      }

      if (session) sessions.delete(session.token);
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
  for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
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
