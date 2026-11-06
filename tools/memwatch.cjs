// Scale memory watch: real-time play with a teleport every few seconds; samples heap, WebGPU render objects,
// Usage (repo folder, dev server on the port from tools/memwatch.vite.config.mjs running): node tools/memwatch.cjs 5193 12 chrome 1
// Writes memwatch-out/ next to the script. Needs playwright-core (or playwright) resolvable.
// renderer info; a sampling heap profile over the run (what is still alive at the end, by allocating stack).
// node memwatch.cjs <port> <minutes> [chromeChannel|exePath|headless] [size] [gpu: webgl|webgpu]
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const fs = require('fs'), path = require('path'), os = require('os');
const port = process.argv[2] || '5193', minutes = +(process.argv[3] || 12), chan = process.argv[4] || 'chrome', size = process.argv[5] || '1', gpu = process.argv[6] || '';
const out = path.join(__dirname, 'memwatch-out'); fs.mkdirSync(out, { recursive: true }); fs.rmSync(path.join(out, 'memwatch.log'), { force: true });
const log = (s) => { console.log(s); fs.appendFileSync(path.join(out, 'memwatch.log'), s + '\n'); };
(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-mem-'));
  const opts = { headless: chan === 'headless', args: ['--mute-audio', '--enable-precise-memory-info', '--window-size=1600,900'], viewport: null };
  if (chan === 'headless') { opts.args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'); }
  else if (/[\\/]/.test(chan)) opts.executablePath = chan; else opts.channel = chan;
  const ctx = await chromium.launchPersistentContext(prof, opts);
  try { log('browser pid ' + ctx.browser()?.process?.()?.pid); } catch {}
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERR ' + e.message.slice(0, 200)));
  const cdp = await ctx.newCDPSession(page);
  const t0 = Date.now(), T = () => Math.round((Date.now() - t0) / 1000);
  await page.goto(`http://localhost:${port}/?seed=42&size=${size}&auto&mute&mode=sandbox${gpu ? '&gpu=' + gpu : ''}`);
  await page.waitForFunction(() => window.warmReport && document.querySelector('#loading')?.style.display === 'none', null, { timeout: 1200000, polling: 2000 });
  log(`loaded at ${T()} s, webgpu=${await page.evaluate(() => !!window.game.renderer.webgpu)}`);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^ok$/i.test(x.textContent.trim())); b?.click(); });
  await page.waitForTimeout(5000);
  const R = await page.evaluate(() => 900 * Math.pow(15.5, Math.min(1, window.game.settings.size)));
  const sample = async (tag, gc) => {
    if (gc) await cdp.send('HeapProfiler.collectGarbage');
    const h = await cdp.send('Runtime.getHeapUsage');
    const m = await page.evaluate(async () => {
      const g = window.game, gl = g.renderer.gl, info = gl.info;
      let objs = 0; g.renderer.scene.traverse(() => objs++);
      const RO = gl._objects?._renderObjects; let ros = -1, detached = 0; const kinds = {};
      if (RO) { ros = RO.size; for (const ro of RO) { let o = ro.object; const names = []; while (o.parent) { if (o.name && names.length < 2) names.push(o.name); o = o.parent; } if (!o.isScene) { detached++; const k = `${ro.object.type}${ro.object.name ? ' ' + ro.object.name : ''}${names.length ? ' <' + names.join('<') : ''} | ${ro.material.name || ro.material.type}`; kinds[k] = (kinds[k] || 0) + 1; } } }
      const top = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${v}× ${k}`);
      const geoL = gl._geometries?._geometryDisposeListeners?.size;
      let ua = null;
      try { const r = await performance.measureUserAgentSpecificMemory(); const by = {}; for (const b of r.breakdown) { const k = (b.attribution[0]?.scope || 'other') + ':' + (b.types || []).join('/'); by[k] = (by[k] || 0) + b.bytes; } ua = { totalMB: Math.round(r.bytes / 1048576), ...Object.fromEntries(Object.entries(by).filter(([, v]) => v > 8e6).map(([k, v]) => [k, Math.round(v / 1048576)])) }; } catch { ua = 'n/a (page not cross-origin isolated)'; }
      return { ua, jsMB: Math.round(performance.memory.usedJSHeapSize / 1048576), ros, detached, geoListeners: geoL, geo: info.memory.geometries, tex: info.memory.textures, objs, top };
    });
    log(JSON.stringify({ tag, t: T(), heapMB: Math.round(h.usedSize / 1048576), ...m }));
  };
  await sample('start', true);
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 65536 });
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const end = Date.now() + minutes * 60000; let n = 0, nextSample = Date.now() + 60000;
  while (Date.now() < end) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * R * 0.6;
    await page.evaluate(({ x, z }) => window.dev.teleport(x, z), { x: Math.cos(a) * d, z: Math.sin(a) * d }).catch((e) => log('tp ' + e.message.slice(0, 100)));
    n++;
    await page.waitForTimeout(6000);
    if (Date.now() > nextSample) { nextSample += 60000; await sample('teleports ' + n, false); }
  }
  await sample('end', true);
  const { profile } = await cdp.send('HeapProfiler.getSamplingProfile');
  await cdp.send('HeapProfiler.stopSampling');
  // Live bytes by the allocating frame chain (innermost 3 frames of our own code).
  const agg = {};
  const walk = (node, stack) => {
    const f = node.callFrame; const here = f.url ? `${f.functionName || '(anon)'} ${f.url.replace(/^.*?\/(src|node_modules|vendor)\//, '$1/').replace(/\?.*$/, '')}:${f.lineNumber + 1}` : (f.functionName || '(native)');
    const st = here === '(root)' ? stack : [here, ...stack].slice(0, 4);
    if (node.selfSize) { const k = st.join(' ← '); agg[k] = (agg[k] || 0) + node.selfSize; }
    for (const c of node.children) walk(c, st);
  };
  walk(profile.head, []);
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 40);
  log('--- still alive at the end (sampled), MB by allocating stack ---');
  for (const [k, v] of top) log(`${(v / 1048576).toFixed(1).padStart(7)}  ${k}`);
  fs.writeFileSync(path.join(out, 'sampling.json'), JSON.stringify(profile));
  await ctx.close();
  fs.rmSync(prof, { recursive: true, force: true });
  log('done');
})().catch((e) => { log('FAILED ' + e.stack); process.exit(1); });
