'use strict';

/**
 * lib/ssrf.js — SONARS Outbound Feed URL & DNS SSRF Protection
 * ───────────────────────────────────────────────────────────────
 * Blocks:
 *   • non-HTTPS schemes (test-only opt-in disabled in production)
 *   • embedded credentials (user:pass@host)
 *   • localhost / *.localhost / *.local / *.internal / metadata hosts
 *   • RFC1918, loopback, link-local, CGNAT, multicast, unspecified, reserved IPv4
 *   • IPv6 loopback, ULA (fc00::/7), link-local (fe80::/10), multicast (ff00::/8),
 *     unspecified (::), NAT64, 6to4, and IPv4-mapped IPv6 (::ffff:...)
 *   • public hostnames whose DNS records resolve to any prohibited IP
 */

const dns = require('dns');
const net = require('net');

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'ip6-localhost',
  'ip6-loopback',
]);

function ipv4ToUint32(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let val = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    val = (val * 256) + n;
  }
  return val >>> 0;
}

function isProhibitedIpv4(ip) {
  const n = ipv4ToUint32(ip);
  if (n === null) return true;
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8)  & 0xff;

  if (a === 0) return true;                                  // 0.0.0.0/8 unspecified
  if (a === 10) return true;                                 // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true;         // 100.64.0.0/10 CGNAT
  if (a === 127) return true;                                // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;                   // 169.254.0.0/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && c === 0) return true;          // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return true;          // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true;                   // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true;      // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true;       // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;        // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true;                                 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast

  return false;
}

function parseIpv6Groups(rawIp) {
  let ip = rawIp.toLowerCase();
  if (ip.includes('%')) return null; // Zone IDs (e.g. %eth0) are always link/local scoped

  // Handle trailing IPv4 in mapped forms like ::ffff:127.0.0.1
  const lastColon = ip.lastIndexOf(':');
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes('.')) {
    const v4Part = ip.slice(lastColon + 1);
    const u32 = ipv4ToUint32(v4Part);
    if (u32 === null) return null;
    const hi = ((u32 >>> 16) & 0xffff).toString(16);
    const lo = (u32 & 0xffff).toString(16);
    ip = `${ip.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const dbl = ip.split('::');
  if (dbl.length > 2) return null;

  const left = dbl[0] ? dbl[0].split(':') : [];
  const right = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (dbl.length === 1 && missing !== 0) return null;
  if (dbl.length === 2 && missing < 1) return null;

  const full = [
    ...left,
    ...Array(Math.max(0, missing)).fill('0'),
    ...right,
  ];
  if (full.length !== 8) return null;

  const groups = [];
  for (const hex of full) {
    if (!/^[0-9a-f]{1,4}$/.test(hex)) return null;
    groups.push(parseInt(hex, 16));
  }
  return groups;
}

function groupsToIpv4(gHi, gLo) {
  return `${(gHi >>> 8) & 0xff}.${gHi & 0xff}.${(gLo >>> 8) & 0xff}.${gLo & 0xff}`;
}

function isProhibitedIpv6(ip) {
  const g = parseIpv6Groups(ip);
  if (!g) return true;

  const allZero = g.every(x => x === 0);
  if (allZero) return true;                                                 // ::/128 unspecified
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;         // ::1/128 loopback

  // IPv4-mapped ::ffff:0:0/96
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return isProhibitedIpv4(groupsToIpv4(g[6], g[7]));
  }
  // IPv4-compatible ::/96
  if (g.slice(0, 6).every(x => x === 0)) {
    return isProhibitedIpv4(groupsToIpv4(g[6], g[7]));
  }
  // NAT64 64:ff9b::/96 & 64:ff9b:1::/48
  if (g[0] === 0x0064 && g[1] === 0xff9b) {
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isProhibitedIpv4(groupsToIpv4(g[6], g[7]));
    }
    return true;
  }
  // 6to4 2002::/16
  if (g[0] === 0x2002) {
    return isProhibitedIpv4(groupsToIpv4(g[1], g[2]));
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true;  // fc00::/7 Unique Local (ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return true;  // fe80::/10 Link-Local
  if ((g[0] & 0xffc0) === 0xfec0) return true;  // fec0::/10 Site-Local
  if ((g[0] & 0xff00) === 0xff00) return true;  // ff00::/8 Multicast
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation

  return false;
}

function isProhibitedIp(addr) {
  const clean = String(addr || '').trim().replace(/^\[|\]$/g, '');
  const ver = net.isIP(clean);
  if (ver === 4) return isProhibitedIpv4(clean);
  if (ver === 6) return isProhibitedIpv6(clean);
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localdomain')
  ) {
    return true;
  }
  // Reject non-dotted integer / hex IP representations such as 0x7f000001 or 2130706433
  if (/^(0x[0-9a-f]+|\d+|0[0-7]+)$/i.test(host)) {
    return true;
  }
  return false;
}

function stripBrackets(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '');
}

async function defaultLookup(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

async function validateFeedUrl(rawUrl, options = {}) {
  const isProd = process.env.NODE_ENV === 'production';
  const allowPrivateForTest = !isProd && options.allowPrivateForTest === true;
  const lookup = typeof options.lookup === 'function' ? options.lookup : defaultLookup;

  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    return { valid: false, error: 'Malformed URL' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Feed URL must not contain embedded credentials' };
  }

  if (parsed.protocol !== 'https:' && !(allowPrivateForTest && parsed.protocol === 'http:')) {
    return { valid: false, error: 'Feed URL must use https://' };
  }

  const host = stripBrackets(parsed.hostname);
  if (!host) {
    return { valid: false, error: 'Feed URL missing hostname' };
  }

  if (allowPrivateForTest) {
    return { valid: true, url: parsed.toString(), addresses: [] };
  }

  if (isBlockedHostname(host)) {
    return { valid: false, error: `Disallowed internal hostname: ${host}` };
  }

  const ipVer = net.isIP(host);
  if (ipVer !== 0) {
    if (isProhibitedIp(host)) {
      return { valid: false, error: `Disallowed private or reserved IP address: ${host}` };
    }
    return { valid: true, url: parsed.toString(), addresses: [host] };
  }

  let records;
  try {
    records = await lookup(host);
  } catch {
    return { valid: false, error: `Unable to resolve feed hostname: ${host}` };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return { valid: false, error: `Feed hostname resolved no addresses: ${host}` };
  }

  const addresses = [];
  for (const rec of records) {
    const addr = typeof rec === 'string' ? rec : rec && rec.address;
    if (!addr || isProhibitedIp(addr)) {
      return {
        valid: false,
        error: `Feed hostname resolved to prohibited address (${addr || 'unknown'})`,
      };
    }
    addresses.push(addr);
  }

  return { valid: true, url: parsed.toString(), addresses };
}

module.exports = {
  isProhibitedIpv4,
  isProhibitedIpv6,
  isProhibitedIp,
  isBlockedHostname,
  validateFeedUrl,
};
