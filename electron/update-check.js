/* OpenToon Studio - read-only "is there a newer release?" check.
 *
 * Queries the GitHub Releases API for the latest published release and
 * compares it with the running version. It never downloads or installs
 * anything. Shared by the Electron main process (approval-based update flow)
 * and tools/check-update.cjs (command-line check). Plain Node, no deps:
 * needs a global fetch (Node 18+ / Electron 28+). */
'use strict';

// Release assets that are a usable download / self-update feed per platform.
const PLATFORM_ASSETS = {
  win32: { download: /\.exe$/i, feed: /^latest\.yml$/i },
  darwin: { download: /\.(dmg|zip)$/i, feed: /^latest-mac\.yml$/i },
  linux: { download: /\.(AppImage|deb|rpm|tar\.gz)$/i, feed: /^latest-linux\.yml$/i }
};

class UpdateCheckError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'UpdateCheckError';
    this.code = code;               // offline | timeout | rate-limited | not-found | http | bad-response
    Object.assign(this, extra || {});
  }
}

// "1.2.3", "v1.2.3", "1.2.3-beta.1" -> { nums: [1,2,3], pre: 'beta.1' }
function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [+m[1], +(m[2] || 0), +(m[3] || 0)], pre: m[4] || '' };
}

// semver precedence: -1 if a < b, 0 if equal, 1 if a > b (null if unparsable)
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;            // 1.0.0 > 1.0.0-rc.1
  if (!pb.pre) return -1;
  const xa = pa.pre.split('.'), xb = pb.pre.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb && +xa[i] !== +xb[i]) return +xa[i] < +xb[i] ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

// owner/repo from package.json build.publish (github provider)
function githubRepoFromPackage(pkg) {
  const pub = pkg && pkg.build && pkg.build.publish;
  const list = Array.isArray(pub) ? pub : (pub ? [pub] : []);
  const gh = list.find(p => p && p.provider === 'github' && p.owner && p.repo);
  return gh ? { owner: gh.owner, repo: gh.repo } : null;
}

// owner/repo from electron-builder's resources/app-update.yml. Packaged builds
// need this: electron-builder strips the "build" field from package.json.
function githubRepoFromUpdateConfig(text) {
  const get = key => {
    const m = new RegExp('^' + key + ':\\s*["\']?([^"\'\\s#]+)', 'm').exec(String(text || ''));
    return m ? m[1] : null;
  };
  const provider = get('provider'), owner = get('owner'), repo = get('repo');
  return provider === 'github' && owner && repo ? { owner, repo } : null;
}

function networkErrorCode(err) {
  const c = (err && (err.code || (err.cause && err.cause.code))) || '';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH/.test(c)) return 'offline';
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(c)) return 'timeout';
  return 'offline';
}

async function fetchLatestRelease(opts) {
  const { owner, repo } = opts;
  const timeoutMs = opts.timeoutMs || 15000;
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function')
    throw new UpdateCheckError('bad-response', 'No fetch() available in this runtime.');
  const url = 'https://api.github.com/repos/' + owner + '/' + repo + '/releases/latest';
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OpenToon-Studio-update-check',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: ctrl.signal });
  } catch (err) {
    if (err && err.name === 'AbortError')
      throw new UpdateCheckError('timeout', 'GitHub did not answer within ' + Math.round(timeoutMs / 1000) + ' s.');
    const code = networkErrorCode(err);
    throw new UpdateCheckError(code, (code === 'timeout' ? 'Connection to GitHub timed out' :
      'Could not reach GitHub (offline or DNS failure)') +
      ': ' + ((err && err.cause && err.cause.message) || (err && err.message) || err));
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404)
    throw new UpdateCheckError('not-found', 'No published release found for ' + owner + '/' + repo + '.');
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset')) || 0;
    if (remaining === '0' || res.status === 429) {
      const when = reset ? new Date(reset * 1000).toISOString() : 'later';
      throw new UpdateCheckError('rate-limited',
        'GitHub API rate limit reached; try again after ' + when + ' (or set GITHUB_TOKEN).',
        { resetAt: reset ? reset * 1000 : null });
    }
  }
  if (!res.ok)
    throw new UpdateCheckError('http', 'GitHub returned HTTP ' + res.status + ' for ' + url + '.', { status: res.status });

  let data;
  try { data = await res.json(); }
  catch (e) { throw new UpdateCheckError('bad-response', 'GitHub returned invalid JSON.'); }
  if (!data || typeof data.tag_name !== 'string')
    throw new UpdateCheckError('bad-response', 'GitHub release data has no tag_name.');
  return data;
}

/* Check for a newer release. Resolves with
 *   { status: 'update-available' | 'up-to-date' | 'newer-than-release',
 *     current, latest, tag, url, publishedAt, platform,
 *     download: {name,url}|null,  // a release asset usable on this platform
 *     feed: boolean }             // electron-updater feed for this platform
 * Rejects with UpdateCheckError on any failure. */
async function checkForUpdate(opts) {
  const platform = opts.platform || process.platform;
  const rel = await fetchLatestRelease(opts);
  const latest = rel.tag_name.replace(/^v/i, '');
  const cmp = compareVersions(opts.currentVersion, latest);
  if (cmp === null)
    throw new UpdateCheckError('bad-response',
      'Cannot compare versions "' + opts.currentVersion + '" and "' + rel.tag_name + '".');
  const rules = PLATFORM_ASSETS[platform] || { download: /^$/, feed: /^$/ };
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const dl = assets.find(a => a && rules.download.test(a.name || ''));
  return {
    status: cmp < 0 ? 'update-available' : (cmp === 0 ? 'up-to-date' : 'newer-than-release'),
    current: String(opts.currentVersion).replace(/^v/i, ''),
    latest,
    tag: rel.tag_name,
    url: rel.html_url || ('https://github.com/' + opts.owner + '/' + opts.repo + '/releases/tag/' + rel.tag_name),
    publishedAt: rel.published_at || null,
    platform,
    download: dl ? { name: dl.name, url: dl.browser_download_url } : null,
    feed: assets.some(a => a && rules.feed.test(a.name || ''))
  };
}

module.exports = {
  checkForUpdate, fetchLatestRelease, compareVersions, parseVersion,
  githubRepoFromPackage, githubRepoFromUpdateConfig, UpdateCheckError
};
