package main

import (
	"slices"
	"strings"
	"time"
)

const (
	echoCallsign = "Echobot"
	// How long the echo channel must be quiet before Echobot replays.
	echoDelay = time.Second
)

// echoBot is a radio parked on the echo channel. It records everything keyed
// there from the first key-up until nobody is keyed, then replays it with the
// original timing. Overlapping talkers are replayed as separate streams, so
// listeners hear the same double they heard live. Echobot's own replay isn't
// recorded, so a talker doubling with it isn't echoed back twice.
type echoBot struct {
	*Client
	ch      int
	take    *echoTake   // being recorded
	queue   []*echoTake // recorded, waiting to be replayed
	wait    *time.Timer // the quiet gap before the next replay
	playing *echoPlayback
}

type echoTake struct {
	start  time.Time
	voices []*echoVoice
}

// echoVoice is one transmission within a take.
type echoVoice struct {
	take       *echoTake
	start, end time.Time
	frames     []echoFrame
}

type echoFrame struct {
	at   time.Time
	data []byte // [seq u16][payload], as the talker sent it
}

type echoPlayback struct {
	start  time.Time
	events []echoEvent
	next   int
	sids   []uint16 // one stream per voice
}

type echoEvent struct {
	at    time.Duration // since the playback started
	voice int
	kind  echoEventKind
	data  []byte
}

type echoEventKind int

const (
	echoStart echoEventKind = iota
	echoFrameOut
	echoEnd
)

func (h *Hub) addEchobot(ch int) {
	c := &Client{
		ID:       h.allocIDLocked(),
		Callsign: echoCallsign,
		bot:      true,
		kick:     func(KickReason) {},
		channel:  ch,
		scanList: map[int]bool{},
	}
	h.clients[c.ID] = c
	// Logins are upper-cased, so this is the key that keeps anyone else from
	// taking the callsign.
	h.byCall[strings.ToUpper(echoCallsign)] = c
	h.echo = &echoBot{Client: c, ch: ch}
}

// echoKeyedLocked starts recording c's new transmission if it's on the echo
// channel.
func (h *Hub) echoKeyedLocked(c *Client) {
	e := h.echo
	if e == nil || c.bot || !slices.Contains(c.tx.chs, e.ch) {
		return
	}
	now := time.Now()
	if e.take == nil {
		e.take = &echoTake{start: now}
	}
	v := &echoVoice{take: e.take, start: now}
	e.take.voices = append(e.take.voices, v)
	c.tx.echo = v
}

func (h *Hub) echoRecordLocked(v *echoVoice, frame []byte) {
	now := time.Now()
	// Talkers taking turns can keep a take going indefinitely; stop
	// recording after one TOT's worth so it can't grow without bound.
	if now.Sub(v.take.start) > h.tot {
		return
	}
	v.frames = append(v.frames, echoFrame{at: now, data: slices.Clone(frame)})
}

// echoUnkeyedLocked ends v. Once the last talker unkeys, the take is queued.
func (h *Hub) echoUnkeyedLocked(v *echoVoice) {
	e := h.echo
	v.end = time.Now()
	for c := range h.channels[e.ch].txers {
		if !c.bot {
			return
		}
	}
	t := e.take
	e.take = nil
	if slices.ContainsFunc(t.voices, func(v *echoVoice) bool { return len(v.frames) > 0 }) {
		e.queue = append(e.queue, t)
		h.echoScheduleLocked()
	}
}

// echoScheduleLocked replays the next queued take after a quiet gap, unless
// Echobot is already replaying or waiting.
func (h *Hub) echoScheduleLocked() {
	e := h.echo
	if e.playing != nil || e.wait != nil || len(e.queue) == 0 {
		return
	}
	e.wait = time.AfterFunc(echoDelay, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		e.wait = nil
		h.echoPlayLocked()
	})
}

func (h *Hub) echoPlayLocked() {
	e := h.echo
	t := e.queue[0]
	e.queue = e.queue[1:]

	p := &echoPlayback{start: time.Now()}
	for i, v := range t.voices {
		p.sids = append(p.sids, h.allocIDLocked())
		h.voiceIDs[p.sids[i]] = true
		p.events = append(p.events, echoEvent{at: v.start.Sub(t.start), voice: i, kind: echoStart})
		for _, f := range v.frames {
			p.events = append(p.events, echoEvent{at: f.at.Sub(t.start), voice: i, kind: echoFrameOut, data: f.data})
		}
		p.events = append(p.events, echoEvent{at: v.end.Sub(t.start), voice: i, kind: echoEnd})
	}
	// Stable, so each voice's start, frames and end stay in order.
	slices.SortStableFunc(p.events, func(a, b echoEvent) int { return int(a.at - b.at) })
	e.playing = p

	// Echobot transmits for the roster and so the take after this one hears
	// nothing of it, but listeners get each voice as its own stream.
	e.tx = &transmission{ch: e.ch, chs: []int{e.ch}, start: p.start}
	h.channels[e.ch].txers[e.Client] = true
	h.dirty = true
	h.echoStepLocked()
}

// echoStepLocked sends every event that's due, then waits for the next one.
func (h *Hub) echoStepLocked() {
	e := h.echo
	p := e.playing
	elapsed := time.Since(p.start)
	for ; p.next < len(p.events) && p.events[p.next].at <= elapsed; p.next++ {
		ev := p.events[p.next]
		sid := p.sids[ev.voice]
		switch ev.kind {
		case echoStart:
			h.echoNotifyLocked(map[string]any{"t": "rx_start", "ch": e.ch, "sid": sid})
		case echoFrameOut:
			h.fanOutLocked(e.tx.chs, sid, ev.data)
		case echoEnd:
			h.echoNotifyLocked(map[string]any{"t": "rx_end", "ch": e.ch, "sid": sid})
		}
	}
	if p.next < len(p.events) {
		time.AfterFunc(p.events[p.next].at-elapsed, func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.echoStepLocked()
		})
		return
	}

	for _, sid := range p.sids {
		delete(h.voiceIDs, sid)
	}
	e.playing = nil
	e.tx = nil
	delete(h.channels[e.ch].txers, e.Client)
	h.dirty = true
	h.echoScheduleLocked()
}

func (h *Hub) echoNotifyLocked(m map[string]any) {
	for _, r := range h.clients {
		if _, ok := h.rxChannelLocked(r, []int{h.echo.ch}); ok {
			h.sendJSON(r, m)
		}
	}
}
