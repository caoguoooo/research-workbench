import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['192.88.99.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(address,prefix,'ipv4');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::',3,'ipv6');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(address,prefix,'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address,'ipv4') : family === 6 && publicV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}

export function publicURL(value, base) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw new Error('Invalid URL');
  const url = new URL(value,base);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname.replace(/^\[|\]$/g,'')) || !url.hostname.includes('.')) throw new Error('Invalid source');
  url.hash = '';
  return url;
}

export function proxyURL(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('WORKBENCH_IMAGE_PROXY must be an HTTP(S) proxy without credentials or path');
  return url;
}

function tunnelAgent(proxy, address, hostname, signal) {
  const agent = new https.Agent({ keepAlive:false,maxSockets:1 });
  agent.createConnection = (_options,callback) => {
    const host = address.family === 6 ? `[${address.address}]:443` : `${address.address}:443`;
    const req = (proxy.protocol === 'https:' ? https : http).request(proxy,{
      method:'CONNECT',path:host,agent:false,signal,headers:{ Host:host }
    });
    let socket, finished = false;
    const finish = (error,connection) => {
      if (finished) return;
      finished = true;
      if (error) { socket?.destroy(); req.destroy(); }
      callback(error,connection);
    };
    req.once('error',error => finish(error));
    req.once('response',res => { res.destroy(); finish(new Error('Proxy refused tunnel')); });
    req.once('connect',(res,connection,head) => {
      socket = connection;
      if (signal.aborted || res.statusCode !== 200 || head.length) return finish(new Error('Proxy refused tunnel'));
      const abort = () => { socket.destroy(); finish(signal.reason); };
      signal.addEventListener('abort',abort,{ once:true });
      socket = tls.connect({ socket,servername:hostname,rejectUnauthorized:true,ALPNProtocols:['http/1.1'] });
      socket.once('error',error => finish(error));
      socket.once('close',() => signal.removeEventListener('abort',abort));
      socket.once('secureConnect',() => finish(null,socket));
    });
    req.end();
  };
  return agent;
}

export function createPublicDownloader({ lookupImpl = lookup, requestImpl = https.request, proxy = process.env.WORKBENCH_IMAGE_PROXY || '' } = {}) {
  const outboundProxy = proxyURL(proxy);
  return async function download(value, limit, signal) {
    let url = publicURL(value);
    const timeout = AbortSignal.timeout(60_000);
    const active = signal ? AbortSignal.any([signal,timeout]) : timeout;
    for (let redirects = 0; redirects <= 3; redirects++) {
      active.throwIfAborted();
      let fail;
      const aborted = new Promise((_,reject) => { fail = () => reject(active.reason); active.addEventListener('abort',fail,{ once:true }); });
      let addresses;
      try { addresses = await Promise.race([lookupImpl(url.hostname,{ all:true,verbatim:true }),aborted]); }
      finally { active.removeEventListener('abort',fail); }
      active.throwIfAborted();
      if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Private source');
      const address = addresses[0];
      const agent = outboundProxy ? tunnelAgent(outboundProxy,address,url.hostname,active) : false;
      let result;
      try {
        result = await new Promise((resolve,reject) => {
          const req = requestImpl(url,{
            method:'GET',agent,signal:active,
            headers:{ 'User-Agent':'ResearchWorkbenchReferences/1.0 (local research; Wikimedia Commons API)',Accept:'application/json,text/html,image/jpeg,image/png,image/webp' },
            lookup:(_hostname,options,callback) => callback(null,options.all ? [address] : address.address,address.family)
          },res => {
            if ([301,302,303,307,308].includes(res.statusCode)) {
              const location = res.headers.location; res.destroy(); resolve({ location }); return;
            }
            if (res.statusCode !== 200 || (res.headers['content-length'] && Number(res.headers['content-length']) > limit)) {
              res.destroy(); reject(new Error(`Source HTTP ${res.statusCode} or byte limit exceeded`)); return;
            }
            const chunks = []; let size = 0;
            res.on('data',chunk => {
              size += chunk.length;
              if (size > limit) { res.destroy(new Error('Source too large')); return; }
              chunks.push(chunk);
            });
            res.once('error',reject);
            res.once('aborted',() => reject(new Error('Source interrupted')));
            res.once('end',() => resolve({ bytes:Buffer.concat(chunks),type:String(res.headers['content-type'] || '').split(';')[0].toLowerCase() }));
          });
          req.once('error',reject); req.end();
        });
      } finally { if (agent) agent.destroy(); }
      if (result.bytes) return { ...result,url:url.href };
      if (!result.location) throw new Error('Invalid redirect');
      url = publicURL(result.location,url);
    }
    throw new Error('Too many redirects');
  };
}
