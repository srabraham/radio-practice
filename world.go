package main

import "math"

// Coordinates are meters with the Man at the origin, x to the east (3:00) and
// y toward 6:00. The layout is a loose Black Rock City approximation for
// practice, not a survey.

type Pos struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// clockPos converts a BRC-style address (hour on the clock, distance from the
// Man in meters) into map coordinates. 12:00 points up (negative y).
func clockPos(hour, radius float64) Pos {
	theta := hour * math.Pi / 6
	return Pos{X: radius * math.Sin(theta), Y: -radius * math.Cos(theta)}
}

type Landmark struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Pos  Pos    `json:"pos"`
}

const (
	esplanadeR = 760.0
	kStreetR   = 1700.0
)

func defaultLandmarks() []Landmark {
	return []Landmark{
		{"man", "The Man", Pos{}},
		{"temple", "Temple", clockPos(12, 760)},
		{"center-camp", "Center Camp", clockPos(6, 1000)},
		{"3-esp", "3:00 & Esplanade", clockPos(3, esplanadeR)},
		{"9-esp", "9:00 & Esplanade", clockPos(9, esplanadeR)},
		{"3-k", "3:00 & K", clockPos(3, kStreetR)},
		{"9-k", "9:00 & K", clockPos(9, kStreetR)},
		{"430-g", "4:30 & G", clockPos(4.5, 1350)},
		{"730-g", "7:30 & G", clockPos(7.5, 1350)},
		{"2-c", "2:00 & C", clockPos(2, 1000)},
		{"10-c", "10:00 & C", clockPos(10, 1000)},
		{"deep-playa", "Deep Playa (12:00)", clockPos(12, 2600)},
		{"airport", "Airport", clockPos(5, 2600)},
		{"gate", "Gate Road", clockPos(6, 3000)},
	}
}

type Mode string

const (
	// ModeSimplex is analog FM radio-to-radio: no floor lock, range limited,
	// and simultaneous keying produces doubling/capture at receivers.
	ModeSimplex Mode = "fm-simplex"
	// ModeRepeater is a digital (DMR-style) repeater channel: the repeater
	// grants one talker at a time and rebroadcasts cleanly.
	ModeRepeater Mode = "digital-repeater"
)

type ChannelConfig struct {
	Name          string  `json:"name"`
	Mode          Mode    `json:"mode"`
	Repeater      *Pos    `json:"repeater,omitempty"`
	RepeaterRange float64 `json:"repeaterRange,omitempty"`
	// Default marks the channel a radio starts on when it has no saved channel.
	Default bool `json:"default,omitempty"`
}

func defaultChannels() []ChannelConfig {
	rptrA := clockPos(6, 1850)
	rptrB := clockPos(3, 1850)
	return []ChannelConfig{
		{Name: "brc 911 alt", Mode: ModeSimplex},
		{Name: "BRC 911", Mode: ModeRepeater, Repeater: &rptrA, RepeaterRange: 6000},
		{Name: "Ranger Admin", Mode: ModeRepeater, Repeater: &rptrA, RepeaterRange: 6000},
		{Name: "Control 1", Mode: ModeRepeater, Repeater: &rptrA, RepeaterRange: 6000, Default: true},
		{Name: "Control 2", Mode: ModeRepeater, Repeater: &rptrB, RepeaterRange: 6000},
		{Name: "tac 1", Mode: ModeSimplex},
		{Name: "tac 2", Mode: ModeSimplex},
		{Name: "tac 3", Mode: ModeSimplex},
		{Name: "Ranger Talk", Mode: ModeRepeater, Repeater: &rptrA, RepeaterRange: 6000},
	}
}

// handheldRange is where a simplex handheld-to-handheld link fades to nothing.
// Across-the-city links (~3.4 km) fail, which forces relaying.
const handheldRange = 2200.0

// squelchThreshold is the link quality below which nothing is heard at all.
const squelchThreshold = 0.05

type Zone struct {
	ID     int     `json:"id"`
	Center Pos     `json:"center"`
	Radius float64 `json:"radius"`
	Loss   float64 `json:"loss"` // 0..1 fraction of signal removed
}

// linkQuality returns 0..1 for a radio path between a and b. It falls off
// with distance and is attenuated by any dead zone the path touches.
func linkQuality(a, b Pos, maxRange float64, zones []Zone) float64 {
	d := math.Hypot(a.X-b.X, a.Y-b.Y)
	if d >= maxRange {
		return 0
	}
	// Stays strong up close, then drops quickly near the edge of range.
	q := 1 - math.Pow(d/maxRange, 2.5)
	for _, z := range zones {
		if segmentHitsCircle(a, b, z.Center, z.Radius) {
			q *= 1 - z.Loss
		}
	}
	return q
}

func segmentHitsCircle(a, b, c Pos, r float64) bool {
	dx, dy := b.X-a.X, b.Y-a.Y
	lenSq := dx*dx + dy*dy
	t := 0.0
	if lenSq > 0 {
		t = ((c.X-a.X)*dx + (c.Y-a.Y)*dy) / lenSq
		t = math.Max(0, math.Min(1, t))
	}
	px, py := a.X+t*dx, a.Y+t*dy
	return math.Hypot(px-c.X, py-c.Y) <= r
}
