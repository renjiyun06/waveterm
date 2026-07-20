// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package webremote

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSessionLifecycle(t *testing.T) {
	auth, err := newSessionAuth("a-long-codex-web-token")
	if err != nil {
		t.Fatalf("newSessionAuth: %v", err)
	}
	now := time.Unix(1_700_000_000, 0)
	auth.nowFn = func() time.Time { return now }
	session, err := auth.makeSession()
	if err != nil || !auth.validSession(session) {
		t.Fatalf("fresh session should be valid: %v", err)
	}
	if auth.validSession(session + "tampered") {
		t.Fatalf("tampered session should be invalid")
	}
	now = now.Add(sessionDuration + time.Second)
	if auth.validSession(session) {
		t.Fatalf("expired session should be invalid")
	}
}

func TestLoginCreatesHttpOnlySession(t *testing.T) {
	const accessToken = "a-long-codex-web-token"
	auth, err := newSessionAuth(accessToken)
	if err != nil {
		t.Fatalf("newSessionAuth: %v", err)
	}
	manager := &Manager{registry: codexTestRegistry()}
	handler := manager.makeHandler(auth, make(chan struct{}))
	request := httptest.NewRequest(http.MethodPost, "http://wave.test/api/login", strings.NewReader(`{"token":"`+accessToken+`"}`))
	request.Host = "wave.test"
	request.Header.Set("Origin", "http://wave.test")
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "192.0.2.10:4321"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", response.Code, response.Body.String())
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("unexpected session cookies: %#v", cookies)
	}
	if strings.Contains(cookies[0].Value, accessToken) {
		t.Fatalf("session cookie must not contain the access token")
	}
}

func TestLoginRejectsCrossOrigin(t *testing.T) {
	auth, _ := newSessionAuth("a-long-codex-web-token")
	manager := &Manager{registry: codexTestRegistry()}
	handler := manager.makeHandler(auth, make(chan struct{}))
	request := httptest.NewRequest(http.MethodPost, "http://wave.test/api/login", strings.NewReader(`{"token":"wrong"}`))
	request.Host = "wave.test"
	request.Header.Set("Origin", "https://attacker.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin login status = %d", response.Code)
	}
}
