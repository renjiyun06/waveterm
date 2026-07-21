// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func runTestGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}

func TestParseGitStatusOutput(t *testing.T) {
	root := "/work/repo"
	output := []byte(" M src/main.go\x00?? notes.txt\x00A  added.go\x00D  removed.go\x00R  renamed.go\x00old.go\x00")
	files := parseGitStatusOutput(root, output)
	if len(files) != 5 {
		t.Fatalf("expected 5 files, got %d", len(files))
	}
	expected := []struct {
		path   string
		status string
	}{
		{"src/main.go", GitStatusModified},
		{"notes.txt", GitStatusUntracked},
		{"added.go", GitStatusAdded},
		{"removed.go", GitStatusDeleted},
		{"renamed.go", GitStatusModified},
	}
	for idx, item := range expected {
		if files[idx].Path != item.path || files[idx].Status != item.status {
			t.Fatalf("file %d: expected %s %s, got %s %s", idx, item.path, item.status, files[idx].Path, files[idx].Status)
		}
	}
}

func TestParseGitDiffHunks(t *testing.T) {
	output := []byte("diff --git a/file b/file\n@@ -2,3 +2,4 @@\n@@ -10 +11,0 @@\n@@ -20,0 +21,2 @@\n")
	hunks := parseGitDiffHunks(output)
	if len(hunks) != 3 {
		t.Fatalf("expected 3 hunks, got %d", len(hunks))
	}
	if hunks[0].OldStart != 2 || hunks[0].OldLines != 3 || hunks[0].NewStart != 2 || hunks[0].NewLines != 4 {
		t.Fatalf("unexpected first hunk: %#v", hunks[0])
	}
	if hunks[1].OldLines != 1 || hunks[1].NewLines != 0 {
		t.Fatalf("unexpected deletion hunk: %#v", hunks[1])
	}
	if hunks[2].OldLines != 0 || hunks[2].NewLines != 2 {
		t.Fatalf("unexpected addition hunk: %#v", hunks[2])
	}
}

func TestGetGitStatusAndFileDiff(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repoDir := t.TempDir()
	runTestGit(t, repoDir, "init", "--quiet")

	trackedPath := filepath.Join(repoDir, "tracked.txt")
	if err := os.WriteFile(trackedPath, []byte("first\nsecond\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runTestGit(t, repoDir, "add", "tracked.txt")
	runTestGit(
		t,
		repoDir,
		"-c",
		"user.name=Wave Test",
		"-c",
		"user.email=wave@example.com",
		"commit",
		"--quiet",
		"-m",
		"initial",
	)

	if err := os.WriteFile(trackedPath, []byte("first\nchanged\nadded\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	untrackedPath := filepath.Join(repoDir, "untracked.txt")
	if err := os.WriteFile(untrackedPath, []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	status, err := getGitStatus(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if !status.IsRepo || !status.Dirty || len(status.Files) != 2 {
		t.Fatalf("unexpected Git status: %#v", status)
	}

	diff, err := getGitFileDiff(context.Background(), trackedPath)
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != GitStatusModified || len(diff.Hunks) == 0 {
		t.Fatalf("unexpected tracked file diff: %#v", diff)
	}

	untrackedDiff, err := getGitFileDiff(context.Background(), untrackedPath)
	if err != nil {
		t.Fatal(err)
	}
	if untrackedDiff.Status != GitStatusUntracked || len(untrackedDiff.Hunks) != 1 {
		t.Fatalf("unexpected untracked file diff: %#v", untrackedDiff)
	}
	if untrackedDiff.Hunks[0].OldLines != 0 || untrackedDiff.Hunks[0].NewLines != 1 {
		t.Fatalf("unexpected untracked file hunk: %#v", untrackedDiff.Hunks[0])
	}
}

func TestGitStatusCanProbeNestedRepositoryWithoutScanningParent(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	workspaceDir := t.TempDir()
	repoDir := filepath.Join(workspaceDir, "nested", "repo")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	runTestGit(t, repoDir, "init", "--quiet")
	if err := os.WriteFile(filepath.Join(repoDir, "untracked.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	parentStatus, err := getGitStatus(context.Background(), workspaceDir)
	if err != nil {
		t.Fatal(err)
	}
	if parentStatus.IsRepo {
		t.Fatalf("non-Git parent was reported as a repository: %#v", parentStatus)
	}

	nestedStatus, err := getGitStatus(context.Background(), repoDir)
	if err != nil {
		t.Fatal(err)
	}
	if !nestedStatus.IsRepo || !nestedStatus.Dirty || filepath.ToSlash(repoDir) != nestedStatus.Root {
		t.Fatalf("nested repository probe failed: %#v", nestedStatus)
	}
}
