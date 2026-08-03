# Home relay — `home-relay-proxy.js`

Fixes exactly one thing: channels like Pluto TV's `jmp2.uk` links that
reject any request from a cloud/datacenter IP outright (confirmed
directly — a fetch from an entirely separate cloud network came back
"blocked — bot detection"). Your Cloudflare Worker, codetabs, and
allorigins all run from datacenter IPs and hit the identical wall, no
matter what headers or signatures they send.

This isn't a cleverness problem — it's a *where the request comes from*
problem. This relay does nothing your browser doesn't already try;
it just does it from your home connection's IP, which is what actually
gets through.

**Why this instead of the full `mediamtx-setup` folder:** that one's for
RTSP/RTMP/UDP/SRT sources — it transcodes protocols the browser can
never speak at all. This is a much smaller problem (the source is
already HLS; it just needs a residential IP and a CORS header added),
so this is a single dependency-free file instead of Docker + FFmpeg. If
you already have MediaMTX running, you don't need this too — its
`00s-replay`-style `source: https://jmp2.uk/...` entries do the same
job. Use whichever you'd rather maintain.

## Auto-discovery from the app (no manual URL wiring needed)

`index.html` now has a third config option, `MY_FFMPEG_RELAY_URL`. Once
set, the app automatically checks
`<your-relay>/<slugified-channel-name>/index.m3u8` for **any** channel
it already knows is otherwise unplayable — RTSP/RTMP/UDP protocols, or
a known-blocked host if you haven't set up `home-relay-proxy.js`
separately — before falling back to the VLC/resolve-link handoff.

The slug has to match exactly: lowercase, anything that isn't a
letter/number collapsed to a single `-`. "00s Replay" → `00s-replay`.
This is exactly what the `name` field in `ffmpeg-relay.js`'s `CHANNELS`
array should be — get that right once and there's nothing else to wire
up per channel; the app finds it automatically the next time you click
that channel.

If the relay isn't running, or doesn't have that particular channel
configured, this check just fails quietly and falls through to VLC
exactly as before — nothing breaks if you haven't set this up.

## Two relay options — which to use

This repo now has two small relays for this exact problem. Both need
the same thing: running from your home connection, not a cloud host —
confirmed directly by actually running each against `jmp2.uk` from a
cloud IP and getting a real rejection both times (a CORS-less
"bot detection" block for the fetch-based relay, and a genuine HTTP
`403 Forbidden` from FFmpeg). Neither tool has any special ability to
get past an IP-reputation check; only *where it runs* matters.

**`home-relay-proxy.js`** (this file) — passes bytes straight through,
adds a CORS header. No transcoding, minimal CPU/disk, works because
Pluto's stream is already browser-compatible H.264/AAC and just needs
the redirect followed from the right IP.

**`ffmpeg-relay.js`** — actually pulls each source with FFmpeg and
remuxes to local `.ts` segments + a live `index.m3u8`. Heavier (real
disk usage for the rolling segment window, needs FFmpeg installed
separately), but:
- Gives you real local segment files — a starting point if you ever
  want basic DVR/rewind.
- Handles the (currently hypothetical, for Pluto) case where a source's
  codec isn't already browser-compatible — FFmpeg can transcode where a
  pure passthrough can only forward bytes as-is.
- Generalizes cleanly to adding more channels later via one array at
  the top of the file.

For Pluto/`jmp2.uk` specifically, either works identically from the
app's point of view — pick whichever you'd rather maintain. Default to
`home-relay-proxy.js` unless you specifically want the segment-file or
future-transcoding benefits above.

**`home-relay-proxy.js` requirements:** Node.js 18+ only — no
`npm install`, no Docker, no FFmpeg.

**`ffmpeg-relay.js` requirements:** Node.js 18+, plus `ffmpeg` installed
separately and on your `PATH` (not bundled — [ffmpeg.org/download.html](https://ffmpeg.org/download.html),
or `apt install ffmpeg` / `brew install ffmpeg` / `winget install ffmpeg`).
Configure channels by editing the `CHANNELS` array at the top of the
file, then run the same way:
```bash
node ffmpeg-relay.js
```
Each channel gets its own `http://localhost:8788/<channel-name>/index.m3u8`.

## Run it

```bash
node home-relay-proxy.js
```

Listens on port 8787 by default (`PORT=xxxx node home-relay-proxy.js` to
change it). Test it locally:

```
http://localhost:8787/?url=https://jmp2.uk/plu-62ba60f059624e000781c436.m3u8
```

A working response starts with `#EXTM3U`.

## Expose it so GitHub Pages can reach it

Quickest way to test (temporary URL, resets if you restart it):

```bash
cloudflared tunnel --url http://localhost:8787
```

For something permanent tied to your own domain, follow the same
`cloudflared tunnel create` + DNS routing steps in
`mediamtx-setup/README.md` — identical process, just pointing at port
8787 instead of MediaMTX's 8888.

## Wire it into the app

Open `index.html`, find `MY_HOME_RELAY_URL` near the top of the
`<script>` block, and paste your tunnel's HTTPS URL in:

```js
const MY_HOME_RELAY_URL = 'https://your-tunnel-address.example.com';
```

Commit and push. From then on, any channel matching the known-blocked
host list (`jmp2.uk` and Pluto's stitcher domains) is automatically
routed through your relay first — no manual "resolve and paste" step
needed, since this relay re-fetches fresh from your residential IP on
every request rather than relying on a saved token that goes stale.

If the relay isn't running or isn't reachable, those channels fall back
to the VLC-download/resolve-link handoff exactly as before — nothing
about the existing behavior changes if you don't set this up.

## Keeping it running

This needs to stay running for those channels to keep working — same
requirement as MediaMTX. A few options:

- **Simplest**: leave a terminal window open on a PC that's usually on.
- **More durable**: run it as a background service. On Windows, [NSSM](https://nssm.cc/) can wrap
  it as a Windows service. On Linux/a Raspberry Pi, a systemd unit:

  ```ini
  # /etc/systemd/system/home-relay.service
  [Unit]
  Description=Live TV home relay
  After=network.target

  [Service]
  ExecStart=/usr/bin/node /path/to/home-relay-proxy.js
  Restart=always
  Environment=PORT=8787

  [Install]
  WantedBy=multi-user.target
  ```
  Then: `sudo systemctl enable --now home-relay`.

## Troubleshooting

- **CORS error in the browser console for a relayed channel**: confirm
  the relay is actually running and the tunnel is up — a dead relay
  behind a live tunnel shows as a connection error, not a CORS one.
- **Works at `localhost:8787` but not through the tunnel**: double-check
  the tunnel's target is `http://localhost:8787` (not `https`, this
  relay doesn't terminate TLS itself — the tunnel handles that).
- **A channel outside `jmp2.uk`/Pluto isn't using the relay**: that's
  intentional — only channels matching `KNOWN_BLOCKED_HOSTS` in
  `index.html` route here. Everything else still uses your Worker/public
  proxies, since those are perfectly fine for the vast majority of
  channels and there's no reason to route ordinary traffic through your
  home connection.
