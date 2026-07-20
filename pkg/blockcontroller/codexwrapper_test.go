// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"strings"
	"testing"
)

func TestCodexRemoteWrapperSupportsWaveShells(t *testing.T) {
	for _, shellType := range []string{"bash", "zsh", "fish", "pwsh"} {
		script := getCodexRemoteWrapperScript(shellType)
		if !strings.Contains(script, "wsh codex") {
			t.Fatalf("%s wrapper does not invoke wsh codex: %q", shellType, script)
		}
	}
	if script := getCodexRemoteWrapperScript("cmd"); script != "" {
		t.Fatalf("unsupported shell should not receive a wrapper: %q", script)
	}
}
