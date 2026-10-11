/* Unit tests for electron/update-check.js (no network, no browser). */
'use strict';
const assert = require('assert');
const {
  checkForUpdate, compareVersions, githubRepoFromPackage, githubRepoFromUpdateConfig, UpdateCheckError
} = require('../electron/update-check.js');

function fakeResponse(status, body, headers) {
  const h = new Map(Object.entries(headers || {}));
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: k => (h.has(k) ? h.get(k) : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  };
}
const release = (tag, assets) => ({
  tag_name: tag, html_url: 'https://github.com/o/r/releases/tag/' + tag,
  published_at: '2026-05-25T20:10:06Z',
  assets: (assets || []).map(n => ({ name: n, browser_download_url: 'https://example/' + n }))
});
const opts = (fetch, extra) => Object.assign(
  { owner: 'o', repo: 'r', currentVersion: '1.0.45', platform: 'linux', fetch }, extra || {});

async function expectCode(promise, code) {
  try { await promise; } catch (e) {
    assert.ok(e instanceof UpdateCheckError, 'expected UpdateCheckError, got ' + e);
    assert.strictEqual(e.code, code, e.message);
    return e;
  }
  assert.fail('expected rejection with ' + code);
}

const tests = {
  'compareVersions orders release and prerelease versions'() {
    assert.strictEqual(compareVersions('1.0.45', 'v1.0.46'), -1);
    assert.strictEqual(compareVersions('1.0.45', '1.0.45'), 0);
    assert.strictEqual(compareVersions('1.1.0', '1.0.99'), 1);
    assert.strictEqual(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
    assert.strictEqual(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
    assert.strictEqual(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.strictEqual(compareVersions('2', '1.9.9'), 1);
    assert.strictEqual(compareVersions('garbage', '1.0.0'), null);
  },
  'githubRepoFromPackage reads build.publish'() {
    assert.deepStrictEqual(githubRepoFromPackage(require('../package.json')),
      { owner: 'helliott20', repo: 'opentoon' });
    assert.strictEqual(githubRepoFromPackage({ build: {} }), null);
  },
  'githubRepoFromUpdateConfig reads app-update.yml'() {
    assert.deepStrictEqual(githubRepoFromUpdateConfig(
      'owner: helliott20\nrepo: opentoon\nprovider: github\nreleaseType: release\nupdaterCacheDirName: opentoon-updater\n'),
      { owner: 'helliott20', repo: 'opentoon' });
    assert.deepStrictEqual(githubRepoFromUpdateConfig("provider: 'github'\nowner: \"a\"\nrepo: b # comment\n"),
      { owner: 'a', repo: 'b' });
    assert.strictEqual(githubRepoFromUpdateConfig('provider: generic\nurl: https://x\n'), null);
    assert.strictEqual(githubRepoFromUpdateConfig(''), null);
  },
  async 'newer release with Linux build + feed'() {
    const r = await checkForUpdate(opts(async () => fakeResponse(200,
      release('v1.0.46', ['OpenToon-Studio-1.0.46.AppImage', 'latest-linux.yml', 'latest.yml']))));
    assert.strictEqual(r.status, 'update-available');
    assert.strictEqual(r.latest, '1.0.46');
    assert.strictEqual(r.download.name, 'OpenToon-Studio-1.0.46.AppImage');
    assert.strictEqual(r.feed, true);
  },
  async 'newer Windows-only release reports no Linux build'() {
    const r = await checkForUpdate(opts(async () => fakeResponse(200,
      release('v1.0.46', ['OpenToon Studio Setup 1.0.46.exe', 'latest.yml']))));
    assert.strictEqual(r.status, 'update-available');
    assert.strictEqual(r.download, null);
    assert.strictEqual(r.feed, false);
    const w = await checkForUpdate(opts(async () => fakeResponse(200,
      release('v1.0.46', ['OpenToon Studio Setup 1.0.46.exe', 'latest.yml'])), { platform: 'win32' }));
    assert.strictEqual(w.feed, true);
  },
  async 'same and older releases'() {
    const same = await checkForUpdate(opts(async () => fakeResponse(200, release('v1.0.45'))));
    assert.strictEqual(same.status, 'up-to-date');
    const older = await checkForUpdate(opts(async () => fakeResponse(200, release('v1.0.40'))));
    assert.strictEqual(older.status, 'newer-than-release');
  },
  async 'sends a User-Agent and optional token'() {
    let seen;
    await checkForUpdate(opts(async (url, init) => { seen = { url, init }; return fakeResponse(200, release('v1.0.45')); },
      { token: 'abc' }));
    assert.strictEqual(seen.url, 'https://api.github.com/repos/o/r/releases/latest');
    assert.ok(seen.init.headers['User-Agent']);
    assert.strictEqual(seen.init.headers.Authorization, 'Bearer abc');
  },
  async 'no releases -> not-found'() {
    await expectCode(checkForUpdate(opts(async () => fakeResponse(404, {}))), 'not-found');
  },
  async 'rate limit -> rate-limited with reset time'() {
    const e = await expectCode(checkForUpdate(opts(async () => fakeResponse(403, {},
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }))), 'rate-limited');
    assert.strictEqual(e.resetAt, 1800000000 * 1000);
    assert.match(e.message, /GITHUB_TOKEN/);
  },
  async 'server error -> http'() {
    await expectCode(checkForUpdate(opts(async () => fakeResponse(502, {}))), 'http');
  },
  async 'invalid JSON or missing tag -> bad-response'() {
    await expectCode(checkForUpdate(opts(async () => fakeResponse(200, '{nope'))), 'bad-response');
    await expectCode(checkForUpdate(opts(async () => fakeResponse(200, { name: 'x' }))), 'bad-response');
  },
  async 'DNS failure -> offline'() {
    await expectCode(checkForUpdate(opts(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.github.com' } });
    })), 'offline');
  },
  async 'slow server -> timeout'() {
    await expectCode(checkForUpdate(opts((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }), { timeoutMs: 50 })), 'timeout');
  }
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
  }
  console.log('\n' + (Object.keys(tests).length - failed) + '/' + Object.keys(tests).length + ' update-check tests passed');
  process.exitCode = failed ? 1 : 0;
})();
