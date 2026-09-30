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
	"strings"
	"time"
)

const cookieName = "rp_session"

type Auth struct {
	key           []byte
	participantPW string
	instructorPW  string
}

type session struct {
	Callsign string `json:"c"`
	Role     Role   `json:"r"`
	Exp      int64  `json:"e"`
}

func NewAuth(participantPW, instructorPW string) *Auth {
	// Per-process key: restarting the server logs everyone out, which is
	// fine for a practice tool.
	key := make([]byte, 32)
	rand.Read(key)
	return &Auth{key: key, participantPW: participantPW, instructorPW: instructorPW}
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

	ttl := 24 * time.Hour
	s := session{Callsign: callsign, Role: role, Exp: time.Now().Add(ttl).Unix()}
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

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
