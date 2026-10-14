import sharp from 'sharp';
import { createHash } from 'node:crypto';

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
