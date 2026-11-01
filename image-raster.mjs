import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const formats = { jpeg:'image/jpeg',png:'image/png',webp:'image/webp' };
sharp.cache(false);
sharp.concurrency(1);

export async function inspectRaster(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image byte limit');
  const options = { failOn:'warning',limitInputPixels:24_000_000,animated:true };
  const metadata = await sharp(bytes,options).metadata();
  if (!formats[metadata.format] || formats[metadata.format] !== mime || (metadata.pages || 1) !== 1) throw new Error('Unsupported image or MIME mismatch');
  await sharp(bytes,options).raw().toBuffer();
  return { format:metadata.format,width:metadata.width,height:metadata.height,bytes:bytes.length,sha1:createHash('sha1').update(bytes).digest('hex'),sha256:createHash('sha256').update(bytes).digest('hex'),fullDecode:true };
}

export async function imagePreview(bytes) {
  return sharp(bytes,{ failOn:'warning',limitInputPixels:24_000_000 }).rotate().resize({ width:1000,height:800,fit:'inside',withoutEnlargement:true }).jpeg({ quality:85 }).toBuffer();
}

export function createThumbnailCache(directory) {
  const pending = new Map();
  let queue = Promise.resolve();
  return async (filename, info) => {
    if (!info.size || info.size > MAX_IMAGE_BYTES) throw new Error('Image byte limit');
    const key = createHash('sha256').update(JSON.stringify(['v1', filename, info.size, info.mtimeMs])).digest('hex');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const base = await realpath(directory);
    const destination = path.join(base, `${key}.webp`);
    try {
      const cached = await realpath(destination);
      if (!cached.startsWith(base + path.sep) || !(await stat(cached)).isFile()) throw new Error('Invalid thumbnail cache path');
      return cached;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 16) { const error = new Error('缩略图生成繁忙，请稍后重试'); error.status = 429; throw error; }
    const task = queue.then(async () => {
      const temporary = `${destination}.${process.pid}.tmp`;
      try {
        await sharp(filename, { failOn: 'warning', limitInputPixels: 24_000_000 }).rotate().resize({ width: 1000, height: 800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(temporary);
        await rename(temporary, destination);
        return destination;
      } finally { await unlink(temporary).catch(() => {}); }
    });
    pending.set(key, task);
    queue = task.catch(() => {});
    try { return await task; } finally { pending.delete(key); }
  };
}
