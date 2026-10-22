#!/usr/bin/env node
/** Pin and bundle runtime dependencies so a demo never depends on a third-party CDN. */
import { cp, mkdir, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'web/vendor');
const modelPath = join(root, 'web/models/pose_landmarker_lite.task');
const modelURL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const modelSHA256 = '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a';
const mediaPipeLicenseURL = 'https://raw.githubusercontent.com/google-ai-edge/mediapipe/v0.10.18/LICENSE';
const hash = data => createHash('sha256').update(data).digest('hex');
const exists = async path => { try { await stat(path); return true; } catch { return false; } };

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try { await writeFile(temporary, data); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function atomicCopy(source, destination) { await atomicWrite(destination, await readFile(source)); }
async function replaceDirectory(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}`;
  const previous = `${destination}.previous-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await cp(source, temporary, { recursive: true });
  const hadPrevious = await exists(destination);
  if (hadPrevious) await rename(destination, previous);
  try { await rename(temporary, destination); }
  catch (error) { if (hadPrevious) await rename(previous, destination); throw error; }
  await rm(previous, { recursive: true, force: true });
}
async function download(url, maximumBytes) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' }); }
  catch (fetchError) {
    // Node 20's fetch does not inherit HTTPS_PROXY. curl supports proxy-configured
    // development environments and is invoked without a shell or credentials.
    try {
      const { stdout } = await promisify(execFile)('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120', url], { encoding: 'buffer', maxBuffer: maximumBytes });
      return Buffer.from(stdout);
    } catch {
      throw new Error(`Cannot download ${url}: ${fetchError.cause?.code || fetchError.message}. Check HTTPS access or your proxy configuration.`);
    }
  }
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximumBytes) throw new Error(`Unexpectedly large response from ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maximumBytes) throw new Error(`Download exceeded the expected size: ${url}`);
  return body;
}
function validModel(data) {
  // MediaPipe .task files are ZIP containers (some have a two-byte alignment prefix).
  const signature = data.subarray(0, 8).indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  return data.length === 5_777_746 && signature >= 0 && hash(data) === modelSHA256;
}
async function record(path, source, version) {
  const bytes = await readFile(path);
  return { path: relative(join(root, 'web'), path).replaceAll('\\', '/'), source, version, bytes: bytes.length, sha256: hash(bytes) };
}

try {
  const threeDir = join(root, 'node_modules/three');
  const visionDir = join(root, 'node_modules/@mediapipe/tasks-vision');
  const three = JSON.parse(await readFile(join(threeDir, 'package.json'), 'utf8'));
  const vision = JSON.parse(await readFile(join(visionDir, 'package.json'), 'utf8'));
  if (three.version !== '0.160.1' || vision.version !== '0.10.18') {
    throw new Error(`Unexpected dependency versions: three=${three.version}, tasks-vision=${vision.version}. Run npm ci with the supplied lockfile.`);
  }
  await mkdir(vendor, { recursive: true });
  await atomicCopy(join(threeDir, 'build/three.module.js'), join(vendor, 'three.module.js'));
  await atomicCopy(join(visionDir, 'vision_bundle.mjs'), join(vendor, 'vision_bundle.mjs'));
  await atomicCopy(join(threeDir, 'LICENSE'), join(vendor, 'LICENSE.three.txt'));
  await replaceDirectory(join(visionDir, 'wasm'), join(vendor, 'wasm'));

  let model = await exists(modelPath) ? await readFile(modelPath) : null;
  if (!model || !validModel(model)) {
    console.log('Downloading the official MediaPipe Pose Landmarker Lite v1 model…');
    model = await download(modelURL, 15_000_000);
    if (!validModel(model)) throw new Error('The pose model failed its size or container check. No model file was replaced.');
    await atomicWrite(modelPath, model);
  } else console.log('Using the bundled, validated pose model.');

  const licensePath = join(vendor, 'LICENSE.mediapipe.txt');
  let license = await exists(licensePath) ? await readFile(licensePath, 'utf8') : '';
  if (!license.includes('Apache License') || !license.includes('Version 2.0')) {
    const upstream = await download(mediaPipeLicenseURL, 50_000);
    license = upstream.toString('utf8');
    if (!license.includes('Apache License') || !license.includes('Version 2.0')) throw new Error('Unexpected MediaPipe license response.');
    await atomicWrite(licensePath, upstream);
  }

  const assets = [
    await record(join(vendor, 'three.module.js'), 'https://www.npmjs.com/package/three', three.version),
    await record(join(vendor, 'vision_bundle.mjs'), 'https://www.npmjs.com/package/@mediapipe/tasks-vision', vision.version),
    await record(modelPath, modelURL, 'float16/1'),
    await record(join(vendor, 'LICENSE.three.txt'), 'https://github.com/mrdoob/three.js/blob/r160/LICENSE', three.version),
    await record(licensePath, mediaPipeLicenseURL, vision.version),
  ];
  for (const filename of (await readdir(join(vendor, 'wasm'))).sort()) {
    assets.push(await record(join(vendor, 'wasm', filename), 'https://www.npmjs.com/package/@mediapipe/tasks-vision', vision.version));
  }
  await atomicWrite(join(vendor, 'asset-manifest.json'), `${JSON.stringify({ format: 1, assets }, null, 2)}\n`);
  console.log(`Runtime assets ready: ${assets.length} files; pose model ${model.length.toLocaleString()} bytes; SHA-256 ${hash(model)}.`);
} catch (error) {
  console.error(`Asset setup failed: ${error.message}`);
  console.error('Install dependencies with npm ci first. The first setup requires HTTPS access to the official Google model and MediaPipe license URLs.');
  process.exitCode = 1;
}
