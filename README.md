# Bibino-LAN — self-hosted baby monitor

A tiny, self-hosted baby monitor for your **local network**. Two browsers (one
near the baby, one with you) pair with a code and stream video + audio
**peer-to-peer over WebRTC**. No cloud, no account, no internet required.

It is a clean-room reimplementation inspired by the architecture of the
commercial *Bibino* desktop app (two-station model, WebRTC transport,
perfect-negotiation signaling), rebuilt as a minimal LAN-only service. It does
**not** connect to, and is not compatible with, the official Bibino apps or
servers.

## Features

- 👶 **Baby device** publishes camera + microphone.
- 📱 **Parent device** watches and listens, with an **open/close talk-back mic**
  that auto-closes after 8 s.
- **Noise gate + sensitivity (1–10)**: the parent only hears (and is alerted to)
  sounds above an adjustable threshold.
- **Noise push notifications** to the parent's lock screen (PWA; see limits below).
- **Dim screen + wake lock** on the baby device, so its light doesn't disturb
  the baby while the camera keeps streaming.
- Pairing by a high-entropy code on the same LAN; works fully offline (no
  STUN/TURN — uses same-network host ICE candidates).

Not included: recording, activity log, lullabies, multi-camera, remote
(off-LAN) access.

## Run it

The server serves **HTTPS with a self-signed certificate** (browsers require a
secure origin for camera/microphone, and a LAN IP is never `localhost`). You
must tell it which address(es) to put in the certificate via `CERT_HOSTS`.

### Docker Compose (clone + build)

```bash
cp .env.example .env     # then set CERT_HOSTS to your server's LAN IP/hostname
docker compose up -d --build
```

### Portainer (paste a stack, pull the prebuilt image)

```yaml
services:
  baby-monitor:
    image: ghcr.io/lichifunes/baby-monitor:latest
    container_name: baby-monitor
    restart: unless-stopped
    ports:
      - "8443:8443"
    environment:
      - PORT=8443
      - CERT_HOSTS=192.168.1.50   # <-- set your server's LAN IP/hostname
    volumes:
      - certs:/app/certs
volumes:
  certs:
```

(The image is published to GHCR by CI on each push to `main`. Make the package
public, or add GHCR credentials in Portainer, so it can be pulled.)

### Node (development)

```bash
npm install
CERT_HOSTS=<your-lan-ip> npm start
```

Then open `https://<your-lan-ip>:8443` on both devices, accept the one-time
certificate warning, use the **same code**, pick 👶 on one and 📱 on the other.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CERT_HOSTS` | (none) | **Required.** Comma-separated LAN IPs/hostnames written into the cert SAN. |
| `PORT` | `8443` | Published/listen port. |
| `TLS` | `1` | `0` serves plain HTTP (only usable via `localhost`). |
| `MAX_CONNECTIONS` | `100` | Cap on concurrent WebSocket clients. |
| `MAX_ROOMS` | `50` | Cap on concurrent rooms. |
| `VAPID_SUBJECT` | `mailto:admin@bibino.lan` | `mailto:`/URL subject for Web Push. |

For a warning-free certificate (and to enable iOS push, which requires a trusted
cert), put the service behind a reverse proxy such as Caddy or Traefik.

## Architecture

```
          ┌───────────────┐  signaling (SDP/ICE)  ┌──────────────┐
          │ baby (browser)│ ────────────────────▶ │ server (wss) │
          │ cam + mic     │ ◀──────────────────── │ relay only   │
          └──────┬────────┘                       └──────┬───────┘
                 │                                        │
                 │     WebRTC P2P (media never            │
                 │     touches the server)                │
                 ▼                                        ▼
            video + audio ──────────────────────▶ parent (browser)
            baby  ◀───────── talk-back audio ───── parent
```

- **`server.js`** — HTTPS static host + `/ws` WebSocket signaling + Web Push.
  It only relays opaque SDP/ICE/control between the two peers in a room; it
  never sees media.
- **`public/app.js`** — the client. WebRTC with a single offerer (baby offers,
  parent answers) to stay robust across Safari/WebKit.
- **`generate-cert.js`** — first-boot self-signed cert (SAN from `CERT_HOSTS`).

### How this maps to the original Bibino design

| Bibino (commercial) | Bibino-LAN (this project) |
|---|---|
| mDNS/Bonjour LAN discovery | shared URL + pairing code |
| XMPP-over-WebSocket signaling + presence | local WebSocket signaling |
| Google STUN + TappyTaps TURN | none (LAN host candidates) |
| WebRTC video track + Opus-over-DataChannel audio | WebRTC video + audio tracks |
| protobuf `Envelope` control RPCs | small JSON control messages |
| Parse + Firebase accounts, S3, Paddle | none |

## Security model

- **The room code is the shared secret.** Anyone who can reach the server *and*
  knows a room code is treated as authorized for that room, so codes are
  generated with a CSPRNG and are large enough to resist online guessing. Share
  the code (or the URL) over a trusted channel.
- Media is **peer-to-peer** and never passes through the server.
- The server enforces same-origin WebSocket connections, caps connections/rooms
  and message size, runs as a non-root user, and keeps private keys owner-only.
- **Known limitations** (inherent to the web platform): on a **locked iPhone**,
  live WebRTC audio is suspended by iOS — you get a push *notification* on noise
  (installed PWA + trusted cert required), not continuous audio. The self-signed
  certificate shows a one-time warning until you front it with a real cert.

## License

For personal, self-hosted use.
