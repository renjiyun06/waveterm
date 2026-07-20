// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package webremote

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookieName = "wave_codex_session"
	sessionDuration   = 7 * 24 * time.Hour
	loginWindow       = time.Minute
	maxLoginFailures  = 8
)

type loginFailureState struct {
	windowStart time.Time
	count       int
}

type sessionAuth struct {
	token        []byte
	sessionKey   []byte
	failureLock  sync.Mutex
	loginFailure map[string]loginFailureState
	nowFn        func() time.Time
}

func newSessionAuth(token string) (*sessionAuth, error) {
	sessionKey := make([]byte, 32)
	if _, err := rand.Read(sessionKey); err != nil {
		return nil, fmt.Errorf("generating Codex Web session key: %w", err)
	}
	return &sessionAuth{
		token:        []byte(token),
		sessionKey:   sessionKey,
		loginFailure: make(map[string]loginFailureState),
		nowFn:        time.Now,
	}, nil
}

func (a *sessionAuth) tokenMatches(token string) bool {
	return subtle.ConstantTimeCompare(a.token, []byte(token)) == 1
}

func (a *sessionAuth) sign(value string) []byte {
	mac := hmac.New(sha256.New, a.sessionKey)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func (a *sessionAuth) makeSession() (string, error) {
	nonce := make([]byte, 18)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	expires := a.nowFn().Add(sessionDuration).Unix()
	payload := strconv.FormatInt(expires, 10) + "." + base64.RawURLEncoding.EncodeToString(nonce)
	signature := base64.RawURLEncoding.EncodeToString(a.sign(payload))
	return payload + "." + signature, nil
}

func (a *sessionAuth) validSession(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return false
	}
	expires, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || a.nowFn().Unix() > expires {
		return false
	}
	payload := parts[0] + "." + parts[1]
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	return hmac.Equal(signature, a.sign(payload))
}

func (a *sessionAuth) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookieName)
	return err == nil && a.validSession(cookie.Value)
}

func remoteAddressKey(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}
	return remoteAddr
}

func (a *sessionAuth) loginAllowed(remoteAddr string) bool {
	key := remoteAddressKey(remoteAddr)
	now := a.nowFn()
	a.failureLock.Lock()
	defer a.failureLock.Unlock()
	state := a.loginFailure[key]
	if state.windowStart.IsZero() || now.Sub(state.windowStart) >= loginWindow {
		delete(a.loginFailure, key)
		return true
	}
	return state.count < maxLoginFailures
}

func (a *sessionAuth) recordLoginFailure(remoteAddr string) {
	key := remoteAddressKey(remoteAddr)
	now := a.nowFn()
	a.failureLock.Lock()
	defer a.failureLock.Unlock()
	state := a.loginFailure[key]
	if state.windowStart.IsZero() || now.Sub(state.windowStart) >= loginWindow {
		state = loginFailureState{windowStart: now}
	}
	state.count++
	a.loginFailure[key] = state
}

func (a *sessionAuth) clearLoginFailures(remoteAddr string) {
	a.failureLock.Lock()
	delete(a.loginFailure, remoteAddressKey(remoteAddr))
	a.failureLock.Unlock()
}

func originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	originURL, err := url.Parse(origin)
	if err != nil || (originURL.Scheme != "http" && originURL.Scheme != "https") {
		return false
	}
	return strings.EqualFold(originURL.Host, r.Host)
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
	})
}
