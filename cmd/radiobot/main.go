// radiobot is a scripted radio for testing without a microphone: it logs in,
// tunes a channel, and periodically keys up and sends a warbling tone.
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"log"
	"math"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

func main() {
	server := flag.String("url", "http://localhost:8555", "server base URL")
	callsign := flag.String("callsign", "BOT", "callsign")
	password := flag.String("password", "", "participant password")
	ch := flag.Int("ch", 0, "channel index (0-based)")
	loc := flag.String("loc", "center-camp", "landmark id")
	every := flag.Duration("every", 8*time.Second, "time between transmissions")
	length := flag.Duration("len", 3*time.Second, "transmission length")
	pitch := flag.Float64("pitch", 700, "tone frequency in Hz")
	flag.Parse()

	jar, _ := cookiejar.New(nil)
	hc := &http.Client{Jar: jar}
	body, _ := json.Marshal(map[string]string{"callsign": *callsign, "password": *password})
	resp, err := hc.Post(*server+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil || resp.StatusCode != 200 {
		log.Fatalf("login failed: %v %v", err, resp.Status)
	}

	u, _ := url.Parse(*server)
	wsURL := strings.Replace(*server, "http", "ws", 1) + "/ws"
	ctx := context.Background()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPClient: hc,
		HTTPHeader: http.Header{"Origin": {u.Scheme + "://" + u.Host}},
	})
	if err != nil {
		log.Fatal(err)
	}
	defer conn.CloseNow()

	send := func(v any) {
		b, _ := json.Marshal(v)
		conn.Write(ctx, websocket.MessageText, b)
	}
	go func() {
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				log.Fatal(err)
			}
			if typ == websocket.MessageText && bytes.Contains(data, []byte(`"t":"tx_`)) {
				log.Printf("%s", data)
			}
		}
	}()

	send(map[string]any{"t": "tune", "ch": *ch})
	send(map[string]any{"t": "pos", "loc": *loc})

	var seq uint16
	var phase float64
	for {
		time.Sleep(*every)
		log.Printf("keying ch %d for %s", *ch, *length)
		send(map[string]any{"t": "key", "ch": *ch})
		tick := time.NewTicker(20 * time.Millisecond)
		frames := int(*length / (20 * time.Millisecond))
		for i := 0; i < frames; i++ {
			<-tick.C
			frame := make([]byte, 2+160)
			binary.BigEndian.PutUint16(frame, seq)
			seq++
			for j := 0; j < 160; j++ {
				t := float64(i*160+j) / 8000
				f := *pitch * (1 + 0.15*math.Sin(2*math.Pi*3*t)) // warble so it's easy to tell apart
				phase += 2 * math.Pi * f / 8000
				frame[2+j] = linToUlaw(0.5 * math.Sin(phase))
			}
			conn.Write(ctx, websocket.MessageBinary, frame)
		}
		tick.Stop()
		send(map[string]any{"t": "unkey"})
	}
}

func linToUlaw(x float64) byte {
	s := int(math.Max(-1, math.Min(1, x)) * 32767)
	sign := 0
	if s < 0 {
		sign = 0x80
		s = -s
	}
	if s > 32635 {
		s = 32635
	}
	s += 0x84
	exp := 7
	for mask := 0x4000; s&mask == 0 && exp > 0; mask >>= 1 {
		exp--
	}
	mant := (s >> (exp + 3)) & 0x0f
	return ^byte(sign | exp<<4 | mant)
}
