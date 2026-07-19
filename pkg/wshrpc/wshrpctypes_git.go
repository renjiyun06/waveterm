// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

type WshRpcGitInterface interface {
	RemoteGitStatusCommand(ctx context.Context, data CommandRemoteGitStatusData) (*GitStatusResponse, error)
	RemoteGitFileDiffCommand(ctx context.Context, data CommandRemoteGitFileDiffData) (*GitFileDiffResponse, error)
}

type CommandRemoteGitStatusData struct {
	Path string `json:"path"`
}

type CommandRemoteGitFileDiffData struct {
	Path string `json:"path"`
}

type GitFileStatus struct {
	Path           string `json:"path"`
	AbsPath        string `json:"abspath"`
	Status         string `json:"status"`
	IndexStatus    string `json:"indexstatus,omitempty"`
	WorkTreeStatus string `json:"worktreestatus,omitempty"`
}

type GitStatusResponse struct {
	IsRepo bool            `json:"isrepo"`
	Dirty  bool            `json:"dirty"`
	Root   string          `json:"root,omitempty"`
	Branch string          `json:"branch,omitempty"`
	Ahead  int             `json:"ahead,omitempty"`
	Behind int             `json:"behind,omitempty"`
	Files  []GitFileStatus `json:"files,omitempty"`
	Ts     int64           `json:"ts"`
}

type GitDiffHunk struct {
	OldStart int `json:"oldstart"`
	OldLines int `json:"oldlines"`
	NewStart int `json:"newstart"`
	NewLines int `json:"newlines"`
}

type GitFileDiffResponse struct {
	IsRepo bool          `json:"isrepo"`
	Root   string        `json:"root,omitempty"`
	Path   string        `json:"path,omitempty"`
	Status string        `json:"status,omitempty"`
	Binary bool          `json:"binary,omitempty"`
	Hunks  []GitDiffHunk `json:"hunks,omitempty"`
}
