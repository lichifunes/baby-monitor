// Self-hosted LAN baby monitor — HTTPS static server + WebSocket signaling.
// No cloud, no accounts, no STUN/TURN: two browsers pair by a high-entropy room
// code and connect peer-to-peer over WebRTC. Media never touches the server.
//
// Trust model: the room code is the shared secret. Anyone who can reach the
// server AND knows a room code is treated as authorized for that room. Codes are
// generated client-side with a CSPRNG and are large enough to resist online
// guessing. The controls below bound what an unauthorized network client can do.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import webpush from "web-push";
import { ensureCerts } from "./generate-cert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const CERTS = path.join(__dirname, "certs");
const PORT = Number(process.env.PORT) || 8443;
const USE_TLS = process.env.TLS !== "0"; // TLS on by default (required for camera/mic over LAN)

const PUSH_COOLDOWN_MS = 15000; // minimum gap between noise notifications per room
const WS_MAX_PAYLOAD = 64 * 1024; // signaling messages are tiny; cap to bound memory
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 100;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 50;
const MAX_SUBSCRIPTIONS = 200;
const MAX_ROOM_ID_LEN = 128;
const HEARTBEAT_MS = 30000;
const SUBSCRIBE_BODY_LIMIT = 16 * 1024;

// ---- Web Push (noise notifications to the parent) -------------------------
// VAPID keys are generated once and persisted so subscriptions stay valid across
// restarts. Push is best-effort: any failure is logged and never breaks signaling.
let pushEnabled = false;
function initPush() {
  try {
    fs.mkdirSync(CERTS, { recursive: true, mode: 0o700 });
    const vapidPath = path.join(CERTS, "vapid.json");
    let keys;
    if (fs.existsSync(vapidPath)) {
      keys = JSON.parse(fs.readFileSync(vapidPath, "utf8"));
    } else {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(vapidPath, JSON.stringify(keys), { mode: 0o600 }); // contains the VAPID private key
      console.log("  Generated VAPID push keys");
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@bibino.lan", keys.publicKey, keys.privateKey);
    initPush.publicKey = keys.publicKey;
    pushEnabled = true;
  } catch (err) {
    console.log("  Push disabled:", err.message);
  }
}

// room -> { parent?: subscription, baby?: subscription }
const subscriptions = new Map();
function validSubscription(s) {
  return (
    s &&
    typeof s.endpoint === "string" &&
    /^https:\/\//.test(s.endpoint) &&
    s.keys &&
    typeof s.keys.p256dh === "string" &&
    typeof s.keys.auth === "string"
  );
}
function saveSubscription(room, role, subscription) {
  if (!subscriptions.has(room)) {
    if (subscriptions.size >= MAX_SUBSCRIPTIONS) return false; // bound memory
    subscriptions.set(room, {});
  }
  subscriptions.get(room)[role] = subscription;
  return true;
}
async function pushToParent(room, payload) {
  const sub = subscriptions.get(room)?.parent;
  if (!pushEnabled || !sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) delete subscriptions.get(room)?.parent; // gone
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".json": "application/json"
};

function serveStatic(req, res) {
  // Strip query, prevent path traversal, default to index.html.
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(PUBLIC, rel));
  // Require the resolved path to be strictly inside PUBLIC (the trailing
  // separator stops a sibling like "/app/publicX" from matching the prefix).
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

function readJsonBody(req, limit = SUBSCRIBE_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function handleRequest(req, res) {
  const url = (req.url || "/").split("?")[0];

  if (req.method === "GET" && url === "/vapid-public-key") {
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end(pushEnabled ? initPush.publicKey : "");
    return;
  }

  if (req.method === "POST" && url === "/subscribe") {
    try {
      const body = await readJsonBody(req);
      const room = typeof body.room === "string" ? body.room.slice(0, MAX_ROOM_ID_LEN) : "";
      const role = body.role === "baby" ? "baby" : "parent";
      // The room code is the authorization: callers must already know it. We also
      // validate the subscription shape and bound the store.
      if (room && validSubscription(body.subscription) && saveSubscription(room, role, body.subscription)) {
        res.writeHead(204).end();
      } else {
        res.writeHead(400).end("bad request");
      }
    } catch {
      res.writeHead(400).end("bad request");
    }
    return;
  }

  serveStatic(req, res);
}

// ---- Signaling ------------------------------------------------------------
// A room holds at most two peers. The server only relays opaque signaling
// payloads (SDP / ICE) between them and announces join/leave; it never parses
// media and keeps no state beyond who is connected.
const rooms = new Map(); // roomId -> Set<ws>

function peersIn(roomId) {
  return rooms.get(roomId) || new Set();
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Same-origin check: defeats cross-site WebSocket hijacking from a page the user
// visits in a browser. Browsers always send Origin; non-browser clients (no
// Origin) can connect over raw sockets regardless, so this only gates browsers.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function setupSignaling(server) {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: WS_MAX_PAYLOAD,
    verifyClient: ({ req }) => originAllowed(req)
  });

  // Heartbeat: drop sockets that stop answering so rooms don't leak.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((c) => {
      if (c.isAlive === false) return c.terminate();
      c.isAlive = false;
      try {
        c.ping();
      } catch {}
    });
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    if (wss.clients.size > MAX_CONNECTIONS) {
      send(ws, { type: "error", reason: "server-busy" });
      ws.close();
      return;
    }

    const params = new URLSearchParams((req.url || "").split("?")[1] || "");
    const roomId = (params.get("room") || "").trim().slice(0, MAX_ROOM_ID_LEN);
    const role = params.get("role") === "baby" ? "baby" : "parent";

    if (!roomId) {
      send(ws, { type: "error", reason: "missing-room" });
      ws.close();
      return;
    }
    if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) {
      send(ws, { type: "error", reason: "server-busy" });
      ws.close();
      return;
    }
    if (peersIn(roomId).size >= 2) {
      send(ws, { type: "error", reason: "room-full" });
      ws.close();
      return;
    }

    ws.roomId = roomId;
    ws.role = role;
    ws.lastNoise = false;
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId).add(ws);
    console.log(`[room ${roomId}] ${role} joined (peers=${rooms.get(roomId).size})`);

    // Tell this peer whether someone is already waiting, and notify the other.
    const others = [...peersIn(roomId)].filter((p) => p !== ws);
    send(ws, { type: "joined", role, peerPresent: others.length > 0 });
    others.forEach((p) => send(p, { type: "peer-joined", role }));

    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (msg.type !== "signal") return;
      // Relay to the other peer in the room, untouched.
      const d = msg.data || {};
      const kind = d.control
        ? `control(${d.control.status || Object.keys(d.control)[0]})`
        : d.description
          ? d.description.type
          : d.candidate
            ? "candidate"
            : "?";
      const peers = [...peersIn(roomId)].filter((p) => p !== ws);
      if (kind !== "candidate" && !(d.control && d.control.status)) {
        console.log(`[room ${roomId}] ${ws.role} -> ${kind} (relayed to ${peers.length})`);
      }
      peers.forEach((p) => send(p, { type: "signal", data: msg.data }));

      // Push a lock-screen notification to the parent on a baby noise transition.
      const status = d.control && d.control.status;
      if (ws.role === "baby" && status) {
        const nowNoisy = status === "noise";
        const now = Date.now();
        if (nowNoisy && !ws.lastNoise && (!ws.lastPushAt || now - ws.lastPushAt > PUSH_COOLDOWN_MS)) {
          ws.lastPushAt = now;
          pushToParent(roomId, { title: "Baby Monitor", body: "Noise detected in the baby's room" });
        }
        ws.lastNoise = nowNoisy;
      }
    });

    ws.on("close", () => {
      const set = rooms.get(roomId);
      if (!set) return;
      set.delete(ws);
      set.forEach((p) => send(p, { type: "peer-left" }));
      if (set.size === 0) rooms.delete(roomId);
    });
  });
}

// ---- Boot -----------------------------------------------------------------
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function start() {
  initPush();
  let server;
  if (USE_TLS) {
    const { key, cert } = ensureCerts(CERTS);
    server = https.createServer({ key, cert }, handleRequest);
  } else {
    server = http.createServer(handleRequest);
  }
  setupSignaling(server);
  server.listen(PORT, "0.0.0.0", () => {
    const scheme = USE_TLS ? "https" : "http";
    console.log(`\n  Bibino-LAN baby monitor running (${scheme})\n`);
    console.log(`  On this machine:  ${scheme}://localhost:${PORT}`);
    for (const ip of lanAddresses()) {
      console.log(`  On your network:  ${scheme}://${ip}:${PORT}   <- open this on phones/tablets`);
    }
    if (USE_TLS) {
      console.log(`\n  (Self-signed certificate: your browser will warn once — accept it to continue.)\n`);
    }
  });
}

start();
