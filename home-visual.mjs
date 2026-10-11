import { mkdir, readFile, writeFile, rename, access, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const homepage = 'https://www.designboom.com/';
const day = 24 * 60 * 60 * 1000;
const dateKey = time => new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const imageName = /^[a-f0-9]{64}\.(jpg|png|webp)$/;
const entities = value => value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, token => {
  const names = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  if (names[token.toLowerCase()]) return names[token.toLowerCase()];
  const number = Number(token.toLowerCase().startsWith('&#x') ? '0x' + token.slice(3, -1) : token.slice(2, -1));
  return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
});
function externalUrl(value) {
  try {
    const url = new URL(entities(value), homepage);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['www.designboom.com', 'designboom.com', 'static.designboom.com'].includes(url.hostname) ? url : null;
  } catch { return null; }
}
function articleUrl(value) {
  const url = externalUrl(value || '');
  return url && url.hostname !== 'static.designboom.com' && /^\/(architecture|design|art|technology|readers)\/[^/]+\//.test(url.pathname) ? url.href : null;
}
function attributes(text) {
  return Object.fromEntries([...text.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(match => [match[1].toLowerCase(), entities(match[2] ?? match[3] ?? match[4])]));
}

export function parseDesignboomHomepage(html) {
  const groups = [], stack = [];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  html = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of html.matchAll(/<(\/?)([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const tag = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.findLastIndex(node => node.tag === tag);
      if (index >= 0) stack.splice(index);
      continue;
    }
    const attrs = attributes(match[3]);
    let group = stack.at(-1)?.group;
    if (tag === 'article' || /\bdata-hero-slide(?:\s|=|$)/.test(match[3]) || (!group && tag === 'a' && articleUrl(attrs.href))) {
      group = { images: [], links: [] };
      groups.push(group);
    }
    if (group && tag === 'a' && articleUrl(attrs.href)) group.links.push(articleUrl(attrs.href));
    if (group && tag === 'img') {
      const url = externalUrl(attrs['data-src'] || attrs.src || '');
      if (url && url.pathname.startsWith('/wp-content/uploads/') && (!attrs.width || Number(attrs.width) >= 600) && (!attrs.height || Number(attrs.height) >= 250)) group.images.push({ imageUrl: url.href, title: (attrs.alt || 'Designboom 每日配图').slice(0, 200) });
    }
    if (!voidTags.has(tag) && !match[3].trimEnd().endsWith('/')) stack.push({ tag, group });
  }
  const unique = new Map();
  for (const group of groups) if (group.links.length && group.images.length) {
    const image = group.images[0];
    unique.set(image.imageUrl, { ...image, sourceUrl: group.links[0] });
  }
  return [...unique.values()];
}

function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('Unsupported image');
}

export async function createHomeVisualStore(dataRoot, { fetchImpl = fetch, now = Date.now, random = Math.random } = {}) {
  const directory = path.join(dataRoot, 'cache', 'home-visual');
  const manifest = path.join(directory, 'current.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let state = null, attemptedAt = 0, pending = null, timer = null, controller = null;
  try {
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    attemptedAt = Number(saved.attemptedAt) || 0;
    if (saved.image && imageName.test(saved.image.filename) && articleUrl(saved.image.sourceUrl) && /^\d{4}-\d{2}-\d{2}$/.test(saved.image.dateKey)) {
      await access(path.join(directory, saved.image.filename));
      state = saved.image;
    }
  } catch { /* Missing or damaged cache will be refreshed. */ }
  async function persist() {
    await writeFile(manifest + '.tmp', JSON.stringify({ image: state, attemptedAt }), { mode: 0o600 });
    await rename(manifest + '.tmp', manifest);
  }
  async function download(url, limit) {
    for (let redirect = 0; redirect <= 3; redirect++) {
      if (!externalUrl(url)) throw new Error('Invalid source');
      const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), headers: { 'User-Agent': 'caoguoooo-workbench/0.1.6', Accept: 'text/html,image/jpeg,image/png,image/webp' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location');
        await response.body?.cancel();
        if (!next) throw new Error('Invalid redirect');
        url = new URL(next, url).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('Source unavailable'); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) { throw new Error('Source too large'); }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    throw new Error('Too many redirects');
  }
  async function refresh() {
    if (pending) return pending;
    if (state?.dateKey === dateKey(now()) || (attemptedAt && now() - attemptedAt < 60 * 60 * 1000)) return;
    controller = new AbortController();
    pending = (async () => {
      attemptedAt = now();
      try {
        let choices = parseDesignboomHomepage((await download(homepage, 2 * 1024 * 1024)).toString('utf8'));
        const alternatives = choices.filter(item => item.imageUrl !== state?.imageUrl);
        if (alternatives.length) choices = alternatives;
        if (!choices.length) throw new Error('No homepage images');
        const offset = Math.floor(random() * choices.length);
        for (let attempt = 0; attempt < Math.min(3, choices.length); attempt++) {
          try {
            const item = choices[(offset + attempt) % choices.length];
            const bytes = await download(item.imageUrl, 12 * 1024 * 1024);
            const type = imageType(bytes);
            const filename = createHash('sha256').update(bytes).digest('hex') + '.' + type;
            await writeFile(path.join(directory, filename), bytes, { mode: 0o600 });
            const previous = state;
            state = { ...item, filename, updatedAt: new Date(now()).toISOString(), dateKey: dateKey(now()) };
            try { await persist(); } catch (error) { state = previous; throw error; }
            const keep = new Set([filename, previous?.filename]);
            for (const name of await readdir(directory)) if (imageName.test(name) && !keep.has(name)) await rm(path.join(directory, name)).catch(() => {});
            return;
          } catch { if (controller.signal.aborted) break; }
        }
      } catch { /* Keep the previous image when the site or network is unavailable. */ }
      await persist().catch(() => {});
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    refresh,
    get() { return { image: state ? { url: '/api/home-visual/image?v=' + state.filename, title: state.title, sourceUrl: state.sourceUrl, updatedAt: state.updatedAt } : null }; },
    async image() { return state ? { bytes: await readFile(path.join(directory, state.filename)), type: { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[state.filename.split('.').at(-1)] } : null; },
    start() { if (!timer) { void refresh(); timer = setInterval(() => { void refresh(); }, 15 * 60 * 1000); timer.unref(); } },
    stop() { if (timer) clearInterval(timer); timer = null; controller?.abort(); }
  };
}
