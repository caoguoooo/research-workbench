import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accountRecord, verifyPassword } from '../auth-store.mjs';
import { createSessionStore, REMEMBER_AGE, SESSION_AGE } from '../session-store.mjs';

test('password creation accepts eight characters and rejects shorter nonempty passwords', () => {
  assert.throws(() => accountRecord('test-user', '1234567'), /8–128/);
  const record = accountRecord('test-user', 'qa8-pass');
  assert.equal(verifyPassword(record, 'qa8-pass'), true);
  assert.throws(() => accountRecord('test-user', ''), /8–128/);
  assert.throws(() => accountRecord('test-user', 'x'.repeat(129)), /8–128/);
});

test('remembered sessions survive restart with hashed tokens, expire and remain revoked after logout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-sessions-'));
  const account = accountRecord('test-user', 'qa8-pass');
  let time = 10000;
  const options = { now: () => time };
  try {
    const store = await createSessionStore(dir, () => account, options);
    const normal = await store.create(account.username);
    const remembered = await store.create(account.username, true);
    assert.deepEqual(store.get(normal), { username: account.username });
    const raw = await readFile(path.join(dir, 'remembered-sessions.json'), 'utf8');
    assert.equal(raw.includes(normal), false);
    assert.equal(raw.includes(remembered), false);
    assert.equal(raw.includes('qa8-pass'), false);
    assert.equal(JSON.parse(raw).sessions.length, 1);
    assert.equal((await stat(path.join(dir, 'remembered-sessions.json'))).mode & 0o777, 0o600);
    const restarted = await createSessionStore(dir, () => account, options);
    assert.equal(restarted.get(normal), null);
    assert.deepEqual(restarted.get(remembered), { username: account.username });
    time += SESSION_AGE;
    assert.equal(store.get(normal), null);
    assert.ok(restarted.get(remembered));
    await restarted.revoke(remembered);
    assert.equal((await createSessionStore(dir, () => account, options)).get(remembered), null);
    const second = await restarted.create(account.username, true);
    time += REMEMBER_AGE;
    assert.equal(restarted.get(second), null);
    await restarted.prune();
    assert.equal(JSON.parse(await readFile(path.join(dir, 'remembered-sessions.json'), 'utf8')).sessions.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('password resets, environment changes and capacity eviction invalidate remembered tokens', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-session-revoke-'));
  let account = accountRecord('test-user', 'qa8-pass');
  try {
    const store = await createSessionStore(dir, () => account, { maxSessions: 2 });
    const old = await store.create(account.username, true);
    await store.create(account.username);
    const newest = await store.create(account.username, true);
    assert.equal(store.get(old), null);
    assert.equal((await createSessionStore(dir, () => account)).get(old), null);
    assert.equal((await createSessionStore(dir, () => account, { realm: 'development' })).get(newest), null);
    account = accountRecord(account.username, 'qa-new88');
    assert.equal(store.get(newest), null);
    assert.equal((await createSessionStore(dir, () => account)).get(newest), null);
    assert.equal(store.get('malformed'), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
