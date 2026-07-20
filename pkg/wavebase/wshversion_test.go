// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavebase

import "testing"

func TestWshVersionIncludesCodexWebCapability(t *testing.T) {
	originalVersion := WaveVersion
	t.Cleanup(func() {
		WaveVersion = originalVersion
	})
	WaveVersion = "0.14.5"
	if got := GetWshVersion(); got != "0.14.5+wavecodex1" {
		t.Fatalf("wsh version = %q", got)
	}
	WaveVersion = "0.14.5+windows"
	if got := GetWshVersion(); got != "0.14.5+windows.wavecodex1" {
		t.Fatalf("wsh version with metadata = %q", got)
	}
	if !WshVersionHasCodexWeb("v0.14.5+windows.wavecodex1") {
		t.Fatal("capability marker was not detected")
	}
	if WshVersionHasCodexWeb("v0.14.5") {
		t.Fatal("plain version unexpectedly has the capability")
	}
}
