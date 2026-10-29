// Generate (once) a self-signed certificate so the app can be served over
// HTTPS. Browsers block camera/microphone access on non-secure origins, and a
// LAN IP is never "localhost", so TLS is mandatory for a real device-to-device
// baby monitor.
//
// The certificate MUST carry a subjectAltName covering the hostnames/IPs the
// devices use, or strict engines (WebKit/iOS especially) reject it even after
// you tap "proceed". We include localhost, 127.0.0.1, every detected LAN IPv4,
// and anything listed in the CERT_HOSTS env var (comma-separated), which is how
// you add the host's real LAN IP when the server runs inside WSL/Docker and
// only sees an internal address itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";

function hostList() {
  const hosts = new Set(["localhost", "127.0.0.1"]);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) hosts.add(a.address);
    }
  }
  for (const h of (process.env.CERT_HOSTS || "").split(",")) {
    const t = h.trim();
    if (t) hosts.add(t);
  }
  return [...hosts];
}

const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

export async function ensureCerts(dir) {
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  const hosts = hostList();
  const altNames = hosts.map((h) => (isIp(h) ? { type: 7, ip: h } : { type: 2, value: h }));

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const attrs = [{ name: "commonName", value: hosts.find((h) => !isIp(h)) || hosts[0] }];
  const notAfterDate = new Date();
  notAfterDate.setDate(notAfterDate.getDate() + 3650); // ~10 years
  // selfsigned v5 is async and uses Node's native crypto (no node-forge).
  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate,
    extensions: [
      { name: "basicConstraints", cA: true },
      { name: "subjectAltName", altNames }
    ]
  });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 }); // private key — owner-only
  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
  console.log("  Generated self-signed certificate for:", hosts.join(", "));
  return { key: pems.private, cert: pems.cert };
}
