#!/usr/bin/env node
// Apply SKRIEN to the official template supplied by the user's installed Vega SDK.
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const target = path.join(here, 'generated');
const argv = process.argv.slice(2);
const urlIndex = argv.indexOf('--url');
// Vega WebView only allows HTTPS, so the TV pairs through the public relay unless told otherwise.
const DEFAULT_RELAY = 'https://skrien.emplv.com';
let gameUrl = `file:///pkg/assets/index.html?tv=1&platform=vega&relay=${encodeURIComponent(DEFAULT_RELAY)}`;
if (argv.length && !(argv.length === 2 && urlIndex === 0)) {
  throw new Error('Usage: node vega/prepare.mjs [--url https://your-demo-host/]');
}
if (urlIndex >= 0) {
  const url = new URL(argv[urlIndex + 1]);
  if (url.protocol !== 'https:') throw new Error('Hosted mode requires an HTTPS URL reachable by the Vega device.');
  url.searchParams.set('tv', '1');
  url.searchParams.set('platform', 'vega');
  if (!url.searchParams.has('relay')) url.searchParams.set('relay', url.origin);
  gameUrl = url.href;
}
if (!existsSync(path.join(root, 'dist/index.html')) || !existsSync(path.join(root, 'dist/app.bundle.js'))) {
  throw new Error('Build the shared game first: npm install && npm run build from the SKRIEN root.');
}
if (!existsSync(target)) {
  const result = spawnSync('vega', ['project', 'generate', '--template', 'vegaWebview', '--name', 'SKRIEN', '--packageId', 'com.progresful.skrien', '--outputDir', target], {stdio: 'inherit'});
  if (result.error) throw new Error('Vega SDK is not installed or vega is not on PATH. Install the official Vega SDK, then rerun. ' + result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
} else if (!existsSync(path.join(target, '.skrien-template'))) {
  throw new Error('vega/generated already exists and was not created by this script. Choose a fresh folder or move it aside before retrying.');
}
if (!existsSync(path.join(target, 'manifest.toml')) || !existsSync(path.join(target, 'package.json'))) {
  throw new Error('The SDK generated an unexpected layout. Open its generated folder in Vega Studio; do not overwrite a different project.');
}
writeFileSync(path.join(target, '.skrien-template'), 'Amazon Vega SDK vegaWebview template with SKRIEN source overlay\n');
mkdirSync(path.join(target, 'src'), {recursive: true});
cpSync(path.join(here, 'src/App.tsx'), path.join(target, 'src/App.tsx'));
writeFileSync(path.join(target, 'src/config.ts'), `export const GAME_URL = ${JSON.stringify(gameUrl)};\n`);
cpSync(path.join(root, 'dist'), path.join(target, 'assets'), {recursive: true});

// Preserve SDK-specific native module requirements and dependency versions.
// Explicitly check the renderer service required by Amazon's migration docs.
const manifestPath = path.join(target, 'manifest.toml');
let manifest = readFileSync(manifestPath, 'utf8');
const packageSection = /\[package\]([\s\S]*?)(?=\n\s*\[|$)/;
if (!packageSection.test(manifest)) throw new Error('Generated manifest has no [package] section. Inspect it in Vega Studio before continuing.');
manifest = manifest.replace(packageSection, (section) => {
  if (!/^\s*title\s*=/m.test(section) || !/^\s*version\s*=/m.test(section)) {
    throw new Error('Generated package title/version fields are missing. Inspect manifest.toml in Vega Studio.');
  }
  return section.replace(/^(\s*title\s*=).*$/m, '$1 "SKRIEN"')
    .replace(/^(\s*version\s*=).*$/m, '$1 "0.3.0"');
});
for (const service of ['com.amazon.webview.renderer_service', 'com.amazon.inputmethod.service', 'com.amazon.audio.stream', 'com.amazon.audio.control']) {
  if (!manifest.includes(`"${service}"`)) manifest += `\n[[wants.service]]\nid = "${service}"\n`;
}
writeFileSync(manifestPath, manifest);

const pkg = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
if (!pkg.dependencies?.['@amazon-devices/webview']) {
  throw new Error('Installed SDK vegaWebview template did not declare @amazon-devices/webview. Update the Vega SDK; no incompatible dependency version was guessed.');
}
pkg.version = '0.3.0';
writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
console.log('\nPrepared SKRIEN from the installed Amazon vegaWebview template.');
console.log('App URL: ' + gameUrl);
console.log('Next: cd vega/generated && npm install && npm run build:app');
console.log('Use Vega Studio to select the virtual device / physical Fire TV and run the generated .vpkg.');
