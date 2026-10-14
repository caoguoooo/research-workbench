import { createPublicDownloader } from './public-download.mjs';

const api = 'https://commons.wikimedia.org/w/api.php';
const hosts = new Set(['commons.wikimedia.org','upload.wikimedia.org','thumb.wikimedia.org']);
export function sourceURL(value, base) {
  const url = new URL(value,base);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) throw new Error('Only HTTPS Wikimedia Commons sources are allowed');
  return url;
}
const text = value => String(value || '').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim().slice(0,4000);
const parameters = { prop:'imageinfo',iiprop:'url|size|mime|sha1|extmetadata',iiurlwidth:'800' };
function candidate(page) {
  const info = page.imageinfo?.[0];
  if (!info || !['image/jpeg','image/png','image/webp'].includes(info.mime)) return null;
  sourceURL(info.url); sourceURL(info.descriptionurl); sourceURL(info.thumburl || info.url);
  const meta = info.extmetadata || {}, value = key => text(meta[key]?.value);
  let licenseUrl = null;
  try { const url = new URL(value('LicenseUrl')); if (url.protocol === 'https:' && !url.username && !url.password) licenseUrl = url.href; } catch {}
  return { pageId:page.pageid,title:page.title,sourcePage:info.descriptionurl,originalUrl:info.url,previewUrl:info.thumburl || info.url,width:info.width,height:info.height,size:info.size,mime:info.mime,sha1:info.sha1,description:value('ImageDescription'),photographedAt:value('DateTimeOriginal'),author:value('Artist'),license:{ name:value('LicenseShortName') || 'Unknown',url:licenseUrl,usageTerms:value('UsageTerms'),attributionRequired:value('AttributionRequired'),attribution:value('Attribution'),restrictions:value('Restrictions'),credit:value('Credit') } };
}
export function checkOriginal(item, checked, minWidth = 1) {
  if (checked.width !== item.width || checked.height !== item.height || checked.bytes !== item.size || checked.sha1 !== item.sha1) throw new Error('Original does not match Commons dimensions, size or SHA-1');
  if (checked.width < minWidth) throw new Error(`Original width ${checked.width} is below ${minWidth}`);
}
export function createCommonsImages(download = createPublicDownloader()) {
  async function query(options,signal) {
    const url = new URL(api);
    url.search = new URLSearchParams({ action:'query',format:'json',...parameters,...options }).toString();
    const response = await download(url.href,2*1024*1024,signal);
    const data = JSON.parse(response.bytes.toString('utf8'));
    if (data.error) throw new Error(`Commons: ${String(data.error.code).slice(0,80)}`);
    return { data,requestUrl:url.href };
  }
  return {
    async search(term,limit = 4,signal) {
      const { data,requestUrl } = await query({ generator:'search',gsrsearch:term,gsrnamespace:'6',gsrlimit:String(limit) },signal);
      return { candidates:Object.values(data.query?.pages || {}).sort((a,b) => a.index-b.index).map(candidate).filter(Boolean),requestUrl };
    },
    async original(pageId,signal) {
      if (!Number.isSafeInteger(pageId) || pageId < 1) throw new Error('Invalid Commons page ID');
      const { data } = await query({ pageids:String(pageId) },signal);
      const item = candidate(data.query?.pages?.[String(pageId)] || {});
      if (!item) throw new Error('Commons original unavailable');
      return item;
    }
  };
}
