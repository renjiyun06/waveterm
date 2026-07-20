// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package webremote

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/wavetermdev/waveterm/pkg/codexremote"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	DefaultListenAddress = "127.0.0.1:16110"
	maxLoginBodySize     = 4096
	maxMessageBodySize   = 68 * 1024
)

type serverConfig struct {
	Enabled bool
	Listen  string
	Token   string
}

type Manager struct {
	applyLock sync.Mutex
	lock      sync.Mutex
	config    serverConfig
	server    *http.Server
	listener  net.Listener
	stopCh    chan struct{}
	staticDir string
	registry  *codexremote.Registry
}

func NewManager(staticDir string) (*Manager, error) {
	return &Manager{
		staticDir: staticDir,
		registry:  codexremote.DefaultRegistry(),
	}, nil
}

func configFromSettings(settings wconfig.SettingsType) serverConfig {
	listenAddress := strings.TrimSpace(settings.WebRemoteListen)
	if listenAddress == "" {
		listenAddress = DefaultListenAddress
	}
	return serverConfig{
		Enabled: settings.WebRemoteEnabled,
		Listen:  listenAddress,
		Token:   settings.WebRemoteToken,
	}
}

func validateServerConfig(config serverConfig) error {
	if !config.Enabled {
		return nil
	}
	if len([]byte(config.Token)) < 16 {
		return errors.New("webremote:token must contain at least 16 bytes")
	}
	if _, err := net.ResolveTCPAddr("tcp", config.Listen); err != nil {
		return fmt.Errorf("invalid webremote:listen %q: %w", config.Listen, err)
	}
	return nil
}

func configEqual(left serverConfig, right serverConfig) bool {
	if left.Enabled != right.Enabled || left.Listen != right.Listen {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left.Token), []byte(right.Token)) == 1
}

func (m *Manager) ApplySettings(settings wconfig.SettingsType) error {
	config := configFromSettings(settings)
	m.applyLock.Lock()
	defer m.applyLock.Unlock()

	m.lock.Lock()
	if configEqual(config, m.config) && (!config.Enabled || m.server != nil) {
		m.lock.Unlock()
		return nil
	}
	m.lock.Unlock()

	if err := validateServerConfig(config); err != nil {
		return err
	}
	var auth *sessionAuth
	if config.Enabled {
		if _, err := os.Stat(filepath.Join(m.staticDir, "index.html")); err != nil {
			return fmt.Errorf("Codex Web assets unavailable at %q: %w", m.staticDir, err)
		}
		var err error
		auth, err = newSessionAuth(config.Token)
		if err != nil {
			return err
		}
	}

	m.lock.Lock()
	oldServer := m.server
	oldStopCh := m.stopCh
	m.server = nil
	m.listener = nil
	m.stopCh = nil
	m.config = config
	m.lock.Unlock()

	if oldStopCh != nil {
		close(oldStopCh)
	}
	if oldServer != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = oldServer.Shutdown(shutdownCtx)
		cancel()
		_ = oldServer.Close()
	}
	if !config.Enabled {
		log.Printf("Codex Web server disabled")
		return nil
	}
	listener, err := net.Listen("tcp", config.Listen)
	if err != nil {
		return fmt.Errorf("listening for Codex Web access on %q: %w", config.Listen, err)
	}
	stopCh := make(chan struct{})
	server := &http.Server{
		Handler:           m.makeHandler(auth, stopCh),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    32 * 1024,
	}
	m.lock.Lock()
	m.server = server
	m.listener = listener
	m.stopCh = stopCh
	m.lock.Unlock()
	log.Printf("Codex Web server listening on http://%s", listener.Addr())
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Printf("[error] Codex Web server failed: %v", serveErr)
		}
	}()
	return nil
}

func (m *Manager) Close() error {
	m.applyLock.Lock()
	defer m.applyLock.Unlock()
	m.lock.Lock()
	server := m.server
	stopCh := m.stopCh
	m.server = nil
	m.listener = nil
	m.stopCh = nil
	m.config = serverConfig{}
	m.lock.Unlock()
	if stopCh != nil {
		close(stopCh)
	}
	if server == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := server.Shutdown(ctx)
	_ = server.Close()
	return err
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func requireAuth(auth *sessionAuth, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !auth.authenticated(r) {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		next(w, r)
	}
}

func (m *Manager) makeHandler(auth *sessionAuth, stopCh <-chan struct{}) http.Handler {
	router := mux.NewRouter()
	router.HandleFunc("/api/login", m.handleLogin(auth)).Methods(http.MethodPost)
	router.HandleFunc("/api/logout", requireAuth(auth, m.handleLogout)).Methods(http.MethodPost)
	router.HandleFunc("/api/session", requireAuth(auth, m.handleSession)).Methods(http.MethodGet)
	router.HandleFunc("/api/sessions", requireAuth(auth, m.handleSessions)).Methods(http.MethodGet)
	router.HandleFunc("/api/sessions/{blockid}", requireAuth(auth, m.handleSessionDetail)).Methods(http.MethodGet)
	router.HandleFunc("/api/sessions/{blockid}/messages", requireAuth(auth, m.handleMessage)).Methods(http.MethodPost)
	router.HandleFunc("/api/sessions/{blockid}/interrupt", requireAuth(auth, m.handleInterrupt)).Methods(http.MethodPost)
	router.HandleFunc("/api/events", requireAuth(auth, m.handleEvents(stopCh))).Methods(http.MethodGet)
	router.PathPrefix("/").Handler(http.FileServer(http.Dir(m.staticDir)))
	return securityHeaders(router)
}

func (m *Manager) handleLogin(auth *sessionAuth) http.HandlerFunc {
	type loginRequest struct {
		Token string `json:"token"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if !originAllowed(r) {
			writeJSONError(w, http.StatusForbidden, "origin not allowed")
			return
		}
		if !auth.loginAllowed(r.RemoteAddr) {
			writeJSONError(w, http.StatusTooManyRequests, "too many login attempts")
			return
		}
		body := http.MaxBytesReader(w, r.Body, maxLoginBodySize)
		defer body.Close()
		var request loginRequest
		if err := json.NewDecoder(body).Decode(&request); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid login request")
			return
		}
		if !auth.tokenMatches(request.Token) {
			auth.recordLoginFailure(r.RemoteAddr)
			writeJSONError(w, http.StatusUnauthorized, "invalid access token")
			return
		}
		session, err := auth.makeSession()
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not create session")
			return
		}
		auth.clearLoginFailures(r.RemoteAddr)
		setSessionCookie(w, r, session, int(sessionDuration/time.Second))
		writeJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
	}
}

func (m *Manager) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !originAllowed(r) {
		writeJSONError(w, http.StatusForbidden, "origin not allowed")
		return
	}
	setSessionCookie(w, r, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": false})
}

func (m *Manager) handleSession(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}

func (m *Manager) handleSessions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"sessions": m.registry.List()})
}

func (m *Manager) handleSessionDetail(w http.ResponseWriter, r *http.Request) {
	session, ok := m.registry.Get(mux.Vars(r)["blockid"])
	if !ok {
		writeJSONError(w, http.StatusNotFound, "Codex session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": session})
}

func (m *Manager) handleMessage(w http.ResponseWriter, r *http.Request) {
	if !originAllowed(r) {
		writeJSONError(w, http.StatusForbidden, "origin not allowed")
		return
	}
	var request struct {
		Text string `json:"text"`
	}
	body := http.MaxBytesReader(w, r.Body, maxMessageBodySize)
	defer body.Close()
	if err := json.NewDecoder(body).Decode(&request); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid message request")
		return
	}
	if err := m.registry.Submit(mux.Vars(r)["blockid"], request.Text); err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"accepted": true})
}

func (m *Manager) handleInterrupt(w http.ResponseWriter, r *http.Request) {
	if !originAllowed(r) {
		writeJSONError(w, http.StatusForbidden, "origin not allowed")
		return
	}
	if err := m.registry.Interrupt(mux.Vars(r)["blockid"]); err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"accepted": true})
}

func (m *Manager) handleEvents(stopCh <-chan struct{}) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSONError(w, http.StatusInternalServerError, "streaming unavailable")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		updates, cancel := m.registry.Subscribe()
		defer cancel()
		send := func() bool {
			data, err := json.Marshal(map[string]any{"sessions": m.registry.List()})
			if err != nil {
				return false
			}
			if _, err := fmt.Fprintf(w, "event: sessions\ndata: %s\n\n", data); err != nil {
				return false
			}
			flusher.Flush()
			return true
		}
		if !send() {
			return
		}
		heartbeat := time.NewTicker(15 * time.Second)
		defer heartbeat.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-stopCh:
				return
			case _, open := <-updates:
				if !open || !send() {
					return
				}
			case <-heartbeat.C:
				if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
