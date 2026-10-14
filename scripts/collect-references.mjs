import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicDownloader } from '../public-download.mjs';
import { createCommonsImages, sourceURL, checkOriginal } from '../commons-images.mjs';
import { inspectRaster, imagePreview, MAX_IMAGE_BYTES } from '../image-raster.mjs';

export { sourceURL, checkOriginal, inspectRaster };

const project = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.WORKBENCH_REFERENCES_DIR || path.join(project, 'assets', 'references'));

function createReferenceDownloader() {
  const download = createPublicDownloader({ proxy: process.env.WORKBENCH_IMAGE_PROXY || '' });
  return async (value, limit, signal) => {
    const response = await download(sourceURL(value).href, limit, signal);
    sourceURL(response.url);
    return response;
  };
}

export async function search(term, limit = 4) {
  if (typeof term !== 'string' || !term.trim() || term.length > 300 || !Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('Search needs 1–12 candidates and a query up to 300 characters');
  const download = createReferenceDownloader();
  const response = await createCommonsImages(download).search(term, limit);
  const id = randomUUID();
  const previewDirectory = path.join(directory, '.previews', id);
  await mkdir(previewDirectory, { recursive: true });
  const candidates = [], failures = [];
  for (const item of response.candidates) {
    try {
      if (!Number.isSafeInteger(item.pageId) || item.pageId < 1) throw new Error('Invalid Commons page ID');
      const preview = await download(item.previewUrl, MAX_IMAGE_BYTES);
      const checked = await inspectRaster(preview.bytes, preview.type);
      const previewFile = path.join(previewDirectory, `${item.pageId}.jpg`);
      const bytes = await imagePreview(preview.bytes);
      await writeFile(previewFile, bytes, { flag: 'wx' });
      candidates.push({ ...item, previewFile: path.relative(project, previewFile), previewDimensions: [checked.width, checked.height] });
    } catch (error) { failures.push({ title: item.title, error: error.message }); }
  }
  const manifest = path.join(directory, `search-${id}.json`);
  await writeFile(manifest, JSON.stringify({ provider: 'Wikimedia Commons', searchedAt: new Date().toISOString(), query: term, requestUrl: response.requestUrl, candidates, failures }, null, 2) + '\n', { flag: 'wx' });
  const result = { manifest: path.relative(project, manifest), candidates: candidates.map(({ pageId, title, width, height, license, previewFile }) => ({ pageId, title, width, height, license: license.name, previewFile })), failures };
  console.log(JSON.stringify(result, null, 2));
  if (!candidates.length) throw new Error('No viewable raster candidates; see manifest failures');
  return result;
}

export async function save(manifestPath, pageId, review, minWidth = 1600) {
  if (typeof manifestPath !== 'string' || !manifestPath || !Number.isSafeInteger(pageId) || pageId < 1 || !Number.isInteger(minWidth) || minWidth < 1 || minWidth > 20000 || typeof review !== 'string' || !review.trim() || review.length > 2000) throw new Error('Invalid manifest, candidate ID, minimum width or review');
  const filename = await realpath(path.resolve(project, manifestPath));
  const base = await realpath(directory);
  const relative = path.relative(base, filename);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || path.extname(filename) !== '.json') throw new Error('Manifest must be a small JSON file inside the references directory');
  const info = await stat(filename);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Manifest must be a small JSON file inside the references directory');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  const previous = manifest.candidates?.find(item => item.pageId === pageId);
  if (!previous || !previous.previewFile || manifest.provider !== 'Wikimedia Commons') throw new Error('Candidate is not in the search manifest');
  const download = createReferenceDownloader();
  const item = await createCommonsImages(download).original(pageId);
  if (!item || item.title !== previous.title) throw new Error('Candidate identity changed');
  const original = await download(item.originalUrl, MAX_IMAGE_BYTES);
  const checked = await inspectRaster(original.bytes, original.type);
  checkOriginal(item, checked, minWidth);
  const stem = `commons-${pageId}-${checked.sha256.slice(0, 12)}`;
  const imageFile = path.join(directory, `${stem}.${checked.format === 'jpeg' ? 'jpg' : checked.format}`);
  const recordFile = path.join(directory, `${stem}.json`);
  const record = { ...item, imageFile: path.relative(project, imageFile), downloadedAt: new Date().toISOString(),
    downloadedUrl: original.url, query: manifest.query, searchManifest: path.relative(project, filename),
    review: { notes: review, candidatePreview: previous.previewFile, recordedAt: new Date().toISOString(), automatedVisualReview: false },
    verification: checked, originalBytesPreserved: true };
  await writeFile(imageFile, original.bytes, { flag: 'wx' });
  await writeFile(recordFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  const result = { image: record.imageFile, metadata: path.relative(project, recordFile), sourcePage: item.sourcePage,
    width: checked.width, height: checked.height, license: item.license, verification: checked };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--query', '--limit', '--manifest', '--id', '--review', '--min-width'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid command options');
    options[args[i]] = args[i + 1];
  }
  if (command === 'search' && options['--query']?.trim()) {
    const limit = Number(options['--limit'] || 4);
    await search(options['--query'], limit);
  } else if (command === 'download' && options['--manifest'] && options['--review']?.trim()) {
    const id = Number(options['--id']), minWidth = Number(options['--min-width'] || 1600);
    await save(options['--manifest'], id, options['--review'], minWidth);
  } else {
    throw new Error('Usage: npm run references -- search --query "Chengdu skyline" --limit 4\nThen view previews before: npm run references -- download --manifest assets/references/search-ID.json --id PAGE_ID --review "Actual visual review"');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}