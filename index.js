
const express = require("express");
const sharp = require("sharp");

const app = express();

// ========================================
// SPOTIFY CONFIGURATION
// ========================================

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;

let cachedToken = null;
let tokenExpiry = 0;

// ========================================
// GET SPOTIFY ACCESS TOKEN
// ========================================

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Spotify environment variables belum diatur.");
  }

  const basic = Buffer.from(
    `${CLIENT_ID}:${CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Token refresh gagal: ${response.status} ${error}`
    );
  }

  const data = await response.json();

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;

  return cachedToken;
}

// ========================================
// ESCAPE XML
// ========================================

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ========================================
// CREATE NOW PLAYING IMAGE
// ========================================

async function createImage(track) {
  const width = 480;
  const height = 140;

  const bg = "#121212";
  const accent = "#1DB954";

  // Jika tidak ada lagu yang diputar
  if (!track) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg"
           width="${width}"
           height="${height}"
           viewBox="0 0 ${width} ${height}">

        <rect width="100%" height="100%"
              rx="12" fill="${bg}"/>

        <text x="240" y="65"
              text-anchor="middle"
              fill="#ffffff"
              font-family="Arial"
              font-size="18"
              font-weight="bold">
          Nothing Playing
        </text>

        <text x="240" y="90"
              text-anchor="middle"
              fill="#b3b3b3"
              font-family="Arial"
              font-size="13">
          Play something on Spotify
        </text>
      </svg>
    `;

    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  // Informasi lagu
  const name = esc(track.name).slice(0, 38);

  const artists = esc(
    (track.artists || [])
      .map((artist) => artist.name)
      .join(", ")
  ).slice(0, 48);

  const duration = track.duration_ms || 0;

  const progress = Math.min(
    Math.max(track.progress_ms || 0, 0),
    duration
  );

  const trackWidth = 310;

  const barWidth = duration
    ? trackWidth * (progress / duration)
    : 0;

  // ========================================
  // DOWNLOAD ALBUM COVER
  // ========================================

  let coverBuffer = null;

  const coverUrl = track.album?.images?.[0]?.url;

  if (coverUrl) {
    try {
      const coverResponse = await fetch(coverUrl);

      if (!coverResponse.ok) {
        throw new Error("Cover album gagal diunduh.");
      }

      const contentType =
        coverResponse.headers.get("content-type") || "";

      if (!contentType.startsWith("image/")) {
        throw new Error("Format cover album tidak valid.");
      }

      const imageBuffer = Buffer.from(
        await coverResponse.arrayBuffer()
      );

      if (imageBuffer.length > 5 * 1024 * 1024) {
        throw new Error("Ukuran cover album terlalu besar.");
      }

      coverBuffer = await sharp(imageBuffer)
        .resize(108, 108, {
          fit: "cover",
          position: "centre",
        })
        .png()
        .toBuffer();

    } catch (error) {
      console.error("Cover Error:", error.message);
    }
  }

  // ========================================
  // CREATE SVG LAYOUT
  // ========================================

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg"
         width="${width}"
         height="${height}"
         viewBox="0 0 ${width} ${height}">

      <rect width="100%" height="100%"
            rx="12" fill="${bg}"/>

      ${
        !coverBuffer
          ? `<rect x="16" y="16"
                  width="108" height="108"
                  rx="8" fill="#282828"/>`
          : ""
      }

      <text x="140" y="48"
            fill="#ffffff"
            font-family="Arial, sans-serif"
            font-size="18"
            font-weight="bold">
        ${name}
      </text>

      <text x="140" y="74"
            fill="#b3b3b3"
            font-family="Arial, sans-serif"
            font-size="14">
        ${artists}
      </text>

      <rect x="140" y="94"
            width="${trackWidth}"
            height="5"
            rx="2.5"
            fill="#333333"/>

      <rect x="140" y="94"
            width="${barWidth}"
            height="5"
            rx="2.5"
            fill="${accent}"/>

      <text x="140" y="120"
            fill="#777777"
            font-family="Arial, sans-serif"
            font-size="10"
            letter-spacing="1">
        SPOTIFY NOW PLAYING
      </text>

      <circle cx="450" cy="115"
              r="5" fill="${accent}"/>

    </svg>
  `;

  // ========================================
  // COMBINE COVER + SVG INTO PNG
  // ========================================

  let image = sharp(Buffer.from(svg));

  if (coverBuffer) {
    image = image.composite([
      {
        input: coverBuffer,
        left: 16,
        top: 16,
      },
    ]);
  }

  return image.png().toBuffer();
}

// ========================================
// NOW PLAYING ENDPOINT
// ========================================

app.get("/now-playing", async (req, res) => {
  try {
    const token = await getAccessToken();

    const response = await fetch(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    let image;

    if (response.status === 204) {
      image = await createImage(null);
    } else if (!response.ok) {
      throw new Error(
        `Spotify API Error: ${response.status}`
      );
    } else {
      const data = await response.json();

      image = data.is_playing && data.item
        ? await createImage({
            ...data.item,
            progress_ms: data.progress_ms,
          })
        : await createImage(null);
    }

    res.setHeader("Content-Type", "image/png");

    res.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=30, stale-while-revalidate=15"
    );

    return res.status(200).send(image);

  } catch (error) {
    console.error("Now Playing Error:", error);

    try {
      const fallback = await createImage(null);

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-cache");

      return res.status(200).send(fallback);

    } catch (imageError) {
      console.error("Image Error:", imageError);
      return res.status(500).send("Internal Server Error");
    }
  }
});

// ========================================
// HOME ROUTE
// ========================================

app.get("/", (req, res) => {
  res.redirect("/now-playing");
});

// ========================================
// EXPORT
// ========================================

module.exports = app;
