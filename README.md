# SKRIEN

**Your body. Your controller.**

SKRIEN is a 3D endless runner for the TV that you play by moving. Run in place to set the pace, step left and right to switch lanes, jump, duck, and clap above your head to clear gates and collect coins. A phone or laptop camera watches you; the TV shows the trail.

Play it at **[skrien.emplv.com](https://skrien.emplv.com)**. On Fire TV it runs as a Vega OS app (see [vega/](vega/README.md)).

## How it works

```
 phone / laptop camera                                   TV (Vega OS or browser)
 ┌──────────────────────────┐    game actions only     ┌────────────────────────┐
 │ MediaPipe Pose Landmarker│  run 0.8 · jump · left   │ Three.js runner        │
 │ movement interpretation  │ ───── WebSocket relay ──▶│ cues, scoring, worlds  │
 └──────────────────────────┘     (wss, /relay)        └────────────────────────┘
```

- **Pose stays on the camera device.** The controller page runs the pose model in the browser and sends interpreted actions (`run`, `lane`, `jump`, `duck`, `clap`). Video frames are never uploaded.
- **Pairing uses a six-character code.** The TV creates a room on the relay and shows an address such as `skrien.emplv.com/?controller=ABC234`. Opening it on the phone pairs immediately.
- **Running pace comes from the body's bounce.** Seen from the front, knees move toward the camera and barely change height, but the torso bounces once per step. The controller measures that rhythm, so faster running moves the runner faster.
- **Losing sight of the player pauses the TV** after a short grace period and resumes when they step back into view. The phone keeps its screen awake during a run.

## Moves

| Move | Camera | TV remote | Keyboard |
| --- | --- | --- | --- |
| Run | Run in place; faster steps, faster runner | Automatic | Automatic |
| Change lane | Step left or right | D-pad left/right | Arrows or A/D |
| Jump | Jump with both feet (knee raise in low-impact mode) | D-pad up | Up or W |
| Duck | Bend your knees and lower your body | D-pad down | Down or S |
| Energy gate | Bring both hands together above your head | Select | Space or Enter |
| Pause | Pause button on the phone | Back or play/pause | P or Escape |

Choose **Easy**, **Medium** or **Workout**, one of three worlds (Evergreen escape, Golden canyon, Afterglow city), and a 60, 90 or 180 second session. Workout stays at full intensity for the whole run; Easy and Medium include gentler phases. **Low-impact** replaces jumps with knee raises in every mode.

## Run it locally

Requires Node.js 20 or newer.

```bash
npm ci
npm test
npm run build
npm start
```

Open http://localhost:4173. To use the camera on the same computer, choose **Use your camera**. To use the computer as a controller for another screen, open http://localhost:4173/?controller and enter the code shown on the TV.

`npm start` serves `dist/`; run `npm run build` after changing anything in `web/`. Phone cameras need HTTPS: either deploy the relay (below) or run `npm run tunnel` for a temporary Cloudflare address.

## Fire TV (Vega OS)

The Vega app wraps the same build in Amazon's `vegaWebview` template. Vega's WebView only allows HTTPS and WSS, so the TV pairs through an HTTPS relay; the build points at `https://skrien.emplv.com` by default. Build and run steps are in [vega/README.md](vega/README.md).

## Deploy the relay

`server.mjs` serves the game and the `/relay` WebSocket from one process. Rooms live in memory; nothing is stored.

```bash
DEPLOY_HOST=user@server deploy/deploy.sh
```

The script runs the tests, builds, uploads a release and runs `deploy/install.sh` on the server, which creates a `skrien` system user, installs `deploy/skrien.service` (Node on `127.0.0.1:4373`) and adds `deploy/skrien.caddy` to Caddy. The Caddy configuration is validated before reloading. The snippet expects TLS through Cloudflare with an origin certificate; adjust it for your host.

## Tuning movement detection

Open the controller with `?controller&record` to show a **Record moves** button in the camera view. It saves landmark coordinates and detected actions as JSON (no video). `tests/fixtures/real-moves.json` holds short recorded clips that the pose tests replay at 20 Hz and 14 Hz.

## Project layout

| Path | What it does |
| --- | --- |
| `web/app.js`, `web/index.html`, `web/style.css` | Menus, HUD, TV remote focus, pairing, controller screen |
| `web/game.js`, `web/game-logic.js` | Three.js renderer and deterministic game rules |
| `web/motion.js`, `web/pose-logic.js`, `web/cadence.js` | Camera, pose model, movement and running-pace detection |
| `web/tracking-pause.js`, `web/pose-recorder.js` | Pause on tracking loss, landmark recorder |
| `web/relay.js`, `server.mjs` | Pairing client, static server and WebSocket relay |
| `scripts/` | Dependency vendoring, build, tunnel |
| `vega/` | Vega OS wrapper source and simulator launcher |
| `deploy/` | systemd unit, Caddy snippet and deploy scripts |
| `tests/` | Game rules, pose interpretation, relay integration |

## License

[MIT](LICENSE). Three.js, MediaPipe Tasks Vision, the pose model and `ws` keep their own licenses; see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
