import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { sourceURL, inspectRaster, checkOriginal } from '../scripts/collect-references.mjs';

test('Reference sources restrict every URL and redirect to Wikimedia HTTPS', () => {
  for (const url of ['http://commons.wikimedia.org/', 'https://127.0.0.1/', 'https://example.com/', 'https://commons.wikimedia.org.evil.example/', 'https://user:pass@upload.wikimedia.org/', 'https://commons.wikimedia.org:444/']) assert.throws(() => sourceURL(url));
  assert.equal(sourceURL('/example.jpg', 'https://upload.wikimedia.org/').href, 'https://upload.wikimedia.org/example.jpg');
});

test('References decode actual raster pixels and reject HTML, SVG and false MIME', async () => {
  const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#fff' } }).png().toBuffer();
  const checked = await inspectRaster(png, 'image/png');
  assert.equal(checked.width, 32);
  assert.equal(checked.height, 24);
  assert.equal(checked.fullDecode, true);
  assert.equal(checked.sha256.length, 64);
  await assert.rejects(inspectRaster(png, 'image/jpeg'));
  await assert.rejects(inspectRaster(Buffer.from('<html>Error</html>'), 'image/jpeg'));
  await assert.rejects(inspectRaster(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"/>'), 'image/svg+xml'));
  await assert.rejects(inspectRaster(png.subarray(0, 40), 'image/png'));
});

test('Originals must match source dimensions, byte count and digest, not previews', () => {
  const item = { width: 4000, height: 3000, size: 1024, sha1: 'known-digest' };
  const checked = { width: 4000, height: 3000, bytes: 1024, sha1: 'known-digest' };
  assert.doesNotThrow(() => checkOriginal(item, checked, 1600));
  for (const change of [{ width: 800 }, { height: 600 }, { bytes: 100 }, { sha1: 'wrong' }]) assert.throws(() => checkOriginal(item, { ...checked, ...change }, 1600));
  assert.throws(() => checkOriginal(item, checked, 5000));
});