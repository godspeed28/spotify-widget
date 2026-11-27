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
// HELPERS
// ==========================================

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

async function fetchCover(track) {
  const images = track?.album?.images || [];
  // Pakai ukuran sedang (~300px) supaya SVG tetap ringan
  const url = (images[1] || images[0])?.url;
  if (!url) return "";

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error("Gagal mengambil cover album.");

    const contentType = res.headers.get("content-type") || "";
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(contentType.split(";")[0])) {
      throw new Error("Format gambar tidak didukung.");
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) {
      throw new Error("Ukuran cover terlalu besar.");
    }

    return `data:${contentType.split(";")[0]};base64,${buf.toString(
      "base64"
    )}`;
  } catch (error) {
    console.error("Album Cover Error:", error.message);
    return "";
  }
}

// ==========================================
// CREATE SVG
// ==========================================
//
// state: "playing" | "paused" | "idle" | "error"

async function createSVG(track, state = "idle") {
  const W = 520;
  const H = 150;
  const accent = "#1ED760";

  const hasTrack = !!track && (state === "playing" || state === "paused");
  const playing = state === "playing";

  // ---- Teks ----
  let title, subtitle, status;

  if (hasTrack) {
    title = trunc(track.name, 25);
    subtitle = trunc(
      (track.artists || []).map((a) => a.name).join(", "),
      36
    );
    status = playing ? "Now playing" : "Paused";
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
  const duration = hasTrack ? track.duration_ms || 0 : 0;
  const progress = hasTrack
    ? Math.min(Math.max(track.progress_ms || 0, 0), duration)
    : 0;
  const fill = duration ? barW * (progress / duration) : 0;

  // ---- Cover ----
  const cover = hasTrack ? await fetchCover(track) : "";

  // Cover (atau placeholder) didefinisikan sekali, dipakai ulang
  // untuk latar blur, sampul, dan label piringan hitam
  const coverDef = cover
    ? `<image id="cov" width="100" height="100"
              preserveAspectRatio="xMidYMid slice"
              href="${cover}" xlink:href="${cover}"/>`
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

  const spin = playing
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
        : `<rect x="${b.x}" y="36" width="3" height="4" rx="1.5" fill="#6b6b6b"/>`
    )
    .join("");

  const statusColor = playing ? accent : "#8a8a8a";

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">

  <defs>
    ${coverDef}

    <linearGradient id="ph" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2f2f2f"/>
      <stop offset="1" stop-color="#1c1c1c"/>
    </linearGradient>

    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0a0a0a" stop-opacity="0.55"/>
      <stop offset="0.45" stop-color="#0a0a0a" stop-opacity="0.78"/>
      <stop offset="1" stop-color="#0a0a0a" stop-opacity="0.9"/>
    </linearGradient>

    <linearGradient id="vinylTone" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b1b1b"/>
      <stop offset="1" stop-color="#050505"/>
    </linearGradient>

    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.65"/>
      <stop offset="1" stop-color="${accent}"/>
    </linearGradient>

    <clipPath id="card"><rect width="${W}" height="${H}" rx="18"/></clipPath>
    <clipPath id="sleeve"><rect x="18" y="19" width="112" height="112" rx="10"/></clipPath>
    <clipPath id="label"><circle cx="150" cy="75" r="20"/></clipPath>

    <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>

    <filter id="shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="0.55"/>
    </filter>
  </defs>

  <g clip-path="url(#card)">

    <!-- Latar: sampul album diblur -->
    <rect width="${W}" height="${H}" fill="#101010"/>
    <g filter="url(#blur)" opacity="0.9">
      <use href="#cov" xlink:href="#cov" transform="translate(-40,-210) scale(6)"/>
    </g>
    <rect width="${W}" height="${H}" fill="url(#shade)"/>

    <!-- Piringan hitam (di belakang sampul) -->
    <g filter="url(#shadow)">
      <g>
        ${spin}
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
          font-family="'Segoe UI', Helvetica, Arial, sans-serif"
          font-size="12" font-weight="600">${esc(status)}</text>

    <!-- Logo Spotify -->
    <g transform="translate(488,34)">
      <circle r="11" fill="${accent}"/>
      <g fill="none" stroke="#101010" stroke-linecap="round">
        <path d="M-6 -3.5 C-2 -5 2 -5 6.5 -2.5" stroke-width="1.9"/>
        <path d="M-5 0 C-2 -1.2 2 -1.2 5.5 0.8" stroke-width="1.6"/>
        <path d="M-4 3.4 C-1.5 2.5 1.5 2.5 4.2 3.9" stroke-width="1.3"/>
      </g>
    </g>

    <!-- Judul & artis -->
    <text x="${barX}" y="72" fill="#ffffff"
          font-family="'Segoe UI', Helvetica, Arial, sans-serif"
          font-size="21" font-weight="700">${esc(title)}</text>

    <text x="${barX}" y="94" fill="#c4c4c4"
          font-family="'Segoe UI', Helvetica, Arial, sans-serif"
          font-size="14">${esc(subtitle)}</text>

    <!-- Progress -->
    <rect x="${barX}" y="108" width="${barW}" height="4" rx="2"
          fill="#ffffff" fill-opacity="0.18"/>
    ${
      fill > 0
        ? `<rect x="${barX}" y="108" width="${fill.toFixed(1)}" height="4" rx="2" fill="url(#bar)"/>
           <circle cx="${(barX + fill).toFixed(1)}" cy="110" r="5" fill="#fff"/>`
        : ""
    }

    <text x="${barX}" y="132" fill="#9a9a9a"
          font-family="'Segoe UI', Helvetica, Arial, sans-serif"
          font-size="11">${hasTrack ? fmtTime(progress) : "0:00"}</text>
    <text x="${barX + barW}" y="132" fill="#9a9a9a" text-anchor="end"
          font-family="'Segoe UI', Helvetica, Arial, sans-serif"
          font-size="11">${hasTrack ? fmtTime(duration) : "0:00"}</text>
  </g>

  <!-- Garis tepi kartu -->
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="17.5"
        fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
</svg>`;
}

// ==========================================
// NOW PLAYING ROUTE
// ==========================================

app.get("/now-playing", async (req, res) => {
  try {
    const token = await getAccessToken();

    const response = await fetch(
      "https://api.spotify.com/v1/me/player/currently-playing",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    let svg;

    if (response.status === 204) {
      svg = await createSVG(null, "idle");
    } else if (!response.ok) {
      throw new Error(`Spotify API Error: ${response.status}`);
    } else {
      const data = await response.json();

      if (data.item) {
        svg = await createSVG(
          { ...data.item, progress_ms: data.progress_ms },
          data.is_playing ? "playing" : "paused"
        );
      } else {
        svg = await createSVG(null, "idle");
      }
    }

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=30, stale-while-revalidate=15"
    );

    return res.status(200).send(svg);
  } catch (error) {
    console.error("Spotify Now Playing Error:", error);

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");

    return res.status(500).send(await createSVG(null, "error"));
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