# Radio Practice

A browser-based handheld radio simulator for practicing radio procedure before
an event. It has multiple channels, a push-to-talk (PTT) button, a Voice of God
channel that talks on every repeater at once, and a roster and text messages
for everyone on the network. It is a single Go binary with no database.

## Run it locally

```sh
RADIO_PASSWORD=practice go run . -dev
```

- Open http://localhost:8080 and log in with any callsign and the password.
- The password rides in the URL (`/?p=practice`), so the address bar is a link to share. The browser remembers the callsign, so a link plus a saved callsign logs straight in.
- `-dev` serves `web/` from disk, so front-end edits only need a page refresh.
- If you leave `RADIO_PASSWORD` unset, a random password is generated and printed to the log.

Test without a microphone, or with several people, using scripted radios:

```sh
go run ./cmd/radiobot -password practice -callsign BOT1 -ch 5
go run ./cmd/radiobot -password practice -callsign BOT2 -ch 5 -pitch 400   # doubles with BOT1
```

Phones need HTTPS before the browser allows the mic (localhost is the only
exception). To test on a phone, put it behind an HTTPS reverse proxy or use a
tunnel such as `cloudflared tunnel --url http://localhost:8080` or `tailscale serve`.

## End-to-end tests

Playwright tests in `e2e/` drive real browsers through the audio workflows:
talking and listening on both channel modes, doubling, the repeater's permit
chirp and busy bonk, TOT, scan, Voice of God, the app controls column, mic
and speaker handling, and accessibility (axe scans plus keyboard and screen-reader checks).

```sh
cd e2e
npm ci
npx playwright install chromium firefox webkit
npm test                                  # every browser and device
npx playwright test --project=firefox     # one of them
E2E_BRANDED=chrome,msedge npm test        # also the installed Chrome / Edge
```

Global setup builds the server once, and each Playwright worker runs its own
copy on a free port, so tests never hear each other. Most tests replace `getUserMedia` with a synthetic tone so every
browser gets the same mic, and check what was played by tapping the page's
`AudioContext` output (`e2e/harness/page-audio.js`). `native-mic.spec.ts` uses
each browser's own fake capture device instead.

## Deploy

The server only speaks plain HTTP (port 8080 by default, `-addr` to change it).
Put a reverse proxy in front of it to terminate TLS. The proxy must:
- forward WebSocket upgrades on `/ws`
- pass the original `Host` header through, since WebSocket upgrades are refused
  when `Origin` doesn't match `Host`

With Docker:

1. Create a `.env` file next to `docker-compose.yml` with `RADIO_PASSWORD=…`.
   Git ignores it. Set `HOST_PORT` there too to publish somewhere other than 8080.
2. `docker compose up -d --build`

The server keeps everything in memory. A restart ends every session, and each
person reconnects by tapping "Power on".

To run without Docker, build with `GOOS=linux GOARCH=arm64 go build -o radio .`,
copy the binary over, and run `RADIO_PASSWORD=… ./radio` under systemd.

## Architecture

```
 phone / laptop browser                         Go server (one process)
┌─────────────────────────────┐   WebSocket   ┌──────────────────────────────┐
│ mic → 300–3000 Hz → worklet │ ─ JSON ctrl ─▶│ Hub (one mutex)              │
│   → 8 kHz μ-law 20 ms frames│ ─ binary ────▶│  • channels: floor lock /    │
│                             │               │    simplex txers, TOT timers │
│ per-stream jitter buffer →  │◀─ binary ──── │  • radios: channel, scan     │
│   doubling mix →            │               │  • roster → open columns 5×/s│
│   radio EQ + hiss + tones   │◀─ JSON ────── │                              │
└─────────────────────────────┘               └──────────────────────────────┘
```

**Who decides what.** The server is the authority for everything that has to
be consistent between radios:
- who holds a repeater
- who is keyed on simplex
- the time-out timer (TOT)

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

**Voice of God.** The server adds one more channel after the plan, labelled
ALL REPEATERS. Anyone can key it to transmit on every repeater channel at once.
Anyone talking on a repeater is cut off and hears Voice of God instead. A
second Voice of God gets a busy bonk rather than cutting off the first.
Simplex channels are not affected. A radio tuned to it listens to every
repeater, stopping on the first busy one the way scan does.

**App controls.** The "Show app controls" checkbox opens a second column with
everyone on the network, their channel, and who is transmitting, plus text
messages to everyone. A message also pops up with a beep on every other radio,
whether its column is open or not. The server keeps the last 50 messages for
radios that connect later.

**Why 8 kHz μ-law and not Opus.** μ-law needs no codec library and works in
every browser, including older iOS Safari. Radio audio is band-limited to
3 kHz anyway. At 64 kbps per stream, 100 people with a handful of simultaneous
talkers uses well under 10 Mbps. Switching to Opus through WebCodecs would cut
bandwidth by about 3x if that ever matters.

### Wire protocol

JSON text frames carry control messages. Client to server:
- `key`, `unkey`, `tune`, `scan`
- `watch` (the app controls column opened or closed), `msg`

Server to client:
- `hello` (includes recent messages), `tx_ok`, `tx_deny`, `tx_end`, `rx_start`, `rx_end`, `msg`
- `state`, the roster, only while `watch` is on

Binary frames carry audio:
- up: `[seq u16][160 B μ-law]`
- down: `[ch u8][sid u16][seq u16][160 B μ-law]`

## Files

| | |
|---|---|
| `hub.go` | Channel, floor and TOT logic, Voice of God, fan-out, roster and messages |
| `channels.go` | Channel modes and the default channel plan |
| `auth.go` | Shared-password login, signed session cookie |
| `main.go` | HTTP and WebSocket |
| `Dockerfile`, `docker-compose.yml` | Container build and deploy |
| `web/audio.js` | Capture, playout, and all radio sound effects |
| `web/ptt.js` | Transmit state machine |
| `web/app.js`, `web/radio.js` | Entry point and the radio UI on `index.html` |
| `web/controls.js` | The app controls column: roster and messages |
| `cmd/radiobot` | Scripted radio for testing |
| `e2e/` | Playwright browser tests |

## Known gaps and next steps

- Channels and the TOT are hard-coded in `channels.go`. Move them to a config file.
- iOS Safari routes audio to the earpiece while the mic is open. Releasing the mic between transmissions may help.
- Future work: recording and playback, speech-to-text scoring, and bot traffic (TTS) for solo practice.
- Per-IP rate limiting on login. There is currently a fixed delay after a wrong password and a global cap of 1,000 failures per hour. Past the cap, all new logins are refused until it refills, but existing sessions keep working.
