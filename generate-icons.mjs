// Generate simple PNG app icons (no image libraries): a brand-blue rounded tile
// with a soft white "monitor" dot. Enough for PWA installability + iOS home screen.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const bg = [0x5b, 0x8c, 0xff]; // brand blue
  const dot = [0xff, 0xff, 0xff];
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.28;
  const radius = size * 0.22; // rounded-corner radius

  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // rounded tile mask
      const inCorner =
        (x < radius && y < radius && Math.hypot(radius - x, radius - y) > radius) ||
        (x > size - radius && y < radius && Math.hypot(x - (size - radius), radius - y) > radius) ||
        (x < radius && y > size - radius && Math.hypot(radius - x, y - (size - radius)) > radius) ||
        (x > size - radius && y > size - radius && Math.hypot(x - (size - radius), y - (size - radius)) > radius);
      const inDot = Math.hypot(x - cx, y - cy) < r;
      let col, a;
      if (inCorner) {
        col = [0, 0, 0];
        a = 0;
      } else if (inDot) {
        col = dot;
        a = 255;
      } else {
        col = bg;
        a = 255;
      }
      raw[p++] = col[0];
      raw[p++] = col[1];
      raw[p++] = col[2];
      raw[p++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "public", "icons");
fs.mkdirSync(dir, { recursive: true });
for (const s of [180, 192, 512]) {
  fs.writeFileSync(path.join(dir, `icon-${s}.png`), png(s));
  console.log("wrote", `icons/icon-${s}.png`);
}
