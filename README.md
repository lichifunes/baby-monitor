# Bibino-LAN — self-hosted baby monitor

A tiny, self-hosted baby monitor for your **local network**. Two browsers (one
near the baby, one with you) pair with a short code and stream video + audio
**peer-to-peer over WebRTC**. No cloud, no account, no internet required.

It is a clean-room reimplementation inspired by the architecture of the
commercial *Bibino* desktop app (two-station model, WebRTC transport,
perfect-negotiation signaling), rebuilt as a minimal LAN-only service. It does
**not** connect to, and is not compatible with, the official Bibino apps or
servers.

## What it does (v1)

- 👶 **Baby device** publishes camera + microphone.
- 📱 **Parent device** watches and listens, and can **hold-to-talk** back.
- Pairing by a shared numeric code on the same LAN.
- Works fully offline (no STUN/TURN — uses same-network host ICE candidates).

Not included yet: cry/motion detection, recording, activity log, lullabies,
multi-camera, remote (off-LAN) access. See "Architecture" for where these plug in.

## Run it

### Docker (recommended)

```bash
docker compose up -d --build
```

Then open the URL printed in the logs (`docker compose logs`), e.g.
`https://192.168.1.50:8443`, on both devices.

### Node (for development)

```bash
npm install
npm start
```

## Using it

1. Open the server URL on the **baby** device, enter a code (e.g. `4821`),
   tap **"This is the baby device"**, allow camera + microphone.
2. Open the **same URL and same code** on the **parent** device, tap
   **"This is the parent device"**, allow the microphone.
3. You should see/hear the baby within a second or two. Hold **🎙️ Hold to talk**
   to speak back.

### ⚠️ About the certificate warning

Browsers only allow camera/microphone access on a **secure origin**. A LAN IP
is not `localhost`, so the app serves **HTTPS with a self-signed certificate**
(generated on first boot into `./certs`). Your browser will show a one-time
warning — choose *Advanced → proceed*. This is expected and safe on your own
network. For a warning-free setup, put the service behind a reverse proxy with
a real certificate (e.g. a `*.lan` cert from your own CA, or Caddy/Traefik).

## Architecture

```
          ┌──────────────┐   signaling (SDP/ICE)   ┌──────────────┐
          │ baby (browser)│ ─────────────────────▶ │ server (wss) │
          │ cam + mic     │ ◀───────────────────── │ relay only   │
          └──────┬───────┘                         └──────┬───────┘
                 │                                        │
                 │        WebRTC P2P (media never          │
                 │        touches the server)              │
                 ▼                                        ▼
            video + audio ───────────────────────▶ parent (browser)
            baby  ◀───────── talk-back audio ────── parent
```

- **`server.js`** — HTTPS static host + `/ws` WebSocket signaling. The server
  only relays opaque SDP/ICE between the two peers in a room; it never sees media.
- **`public/app.js`** — the client. Implements WebRTC *perfect negotiation*
  (the parent is the "polite" peer; the baby drives negotiation), mirroring the
  original app's `RtcManager` glare handling.
- **`generate-cert.js`** — first-boot self-signed cert.

### How this maps to the original Bibino design

| Bibino (commercial) | Bibino-LAN (this project) |
|---|---|
| mDNS/Bonjour LAN discovery | shared URL + pairing code |
| XMPP-over-WebSocket signaling + presence | local WebSocket signaling |
| Google STUN + TappyTaps TURN | none (LAN host candidates) |
| WebRTC video track + Opus-over-DataChannel audio | WebRTC video + audio tracks |
| protobuf `Envelope` control RPCs | (not needed for v1 A/V) |
| Parse + Firebase accounts, S3, Paddle | none |

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8443` | Listen port |
| `TLS` | `1` | `0` serves plain HTTP (only usable via `localhost`) |

To add STUN later (for cross-subnet use), set `window.ICE_SERVERS` in the page.
