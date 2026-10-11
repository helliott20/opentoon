/* Shared browser launcher for the headless tests.
 *
 * Tries, in order:
 *   1. OPENTOON_TEST_BROWSER — absolute path to any Chromium-based browser
 *   2. the msedge / chrome Playwright channels (Windows / macOS installs)
 *   3. common Linux Chromium-family binaries on PATH
 *   4. Playwright's own downloaded Chromium, if present
 */
'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// file:// URL of the app entry point (correct on Windows and POSIX)
const FILE = pathToFileURL(path.resolve(__dirname, '..', 'index.html')).href;

const LINUX_BROWSERS = [
  'chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome',
  'microsoft-edge-stable', 'brave', 'brave-browser', 'vivaldi-stable'
];

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ }
  }
  return null;
}

function candidates() {
  const list = [];
  if (process.env.OPENTOON_TEST_BROWSER)
    list.push({ executablePath: process.env.OPENTOON_TEST_BROWSER });
  list.push({ channel: 'msedge' }, { channel: 'chrome' });
  if (process.platform === 'linux') {
    for (const name of LINUX_BROWSERS) {
      const p = findOnPath(name);
      if (p) list.push({ executablePath: p });
    }
  }
  list.push({});
  return list;
}

// A test that crashes before browser.close() would otherwise keep the
// browser pipe open and hang `npm test` forever. The timer is unref'd, so a
// test that finishes normally exits without waiting for it.
function armWatchdog() {
  const ms = Number(process.env.OPENTOON_TEST_TIMEOUT_MS) || 180000;
  setTimeout(() => {
    console.error('TEST TIMEOUT: still running after ' + ms + ' ms');
    process.exit(3);
  }, ms).unref();
}

async function launch(extra) {
  armWatchdog();
  const tried = [];
  for (const c of candidates()) {
    try {
      return await chromium.launch(Object.assign({ headless: true }, c, extra || {}));
    } catch (e) {
      tried.push((c.channel || c.executablePath || 'playwright-chromium') +
        ': ' + String(e && e.message || e).split('\n')[0]);
    }
  }
  throw new Error('No Chromium-based browser available. Set OPENTOON_TEST_BROWSER ' +
    'to a Chromium/Chrome/Edge/Brave executable.\n  ' + tried.join('\n  '));
}

module.exports = { launch, FILE };
