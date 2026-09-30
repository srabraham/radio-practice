package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

const (
	chDispatch = 0 // digital repeater
	chOps      = 1 // digital repeater
	chTac1     = 3 // FM simplex
	chTac2     = 4
)

type testRadio struct {
	*Client
	kicked bool
}

// testChannels is fixed so tests don't depend on the event's channel plan.
func testChannels() []ChannelConfig {
	rptrA := clockPos(6, 1850)
	rptrB := clockPos(3, 1850)
	return []ChannelConfig{
		{Name: "DISPATCH", Mode: ModeRepeater, Repeater: &rptrA, RepeaterRange: 6000},
		{Name: "OPS", Mode: ModeRepeater, Repeater: &rptrB, RepeaterRange: 6000},
		{Name: "MEDICAL", Mode: ModeRepeater, Repeater: &rptrA, RepeaterRange: 6000},
		{Name: "TAC 1", Mode: ModeSimplex},
		{Name: "TAC 2", Mode: ModeSimplex},
	}
}

func newTestHub(tot time.Duration) *Hub {
	return NewHub(testChannels(), defaultLandmarks(), tot)
}

// join connects callsign from its own login session ("sid-" + callsign), so
// joining the same callsign twice looks like a reconnect.
func join(h *Hub, callsign string, role Role) *testRadio {
	r, err := joinSession(h, callsign, "sid-"+callsign, role)
	if err != nil {
		panic(err)
	}
	return r
}

func joinSession(h *Hub, callsign, sid string, role Role) (*testRadio, error) {
	r := &testRadio{}
	c, err := h.Join(callsign, sid, role, make(chan outMsg, 1024), func() { r.kicked = true })
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
	a := join(h, "ALPHA", RoleParticipant)
	b := join(h, "BRAVO", RoleParticipant)
	c := join(h, "CHARLIE", RoleParticipant)

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
	if len(audio) != 1 || audio[0][0] != chDispatch || audio[0][3] == 0 {
		t.Fatalf("CHARLIE should hear ALPHA's frame with a quality byte, got %v", audio)
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

func TestRepeaterOutOfRangeIsDenied(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA", RoleParticipant)

	send(h, a, `{"t":"zone_add","x":0,"y":0,"r":5000,"loss":1}`)
	if len(h.zones) != 0 {
		t.Fatalf("participants must not be able to add dead zones")
	}

	h.zones = []Zone{{ID: 1, Center: a.pos, Radius: 100, Loss: 1}}
	send(h, a, `{"t":"key","ch":%d}`, chDispatch)
	ctrl, _ := drain(a)
	if !hasMsg(ctrl, "tx_deny", "reason", "no_repeater") {
		t.Fatalf("a radio inside a total dead zone can't reach the repeater, got %v", ctrl)
	}
}

func TestSimplexAllowsDoublingAndIsHalfDuplex(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA", RoleParticipant)
	b := join(h, "BRAVO", RoleParticipant)
	c := join(h, "CHARLIE", RoleParticipant)
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

func TestSimplexRange(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA", RoleParticipant)
	b := join(h, "BRAVO", RoleParticipant)
	c := join(h, "CHARLIE", RoleParticipant)
	for _, r := range []*testRadio{a, b, c} {
		send(h, r, `{"t":"tune","ch":%d}`, chTac1)
	}
	send(h, a, `{"t":"pos","loc":"3-k"}`)
	send(h, b, `{"t":"pos","loc":"9-k"}`)   // 3.4 km away: out of range
	send(h, c, `{"t":"pos","loc":"3-esp"}`) // ~1 km away: in range
	drain(b)
	drain(c)

	send(h, a, `{"t":"key","ch":%d}`, chTac1)
	h.Audio(a.Client, frame)
	if _, audio := drain(b); len(audio) != 0 {
		t.Fatalf("BRAVO across the city should hear nothing on simplex")
	}
	if _, audio := drain(c); len(audio) != 1 {
		t.Fatalf("CHARLIE nearby should hear ALPHA")
	}
}

func TestTimeOutTimerEndsTransmission(t *testing.T) {
	h := newTestHub(30 * time.Millisecond)
	a := join(h, "ALPHA", RoleParticipant)
	b := join(h, "BRAVO", RoleParticipant)

	send(h, a, `{"t":"key","ch":%d}`, chDispatch)
	drain(a)
	time.Sleep(80 * time.Millisecond)

	ctrl, _ := drain(a)
	if !hasMsg(ctrl, "tx_end", "reason", "tot") {
		t.Fatalf("ALPHA should be cut off by the TOT, got %v", ctrl)
	}
	send(h, b, `{"t":"key","ch":%d}`, chDispatch)
	ctrl, _ = drain(b)
	if !hasMsg(ctrl, "tx_ok", "", nil) {
		t.Fatalf("floor should be free after TOT, got %v", ctrl)
	}
}

func TestInstructorForceUnkeyAndMonitor(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA", RoleParticipant)
	ctl := join(h, "CONTROL", RoleInstructor)
	send(h, a, `{"t":"tune","ch":%d}`, chTac2)
	drain(a)

	send(h, a, `{"t":"key","ch":%d}`, chTac2)
	h.Audio(a.Client, frame)
	ctrl, audio := drain(ctl)
	if !hasMsg(ctrl, "rx_start", "from", "ALPHA") || len(audio) != 1 {
		t.Fatalf("instructor monitors every channel with caller ID, got %v / %d frames", ctrl, len(audio))
	}

	send(h, ctl, `{"t":"force_unkey","id":%d}`, a.ID)
	ctrl, _ = drain(a)
	if !hasMsg(ctrl, "tx_end", "reason", "forced") {
		t.Fatalf("ALPHA should be force-unkeyed, got %v", ctrl)
	}
}

func TestDisconnectReleasesFloor(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA", RoleParticipant)
	b := join(h, "BRAVO", RoleParticipant)

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
	old := join(h, "ALPHA", RoleParticipant)
	send(h, old, `{"t":"key","ch":%d}`, chDispatch)

	fresh := join(h, "ALPHA", RoleParticipant)
	if !old.kicked {
		t.Fatalf("old connection should be kicked")
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
	first, _ := joinSession(h, "ALPHA", "phone", RoleParticipant)

	if !h.InUse("ALPHA", "laptop") {
		t.Fatalf("ALPHA should be in use for another login")
	}
	if h.InUse("ALPHA", "phone") {
		t.Fatalf("ALPHA should not be in use for its own login")
	}

	second, err := joinSession(h, "ALPHA", "laptop", RoleParticipant)
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
	if _, err := joinSession(h, "ALPHA", "laptop", RoleParticipant); err != nil {
		t.Fatalf("callsign should be free after the holder leaves, got %v", err)
	}
}

func TestScanReceivesOtherChannels(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA", RoleParticipant)
	b := join(h, "BRAVO", RoleParticipant)
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

func TestInstructorMoveZoneAndPrompt(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA", RoleParticipant)
	b := join(h, "BRAVO", RoleParticipant)
	ctl := join(h, "CONTROL", RoleInstructor)
	for _, r := range []*testRadio{a, b} {
		send(h, r, `{"t":"tune","ch":%d}`, chTac1)
		drain(r)
	}

	send(h, ctl, `{"t":"move","id":%d,"x":3000,"y":0}`, b.ID)
	ctrl, _ := drain(b)
	if !hasMsg(ctrl, "pos", "", nil) {
		t.Fatalf("BRAVO should be told it was moved, got %v", ctrl)
	}
	send(h, a, `{"t":"key","ch":%d}`, chTac1)
	h.Audio(a.Client, frame)
	if _, audio := drain(b); len(audio) != 0 {
		t.Fatalf("BRAVO moved 3 km from Center Camp should be out of simplex range")
	}
	send(h, a, `{"t":"unkey"}`)

	send(h, ctl, `{"t":"move","id":%d,"x":%f,"y":%f}`, b.ID, a.pos.X+200, a.pos.Y)
	send(h, ctl, `{"t":"zone_add","x":%f,"y":%f,"r":50,"loss":1}`, a.pos.X+100, a.pos.Y)
	drain(b)
	send(h, a, `{"t":"key","ch":%d}`, chTac1)
	h.Audio(a.Client, frame)
	if _, audio := drain(b); len(audio) != 0 {
		t.Fatalf("a total dead zone between the radios should block the path")
	}
	send(h, a, `{"t":"unkey"}`)

	send(h, ctl, `{"t":"prompt","text":"Radio check","to":%d}`, a.ID)
	ctrlA, _ := drain(a)
	ctrlB, _ := drain(b)
	if !hasMsg(ctrlA, "prompt", "text", "Radio check") || hasMsg(ctrlB, "prompt", "", nil) {
		t.Fatalf("prompt should reach only ALPHA: %v / %v", ctrlA, ctrlB)
	}
}

func TestVoiceOfGodCutsRepeatersOnly(t *testing.T) {
	h := newTestHub(time.Minute)
	a := join(h, "ALPHA", RoleParticipant)
	b := join(h, "BRAVO", RoleParticipant)
	c := join(h, "CHARLIE", RoleParticipant)
	d := join(h, "DELTA", RoleParticipant)
	ctl := join(h, "CONTROL", RoleInstructor)
	mon := join(h, "MONITOR", RoleInstructor)
	send(h, b, `{"t":"tune","ch":%d}`, chOps)
	send(h, c, `{"t":"tune","ch":%d}`, chTac1)
	send(h, d, `{"t":"tune","ch":%d}`, chTac1)

	send(h, a, `{"t":"key","ch":%d}`, chDispatch)
	send(h, c, `{"t":"key","ch":%d}`, chTac1)
	for _, r := range []*testRadio{a, b, c, d, ctl, mon} {
		drain(r)
	}

	send(h, a, `{"t":"key","vog":true}`)
	if ctrl, _ := drain(a); hasMsg(ctrl, "tx_end", "", nil) {
		t.Fatalf("a participant must not be able to use Voice of God, got %v", ctrl)
	}

	send(h, ctl, `{"t":"key","vog":true}`)
	ctrl, _ := drain(ctl)
	if !hasMsg(ctrl, "tx_ok", "vog", true) {
		t.Fatalf("CONTROL should get the floor on every repeater, got %v", ctrl)
	}
	ctrl, _ = drain(a)
	if !hasMsg(ctrl, "tx_end", "reason", "vog") {
		t.Fatalf("ALPHA should be cut off by Voice of God, got %v", ctrl)
	}
	ctrl, _ = drain(b)
	if !hasMsg(ctrl, "rx_start", "from", "CONTROL") {
		t.Fatalf("BRAVO on OPS should hear CONTROL, got %v", ctrl)
	}
	if c.tx == nil {
		t.Fatalf("CHARLIE on simplex must not be cut")
	}

	h.Audio(ctl.Client, frame)
	if _, audio := drain(a); len(audio) != 1 || audio[0][0] != chDispatch {
		t.Fatalf("ALPHA should now hear CONTROL on DISPATCH, got %v", audio)
	}
	if _, audio := drain(b); len(audio) != 1 || audio[0][0] != chOps {
		t.Fatalf("BRAVO should hear CONTROL on OPS, got %v", audio)
	}
	if _, audio := drain(d); len(audio) != 0 {
		t.Fatalf("DELTA on simplex should not hear Voice of God, got %v", audio)
	}
	if _, audio := drain(mon); len(audio) != 1 {
		t.Fatalf("another console should get one copy of Voice of God, got %d", len(audio))
	}

	send(h, a, `{"t":"key","ch":%d}`, chDispatch)
	ctrl, _ = drain(a)
	if !hasMsg(ctrl, "tx_deny", "reason", "busy") {
		t.Fatalf("repeaters should be busy during Voice of God, got %v", ctrl)
	}

	send(h, ctl, `{"t":"unkey"}`)
	ctrl, _ = drain(b)
	if !hasMsg(ctrl, "rx_end", "sid", ctl.ID) {
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
	ctl1 := join(h, "CONTROL1", RoleInstructor)
	ctl2 := join(h, "CONTROL2", RoleInstructor)

	send(h, ctl1, `{"t":"key","vog":true}`)
	drain(ctl1)
	send(h, ctl2, `{"t":"key","vog":true}`)
	ctrl, _ := drain(ctl2)
	if !hasMsg(ctrl, "tx_deny", "reason", "busy") {
		t.Fatalf("a second Voice of God should be denied, got %v", ctrl)
	}
	ctrl, _ = drain(ctl1)
	if hasMsg(ctrl, "tx_end", "", nil) || ctl1.tx == nil {
		t.Fatalf("the first Voice of God should keep going, got %v", ctrl)
	}
}
