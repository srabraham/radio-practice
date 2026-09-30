package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/acme/autocert"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "listen address (ignored with -domain)")
	domain := flag.String("domain", "", "public domain name; enables automatic Let's Encrypt TLS on :443")
	certDir := flag.String("cert-dir", "certs", "where -domain stores certificates")
	dev := flag.Bool("dev", false, "serve web/ from disk so edits show up without rebuilding")
	tot := flag.Duration("tot", 60*time.Second, "transmit time-out timer")
	flag.Parse()

	participantPW := envOrRandom("RADIO_PASSWORD")
	instructorPW := envOrRandom("RADIO_INSTRUCTOR_PASSWORD")

	hub := NewHub(defaultChannels(), defaultLandmarks(), *tot)
	go hub.RunStateBroadcast(200*time.Millisecond, nil)
	auth := NewAuth(participantPW, instructorPW)

	var static fs.FS
	if *dev {
		static = os.DirFS("web")
	} else {
		static, _ = fs.Sub(webFS, "web")
	}

	mux := http.NewServeMux()
	files := http.FileServerFS(static)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Small files; always revalidate so a deploy never mixes old and new modules.
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
	mux.HandleFunc("/api/login", auth.HandleLogin)
	mux.HandleFunc("/api/me", auth.HandleMe)
	mux.HandleFunc("/api/logout", auth.HandleLogout)
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { serveWS(hub, auth, w, r) })

	if *domain != "" {
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(*domain),
			Cache:      autocert.DirCache(*certDir),
		}
		go func() { log.Fatal(newServer(":80", m.HTTPHandler(nil)).ListenAndServe()) }()
		srv := newServer(":443", mux)
		srv.TLSConfig = m.TLSConfig()
		log.Printf("listening on https://%s", *domain)
		log.Fatal(srv.ListenAndServeTLS("", ""))
	}
	log.Printf("listening on http://localhost%s", *addr)
	log.Fatal(newServer(*addr, mux).ListenAndServe())
}

// newServer drops connections that dribble in headers or sit idle. There's
// deliberately no ReadTimeout or WriteTimeout: those would cut off WebSockets.
func newServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
}

func envOrRandom(name string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	b := make([]byte, 4)
	rand.Read(b)
	v := hex.EncodeToString(b)
	log.Printf("%s not set; using generated password: %s", name, v)
	return v
}

func serveWS(hub *Hub, auth *Auth, w http.ResponseWriter, r *http.Request) {
	s, ok := auth.Session(r)
	if !ok {
		http.Error(w, "not logged in", http.StatusUnauthorized)
		return
	}
	// Accept rejects cross-origin upgrades by default, which is what we want
	// with cookie auth.
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	send := make(chan outMsg, 512)
	c := hub.Join(s.Callsign, s.Role, send, cancel)
	defer hub.Leave(c)

	go writeLoop(ctx, conn, send, cancel)
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			hub.Audio(c, data)
		} else {
			hub.HandleJSON(c, data)
		}
	}
}

func writeLoop(ctx context.Context, conn *websocket.Conn, send <-chan outMsg, cancel func()) {
	defer cancel()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pctx)
			pcancel()
			if err != nil {
				return
			}
		case m := <-send:
			typ := websocket.MessageText
			if m.binary {
				typ = websocket.MessageBinary
			}
			wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Write(wctx, typ, m.data)
			wcancel()
			if err != nil {
				return
			}
		}
	}
}
