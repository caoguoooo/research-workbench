import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountRecord, saveAccount } from '../auth-store.mjs';
import { createUserStore } from '../user-store.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));

test('registration fixes viewer/pending defaults, enforces uniqueness atomically and persists without leaking credentials', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-users-store-'));
  const primary = accountRecord('root-admin', 'admin888');
  try {
    const users = await createUserStore(dir, () => primary);
    assert.throws(() => users.register('new-user', ''), /8–128/);
    const results = await Promise.allSettled([users.register('New-User', 'reader88'), users.register('new-user', 'reader88')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(users.list().length, 2);
    assert.equal(users.list()[1].role, 'viewer'); assert.equal(users.list()[1].status, 'pending');
    assert.equal(/hash|salt|reader88/.test(JSON.stringify(users.list())), false);
    await assert.rejects(users.register('ROOT-ADMIN', 'reader88'), /已注册/);
    assert.equal((await stat(path.join(dir, 'users.json'))).mode & 0o777, 0o600);
    const restored = await createUserStore(dir, () => primary);
    assert.equal(restored.find('NEW-USER').username, 'New-User');
    await assert.rejects(restored.update('root-admin', { status: 'disabled' }, 'root-admin'), /初始管理员/);
    await assert.rejects(restored.update('New-User', { role: 'owner' }, 'root-admin'), /角色/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function fixture(storage, port) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-users-api-'));
  await saveAccount(dir, accountRecord('root-admin', 'admin888'));
  let child;
  async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: '', WORKBENCH_STORAGE: storage, WORKBENCH_DATA_DIR: dir, WORKBENCH_ALLOW_EMPTY_PASSWORD: 'false', WORKBENCH_HOME_VISUAL: 'false', WORKBENCH_TRUST_PROXY: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`server exit ${code}`))); });
  }
  async function request(route, { method = 'GET', body, cookie, headers = {} } = {}) {
    return fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'X-Workbench-Request': '1', Origin: 'https://demo.example', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function login(username, password) { const response = await request('/api/login', { method: 'POST', body: { username, password, remember: true } }); assert.equal(response.status, 200, await response.text()); return response.headers.get('set-cookie').split(';')[0]; }
  await start();
  return { dir, base: `http://127.0.0.1:${port}`, request, login, start, stop, async close() { await stop(); await rm(dir, { recursive: true, force: true }); } };
}
for (const [index, storage] of ['json', 'sqlite'].entries()) test(`registration → approval → read-only permissions → role/disable/password revocation and restart (${storage})`, async () => {
  const f = await fixture(storage, 39120 + index);
  const register = { username: 'reader-user', password: 'reader88', confirmPassword: 'reader88', role: 'admin', status: 'active' };
  try {
    assert.equal((await f.request('/api/admin/users')).status, 401);
    assert.equal((await f.request('/api/register', { method: 'POST', body: register, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.request('/api/register', { method: 'POST', body: { ...register, confirmPassword: 'wrong888' } })).status, 400);
    const registered = await f.request('/api/register', { method: 'POST', body: register });
    assert.equal(registered.status, 201);
    const signup = await registered.json(); assert.equal(signup.item.role, 'viewer'); assert.equal(signup.item.status, 'pending');
    assert.equal(registered.headers.has('set-cookie'), false);
    assert.equal((await f.request('/api/login', { method: 'POST', body: register })).status, 403);
    assert.equal((await f.request('/api/register', { method: 'POST', body: register })).status, 409);
    const admin = await f.login('root-admin', 'admin888');
    const patch = (body, cookie = admin, username = register.username, headers = {}) => f.request(`/api/admin/users/${username}`, { method: 'PATCH', body, cookie, headers });
    assert.equal((await patch({ status: 'active' }, admin, register.username, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await patch({ status: 'disabled' }, admin, 'root-admin')).status, 403);
    assert.equal((await patch({ role: 'superuser' })).status, 400);
    assert.equal((await patch({ status: 'active' })).status, 200);
    let reader = await f.login('reader-user', 'reader88');
    const status = await (await f.request('/api/status', { cookie: reader })).json(); assert.equal(status.role, 'viewer');
    const created = await f.request('/api/competitors', { method: 'POST', cookie: admin, body: { name: '权限测试楼盘', city: '重庆', district: '两江新区' } });
    assert.equal(created.status, 201); const { item } = await created.json();
    assert.equal((await f.request('/api/competitors', { cookie: reader })).status, 200);
    assert.equal((await f.request('/api/maps/client', { cookie: reader })).status, 200);
    assert.equal((await f.request('/amap-frame', { cookie: reader })).status, 200);
    assert.equal((await f.request('/api/maps/client', { method: 'POST', cookie: reader, body: {} })).status, 403);
    assert.equal((await f.request(`/api/competitors/${item.id}`, { cookie: reader })).status, 200);
    const upload = await fetch(`http://127.0.0.1:${39120 + index}/api/competitors/${item.id}/files?name=permission.txt&category=${encodeURIComponent('其他')}`, { method: 'POST', headers: { Cookie: admin, 'X-Workbench-Request': '1', Origin: 'https://demo.example', 'Content-Type': 'text/plain' }, body: 'read-only attachment' });
    assert.equal(upload.status, 201);
    const withFile = await upload.json();
    const fileId = withFile.file.id;
    const viewed = await f.request(`/api/competitors/${item.id}/files/${fileId}`, { cookie: reader });
    assert.equal(viewed.status, 200); assert.equal(await viewed.text(), 'read-only attachment');

    for (const [method, route] of [
      ['POST','/api/competitors'], ['PATCH',`/api/competitors/${item.id}`], ['DELETE',`/api/competitors/${item.id}`],
      ['PATCH',`/api/competitors/${item.id}/research`], ['PATCH',`/api/competitors/${item.id}/amenities`],
      ['POST',`/api/competitors/${item.id}/files`], ['PUT',`/api/competitors/${item.id}/files/${fileId}`], ['DELETE',`/api/competitors/${item.id}/files/${fileId}`], ['POST',`/api/competitors/${item.id}/floorplans`],
      ['POST',`/api/competitors/${item.id}/visits`], ['POST',`/api/competitors/${item.id}/restore`],
      ['GET','/api/competitors?deleted=true'], ['GET','/api/admin/users'], ['PATCH','/api/admin/users/reader-user'], ['GET','/api/future-private-endpoint'],
      ['GET','/api/settings/maps'], ['PATCH','/api/settings/maps'], ['GET','/api/settings/ai'], ['PATCH','/api/settings/ai'],
      ['GET','/api/research-tasks'], ['POST','/api/research-tasks'], ['POST','/api/maps/search'], ['POST','/api/maps/nearby'], ['POST','/api/maps/refresh'], ['POST','/api/home-visual/refresh'],
      ['GET','/api/ai/conversations'], ['POST','/api/ai/archive'], ['POST','/api/ai/collect'], ['POST','/api/ai/chat']
    ]) assert.equal((await f.request(route, { method, cookie: reader, ...(method !== 'GET' ? { body: {} } : {}) })).status, 403, `${method} ${route}`);
    // A viewer can change their own credentials without affecting the administrator.
    const changed = await f.request('/api/account/password', { method: 'POST', cookie: reader, body: { currentPassword: 'reader88', newPassword: 'changed8', confirmPassword: 'changed8' } }); assert.equal(changed.status, 200);
    assert.equal((await (await f.request('/api/status', { cookie: reader })).json()).authenticated, false);
    reader = await f.login('reader-user', 'changed8');
    assert.equal((await f.request('/api/admin/users', { cookie: admin })).status, 200);
    assert.equal((await patch({ role: 'admin' })).status, 200);
    assert.equal((await (await f.request('/api/status', { cookie: reader })).json()).authenticated, false);
    let promoted = await f.login('reader-user', 'changed8');
    assert.equal((await f.request('/api/admin/users', { cookie: promoted })).status, 200);
    assert.equal((await patch({ role: 'viewer' }, promoted)).status, 403);
    assert.equal((await patch({ status: 'disabled' })).status, 200);
    assert.equal((await f.request('/api/admin/users', { cookie: promoted })).status, 401);
    assert.equal((await f.request('/api/login', { method: 'POST', body: { username: 'reader-user', password: 'changed8' } })).status, 403);
    await patch({ role: 'viewer', status: 'active' });
    assert.equal((await (await f.request('/api/status', { cookie: promoted })).json()).authenticated, false);
    reader = await f.login('reader-user', 'changed8');
    assert.equal((await patch({ password: 'reset888' })).status, 200);
    assert.equal((await (await f.request('/api/status', { cookie: reader })).json()).authenticated, false);
    const renewed = await f.login('reader-user', 'reset888');
    const listed = await (await f.request('/api/admin/users', { cookie: admin })).json();
    assert.equal(/hash|salt|reset888/.test(JSON.stringify(listed)), false);
    const raw = await readFile(path.join(f.dir, 'users.json'), 'utf8'); assert.equal(raw.includes('reset888'), false);
    await f.stop(); await f.start();
    assert.equal((await (await f.request('/api/status', { cookie: renewed })).json()).role, 'viewer');
    assert.equal((await f.request('/api/admin/users', { cookie: renewed })).status, 403);
    assert.equal((await f.request('/api/competitors', { cookie: renewed })).status, 200);
    assert.equal((await f.request('/api/logout', { method: 'POST', cookie: renewed, body: {} })).status, 200);
    assert.equal((await (await f.request('/api/status', { cookie: renewed })).json()).authenticated, false);
  } finally { await f.close(); }
});


for (const [index, storage] of ['json', 'sqlite'].entries()) test(`profiles/avatars persist, own-account permissions and user deletion revoke access (${storage})`, async () => {
  const f = await fixture(storage, 39124 + index);
  const register = { username: 'profile-user', password: 'reader88', confirmPassword: 'reader88' };
  try {
    await f.request('/api/register', { method: 'POST', body: register });
    const admin = await f.login('root-admin', 'admin888');
    const target = '/api/admin/users/profile-user';
    await f.request(target, { method: 'PATCH', cookie: admin, body: { status: 'active' } });
    const reader = await f.login('profile-user', 'reader88');
    const authBefore = await readFile(path.join(f.dir, 'auth.json'), 'utf8');
    assert.equal((await f.request('/api/account/profile')).status, 401);
    assert.equal((await f.request('/api/account/profile', { method: 'PATCH', cookie: reader, body: { nickname: '你好', role: 'admin' } })).status, 400);
    assert.equal((await f.request('/api/account/profile', { method: 'PATCH', cookie: reader, body: { nickname: 'a'.repeat(41) } })).status, 400);
    assert.equal((await f.request('/api/account/profile', { method: 'PATCH', cookie: reader, body: { nickname: '昵称' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.request(target+'/profile', { method: 'PATCH', cookie: reader, body: { nickname: '昵称' } })).status, 403);
    assert.equal((await f.request('/api/admin/users/root-admin/profile', { method: 'PATCH', cookie: reader, body: { nickname: '冒充管理员' } })).status, 403);
    let result = await f.request('/api/account/profile', { method: 'PATCH', cookie: reader, body: { nickname: '  项目研究员  ' } });
    assert.equal(result.status, 200); assert.equal((await result.json()).profile.nickname, '项目研究员');
    assert.equal((await (await f.request('/api/status', { cookie: reader })).json()).nickname, '项目研究员');
    assert.equal((await f.request('/api/competitors', { cookie: reader })).status, 200);
    assert.equal((await f.request('/api/account/profile', { method: 'PATCH', cookie: admin, body: { nickname: '管理员昵称' } })).status, 200);
    assert.equal(await readFile(path.join(f.dir, 'auth.json'), 'utf8'), authBefore);
    const sharp = (await import('sharp')).default;
    const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#246b8d' } }).png().toBuffer();
    const upload = (route, bytes, cookie, extra = {}) => fetch(f.base+route, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://demo.example', 'X-Workbench-Request': '1', 'Content-Type': 'image/png', ...extra }, body: bytes });
    assert.equal((await upload(target+'/avatar', image, reader)).status, 403);
    assert.equal((await upload('/api/account/avatar', image, reader, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    for (const bytes of [Buffer.from('<html>bad</html>'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"/>')]) assert.equal((await upload('/api/account/avatar', bytes, reader)).status, 400);
    assert.equal((await upload('/api/account/avatar', Buffer.alloc(5 * 1024 * 1024 + 1), reader)).status, 413);
    const uploaded = await upload('/api/account/avatar', image, reader); assert.equal(uploaded.status, 200);
    const first = (await uploaded.json()).profile.avatarUrl;
    let response = await f.request(first, { cookie: reader }); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp');
    const decoded = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    assert.equal(decoded.width, 256); assert.equal(decoded.height, 256);
    assert.equal((await f.request(first)).status, 401);
    await f.request(target+'/profile', { method: 'PATCH', cookie: admin, body: { nickname: '更新后的昵称' } });
    const status = await (await f.request('/api/status', { cookie: reader })).json(); assert.equal(status.nickname, '更新后的昵称'); assert.equal(status.avatarUrl, first); assert.equal(status.role, 'viewer');
    await f.stop(); await f.start();
    assert.equal((await (await f.request('/api/status', { cookie: reader })).json()).nickname, '更新后的昵称');
    assert.equal((await f.request(first, { cookie: reader })).status, 200);
    assert.equal((await (await f.request('/api/status', { cookie: admin })).json()).nickname, '管理员昵称');
    assert.equal((await f.request('/api/account/avatar', { method: 'DELETE', cookie: reader })).status, 200);
    assert.equal((await (await f.request('/api/status', { cookie: reader })).json()).avatarUrl, '');
    assert.equal((await f.request('/api/account/profile', { method: 'PATCH', cookie: reader, body: { nickname: '' } })).status, 200);
    assert.equal((await (await f.request('/api/status', { cookie: reader })).json()).nickname, '');
    assert.equal((await upload(target+'/avatar', image, admin)).status, 200);
    const created = await f.request('/api/competitors', { method: 'POST', cookie: admin, body: { name: '用户删除后仍保留的档案' } }); const project = (await created.json()).item;
    assert.equal((await f.request('/api/admin/users/root-admin', { method: 'DELETE', cookie: admin, body: {} })).status, 403);
    assert.equal((await f.request(target, { method: 'DELETE', cookie: reader, body: {} })).status, 403);
    await f.request(target, { method: 'PATCH', cookie: admin, body: { role: 'admin' } });
    const secondAdmin = await f.login('profile-user', 'reader88');
    assert.equal((await f.request(target, { method: 'DELETE', cookie: secondAdmin, body: {} })).status, 403);
    assert.equal((await f.request(target, { method: 'DELETE', cookie: admin, body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.request(target, { method: 'DELETE', cookie: admin, body: {} })).status, 200);
    assert.equal((await (await f.request('/api/admin/users', { cookie: admin })).json()).items.length, 1);
    assert.equal((await (await f.request('/api/status', { cookie: secondAdmin })).json()).authenticated, false);
    assert.equal((await f.request('/api/login', { method: 'POST', body: register })).status, 401);
    assert.equal((await f.request('/api/register', { method: 'POST', body: register })).status, 409);
    assert.equal((await f.request(target+'/profile', { method: 'PATCH', cookie: admin, body: { nickname: 'deleted' } })).status, 404);
    assert.equal((await f.request(first, { cookie: admin })).status, 404);
    assert.equal((await f.request('/api/competitors/'+project.id, { cookie: admin })).status, 200);
    await f.stop(); await f.start();
    assert.equal((await (await f.request('/api/status', { cookie: secondAdmin })).json()).authenticated, false);
    assert.equal((await (await f.request('/api/admin/users', { cookie: admin })).json()).items.length, 1);
  } finally { await f.close(); }
});

for (const [index, storage] of ['json','sqlite'].entries()) test(`last login is admin-only, records successful canonical accounts and survives remembered sessions/restart (${storage})`,async()=>{
  const f=await fixture(storage,39138+index);
  const register={username:'login-reader',password:'reader88',confirmPassword:'reader88'};
  const list=async cookie=>(await(await f.request('/api/admin/users',{cookie})).json()).items;
  try {
    const authBefore=await readFile(path.join(f.dir,'auth.json'),'utf8');
    assert.equal((await f.request('/api/register',{method:'POST',body:register})).status,201);
    assert.equal((await f.request('/api/login',{method:'POST',body:register})).status,403);
    const start=Date.now(),admin=await f.login('ROOT-ADMIN','admin888');
    let records=await list(admin),primary=records.find(user=>user.primary),reader=records.find(user=>user.username===register.username);
    assert.ok(Date.parse(primary.lastLoginAt)>=start && Date.parse(primary.lastLoginAt)<=Date.now());assert.equal(reader.lastLoginAt,null);
    const patch=body=>f.request('/api/admin/users/login-reader',{method:'PATCH',body,cookie:admin});
    assert.equal((await patch({status:'active'})).status,200);
    assert.equal((await f.request('/api/login',{method:'POST',body:{...register,password:'incorrect'}})).status,401);
    assert.equal((await list(admin)).find(user=>user.username===register.username).lastLoginAt,null);
    const viewer=await f.login('LOGIN-READER','reader88');
    const lastLogin=(await list(admin)).find(user=>user.username===register.username).lastLoginAt;
    assert.ok(Number.isFinite(Date.parse(lastLogin)));
    assert.equal((await f.request('/api/admin/users',{cookie:viewer})).status,403);
    assert.equal((await f.request('/api/account/profile',{method:'PATCH',cookie:viewer,body:{nickname:'伪造时间',lastLoginAt:'2000-01-01T00:00:00.000Z'}})).status,400);
    assert.equal((await f.request('/api/account/profile',{method:'PATCH',cookie:viewer,body:{nickname:'用户昵称'}})).status,200);
    assert.equal((await f.request('/api/login',{method:'POST',body:{...register,password:'incorrect'}})).status,401);
    const updated=await patch({status:'disabled'});assert.equal(updated.status,200);assert.equal((await updated.json()).item.lastLoginAt,lastLogin);
    assert.equal((await f.request('/api/login',{method:'POST',body:register})).status,403);
    assert.equal((await list(admin)).find(user=>user.username===register.username).lastLoginAt,lastLogin);
    await patch({status:'active'});
    const remembered=await f.login('login-reader','reader88');
    const beforeRestart=(await list(admin)).find(user=>user.username==='login-reader');
    const diskBefore=await readFile(path.join(f.dir,'user-profiles.json'),'utf8');
    await f.stop();await f.start();
    assert.equal((await(await f.request('/api/status',{cookie:remembered})).json()).authenticated,true);
    records=await list(admin);reader=records.find(user=>user.username==='login-reader');
    assert.equal(reader.lastLoginAt,beforeRestart.lastLoginAt);assert.equal(reader.nickname,'用户昵称');assert.equal((await f.request('/api/account/profile',{cookie:remembered})).status,200);
    assert.equal(await readFile(path.join(f.dir,'user-profiles.json'),'utf8'),diskBefore);
    assert.equal(await readFile(path.join(f.dir,'auth.json'),'utf8'),authBefore);
    assert.equal(/hash|salt|reader88/.test(JSON.stringify(records)),false);
  } finally {await f.close();}
});
