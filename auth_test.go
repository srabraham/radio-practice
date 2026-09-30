package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func TestFailureBudget(t *testing.T) {
	t.Run("allows max failures then refuses", func(t *testing.T) {
		clk := &fakeClock{t: time.Unix(0, 0)}
		b := newFailureBudget(3, time.Minute, clk.now)
		for i := range 3 {
			if wait := b.take(); wait != 0 {
				t.Fatalf("take %d: got wait %v, want 0", i, wait)
			}
		}
		// One token refills every 20s.
		if wait := b.take(); wait != 20*time.Second {
			t.Fatalf("got wait %v, want 20s", wait)
		}
	})

	t.Run("refills over time", func(t *testing.T) {
		clk := &fakeClock{t: time.Unix(0, 0)}
		b := newFailureBudget(3, time.Minute, clk.now)
		for range 3 {
			b.take()
		}
		clk.advance(15 * time.Second)
		if wait := b.take(); wait != 5*time.Second {
			t.Fatalf("after 15s: got wait %v, want 5s", wait)
		}
		clk.advance(5 * time.Second)
		if wait := b.take(); wait != 0 {
			t.Fatalf("after 20s: got wait %v, want 0", wait)
		}
	})

	t.Run("refill is capped at max", func(t *testing.T) {
		clk := &fakeClock{t: time.Unix(0, 0)}
		b := newFailureBudget(3, time.Minute, clk.now)
		clk.advance(time.Hour)
		for range 3 {
			b.take()
		}
		if wait := b.take(); wait == 0 {
			t.Fatal("got a 4th token after a long idle, want cap of 3")
		}
	})

	t.Run("refund gives the token back", func(t *testing.T) {
		clk := &fakeClock{t: time.Unix(0, 0)}
		b := newFailureBudget(1, time.Minute, clk.now)
		b.take()
		b.refund()
		if wait := b.take(); wait != 0 {
			t.Fatalf("got wait %v after refund, want 0", wait)
		}
	})
}

func login(a *Auth, password string) *httptest.ResponseRecorder {
	body := `{"callsign":"BOT1","password":"` + password + `"}`
	w := httptest.NewRecorder()
	a.HandleLogin(w, httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(body)))
	return w
}

func TestLoginRefusedOnceFailureBudgetIsSpent(t *testing.T) {
	a := NewAuth("right", "control", func(string, string) bool { return false })
	a.failures = newFailureBudget(2, time.Hour, time.Now)

	if w := login(a, "right"); w.Code != http.StatusOK {
		t.Fatalf("correct password: got %d, want 200", w.Code)
	}
	if w := login(a, "wrong"); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password 1: got %d, want 401", w.Code)
	}
	if w := login(a, "wrong"); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password 2: got %d, want 401", w.Code)
	}

	// Budget spent: even the right password is refused without being checked.
	w := login(a, "right")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("after budget spent: got %d, want 429", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("429 has no Retry-After header")
	}
}

func TestLoginRefusedWhenCallsignOnTheAir(t *testing.T) {
	a := NewAuth("right", "control", nil)
	// Stands in for the hub: BOT1 is connected from the "phone" login.
	a.inUse = func(callsign, sid string) bool { return callsign == "BOT1" && sid != "phone" }

	w := login(a, "right")
	if w.Code != http.StatusConflict {
		t.Fatalf("new login for a callsign on the air: got %d, want 409", w.Code)
	}

	// The device already holding BOT1 may log in again and keeps its session.
	r := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"callsign":"BOT1","password":"right"}`))
	r.AddCookie(&http.Cookie{Name: cookieName, Value: a.issue(session{Callsign: "BOT1", Sid: "phone", Role: RoleParticipant, Exp: time.Now().Add(time.Hour).Unix()})})
	w = httptest.NewRecorder()
	a.HandleLogin(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("login from the holding device: got %d, want 200", w.Code)
	}
	r = httptest.NewRequest(http.MethodGet, "/", nil)
	for _, c := range w.Result().Cookies() {
		r.AddCookie(c)
	}
	s, ok := a.Session(r)
	if !ok || s.Sid != "phone" {
		t.Fatalf("got session %+v (ok=%v), want sid phone", s, ok)
	}
}
