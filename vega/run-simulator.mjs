#!/usr/bin/env node
// Launch the real Amazon Vega Virtual Device and a previously built SKRIEN app.
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const usage = `Launch SKRIEN in Amazon's Vega Virtual Device on Apple Silicon.

  node vega/run-simulator.mjs [--vpkg /path/to/aarch64-package.vpkg] [--dry-run]

First install the Vega SDK, run node vega/prepare.mjs, and build vega/generated.
By default, this finds the single .vpkg in generated/build/aarch64-release and
reads the interactive component ID from generated/manifest.toml.
--dry-run prints commands without starting the simulator.
This WebView app is not supported by VVD on Intel Mac or Ubuntu in SDK 0.24.
See vega/README.md for setup.`;

try {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) { console.log(usage); process.exit(0); }
  let explicitPackage;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { dryRun = true; continue; }
    if (argv[i] === '--vpkg' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      if (explicitPackage) throw new Error('Pass --vpkg only once.');
      explicitPackage = path.resolve(argv[++i]);
      continue;
    }
    throw new Error(`Unknown or missing argument: ${argv[i]}. Run with --help.`);
  }
  if (!dryRun) {
    const silicon = process.platform === 'darwin' && (process.arch === 'arm64' ||
      spawnSync('sysctl', ['-n', 'hw.optional.arm64'], {encoding: 'utf8'}).stdout?.trim() === '1');
    if (!silicon) throw new Error('SKRIEN uses WebView. Amazon documents VVD WebView support on Apple Silicon, not Intel Mac or Ubuntu. Use an Apple Silicon Mac or compatible physical Fire TV.');
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const generated = path.join(here, 'generated');
  const manifestFile = path.join(generated, 'manifest.toml');
  if (!existsSync(manifestFile)) throw new Error('Missing vega/generated/manifest.toml. Run node vega/prepare.mjs first.');
  const manifest = readFileSync(manifestFile, 'utf8');
  const interactive = manifest.match(/\[\[components\.interactive\]\]([\s\S]*?)(?=\n\s*\[|$)/)?.[1];
  const componentId = interactive?.match(/^\s*id\s*=\s*"([^"]+)"/m)?.[1];
  if (!componentId) throw new Error('Cannot resolve the interactive component ID. Inspect manifest.toml and use vega run-app manually.');
  let vpkg = explicitPackage;
  if (!vpkg) {
    const directory = path.join(generated, 'build/aarch64-release');
    const matches = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.vpkg')) : [];
    if (matches.length !== 1) throw new Error('Expected one aarch64 release .vpkg. Build with npm run build:app in vega/generated, or pass --vpkg with the actual aarch64 output.');
    vpkg = path.join(directory, matches[0]);
  }
  if (!existsSync(vpkg) || !vpkg.endsWith('.vpkg')) throw new Error(`Vega package not found: ${vpkg}`);
  for (const args of [
    ['virtual-device', 'start', '--timeout', '120'],
    ['run-app', vpkg, componentId, '-d', 'VirtualDevice'],
  ]) {
    if (dryRun) { console.log(JSON.stringify(['vega', ...args])); continue; }
    const result = spawnSync('vega', args, {stdio: 'inherit'});
    if (result.error) throw new Error(`Cannot run Vega CLI: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Vega command failed (${result.status ?? result.signal}). See the SDK output above.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
