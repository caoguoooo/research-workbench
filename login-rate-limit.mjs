import { isIP } from 'node:net';
import { ArchiveError } from './competitor-store.mjs';

const addressKey = value => String(value || '').replace(/^::ffff:(?=\d+\.)/, '');
const usernameKey = value => String(value || '').normalize('NFKC').toLocaleLowerCase();

export function loginAddress(req, config) {
  const peer = addressKey(req.socket.remoteAddress || 'local');
  const trusted = (config.trustedProxies || []).map(addressKey);
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
  return config.trustProxy && trusted.includes(peer) && isIP(forwarded) ? addressKey(forwarded) : peer;
}

export function createLoginLimiter({ now = Date.now } = {}) {
  const pairs = new Map(), accounts = new Map();
  let traffic = { count: 0, until: 0 };
  const current = (map, key) => {
    const item = map.get(key);
    return item && item.until > now() ? item : { count: 0, until: now() + 15 * 60_000 };
  };
  return {
    check(req, username, knownAccount, config, countTraffic = true) {
      if (countTraffic) {
        if (traffic.until <= now()) traffic = { count: 0, until: now() + 60_000 };
        if (++traffic.count > 120) throw new ArchiveError('登录请求过于频繁，请稍后再试', 429);
      }
      const account = usernameKey(username), pair = JSON.stringify([loginAddress(req, config), account]);
      if (current(pairs, pair).count >= 10 || knownAccount && current(accounts, account).count >= 30) throw new ArchiveError('此账号尝试次数过多，请稍后再试', 429);
      return { pair, account };
    },
    fail(ticket, knownAccount) {
      const item = current(pairs, ticket.pair); item.count++; pairs.set(ticket.pair, item);
      if (pairs.size > 10_000) pairs.delete(pairs.keys().next().value);
      // Only real accounts occupy this map, independently of pair-cache eviction.
      if (knownAccount) { const item = current(accounts, ticket.account); item.count++; accounts.set(ticket.account, item); }
    },
    success(ticket) { pairs.delete(ticket.pair); accounts.delete(ticket.account); },
    prune() { for (const map of [pairs, accounts]) for (const [key, item] of map) if (item.until <= now()) map.delete(key); }
  };
}
