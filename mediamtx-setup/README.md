# RTSP/RTMP/UDP/SRT → HLS relay (MediaMTX)

This turns any RTSP, RTMP, UDP-multicast, or SRT source into a normal
HLS (`.m3u8`) stream — the one format your web player already knows how
to play. It doesn't touch `index.html` or your Cloudflare Worker at
all; the output is just another channel URL to them.

Runs fine on a Raspberry Pi, an old PC, or a $5/mo VPS — anything that
can stay on.

> **Quick answer if you're only here for RTSP/RTMP/UDP sources** (security
> cameras, private encoders, multicast feeds): a cloud VPS works completely
> fine for these. They're not ad-monetized/bot-protected the way the
> `00s-replay` entry below is — that one specific channel (Pluto TV via
> `jmp2.uk`) is the only thing in this whole setup that needs to run from
> an actual home connection. Everything else in `mediamtx.yml` can run
> wherever's most convenient for you, VPS included. See section 6 below
> for why that one's different.

> **Why MediaMTX over SRS or Node-Media-Server:** all three do the same
> core job (ingest → HLS/WebRTC out). MediaMTX was picked here for the
> broadest single-config protocol coverage (RTSP/RTMP/UDP/SRT/WebRTC in
> one YAML file, no separate ingest servers per protocol) and because
> it's what's already built, tested, and documented in this repo — no
> reason to introduce a second tool for the same job. SRS is a
> reasonable alternative if you specifically want its WebRTC/low-latency
> focus; Node-Media-Server is simpler but covers fewer protocols
> (RTMP-centric). On the playback side, this project already uses
> hls.js in `index.html` (not video.js) — that part doesn't need
> changing either way.

---

## 1. Run it

```bash
git clone <this-folder-or-just-copy-the-3-files>
cd mediamtx-setup
docker compose up -d
```

Check it's alive:

```bash
docker logs mediamtx
```

At this point MediaMTX is running locally at `http://localhost:8888`,
but nothing outside your network can reach it yet — that's what the
tunnel is for.

---

## 2. Add your sources

Edit `mediamtx.yml` → the `paths:` section. Each entry is one channel.
The file has working examples for:

- a plain RTSP source
- an RTSP source needing a username/password
- RTMP push (an encoder sends TO this server)
- UDP/RTP multicast (common on managed ISP IPTV networks)
- SRT
- relaying an existing RTSP feed through one consistent egress point

Restart after editing:

```bash
docker compose restart mediamtx
```

Each path named e.g. `hallway-cam` becomes:

```
http://localhost:8888/hallway-cam/index.m3u8
```

---

## 3. Expose it over HTTPS with a Cloudflare Tunnel

This is the recommended option since you're already using Cloudflare
for the Worker — no port forwarding, no separate cert management, and
it survives your home IP changing.

**One-time setup:**

```bash
# authenticate (opens a browser)
cloudflared tunnel login

# create the tunnel — pick any name
cloudflared tunnel create mediamtx-relay

# point a subdomain at it (needs a domain on your Cloudflare account)
cloudflared tunnel route dns mediamtx-relay relay.yourdomain.com

# get the token to run it as a service (paste into docker-compose.yml)
cloudflared tunnel token mediamtx-relay
```

Then in the Cloudflare dashboard (Zero Trust → Networks → Tunnels →
your tunnel → **Public Hostname**), add:

| Subdomain | Path | Service |
|---|---|---|
| `relay` | `*` | `http://mediamtx:8888` |

Paste the token from step 3 into `TUNNEL_TOKEN` in `docker-compose.yml`
and restart:

```bash
docker compose up -d
```

Your channel is now live at:

```
https://relay.yourdomain.com/hallway-cam/index.m3u8
```

That's a normal HTTPS HLS URL — put it straight into your M3U as the
channel's stream. It'll already have CORS headers (`hlsAllowOrigin: "*"`
in the config) and valid HTTPS, so it doesn't even need to go through
your Worker proxy — though it's fine if it does (e.g. if you want it
folded into the same route-fallback logic as everything else).

### Alternative: Caddy instead of a tunnel

If you'd rather use a domain you point directly at your public IP with
port forwarding, swap `cloudflared` in `docker-compose.yml` for Caddy —
it gets you free auto-renewing HTTPS certs with a 3-line Caddyfile:

```
relay.yourdomain.com {
    reverse_proxy mediamtx:8888
}
```

This needs port 443 forwarded on your router to the machine running
Caddy, and DNS pointed at your public IP. The tunnel avoids both of
those, which is why it's the default here.

---

## 4. Add the channel to your app

In your M3U file:

```
#EXTINF:-1 tvg-id="hallway.local" tvg-name="Hallway Cam",Hallway Cam
https://relay.yourdomain.com/hallway-cam/index.m3u8
```

That's it — it flows through the exact same `PLAYBACK_ROUTES` /
hls.js pipeline as every other channel in the app.

---

## 5. Satellite / Enigma2 receivers

If your source is a physical Enigma2-based satellite/cable box rather
than a raw stream, you likely don't need MediaMTX at all — most
Enigma2 images ship **OpenWebIf**, which can restream the currently
tuned service directly:

```
http://<box-ip>:8001/<serviceref>
```

Check the box's plugin/settings menu for "OpenWebIf" or "Web
Interface" if it's not already enabled. That URL can go straight into
your M3U the same way (through the Cloudflare Tunnel/Caddy above if
you need it reachable outside your LAN, or straight through your
existing Worker proxy either way).

---

## 6. Bot-detected CDNs (Pluto TV / jmp2.uk-style links)

Some channels — the `00s-replay` entry in `mediamtx.yml` is one — fail
identically on every proxy route (your Worker, codetabs, allorigins) but
work fine in VLC. That specific signature usually means the target CDN
is checking IP reputation and rejecting anything from a recognized
datacenter/cloud range, confirmed directly: a fetch to Pluto's
ad-stitching CDN from a completely unrelated cloud network came back
with an explicit "blocked — bot detection" response.

**This is the one case in this setup where the relay genuinely must run
from a residential connection** — a VPS doesn't help here, because it's
just another datacenter IP hitting the same wall. Run this specific
service on the Pi/home PC itself (not a cloud box), the same way the
config already assumes.

Once it's pulling successfully, the Tunnel/Worker step is unaffected —
`https://relay.yourdomain.com/00s-replay/index.m3u8` (or your local
address during testing) is a normal HLS URL your app already knows how
to play, same as every other channel.

---

## Notes on resource use

- **Remuxing** (repackaging RTSP/RTMP/UDP into HLS without re-encoding
  video) is what happens by default here and is very cheap — a
  Raspberry Pi 4 can handle several channels at once.
- **Transcoding** (changing codec/resolution) is not configured in this
  setup and is far more CPU-intensive. You'd only need it if a source's
  codec isn't something browsers support (e.g. MPEG-2) — that's a
  bigger, separate change (adding an ffmpeg step) and worth doing only
  for channels that actually need it.
- `hlsAlwaysRemux: no` (the default here) means a channel spins up on
  first request and stops when nobody's watching — saves bandwidth/CPU
  for channels you don't watch often. Set it to `yes` per-channel for
  instant-join on the ones you check frequently.

## Troubleshooting

- **Blank/black video, no errors**: check `docker logs mediamtx` —
  most often the source RTSP/RTMP credentials or address are wrong.
- **CORS error in the browser console**: confirm `hlsAllowOrigin: "*"`
  is still set in `mediamtx.yml` and you restarted after editing.
- **Works locally, not through the tunnel**: check the tunnel's Public
  Hostname service points at `http://mediamtx:8888` (the Docker
  service name, not `localhost`) — `localhost` inside the cloudflared
  container refers to itself, not the mediamtx container.
