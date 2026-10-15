import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createUserProfileStore } from '../user-profile-store.mjs';
import { displayName } from '../profile.js';

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
