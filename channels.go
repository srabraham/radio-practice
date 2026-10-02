package main

type Mode string

const (
	// ModeSimplex is analog FM radio-to-radio: no floor lock, and
	// simultaneous keying produces doubling at receivers.
	ModeSimplex Mode = "fm-simplex"
	// ModeRepeater is a digital (DMR-style) repeater channel: the repeater
	// grants one talker at a time and rebroadcasts cleanly.
	ModeRepeater Mode = "digital-repeater"
	// ModeVoiceOfGod is the channel the hub adds after the plan when it has
	// any repeaters. Keying it transmits on every repeater at once, cutting
	// off whoever is talking there; tuning to it listens to all of them.
	ModeVoiceOfGod Mode = "voice-of-god"
)

type ChannelConfig struct {
	Name string `json:"name"`
	Mode Mode   `json:"mode"`
	// Default marks the channel a radio starts on when it has no saved channel.
	Default bool `json:"default,omitempty"`
}

func defaultChannels() []ChannelConfig {
	return []ChannelConfig{
		{Name: "brc 911 alt", Mode: ModeSimplex},
		{Name: "BRC 911", Mode: ModeRepeater},
		{Name: "Ranger Admin", Mode: ModeRepeater},
		{Name: "Control 1", Mode: ModeRepeater, Default: true},
		{Name: "Control 2", Mode: ModeRepeater},
		{Name: "tac 1", Mode: ModeSimplex},
		{Name: "tac 2", Mode: ModeSimplex},
		{Name: "tac 3", Mode: ModeSimplex},
		{Name: "Ranger Talk", Mode: ModeRepeater},
		{Name: "Ranger HQ", Mode: ModeRepeater},
	}
}
