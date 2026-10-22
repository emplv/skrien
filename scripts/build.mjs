#!/usr/bin/env node
/** Build one offline-capable directory shared by the browser and native TV wrappers. */
import { cp, mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'web');
const destination = join(root, 'dist');
const stage = join(root, `.dist-stage-${process.pid}`);
const backup = join(root, `.dist-previous-${process.pid}`);
const exists = async path => { try { await stat(path); return true; } catch { return false; } };

try {
  for (const file of ['app.js', 'index.html', 'style.css', 'icon.svg', 'vendor/three.module.js', 'vendor/vision_bundle.mjs', 'models/pose_landmarker_lite.task', 'vendor/wasm/vision_wasm_internal.wasm']) {
    if (!await exists(join(source, file))) throw new Error(`Missing web/${file}. Run npm run setup after installing dependencies.`);
  }
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await Promise.all([
    ...['index.html', 'style.css', 'icon.svg'].map(file => cp(join(source, file), join(stage, file))),
    cp(join(source, 'vendor/wasm'), join(stage, 'vendor/wasm'), { recursive: true }),
    cp(join(source, 'models'), join(stage, 'models'), { recursive: true }),
    cp(join(source, 'vendor/asset-manifest.json'), join(stage, 'ASSET_MANIFEST.json')),
  ]);
  await build({
    absWorkingDir: root, entryPoints: [join(source, 'app.js')], outfile: join(stage, 'app.bundle.js'),
    bundle: true, format: 'iife', platform: 'browser', target: ['es2020'],
    minify: true, sourcemap: false, legalComments: 'linked', charset: 'utf8',
    logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"', __SKRIEN_BUILD__: JSON.stringify(new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')) },
  });
  let html = await readFile(join(stage, 'index.html'), 'utf8');
  html = html.replace(/<script\b[^>]*\bsrc=["'](?:\.\/)?app\.js["'][^>]*>\s*<\/script>/gi, '<script src="app.bundle.js" defer></script>');
  if (!html.includes('app.bundle.js')) throw new Error('index.html must load app.bundle.js.');
  // Content-hash the asset URLs so browsers and CDNs never mix a new page with an old bundle.
  const versions = {};
  for (const file of ['app.bundle.js', 'style.css']) {
    versions[file] = createHash('sha256').update(await readFile(join(stage, file))).digest('hex').slice(0, 12);
  }
  html = html.replace(/\b(app\.bundle\.js|style\.css)(?:\?v=[\w.-]*)?/g, (_, file) => `${file}?v=${versions[file]}`);
  await writeFile(join(stage, 'index.html'), html);

  const [threeLicense, mediaPipeLicense, wsLicense, manifest] = await Promise.all([
    readFile(join(source, 'vendor/LICENSE.three.txt'), 'utf8'),
    readFile(join(source, 'vendor/LICENSE.mediapipe.txt'), 'utf8'),
    readFile(join(root, 'node_modules/ws/LICENSE'), 'utf8'),
    readFile(join(source, 'vendor/asset-manifest.json'), 'utf8'),
  ]);
  const model = JSON.parse(manifest).assets.find(asset => asset.path.startsWith('models/'));
  const notices = `SKRIEN — THIRD-PARTY NOTICES\n\n` +
    `The application and procedural art are original SKRIEN code. The following libraries and model assets retain their upstream terms.\n\n` +
    `THREE.JS 0.160.1 — MIT License\nhttps://github.com/mrdoob/three.js\n\n${threeLicense.trim()}\n\n` +
    `MEDIAPIPE TASKS VISION 0.10.18 — Apache License 2.0\nCopyright The MediaPipe Authors.\nhttps://github.com/google-ai-edge/mediapipe\n\n${mediaPipeLicense.trim()}\n\n` +
    `MEDIAPIPE POSE LANDMARKER LITE — MODEL ATTRIBUTION\n` +
    `Google MediaPipe Pose Landmarker Lite, float16 model bundle, version 1.\n` +
    `Official documentation: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker\n` +
    `Source: ${model.source}\nSHA-256: ${model.sha256}\n` +
    `The model bundle is redistributed unchanged. It is not a model trained by SKRIEN.\n\n` +
    `WS 8.18.3 — MIT License (local relay server; not included in the browser JavaScript bundle)\nhttps://github.com/websockets/ws\n\n${wsLicense.trim()}\n\n` +
    `The Vega wrapper is generated from Amazon's vegaWebview SDK template (see vega/README.md). Keep upstream notices in any generated Vega project.\n`;
  await writeFile(join(stage, 'THIRD_PARTY_NOTICES.txt'), notices);

  // Only exchange the live output after bundling, copying, and notices all succeed.
  // A failed build leaves the preceding usable dist intact.
  const hadPrevious = await exists(destination);
  if (hadPrevious) await rename(destination, backup);
  try { await rename(stage, destination); }
  catch (error) { if (hadPrevious) await rename(backup, destination); throw error; }
  await rm(backup, { recursive: true, force: true });
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.txt'), notices);
  const bundle = await stat(join(destination, 'app.bundle.js'));
  console.log(`SKRIEN built successfully: dist/ (${(bundle.size / 1024).toFixed(0)} KiB JavaScript, local WASM and pose model included).`);
} catch (error) {
  console.error(`Build failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(stage, { recursive: true, force: true });
}
