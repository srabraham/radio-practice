package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

const (
	chDispatch = 0 // digital repeater
	chOps      = 1 // digital repeater
	chTac1     = 3 // FM simplex
	chTac2     = 4
	chVog      = 5 // added by the hub after the plan
)

type testRadio struct {
	*Client
	kicked     bool
	kickReason KickReason
}

// testChannels is fixed so tests don't depend on the event's channel plan.
func testChannels() []ChannelConfig {
	return []ChannelConfig{
		{Name: "DISPATCH", Mode: ModeRepeater},
		{Name: "OPS", Mode: ModeRepeater},
		{Name: "MEDICAL", Mode: ModeRepeater},
		{Name: "TAC 1", Mode: ModeSimplex},
		{Name: "TAC 2", Mode: ModeSimplex},
	}
}

// newTestHub turns off repeater key-up latency so tests can send audio right
// after keying; TestRepeaterClipsStartOfTransmission covers it.
func newTestHub(tot time.Duration) *Hub {
	h := NewHub(testChannels(), tot)
	h.rptrDelay = 0
	return h
}

// join connects callsign from its own login session ("sid-" + callsign), so
// joining the same callsign twice looks like a reconnect.
func join(h *Hub, callsign string) *testRadio {
	r, err := joinSession(h, callsign, "sid-"+callsign)
	if err != nil {
		panic(err)
	}
	return r
}

func joinSession(h *Hub, callsign, sid string) (*testRadio, error) {
	r := &testRadio{}
	c, err := h.Join(callsign, sid, make(chan outMsg, 1024), func(why KickReason) {
		r.kicked, r.kickReason = true, why
	})
	if err != nil {
		return nil, err
	}
	r.Client = c
	drain(r)
	return r, nil
}

func send(h *Hub, r *testRadio, format string, args ...any) {
	h.HandleJSON(r.Client, []byte(fmt.Sprintf(format, args...)))
}

// drain returns everything queued for r: control messages and audio frames.
func drain(r *testRadio) (ctrl []map[string]any, audio [][]byte) {
	for {
		select {
		case m := <-r.send:
			if m.binary {
				audio = append(audio, m.data)
				continue
			}
			var v map[string]any
			json.Unmarshal(m.data, &v)
			ctrl = append(ctrl, v)
		default:
			return
		}
	}
}

func hasMsg(ctrl []map[string]any, t string, key string, want any) bool {
	for _, m := range ctrl {
		if m["t"] == t && (key == "" || fmt.Sprint(m[key]) == fmt.Sprint(want)) {
			return true
		}
	}
	return false
}

var frame = append([]byte{0, 1}, make([]byte, 160)...)

func TestRepeaterFloorControl(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	b := join(h, "BRAVO")
	c := join(h, "CHARLIE")

	send(h, a, `{"t":"key","ch":%d}`, chDispatch)
	ctrl, _ := drain(a)
	if !hasMsg(ctrl, "tx_ok", "ch", chDispatch) {
		t.Fatalf("ALPHA should get the floor, got %v", ctrl)
	}
	ctrl, _ = drain(c)
	if !hasMsg(ctrl, "rx_start", "from", "ALPHA") {
		t.Fatalf("CHARLIE should see ALPHA's caller ID, got %v", ctrl)
	}

	send(h, b, `{"t":"key","ch":%d}`, chDispatch)
	ctrl, _ = drain(b)
	if !hasMsg(ctrl, "tx_deny", "reason", "busy") {
		t.Fatalf("BRAVO should be denied while ALPHA holds the floor, got %v", ctrl)
	}
	h.Audio(b.Client, frame)
	if _, audio := drain(c); len(audio) != 0 {
		t.Fatalf("audio from a denied radio must not be forwarded")
	}

	h.Audio(a.Client, frame)
	_, audio := drain(c)
	if len(audio) != 1 || audio[0][0] != chDispatch {
		t.Fatalf("CHARLIE should hear ALPHA's frame on DISPATCH, got %v", audio)
	}

	send(h, a, `{"t":"unkey"}`)
	ctrl, _ = drain(c)
	if !hasMsg(ctrl, "rx_end", "sid", a.ID) {
		t.Fatalf("CHARLIE should get rx_end, got %v", ctrl)
	}
	send(h, b, `{"t":"key","ch":%d}`, chDispatch)
	ctrl, _ = drain(b)
	if !hasMsg(ctrl, "tx_ok", "", nil) {
		t.Fatalf("BRAVO should get the floor after ALPHA unkeys, got %v", ctrl)
	}
}

func TestRepeaterClipsStartOfTransmission(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newTestHub(time.Minute)
		h.rptrDelay = time.Second
		a := join(h, "ALPHA")
		b := join(h, "BRAVO")

		send(h, a, `{"t":"key","ch":%d}`, chDispatch)
		h.Audio(a.Client, frame)
		if _, audio := drain(b); len(audio) != 0 {
			t.Fatalf("audio right after the talk-permit tone should be clipped, got %d frames", len(audio))
		}

		time.Sleep(time.Second)
		h.Audio(a.Client, frame)
		if _, audio := drain(b); len(audio) != 1 {
			t.Fatalf("audio after the repeater delay should go out, got %d frames", len(audio))
		}
	})
}

func TestSimplexIsNotClipped(t *testing.T) {
	h := newTestHub(time.Minute)
	h.rptrDelay = time.Minute
	a := join(h, "ALPHA")
	b := join(h, "BRAVO")
	send(h, a, `{"t":"tune","ch":%d}`, chTac1)
	send(h, b, `{"t":"tune","ch":%d}`, chTac1)
	drain(b)

	send(h, a, `{"t":"key","ch":%d}`, chTac1)
	h.Audio(a.Client, frame)
	if _, audio := drain(b); len(audio) != 1 {
		t.Fatalf("simplex keys immediately and should not be clipped, got %d frames", len(audio))
	}
}

func TestSimplexAllowsDoublingAndIsHalfDuplex(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	b := join(h, "BRAVO")
	c := join(h, "CHARLIE")
	for _, r := range []*testRadio{a, b, c} {
		send(h, r, `{"t":"tune","ch":%d}`, chTac1)
		drain(r)
	}

	send(h, a, `{"t":"key","ch":%d}`, chTac1)
	send(h, b, `{"t":"key","ch":%d}`, chTac1)
	ctrlA, _ := drain(a)
	ctrlB, _ := drain(b)
	if !hasMsg(ctrlA, "tx_ok", "", nil) || !hasMsg(ctrlB, "tx_ok", "", nil) {
		t.Fatalf("simplex has no floor lock; both should key up: %v / %v", ctrlA, ctrlB)
	}
	ctrl, _ := drain(c)
	if hasMsg(ctrl, "rx_start", "from", "ALPHA") {
		t.Fatalf("analog FM must not reveal caller ID, got %v", ctrl)
	}

	h.Audio(a.Client, frame)
	h.Audio(b.Client, frame)
	_, audio := drain(c)
	if len(audio) != 2 {
		t.Fatalf("CHARLIE should receive both overlapping streams to mix/capture, got %d", len(audio))
	}
	if _, audio := drain(b); len(audio) != 0 {
		t.Fatalf("BRAVO is transmitting and must not hear ALPHA")
	}
}

func TestTimeOutTimerEndsTransmission(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newTestHub(time.Minute)
		a := join(h, "ALPHA")
		b := join(h, "BRAVO")

		send(h, a, `{"t":"key","ch":%d}`, chDispatch)
		drain(a)
		time.Sleep(time.Minute)
		// The TOT fires in an AfterFunc goroutine; let it finish.
		synctest.Wait()

		ctrl, _ := drain(a)
		if !hasMsg(ctrl, "tx_end", "reason", "tot") {
			t.Fatalf("ALPHA should be cut off by the TOT, got %v", ctrl)
		}
		send(h, b, `{"t":"key","ch":%d}`, chDispatch)
		ctrl, _ = drain(b)
		if !hasMsg(ctrl, "tx_ok", "", nil) {
			t.Fatalf("floor should be free after TOT, got %v", ctrl)
		}
	})
}

func TestDisconnectReleasesFloor(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	b := join(h, "BRAVO")

	send(h, a, `{"t":"key","ch":%d}`, chDispatch)
	h.Leave(a.Client)
	drain(b)

	send(h, b, `{"t":"key","ch":%d}`, chDispatch)
	ctrl, _ := drain(b)
	if !hasMsg(ctrl, "tx_ok", "", nil) {
		t.Fatalf("floor should be free after the holder disconnects, got %v", ctrl)
	}
}

func TestReconnectReplacesOldConnection(t *testing.T) {
	h := newTestHub(time.Minute)
	old := join(h, "ALPHA")
	send(h, old, `{"t":"key","ch":%d}`, chDispatch)

	fresh := join(h, "ALPHA")
	if !old.kicked || old.kickReason != KickReplaced {
		t.Fatalf("old connection should be kicked as replaced, got kicked=%v reason=%v", old.kicked, old.kickReason)
	}
	h.Leave(old.Client) // the old handler exiting must not remove the new one
	if h.byCall["ALPHA"] != fresh.Client {
		t.Fatalf("new connection should own the callsign")
	}
	if h.channels[chDispatch].holder != nil {
		t.Fatalf("old connection's transmission should have ended")
	}
}

func TestSameCallsignFromAnotherLoginIsRefused(t *testing.T) {
	h := newTestHub(time.Minute)
	first, _ := joinSession(h, "ALPHA", "phone")

	if !h.InUse("ALPHA", "laptop") {
		t.Fatalf("ALPHA should be in use for another login")
	}
	if h.InUse("ALPHA", "phone") {
		t.Fatalf("ALPHA should not be in use for its own login")
	}

	second, err := joinSession(h, "ALPHA", "laptop")
	if err != ErrCallsignInUse {
		t.Fatalf("got %v, want ErrCallsignInUse", err)
	}
	if second != nil {
		t.Fatalf("refused join should not return a client")
	}
	if first.kicked {
		t.Fatalf("the connected radio should not be kicked")
	}
	if h.byCall["ALPHA"] != first.Client {
		t.Fatalf("the connected radio should keep the callsign")
	}

	// Once the first radio leaves, the callsign is free again.
	h.Leave(first.Client)
	if _, err := joinSession(h, "ALPHA", "laptop"); err != nil {
		t.Fatalf("callsign should be free after the holder leaves, got %v", err)
	}
}

func TestScanReceivesOtherChannels(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	b := join(h, "BRAVO")
	send(h, a, `{"t":"tune","ch":%d}`, chTac2)
	send(h, b, `{"t":"scan","on":true,"list":[%d,%d]}`, chDispatch, chTac2)
	drain(b)

	send(h, a, `{"t":"key","ch":%d}`, chTac2)
	h.Audio(a.Client, frame)
	_, audio := drain(b)
	if len(audio) != 1 || audio[0][0] != chTac2 {
		t.Fatalf("scanning radio should hear TAC 2 tagged with its channel, got %v", audio)
	}
}

func TestVoiceOfGodCutsRepeatersOnly(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	b := join(h, "BRAVO")
	c := join(h, "CHARLIE")
	d := join(h, "DELTA")
	god := join(h, "GOD")
	send(h, b, `{"t":"tune","ch":%d}`, chOps)
	send(h, c, `{"t":"tune","ch":%d}`, chTac1)
	send(h, d, `{"t":"tune","ch":%d}`, chTac1)
	send(h, god, `{"t":"tune","ch":%d}`, chVog)

	send(h, a, `{"t":"key","ch":%d}`, chDispatch)
	send(h, c, `{"t":"key","ch":%d}`, chTac1)
	for _, r := range []*testRadio{a, b, c, d, god} {
		drain(r)
	}

	send(h, god, `{"t":"key","ch":%d}`, chVog)
	ctrl, _ := drain(god)
	if !hasMsg(ctrl, "tx_ok", "ch", chVog) {
		t.Fatalf("GOD should get the floor on every repeater, got %v", ctrl)
	}
	ctrl, _ = drain(a)
	if !hasMsg(ctrl, "tx_end", "reason", "vog") {
		t.Fatalf("ALPHA should be cut off by Voice of God, got %v", ctrl)
	}
	ctrl, _ = drain(b)
	if !hasMsg(ctrl, "rx_start", "from", "GOD") {
		t.Fatalf("BRAVO on OPS should hear GOD, got %v", ctrl)
	}
	if c.tx == nil {
		t.Fatalf("CHARLIE on simplex must not be cut")
	}

	h.Audio(god.Client, frame)
	if _, audio := drain(a); len(audio) != 1 || audio[0][0] != chDispatch {
		t.Fatalf("ALPHA should now hear GOD on DISPATCH, got %v", audio)
	}
	if _, audio := drain(b); len(audio) != 1 || audio[0][0] != chOps {
		t.Fatalf("BRAVO should hear GOD on OPS, got %v", audio)
	}
	if _, audio := drain(d); len(audio) != 0 {
		t.Fatalf("DELTA on simplex should not hear Voice of God, got %v", audio)
	}

	send(h, a, `{"t":"key","ch":%d}`, chDispatch)
	ctrl, _ = drain(a)
	if !hasMsg(ctrl, "tx_deny", "reason", "busy") {
		t.Fatalf("repeaters should be busy during Voice of God, got %v", ctrl)
	}

	send(h, god, `{"t":"unkey"}`)
	ctrl, _ = drain(b)
	if !hasMsg(ctrl, "rx_end", "sid", god.ID) {
		t.Fatalf("BRAVO should get rx_end, got %v", ctrl)
	}
	send(h, b, `{"t":"key","ch":%d}`, chOps)
	ctrl, _ = drain(b)
	if !hasMsg(ctrl, "tx_ok", "", nil) {
		t.Fatalf("repeaters should be free after Voice of God ends, got %v", ctrl)
	}
}

func TestVoiceOfGodDoesNotCutAnotherVoiceOfGod(t *testing.T) {
	h := newTestHub(time.Minute)
	god1 := join(h, "GOD1")
	god2 := join(h, "GOD2")

	send(h, god1, `{"t":"key","ch":%d}`, chVog)
	drain(god1)
	send(h, god2, `{"t":"key","ch":%d}`, chVog)
	ctrl, _ := drain(god2)
	if !hasMsg(ctrl, "tx_deny", "reason", "busy") {
		t.Fatalf("a second Voice of God should be denied, got %v", ctrl)
	}
	ctrl, _ = drain(god1)
	if hasMsg(ctrl, "tx_end", "", nil) || god1.tx == nil {
		t.Fatalf("the first Voice of God should keep going, got %v", ctrl)
	}
}

func TestVoiceOfGodChannelListensToEveryRepeater(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	b := join(h, "BRAVO")
	c := join(h, "CHARLIE")
	send(h, b, `{"t":"tune","ch":%d}`, chTac1)
	send(h, c, `{"t":"tune","ch":%d}`, chVog)

	send(h, a, `{"t":"key","ch":%d}`, chOps)
	h.Audio(a.Client, frame)
	ctrl, audio := drain(c)
	if !hasMsg(ctrl, "rx_start", "from", "ALPHA") || len(audio) != 1 || audio[0][0] != chOps {
		t.Fatalf("CHARLIE should hear ALPHA on OPS with caller ID, got %v / %v", ctrl, audio)
	}
	send(h, a, `{"t":"unkey"}`)
	drain(c)

	send(h, b, `{"t":"key","ch":%d}`, chTac1)
	h.Audio(b.Client, frame)
	if _, audio := drain(c); len(audio) != 0 {
		t.Fatalf("simplex is not a repeater; CHARLIE should not hear it, got %v", audio)
	}
	send(h, b, `{"t":"unkey"}`)

	// Voice of God goes out on every repeater, but CHARLIE gets one copy.
	send(h, a, `{"t":"key","ch":%d}`, chVog)
	h.Audio(a.Client, frame)
	ctrl, audio = drain(c)
	starts := 0
	for _, m := range ctrl {
		if m["t"] == "rx_start" {
			starts++
		}
	}
	if starts != 1 || len(audio) != 1 {
		t.Fatalf("CHARLIE should get one rx_start and one frame of Voice of God, got %d / %d", starts, len(audio))
	}
}

func TestScanSkipsVoiceOfGodChannel(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	send(h, a, `{"t":"scan","on":true,"list":[%d,%d]}`, chTac1, chVog)
	if a.scanList[chVog] || !a.scanList[chTac1] {
		t.Fatalf("scan list should hold TAC 1 only, got %v", a.scanList)
	}
}

func TestMessageReachesEveryone(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	b := join(h, "BRAVO")

	send(h, a, `{"t":"msg","text":"  Radio check  "}`)
	ctrlA, _ := drain(a)
	ctrlB, _ := drain(b)
	if !hasMsg(ctrlA, "msg", "text", "Radio check") {
		t.Fatalf("the sender should get its own message back, trimmed, got %v", ctrlA)
	}
	if !hasMsg(ctrlB, "msg", "from", "ALPHA") || !hasMsg(ctrlB, "msg", "text", "Radio check") {
		t.Fatalf("BRAVO should get ALPHA's message, got %v", ctrlB)
	}

	// A radio that connects later gets the history in hello.
	c := &testRadio{}
	cl, err := h.Join("CHARLIE", "sid-CHARLIE", make(chan outMsg, 1024), func(KickReason) {})
	if err != nil {
		t.Fatal(err)
	}
	c.Client = cl
	ctrl, _ := drain(c)
	hello := ctrl[0]
	msgs, _ := hello["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["text"] != "Radio check" {
		t.Fatalf("hello should carry the message history, got %v", hello["messages"])
	}
}

func TestBlankMessageIsDropped(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	b := join(h, "BRAVO")
	send(h, a, `{"t":"msg","text":"   "}`)
	if ctrl, _ := drain(b); hasMsg(ctrl, "msg", "", nil) {
		t.Fatalf("a blank message should not be sent, got %v", ctrl)
	}
	if len(h.messages) != 0 {
		t.Fatalf("a blank message should not be kept, got %v", h.messages)
	}
}

func TestLongMessageIsCut(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	long := strings.Repeat("é", maxMessageLen+10)
	send(h, a, `{"t":"msg","text":%q}`, long)
	if got := []rune(h.messages[0].Text); len(got) != maxMessageLen {
		t.Fatalf("got a %d-rune message, want %d", len(got), maxMessageLen)
	}
}

func TestMessageHistoryIsBounded(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	for i := range keepMessages + 5 {
		send(h, a, `{"t":"msg","text":"m%d"}`, i)
	}
	if len(h.messages) != keepMessages || h.messages[0].Text != "m5" {
		t.Fatalf("should keep the last %d messages, got %d starting at %q", keepMessages, len(h.messages), h.messages[0].Text)
	}
}

func TestRosterGoesOnlyToWatchers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newTestHub(time.Minute)
		a := join(h, "ALPHA")
		b := join(h, "BRAVO")
		stop := make(chan struct{})
		defer close(stop)
		go h.RunStateBroadcast(200*time.Millisecond, stop)

		send(h, a, `{"t":"watch","on":true}`)
		ctrl, _ := drain(a)
		if !hasMsg(ctrl, "state", "", nil) {
			t.Fatalf("opening the column should send the roster right away, got %v", ctrl)
		}

		send(h, b, `{"t":"key","ch":%d}`, chVog)
		drain(b)
		time.Sleep(200 * time.Millisecond)
		synctest.Wait()
		ctrl, _ = drain(a)
		var bravo map[string]any
		for _, m := range ctrl {
			if m["t"] != "state" {
				continue
			}
			for _, c := range m["clients"].([]any) {
				if c := c.(map[string]any); c["callsign"] == "BRAVO" {
					bravo = c
				}
			}
		}
		if bravo == nil || bravo["tx"] == nil || bravo["tx"].(map[string]any)["ch"] != float64(chVog) {
			t.Fatalf("the roster should show BRAVO transmitting on Voice of God, got %v", ctrl)
		}
		if ctrl, _ := drain(b); hasMsg(ctrl, "state", "", nil) {
			t.Fatalf("BRAVO isn't watching and should get no roster, got %v", ctrl)
		}

		send(h, a, `{"t":"watch","on":false}`)
		send(h, b, `{"t":"unkey"}`)
		time.Sleep(200 * time.Millisecond)
		synctest.Wait()
		if ctrl, _ := drain(a); hasMsg(ctrl, "state", "", nil) {
			t.Fatalf("closing the column should stop roster updates, got %v", ctrl)
		}
	})
}

func TestReplacedConnectionIsIgnored(t *testing.T) {
	h := newTestHub(time.Minute)
	old := join(h, "ALPHA")
	b := join(h, "BRAVO")
	join(h, "ALPHA")
	drain(b)

	// The old connection is still closing when these arrive.
	send(h, old, `{"t":"key","ch":%d}`, chDispatch)
	if h.channels[chDispatch].holder != nil {
		t.Fatalf("a replaced connection must not take the floor")
	}
	old.tx = &transmission{chs: []int{chDispatch}, timer: time.NewTimer(time.Hour)}
	h.Audio(old.Client, frame)
	if _, audio := drain(b); len(audio) != 0 {
		t.Fatalf("audio from a replaced connection must not be forwarded, got %d frames", len(audio))
	}
}

func TestSlowClientIsKickedToReconnect(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA")
	// Room for hello and nothing else.
	slow := &testRadio{}
	c, err := h.Join("SLOW", "sid-SLOW", make(chan outMsg, 1), func(why KickReason) {
		slow.kicked, slow.kickReason = true, why
	})
	if err != nil {
		t.Fatal(err)
	}
	slow.Client = c

	send(h, a, `{"t":"key","ch":%d}`, chDispatch)
	if !slow.kicked || slow.kickReason != KickTooSlow {
		t.Fatalf("a client with a full queue should be kicked as too slow, got kicked=%v reason=%v", slow.kicked, slow.kickReason)
	}
}
