'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { isProhibitedIp, validateFeedUrl } = require('../../lib/ssrf');

test('ssrf: rejects prohibited IPv4, IPv6, IPv4-mapped IPv6, and internal hostnames', async () => {
  const prohibitedIps = [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.5',
    '::ffff:7f00:1',
  ];

  for (const ip of prohibitedIps) {
    assert.equal(isProhibitedIp(ip), true, `Expected ${ip} to be prohibited`);
  }

  // Public IPs allowed
  assert.equal(isProhibitedIp('151.101.1.140'), false);
  assert.equal(isProhibitedIp('2606:4700:4700::1111'), false);

  const blockedUrls = [
    'http://www.reddit.com/r/forhire/.rss',
    'https://localhost/feed.rss',
    'https://sub.localhost/feed.rss',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://service.internal/rss',
    'https://printer.local/rss',
    'https://127.0.0.1/rss',
    'https://[::1]/rss',
    'https://[::ffff:127.0.0.1]/rss',
    'https://0x7f000001/rss',
    'https://2130706433/rss',
    'https://user:pass@www.reddit.com/r/forhire/.rss',
  ];

  for (const u of blockedUrls) {
    const res = await validateFeedUrl(u, { lookup: async () => [{ address: '151.101.1.140' }] });
    assert.equal(res.valid, false, `Expected URL to be blocked: ${u}`);
  }
});

test('ssrf: rejects hostnames resolving via DNS to private/mapped IPs and accepts legitimate public feeds', async () => {
  const rebindRes = await validateFeedUrl('https://evil-dns.example/feed.rss', {
    lookup: async () => [{ address: '151.101.1.140' }, { address: '10.20.30.40' }],
  });
  assert.equal(rebindRes.valid, false);

  const mappedRes = await validateFeedUrl('https://mapped.example/feed.rss', {
    lookup: async () => [{ address: '::ffff:192.168.1.50' }],
  });
  assert.equal(mappedRes.valid, false);

  const okRes = await validateFeedUrl('https://www.reddit.com/r/forhire/.rss', {
    lookup: async () => [{ address: '151.101.1.140' }, { address: '151.101.65.140' }],
  });
  assert.equal(okRes.valid, true);
  assert.deepEqual(okRes.addresses, ['151.101.1.140', '151.101.65.140']);
});

test('ssrf: NODE_ENV=production never permits allowPrivateForTest bypass', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await validateFeedUrl('http://127.0.0.1:3000/r/test/.rss', {
      allowPrivateForTest: true,
    });
    assert.equal(res.valid, false);
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  }
});
