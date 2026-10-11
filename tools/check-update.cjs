#!/usr/bin/env node
/* OpenToon Studio - check GitHub Releases for a newer version (read-only).
 *
 *   node tools/check-update.cjs [--current 1.0.45] [--platform linux] [--json]
 *
 * Never downloads or installs anything. Exit codes:
 *   0  up to date (or running something newer than the latest release)
 *   10 a newer release exists
 *   2  network failure (offline / DNS / timeout)
 *   3  GitHub API rate limit hit (set GITHUB_TOKEN to raise it)
 *   4  release data missing or unusable (no releases, HTTP error, bad JSON)
 *   64 bad command-line usage */
'use strict';
const path = require('path');
const { checkForUpdate, githubRepoFromPackage } = require('../electron/update-check.js');

const EXIT = { ok: 0, available: 10, network: 2, rateLimited: 3, badData: 4, usage: 64 };

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value');
      return argv[++i];
    };
    if (a === '--json') out.json = true;
    else if (a === '--current') out.current = val();
    else if (a === '--platform') out.platform = val();
    else if (a === '--repo') out.repo = val();
    else if (a === '--timeout') out.timeoutMs = Number(val()) * 1000;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function usage() {
  return 'usage: check-update.cjs [--current VERSION] [--platform win32|darwin|linux]\n' +
    '                        [--repo OWNER/REPO] [--timeout SECONDS] [--json]';
}

(async () => {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message + '\n' + usage()); process.exitCode = EXIT.usage; return; }
  if (args.help) { console.log(usage()); return; }

  const pkg = require(path.join(__dirname, '..', 'package.json'));
  let repo = githubRepoFromPackage(pkg);
  if (args.repo) {
    const [owner, name] = args.repo.split('/');
    repo = owner && name ? { owner, repo: name } : null;
  }
  if (!repo) {
    console.error('No GitHub repository configured (package.json build.publish or --repo OWNER/REPO).');
    process.exitCode = EXIT.usage;
    return;
  }

  const current = args.current || pkg.version;
  try {
    const r = await checkForUpdate({
      owner: repo.owner, repo: repo.repo, currentVersion: current,
      platform: args.platform, timeoutMs: args.timeoutMs,
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    });
    if (args.json) {
      console.log(JSON.stringify(Object.assign({ ok: true }, r), null, 2));
    } else if (r.status === 'update-available') {
      console.log('Update available: ' + r.current + ' -> ' + r.latest +
        (r.publishedAt ? '  (published ' + r.publishedAt.slice(0, 10) + ')' : ''));
      console.log('Release: ' + r.url);
      console.log(r.download
        ? r.platform + ' download: ' + r.download.name
        : 'No ' + r.platform + ' build is attached to this release; build it from source (tag ' + r.tag + ').');
    } else if (r.status === 'up-to-date') {
      console.log('Up to date: ' + r.current + ' is the latest release.');
    } else {
      console.log('Running ' + r.current + ', which is newer than the latest release (' + r.latest + ').');
    }
    process.exitCode = r.status === 'update-available' ? EXIT.available : EXIT.ok;
  } catch (e) {
    const code = e && e.code;
    if (args.json) console.log(JSON.stringify({ ok: false, error: code || 'unknown', message: e && e.message }, null, 2));
    else console.error('Update check failed [' + (code || 'unknown') + ']: ' + (e && e.message));
    process.exitCode = (code === 'offline' || code === 'timeout') ? EXIT.network
      : code === 'rate-limited' ? EXIT.rateLimited : EXIT.badData;
  }
})();
