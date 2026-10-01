# Radio Practice

A browser-based handheld radio simulator for practicing radio procedure before
an event. It has multiple channels, a push-to-talk (PTT) button, and an
instructor console. It is a single Go binary with no database.

## Run it locally

```sh
RADIO_PASSWORD=practice RADIO_INSTRUCTOR_PASSWORD=control go run . -dev
```

- Radios: http://localhost:8555. Log in with any callsign and the participant password.
- Console: http://localhost:8555/instructor.html. Use the instructor password.
- `-dev` serves `web/` from disk, so front-end edits only need a page refresh.
- If you leave the password env vars unset, random passwords are generated and printed to the log.

Test without a microphone, or with several people, using scripted radios:

```sh
go run ./cmd/radiobot -password practice -callsign BOT1 -ch 5
go run ./cmd/radiobot -password practice -callsign BOT2 -ch 5 -pitch 400   # doubles with BOT1
```

Phones need HTTPS before the browser allows the mic (localhost is the only
exception). To test on a phone, either deploy with `-tls-domain` or use a tunnel
such as `cloudflared tunnel --url http://localhost:8555` or `tailscale serve`.

## Deploy (AWS Lightsail or EC2)

1. Create a small instance: Lightsail $5/mo, or EC2 t4g.small. Open ports 80 and 443.
2. Point a DNS name at it.
3. Create a `.env` file next to `docker-compose.yml`. Git ignores it.

   ```sh
   TLS_DOMAIN=radio.example.org       # required; comma-separate several domains
   TLS_EMAIL=you@example.org          # optional; Let's Encrypt expiry warnings
   TLS_STAGING=false                  # true while testing, to avoid rate limits
   RADIO_PASSWORD=…
   RADIO_INSTRUCTOR_PASSWORD=…
   ```

4. `docker compose up -d --build`

`-tls-domain` gets and renews a Let's Encrypt certificate automatically, so you
don't need a reverse proxy. Port 80 must stay reachable for issuance and
renewal. Certificates are cached in `./certs` so they survive re-deploys. The
server keeps everything in memory. A restart ends every session, and each
person reconnects by tapping "Power on".

To run without Docker, build with `GOOS=linux GOARCH=arm64 go build -o radio .`,
copy the binary over, and run
`RADIO_PASSWORD=… RADIO_INSTRUCTOR_PASSWORD=… ./radio -tls-domain radio.example.org`
under systemd.

## Architecture

```
 phone / laptop browser                         Go server (one process)
┌─────────────────────────────┐   WebSocket   ┌──────────────────────────────┐
│ mic → 300–3000 Hz → worklet │ ─ JSON ctrl ─▶│ Hub (one mutex)              │
│   → 8 kHz μ-law 20 ms frames│ ─ binary ────▶│  • channels: floor lock /    │
│                             │               │    simplex txers, TOT timers │
│ per-stream jitter buffer →  │◀─ binary ──── │  • radios: channel, scan     │
│   doubling mix →            │               │  • state → instructor 5×/s   │
│   radio EQ + hiss + tones   │◀─ JSON ────── │                              │
└─────────────────────────────┘               └──────────────────────────────┘
```

**Who decides what.** The server is the authority for everything that has to
be consistent between radios:
- who holds a repeater
- who is keyed on simplex
- the time-out timer (TOT)
- force-unkey

There is no range model: every radio hears every transmission on the channels
it is listening to. The server sends each frame only to those radios.
Everything that is just how it sounds happens in the receiving browser: hiss,
the squelch tail, a garbled double when two people key on simplex, and beeps.

**Channel modes.**

| | Analog FM simplex (TAC 1/2, CAMP) | Digital repeater (DISPATCH, OPS, MEDICAL) |
|---|---|---|
| Floor | None. Anyone can key at any time. | The repeater grants one talker. Others get a "busy" bonk. |
| Two talkers | Everyone hears a garbled mix and a heterodyne whine. | Can't happen. |
| Caller ID | No | Yes |
| Keying | Instant | Wait for the talk-permit chirp. Speech before it is lost. |

Both modes are half-duplex: a radio that is transmitting hears nothing. Both
enforce a TOT, 60 s by default (`-tot`). A warning beeps 5 s before the
cutoff, then an alarm sounds until the user releases PTT.

**Scan.** The radio stops on the first busy channel and stays there for a 3 s
hang time. PTT during the hang time talks back on that channel.

**Instructor console.**
- Hears every monitored channel cleanly, with caller ID.
- Force-unkeys a stuck mic.
- Voice of God: transmits on every repeater channel at once. Anyone talking on
  a repeater is cut off and hears Control instead. Simplex channels are not
  affected.
- Sends scenario prompts to everyone or one radio.
- Transmits as Control.

**Why 8 kHz μ-law and not Opus.** μ-law needs no codec library and works in
every browser, including older iOS Safari. Radio audio is band-limited to
3 kHz anyway. At 64 kbps per stream, 100 people with a handful of simultaneous
talkers uses well under 10 Mbps. Switching to Opus through WebCodecs would cut
bandwidth by about 3x if that ever matters.

### Wire protocol

JSON text frames carry control messages. Client to server:
- `key` (instructors may send `vog: true` for Voice of God), `unkey`, `tune`, `scan`
- instructor only: `monitor`, `force_unkey`, `prompt`

Server to client:
- `hello`, `tx_ok`, `tx_deny`, `tx_end`, `rx_start`, `rx_end`, `prompt`
- instructor only: `state`

Binary frames carry audio:
- up: `[seq u16][160 B μ-law]`
- down: `[ch u8][sid u16][seq u16][160 B μ-law]`

## Files

| | |
|---|---|
| `hub.go` | Channel, floor and TOT logic, fan-out, instructor commands |
| `channels.go` | Channel modes and the default channel plan |
| `auth.go` | Shared-password login, signed session cookie |
| `main.go` | HTTP, WebSocket, and autocert TLS |
| `Dockerfile`, `docker-compose.yml` | Container build and public deploy |
| `web/audio.js` | Capture, playout, and all radio sound effects |
| `web/ptt.js` | Transmit state machine (shared by the radio and the console) |
| `web/radio.js`, `web/console.js` | The two UIs |
| `cmd/radiobot` | Scripted radio for testing |

## Known gaps and next steps

- Channels and the TOT are hard-coded in `channels.go`. Move them to a config file.
- iOS Safari routes audio to the earpiece while the mic is open. Releasing the mic between transmissions may help.
- Future work: recording and playback, speech-to-text scoring, and bot traffic (TTS) for solo practice.
- Per-IP rate limiting on login. There is currently a fixed delay after a wrong password and a global cap of 1,000 failures per hour. Past the cap, all new logins are refused until it refills, but existing sessions keep working.
