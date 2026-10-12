/**
 * Shared plumbing for the real-browser passes: serve `dist/`, launch the
 * provisioned Chromium, and read pixels back out of a screenshot.
 *
 * Needs `source /paperclip/qa-browser/env.sh` (DOG-95). A screenshot is only
 * evidence if `check.sh` passed in the same run: a fontless Chromium paints
 * nothing and still reports success.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..');
const WEB = join(ROOT, 'packages', 'atlas-web');

const { chromium } = await import('/paperclip/qa-browser/node_modules/playwright/index.mjs');

/**
 * Start `serve.mjs` on `port`, or throw. A child that exits before it prints
 * (EADDRINUSE) means whatever answers on that port is someone else's build, so
 * carrying on would test it.
 */
export async function serve(port) {
  const srv = spawn('node', [join(WEB, 'serve.mjs'), '--port', String(port), '--dir', 'dist'], { stdio: 'pipe' });
  let stderr = '';
  srv.stderr.on('data', (d) => { stderr += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`dist server did not start on port ${port} within 5 s`)), 5000);
    srv.stdout.on('data', () => { clearTimeout(t); resolve(); });
    srv.on('exit', (code) => { clearTimeout(t); reject(new Error(`dist server exited ${code} before it was serving on port ${port}: ${stderr.split('\n').find((l) => /Error/.test(l))?.trim() ?? stderr.trim()}`)); });
  }).catch((e) => { srv.kill(); throw e; });
  return { base: `http://127.0.0.1:${port}`, close: () => srv.kill() };
}

/**
 * Throw unless `base` serves this worktree's dist/ byte for byte. `index.html`
 * alone cannot tell builds apart (its asset paths are unhashed), so this
 * compares the files that change with the code and the data.
 */
export async function assertServesOwnDist(base) {
  const dist = join(WEB, 'dist');
  const optional = ['data/atlas-index.json', 'data/research.json', 'build-manifest.json'];
  for (const f of ['index.html', 'app/app.js', ...optional.filter((o) => existsSync(join(dist, o)))]) {
    const local = readFileSync(join(dist, f));
    const served = await fetch(`${base}/${f}`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
    if (!served || !local.equals(Buffer.from(served))) {
      throw new Error(`${base} is not serving this worktree's dist/: /${f} differs (port taken by another build?)`);
    }
  }
}

export async function launch() {
  // SwiftShader: the runner has no GPU. Software WebGL is slower than any real
  // GPU, so a timing taken here is an upper bound on the render term.
  return chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
}

/** Open a page and collect every console error and uncaught exception. */
export async function openPage(context, url, { waitReady = true } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  if (waitReady) {
    await page.waitForFunction(() => window.__atlas?.ready === true, null, { timeout: 60000 })
      .catch(() => errors.push('window.__atlas.ready never became true'));
  }
  return { page, errors };
}

/**
 * Pixel facts about the canvas, read from a real screenshot rather than from
 * the WebGL context (which does not preserve its drawing buffer).
 *
 * `painted` counts pixels that differ from the corner (background) colour;
 * `bbox` is their bounding box in canvas pixels, so "the body is in frame" is
 * a measurement and not a look.
 */
export async function canvasPixels(page) {
  const canvas = page.locator('[data-testid="canvas"]');
  const box = await canvas.boundingBox();
  const png = await canvas.screenshot();
  const facts = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const bg = [data[0], data[1], data[2]];
    let painted = 0; let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
    let sx = 0; let sy = 0;
    const colours = new Set();
    for (let y = 0; y < c.height; y += 1) {
      for (let x = 0; x < c.width; x += 1) {
        const i = (y * c.width + x) * 4;
        const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
        if (d > 24) {
          painted += 1; sx += x; sy += y;
          if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
          if (colours.size < 4096) colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
      }
    }
    return {
      width: c.width, height: c.height, background: bg, painted,
      paintedFraction: painted / (c.width * c.height),
      colours: colours.size,
      bbox: painted ? { minX, minY, maxX, maxY } : null,
      centroid: painted ? { x: sx / painted, y: sy / painted } : null,
    };
  }, png.toString('base64'));
  return { ...facts, box, png };
}

/** A per-row result. `status` is pass | fail | unverified; never anything else. */
export function row(id, status, detail, evidence = {}) {
  if (!['pass', 'fail', 'unverified'].includes(status)) throw new Error(`bad status ${status}`);
  return { id, status, detail, evidence };
}

/**
 * Pixels that differ between two screenshots of the same element.
 *
 * The canvas background is a gradient, so "differs from the corner colour" is
 * not "is the model". Diffing a render against the same view with every layer
 * hidden is: what changes is what the layers drew.
 */
export async function diffPixels(page, pngA, pngB) {
  return page.evaluate(async ([a, b]) => {
    const load = async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
    };
    const A = await load(a); const B = await load(b);
    if (A.w !== B.w || A.h !== B.h) return { error: `size ${A.w}x${A.h} vs ${B.w}x${B.h}` };
    let n = 0; let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1; let sx = 0; let sy = 0;
    for (let y = 0; y < A.h; y += 1) {
      for (let x = 0; x < A.w; x += 1) {
        const i = (y * A.w + x) * 4;
        const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
        if (d > 24) {
          n += 1; sx += x; sy += y;
          if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
      }
    }
    return { width: A.w, height: A.h, changed: n, bbox: n ? { minX, minY, maxX, maxY } : null, centroid: n ? { x: sx / n, y: sy / n } : null };
  }, [pngA.toString('base64'), pngB.toString('base64')]);
}
