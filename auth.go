package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const cookieName = "rp_session"

type Auth struct {
	key           []byte
	participantPW string
	instructorPW  string
	failures      *failureBudget
	// inUse reports whether a callsign is on the air from another login.
	inUse func(callsign, sid string) bool
}

type session struct {
	Callsign string `json:"c"`
	Sid      string `json:"s"` // random per login, tells two people on one callsign apart
	Role     Role   `json:"r"`
	Exp      int64  `json:"e"`
}

func NewAuth(participantPW, instructorPW string, inUse func(callsign, sid string) bool) *Auth {
	// Per-process key: restarting the server logs everyone out, which is
	// fine for a practice tool.
	key := make([]byte, 32)
	rand.Read(key)
	return &Auth{
		key:           key,
		participantPW: participantPW,
		instructorPW:  instructorPW,
		failures:      newFailureBudget(1000, time.Hour, time.Now),
		inUse:         inUse,
	}
}

// failureBudget caps wrong-password attempts across all clients: a token
// bucket holding up to max failures, refilling at max per window. Once it's
// empty, logins are refused without checking the password, since checking it
// at all would still give an attacker a guess.
type failureBudget struct {
	mu     sync.Mutex
	max    float64
	perSec float64
	tokens float64
	last   time.Time
	now    func() time.Time
}

func newFailureBudget(max int, window time.Duration, now func() time.Time) *failureBudget {
	return &failureBudget{
		max:    float64(max),
		perSec: float64(max) / window.Seconds(),
		tokens: float64(max),
		last:   now(),
		now:    now,
	}
}

func (b *failureBudget) refill() {
	t := b.now()
	b.tokens = min(b.max, b.tokens+t.Sub(b.last).Seconds()*b.perSec)
	b.last = t
}

// take reserves one failure up front, so a burst of parallel requests can't
// all slip past the check before any of them is counted. It returns 0 on
// success, or how long until an attempt may proceed.
func (b *failureBudget) take() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	if b.tokens < 1 {
		return time.Duration((1 - b.tokens) / b.perSec * float64(time.Second))
	}
	b.tokens--
	return 0
}

// refund returns a token reserved by take, for an attempt that succeeded.
func (b *failureBudget) refund() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	b.tokens = min(b.max, b.tokens+1)
}

func (a *Auth) sign(payload []byte) []byte {
	m := hmac.New(sha256.New, a.key)
	m.Write(payload)
	return m.Sum(nil)
}

func (a *Auth) issue(s session) string {
	payload, _ := json.Marshal(s)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(payload) + "." + enc.EncodeToString(a.sign(payload))
}

func (a *Auth) Session(r *http.Request) (session, bool) {
	ck, err := r.Cookie(cookieName)
	if err != nil {
		return session{}, false
	}
	p, sig, ok := strings.Cut(ck.Value, ".")
	if !ok {
		return session{}, false
	}
	enc := base64.RawURLEncoding
	payload, err1 := enc.DecodeString(p)
	mac, err2 := enc.DecodeString(sig)
	if err1 != nil || err2 != nil || !hmac.Equal(mac, a.sign(payload)) {
		return session{}, false
	}
	var s session
	if json.Unmarshal(payload, &s) != nil || time.Now().Unix() > s.Exp {
		return session{}, false
	}
	return s, true
}

var callsignRE = regexp.MustCompile(`^[A-Z0-9][A-Z0-9 _-]{0,19}$`)

func (a *Auth) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Callsign string `json:"callsign"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	callsign := strings.ToUpper(strings.TrimSpace(req.Callsign))
	if !callsignRE.MatchString(callsign) {
		http.Error(w, "callsign must be 1-20 letters, digits, spaces, - or _", http.StatusBadRequest)
		return
	}

	if wait := a.failures.take(); wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		http.Error(w, "too many failed logins; try again later", http.StatusTooManyRequests)
		return
	}

	var role Role
	switch {
	case a.instructorPW != "" && subtle.ConstantTimeCompare([]byte(req.Password), []byte(a.instructorPW)) == 1:
		role = RoleInstructor
	case subtle.ConstantTimeCompare([]byte(req.Password), []byte(a.participantPW)) == 1:
		role = RoleParticipant
	default:
		time.Sleep(500 * time.Millisecond) // blunt brute-force damper
		http.Error(w, "wrong password", http.StatusUnauthorized)
		return
	}
	a.failures.refund()

	// Logging in again on the same device keeps its session, so the radio
	// it already has open doesn't count as someone else.
	sid := randomID()
	if prev, ok := a.Session(r); ok && prev.Callsign == callsign && prev.Sid != "" {
		sid = prev.Sid
	}
	if a.inUse(callsign, sid) {
		http.Error(w, callsign+" is already on the air; pick another callsign", http.StatusConflict)
		return
	}

	ttl := 24 * time.Hour
	s := session{Callsign: callsign, Sid: sid, Role: role, Exp: time.Now().Add(ttl).Unix()}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    a.issue(s),
		Path:     "/",
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, map[string]any{"callsign": s.Callsign, "role": s.Role})
}

func (a *Auth) HandleMe(w http.ResponseWriter, r *http.Request) {
	s, ok := a.Session(r)
	if !ok {
		http.Error(w, "not logged in", http.StatusUnauthorized)
		return
	}
	writeJSON(w, map[string]any{"callsign": s.Callsign, "role": s.Role})
}

func (a *Auth) HandleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}

func randomID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
