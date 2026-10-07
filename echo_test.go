package main

import (
	"bytes"
	"encoding/binary"
	"testing"
	"testing/synctest"
	"time"
)

const (
	chPlainTac = 0
	chEcho     = 1
)

func newEchoHub() *Hub {
	return NewHub([]ChannelConfig{
		{Name: "TAC 1", Mode: ModeSimplex},
		{Name: "ECHO", Mode: ModeSimplex, Echo: true},
	}, time.Minute)
}

func joinOn(h *Hub, callsign string, ch int) *testRadio {
	r := join(h, callsign)
	send(h, r, `{"t":"tune","ch":%d}`, ch)
	drain(r)
	return r
}

// voiceFrame is an uplink frame whose seq and payload identify it.
func voiceFrame(seq uint16) []byte {
	f := binary.BigEndian.AppendUint16(nil, seq)
	return append(f, bytes.Repeat([]byte{byte(seq)}, 160)...)
}

func sidOf(down []byte) uint16 { return binary.BigEndian.Uint16(down[1:3]) }

// sleep advances the fake clock and lets Echobot's timers run.
func sleep(d time.Duration) {
	time.Sleep(d)
	synctest.Wait()
}

func TestEchobotReplaysTransmissionAfterChannelGoesQuiet(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newEchoHub()
		a := joinOn(h, "ALPHA", chEcho)
		b := joinOn(h, "BRAVO", chEcho)
		other := joinOn(h, "CHARLIE", chPlainTac)

		send(h, a, `{"t":"key","ch":%d}`, chEcho)
		h.Audio(a.Client, voiceFrame(1))
		sleep(20 * time.Millisecond)
		h.Audio(a.Client, voiceFrame(2))
		sleep(20 * time.Millisecond)
		send(h, a, `{"t":"unkey"}`)
		if _, live := drain(b); len(live) != 2 {
			t.Fatalf("BRAVO should hear ALPHA live, got %d frames", len(live))
		}
		drain(a)

		sleep(echoDelay - time.Millisecond)
		if ctrl, audio := drain(b); len(ctrl) != 0 || len(audio) != 0 {
			t.Fatalf("Echobot should wait for the channel to be quiet, got %v and %d frames", ctrl, len(audio))
		}

		sleep(time.Millisecond)
		ctrl, audio := drain(b)
		if !hasMsg(ctrl, "rx_start", "ch", chEcho) || hasMsg(ctrl, "rx_start", "from", echoCallsign) {
			t.Fatalf("the echo should start like any FM transmission, with no caller ID, got %v", ctrl)
		}
		if len(audio) != 1 || !bytes.Equal(audio[0][3:], voiceFrame(1)) || audio[0][0] != chEcho {
			t.Fatalf("the echo should open with ALPHA's first frame, unchanged, got %v", audio)
		}
		sid := sidOf(audio[0])
		if sid == a.ID || sid == b.ID {
			t.Fatalf("the echo must not reuse a radio's stream ID, got %d", sid)
		}
		if _, audio := drain(a); len(audio) != 1 {
			t.Fatalf("ALPHA should hear its own echo, got %d frames", len(audio))
		}

		sleep(20 * time.Millisecond)
		_, audio = drain(b)
		if len(audio) != 1 || !bytes.Equal(audio[0][3:], voiceFrame(2)) || sidOf(audio[0]) != sid {
			t.Fatalf("the second frame should follow 20 ms later on the same stream, got %v", audio)
		}

		sleep(20 * time.Millisecond)
		ctrl, _ = drain(b)
		if !hasMsg(ctrl, "rx_end", "sid", sid) {
			t.Fatalf("the echo should end when ALPHA unkeyed, got %v", ctrl)
		}
		if h.echo.tx != nil {
			t.Fatalf("Echobot should be off the air after the replay")
		}

		if ctrl, audio := drain(other); len(ctrl) != 0 || len(audio) != 0 {
			t.Fatalf("a radio on another channel should hear none of it, got %v and %d frames", ctrl, len(audio))
		}
	})
}

func TestEchobotReplaysADoubleAsTwoStreams(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newEchoHub()
		a := joinOn(h, "ALPHA", chEcho)
		b := joinOn(h, "BRAVO", chEcho)
		c := joinOn(h, "CHARLIE", chEcho)

		send(h, a, `{"t":"key","ch":%d}`, chEcho)
		h.Audio(a.Client, voiceFrame(1))
		sleep(20 * time.Millisecond)
		send(h, b, `{"t":"key","ch":%d}`, chEcho)
		h.Audio(a.Client, voiceFrame(2))
		h.Audio(b.Client, voiceFrame(101))
		sleep(20 * time.Millisecond)
		send(h, a, `{"t":"unkey"}`)
		h.Audio(b.Client, voiceFrame(102))
		sleep(20 * time.Millisecond)
		send(h, b, `{"t":"unkey"}`)
		drain(c)

		// ALPHA unkeying alone doesn't end the take; BRAVO was still talking.
		sleep(echoDelay)
		_, audio := drain(c)
		if len(audio) != 1 || !bytes.Equal(audio[0][3:], voiceFrame(1)) {
			t.Fatalf("the replay should start with ALPHA alone, got %v", audio)
		}
		alphaSid := sidOf(audio[0])

		sleep(20 * time.Millisecond)
		_, audio = drain(c)
		if len(audio) != 2 {
			t.Fatalf("CHARLIE should get both voices overlapping, got %d frames", len(audio))
		}
		bravoSid := sidOf(audio[1])
		if sidOf(audio[0]) != alphaSid || bravoSid == alphaSid || !bytes.Equal(audio[1][3:], voiceFrame(101)) {
			t.Fatalf("each voice should be its own stream so receivers double them, got %v", audio)
		}

		sleep(20 * time.Millisecond)
		ctrl, audio := drain(c)
		if !hasMsg(ctrl, "rx_end", "sid", alphaSid) || len(audio) != 1 || sidOf(audio[0]) != bravoSid {
			t.Fatalf("ALPHA's echo should end while BRAVO's carries on, got %v and %v", ctrl, audio)
		}

		sleep(20 * time.Millisecond)
		ctrl, _ = drain(c)
		if !hasMsg(ctrl, "rx_end", "sid", bravoSid) {
			t.Fatalf("BRAVO's echo should end, got %v", ctrl)
		}
	})
}

func TestEchobotDoublesWithANewTalkerAndEchoesThemNext(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newEchoHub()
		a := joinOn(h, "ALPHA", chEcho)
		b := joinOn(h, "BRAVO", chEcho)

		send(h, a, `{"t":"key","ch":%d}`, chEcho)
		h.Audio(a.Client, voiceFrame(1))
		sleep(20 * time.Millisecond)
		h.Audio(a.Client, voiceFrame(2))
		sleep(20 * time.Millisecond)
		send(h, a, `{"t":"unkey"}`)
		sleep(echoDelay)
		drain(a)
		drain(b)

		// ALPHA keys again mid-replay.
		send(h, a, `{"t":"key","ch":%d}`, chEcho)
		h.Audio(a.Client, voiceFrame(3))
		sleep(20 * time.Millisecond)
		_, audio := drain(b)
		if len(audio) != 2 || sidOf(audio[0]) != a.ID || sidOf(audio[1]) == a.ID {
			t.Fatalf("BRAVO should hear ALPHA doubling with Echobot, got %v", audio)
		}
		if _, audio := drain(a); len(audio) != 0 {
			t.Fatalf("ALPHA is transmitting and should hear nothing, got %d frames", len(audio))
		}
		send(h, a, `{"t":"unkey"}`)

		sleep(20 * time.Millisecond)
		drain(b)
		sleep(echoDelay - time.Millisecond)
		if _, audio := drain(b); len(audio) != 0 {
			t.Fatalf("the next echo should wait for a quiet gap after the replay, got %d frames", len(audio))
		}
		sleep(time.Millisecond)
		_, audio = drain(b)
		if len(audio) != 1 || !bytes.Equal(audio[0][3:], voiceFrame(3)) {
			t.Fatalf("Echobot should echo ALPHA's second transmission, without its own replay mixed in, got %v", audio)
		}
	})
}

func TestEchobotSkipsTransmissionsWithNoAudio(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newEchoHub()
		a := joinOn(h, "ALPHA", chEcho)
		b := joinOn(h, "BRAVO", chEcho)

		send(h, a, `{"t":"key","ch":%d}`, chEcho)
		send(h, a, `{"t":"unkey"}`)
		drain(b)
		sleep(2 * echoDelay)
		if ctrl, _ := drain(b); len(ctrl) != 0 {
			t.Fatalf("a key-up with no audio shouldn't be echoed, got %v", ctrl)
		}
	})
}

func TestEchobotIsOnTheRoster(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newEchoHub()
		a := joinOn(h, "ALPHA", chEcho)

		if _, err := joinSession(h, "ECHOBOT", "sid-x"); err != ErrCallsignInUse {
			t.Fatalf("nobody should be able to log in as Echobot, got %v", err)
		}
		if !h.InUse("ECHOBOT", "sid-x") {
			t.Fatalf("the login page should report Echobot's callsign as taken")
		}

		send(h, a, `{"t":"key","ch":%d}`, chEcho)
		h.Audio(a.Client, voiceFrame(1))
		sleep(20 * time.Millisecond)
		send(h, a, `{"t":"unkey"}`)
		sleep(echoDelay)

		var echobot map[string]any
		for _, c := range h.stateLocked()["clients"].([]map[string]any) {
			if c["callsign"] == echoCallsign {
				echobot = c
			}
		}
		if echobot == nil || echobot["channel"] != chEcho || echobot["tx"] == nil {
			t.Fatalf("the roster should show Echobot transmitting on echo, got %v", echobot)
		}
	})
}
