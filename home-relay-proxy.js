#!/usr/bin/env node
/**
 * Live TV — home relay (plain Node.js, no dependencies)
 * ------------------------------------------------------
 * Purpose-built for the ONE category of channel nothing else in this
 * project can fix: sources like Pluto TV's jmp2.uk-style redirect links,
 * which reject any request from a recognized cloud/datacenter IP range
 * before even evaluating headers — confirmed directly earlier (a fetch
 * from an entirely separate cloud network came back "blocked — bot
 * detection"). Your Cloudflare Worker, codetabs, and allorigins all run
 * from datacenter IPs and hit the identical wall.
 *
 * The fix is not clever code — it's WHERE the request comes from. This
 * server does nothing your browser wouldn't do on its own; it just does
 * it from your home connection's IP instead of the browser's own
 * same-origin-policy-constrained fetch(), which is what actually lets it
 * through.
 *
 * REQUIREMENTS: Node.js 18 or newer (needs native fetch()). Nothing else
 * — no npm install, no Docker, no FFmpeg. This isn't transcoding
 * anything, just following a redirect and adding the CORS header the
 * browser needs to be allowed to read the response.
 *
 * RUN:
 *   node home-relay-proxy.js
 *   (listens on port 8787 by default; override with PORT=xxxx)
 *
 * EXPOSE IT so your GitHub Pages site can reach it — same Cloudflare
 * Tunnel approach as the mediamtx-setup folder in this repo:
 *   cloudflared tunnel --url http://localhost:8787
 * gives you a temporary https://xxxxx.trycloudflare.com URL immediately
 * (good for testing); use `cloudflared tunnel create` + DNS routing
 * (see mediamtx-setup/README.md) for a permanent one tied to your own
 * domain.
 *
 * WIRE IT INTO THE APP: paste the resulting HTTPS URL into MY_HOME_RELAY_URL
 * near the top of index.html's <script> block. The app then automatically
 * routes jmp2.uk/Pluto-style channels through it — nothing else to
 * configure, no manual "resolve and paste" step needed, since this
 * server re-fetches fresh from your residential IP on every request
 * rather than needing a saved/expiring token.
 */

const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const PLAYLIST_PATTERN = /\.m3u8?($|\?)/i;

function corsHeaders(extra) {
  return Object.assign(
    {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
    },
    extra || {}
  );
}

// Same job as the Cloudflare Worker's rewritePlaylist: hls.js resolves
// relative URIs in a playlist against the RESPONSE URL it actually
// connected to — once proxied, that's this relay's own address, not the
// real stream's directory. Rewriting every URI to an absolute,
// already-proxied URL avoids relative resolution breaking downstream.
function rewritePlaylist(text, baseUrl, relayOrigin) {
  const proxify = (uri) => {
    let abs;
    try { abs = new URL(uri, baseUrl).toString(); } catch (e) { return uri; }
    return `${relayOrigin}/?url=${encodeURIComponent(abs)}`;
  };
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return trimmed.replace(/URI="([^"]+)"/i, (m, uri) => `URI="${proxify(uri)}"`);
    }
    return proxify(trimmed);
  }).join('\n');
}

const UPSTREAM_TIMEOUT_MS = 10000; // generous — a home connection has no reason to race a datacenter's own internal timeout budget the way the Worker does

async function fetchUpstream(targetUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow', // this is the whole point — jmp2.uk's redirect gets followed from a residential IP instead of being rejected outright
      headers: {
        // An ordinary browser-like signature — unlike the Worker's VLC
        // impersonation (built for a different problem, hotlink
        // protection), the block here is purely IP-based, so there's
        // nothing to gain from spoofing a different client signature.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const target = reqUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, corsHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Missing "url" query parameter.');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    res.writeHead(400, corsHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Invalid "url" query parameter.');
    return;
  }
  if (!ALLOWED_PROTOCOLS.has(targetUrl.protocol)) {
    res.writeHead(400, corsHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Only http:// and https:// targets are allowed.');
    return;
  }

  let upstream;
  try {
    upstream = await fetchUpstream(targetUrl.toString());
  } catch (e) {
    res.writeHead(502, corsHeaders({ 'Content-Type': 'text/plain' }));
    res.end(`Upstream fetch failed or timed out: ${e.message}`);
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isPlaylist = PLAYLIST_PATTERN.test(targetUrl.pathname) || /mpegurl/i.test(contentType);

  if (isPlaylist) {
    const text = await upstream.text();

    // Same reasoning as the Worker: a 200 status doesn't guarantee real
    // playlist content — fail loudly on anything that isn't actually
    // HLS rather than handing hls.js garbage to choke on silently.
    if (!upstream.ok || !/^\s*#EXTM3U/.test(text)) {
      res.writeHead(502, corsHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Upstream did not return a valid HLS playlist.');
      return;
    }

    const relayOrigin = `${reqUrl.protocol}//${reqUrl.host}`;
    const rewritten = rewritePlaylist(text, targetUrl, relayOrigin);
    res.writeHead(upstream.status, corsHeaders({
      'Content-Type': 'application/vnd.apple.mpegurl',
      // No content-length/content-encoding forwarded — same gzip
      // double-decode trap as the Worker: fetch()'s .text() already
      // transparently decompresses regardless of wire encoding, so
      // forwarding the original headers here would describe bytes that
      // no longer match what's actually being sent.
    }));
    res.end(rewritten);
    return;
  }

  // Non-playlist (segments, keys, etc): stream the body through
  // untouched rather than buffering it in memory first.
  res.writeHead(upstream.status, corsHeaders({
    'Content-Type': contentType || 'application/octet-stream',
  }));
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (e) {
    // client disconnected mid-stream — nothing to do
  }
  res.end();
});

server.listen(PORT, () => {
  console.log(`Home relay listening on http://localhost:${PORT}`);
  console.log(`Test it:  http://localhost:${PORT}/?url=https://jmp2.uk/plu-62ba60f059624e000781c436.m3u8`);
  console.log(`Expose it with:  cloudflared tunnel --url http://localhost:${PORT}`);
});
