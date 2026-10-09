package kvm

/*
	auth.go

	Two ways in, both optional:

	  - a password, exchanged at api/auth/login for a signed session cookie
	    (what the bundled UI uses), and
	  - API tokens, for integrations: "Authorization: Bearer <token>", or
	    ?token=<token> where headers cannot be set (an <img> src, a
	    WebSocket, an iframe).

	The cookie carries nothing but its expiry and an HMAC over it, so there is
	no server-side session store to lose or grow.
*/

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookieName = "kvm_session"
	loginMaxFailures  = 5
	loginWindow       = time.Minute
)

// Auth methods reported by api/auth/session.
const (
	authNone   = "none"
	authCookie = "cookie"
	authToken  = "token"
)

type authenticator struct {
	passwordHash   [32]byte
	hasPassword    bool
	tokens         [][32]byte
	secret         []byte
	ttl            time.Duration
	allowedOrigins []string

	mu       sync.Mutex
	failures map[string][]time.Time
}

func newAuthenticator(cfg *Config) *authenticator {
	a := &authenticator{
		ttl:            cfg.SessionTTL,
		allowedOrigins: cfg.AllowedOrigins,
		failures:       map[string][]time.Time{},
	}
	if cfg.Password != "" {
		a.passwordHash = sha256.Sum256([]byte(cfg.Password))
		a.hasPassword = true
	}
	for _, t := range cfg.APITokens {
		if t = strings.TrimSpace(t); t != "" {
			a.tokens = append(a.tokens, sha256.Sum256([]byte(t)))
		}
	}
	if cfg.SessionSecret != "" {
		a.secret = []byte(cfg.SessionSecret)
	} else {
		a.secret = make([]byte, 32)
		if _, err := rand.Read(a.secret); err != nil {
			panic("kvm: no randomness available for the session secret: " + err.Error())
		}
	}
	return a
}

func (a *authenticator) required() bool {
	return a.hasPassword || len(a.tokens) > 0
}

// Comparing fixed-size hashes keeps the comparison constant time and does
// not leak the length of the secret.
func (a *authenticator) checkPassword(pw string) bool {
	if !a.hasPassword {
		return false
	}
	h := sha256.Sum256([]byte(pw))
	return subtle.ConstantTimeCompare(h[:], a.passwordHash[:]) == 1
}

func (a *authenticator) checkToken(tok string) bool {
	if tok == "" {
		return false
	}
	h := sha256.Sum256([]byte(tok))
	ok := 0
	for _, t := range a.tokens {
		ok |= subtle.ConstantTimeCompare(h[:], t[:])
	}
	return ok == 1
}

func (a *authenticator) mac(payload string) []byte {
	m := hmac.New(sha256.New, a.secret)
	m.Write([]byte("kvm-session:" + payload))
	return m.Sum(nil)
}

func (a *authenticator) signSession(expiry time.Time) string {
	payload := strconv.FormatInt(expiry.Unix(), 10)
	return payload + "." + base64.RawURLEncoding.EncodeToString(a.mac(payload))
}

func (a *authenticator) verifySession(value string, now time.Time) bool {
	payload, sig, ok := strings.Cut(value, ".")
	if !ok {
		return false
	}
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(got, a.mac(payload)) {
		return false
	}
	exp, err := strconv.ParseInt(payload, 10, 64)
	return err == nil && now.Unix() < exp
}

// identify works out how (and whether) a request is authenticated.
func (a *authenticator) identify(r *http.Request) (method string, ok bool) {
	if !a.required() {
		return authNone, true
	}
	if h := r.Header.Get("Authorization"); h != "" {
		if tok, found := strings.CutPrefix(h, "Bearer "); found && a.checkToken(strings.TrimSpace(tok)) {
			return authToken, true
		}
	}
	if tok := r.URL.Query().Get("token"); tok != "" && a.checkToken(tok) {
		return authToken, true
	}
	if c, err := r.Cookie(sessionCookieName); err == nil && a.verifySession(c.Value, time.Now()) {
		return authCookie, true
	}
	return "", false
}

/* --- Login rate limiting ------------------------------------------------ */

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *authenticator) recentFailures(ip string, now time.Time) []time.Time {
	kept := a.failures[ip][:0]
	for _, t := range a.failures[ip] {
		if now.Sub(t) < loginWindow {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(a.failures, ip)
		return nil
	}
	a.failures[ip] = kept
	return kept
}

func (a *authenticator) loginBlocked(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.recentFailures(ip, time.Now())) >= loginMaxFailures
}

func (a *authenticator) recordFailure(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	a.failures[ip] = append(a.recentFailures(ip, now), now)
}

func (a *authenticator) clearFailures(ip string) {
	a.mu.Lock()
	delete(a.failures, ip)
	a.mu.Unlock()
}

/* --- Origins ------------------------------------------------------------ */

// explicitlyAllowed reports whether origin is on the configured list.
func (a *authenticator) explicitlyAllowed(origin string) bool {
	for _, allowed := range a.allowedOrigins {
		if allowed == "*" || strings.EqualFold(strings.TrimRight(allowed, "/"), origin) {
			return true
		}
	}
	return false
}

// originAllowed decides whether a browser request may act with the user's
// cookie. Browsers attach cookies to cross-site WebSocket handshakes, so
// without this check any web page the user visits could open ws/hid and
// type on the remote machine.
func (a *authenticator) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // not a browser, or a same-origin navigation
	}
	if a.explicitlyAllowed(origin) {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && strings.EqualFold(u.Host, r.Host)
}

/* --- Request context ---------------------------------------------------- */

type ctxKey struct{}

func withAuthMethod(r *http.Request, method string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), ctxKey{}, method))
}

func authMethod(r *http.Request) string {
	m, _ := r.Context().Value(ctxKey{}).(string)
	return m
}

func isSecure(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}
