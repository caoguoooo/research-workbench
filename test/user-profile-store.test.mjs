import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createUserProfileStore } from '../user-profile-store.mjs';
import { displayName } from '../profile.js';
import { lastLoginPresentation } from '../users.js';

test('last login labels use relative Chinese time and exact Beijing timestamps without inventing missing history', () => {
  const now = Date.parse('2026-11-13T00:00:00.000Z');
  const label = seconds => lastLoginPresentation(new Date(now - seconds * 1000).toISOString(), now).text;
  for (const value of [null,undefined,'not-a-date','']) assert.equal(lastLoginPresentation(value,now).text,'暂无登录记录');
  for (const [seconds,expected] of [[0,'刚刚'],[59,'刚刚'],[60,'1分钟前'],[180,'3分钟前'],[3600,'1小时前'],[10800,'3小时前'],[86400,'1天前'],[90*86400,'3个月前'],[365*86400,'1年前']]) assert.equal(label(seconds),expected);
  const info=lastLoginPresentation('2026-11-13T00:00:00.000Z',now);
  assert.match(info.title,/2026.*11.*13.*08:00:00.*北京时间/); assert.equal(info.dateTime,'2026-11-13T00:00:00.000Z');
  assert.equal(lastLoginPresentation('2026-11-13T00:01:00.000Z',now).text,'刚刚');
});

test('login timestamps survive profile edits, avatar changes and reopening without losing concurrent updates', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'workbench-login-profile-'));
  let clock=Date.parse('2026-11-13T00:00:00.000Z');
  try {
    let store=await createUserProfileStore(directory,{now:()=>clock});
    assert.equal(store.lastLoginAt('admin'),null);
    await Promise.all([store.recordLogin('admin'),store.update('admin',{nickname:'昵称'})]);
    const first=store.lastLoginAt('admin'); assert.equal(first,new Date(clock).toISOString()); assert.equal(store.get('admin').nickname,'昵称');
    const bytes=await sharp({create:{width:100,height:100,channels:3,background:'#618181'}}).png().toBuffer();
    clock+=60_000; await Promise.all([store.upload('admin',bytes),store.recordLogin('admin')]);
    const current=store.lastLoginAt('admin');assert.notEqual(current,first); assert.ok(store.get('admin').avatarUrl);
    clock-=120_000; await store.recordLogin('admin'); assert.equal(store.lastLoginAt('admin'),current);
    store=await createUserProfileStore(directory);assert.equal(store.lastLoginAt('admin'),current);
    await store.clearAvatar('admin');assert.equal(store.lastLoginAt('admin'),current);
    assert.throws(()=>store.update('admin',{nickname:'昵称',lastLoginAt:first}),/昵称/);
    await store.remove('admin');assert.equal(store.lastLoginAt('admin'),null);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('display name uses nickname, falls back to login name when empty', () => {
  assert.equal(displayName({ username: 'admin', nickname: ' 管理员昵称 ' }), '管理员昵称');
  assert.equal(displayName({ username: 'admin', nickname: ' ' }), 'admin');
  assert.equal(displayName({ username: 'admin' }), 'admin');
});

test('profiles and decoded avatars persist independently, replacements clean old files and preserve concurrent nickname changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-profiles-'));
  try {
    const store = await createUserProfileStore(directory);
    assert.deepEqual(store.get('admin'), { nickname: '', avatarUrl: '' });
    assert.throws(() => store.update('admin', { nickname: 'line\nbreak' }), /昵称/);
    assert.throws(() => store.update('admin', { nickname: '名字', avatar: '../../secret' }), /昵称/);
    const bytes = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#21577a' } }).jpeg().withMetadata().toBuffer();
    await Promise.all([store.upload('admin', bytes), store.update('admin', { nickname: '<img onerror=alert(1)>' })]);
    const first = store.get('admin'); assert.equal(first.nickname, '<img onerror=alert(1)>'); assert.match(first.avatarUrl, /^\/api\/users\/admin\/avatar\?v=/);
    assert.equal((await readdir(path.join(directory, 'user-avatars'))).length, 1);
    const metadata = await sharp(await store.image('admin')).metadata(); assert.equal(metadata.exif, undefined); assert.equal(metadata.width, 256); assert.equal(metadata.format, 'webp');
    const restored = await createUserProfileStore(directory); assert.deepEqual(restored.get('admin'), first);
    await restored.upload('admin', bytes); assert.notEqual(restored.get('admin').avatarUrl, first.avatarUrl);
    assert.equal((await readdir(path.join(directory, 'user-avatars'))).length, 1);
    const filename = (await readdir(path.join(directory, 'user-avatars')))[0];
    assert.equal((await stat(path.join(directory, 'user-avatars', filename))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(directory, 'user-profiles.json'))).mode & 0o777, 0o600);
    const before = await readFile(path.join(directory, 'user-profiles.json'), 'utf8');
    await assert.rejects(restored.upload('admin', bytes.subarray(0, bytes.length / 2)), /完整/);
    assert.equal(await readFile(path.join(directory, 'user-profiles.json'), 'utf8'), before);
    await restored.clearAvatar('admin'); assert.equal(restored.get('admin').avatarUrl, ''); assert.equal(restored.get('admin').nickname, first.nickname);
    await restored.remove('admin'); assert.deepEqual(restored.get('admin'), { nickname: '', avatarUrl: '' });
    assert.equal((await readdir(path.join(directory, 'user-avatars'))).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
