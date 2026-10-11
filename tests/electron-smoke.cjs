/* End-to-end smoke test of the *packaged* desktop app in a real GUI session.
 *
 *   npm run dist:linux
 *   node tests/electron-smoke.cjs [path/to/opentoon-studio] [extra electron args…]
 *
 * Defaults to dist/linux-unpacked/opentoon-studio. Runs with a throwaway
 * XDG_CONFIG_HOME so the user's real settings, recents and autosave are never
 * touched. Native dialogs are stubbed in the main process; everything else
 * (windows, IPC, file IO, downloads, update policy) is the shipped code.
 * Set OPENTOON_SMOKE_SHOTS=dir to keep screenshots. */
'use strict';
const { _electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = process.argv[2] || path.join(ROOT, 'dist', 'linux-unpacked', 'opentoon-studio');
const EXTRA_ARGS = process.argv.slice(3);
const PKG = require(path.join(ROOT, 'package.json'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
}

async function mainWindow(app) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const w = app.windows().find(p => /index\.html$/.test(p.url()));
    if (w) return w;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('main window never appeared');
}

(async () => {
  if (!fs.existsSync(EXE)) throw new Error('packaged app not found: ' + EXE + ' (run npm run dist:linux)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opentoon-smoke-'));
  const shots = process.env.OPENTOON_SMOKE_SHOTS || null;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const env = Object.assign({}, process.env, { XDG_CONFIG_HOME: path.join(tmp, 'config') });
  delete env.OPENTOON_UPDATES;          // exercise the platform default policy

  const app = await _electron.launch({ executablePath: EXE, args: EXTRA_ARGS, env, timeout: 60000 });
  const errors = [];
  try {
    const page = await mainWindow(app);
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    await page.waitForFunction(() => window.OT && window.OT.app && window.OT.app.project, null, { timeout: 30000 });

    // ---- shell: packaged, visible, right version, user data isolated ----
    await page.waitForTimeout(3000);       // splash minimum + reveal
    const shell = await app.evaluate(({ app: a, BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      const main = wins.find(w => /index\.html$/.test(w.webContents.getURL()));
      return {
        packaged: a.isPackaged, version: a.getVersion(), userData: a.getPath('userData'),
        visible: !!(main && main.isVisible()), windows: wins.length, platform: process.platform,
        ozone: a.commandLine.getSwitchValue('ozone-platform-hint') || 'default'
      };
    });
    check('packaged app launched and main window visible', shell.packaged && shell.visible, shell);
    check('version matches package.json', shell.version === PKG.version, shell.version);
    check('user data isolated to temp dir', shell.userData.startsWith(tmp), shell.userData);
    if (shots) await page.screenshot({ path: path.join(shots, '1-launcher.png') });

    // ---- update policy: manual by default off Windows, nothing auto-downloaded ----
    const policy = await page.evaluate(() => window.OpenToonDesktop.getUpdatePolicy());
    const expected = process.platform === 'win32' ? 'auto' : 'manual';
    check('update policy is ' + expected, policy === expected, policy);
    const upd = await page.evaluate(() => window.OpenToonDesktop.checkForUpdates());
    check('update check returns a definite answer', ['uptodate', 'available', 'error'].includes(upd.state), upd);
    if (upd.state === 'error') console.log('     (update check error is reported, not swallowed: ' + upd.code + ')');
    const dl = await page.evaluate(() => window.OpenToonDesktop.downloadUpdate());
    check('download refuses without an approvable update', dl.ok === false, dl);

    // ---- start a scene and draw ----
    await page.evaluate(() => { const l = window.OT.app._launcher; if (l) l.close(); });
    await page.waitForTimeout(500);
    const box = await page.evaluate(() => {
      const r = document.getElementById('canvas').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    async function stroke(dx, dy) {
      const cx = box.x + box.w / 2 + dx, cy = box.y + box.h / 2 + dy;
      await page.mouse.move(cx - 80, cy);
      await page.mouse.down();
      for (let i = 0; i <= 20; i++) await page.mouse.move(cx - 80 + i * 8, cy + Math.sin(i / 3) * 30);
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => { window.OT.app.tools.select('brush'); window.OT.app.setColor('#d94f30'); });
    await stroke(0, 0);
    await page.keyboard.press('.');          // next frame
    await page.waitForTimeout(100);
    await stroke(0, 60);
    const drawn = await page.evaluate(() => {
      const a = window.OT.app, l = a.activeLayer();
      const c0 = l.celAt(0), c1 = l.celAt(1);
      return { frame: a.frame, s0: c0 && c0.strokes ? c0.strokes.length : 0,
        s1: c1 && c1.strokes ? c1.strokes.length : 0, dirty: a.dirty, frames: a.project.frameCount };
    });
    check('mouse strokes land on frames 1 and 2', drawn.s0 > 0 && drawn.s1 > 0, drawn);
    if (shots) await page.screenshot({ path: path.join(shots, '2-drawn.png') });

    // ---- undo / redo ----
    const ur = await page.evaluate(() => {
      const a = window.OT.app, n = () => (a.activeLayer().celAt(1) || { strokes: [] }).strokes.length;
      const before = n(); a.undo(); const mid = n(); a.redo(); return { before, mid, after: n() };
    });
    check('undo / redo', ur.mid < ur.before && ur.after === ur.before, ur);

    // ---- playback ----
    const play = await page.evaluate(async () => {
      const a = window.OT.app;
      a.project.frameCount = Math.max(a.project.frameCount, 12);
      a.setFrame ? a.setFrame(0) : (a.frame = 0);
      const start = a.frame;
      a.playback.play ? a.playback.play() : a.playback.toggle();
      await new Promise(r => setTimeout(r, 400));
      const mid = a.frame;
      a.playback.stop ? a.playback.stop() : a.playback.toggle();
      return { start, mid, playing: !!a.playback.playing };
    });
    check('playback advances frames and stops', play.mid !== play.start && !play.playing, play);

    // ---- save / reopen through the real main-process file IO ----
    const file = path.join(tmp, 'smoke test.otoon');
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    }, file);
    await page.evaluate(() => window.OT.app.saveProject(true));
    await page.waitForTimeout(800);
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* fail below */ }
    check('project saved to disk via native IO', !!(saved && saved.layers && saved.layers.length), saved ? { layers: saved.layers.length, bytes: fs.statSync(file).size } : null);
    await page.evaluate(() => { const a = window.OT.app; a.activeLayer().celAt(0).strokes.length = 0; a.dirty = false; });
    await page.evaluate(() => window.OT.app.openProject());
    await page.waitForTimeout(1200);
    const reopened = await page.evaluate(() => {
      const a = window.OT.app, l = a.project.layers.find(x => x.celAt && x.celAt(0));
      return { path: a.projectPath, s0: l ? (l.celAt(0).strokes || []).length : 0 };
    });
    check('project reopens with strokes intact', reopened.s0 > 0 && reopened.path === file, reopened);

    // ---- exports (downloads intercepted in the main process) ----
    await app.evaluate(({ session }, dir) => {
      // (no require() in this context; dir is an absolute POSIX/Win path)
      session.defaultSession.on('will-download', (_e, item) => item.setSavePath(dir + '/' + item.getFilename()));
    }, tmp);
    const gif = await page.evaluate(async () => {
      const a = window.OT.app;
      const blob = await OT.IO.Export.gif(a, { outW: 320, outH: 180, from: 0, to: 1, loop: true }, null);
      return { size: blob.size, type: blob.type };
    });
    check('GIF export encodes', gif.size > 100 && gif.type === 'image/gif', gif);
    const webm = await page.evaluate(async () => {
      const blob = await OT.IO.Export.webm(window.OT.app, { outW: 320, outH: 180, from: 0, to: 1 }, null);
      return { size: blob.size };
    });
    check('WebM export records', webm.size > 100, webm);
    const mp4 = await page.evaluate(async () => {
      try {
        const blob = await OT.IO.Export.mp4(window.OT.app, { outW: 320, outH: 180, from: 0, to: 1 }, null);
        return { ok: true, size: blob.size };
      } catch (e) { return { ok: false, message: e.message }; }
    });
    console.log('info MP4 export: ' + JSON.stringify(mp4));
    await page.evaluate(() => {
      window.OT.app.ui._runExport('frame', { outW: 320, outH: 180, from: 0, to: 0, name: 'smoke-frame' });
    });
    await page.waitForTimeout(1500);
    const pngs = fs.readdirSync(tmp).filter(f => /\.png$/i.test(f));
    check('single-frame PNG export written through download', pngs.length > 0, pngs);

    // ---- pen-display window ----
    const pen = await page.evaluate(() => window.OpenToonDesktop.openPenWindow({}));
    await page.waitForTimeout(2500);
    const penState = await page.evaluate(() => window.OpenToonDesktop.getPenWindowState());
    const penPage = app.windows().find(p => /pen\.html$/.test(p.url()));
    const penAttached = await page.evaluate(() => window.OT.app.penCast.active);
    check('pen-display window opens and attaches', pen.ok && penState.open && !!penPage && penAttached, { penState, penAttached });
    if (shots && penPage) await penPage.screenshot({ path: path.join(shots, '3-pen-window.png') });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().filter(w => /pen\.html$/.test(w.webContents.getURL())).forEach(w => w.close());
    });
    await page.waitForTimeout(800);

    // ---- update-available card (manual policy) never downloads by itself ----
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(x => /index\.html$/.test(x.webContents.getURL()));
      w.webContents.send('opentoon:update-status', {
        state: 'available', policy: 'manual', version: '99.0.0',
        url: 'https://github.com/helliott20/opentoon/releases', canDownload: false, hasPlatformBuild: false
      });
    });
    await page.waitForTimeout(600);
    const card = await page.evaluate(() => {
      const c = document.querySelector('.update-card');
      return c ? { label: c.getAttribute('aria-label'), text: c.innerText.replace(/\s+/g, ' ').trim(),
        buttons: [...c.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean) } : null;
    });
    check('update-available card asks before doing anything',
      !!card && card.label === 'Update available' && !card.buttons.includes('Restart & Install'), card);
    if (shots) await page.screenshot({ path: path.join(shots, '4-update-card.png') });
    await page.evaluate(() => { const b = document.querySelector('.update-card__later'); if (b) b.click(); });

    // ---- closing with unsaved edits prompts instead of silently refusing ----
    // A listener stops Playwright from auto-answering the beforeunload dialog
    // itself; Electron routes it to will-prevent-unload in the main process.
    page.on('dialog', () => {});
    await page.evaluate(() => { window.OT.app.dirty = true; });
    await app.evaluate(({ dialog }) => {
      global.__smokePrompts = 0;
      dialog.showMessageBoxSync = () => { global.__smokePrompts++; return 1; };   // Cancel
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(w => /index\.html$/.test(w.webContents.getURL())).close();
    });
    await page.waitForTimeout(800);
    const afterCancel = await app.evaluate(({ BrowserWindow }) => ({
      prompts: global.__smokePrompts, open: BrowserWindow.getAllWindows().length
    }));
    check('close with unsaved edits prompts; Cancel keeps the window', afterCancel.prompts === 1 && afterCancel.open >= 1, afterCancel);
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });      // Discard Changes
    const closed = app.waitForEvent('close', { timeout: 15000 }).then(() => true).catch(() => false);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(w => /index\.html$/.test(w.webContents.getURL())).close();
    });
    check('"Discard Changes" exits the app', await closed);

    check('no renderer errors', errors.length === 0, errors.slice(0, 5));
  } catch (e) {
    check('smoke test ran to completion', false, String(e && e.stack || e));
  } finally {
    try { await app.close(); } catch (e) { /* already closed */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' packaged-app checks passed');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error('SMOKE CRASH:', e); process.exitCode = 2; });
