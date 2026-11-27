const express = require("express");
const app = express();

// ==========================================
// SPOTIFY ENVIRONMENT VARIABLES
// ==========================================

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;

// ==========================================
// ACCESS TOKEN CACHE
// ==========================================

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Spotify environment variables belum diatur.");
  }

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
    "base64"
  );

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh gagal: ${response.status} ${error}`);
  }

  const data = await response.json();

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;

  return cachedToken;
}

// ==========================================
// GENERAL HELPERS
// ==========================================

const DEFAULT_ACCENT = "#1ED760";
const FONT = "'Segoe UI', Helvetica, Arial, sans-serif";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Potong teks SEBELUM di-escape supaya entity XML tidak terpotong
function trunc(value, max) {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function fmtTime(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ==========================================
// COLOR HELPERS (aksen dari cover)
// ==========================================

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const hex = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// Ambil warna dominan yang "hidup" dari cover.
// Butuh paket `sharp` (npm i sharp). Kalau tidak ada, balik ke hijau Spotify.
async function dominantHsl(buf) {
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    return null;
  }

  try {
    const { data } = await sharp(buf)
      .resize(32, 32, { fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = Array.from({ length: 12 }, () => ({
      w: 0,
      h: 0,
      s: 0,
      l: 0,
    }));

    for (let i = 0; i < data.length; i += 3) {
      const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      if (l < 0.12 || l > 0.92) continue;

      // Prioritaskan warna jenuh dan tidak terlalu gelap/terang
      const w = s * s * (1 - Math.abs(l - 0.5) * 1.2);
      const b = buckets[Math.floor(h / 30) % 12];
      b.w += w;
      b.h += w * h;
      b.s += w * s;
      b.l += w * l;
    }

    const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
    if (best.w < 1) return null; // cover hampir hitam-putih

    return [best.h / best.w, best.s / best.w, best.l / best.w];
  } catch (error) {
    console.error("Accent Error:", error.message);
    return null;
  }
}

function makeAccent(hsl, theme) {
  if (!hsl) return DEFAULT_ACCENT;
  const [h, s] = hsl;
  return theme === "light"
    ? hslToHex(h, Math.max(s, 0.7), 0.4)
    : hslToHex(h, Math.max(s, 0.65), 0.6);
}

// ==========================================
// COVER CACHE (hindari unduh ulang tiap request)
// ==========================================

const coverCache = new Map();
const COVER_CACHE_MAX = 30;

function coverUrlOf(track) {
  const images =
    track?.album?.images || track?.images || track?.show?.images || [];
  // Pakai ukuran sedang (~300px) supaya SVG tetap ringan
  return (images[1] || images[0])?.url || "";
}

async function fetchCover(track) {
  const url = coverUrlOf(track);
  if (!url) return null;

  if (coverCache.has(url)) return coverCache.get(url);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error("Gagal mengambil cover album.");

    const mime = (res.headers.get("content-type") || "").split(";")[0];
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(mime)) {
      throw new Error("Format gambar tidak didukung.");
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) {
      throw new Error("Ukuran cover terlalu besar.");
    }

    const entry = {
      uri: `data:${mime};base64,${buf.toString("base64")}`,
      hsl: await dominantHsl(buf),
    };

    if (coverCache.size >= COVER_CACHE_MAX) {
      coverCache.delete(coverCache.keys().next().value);
    }
    coverCache.set(url, entry);

    return entry;
  } catch (error) {
    console.error("Album Cover Error:", error.message);
    return null;
  }
}

// ==========================================
// SPOTIFY DATA
// ==========================================
//
// Mengembalikan { state, track, playedAt }
// state: "playing" | "paused" | "last" | "idle"

async function getNowPlaying() {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const response = await fetch(
    "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode",
    { headers }
  );

  if (response.status !== 204 && !response.ok) {
    throw new Error(`Spotify API Error: ${response.status}`);
  }

  if (response.status !== 204) {
    const data = await response.json();
    if (data?.item) {
      return {
        state: data.is_playing ? "playing" : "paused",
        track: { ...data.item, progress_ms: data.progress_ms },
      };
    }
  }

  // Tidak ada yang diputar → tampilkan lagu terakhir.
  // Butuh scope `user-read-recently-played`; kalau belum ada, jatuh ke idle.
  try {
    const recent = await fetch(
      "https://api.spotify.com/v1/me/player/recently-played?limit=1",
      { headers }
    );
    if (recent.ok) {
      const data = await recent.json();
      const item = data?.items?.[0];
      if (item?.track) {
        return {
          state: "last",
          track: item.track,
          playedAt: item.played_at,
        };
      }
    }
  } catch (error) {
    console.error("Recently Played Error:", error.message);
  }

  return { state: "idle", track: null };
}

// ==========================================
// LYRICS (LRCLIB)
// ==========================================
// LRCLIB: database lirik komunitas, gratis, tanpa API key.
// Format LRC: "[mm:ss.xx] teks baris"

const lyricsCache = new Map();
const LYRICS_CACHE_MAX = 50;

function parseLrc(lrc) {
  if (!lrc) return null;
  const out = [];
  for (const raw of lrc.split("\n")) {
    const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (!m) continue;
    out.push({
      t: (Number(m[1]) * 60 + parseFloat(m[2])) * 1000,
      text: m[3].trim(),
    });
  }
  return out.length ? out : null;
}

async function getLyrics(track) {
  if (!track?.id || track.type === "episode") return null;
  if (lyricsCache.has(track.id)) return lyricsCache.get(track.id);

  let lines = null;
  try {
    const params = new URLSearchParams({
      track_name: track.name,
      artist_name: track.artists?.[0]?.name || "",
      album_name: track.album?.name || "",
      duration: String(Math.round((track.duration_ms || 0) / 1000)),
    });

    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { "User-Agent": "spotify-now-playing-card" },
      signal: AbortSignal.timeout(3000),
    });

    if (res.ok) lines = parseLrc((await res.json()).syncedLyrics);
  } catch (error) {
    console.error("Lyrics Error:", error.message);
  }

  if (lyricsCache.size >= LYRICS_CACHE_MAX) {
    lyricsCache.delete(lyricsCache.keys().next().value);
  }
  lyricsCache.set(track.id, lines);
  return lines;
}

// ------------------------------------------
// Tampilan lirik gaya karaoke 3 baris
// ------------------------------------------
// Tiap baris punya "slot" posisi: above (tersembunyi), prev (redup),
// cur (besar & terang), next (setengah redup), below (tersembunyi).
// Saat baris berganti, teks berpindah slot dengan animasi SMIL halus.

const LY = {
  above: { y: 160, size: 12,   op: 0 },
  prev:  { y: 177, size: 12.5, op: 0.38 },
  cur:   { y: 204, size: 16,   op: 1 },
  next:  { y: 225, size: 13,   op: 0.55 },
  below: { y: 244, size: 12,   op: 0 },
};

const lyState = (d) =>
  d <= -2 ? LY.above : d === -1 ? LY.prev : d === 0 ? LY.cur : d === 1 ? LY.next : LY.below;

const lyAnim = (attr, from, to, begin) =>
  `<animate attributeName="${attr}" from="${from}" to="${to}" begin="${begin}s"
     dur="0.4s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.4 0 0.2 1"/>`;

function lyricLines({ x, lines, progressMs, playing, font, color }) {
  // Baris yang sedang dinyanyikan
  let cur = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= progressMs) cur = i;
    else break;
  }

  const label = (i, max) => esc(trunc(lines[i].text || "♪", max));
  const out = [];

  // Paused: tampilkan 3 baris statis
  if (!playing) {
    for (let i = Math.max(cur - 1, 0); i <= Math.min(cur + 1, lines.length - 1); i++) {
      const s = lyState(i - cur);
      out.push(
        `<text x="${x}" y="${s.y}" text-anchor="middle" font-family="${font}"
           font-size="${s.size}" font-weight="600" fill="${color}"
           fill-opacity="${s.op}">${label(i, i === cur ? 50 : 56)}</text>`
      );
    }
    return out.join("");
  }

  // Playing: tiap baris punya animasi perpindahan slot
  const first = Math.max(cur - 1, 0);
  const last = Math.min(lines.length, cur + 16);

  for (let i = first; i < last; i++) {
    const s0 = lyState(i - cur);
    let anims = "";

    // Baris i berpindah slot tiap kali baris ke-k mulai dinyanyikan
    for (let k = Math.max(cur + 1, i - 1); k <= i + 2 && k < lines.length; k++) {
      const a = lyState(i - (k - 1));
      const b = lyState(i - k);
      const begin = Math.max((lines[k].t - progressMs) / 1000, 0.01).toFixed(2);
      anims +=
        lyAnim("y", a.y, b.y, begin) +
        lyAnim("font-size", a.size, b.size, begin) +
        lyAnim("fill-opacity", a.op, b.op, begin);
    }

    out.push(
      `<text x="${x}" y="${s0.y}" text-anchor="middle" font-family="${font}"
         font-size="${s0.size}" font-weight="600" fill="${color}"
         fill-opacity="${s0.op}">${label(i, 50)}${anims}</text>`
    );
  }

  return out.join("");
}

// ==========================================
// CREATE SVG
// ==========================================

const THEMES = {
  dark: {
    base: "#101010",
    shade: "#0a0a0a",
    shadeOpacity: [0.55, 0.78, 0.9],
    main: "#ffffff",
    sub: "#c4c4c4",
    dim: "#9a9a9a",
    muted: "#6b6b6b",
    trackBg: "#ffffff",
    trackBgOpacity: 0.18,
    edge: "#ffffff",
    edgeOpacity: 0.08,
    knob: "#ffffff",
  },
  light: {
    base: "#efefef",
    shade: "#fbfbfb",
    shadeOpacity: [0.6, 0.82, 0.92],
    main: "#141414",
    sub: "#4a4a4a",
    dim: "#6c6c6c",
    muted: "#a0a0a0",
    trackBg: "#000000",
    trackBgOpacity: 0.14,
    edge: "#000000",
    edgeOpacity: 0.1,
    knob: "#141414",
  },
};

// ==========================================
// LIVE ELAPSED TIME
// ==========================================
// Tiap digit adalah gulungan angka yang bergeser otomatis (SMIL),
// jadi waktu berjalan sendiri tanpa JavaScript. Offset negatif pada
// `begin` membuat animasi langsung mulai dari posisi lagu saat ini.

function liveElapsed({ x, y, progressMs, durationMs, font, color }) {
  const progressSec = progressMs / 1000;
  const remaining = Math.max((durationMs - progressMs) / 1000, 0);
  const ROW = 14;

  const roll = (cx, count, stepSec, offsetSec) => {
    const cycle = count * stepSec;
    const values = Array.from({ length: count }, (_, i) => `0 ${-i * ROW}`).join(";");
    const keyTimes = Array.from({ length: count }, (_, i) => (i / count).toFixed(4)).join(";");
    const digits = Array.from(
      { length: count },
      (_, i) => `<text x="0" y="${i * ROW}" text-anchor="middle">${i}</text>`
    ).join("");

    return `
      <g transform="translate(${cx.toFixed(1)},${y})" clip-path="url(#dig)">
        <g>
          ${digits}
          <animateTransform attributeName="transform" type="translate"
            calcMode="discrete" values="${values}" keyTimes="${keyTimes}"
            dur="${cycle}s" begin="-${offsetSec.toFixed(3)}s"
            repeatDur="${(remaining + offsetSec).toFixed(3)}s" fill="freeze"/>
        </g>
      </g>`;
  };

  return `
    <g font-family="${font}" font-size="11" fill="${color}">
      ${roll(x + 3, 10, 60, progressSec % 600)}
      <text x="${x + 7.2}" y="${y}" text-anchor="middle">:</text>
      ${roll(x + 12, 6, 10, progressSec % 60)}
      ${roll(x + 18.3, 10, 1, progressSec % 10)}
    </g>`;
}

async function createSVG({
  track = null,
  state = "idle",
  playedAt = null,
  theme = "dark",
  accentOverride = null,
  spin = true,
  lyrics = null,
} = {}) {
  const W = 520;
  const showLyrics = !!lyrics && (state === "playing" || state === "paused");
  const H = showLyrics ? 236 : 150; // kartu lebih tinggi kalau ada lirik
  const t = THEMES[theme] || THEMES.dark;

  const hasTrack = !!track && ["playing", "paused", "last"].includes(state);
  const playing = state === "playing";

  // ---- Cover & aksen ----
  const cover = hasTrack ? await fetchCover(track) : null;
  const accent = accentOverride || makeAccent(cover?.hsl, theme);

  // ---- Teks ----
  let title, subtitle, status;

  if (hasTrack) {
    title = trunc(track.name, 80);
    const names = (track.artists || []).map((a) => a.name);
    subtitle = trunc(
      (names.length ? names : [track.show?.publisher || track.show?.name])
        .filter(Boolean)
        .join(", "),
      38
    );
    status =
      state === "playing"
        ? "Now playing"
        : state === "paused"
        ? "Paused"
        : "Last played";
  } else if (state === "error") {
    title = "Can't reach Spotify";
    subtitle = "Try again in a moment";
    status = "Offline";
  } else {
    title = "Nothing playing";
    subtitle = "Play something on Spotify";
    status = "Idle";
  }

  // ---- Progress ----
  const barX = 228;
  const barW = 272;
  const showBar = state === "playing" || state === "paused";
  const duration = showBar ? track.duration_ms || 0 : 0;
  const progress = showBar
    ? Math.min(Math.max(track.progress_ms || 0, 0), duration)
    : 0;
  const fill = duration ? barW * (progress / duration) : 0;

  // ---- Marquee untuk judul panjang ----
  const estWidth = title.length * 21 * 0.55;
  const overflow = Math.ceil(estWidth - barW);
  const marquee = hasTrack && overflow > 0;
  const marqueeDur = Math.max(8, (overflow / 28) * 2 + 4).toFixed(1);

  const titleAnim = marquee
    ? `<animateTransform attributeName="transform" type="translate"
         values="0 0;0 0;-${overflow + 12} 0;-${overflow + 12} 0;0 0"
         keyTimes="0;0.15;0.55;0.72;1"
         dur="${marqueeDur}s" repeatCount="indefinite"/>`
    : "";

  // ---- Cover (atau placeholder) didefinisikan sekali, dipakai ulang ----
  const coverDef = cover
    ? `<image id="cov" width="100" height="100"
              preserveAspectRatio="xMidYMid slice"
              href="${cover.uri}" xlink:href="${cover.uri}"/>`
    : `<g id="cov">
         <rect width="100" height="100" fill="url(#ph)"/>
         <circle cx="40" cy="68" r="9" fill="#555"/>
         <rect x="47" y="30" width="4" height="38" fill="#555"/>
         <path d="M51 30 L66 36 L66 44 L51 38 Z" fill="#555"/>
       </g>`;

  // ---- Piringan hitam ----
  const grooves = [50, 44, 38, 32, 26]
    .map(
      (r) =>
        `<circle cx="150" cy="75" r="${r}" fill="none"
                 stroke="#ffffff" stroke-opacity="0.06"/>`
    )
    .join("");

  const spinAnim =
    playing && spin
      ? `<animateTransform attributeName="transform" type="rotate"
           from="0 150 75" to="360 150 75" dur="9s" repeatCount="indefinite"/>`
      : "";

  // ---- Equalizer ----
  const eqSpecs = [
    { x: 228, dur: "0.9s", y: "35;27;33;25;35", h: "5;13;7;15;5" },
    { x: 234, dur: "0.7s", y: "31;36;26;32;31", h: "9;4;14;8;9" },
    { x: 240, dur: "1.1s", y: "34;25;31;36;34", h: "6;15;9;4;6" },
    { x: 246, dur: "0.8s", y: "29;34;27;33;29", h: "11;6;13;7;11" },
  ];

  const eq = eqSpecs
    .map((b) =>
      playing
        ? `<rect x="${b.x}" y="35" width="3" height="5" rx="1.5" fill="${accent}">
             <animate attributeName="y" values="${b.y}" dur="${b.dur}" repeatCount="indefinite"/>
             <animate attributeName="height" values="${b.h}" dur="${b.dur}" repeatCount="indefinite"/>
           </rect>`
        : `<rect x="${b.x}" y="36" width="3" height="4" rx="1.5" fill="${t.muted}"/>`
    )
    .join("");

  const statusColor = playing ? accent : t.dim;

  // ---- Baris bawah ----
  let footer = "";
  if (showBar) {
    const remaining = Math.max((duration - progress) / 1000, 0);
    const live = playing && remaining > 0;
    const liveTime = live && duration < 600000;

    const barAnim = live
      ? `<animate attributeName="width" from="${fill.toFixed(1)}" to="${barW}"
           dur="${remaining.toFixed(3)}s" fill="freeze"/>`
      : "";
    const knobAnim = live
      ? `<animate attributeName="cx" from="${(barX + fill).toFixed(1)}" to="${barX + barW}"
           dur="${remaining.toFixed(3)}s" fill="freeze"/>`
      : "";

    const elapsed = liveTime
      ? liveElapsed({
          x: barX,
          y: 132,
          progressMs: progress,
          durationMs: duration,
          font: FONT,
          color: t.dim,
        })
      : `<text x="${barX}" y="132" fill="${t.dim}" font-family="${FONT}" font-size="11">${fmtTime(progress)}</text>`;

    footer = `
    <rect x="${barX}" y="108" width="${barW}" height="4" rx="2"
          fill="${t.trackBg}" fill-opacity="${t.trackBgOpacity}"/>
    <rect x="${barX}" y="108" width="${fill.toFixed(1)}" height="4" rx="2" fill="url(#bar)">${barAnim}</rect>
    <circle cx="${(barX + fill).toFixed(1)}" cy="110" r="5" fill="${t.knob}">${knobAnim}</circle>
    ${elapsed}
    <text x="${barX + barW}" y="132" fill="${t.dim}" text-anchor="end" font-family="${FONT}" font-size="11">${fmtTime(duration)}</text>`;
  } else if (state === "last" && playedAt) {
    footer = `
    <text x="${barX}" y="124" fill="${t.dim}" font-family="${FONT}" font-size="12">Played ${esc(
      ago(playedAt)
    )}</text>`;
  }

  // ---- Lirik (karaoke 3 baris) ----
  const lyricsSvg = showLyrics
    ? `<rect x="0" y="150" width="${W}" height="${H - 150}" fill="${t.edge}" fill-opacity="0.04"/>
       <line x1="18" y1="150" x2="${W - 18}" y2="150" stroke="${t.edge}" stroke-opacity="0.1"/>
       <g mask="url(#lyfade)">
         ${lyricLines({
           x: W / 2,
           lines: lyrics,
           progressMs: progress,
           playing,
           font: FONT,
           color: t.main,
         })}
       </g>`
    : "";

  const [s0, s1, s2] = t.shadeOpacity;

  const a11y = hasTrack
    ? `${status}: ${track.name}${subtitle ? " by " + subtitle : ""}`
    : title;

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="${esc(a11y)}">

  <title>${esc(a11y)}</title>
  <desc>Spotify now playing card</desc>

  <defs>
    ${coverDef}

    <linearGradient id="ph" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2f2f2f"/>
      <stop offset="1" stop-color="#1c1c1c"/>
    </linearGradient>

    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${t.shade}" stop-opacity="${s0}"/>
      <stop offset="0.45" stop-color="${t.shade}" stop-opacity="${s1}"/>
      <stop offset="1" stop-color="${t.shade}" stop-opacity="${s2}"/>
    </linearGradient>

    <linearGradient id="vinylTone" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b1b1b"/>
      <stop offset="1" stop-color="#050505"/>
    </linearGradient>

    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.6"/>
      <stop offset="1" stop-color="${accent}"/>
    </linearGradient>

    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>

    <clipPath id="card"><rect width="${W}" height="${H}" rx="18"/></clipPath>
    <clipPath id="sleeve"><rect x="18" y="19" width="112" height="112" rx="10"/></clipPath>
    <clipPath id="label"><circle cx="150" cy="75" r="20"/></clipPath>
    <clipPath id="dig"><rect x="-5" y="-11" width="10" height="14"/></clipPath>
    <clipPath id="txt"><rect x="${barX}" y="50" width="${barW}" height="34"/></clipPath>

    <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>

    <filter id="shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="0.55"/>
    </filter>

    <!-- Fade atas & bawah untuk area lirik -->
    <linearGradient id="lyg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.2" stop-color="#fff"/>
      <stop offset="0.85" stop-color="#fff"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="lyfade" maskUnits="userSpaceOnUse" x="0" y="152" width="${W}" height="${H - 152}">
      <rect x="0" y="152" width="${W}" height="${H - 152}" fill="url(#lyg)"/>
    </mask>
  </defs>

  <g clip-path="url(#card)">

    <!-- Latar: sampul album diblur -->
    <rect width="${W}" height="${H}" fill="${t.base}"/>
    <g filter="url(#blur)" opacity="0.9">
      <use href="#cov" xlink:href="#cov" transform="translate(-40,-210) scale(6)"/>
    </g>
    <rect width="${W}" height="${H}" fill="url(#shade)"/>

    <!-- Cahaya aksen di belakang piringan -->
    <circle cx="150" cy="75" r="115" fill="url(#glow)"/>

    <!-- Piringan hitam (di belakang sampul) -->
    <g filter="url(#shadow)">
      <g>
        ${spinAnim}
        <circle cx="150" cy="75" r="56" fill="url(#vinylTone)"/>
        ${grooves}
        <path d="M150 75 L177 28.2 A54 54 0 0 1 200.7 56.5 Z" fill="#fff" fill-opacity="0.07"/>
        <path d="M150 75 L123 121.8 A54 54 0 0 1 99.3 93.5 Z" fill="#fff" fill-opacity="0.07"/>
        <g clip-path="url(#label)">
          <use href="#cov" xlink:href="#cov" transform="translate(130,55) scale(0.4)"/>
        </g>
        <circle cx="150" cy="75" r="20" fill="none" stroke="#000" stroke-opacity="0.35"/>
        <circle cx="150" cy="75" r="3.2" fill="#101010"/>
      </g>
    </g>

    <!-- Sampul album -->
    <g filter="url(#shadow)">
      <g clip-path="url(#sleeve)">
        <use href="#cov" xlink:href="#cov" transform="translate(18,19) scale(1.12)"/>
      </g>
    </g>
    <rect x="18.5" y="19.5" width="111" height="111" rx="9.5"
          fill="none" stroke="#fff" stroke-opacity="0.12"/>

    <!-- Status -->
    ${eq}
    <text x="256" y="40" fill="${statusColor}"
          font-family="${FONT}" font-size="12" font-weight="600">${esc(status)}</text>

    <!-- Logo Spotify -->
    <g transform="translate(488,34)">
      <circle r="11" fill="${DEFAULT_ACCENT}"/>
      <g fill="none" stroke="#101010" stroke-linecap="round">
        <path d="M-6 -3.5 C-2 -5 2 -5 6.5 -2.5" stroke-width="1.9"/>
        <path d="M-5 0 C-2 -1.2 2 -1.2 5.5 0.8" stroke-width="1.6"/>
        <path d="M-4 3.4 C-1.5 2.5 1.5 2.5 4.2 3.9" stroke-width="1.3"/>
      </g>
    </g>

    <!-- Judul (marquee kalau kepanjangan) -->
    <g clip-path="url(#txt)">
      <text x="${barX}" y="72" fill="${t.main}"
            font-family="${FONT}" font-size="21" font-weight="700">${esc(title)}${titleAnim}</text>
    </g>

    <!-- Artis -->
    <text x="${barX}" y="94" fill="${t.sub}"
          font-family="${FONT}" font-size="14">${esc(subtitle)}</text>

    ${footer}

    <!-- Lirik -->
    ${lyricsSvg}
  </g>

  <!-- Garis tepi kartu -->
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="17.5"
        fill="none" stroke="${t.edge}" stroke-opacity="${t.edgeOpacity}"/>
</svg>`;
}

// ==========================================
// QUERY OPTIONS
// ==========================================
//
//   ?theme=light        tema terang (default: dark)
//   ?accent=ff5500      paksa warna aksen (hex 6 digit, tanpa #)
//   ?spin=off           piringan tidak berputar
//   ?lyrics=on          tampilkan lirik synced (LRCLIB)

function readOptions(req) {
  const accent = String(req.query.accent || "");
  return {
    theme: req.query.theme === "light" ? "light" : "dark",
    accentOverride: /^[0-9a-f]{6}$/i.test(accent) ? `#${accent}` : null,
    spin: req.query.spin !== "off",
    wantLyrics: req.query.lyrics === "on",
  };
}

// ==========================================
// NOW PLAYING ROUTE
// ==========================================

app.get("/now-playing", async (req, res) => {
  const { wantLyrics, ...options } = readOptions(req);

  try {
    const np = await getNowPlaying();

    const lyrics =
      wantLyrics && (np.state === "playing" || np.state === "paused")
        ? await getLyrics(np.track)
        : null;

    const svg = await createSVG({ ...np, ...options, lyrics });

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=10, stale-while-revalidate=5"
    );

    return res.status(200).send(svg);
  } catch (error) {
    console.error("Spotify Now Playing Error:", error);

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");

    return res
      .status(500)
      .send(await createSVG({ state: "error", ...options }));
  }
});

// ==========================================
// TRACK LINK ROUTE
// ==========================================
// Dipakai supaya kartu di README bisa diklik:
// [![Spotify](https://domainmu.vercel.app/now-playing)](https://domainmu.vercel.app/track)

app.get("/track", async (req, res) => {
  try {
    const np = await getNowPlaying();
    const url =
      np.track?.external_urls?.spotify || "https://open.spotify.com";

    res.setHeader("Cache-Control", "no-cache");
    return res.redirect(302, url);
  } catch (error) {
    console.error("Track Redirect Error:", error.message);
    return res.redirect(302, "https://open.spotify.com");
  }
});

// ==========================================
// HOME ROUTE
// ==========================================

app.get("/", (req, res) => {
  res.redirect("/now-playing");
});

// ==========================================
// EXPORT APP FOR VERCEL
// ==========================================

module.exports = app;