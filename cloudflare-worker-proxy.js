/**
 * Live TV — streaming proxy (Cloudflare Worker)
 * --------------------------------------------
 * Fetches an arbitrary http:// or https:// URL and streams the response
 * straight back with permissive CORS headers, so a browser page served
 * over HTTPS (like GitHub Pages) can load an insecure or CORS-blocked
 * stream through it instead of being blocked outright.
 *
 * This exists because public shared proxies (corsproxy.io, allorigins.win)
 * are rate-limited and not built for sustained live video traffic — this
 * one is yours alone, on Cloudflare's free tier, and handles range
 * requests properly so seeking/segment loading behaves correctly.
 *
 * DEPLOY (no CLI needed):
 *   1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
 *   2. Give it a name (e.g. "livetv-proxy") and deploy the default template
 *   3. Click "Edit code", delete everything, paste this whole file in, then Deploy
 *   4. Copy the URL Cloudflare gives you (looks like
 *      https://livetv-proxy.<your-subdomain>.workers.dev)
 *   5. Paste that URL as MY_PROXY_URL near the top of index.html's <script>
 *
 * USAGE (once deployed):
 *   https://<your-worker>.workers.dev/?url=<url-encoded target address>
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

// Cloudflare Workers refuse to make outbound requests directly to a bare IP
// address ("Error 1003: Direct IP access not allowed") — a platform-level
// restriction, not something this script can override directly. A lot of
// free public IPTV streams are hosted at raw IPs with no domain name at
// all, so without a workaround every one of those would be unreachable.
//
// The fix: sslip.io is a free wildcard DNS service where "<ip>.sslip.io"
// resolves to that exact IP with zero setup. Swapping the hostname to that
// form gives Cloudflare a legitimate-looking domain name to satisfy its
// requirement, while the connection still lands on the identical server —
// this is the standard, community-confirmed workaround for this exact
// restriction.
function toFetchableUrl(url) {
  if (IPV4_PATTERN.test(url.hostname)) {
    url.hostname = `${url.hostname}.sslip.io`;
  }
  return url;
}

function corsHeaders(extra) {
  const h = new Headers(extra);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Expose-Headers', '*');
  return h;
}

const PLAYLIST_PATTERN = /\.m3u8?($|\?)/i;

// hls.js resolves relative URIs inside a playlist against the *actual*
// response URL it connected to — which, once proxied, is this Worker's own
// address, not the real stream's directory. Left alone, every relative
// segment/sub-playlist reference inside the file breaks. The fix: rewrite
// every URI in the playlist to an absolute, already-proxied URL before
// handing it back, so there's no relative resolution left for hls.js to
// get wrong. Covers plain segment/sub-playlist lines as well as the
// URI="..." attribute used by #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, etc.
function rewritePlaylist(text, baseUrl, workerOrigin) {
  const proxify = (uri) => {
    let abs;
    try { abs = new URL(uri, baseUrl).toString(); } catch (e) { return uri; }
    return `${workerOrigin}/?url=${encodeURIComponent(abs)}`;
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

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');

    if (!target) {
      return new Response('Missing "url" query parameter.', {
        status: 400,
        headers: corsHeaders({ 'Content-Type': 'text/plain' }),
      });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response('Invalid "url" query parameter.', {
        status: 400,
        headers: corsHeaders({ 'Content-Type': 'text/plain' }),
      });
    }

    if (!ALLOWED_PROTOCOLS.has(targetUrl.protocol)) {
      return new Response('Only http:// and https:// targets are allowed.', {
        status: 400,
        headers: corsHeaders({ 'Content-Type': 'text/plain' }),
      });
    }

    // Many IPTV origin servers specifically allow VLC's request signature
    // while blocking anything that looks like a browser — hotlink
    // protection aimed at stopping exactly this kind of web re-streaming.
    // A confirmed real-world case: a stream that 403'd through every
    // route here played fine in the desktop VLC app from the same
    // network — the only meaningful difference being VLC's User-Agent and
    // the complete absence of a Referer header (VLC sends none at all).
    // So: impersonate VLC's signature rather than a browser's, and don't
    // add a Referer VLC would never send. This overrides whatever UA the
    // browser sent us, rather than just falling back to it, since passing
    // the real browser UA through was exactly the problem.
    //
    // Some origins do the inverse, though — they specifically reject a
    // VLC-looking client while a normal browser signature sails through
    // (the opposite hotlink policy). buildHeaders(asVlc) lets the handler
    // try both signatures rather than betting everything on one.
    function buildHeaders(asVlc) {
      const h = new Headers();
      if (asVlc) {
        h.set('User-Agent', 'VLC/3.0.20 LibVLC/3.0.20');
        h.set('Icy-MetaData', '1');
      } else {
        const ua = request.headers.get('User-Agent');
        if (ua) h.set('User-Agent', ua);
        const referer = request.headers.get('Referer');
        if (referer) h.set('Referer', referer);
      }
      h.set('Accept', '*/*');
      h.set('Connection', 'close');
      // libVLC's default HTTP access module sends a Range header on every
      // request, including the very first one for a playlist — not just on
      // seeks. Forward the browser's Range if it sent one, otherwise default
      // to the same "from the start" range VLC would send.
      h.set('Range', request.headers.get('Range') || 'bytes=0-');
      // toFetchableUrl rewrites bare-IP hostnames to "<ip>.sslip.io" purely
      // to satisfy Cloudflare's "no direct IP" restriction — the ORIGIN
      // server was never meant to see that hostname at all. Left alone,
      // fetch() would send whatever Host the rewritten URL implies
      // (".sslip.io"), and a lot of these appliance-style IPTV panels do
      // strict Host-header validation (or just have a narrow nginx
      // server_name) and reject anything that doesn't match with a 403 —
      // a confirmed real-world case, not a hypothetical. Explicitly
      // setting Host back to the ORIGINAL target here (Workers' fetch()
      // allows this override; browser fetch() forbids it, which is why
      // this has to happen here and not client-side) means the origin
      // sees exactly the Host it expects, regardless of the sslip.io
      // trick used to actually route the connection there.
      h.set('Host', targetUrl.host);
      return h;
    }

    // Bounds each individual upstream attempt so a slow/hanging origin
    // can't stall the Worker past the point where the client (health
    // check, hls.js manifest load) has already given up and moved on — a
    // Worker response that arrives late is as useless as one that never
    // arrives, just harder to diagnose. Must stay comfortably BELOW the
    // client-side timeouts in index.html (currently 9s) — if this and the
    // client timeout are too close together, the client aborts the whole
    // request just as the Worker's own fetch is about to succeed, turning
    // a slow-but-working stream into a false failure on every attempt.
    const UPSTREAM_TIMEOUT_MS = 7000;

    async function fetchUpstream(asVlc) {
      const fetchUrl = toFetchableUrl(new URL(targetUrl.toString()));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        return await fetch(fetchUrl.toString(), {
          method: 'GET',
          headers: buildHeaders(asVlc),
          redirect: 'follow',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    let upstream;
    let playlistText = null;
    // Only URLs that clearly look like a playlist by extension are worth
    // the cost of firing both signatures at once — for everything else
    // (segments, keys, thumbnails, streams with no extension at all) a
    // single VLC attempt is the right default, same as before.
    const isPlaylistByExt = PLAYLIST_PATTERN.test(targetUrl.pathname);

    async function tryPlaylistFetch(asVlc) {
      const res = await fetchUpstream(asVlc);
      if (!res.ok) return { ok: false, res, text: null };
      const text = await res.text();
      return { ok: /^\s*#EXTM3U/.test(text), res, text };
    }

    if (isPlaylistByExt) {
      // Fire the VLC and browser signatures at the same time — some
      // origins only allow one or the other (see buildHeaders above) —
      // and take whichever comes back with a real playlist. Concurrent
      // rather than sequential specifically so a slow-but-legitimate
      // origin costs the same single round-trip either way, instead of
      // silently doubling to two round-trips and blowing past the
      // client's own timeout on the retry.
      const [vlcResult, browserResult] = await Promise.allSettled([
        tryPlaylistFetch(true),
        tryPlaylistFetch(false),
      ]);
      const vlc = vlcResult.status === 'fulfilled' ? vlcResult.value : null;
      const browser = browserResult.status === 'fulfilled' ? browserResult.value : null;
      const winner = (vlc && vlc.ok) ? vlc : (browser && browser.ok) ? browser : (vlc || browser);
      if (!winner) {
        return new Response('Upstream fetch failed or timed out.', {
          status: 502,
          headers: corsHeaders({ 'Content-Type': 'text/plain' }),
        });
      }
      upstream = winner.res;
      playlistText = winner.text;
    } else {
      // Segments/keys/thumbnails: try VLC's signature first, same as
      // always — zero added cost for the common case where it just
      // works. But unlike before, don't blindly trust a 200 status here
      // either. The dual-signature race above only ever covered the
      // .m3u8 manifest itself; every individual segment fetch used to
      // go through with VLC's signature alone and no fallback at all.
      // If an origin's hotlink policy is inconsistent — allows VLC for
      // the manifest but rejects it for segments specifically (or vice
      // versa) — the manifest loads fine while every segment silently
      // comes back as an HTML block/error page instead of real media,
      // which hls.js reports as a confusing fragParsingError with no
      // indication the real cause was a signature mismatch on THIS
      // specific request rather than the stream itself. A real,
      // observed case, not hypothetical.
      try {
        upstream = await fetchUpstream(true);
        const ct = (upstream.headers.get('content-type') || '').toLowerCase();
        if (upstream.ok && /text\/html/.test(ct)) {
          // 200 status but HTML content-type where a binary media
          // segment was expected — exactly the shape of a block/error
          // page standing in for the real thing. Retry once with the
          // browser signature before giving up on this request.
          const retry = await fetchUpstream(false);
          const retryCt = (retry.headers.get('content-type') || '').toLowerCase();
          if (retry.ok && !/text\/html/.test(retryCt)) upstream = retry;
        }
      } catch (e) {
        return new Response(`Upstream fetch failed: ${e.message}`, {
          status: 502,
          headers: corsHeaders({ 'Content-Type': 'text/plain' }),
        });
      }
    }

    const contentTypeInitial = upstream.headers.get('content-type') || '';
    const isPlaylist = isPlaylistByExt || /mpegurl/i.test(contentTypeInitial);

    // Non-extension URLs that turn out to be playlists by content-type
    // still need their body read — the extension-matched path above
    // already has playlistText from tryPlaylistFetch.
    if (isPlaylist && playlistText === null && upstream.ok) {
      playlistText = await upstream.text();
    }

    const headers = corsHeaders(upstream.headers);
    // Strip headers that only make sense for the original origin/embedding
    // context and would otherwise confuse the browser or leak nothing useful.
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
    headers.delete('x-frame-options');
    headers.delete('set-cookie');

    if (isPlaylist) {
      // A 200 status doesn't guarantee real playlist content — some
      // origins return an HTML block/login/error page with a 200 when a
      // stream is dead, geo-blocked, or the request was rejected for
      // reasons other than a clean HTTP error. Forwarding that as if it
      // were the manifest hands hls.js garbage and surfaces client-side
      // as an opaque manifestParsingError with no real diagnostic value.
      // Fail loudly here instead, so the app's existing route-fallback
      // logic can react to a clear error rather than bad content.
      if (!upstream.ok || !/^\s*#EXTM3U/.test(playlistText || '')) {
        return new Response('Upstream did not return a valid HLS playlist.', {
          status: 502,
          headers: corsHeaders({ 'Content-Type': 'text/plain' }),
        });
      }

      // Channel-list files (like an apsattv.com/iptv-org playlist of
      // hundreds of separate channels) match the same .m3u/.m3u8
      // extension pattern as a genuine HLS streaming manifest, but they
      // are NOT the same kind of file — rewritePlaylist's job is
      // resolving relative SEGMENT URIs within one HLS stream, which
      // makes no sense applied to a directory of unrelated channels.
      // Real HLS manifests (master or media) always carry at least one
      // #EXT-X- tag; a channel list never does — checking for that is
      // enough to tell the two apart and only rewrite the one that
      // actually needs it.
      const isActualHlsManifest = /#EXT-X-/.test(playlistText);
      if (!isActualHlsManifest) {
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(playlistText, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        });
      }

      const rewritten = rewritePlaylist(playlistText, targetUrl, reqUrl.origin);
      headers.set('Content-Type', 'application/vnd.apple.mpegurl');
      headers.delete('content-length'); // length changed after rewriting
      // upstream.text() transparently decompresses the body regardless of
      // how it was sent — but upstream.headers still carries the ORIGINAL
      // wire encoding (e.g. many IPTV middlewares gzip their .m3u8
      // responses). Left in place, the browser sees "Content-Encoding:
      // gzip" on a body that's already plain text and tries to gunzip it
      // again, corrupting the playlist before hls.js ever sees it — this
      // is what surfaces client-side as a confusing manifestParsingError
      // with no indication the real cause was header mismatch, not the
      // stream itself.
      headers.delete('content-encoding');
      return new Response(rewritten, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};
