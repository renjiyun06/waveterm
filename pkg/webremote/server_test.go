// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package webremote

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/codexremote"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func codexTestRegistry() *codexremote.Registry {
	return codexremote.NewRegistry()
}

func TestConfigFromSettingsUsesSafeDefault(t *testing.T) {
	config := configFromSettings(wconfig.SettingsType{})
	if config.Enabled || config.Listen != DefaultListenAddress {
		t.Fatalf("unexpected default config: %#v", config)
	}
}

func TestValidateServerConfigRequiresLongToken(t *testing.T) {
	err := validateServerConfig(serverConfig{
		Enabled: true,
		Listen:  DefaultListenAddress,
		Token:   "short",
	})
	if err == nil {
		t.Fatalf("expected token length error")
	}
}

func TestInvalidConfigKeepsExistingServerRunning(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<!doctype html>"), 0o600); err != nil {
		t.Fatalf("write static fixture: %v", err)
	}
	manager, err := NewManager(staticDir)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	defer manager.Close()
	if err := manager.ApplySettings(wconfig.SettingsType{
		WebRemoteEnabled: true,
		WebRemoteListen:  "127.0.0.1:0",
		WebRemoteToken:   "a-valid-codex-web-token",
	}); err != nil {
		t.Fatalf("start server: %v", err)
	}
	manager.lock.Lock()
	runningServer := manager.server
	manager.lock.Unlock()
	if runningServer == nil {
		t.Fatal("server did not start")
	}
	if err := manager.ApplySettings(wconfig.SettingsType{
		WebRemoteEnabled: true,
		WebRemoteListen:  "127.0.0.1:0",
		WebRemoteToken:   "short",
	}); err == nil {
		t.Fatal("expected invalid replacement config")
	}
	manager.lock.Lock()
	serverAfterError := manager.server
	manager.lock.Unlock()
	if serverAfterError != runningServer {
		t.Fatal("invalid replacement stopped the existing server")
	}
}
