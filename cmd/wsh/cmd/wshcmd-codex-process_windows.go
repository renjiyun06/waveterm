// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package cmd

import (
	"io"
	"os/exec"
	"strconv"
)

func configureCodexAppServerProcess(_ *exec.Cmd) {
}

func terminateCodexAppServerProcess(child *exec.Cmd) {
	taskkill := exec.Command("taskkill.exe", "/PID", strconv.Itoa(child.Process.Pid), "/T", "/F")
	taskkill.Stdout = io.Discard
	taskkill.Stderr = io.Discard
	if taskkill.Run() != nil {
		_ = child.Process.Kill()
	}
}
