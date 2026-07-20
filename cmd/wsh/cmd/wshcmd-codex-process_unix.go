// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build darwin || linux

package cmd

import (
	"os/exec"
	"syscall"
)

func configureCodexAppServerProcess(child *exec.Cmd) {
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateCodexAppServerProcess(child *exec.Cmd) {
	if err := syscall.Kill(-child.Process.Pid, syscall.SIGKILL); err != nil {
		_ = child.Process.Kill()
	}
}
