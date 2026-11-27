const express = require('express');
const app = express();

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh gagal: ${res.status} ${err}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createSVG(track) {
  const width = 480, height = 140;
  const bg = '#121212';
  const accent = '#1DB954';

  if (!track) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" rx="12" fill="${bg}"/>
      <text x="24" y="76" fill="#b3b3b3" font-family="Arial, sans-serif" font-size="18">Tidak ada lagu yang diputar</text>
    </svg>`;
  }

  const name = esc(track.name).slice(0, 38);
  const artists = esc(track.artists.map(a => a.name).join(', ')).slice(0, 48);
  const progress = track.progress_ms || 0;
  const duration = track.duration_ms || 0;
  const barWidth = duration ? (width - 156) * (progress / duration) : 0;
  const coverUrl = track.album?.images?.[0]?.url || '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" rx="12" fill="${bg}"/>
    ${coverUrl ? `<image href="${coverUrl}" x="16" y="16" width="108" height="108" rx="8"/>` : ''}
    <text x="140" y="48" fill="#fff" font-family="Arial, sans-serif" font-size="18" font-weight="bold">${name}</text>
    <text x="140" y="74" fill="#b3b3b3" font-family="Arial, sans-serif" font-size="14">${artists}</text>
    <rect x="140" y="94" width="${width - 156}" height="4" rx="2" fill="#333"/>
    <rect x="140" y="94" width="${barWidth}" height="4" rx="2" fill="${accent}"/>
  </svg>`;
}

app.get('/now-playing', async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });

    let svg;
    if (response.status === 204 || !response.ok) {
      svg = createSVG(null);
    } else {
      const data = await response.json();
      svg = data.is_playing && data.item ? createSVG(data.item) : createSVG(null);
    }

   res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60'); 
    res.send(svg);
  } catch (err) {
    console.error(err);
    res.status(500).send(createSVG(null));
  }
});

app.get('/', (req, res) => res.redirect('/now-playing'));

module.exports = app;