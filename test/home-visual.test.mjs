import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHomeVisualStore, parseDesignboomHomepage } from '../home-visual.mjs';

const html = `<div class=hero--slide data-hero-slide><picture><img src="data:image/svg+xml,placeholder" data-src="https://static.designboom.com/wp-content/uploads/2026/10/one.jpg" width=1800 height=900 alt="First &amp; image"></picture><a href=https://www.designboom.com/architecture/first-story/>First</a></div><article><a href="https://www.designboom.com/design/second-story/"><img src="https://static.designboom.com/wp-content/uploads/2026/10/two.jpg" width="1200" height="800" alt="Second image"></a></article>`;
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6n8AAAAASUVORK5CYII=', 'base64');

test('Designboom homepage extraction handles hero links, lazy images and excludes unsafe sources', () => {
  const items = parseDesignboomHomepage(html + `<article><a href="https://www.designboom.com/art/third-story/"><img src="https://untrusted.example/test.jpg" width=1800 height=900></a></article><script>"<article><img src=x></article>"</script>`);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'First & image');
  assert.equal(items[0].sourceUrl, 'https://www.designboom.com/architecture/first-story/');
  assert.equal(items[1].imageUrl, 'https://static.designboom.com/wp-content/uploads/2026/10/two.jpg');
});

test('Daily image persists, avoids repeated same-day fetches, rotates and retains cache on failure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-visual-'));
  let time = Date.parse('2026-10-08T04:00:00Z'), failing = false;
  const calls = [];
  const options = { now: () => time, random: () => 0, fetchImpl: async url => {
    calls.push(url);
    if (failing) return new Response('unavailable', { status: 503 });
    return new Response(url === 'https://www.designboom.com/' ? html : image);
  } };
  const store = await createHomeVisualStore(root, options);
  t.after(async () => { store.stop(); await rm(root, { recursive: true, force: true }); });
  await Promise.all([store.refresh(), store.refresh()]);
  assert.equal(calls.length, 2);
  const first = store.get().image;
  assert.equal(first.title, 'First & image');
  assert.deepEqual((await store.image()).bytes, image);
  assert.equal((await stat(path.join(root, 'cache/home-visual/current.json'))).mode & 0o777, 0o600);
  const reopened = await createHomeVisualStore(root, options);
  await reopened.refresh();
  assert.deepEqual(reopened.get().image, first);
  assert.equal(calls.length, 2);
  time += 24 * 60 * 60 * 1000;
  await reopened.refresh();
  assert.equal(reopened.get().image.title, 'Second image');
  assert.equal(calls.length, 4);
  const previous = reopened.get().image;
  time += 24 * 60 * 60 * 1000;
  failing = true;
  await reopened.refresh();
  assert.deepEqual(reopened.get().image, previous);
  const count = calls.length;
  const retry = await createHomeVisualStore(root, options);
  await retry.refresh();
  assert.equal(calls.length, count);
  assert.deepEqual(retry.get().image, previous);
});

test('Daily image rejects redirects outside Designboom and unsupported image bytes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-visual-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const redirected = await createHomeVisualStore(root, { fetchImpl: async () => { requests++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }); } });
  await redirected.refresh();
  assert.equal(requests, 2);
  assert.equal(redirected.get().image, null);
  const invalid = await createHomeVisualStore(path.join(root, 'invalid'), { fetchImpl: async url => new Response(url === 'https://www.designboom.com/' ? html : '<script>invalid image</script>') });
  await invalid.refresh();
  assert.equal(invalid.get().image, null);
});

test('public RSS fallback pairs article images with safe sources when homepage markup is unavailable', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-visual-feed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rss = '<rss><item><title>RSS &amp; image</title><link>https://www.designboom.com/architecture/rss-story/</link><content:encoded><![CDATA[<img src="https://static.designboom.com/wp-content/uploads/rss.jpg" width="1200">]]></content:encoded></item></rss>';
  const store = await createHomeVisualStore(root, { fetchImpl: async url => new Response(url.endsWith('/feed/') ? rss : url === 'https://www.designboom.com/' ? '<html>No cards</html>' : image) });
  await store.refresh(); assert.equal(store.get().image.title, 'RSS & image');
  assert.equal(store.get().image.sourceUrl, 'https://www.designboom.com/architecture/rss-story/');
});

test('administrators may force a same-day image rotation with cooldown, while failures keep a diagnosable cache', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-visual-force-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-16T04:00:00Z'), failing = false, calls = 0;
  const store = await createHomeVisualStore(root, { now: () => time, random: () => 0, fetchImpl: async url => { calls++; if (failing) throw new Error('Private network details'); return new Response(url === 'https://www.designboom.com/' ? html : image); } });
  await store.refresh(); time += 1000;
  await store.refresh({ force: true }); assert.equal(store.get().image.title, 'Second image');
  const count = calls; await store.refresh({ force: true }); assert.equal(calls, count);
  time += 60_001; failing = true;
  await store.refresh({ force: true }); assert.equal(store.get().image.title, 'Second image');
  assert.match(store.get().status.error, /保留/); assert.doesNotMatch(store.get().status.error, /Private/);
});
