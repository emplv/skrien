import { spawn } from 'node:child_process';

const port = Number(process.env.SKRIEN_PORT || process.env.MOVA_PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('SKRIEN_PORT must be a port number between 1 and 65535.');
  process.exitCode = 1;
} else {
  console.log(`Starting a temporary HTTPS tunnel to SKRIEN on port ${port}.`);
  console.log('Keep npm start running in another terminal.');
  console.log('Use the printed https://…trycloudflare.com URL on your phone and as the TV relay URL.');
  console.log('Anyone with that temporary URL can open the demo. Stop this command to close the tunnel.\n');
  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], { stdio: 'inherit', shell: false });
  child.once('error', error => {
    if (error.code === 'ENOENT') {
      console.error('\ncloudflared is not installed.');
      console.error('macOS: brew install cloudflared');
      console.error('Other systems: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
      console.error('Then run npm run tunnel again.');
    } else console.error(`Could not start the tunnel: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', code => { process.exitCode = code || 0; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
}
