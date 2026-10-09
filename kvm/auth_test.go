package kvm

import (
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSessionSigning(t *testing.T) {
	a := newAuthenticator(&Config{Password: "pw", SessionSecret: "s1", SessionTTL: time.Hour})
	now := time.Now()
	cookie := a.signSession(now.Add(time.Hour))

	if !a.verifySession(cookie, now) {
		t.Fatal("fresh session rejected")
	}
	if a.verifySession(cookie, now.Add(2*time.Hour)) {
		t.Fatal("expired session accepted")
	}
	other := newAuthenticator(&Config{Password: "pw", SessionSecret: "s2"})
	if other.verifySession(cookie, now) {
		t.Fatal("session signed with another secret accepted")
	}
	// Tampering with the expiry invalidates the signature
	_, sig, _ := strings.Cut(cookie, ".")
	if a.verifySession(strconv.FormatInt(now.Add(48*time.Hour).Unix(), 10)+"."+sig, now) {
		t.Fatal("tampered session accepted")
	}
	if a.verifySession("garbage", now) || a.verifySession("", now) {
		t.Fatal("malformed session accepted")
	}
}

func TestIdentify(t *testing.T) {
	open := newAuthenticator(&Config{})
	if m, ok := open.identify(httptest.NewRequest("GET", "/api/status", nil)); !ok || m != authNone {
		t.Fatal("open server should allow everything")
	}

	a := newAuthenticator(&Config{Password: "pw", APITokens: []string{"tok-1", " tok-2 "}})
	if !a.checkPassword("pw") || a.checkPassword("PW") {
		t.Fatal("password check")
	}

	r := httptest.NewRequest("GET", "/api/status", nil)
	if _, ok := a.identify(r); ok {
		t.Fatal("anonymous request accepted")
	}
	r.Header.Set("Authorization", "Bearer tok-2")
	if m, ok := a.identify(r); !ok || m != authToken {
		t.Fatal("bearer token rejected")
	}
	if m, ok := a.identify(httptest.NewRequest("GET", "/ws/hid?token=tok-1", nil)); !ok || m != authToken {
		t.Fatal("query token rejected")
	}
	if _, ok := a.identify(httptest.NewRequest("GET", "/ws/hid?token=nope", nil)); ok {
		t.Fatal("bad token accepted")
	}
}

func TestOriginAllowed(t *testing.T) {
	a := newAuthenticator(&Config{AllowedOrigins: []string{"https://dash.example.com/"}})
	check := func(origin, host string) bool {
		r := httptest.NewRequest("GET", "http://"+host+"/ws/hid", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return a.originAllowed(r)
	}
	if !check("", "kvm.lan:8080") || !check("http://kvm.lan:8080", "kvm.lan:8080") || !check("https://dash.example.com", "kvm.lan") {
		t.Fatal("legitimate origin rejected")
	}
	if check("https://evil.example", "kvm.lan:8080") {
		t.Fatal("foreign origin accepted")
	}
}

func TestLoginRateLimit(t *testing.T) {
	a := newAuthenticator(&Config{Password: "pw"})
	for i := 0; i < loginMaxFailures; i++ {
		if a.loginBlocked("1.2.3.4") {
			t.Fatalf("blocked after %d failures", i)
		}
		a.recordFailure("1.2.3.4")
	}
	if !a.loginBlocked("1.2.3.4") || a.loginBlocked("5.6.7.8") {
		t.Fatal("rate limit not per IP")
	}
}
