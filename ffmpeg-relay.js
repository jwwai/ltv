#!/usr/bin/env node
/**
 * Live TV — FFmpeg-based home relay
 * -----------------------------------
 * Alternative to home-relay-proxy.js for the same problem (jmp2.uk/Pluto-
 * style channels that block cloud/datacenter IPs — confirmed directly
 * earlier). That one just passes bytes through with a CORS header added;
 * this one actually pulls each source with FFmpeg and remuxes it to a
 * local rolling HLS segment set.
 *
 * Use THIS instead of home-relay-proxy.js when:
 *   - You want real local segment files (e.g. as a base for DVR/rewind
 *     later), not just a live passthrough.
 *   - A source's codec ever turns out NOT to be browser-compatible —
 *     FFmpeg can transcode; a passthrough relay can only forward bytes
 *     as-is. (Pluto's own stream is already H.264/AAC, so for THAT
 *     specific channel this is remuxing with `-c copy`, not re-encoding
 *     — no quality loss, no real CPU cost.)
 *   - You'll want to add more sources over time, including ones that
 *     genuinely aren't already-valid HLS.
 *
 * Either one requires the SAME thing: running from your actual home
 * connection, not a VPS/cloud host — FFmpeg has no special ability to
 * get past an IP-reputation block any more than curl or fetch() does.
 *
 * REQUIREMENTS:
 *   - Node.js 18+ (native fetch not required here, but consistent with
 *     the rest of this project)
 *   - ffmpeg installed and on PATH (NOT bundled — install separately:
 *     https://ffmpeg.org/download.html, or `apt install ffmpeg` /
 *     `brew install ffmpeg` / winget install ffmpeg on Windows)
 *
 * CONFIGURE: edit the CHANNELS array below — name + source URL per
 * channel. Add more as needed; each gets its own ffmpeg process and
 * output folder.
 *
 * RUN:
 *   node ffmpeg-relay.js
 *   (HTTP server on port 8788 by default; override with PORT=xxxx)
 *
 * EXPOSE + WIRE IN: identical to home-relay-proxy.js — see
 * HOME-RELAY-README.md for the Cloudflare Tunnel steps. Once exposed,
 * each channel's URL is:
 *   https://<your-tunnel>/<channel-name>/index.m3u8
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---- Configure your channels here ----
// IMPORTANT for auto-discovery: `name` must be the channel's exact name
// from the app, lowercased, with anything that isn't a letter/number
// collapsed to a single "-" (this matches the slugify() function
// index.html uses internally). Example: a channel named "00s Replay"
// in the app becomes "00s-replay" here. Get this right and the app
// finds and plays it automatically for any channel it already knows is
// otherwise unplayable — no per-channel wiring needed beyond this array.
//
// `transcode: true` (optional, default false/remux) — for a source whose
// VIDEO codec a browser can't decode at all, most commonly HEVC/H.265.
// VLC bundles its own software decoder for virtually every codec, which
// is why a channel like this plays fine there but shows no video (often
// with audio still playing) in the browser — no proxy or route fix can
// ever touch that, since it's a decode-pipeline limitation, not a
// networking one. Set this and the video gets genuinely re-encoded to
// H.264 (audio is left alone with -c:a copy — a codec problem here
// specifically means the VIDEO track, not the audio, which already
// decodes fine as-is). This is real, continuous CPU cost, unlike the
// near-free -c copy remux every other entry below uses — fine for a
// couple of channels on a Pi 4/5 or a modest PC, but don't flip this on
// broadly without checking your hardware keeps up.
const CHANNELS = [
  // --- HTTP(S) source blocked by IP-reputation (jmp2.uk/Pluto etc) ---
  { name: '00s-replay', url: 'https://jmp2.uk/plu-62ba60f059624e000781c436.m3u8' },
  // { name: '70s-cinema', url: 'https://jmp2.uk/plu-5f4d878d3d19b30007d2e782.m3u8' },

  // --- HEVC/H.265 video — needs re-encoding to H.264, not just remuxing,
  //     to actually show video in a browser. Confirmed: plays fine in
  //     VLC, audio-only/no-video in the browser via hls.js — the exact
  //     signature of an undecodable video codec. The channel name below
  //     must match this app's exact display name for this source
  //     ("Sony Entertainment Channel") once slugified — double-check
  //     against what's actually shown in the app if this doesn't
  //     auto-match; playlist sources sometimes label it slightly
  //     differently (e.g. "Sony Entertainment Channel HD", "SET HD"). ---
  { name: 'sony-entertainment-channel', url: 'http://38.96.178.205/SONYHD/index.m3u8', transcode: true },
  { url: 'http://38.96.178.205/SONYHD/index.m3u8', transcode: true },

  // --- RTSP/RTMP/UDP sources — no browser can EVER play these directly,
  //     with or without a proxy (no browser networking API speaks any of
  //     these protocols at all). This is the only thing that actually
  //     makes them playable in the app; everything else in this project
  //     is a proxy/CORS fix, which is a different problem entirely. ---
  // { name: 'hallway-cam', url: 'rtsp://admin:password@192.168.1.50:554/stream1' },
  // { name: 'live-feed', url: 'rtmp://some-encoder.example.com/live/streamkey' },
  // { name: 'news-multicast', url: 'udp://239.1.1.1:1234?fifo_size=1000000&overrun_nonfatal=1' },
];

const PORT = process.env.PORT || 8788;
const OUTPUT_ROOT = path.join(__dirname, 'hls-output');

function corsHeaders(extra) {
  return Object.assign(
    {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
    extra || {}
  );
}

// Different input protocols need different reliability flags — getting
// these wrong is the most common reason someone's ffmpeg command "works
// sometimes" for RTSP/UDP sources. Detected automatically from the
// source URL's scheme so channel entries below can just be a plain URL.
function inputFlagsFor(url){
  let scheme;
  try{ scheme = new URL(url).protocol.replace(':',''); }catch(e){ return []; }
  if(scheme === 'rtsp' || scheme === 'rtsps'){
    return [
      // RTSP defaults to UDP transport for the actual media, which is
      // exactly the kind of thing that gets silently dropped by home
      // routers/NAT and looks like "random freezing" rather than a
      // clean failure. Forcing TCP trades a little overhead for being
      // dramatically more reliable through a normal home network.
      '-rtsp_transport', 'tcp',
      '-rtsp_flags', 'prefer_tcp',
      // RTSP streams frequently have loose/jumpy timestamps depending on
      // the source camera/encoder — this tolerates a wider gap before
      // ffmpeg gives up and reports a discontinuity error.
      '-max_delay', '5000000',
    ];
  }
  if(scheme === 'rtmp' || scheme === 'rtmps'){
    return [
      // RTMP servers vary a lot in how strictly they expect the initial
      // handshake timing; a longer probe window avoids spurious
      // "Server error" failures on a slightly slow RTMP source.
      '-rw_timeout', '15000000',
    ];
  }
  if(scheme === 'udp'){
    return [
      // Nothing on the ffmpeg command line fixes an under-sized socket
      // buffer for UDP/multicast — that has to be in the URL itself,
      // e.g. udp://239.1.1.1:1234?fifo_size=1000000&overrun_nonfatal=1.
      // Flagged here as a reminder rather than silently working with a
      // default buffer that's often too small for a full multicast bitrate.
    ];
  }
  return [];
}

// One persistent ffmpeg process per channel. For an already-compatible
// source this remuxes (`-c copy` — just repackages the existing H.264/AAC
// into HLS segments, near-zero CPU). For a channel marked
// `transcode: true` (see CHANNELS above), the video track is genuinely
// re-encoded to H.264 instead — real, continuous CPU cost, but the only
// thing that actually turns an undecodable codec (HEVC/H.265, typically)
// into something a browser can show.
function codecArgsFor(channel) {
  if (!channel.transcode) return ['-c', 'copy'];
  return [
    // Audio is left alone — a channel needing `transcode: true` means the
    // VIDEO codec is the problem (the browser plays its audio fine as-is
    // in every real case seen so far), so re-encoding audio too would
    // just be wasted CPU for no benefit.
    '-c:v', 'libx264',
    '-preset', 'veryfast', // has to keep up with a continuous live source in real time — a slower preset falls behind and the stream drifts/stalls
    '-tune', 'zerolatency',
    '-crf', '23',          // reasonable quality/bitrate balance for a re-stream; lower = higher quality + bigger segments
    // Forces a keyframe every 6s regardless of the source's actual frame
    // rate — HLS needs a keyframe at (or before) the start of every
    // segment, and -hls_time below is 6s. A fixed -g <frame count> guess
    // only lines up correctly for one exact frame rate; this doesn't need
    // to know the source's frame rate at all.
    '-force_key_frames', 'expr:gte(t,n_forced*6)',
    '-c:a', 'copy',
  ];
}

function startFfmpeg(channel) {
  const outDir = path.join(OUTPUT_ROOT, channel.name);
  fs.mkdirSync(outDir, { recursive: true });
  const indexPath = path.join(outDir, 'index.m3u8');

  const args = [
    '-loglevel', 'warning',
    '-fflags', '+genpts',
    ...inputFlagsFor(channel.url),
    // FFmpeg's http demuxer follows redirects on its own — this is what
    // actually resolves jmp2.uk, same mechanism as any browser
    // navigation, just running from wherever this process runs. For
    // rtsp/rtmp/udp sources, this is what actually gives the browser
    // something it can play at all — no proxy or CORS fix could ever
    // do that, since no browser speaks those protocols regardless of
    // headers or IP.
    '-i', channel.url,
    ...codecArgsFor(channel),
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
    indexPath,
  ];

  console.log(`[${channel.name}] starting${channel.transcode ? ' (transcoding video to H.264)' : ''}: ffmpeg ${args.join(' ')}`);
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  proc.stderr.on('data', (chunk) => {
    // ffmpeg logs to stderr even for normal warnings — prefix so it's
    // clear which channel a given line belongs to when running several.
    process.stderr.write(`[${channel.name}] ${chunk}`);
  });

  proc.on('exit', (code, signal) => {
    console.warn(`[${channel.name}] ffmpeg exited (code=${code} signal=${signal}) — restarting in 5s`);
    setTimeout(() => startFfmpeg(channel), 5000);
  });

  return proc;
}

CHANNELS.forEach(startFfmpeg);

// ---- Minimal static file server for the HLS output, with CORS ----
const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const filePath = path.join(OUTPUT_ROOT, decodeURIComponent(reqUrl.pathname));

  // Don't serve anything outside the output directory.
  if (!filePath.startsWith(OUTPUT_ROOT)) {
    res.writeHead(403, corsHeaders());
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, corsHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Not found — channel may still be starting up, or check the name in the URL.');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, corsHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream' }));
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`FFmpeg relay listening on http://localhost:${PORT}`);
  CHANNELS.forEach(ch => {
    console.log(`  ${ch.name}: http://localhost:${PORT}/${ch.name}/index.m3u8`);
  });
});
