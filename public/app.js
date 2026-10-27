// Bibino-LAN client. One page, two roles:
//   baby   — publishes camera + microphone, detects noise, can dim its screen
//   parent — watches/listens, toggles the talk-back mic open/closed
//
// WebRTC "perfect negotiation" (polite/impolite) handles offer glare. On a LAN
// we use no STUN/TURN (host ICE candidates) and work fully offline.
//
// Media is acquired and unmuted inside the "Start" tap: mobile Safari only
// captures a real microphone signal, and only plays audio, after a genuine user
// gesture (lost when the landing page navigates here).
//
// A lightweight control channel (noise status) is relayed by the
// signaling server alongside SDP/ICE — fine for LAN-scale control messages.

const ICE_SERVERS = window.ICE_SERVERS || [];

// Sensitivity is shown to the parent as 1–10 (10 = hears the faintest sounds).
// It maps to an audioLevel threshold (getStats, 0..1) used for the gate + alert.
const SENS_DEFAULT = 7;
const THRESH_AT_1 = 0.15; // sensitivity 1  = least sensitive (only loud sounds)
const THRESH_AT_10 = 0.02; // sensitivity 10 = most sensitive
const METER_MAX = 0.2; // audioLevel that fills the meter to 100%
const sensToThreshold = (s) => THRESH_AT_1 - ((s - 1) / 9) * (THRESH_AT_1 - THRESH_AT_10);
const DEFAULT_THRESHOLD = sensToThreshold(SENS_DEFAULT);

const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

function show(screen) {
  $("landing").hidden = screen !== "landing";
  $("session").hidden = screen !== "session";
}

// ---- Landing --------------------------------------------------------------
function initLanding() {
  show("landing");
  const roomInput = $("room");
  roomInput.value = qs.get("room") || "";
  $("gen").onclick = () => {
    roomInput.value = String(Math.floor(1000 + Math.random() * 9000));
  };
  const go = (role) => {
    const room = roomInput.value.trim();
    if (!room) return roomInput.focus();
    location.search = `?role=${role}&room=${encodeURIComponent(room)}`;
  };
  $("asBaby").onclick = () => go("baby");
  $("asParent").onclick = () => go("parent");
}

// ---- Session --------------------------------------------------------------
function initSession(role, room) {
  show("session");
  const isBaby = role === "baby";
  const polite = !isBaby;

  $("roleBadge").textContent = isBaby ? "👶 baby device" : "📱 parent device";
  $("codeBadge").textContent = `code ${room}`;

  const statusEl = $("status");
  const overlay = $("overlay");
  const startBtn = $("start");
  const setStatus = (text, hide = false) => {
    statusEl.textContent = text;
    overlay.hidden = hide;
  };

  const logEl = $("log");
  const log = (...args) => {
    const line = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    if (logEl) logEl.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
    console.log("[bibino]", ...args);
  };
  log(`role=${role} room=${room} polite=${polite}`);

  const remoteVideo = $("remoteVideo");
  const localVideo = $("localVideo");
  const remoteAudio = $("remoteAudio");

  let pc = null;
  let localStream = null;
  let tracksAdded = false;
  let makingOffer = false;
  let ignoreOffer = false;
  let userStarted = false;
  let peerPresent = false;
  let ws;

  // Gate/alert threshold. On the parent it derives from the 1–10 sensitivity slider
  // (persisted); on the baby it's set by the parent's setThreshold control.
  let noiseThreshold = DEFAULT_THRESHOLD;
  let sensLevel = SENS_DEFAULT;
  if (!isBaby) {
    try {
      const saved = parseInt(localStorage.getItem("bibino-sens"), 10);
      if (saved >= 1 && saved <= 10) sensLevel = saved;
    } catch {}
    noiseThreshold = sensToThreshold(sensLevel);
  }

  // --- signaling + control relay ---
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?room=${encodeURIComponent(
    room
  )}&role=${role}`;

  function relay(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", data }));
  }
  const signal = (d) => relay(d);
  const sendControl = (control) => relay({ control });

  function connectSocket() {
    log("signaling: connecting");
    ws = new WebSocket(wsUrl);
    ws.onopen = () => log("signaling: open");
    ws.onmessage = async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type !== "signal") log("signaling <-", msg);
      if (msg.type === "error") {
        setStatus(msg.reason === "room-full" ? "This code is already used by two devices." : "Connection error.");
        return;
      }
      if (msg.type === "joined") {
        peerPresent = msg.peerPresent;
        maybeBegin();
      }
      if (msg.type === "peer-joined") {
        peerPresent = true;
        maybeBegin(true);
      }
      if (msg.type === "peer-left") {
        peerPresent = false;
        setStatus("Other device left. Waiting…");
      }
      if (msg.type === "signal") {
        if (msg.data && msg.data.control) handleControl(msg.data.control);
        else await onSignal(msg.data);
      }
    };
    ws.addEventListener("close", () => setTimeout(connectSocket, 1500), { once: true });
  }

  function handleControl(control) {
    if (isBaby && typeof control.setThreshold === "number") {
      noiseThreshold = control.setThreshold;
      log("threshold set to", noiseThreshold);
    }
    if (!isBaby && control.status) updateBabyStatus(control.status, control.level || 0);
  }

  // --- peer connection ---
  function createPeer() {
    const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    peer.onnegotiationneeded = async () => {
      // Only the impolite peer (baby) initiates offers. A single offerer avoids
      // glare entirely — WebKit/Safari's implicit rollback is unreliable and was
      // dropping the baby's tracks whenever an iPhone was involved.
      if (polite) return;
      try {
        makingOffer = true;
        log("negotiationneeded -> offer");
        await peer.setLocalDescription();
        signal({ description: peer.localDescription });
      } catch (err) {
        log("negotiation failed:", err.message || err);
      } finally {
        makingOffer = false;
      }
    };
    peer.onicecandidate = ({ candidate }) => candidate && signal({ candidate });
    peer.oniceconnectionstatechange = () => log("iceConnectionState:", peer.iceConnectionState);

    peer.ontrack = ({ track, streams }) => {
      log("ontrack:", track.kind);
      const stream = streams[0] || new MediaStream([track]);
      const el = track.kind === "video" ? remoteVideo : isBaby ? remoteAudio : remoteVideo;
      el.srcObject = stream;
      if (isBaby && track.kind === "audio") remoteAudio.hidden = false;
      el.play().catch((e) => log("play blocked:", e.name));
      setStatus("", true);
    };

    peer.onconnectionstatechange = () => {
      log("connectionState:", peer.connectionState);
      if (peer.connectionState === "connected") {
        setStatus("", true);
        if (!isBaby) sendControl({ setThreshold: noiseThreshold }); // apply the parent's chosen gate
      } else if (peer.connectionState === "failed") {
        peer.restartIce();
        setStatus("Reconnecting…");
      }
    };
    return peer;
  }

  function ensurePeer() {
    if (!pc) {
      pc = createPeer();
      addLocalTracks(); // attach our tracks at creation so the first offer/answer carries them
    }
    return pc;
  }

  async function onSignal({ description, candidate }) {
    ensurePeer();
    try {
      if (description) {
        const collision = description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
        ignoreOffer = !polite && collision;
        if (ignoreOffer) return log("glare: ignoring offer (impolite)");
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          signal({ description: pc.localDescription });
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!ignoreOffer) throw err;
        }
      }
    } catch (err) {
      log("onSignal error:", err.message || err);
    }
  }

  // --- media ---
  async function acquireLocalMedia() {
    if (isBaby) {
      // autoGainControl OFF so the measured level reflects the real sound — otherwise
      // AGC boosts quiet sounds so the level reads high and noise triggers constantly.
      const audio = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio
        });
      } catch (err) {
        log("camera unavailable, audio-only:", err.name || err.message);
        localStream = await navigator.mediaDevices.getUserMedia({ audio });
      }
      if (localStream.getVideoTracks().length) {
        localVideo.hidden = false;
        localVideo.srcObject = localStream;
      }
    } else {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const t = localStream.getAudioTracks()[0];
      t.enabled = false;
      setupMicToggle(t);
    }
  }

  function addLocalTracks() {
    if (tracksAdded || !localStream) return;
    for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
    tracksAdded = true;
    log("local tracks added");
  }

  function maybeBegin(peerJoinedEvent = false) {
    if (!userStarted) return setStatus("Tap Start to begin");
    if (!peerPresent) return setStatus("Waiting for the other device…");
    const fresh = !pc;
    ensurePeer(); // creating the peer adds our tracks; the baby's triggers its offer
    if (!fresh && peerJoinedEvent && !polite) {
      // Peer reconnected on an existing connection: baby re-drives the offer.
      makingOffer = true;
      pc.setLocalDescription()
        .then(() => signal({ description: pc.localDescription }))
        .catch((e) => log("reoffer failed:", e.message))
        .finally(() => (makingOffer = false));
    }
  }

  // --- noise detection (baby) ---
  // Read the microphone level from WebRTC's own getStats() audioLevel. This avoids
  // tapping the mic with Web Audio, which silences the transmitted track on iOS.
  async function readAudioLevel() {
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      let level = null;
      stats.forEach((r) => {
        if (r.type === "media-source" && r.kind === "audio" && typeof r.audioLevel === "number") level = r.audioLevel;
      });
      if (level == null) {
        stats.forEach((r) => {
          if (r.type === "outbound-rtp" && r.kind === "audio" && typeof r.audioLevel === "number") level = r.audioLevel;
        });
      }
      return level;
    } catch {
      return null;
    }
  }

  function startNoiseWatch() {
    let noisy = false;
    let aboveSince = 0;
    let belowSince = 0;
    let lastSent = 0;
    let lastLog = 0;

    setInterval(async () => {
      const level = await readAudioLevel();
      if (level == null) return;
      const thr = noiseThreshold;
      const now = performance.now();

      if (now - lastLog > 2000) {
        lastLog = now;
        log(`level=${level.toFixed(3)} thr=${thr} ${level > thr ? "NOISE" : "quiet"}`);
      }

      if (level > thr) {
        aboveSince = aboveSince || now;
        belowSince = 0;
        if (!noisy && now - aboveSince > 250) {
          noisy = true;
          sendControl({ status: "noise", level });
        }
      } else {
        belowSince = belowSince || now;
        aboveSince = 0;
        if (noisy && now - belowSince > 1500) {
          noisy = false;
          sendControl({ status: "quiet", level });
        }
      }
      if (now - lastSent > 300) {
        lastSent = now;
        sendControl({ status: noisy ? "noise" : "quiet", level });
      }
    }, 200);
  }

  // --- parent status UI + lock-screen presence ---
  function updateBabyStatus(status, level) {
    const pill = $("statusPill");
    pill.hidden = false;
    const noise = status === "noise";
    pill.classList.toggle("noise", noise);
    $("statusText").textContent = noise ? "Noise detected" : "Quiet";
    $("meterFill").style.width = `${Math.min(100, Math.round((level / METER_MAX) * 100))}%`;
    // Noise gate: only play the baby's audio when it's above the threshold.
    // Uses the baby's hysteresis (quick to open, 1.5 s release) so tails aren't chopped.
    remoteVideo.muted = !noise;
    if (noise && !updateBabyStatus._was) {
      navigator.vibrate && navigator.vibrate(500);
    }
    updateBabyStatus._was = noise;
    updateMediaSession(noise ? "Noise detected" : "Quiet");
  }

  function updateMediaSession(statusText) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Baby Monitor",
        artist: statusText,
        album: `Room ${room}`
      });
      navigator.mediaSession.playbackState = "playing";
    } catch {}
  }

  // --- talk-back (parent): mic opens for 8 s with a countdown, then auto-closes ---
  function setupMicToggle(audioTrack) {
    const btn = $("talk");
    btn.hidden = false;
    const OPEN_SECONDS = 8;
    let countdown = null;

    const close = () => {
      clearInterval(countdown);
      countdown = null;
      audioTrack.enabled = false;
      btn.classList.remove("live");
      btn.textContent = "🎤 Mic off";
    };
    const open = () => {
      audioTrack.enabled = true;
      btn.classList.add("live");
      let remaining = OPEN_SECONDS;
      btn.textContent = `🎙️ Talking · ${remaining}s`;
      clearInterval(countdown);
      countdown = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) return close(); // auto-close for safety
        btn.textContent = `🎙️ Talking · ${remaining}s`;
      }, 1000);
    };

    btn.onclick = () => (audioTrack.enabled ? close() : open());
    close(); // start closed
  }

  // --- parent: live threshold slider (the gate/alert level) ---
  function setMarker() {
    const m = $("meterThresh");
    if (m) m.style.left = `${Math.min(100, (noiseThreshold / METER_MAX) * 100)}%`;
  }
  function setupSensitivity() {
    $("threshWrap").hidden = false;
    const apply = (v) => {
      sensLevel = Math.max(1, Math.min(10, v));
      noiseThreshold = sensToThreshold(sensLevel);
      try {
        localStorage.setItem("bibino-sens", String(sensLevel));
      } catch {}
      sendControl({ setThreshold: noiseThreshold }); // apply on the baby live
      $("threshVal").textContent = `${sensLevel}`;
      setMarker();
    };
    $("sensDown").onclick = () => apply(sensLevel - 1);
    $("sensUp").onclick = () => apply(sensLevel + 1);
    apply(sensLevel);
  }

  // --- baby dim screen + wake lock ---
  let wakeLock = null;
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      log("wake lock acquired");
    } catch (e) {
      log("wake lock failed:", e.name);
    }
  }
  function setupDimButton() {
    const btn = $("dim");
    btn.hidden = false;
    const dim = $("dimOverlay");
    let fadeTimer;
    const showDim = () => {
      dim.hidden = false;
      dim.classList.remove("dark");
      clearTimeout(fadeTimer);
      // Fade the hint to pure black after a few seconds for minimal light output.
      fadeTimer = setTimeout(() => dim.classList.add("dark"), 4000);
    };
    const wake = () => {
      clearTimeout(fadeTimer);
      dim.hidden = true;
    };
    btn.onclick = () => (dim.hidden ? showDim() : wake()); // re-arms every time
    dim.onclick = wake;
  }

  // --- Start gesture ---
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) await new Ctx().resume().catch(() => {});
    } catch {}
    remoteVideo.muted = false;
    remoteAudio.muted = false;
    try {
      await acquireLocalMedia();
    } catch (err) {
      log("getUserMedia failed:", err.name || err.message);
      setStatus(isBaby ? "Cannot access camera/mic — check permissions." : "Cannot access microphone.");
      startBtn.disabled = false;
      return;
    }
    userStarted = true;
    startBtn.hidden = true;
    if (isBaby) {
      setupDimButton();
      requestWakeLock();
      startNoiseWatch();
    } else {
      setupSensitivity();
      updateMediaSession("Quiet");
      setupAlertsButton(); // notifications are opted in via their own button/gesture
    }
    // Join signaling only now: "peer present" then means "peer has started with media",
    // so negotiation never happens with missing tracks (fixes the Start-order bug).
    connectSocket();
  };

  // Notifications are opted in with a dedicated button so the permission prompt
  // gets its own user gesture (chaining it with getUserMedia breaks Start on iOS).
  function setupAlertsButton() {
    const btn = $("alerts");
    if (!("Notification" in window)) {
      btn.hidden = true; // e.g. iOS Safari tab (not installed to home screen)
      return;
    }
    btn.hidden = false;
    if (Notification.permission === "granted") {
      btn.textContent = "🔔 Alerts on";
      btn.disabled = true;
      setupPush();
      return;
    }
    btn.onclick = async () => {
      btn.disabled = true;
      await setupPush();
      if (Notification.permission === "granted") {
        btn.textContent = "🔔 Alerts on";
      } else {
        btn.textContent = "🔔 Enable alerts";
        btn.disabled = false;
      }
    };
  }

  // --- push notifications (parent): noise alerts on the lock screen ---
  async function setupPush(permPromise) {
    if (!("Notification" in window)) return log("notifications unsupported (install to home screen on iOS)");
    let perm;
    try {
      perm = permPromise ? await permPromise : await Notification.requestPermission();
    } catch {
      return log("notification permission request failed");
    }
    if (perm !== "granted") return log("notifications not granted:", perm);
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return log("push unsupported (no SW/Push)");
    try {
      // Don't hang forever if the service worker never registers (e.g. untrusted cert on iOS).
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error("service worker not ready — cert not trusted?")), 4000))
      ]);
      const key = (await (await fetch("/vapid-public-key")).text()).trim();
      if (!key) return log("push disabled on server");
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key)
        });
      }
      await fetch("/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room, role, subscription: sub })
      });
      log("push notifications registered");
    } catch (e) {
      // On iOS this throws unless the app is installed to the home screen.
      log("push setup failed (install to home screen on iOS):", e.message);
    }
  }
  function urlBase64ToUint8Array(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  // Re-acquire the wake lock if the baby page comes back to the foreground.
  document.addEventListener("visibilitychange", () => {
    if (isBaby && document.visibilityState === "visible" && userStarted) requestWakeLock();
  });

  function teardown() {
    try { ws && ws.close(); } catch {}
    try { pc && pc.close(); } catch {}
    try { wakeLock && wakeLock.release(); } catch {}
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
  }
  $("leave").onclick = () => {
    teardown();
    location.search = "";
  };
  window.addEventListener("pagehide", teardown);

  startBtn.hidden = false;
  setStatus(isBaby ? "Tap Start — camera + mic" : "Tap Start — watch, listen & talk");
  // Signaling connects on Start (see the Start handler).
}

// ---- Entry ----------------------------------------------------------------
// Register the service worker (enables PWA install + push). Harmless if absent.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.log("SW register failed", e));
}

const role = qs.get("role");
const room = qs.get("room");
if ((role === "baby" || role === "parent") && room) initSession(role, room);
else initLanding();
