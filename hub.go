package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"log"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxMessageLen = 500 // runes
	keepMessages  = 50  // history sent to each radio as it connects
)

type outMsg struct {
	binary bool
	data   []byte
}

// KickReason says why the hub is dropping a connection, which decides whether
// the page should reconnect.
type KickReason int

const (
	// KickReplaced: the same login connected again (another tab, or a phone
	// reconnecting). The old page must not reconnect and take the radio back.
	KickReplaced KickReason = iota
	// KickTooSlow: the client fell behind on control messages. It should
	// reconnect and get fresh state.
	KickTooSlow
)

type Client struct {
	ID       uint16
	Callsign string
	sid      string // login session; see Join

	send chan outMsg
	kick func(KickReason)

	// Everything below is guarded by Hub.mu.
	channel  int
	scanning bool
	scanList map[int]bool
	watching bool // the app controls column is open and wants roster updates
	tx       *transmission
}

type transmission struct {
	ch    int   // the channel keyed, which is the Voice of God channel for Voice of God
	chs   []int // where it goes out: every repeater for Voice of God
	vog   bool
	start time.Time
	timer *time.Timer
	// Repeater key-up latency: audio before this never goes out, so the
	// first moments after the talk-permit tone are clipped.
	audioAt time.Time
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
	clients   map[uint16]*Client
	byCall    map[string]*Client
	nextID    uint16
	tot       time.Duration
	rptrDelay time.Duration
	dirty     bool
	messages  []chatMessage
}

type chatMessage struct {
	From string `json:"from"`
	Text string `json:"text"`
	At   int64  `json:"at"` // Unix milliseconds
}

func NewHub(chans []ChannelConfig, tot time.Duration) *Hub {
	h := &Hub{
		clients:   map[uint16]*Client{},
		byCall:    map[string]*Client{},
		tot:       tot,
		rptrDelay: 1000 * time.Millisecond,
	}
	if slices.ContainsFunc(chans, func(c ChannelConfig) bool { return c.Mode == ModeRepeater }) {
		chans = append(slices.Clip(chans), ChannelConfig{Name: "Voice of God", Mode: ModeVoiceOfGod})
	}
	for i, cfg := range chans {
		h.channels = append(h.channels, &channel{ChannelConfig: cfg, id: i, txers: map[*Client]bool{}})
	}
	return h
}

var ErrCallsignInUse = errors.New("callsign in use")

// Join registers a connection. A callsign already connected from the same
// login session is replaced, which is what a phone reconnecting after sleep
// (or a second tab) looks like. One connected from a different login is
// someone else using that callsign, so the new connection is refused.
func (h *Hub) Join(callsign, sid string, send chan outMsg, kick func(KickReason)) (*Client, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if old := h.byCall[callsign]; old != nil {
		if old.sid != sid {
			return nil, ErrCallsignInUse
		}
		h.removeLocked(old)
		old.kick(KickReplaced)
	}

	h.nextID++
	for h.nextID == 0 || h.clients[h.nextID] != nil {
		h.nextID++
	}
	c := &Client{
		ID:       h.nextID,
		Callsign: callsign,
		sid:      sid,
		send:     send,
		kick:     kick,
		scanList: map[int]bool{},
	}
	h.clients[c.ID] = c
	h.byCall[callsign] = c

	h.sendJSON(c, map[string]any{
		"t":        "hello",
		"you":      map[string]any{"id": c.ID, "callsign": c.Callsign},
		"channels": h.channelInfo(),
		"tot":      h.tot.Seconds(),
		"messages": append([]chatMessage{}, h.messages...),
	})
	h.sendOngoingLocked(c)
	h.dirty = true
	return c, nil
}

// InUse reports whether callsign is connected from a login other than sid.
func (h *Hub) InUse(callsign, sid string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.byCall[callsign]
	return c != nil && c.sid != sid
}

func (h *Hub) Leave(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.connectedLocked(c) {
		h.removeLocked(c)
	}
}

// connectedLocked is false once c has left or been replaced. A replaced
// connection keeps reading until its close finishes, and anything it sends
// meanwhile must not touch the hub: a key would hold the floor with nobody
// left to release it.
func (h *Hub) connectedLocked(c *Client) bool { return h.clients[c.ID] == c }

func (h *Hub) removeLocked(c *Client) {
	h.endTxLocked(c, "")
	delete(h.clients, c.ID)
	if h.byCall[c.Callsign] == c {
		delete(h.byCall, c.Callsign)
	}
	h.dirty = true
}

type inMsg struct {
	T    string `json:"t"`
	Ch   int    `json:"ch"`
	On   bool   `json:"on"`
	List []int  `json:"list"`
	Text string `json:"text"`
}

func (h *Hub) HandleJSON(c *Client, data []byte) {
	var m inMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.connectedLocked(c) {
		return
	}

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
			if h.validChannel(id) && h.channels[id].Mode != ModeVoiceOfGod {
				c.scanList[id] = true
			}
		}
		h.sendOngoingLocked(c)
		h.dirty = true
	case "watch":
		c.watching = m.On
		if c.watching {
			h.sendJSON(c, h.stateLocked())
		}
	case "msg":
		h.messageLocked(c, m.Text)
	}
}

// messageLocked sends a text message to everyone, the sender included, and
// keeps it for radios that connect later.
func (h *Hub) messageLocked(c *Client, text string) {
	text = strings.TrimSpace(strings.ToValidUTF8(text, ""))
	if text == "" {
		return
	}
	if utf8.RuneCountInString(text) > maxMessageLen {
		text = string([]rune(text)[:maxMessageLen])
	}
	msg := chatMessage{From: c.Callsign, Text: text, At: time.Now().UnixMilli()}
	h.messages = append(h.messages, msg)
	if n := len(h.messages); n > keepMessages {
		h.messages = slices.Clone(h.messages[n-keepMessages:])
	}
	out := map[string]any{"t": "msg", "from": msg.From, "text": msg.Text, "at": msg.At}
	for _, r := range h.clients {
		h.sendJSON(r, out)
	}
}

func (h *Hub) keyLocked(c *Client, chID int) {
	if c.tx != nil || !h.validChannel(chID) {
		return
	}
	ch := h.channels[chID]
	switch ch.Mode {
	case ModeVoiceOfGod:
		h.voiceOfGodLocked(c, chID)
		return
	case ModeRepeater:
		if ch.holder != nil {
			h.sendJSON(c, map[string]any{"t": "tx_deny", "ch": chID, "reason": "busy"})
			return
		}
		ch.holder = c
	case ModeSimplex:
		ch.txers[c] = true
	}
	h.startTxLocked(c, chID, []int{chID}, false)
}

// voiceOfGodLocked keys c on every repeater channel at once, cutting off
// whoever is talking on them. Simplex channels are untouched.
func (h *Hub) voiceOfGodLocked(c *Client, vogCh int) {
	var chs []int
	for _, ch := range h.channels {
		if ch.Mode != ModeRepeater {
			continue
		}
		// Two people can't both be God; the second one waits.
		if ch.holder != nil && ch.holder.tx.vog {
			h.sendJSON(c, map[string]any{"t": "tx_deny", "ch": vogCh, "reason": "busy"})
			return
		}
		chs = append(chs, ch.id)
	}
	if len(chs) == 0 {
		return
	}
	for _, id := range chs {
		ch := h.channels[id]
		if ch.holder != nil {
			h.endTxLocked(ch.holder, "vog")
		}
		ch.holder = c
	}
	h.startTxLocked(c, vogCh, chs, true)
}

func (h *Hub) startTxLocked(c *Client, keyed int, chs []int, vog bool) {
	tx := &transmission{ch: keyed, chs: chs, vog: vog, start: time.Now()}
	if h.channels[chs[0]].Mode == ModeRepeater {
		tx.audioAt = tx.start.Add(h.rptrDelay)
	}
	tx.timer = time.AfterFunc(h.tot, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if c.tx == tx {
			h.endTxLocked(c, "tot")
		}
	})
	c.tx = tx
	h.sendJSON(c, map[string]any{"t": "tx_ok", "ch": keyed})
	for _, r := range h.clients {
		if r == c {
			continue
		}
		if id, ok := h.rxChannelLocked(r, chs); ok {
			h.sendJSON(r, h.rxStart(c, h.channels[id]))
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
	for _, id := range tx.chs {
		ch := h.channels[id]
		if ch.holder == c {
			ch.holder = nil
		}
		delete(ch.txers, c)
	}
	if reason != "" {
		h.sendJSON(c, map[string]any{"t": "tx_end", "reason": reason})
	}
	for _, r := range h.clients {
		if r == c {
			continue
		}
		if id, ok := h.rxChannelLocked(r, tx.chs); ok {
			h.sendJSON(r, map[string]any{"t": "rx_end", "ch": id, "sid": c.ID})
		}
	}
	h.dirty = true
}

// Audio fans one encoded frame from a transmitting client out to every radio
// listening on its channel. Incoming layout: [seq u16][payload]. Outgoing
// layout: [ch u8][sid u16][seq u16][payload].
func (h *Hub) Audio(c *Client, frame []byte) {
	if len(frame) < 3 || len(frame) > 2+960 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	tx := c.tx
	if tx == nil || !h.connectedLocked(c) || time.Now().Before(tx.audioAt) {
		return
	}
	for _, r := range h.clients {
		// Radios are half-duplex: while transmitting you hear nothing.
		if r == c || r.tx != nil {
			continue
		}
		id, ok := h.rxChannelLocked(r, tx.chs)
		if !ok {
			continue
		}
		out := make([]byte, 3+len(frame))
		out[0] = byte(id)
		binary.BigEndian.PutUint16(out[1:3], c.ID)
		copy(out[3:], frame)
		select {
		case r.send <- outMsg{binary: true, data: out}:
		default:
			// Slow client; dropping audio is better than stalling everyone.
		}
	}
}

func (h *Hub) subscribedLocked(r *Client, chID int) bool {
	if r.channel == chID || (r.scanning && r.scanList[chID]) {
		return true
	}
	return h.channels[r.channel].Mode == ModeVoiceOfGod && h.channels[chID].Mode == ModeRepeater
}

// rxChannelLocked picks the one channel r hears a transmission on. Voice of
// God goes out on every repeater, but each radio should get a single copy,
// on the channel it's tuned to when that's one of them.
func (h *Hub) rxChannelLocked(r *Client, chs []int) (int, bool) {
	if slices.Contains(chs, r.channel) {
		return r.channel, true
	}
	for _, id := range chs {
		if h.subscribedLocked(r, id) {
			return id, true
		}
	}
	return 0, false
}

func (h *Hub) rxStart(tx *Client, ch *channel) map[string]any {
	m := map[string]any{"t": "rx_start", "ch": ch.id, "sid": tx.ID}
	// Digital radios display the talker's ID; analog FM doesn't.
	if ch.Mode == ModeRepeater {
		m["from"] = tx.Callsign
	}
	return m
}

// sendOngoingLocked tells c about transmissions already in progress on
// channels it just started listening to.
func (h *Hub) sendOngoingLocked(c *Client) {
	for _, t := range h.clients {
		if t == c || t.tx == nil {
			continue
		}
		if id, ok := h.rxChannelLocked(c, t.tx.chs); ok {
			h.sendJSON(c, h.rxStart(t, h.channels[id]))
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
		c.kick(KickTooSlow)
	}
}

func (h *Hub) validChannel(id int) bool { return id >= 0 && id < len(h.channels) }

func (h *Hub) channelInfo() []map[string]any {
	var out []map[string]any
	for _, ch := range h.channels {
		out = append(out, map[string]any{
			"id": ch.id, "name": ch.Name, "mode": ch.Mode, "default": ch.Default,
		})
	}
	return out
}

func (h *Hub) stateLocked() map[string]any {
	clients := []map[string]any{}
	for _, c := range h.clients {
		m := map[string]any{
			"id": c.ID, "callsign": c.Callsign, "channel": c.channel, "scanning": c.scanning,
		}
		if c.tx != nil {
			m["tx"] = map[string]any{"ch": c.tx.ch, "since": c.tx.start.UnixMilli()}
		}
		clients = append(clients, m)
	}
	return map[string]any{"t": "state", "clients": clients}
}

// RunStateBroadcast pushes roster snapshots to radios showing the app
// controls column, coalescing bursts of changes.
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
				if c.watching {
					h.sendJSON(c, st)
				}
			}
		}
		h.mu.Unlock()
	}
}
