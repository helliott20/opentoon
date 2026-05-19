/* Regression test for the second feature batch:
     - lasso selection tool (select + move vector strokes)
     - custom brush presets
     - colour palette import / export + library
     - auto-shading (light & shade) layer generation */
const { chromium } = require('playwright-core');
const path = require('path');

const FILE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');

async function launch() {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return await chromium.launch(channel ? { channel, headless: true } : { headless: true });
    } catch (e) { /* try next */ }
  }
  throw new Error('No browser available (msedge/chrome).');
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  // ---- lasso tool: draw a stroke, lasso it, drag it ----
  const lasso = await page.evaluate(() => {
    const a = window.OT.app, pc = a.penCast;
    a.tools.select('brush');
    pc._onInput({ type: 'down', nx: 0.44, ny: 0.42, pressure: 1, isPen: true });
    for (let i = 1; i <= 10; i++)
      pc._onInput({ type: 'move', isPen: true, pts: [{ nx: 0.44 + i * 0.012, ny: 0.42 + Math.sin(i / 2) * 0.04, pressure: 1 }] });
    pc._onInput({ type: 'up', nx: 0.56, ny: 0.44, pressure: 1, isPen: true });
    const cel = a.activeLayer().celAt(a.frame);
    const pts = cel.strokes[0].pts;
    let cx = 0, cy = 0; pts.forEach(p => { cx += p.x; cy += p.y; });
    cx /= pts.length; cy /= pts.length;
    // lasso a generous loop around the stroke
    a.tools.select('lasso');
    const L = a.tools.tools.lasso, R = 240;
    L.pointerDown({ x: cx - R, y: cy - R }, {}, a);
    L.pointerMove({ x: cx + R, y: cy - R }, {}, a);
    L.pointerMove({ x: cx + R, y: cy + R }, {}, a);
    L.pointerMove({ x: cx - R, y: cy + R }, {}, a);
    L.pointerMove({ x: cx - R, y: cy - R + 1 }, {}, a);
    L.pointerUp({ x: cx - R, y: cy - R + 1 }, {}, a);
    const selected = L.vsel.length;
    // drag the selection
    const x0 = cel.strokes[0].pts[0].x;
    L.pointerDown({ x: cx, y: cy }, {}, a);
    L.pointerMove({ x: cx + 60, y: cy + 45 }, {}, a);
    L.pointerUp({ x: cx + 60, y: cy + 45 }, {}, a);
    const x1 = cel.strokes[0].pts[0].x;
    return { selected: selected, moved: Math.abs(x1 - x0) > 20 };
  });
  console.log('LASSO', JSON.stringify(lasso), (lasso.selected > 0 && lasso.moved) ? 'OK' : 'FAIL');

  // ---- brush presets ----
  const brush = await page.evaluate(() => {
    const a = window.OT.app;
    const defaults = a.brushPresets.length;
    a.applyBrushPreset('d-marker');
    const tool = a.tools.active.name, size = a.settings.brushSize;
    a.saveBrushPreset('UnitTest Brush');
    const afterSave = a.brushPresets.length;
    const mine = a.brushPresets[a.brushPresets.length - 1];
    a.deleteBrushPreset(mine.id);
    return {
      defaults: defaults, tool: tool, size: size,
      afterSave: afterSave, afterDel: a.brushPresets.length, savedName: mine.name
    };
  });
  console.log('BRUSH PRESETS', JSON.stringify(brush),
    (brush.defaults === 6 && brush.tool === 'brush' && brush.size === 30 &&
      brush.afterSave === 7 && brush.afterDel === 6) ? 'OK' : 'FAIL');

  // ---- palette import / export + library ----
  const pal = await page.evaluate(() => {
    const a = window.OT.app, P = window.OT.Palette;
    const gpl = 'GIMP Palette\nName: T\n#\n255   0   0\tRed\n0 255 0\tGreen\n0 0 255\tBlue\n';
    const fromGpl = P.parseText(gpl);
    const fromHex = P.parseText('#abcdef\n#123456\n#abcdef\nnot a colour');
    a.replacePalette(['#ff0000', '#00ff00', '#0000ff']);
    const palN = a.palette.swatches.length;
    const gplOut = P.toGPL(a.palette.swatches, 'X');
    a.savePaletteToLibrary('LibTest');
    const libN = a.paletteLibrary.length;
    a.loadPaletteFromLibrary('LibTest');
    return {
      fromGpl: fromGpl, fromHex: fromHex.length, palN: palN,
      gplOk: gplOut.indexOf('GIMP Palette') === 0, libN: libN
    };
  });
  console.log('PALETTE', JSON.stringify(pal),
    (pal.fromGpl.length === 3 && pal.fromGpl[0] === '#ff0000' && pal.fromHex === 2 &&
      pal.palN === 3 && pal.gplOk && pal.libN >= 1) ? 'OK' : 'FAIL');

  // ---- auto-shading ----
  const shade = await page.evaluate(() => {
    const a = window.OT.app;
    const src = a.project.layers.find(l => !l.shadeOf);
    a.selectLayer(src);
    const before = a.project.layers.length;
    a.generateShading({ angle: 225, shadow: 0.6, highlight: 0.4, softness: 10 });
    const after = a.project.layers.length;
    const shadeLayer = a.project.layers.find(l => l.shadeOf === src.id);
    let blank = true;
    if (shadeLayer) {
      const sc = shadeLayer.celAt(a.frame);
      if (sc) blank = sc.isBlank();
    }
    // re-running on the source updates in place rather than stacking
    a.selectLayer(src);
    a.generateShading({ angle: 90, shadow: 0.5, highlight: 0.3, softness: 8 });
    const afterRerun = a.project.layers.length;
    return {
      added: after - before, hasShadeLayer: !!shadeLayer, blank: blank,
      rerunStable: afterRerun === after
    };
  });
  console.log('AUTO-SHADE', JSON.stringify(shade),
    (shade.added === 1 && shade.hasShadeLayer && !shade.blank && shade.rerunStable) ? 'OK' : 'FAIL');

  await browser.close();

  const pass = lasso.selected > 0 && lasso.moved &&
    brush.defaults === 6 && brush.afterSave === 7 && brush.afterDel === 6 &&
    pal.fromGpl.length === 3 && pal.fromHex === 2 && pal.palN === 3 && pal.libN >= 1 &&
    shade.added === 1 && shade.hasShadeLayer && !shade.blank && shade.rerunStable;
  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => console.log(e));
  if (errors.length || !pass) { console.log(pass ? 'runtime errors' : 'assertions failed'); process.exitCode = 1; }
  else console.log('All feature-batch-2 checks passed.');
})().catch(e => { console.error('TEST CRASH:', e); process.exitCode = 2; });
