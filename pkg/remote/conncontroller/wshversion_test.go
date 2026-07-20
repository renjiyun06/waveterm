// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

func TestIsWshVersionUpToDateRequiresCodexWebCapability(t *testing.T) {
	originalVersion := wavebase.WaveVersion
	t.Cleanup(func() {
		wavebase.WaveVersion = originalVersion
	})
	wavebase.WaveVersion = "0.14.5"

	upToDate, _, _, err := IsWshVersionUpToDate(context.Background(), "wsh v0.14.5")
	if err != nil {
		t.Fatalf("plain version: %v", err)
	}
	if upToDate {
		t.Fatal("helper without the Codex Web capability was accepted")
	}

	upToDate, version, _, err := IsWshVersionUpToDate(context.Background(), "wsh v0.14.5+wavecodex1")
	if err != nil {
		t.Fatalf("capable version: %v", err)
	}
	if !upToDate || version != "v0.14.5+wavecodex1" {
		t.Fatalf("capable helper rejected: upToDate=%v version=%q", upToDate, version)
	}
}
