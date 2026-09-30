package main

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"sync"
	"time"
)

type Role string

const (
	RoleParticipant Role = "participant"
	RoleInstructor  Role = "instructor"
)

type outMsg struct {
	binary bool
	data   []byte
}

type Client struct {
	ID       uint16
	Callsign string
	Role     Role

	send chan outMsg
	kick func()

	// Everything below is guarded by Hub.mu.
	channel  int
	scanning bool
	scanList map[int]bool
	monitor  map[int]bool // instructors only
	pos      Pos
	loc      string
	tx       *transmission
}

type transmission struct {
	ch    int
	start time.Time
	timer *time.Timer
}

type channel struct {
	ChannelConfig
	id     int
	holder *Client          // repeater channels: who owns the floor
	txers  map[*Client]bool // simplex channels: everyone keyed up right now
}

type Hub struct {
	mu        sync.Mutex
	channels  []*channel
	landmarks []Landmark
	clients   map[uint16]*Client
	byCall    map[string]*Client
	zones     []Zone
	nextZone  int
	nextID    uint16
	tot       time.Duration
	dirty     bool
}

func NewHub(chans []ChannelConfig, landmarks []Landmark, tot time.Duration) *Hub {
	h := &Hub{
		landmarks: landmarks,
		clients:   map[uint16]*Client{},
		byCall:    map[string]*Client{},
		tot:       tot,
	}
	for i, cfg := range chans {
		h.channels = append(h.channels, &channel{ChannelConfig: cfg, id: i, txers: map[*Client]bool{}})
	}
	return h
}

// Join registers a connection. A callsign that is already connected is
// replaced, which is what a phone reconnecting after sleep looks like.
func (h *Hub) Join(callsign string, role Role, send chan outMsg, kick func()) *Client {
	h.mu.Lock()
	defer h.mu.Unlock()

	if old := h.byCall[callsign]; old != nil {
		h.removeLocked(old)
		old.kick()
	}

	h.nextID++
	for h.nextID == 0 || h.clients[h.nextID] != nil {
		h.nextID++
	}
	c := &Client{
		ID:       h.nextID,
		Callsign: callsign,
		Role:     role,
		send:     send,
		kick:     kick,
		scanList: map[int]bool{},
		monitor:  map[int]bool{},
		loc:      "center-camp",
	}
	c.pos = h.landmark(c.loc).Pos
	if role == RoleInstructor {
		for _, ch := range h.channels {
			c.monitor[ch.id] = true
		}
	}
	h.clients[c.ID] = c
	h.byCall[callsign] = c

	h.sendJSON(c, map[string]any{
		"t":         "hello",
		"you":       map[string]any{"id": c.ID, "callsign": c.Callsign, "role": c.Role},
		"channels":  h.channelInfo(),
		"landmarks": h.landmarks,
		"tot":       h.tot.Seconds(),
		"loc":       c.loc,
		"pos":       c.pos,
	})
	h.sendOngoingLocked(c)
	if role == RoleInstructor {
		h.sendJSON(c, h.stateLocked())
	}
	h.dirty = true
	return c
}

func (h *Hub) Leave(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[c.ID] == c {
		h.removeLocked(c)
	}
}

func (h *Hub) removeLocked(c *Client) {
	h.endTxLocked(c, "")
	delete(h.clients, c.ID)
	if h.byCall[c.Callsign] == c {
		delete(h.byCall, c.Callsign)
	}
	h.dirty = true
}

type inMsg struct {
	T    string  `json:"t"`
	Ch   int     `json:"ch"`
	On   bool    `json:"on"`
	List []int   `json:"list"`
	Loc  string  `json:"loc"`
	ID   uint16  `json:"id"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	R    float64 `json:"r"`
	Loss float64 `json:"loss"`
	Text string  `json:"text"`
	To   uint16  `json:"to"`
}

func (h *Hub) HandleJSON(c *Client, data []byte) {
	var m inMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	switch m.T {
	case "key":
		h.keyLocked(c, m.Ch)
	case "unkey":
		h.endTxLocked(c, "")
	case "tune":
		if h.validChannel(m.Ch) {
			// Changing channel mid-transmission drops the transmission.
			h.endTxLocked(c, "")
			c.channel = m.Ch
			h.sendOngoingLocked(c)
			h.dirty = true
		}
	case "scan":
		c.scanning = m.On
		c.scanList = map[int]bool{}
		for _, id := range m.List {
			if h.validChannel(id) {
				c.scanList[id] = true
			}
		}
		h.sendOngoingLocked(c)
		h.dirty = true
	case "pos":
		if lm := h.landmark(m.Loc); lm != nil {
			c.loc, c.pos = lm.ID, lm.Pos
			h.dirty = true
		}
	}

	if c.Role != RoleInstructor {
		return
	}
	switch m.T {
	case "monitor":
		c.monitor = map[int]bool{}
		for _, id := range m.List {
			if h.validChannel(id) {
				c.monitor[id] = true
			}
		}
		h.sendOngoingLocked(c)
	case "move":
		if t := h.clients[m.ID]; t != nil {
			t.pos, t.loc = Pos{X: m.X, Y: m.Y}, ""
			h.sendJSON(t, map[string]any{"t": "pos", "pos": t.pos, "loc": t.loc})
			h.dirty = true
		}
	case "zone_add":
		if m.R > 0 && m.Loss >= 0 && m.Loss <= 1 {
			h.nextZone++
			h.zones = append(h.zones, Zone{ID: h.nextZone, Center: Pos{X: m.X, Y: m.Y}, Radius: m.R, Loss: m.Loss})
			h.dirty = true
		}
	case "zone_del":
		for i, z := range h.zones {
			if z.ID == int(m.ID) {
				h.zones = append(h.zones[:i], h.zones[i+1:]...)
				h.dirty = true
				break
			}
		}
	case "force_unkey":
		if t := h.clients[m.ID]; t != nil {
			h.endTxLocked(t, "forced")
		}
	case "prompt":
		msg := map[string]any{"t": "prompt", "text": m.Text, "from": c.Callsign}
		for _, r := range h.clients {
			if r.Role == RoleParticipant && (m.To == 0 || m.To == r.ID) {
				h.sendJSON(r, msg)
			}
		}
	}
}

func (h *Hub) keyLocked(c *Client, chID int) {
	if c.tx != nil || !h.validChannel(chID) {
		return
	}
	ch := h.channels[chID]
	switch ch.Mode {
	case ModeRepeater:
		if ch.holder != nil {
			h.sendJSON(c, map[string]any{"t": "tx_deny", "ch": chID, "reason": "busy"})
			return
		}
		if h.uplinkLocked(c, ch) < squelchThreshold {
			h.sendJSON(c, map[string]any{"t": "tx_deny", "ch": chID, "reason": "no_repeater"})
			return
		}
		ch.holder = c
	case ModeSimplex:
		ch.txers[c] = true
	}

	tx := &transmission{ch: chID, start: time.Now()}
	tx.timer = time.AfterFunc(h.tot, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if c.tx == tx {
			h.endTxLocked(c, "tot")
		}
	})
	c.tx = tx
	h.sendJSON(c, map[string]any{"t": "tx_ok", "ch": chID})
	for _, r := range h.clients {
		if r != c && h.subscribedLocked(r, chID) {
			h.sendJSON(r, h.rxStart(c, r, ch))
		}
	}
	h.dirty = true
}

// endTxLocked stops c's transmission. A non-empty reason means the server
// ended it (not the user releasing PTT) and the radio should alert.
func (h *Hub) endTxLocked(c *Client, reason string) {
	tx := c.tx
	if tx == nil {
		return
	}
	tx.timer.Stop()
	c.tx = nil
	ch := h.channels[tx.ch]
	if ch.holder == c {
		ch.holder = nil
	}
	delete(ch.txers, c)
	if reason != "" {
		h.sendJSON(c, map[string]any{"t": "tx_end", "reason": reason})
	}
	for _, r := range h.clients {
		if r != c && h.subscribedLocked(r, tx.ch) {
			h.sendJSON(r, map[string]any{"t": "rx_end", "ch": tx.ch, "sid": c.ID})
		}
	}
	h.dirty = true
}

// Audio fans one encoded frame from a transmitting client out to every radio
// that would hear it. Incoming layout: [seq u16][payload]. Outgoing layout:
// [ch u8][sid u16][quality u8][seq u16][payload].
func (h *Hub) Audio(c *Client, frame []byte) {
	if len(frame) < 3 || len(frame) > 2+960 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	tx := c.tx
	if tx == nil {
		return
	}
	ch := h.channels[tx.ch]
	uplink := h.uplinkLocked(c, ch)
	for _, r := range h.clients {
		if r == c || !h.subscribedLocked(r, ch.id) {
			continue
		}
		// Radios are half-duplex: while transmitting you hear nothing.
		if r.tx != nil {
			continue
		}
		q := h.qualityLocked(c, r, ch, uplink)
		if q < squelchThreshold {
			continue
		}
		out := make([]byte, 4+len(frame))
		out[0] = byte(ch.id)
		binary.BigEndian.PutUint16(out[1:3], c.ID)
		out[3] = byte(q * 255)
		copy(out[4:], frame)
		select {
		case r.send <- outMsg{binary: true, data: out}:
		default:
			// Slow client; dropping audio is better than stalling everyone.
		}
	}
}

func (h *Hub) uplinkLocked(c *Client, ch *channel) float64 {
	if ch.Mode != ModeRepeater || c.Role == RoleInstructor {
		return 1
	}
	return linkQuality(c.pos, *ch.Repeater, ch.RepeaterRange, h.zones)
}

func (h *Hub) qualityLocked(tx, rx *Client, ch *channel, uplink float64) float64 {
	if rx.Role == RoleInstructor || tx.Role == RoleInstructor {
		return 1
	}
	if ch.Mode == ModeRepeater {
		return min(uplink, linkQuality(*ch.Repeater, rx.pos, ch.RepeaterRange, h.zones))
	}
	return linkQuality(tx.pos, rx.pos, handheldRange, h.zones)
}

func (h *Hub) subscribedLocked(r *Client, chID int) bool {
	if r.Role == RoleInstructor {
		return r.monitor[chID]
	}
	return r.channel == chID || (r.scanning && r.scanList[chID])
}

func (h *Hub) rxStart(tx, rx *Client, ch *channel) map[string]any {
	m := map[string]any{"t": "rx_start", "ch": ch.id, "sid": tx.ID}
	// Digital radios display the talker's ID; analog FM doesn't.
	if ch.Mode == ModeRepeater || rx.Role == RoleInstructor {
		m["from"] = tx.Callsign
	}
	return m
}

// sendOngoingLocked tells c about transmissions already in progress on
// channels it just started listening to.
func (h *Hub) sendOngoingLocked(c *Client) {
	for _, t := range h.clients {
		if t != c && t.tx != nil && h.subscribedLocked(c, t.tx.ch) {
			h.sendJSON(c, h.rxStart(t, c, h.channels[t.tx.ch]))
		}
	}
}

func (h *Hub) sendJSON(c *Client, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("marshal: %v", err)
		return
	}
	select {
	case c.send <- outMsg{data: data}:
	default:
		// A client that can't keep up with control messages is effectively
		// dead; drop it so it reconnects with fresh state.
		c.kick()
	}
}

func (h *Hub) validChannel(id int) bool { return id >= 0 && id < len(h.channels) }

func (h *Hub) landmark(id string) *Landmark {
	for i := range h.landmarks {
		if h.landmarks[i].ID == id {
			return &h.landmarks[i]
		}
	}
	return nil
}

func (h *Hub) channelInfo() []map[string]any {
	var out []map[string]any
	for _, ch := range h.channels {
		out = append(out, map[string]any{
			"id": ch.id, "name": ch.Name, "mode": ch.Mode,
			"repeater": ch.Repeater, "repeaterRange": ch.RepeaterRange,
		})
	}
	return out
}

func (h *Hub) stateLocked() map[string]any {
	clients := []map[string]any{}
	for _, c := range h.clients {
		m := map[string]any{
			"id": c.ID, "callsign": c.Callsign, "role": c.Role, "channel": c.channel,
			"scanning": c.scanning, "pos": c.pos, "loc": c.loc,
		}
		if c.tx != nil {
			m["tx"] = map[string]any{"ch": c.tx.ch, "since": c.tx.start.UnixMilli()}
		}
		clients = append(clients, m)
	}
	chans := []map[string]any{}
	for _, ch := range h.channels {
		txers := []uint16{}
		for c := range ch.txers {
			txers = append(txers, c.ID)
		}
		if ch.holder != nil {
			txers = append(txers, ch.holder.ID)
		}
		chans = append(chans, map[string]any{"id": ch.id, "txers": txers})
	}
	zones := h.zones
	if zones == nil {
		zones = []Zone{} // JSON [] rather than null
	}
	return map[string]any{
		"t": "state", "clients": clients, "channels": chans, "zones": zones,
		"handheldRange": handheldRange,
	}
}

// RunStateBroadcast pushes roster/map snapshots to instructor consoles,
// coalescing bursts of changes.
func (h *Hub) RunStateBroadcast(interval time.Duration, stop <-chan struct{}) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		h.mu.Lock()
		if h.dirty {
			h.dirty = false
			st := h.stateLocked()
			for _, c := range h.clients {
				if c.Role == RoleInstructor {
					h.sendJSON(c, st)
				}
			}
		}
		h.mu.Unlock()
	}
}
