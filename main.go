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
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
)

//go:embed web
var webFS embed.FS

// Staging issues untrusted certificates but has far higher rate limits, for
// testing provisioning without burning the production quota.
const letsEncryptStagingURL = "https://acme-staging-v02.api.letsencrypt.org/directory"

func main() {
	addr := flag.String("addr", ":8555", "listen address for plain HTTP (ignored with -tls-domain)")
	tlsDomain := flag.String("tls-domain", "", "comma-separated public domain(s); enables automatic Let's Encrypt TLS")
	tlsEmail := flag.String("tls-email", "", "contact email to register with Let's Encrypt, for expiry warnings")
	tlsCache := flag.String("tls-cache", "certs", "where -tls-domain caches certificates and the ACME account key")
	tlsStaging := flag.Bool("tls-staging", false, "use the Let's Encrypt staging CA (untrusted certs, high rate limits)")
	httpsAddr := flag.String("https-addr", ":443", "HTTPS listen address with -tls-domain")
	httpAddr := flag.String("http-addr", ":80", "listen address for ACME HTTP-01 challenges and HTTP→HTTPS redirects with -tls-domain")
	dev := flag.Bool("dev", false, "serve web/ from disk so edits show up without rebuilding")
	tot := flag.Duration("tot", 60*time.Second, "transmit time-out timer")
	flag.Parse()

	password := envOrRandom("RADIO_PASSWORD")

	hub := NewHub(defaultChannels(), *tot)
	go hub.RunStateBroadcast(200*time.Millisecond, nil)
	auth := NewAuth(password, hub.InUse)

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
	// The old instructor console's URL.
	mux.Handle("/instructor.html", http.RedirectHandler("/", http.StatusMovedPermanently))
	mux.HandleFunc("/api/login", auth.HandleLogin)
	mux.HandleFunc("/api/me", auth.HandleMe)
	mux.HandleFunc("/api/logout", auth.HandleLogout)
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { serveWS(hub, auth, w, r) })

	if *tlsDomain != "" {
		serveTLS(mux, splitDomains(*tlsDomain), *tlsEmail, *tlsCache, *httpAddr, *httpsAddr, *tlsStaging)
		return
	}
	log.Printf("listening on http://localhost%s", *addr)
	log.Fatal(newServer(*addr, mux).ListenAndServe())
}

// serveTLS gets and renews certificates from Let's Encrypt. The HTTP listener
// answers ACME HTTP-01 challenges and redirects everything else to HTTPS.
func serveTLS(h http.Handler, domains []string, email, cacheDir, httpAddr, httpsAddr string, staging bool) {
	if len(domains) == 0 {
		log.Fatal("-tls-domain must name at least one domain")
	}
	m := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(domains...),
		Cache:      autocert.DirCache(cacheDir),
		Email:      email,
	}
	if staging {
		m.Client = &acme.Client{DirectoryURL: letsEncryptStagingURL}
		log.Print("using Let's Encrypt STAGING; certificates will be untrusted")
	}
	go func() { log.Fatal(newServer(httpAddr, m.HTTPHandler(nil)).ListenAndServe()) }()
	srv := newServer(httpsAddr, h)
	srv.TLSConfig = m.TLSConfig()
	log.Printf("listening on https://%s (%s), certs in %q", strings.Join(domains, ", "), httpsAddr, cacheDir)
	log.Fatal(srv.ListenAndServeTLS("", ""))
}

func splitDomains(s string) []string {
	var out []string
	for _, d := range strings.Split(s, ",") {
		if d = strings.TrimSpace(d); d != "" {
			out = append(out, d)
		}
	}
	return out
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

const (
	closeReplaced      websocket.StatusCode = 4000
	closeCallsignInUse websocket.StatusCode = 4001
)

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
	// The 4xxx close codes tell the page to stop reconnecting; see net.js.
	// A slow client can trip the kick on every message, so close only once.
	var kickOnce sync.Once
	kick := func(why KickReason) {
		kickOnce.Do(func() {
			if why == KickReplaced {
				go conn.Close(closeReplaced, "opened elsewhere")
			} else {
				go conn.Close(websocket.StatusTryAgainLater, "too slow")
			}
		})
	}
	c, err := hub.Join(s.Callsign, s.Sid, send, kick)
	if err != nil {
		conn.Close(closeCallsignInUse, "callsign in use")
		return
	}
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
