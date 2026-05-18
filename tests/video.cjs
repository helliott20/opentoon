/* Video import test - records a clip, imports it as a playable video layer */
const { chromium } = require('playwright-core');
const path = require('path');
const FILE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');

async function launch() {
  for (const c of ['msedge', 'chrome', undefined]) {
    try { return await chromium.launch(c ? { channel: c, headless: true } : { headless: true }); }
    catch (e) {}
  }
  throw new Error('no browser');
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  // record a short clip in-page, then import it as a video layer
  const imp = await page.evaluate(async () => {
    function record() {
      return new Promise(async resolve => {
        const cv = document.createElement('canvas');
        cv.width = 320; cv.height = 240;
        const cx = cv.getContext('2d');
        const stream = cv.captureStream(30);
        let mime = 'video/webm;codecs=vp8';
        if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
        const rec = new MediaRecorder(stream, { mimeType: mime });
        const chunks = [];
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
        rec.start();
        let t = 0;
        const iv = setInterval(() => {
          cx.fillStyle = (t % 2) ? '#cc4433' : '#3344cc';
          cx.fillRect(0, 0, 320, 240);
          cx.fillStyle = '#fff';
          cx.fillRect((t * 22) % 280, 90, 50, 50);
          t++;
        }, 33);
        setTimeout(() => { clearInterval(iv); rec.stop(); }, 1300);
      });
    }
    const blob = await record();
    const file = new File([blob], 'test-clip.webm', { type: 'video/webm' });
    const a = window.OT.app;
    await a.importVideo(file);
    const vl = a.project.layers.find(l => l.type === 'video');
    return {
      blobSize: blob.size,
      hasVideoLayer: !!vl,
      videoFrames: vl ? vl.videoFrames : 0,
      durFinite: vl ? isFinite(vl.video.duration) : false,
      hasEl: vl ? !!vl.videoEl : false,
      frameCount: a.project.frameCount
    };
  });
  console.log('IMPORT', JSON.stringify(imp));

  // seek to a middle frame and confirm the video composites onto the canvas
  const composited = await page.evaluate(async () => {
    const a = window.OT.app;
    const mid = Math.floor((a.project.layers.find(l => l.type === 'video').videoFrames) / 2);
    a.setFrame(mid);
    await a.seekVideosTo(mid);
    a.emit('render');
    await new Promise(r => setTimeout(r, 200));
    // sample a few points - the video fills most of the frame with colour
    const pts = [[0.5, 0.5], [0.3, 0.4], [0.7, 0.6]];
    let coloured = 0;
    for (const [fx, fy] of pts) {
      const c = a.stage.sampleColor(a.project.width * fx, a.project.height * fy);
      if (c && c !== '#ffffff') coloured++;
    }
    return { frame: mid, colouredSamples: coloured };
  });
  console.log('COMPOSITE', JSON.stringify(composited));
  await page.screenshot({ path: path.join(__dirname, 'vid1.png') });

  // play it and confirm the video element is actually running
  const playing = await page.evaluate(async () => {
    const a = window.OT.app;
    a.setFrame(0);
    a.playback.play();
    await new Promise(r => setTimeout(r, 500));
    const vl = a.project.layers.find(l => l.type === 'video');
    const elPlaying = vl && !vl.videoEl.paused && vl.videoEl.currentTime > 0;
    const advanced = a.frame;
    a.playback.stop();
    return { elPlaying: !!elPlaying, advancedToFrame: advanced };
  });
  console.log('PLAYBACK', JSON.stringify(playing));

  // serialize round-trip keeps the video layer
  const io = await page.evaluate(async () => {
    const a = window.OT.app;
    const data = window.OT.IO.serialize(a);
    const restored = await window.OT.IO.deserialize(JSON.parse(JSON.stringify(data)));
    const vl = restored.project.layers.find(l => l.type === 'video');
    return { hasVideoLayer: !!vl, hasSrc: vl ? !!(vl.video && vl.video.src) : false };
  });
  console.log('IO', JSON.stringify(io));

  await browser.close();
  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => console.log(e));
  process.exitCode = errors.length ? 1 : 0;
})().catch(e => { console.error('CRASH', e); process.exitCode = 2; });
