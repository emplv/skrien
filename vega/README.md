# SKRIEN on Vega OS

This folder turns the SKRIEN web build into a Vega OS app for Fire TV. `prepare.mjs` generates a project from Amazon's `vegaWebview` SDK template, replaces its `src/App.tsx` with [`src/App.tsx`](src/App.tsx), and copies `dist/` into the package's assets.

Tested with Vega SDK 0.24 and the Vega Virtual Device on an Apple Silicon Mac. Amazon's SDK documentation notes that WebView apps are not supported by the virtual device on Intel Macs or Ubuntu.

## Build and run

1. Install the [Vega SDK](https://developer.amazon.com/docs/vega/0.24/install-vega-sdk) and load its environment (`source ~/vega/env`).
2. Build the game and generate the Vega project:

   ```bash
   npm ci
   npm run build
   node vega/prepare.mjs
   ```

3. Build the package:

   ```bash
   cd vega/generated
   npm install
   npm run build:app
   ```

4. Start the virtual device and launch the app:

   ```bash
   vega virtual-device start
   node vega/run-simulator.mjs
   ```

   `run-simulator.mjs` finds the aarch64 `.vpkg` and the component ID from the generated manifest. The equivalent command is
   `vega run-app vega/generated/build/aarch64-release/skrien_aarch64.vpkg com.progresful.skrien.main -d VirtualDevice`.

After any change in `web/`, run `npm run build`, `node vega/prepare.mjs` and `npm run build:app` again before relaunching.

## Pairing a camera

Vega's WebView blocks cleartext traffic (`net::ERR_CLEARTEXT_NOT_PERMITTED`), including plain `ws://` on the local network, so the TV must pair through an HTTPS relay. `prepare.mjs` pre-fills `https://skrien.emplv.com`; change `DEFAULT_RELAY` in `prepare.mjs` to use your own deployment (see `deploy/`). On the TV, open **Pair your camera**, press **Connect**, then open the address it shows on your phone.

To load the game from a hosted copy instead of the bundled assets:

```bash
node vega/prepare.mjs --url https://your-host/
```

## Remote and lifecycle

The WebView receives the D-pad and Back key through `allowSystemKeyEvents`; the shared game code handles focus and gameplay. The wrapper pauses the game when the app leaves the foreground and only shows its error screen if the game page itself fails to load.

## Troubleshooting

- If `vega run-app` fails right after the device boots with `Cannot read properties of undefined (reading 'trim')`, the device bridge is still offline. Restart the virtual device (`vega virtual-device stop`, then `start`) and run again.
- App logs: `vda -s emulator-5554 shell 'loggingctl log -f'`. Messages from the wrapper are prefixed with `[SKRIEN]`.

Keep the template's licenses and third-party notices in the generated project.
