// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	GitStatusAdded     = "A"
	GitStatusDeleted   = "D"
	GitStatusModified  = "M"
	GitStatusUntracked = "?"
)

var GitDiffHunkPattern = regexp.MustCompile(`^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@`)

func resolveGitPath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("path is required")
	}
	expandedPath, err := wavebase.ExpandHomeDir(path)
	if err != nil {
		return "", fmt.Errorf("cannot expand path %q: %w", path, err)
	}
	absPath, err := filepath.Abs(expandedPath)
	if err != nil {
		return "", fmt.Errorf("cannot resolve path %q: %w", path, err)
	}
	return filepath.Clean(absPath), nil
}

func runGitCommand(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmdArgs := append([]string{"-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", cmdArgs...)
	output, err := cmd.Output()
	if err == nil {
		return output, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return nil, fmt.Errorf("git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(string(exitErr.Stderr)))
	}
	return nil, fmt.Errorf("cannot run git: %w", err)
}

func findGitRoot(ctx context.Context, path string) (string, bool, error) {
	resolvedPath, err := resolveGitPath(path)
	if err != nil {
		return "", false, err
	}
	info, statErr := os.Stat(resolvedPath)
	searchPath := resolvedPath
	if statErr == nil && !info.IsDir() {
		searchPath = filepath.Dir(resolvedPath)
	}
	output, err := runGitCommand(ctx, searchPath, "rev-parse", "--show-toplevel")
	if err != nil {
		var execErr *exec.Error
		if errors.As(err, &execErr) {
			return "", false, err
		}
		return "", false, nil
	}
	root := strings.TrimSpace(string(output))
	if root == "" {
		return "", false, nil
	}
	return filepath.Clean(root), true, nil
}

func normalizeGitStatus(indexStatus byte, workTreeStatus byte) string {
	if indexStatus == '?' && workTreeStatus == '?' {
		return GitStatusUntracked
	}
	if indexStatus == 'D' || workTreeStatus == 'D' {
		return GitStatusDeleted
	}
	if indexStatus == 'A' || workTreeStatus == 'A' {
		return GitStatusAdded
	}
	return GitStatusModified
}

func parseGitStatusOutput(root string, output []byte) []wshrpc.GitFileStatus {
	records := bytes.Split(output, []byte{0})
	files := make([]wshrpc.GitFileStatus, 0, len(records))
	for idx := 0; idx < len(records); idx++ {
		record := records[idx]
		if len(record) < 4 || record[2] != ' ' {
			continue
		}
		indexStatus := record[0]
		workTreeStatus := record[1]
		path := string(record[3:])
		if path == "" {
			continue
		}
		files = append(files, wshrpc.GitFileStatus{
			Path:           filepath.ToSlash(path),
			AbsPath:        filepath.ToSlash(filepath.Join(root, filepath.FromSlash(path))),
			Status:         normalizeGitStatus(indexStatus, workTreeStatus),
			IndexStatus:    strings.TrimSpace(string(indexStatus)),
			WorkTreeStatus: strings.TrimSpace(string(workTreeStatus)),
		})
		if indexStatus == 'R' || indexStatus == 'C' {
			idx++
		}
	}
	return files
}

func getGitBranch(ctx context.Context, root string) string {
	output, err := runGitCommand(ctx, root, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err == nil {
		return strings.TrimSpace(string(output))
	}
	output, err = runGitCommand(ctx, root, "rev-parse", "--short", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func getGitAheadBehind(ctx context.Context, root string) (int, int) {
	output, err := runGitCommand(ctx, root, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
	if err != nil {
		return 0, 0
	}
	fields := strings.Fields(string(output))
	if len(fields) != 2 {
		return 0, 0
	}
	ahead, _ := strconv.Atoi(fields[0])
	behind, _ := strconv.Atoi(fields[1])
	return ahead, behind
}

func getGitStatus(ctx context.Context, path string) (*wshrpc.GitStatusResponse, error) {
	resolvedPath, err := resolveGitPath(path)
	if err != nil {
		return nil, err
	}
	root, isRepo, err := findGitRoot(ctx, resolvedPath)
	if err != nil {
		return nil, err
	}
	response := &wshrpc.GitStatusResponse{
		IsRepo:       isRepo,
		ResolvedPath: filepath.ToSlash(resolvedPath),
		Files:        []wshrpc.GitFileStatus{},
		Ts:           time.Now().UnixMilli(),
	}
	if !isRepo {
		return response, nil
	}
	output, err := runGitCommand(ctx, root, "status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		return nil, err
	}
	response.Root = filepath.ToSlash(root)
	response.Branch = getGitBranch(ctx, root)
	response.Ahead, response.Behind = getGitAheadBehind(ctx, root)
	response.Files = parseGitStatusOutput(root, output)
	response.Dirty = len(response.Files) > 0
	return response, nil
}

func parseGitDiffHunks(output []byte) []wshrpc.GitDiffHunk {
	lines := bytes.Split(output, []byte{'\n'})
	hunks := make([]wshrpc.GitDiffHunk, 0)
	for _, line := range lines {
		match := GitDiffHunkPattern.FindSubmatch(line)
		if match == nil {
			continue
		}
		oldStart, _ := strconv.Atoi(string(match[1]))
		oldLines := 1
		if len(match[2]) > 0 {
			oldLines, _ = strconv.Atoi(string(match[2]))
		}
		newStart, _ := strconv.Atoi(string(match[3]))
		newLines := 1
		if len(match[4]) > 0 {
			newLines, _ = strconv.Atoi(string(match[4]))
		}
		hunks = append(hunks, wshrpc.GitDiffHunk{
			OldStart: oldStart,
			OldLines: oldLines,
			NewStart: newStart,
			NewLines: newLines,
		})
	}
	return hunks
}

func countFileLines(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	buffer := make([]byte, 32*1024)
	lineCount := 0
	hasData := false
	lastByte := byte('\n')
	for {
		n, readErr := file.Read(buffer)
		if n > 0 {
			hasData = true
			lineCount += bytes.Count(buffer[:n], []byte{'\n'})
			lastByte = buffer[n-1]
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				return 0, readErr
			}
			break
		}
	}
	if hasData && lastByte != '\n' {
		lineCount++
	}
	return lineCount, nil
}

func getGitFileDiff(ctx context.Context, path string) (*wshrpc.GitFileDiffResponse, error) {
	resolvedPath, err := resolveGitPath(path)
	if err != nil {
		return nil, err
	}
	root, isRepo, err := findGitRoot(ctx, resolvedPath)
	if err != nil {
		return nil, err
	}
	response := &wshrpc.GitFileDiffResponse{
		IsRepo: isRepo,
		Hunks:  []wshrpc.GitDiffHunk{},
	}
	if !isRepo {
		return response, nil
	}
	relativePath, err := filepath.Rel(root, resolvedPath)
	if err != nil || strings.HasPrefix(relativePath, "..") {
		return nil, fmt.Errorf("path %q is outside repository %q", resolvedPath, root)
	}
	statusResponse, err := getGitStatus(ctx, resolvedPath)
	if err != nil {
		return nil, err
	}
	normalizedPath := filepath.ToSlash(resolvedPath)
	for _, fileStatus := range statusResponse.Files {
		if fileStatus.AbsPath == normalizedPath {
			response.Status = fileStatus.Status
			break
		}
	}
	response.Root = filepath.ToSlash(root)
	response.Path = filepath.ToSlash(relativePath)
	if response.Status == "" || response.Status == GitStatusDeleted {
		return response, nil
	}
	_, headErr := runGitCommand(ctx, root, "rev-parse", "--verify", "HEAD")
	if response.Status == GitStatusUntracked || headErr != nil {
		lineCount, countErr := countFileLines(resolvedPath)
		if countErr != nil {
			return nil, fmt.Errorf("cannot inspect file %q: %w", resolvedPath, countErr)
		}
		response.Hunks = []wshrpc.GitDiffHunk{{
			OldStart: 0,
			OldLines: 0,
			NewStart: 1,
			NewLines: lineCount,
		}}
		return response, nil
	}
	output, err := runGitCommand(
		ctx,
		root,
		"diff",
		"--no-ext-diff",
		"--unified=0",
		"--no-color",
		"HEAD",
		"--",
		relativePath,
	)
	if err != nil {
		return nil, err
	}
	response.Binary = bytes.Contains(output, []byte("Binary files "))
	response.Hunks = parseGitDiffHunks(output)
	return response, nil
}

func (*ServerImpl) RemoteGitStatusCommand(
	ctx context.Context,
	data wshrpc.CommandRemoteGitStatusData,
) (*wshrpc.GitStatusResponse, error) {
	return getGitStatus(ctx, data.Path)
}

func (*ServerImpl) RemoteGitFileDiffCommand(
	ctx context.Context,
	data wshrpc.CommandRemoteGitFileDiffData,
) (*wshrpc.GitFileDiffResponse, error) {
	return getGitFileDiff(ctx, data.Path)
}
