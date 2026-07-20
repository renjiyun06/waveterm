// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const (
	codexServerStartTimeout = 20 * time.Second
	codexRpcTimeout         = 10_000
	codexPollTimeout        = 35_000
)

var codexCmd = &cobra.Command{
	Use:                "codex [arguments...]",
	Short:              "run Codex with Wave Web chat synchronization",
	DisableFlagParsing: true,
	Args:               cobra.ArbitraryArgs,
	PreRunE:            preRunCodex,
	RunE:               codexCmdRun,
}

type codexExecutable struct {
	path   string
	prefix []string
}

type codexBridge struct {
	bridgeId     string
	blockId      string
	reports      chan bridgeReport
	done         chan struct{}
	reporterDone chan struct{}
}

type bridgeReport struct {
	kind string
	data string
}

type codexDeltaReport struct {
	Method       string `json:"-"`
	ThreadId     string `json:"threadId"`
	TurnId       string `json:"turnId"`
	ItemId       string `json:"itemId"`
	Delta        string `json:"delta"`
	SummaryIndex *int   `json:"summaryIndex,omitempty"`
}

type boundedLogBuffer struct {
	lock  sync.Mutex
	data  []byte
	limit int
}

type codexProxy struct {
	bridge        *codexBridge
	upstream      *websocket.Conn
	upstreamLock  sync.Mutex
	requestLock   sync.Mutex
	tuiRequests   map[string]string
	webRequestIds map[string]struct{}
	pollOnce      sync.Once
	pollFn        func()
	closed        atomic.Bool
}

type codexProxyHost struct {
	bridge         *codexBridge
	upstreamURL    string
	upgrader       websocket.Upgrader
	connectionLock sync.Mutex
	activeLock     sync.Mutex
	active         *codexProxy
	closed         atomic.Bool
}

type rpcEnvelope struct {
	Id     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func init() {
	rootCmd.AddCommand(codexCmd)
}

func preRunCodex(cmd *cobra.Command, args []string) error {
	if !shouldManageCodex(args) {
		return nil
	}
	return preRunSetupRpcClient(cmd, args)
}

func codexCmdRun(cmd *cobra.Command, args []string) error {
	executable, err := findCodexExecutable()
	if err != nil {
		return err
	}
	if !shouldManageCodex(args) {
		return runCodexProcess(executable, args)
	}
	return runManagedCodex(executable, args)
}

func shouldManageCodex(args []string) bool {
	if os.Getenv("WAVETERM_CODEX_WEB_DISABLE") != "" {
		return false
	}
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if arg == "--remote" || strings.HasPrefix(arg, "--remote=") ||
			arg == "--remote-auth-token-env" || strings.HasPrefix(arg, "--remote-auth-token-env=") {
			return false
		}
		if arg == "-h" || arg == "--help" || arg == "-V" || arg == "--version" {
			return false
		}
	}
	passthroughCommands := map[string]bool{
		"exec": true, "e": true, "review": true, "login": true, "logout": true,
		"mcp": true, "plugin": true, "mcp-server": true, "app-server": true,
		"remote-control": true, "completion": true, "update": true, "doctor": true,
		"sandbox": true, "debug": true, "apply": true, "a": true, "archive": true,
		"delete": true, "unarchive": true, "cloud": true, "exec-server": true,
		"features": true, "help": true,
	}
	return !passthroughCommands[codexTopLevelCommand(args)]
}

func codexTopLevelCommand(args []string) string {
	optionsWithValue := map[string]bool{
		"-c": true, "--config": true,
		"--enable": true, "--disable": true,
		"-i": true, "--image": true,
		"-m": true, "--model": true,
		"--oss-provider": true, "--local-provider": true,
		"-p": true, "--profile": true,
		"-s": true, "--sandbox": true,
		"-a": true, "--ask-for-approval": true, "--approval-policy": true,
		"-C": true, "--cd": true,
		"--add-dir": true,
	}
	optionsEnded := false
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			optionsEnded = true
			continue
		}
		if optionsEnded {
			// Everything after the delimiter is prompt text, never a
			// top-level Codex subcommand.
			return ""
		}
		if strings.HasPrefix(arg, "-") {
			optionName := arg
			if equals := strings.IndexByte(optionName, '='); equals >= 0 {
				optionName = optionName[:equals]
			} else if optionsWithValue[optionName] && index+1 < len(args) {
				index++
			}
			continue
		}
		return arg
	}
	return ""
}

func findCodexExecutable() (codexExecutable, error) {
	path := strings.TrimSpace(os.Getenv("WAVETERM_REAL_CODEX"))
	var err error
	if path == "" {
		path, err = exec.LookPath("codex")
		if err != nil {
			return codexExecutable{}, errors.New("could not find the real codex executable in PATH")
		}
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return codexExecutable{}, fmt.Errorf("resolving codex executable: %w", err)
	}
	extension := strings.ToLower(filepath.Ext(path))
	if runtime.GOOS != "windows" || (extension != ".cmd" && extension != ".bat" && extension != ".ps1") {
		return codexExecutable{path: path}, nil
	}

	// npm installs Codex through a small shell shim on Windows. Launching the
	// JavaScript entry point with an argument vector avoids cmd.exe re-parsing
	// prompts and flags.
	entrypoint := filepath.Join(filepath.Dir(path), "node_modules", "@openai", "codex", "bin", "codex.js")
	if _, statErr := os.Stat(entrypoint); statErr != nil {
		return codexExecutable{}, fmt.Errorf(
			"codex resolves to %s, but its npm entry point was not found; set WAVETERM_REAL_CODEX to codex.exe",
			path,
		)
	}
	if nativePath := findWindowsNpmCodexNative(entrypoint, runtime.GOARCH); nativePath != "" {
		return codexExecutable{path: nativePath}, nil
	}
	nodePath, lookErr := exec.LookPath("node")
	if lookErr != nil {
		return codexExecutable{}, errors.New("could not find node.exe for the Codex npm installation")
	}
	return codexExecutable{path: nodePath, prefix: []string{entrypoint}}, nil
}

func findWindowsNpmCodexNative(entrypoint string, goarch string) string {
	var targetTriple string
	var platformPackage string
	switch goarch {
	case "amd64":
		targetTriple = "x86_64-pc-windows-msvc"
		platformPackage = "codex-win32-x64"
	case "arm64":
		targetTriple = "aarch64-pc-windows-msvc"
		platformPackage = "codex-win32-arm64"
	default:
		return ""
	}
	packageRoot := filepath.Dir(filepath.Dir(entrypoint))
	nodeModulesRoot := filepath.Dir(filepath.Dir(packageRoot))
	platformRoots := []string{
		filepath.Join(packageRoot, "node_modules", "@openai", platformPackage),
		filepath.Join(nodeModulesRoot, "@openai", platformPackage),
		packageRoot,
	}
	for _, root := range platformRoots {
		for _, binaryDir := range []string{"bin", "codex"} {
			candidate := filepath.Join(root, "vendor", targetTriple, binaryDir, "codex.exe")
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
		}
	}
	return ""
}

func (executable codexExecutable) command(args ...string) *exec.Cmd {
	commandArgs := make([]string, 0, len(executable.prefix)+len(args))
	commandArgs = append(commandArgs, executable.prefix...)
	commandArgs = append(commandArgs, args...)
	return exec.Command(executable.path, commandArgs...)
}

func (buffer *boundedLogBuffer) Write(data []byte) (int, error) {
	buffer.lock.Lock()
	buffer.data = append(buffer.data, data...)
	if len(buffer.data) > buffer.limit {
		overflow := len(buffer.data) - buffer.limit
		copy(buffer.data, buffer.data[overflow:])
		buffer.data = buffer.data[:buffer.limit]
	}
	buffer.lock.Unlock()
	return len(data), nil
}

func (buffer *boundedLogBuffer) String() string {
	buffer.lock.Lock()
	defer buffer.lock.Unlock()
	return string(buffer.data)
}

func runCodexProcess(executable codexExecutable, args []string) error {
	child := executable.command(args...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	child.Env = os.Environ()
	return waitForCodex(child)
}

func waitForCodex(child *exec.Cmd) error {
	err := child.Run()
	if err == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		WshExitCode = exitErr.ExitCode()
		return nil
	}
	return err
}

func runManagedCodex(executable codexExecutable, args []string) error {
	blockId := os.Getenv("WAVETERM_BLOCKID")
	if blockId == "" {
		return errors.New("managed Codex requires WAVETERM_BLOCKID")
	}
	bridge := &codexBridge{
		bridgeId:     uuid.NewString(),
		blockId:      blockId,
		reports:      make(chan bridgeReport, 2048),
		done:         make(chan struct{}),
		reporterDone: make(chan struct{}),
	}
	registerData := wshrpc.CodexSessionRegisterData{
		BridgeId:    bridge.bridgeId,
		BlockId:     bridge.blockId,
		TabId:       os.Getenv("WAVETERM_TABID"),
		WorkspaceId: os.Getenv("WAVETERM_WORKSPACEID"),
		Connection:  os.Getenv("WAVETERM_CONN"),
	}
	cwd, _ := os.Getwd()
	registerData.Cwd = cwd
	if blockInfo, infoErr := wshclient.BlockInfoCommand(RpcClient, blockId, &wshrpc.RpcOpts{Timeout: 2000}); infoErr == nil &&
		blockInfo != nil && blockInfo.Block != nil {
		registerData.TabId = blockInfo.TabId
		registerData.WorkspaceId = blockInfo.WorkspaceId
		registerData.BlockName = codexBlockName(blockInfo.Block.Meta)
	}
	if err := wshclient.CodexSessionRegisterCommand(RpcClient, registerData, &wshrpc.RpcOpts{Timeout: codexRpcTimeout}); err != nil {
		return fmt.Errorf("registering managed Codex session: %w", err)
	}
	go bridge.reportLoop()
	defer func() {
		close(bridge.done)
		select {
		case <-bridge.reporterDone:
		case <-time.After(2 * time.Second):
		}
		_ = wshclient.CodexSessionUnregisterCommand(RpcClient, wshrpc.CodexSessionUnregisterData{
			BridgeId: bridge.bridgeId,
			BlockId:  bridge.blockId,
		}, &wshrpc.RpcOpts{Timeout: 2000})
	}()

	upstreamURL, appServer, appServerDone, err := startCodexAppServer(executable)
	if err != nil {
		return err
	}
	defer stopChildProcess(appServer, appServerDone)

	proxyListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("starting Codex bridge listener: %w", err)
	}
	proxyHost := newCodexProxyHost(bridge, upstreamURL)
	server := &http.Server{Handler: proxyHost, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		_ = server.Serve(proxyListener)
	}()
	defer func() {
		proxyHost.Close()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = server.Shutdown(shutdownCtx)
		cancel()
	}()

	proxyURL := "ws://" + proxyListener.Addr().String()
	tuiArgs := make([]string, 0, len(args)+2)
	tuiArgs = append(tuiArgs, "--remote", proxyURL)
	tuiArgs = append(tuiArgs, args...)
	tui := executable.command(tuiArgs...)
	tui.Stdin = os.Stdin
	tui.Stdout = os.Stdout
	tui.Stderr = os.Stderr
	tui.Env = os.Environ()
	return waitForCodex(tui)
}

func newCodexProxyHost(bridge *codexBridge, upstreamURL string) *codexProxyHost {
	return &codexProxyHost{
		bridge:      bridge,
		upstreamURL: upstreamURL,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				host, _, splitErr := net.SplitHostPort(r.RemoteAddr)
				return splitErr == nil && (host == "127.0.0.1" || host == "::1")
			},
		},
	}
}

func (host *codexProxyHost) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The Codex resume/fork picker owns a temporary app-server connection and
	// deliberately reconnects after a selection. Serialize connections so that
	// this handoff works without allowing two TUIs to share one bridge.
	host.connectionLock.Lock()
	defer host.connectionLock.Unlock()
	if host.closed.Load() {
		http.Error(w, "Codex bridge is shutting down", http.StatusServiceUnavailable)
		return
	}
	client, err := host.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	upstream, _, err := websocket.DefaultDialer.Dial(host.upstreamURL, nil)
	if err != nil {
		_ = client.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, err.Error()),
			time.Now().Add(time.Second),
		)
		_ = client.Close()
		return
	}
	proxy := &codexProxy{
		bridge:        host.bridge,
		upstream:      upstream,
		tuiRequests:   make(map[string]string),
		webRequestIds: make(map[string]struct{}),
	}
	proxy.pollFn = proxy.pollActions

	host.activeLock.Lock()
	if host.closed.Load() {
		host.activeLock.Unlock()
		_ = upstream.Close()
		_ = client.Close()
		return
	}
	host.active = proxy
	host.activeLock.Unlock()

	proxy.run(client)

	host.activeLock.Lock()
	if host.active == proxy {
		host.active = nil
	}
	host.activeLock.Unlock()
}

func (host *codexProxyHost) Close() {
	host.closed.Store(true)
	host.activeLock.Lock()
	proxy := host.active
	host.activeLock.Unlock()
	if proxy != nil {
		proxy.closed.Store(true)
		_ = proxy.upstream.Close()
	}
}

func codexBlockName(meta waveobj.MetaMapType) string {
	for _, key := range []string{
		waveobj.MetaKey_FrameText,
		waveobj.MetaKey_FrameTitle,
		waveobj.MetaKey_DisplayName,
	} {
		if value := strings.TrimSpace(meta.GetString(key, "")); value != "" {
			return value
		}
	}
	return ""
}

func startCodexAppServer(executable codexExecutable) (string, *exec.Cmd, <-chan error, error) {
	address, err := reserveLoopbackAddress()
	if err != nil {
		return "", nil, nil, err
	}
	endpoint := "ws://" + address
	child := executable.command("app-server", "--listen", endpoint)
	stderr := &boundedLogBuffer{limit: 32 * 1024}
	child.Stdin = nil
	child.Stdout = io.Discard
	child.Stderr = stderr
	child.Env = os.Environ()
	configureCodexAppServerProcess(child)
	if err := child.Start(); err != nil {
		return "", nil, nil, fmt.Errorf("starting Codex app-server: %w", err)
	}
	done := make(chan error, 1)
	go func() {
		done <- child.Wait()
	}()
	deadline := time.Now().Add(codexServerStartTimeout)
	for time.Now().Before(deadline) {
		select {
		case waitErr := <-done:
			return "", nil, nil, codexAppServerStartError("Codex app-server exited before becoming ready", waitErr, stderr.String())
		default:
		}
		connection, dialErr := net.DialTimeout("tcp", address, 150*time.Millisecond)
		if dialErr == nil {
			_ = connection.Close()
			return endpoint, child, done, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	stopChildProcess(child, done)
	return "", nil, nil, codexAppServerStartError("timed out waiting for Codex app-server", nil, stderr.String())
}

func codexAppServerStartError(message string, processErr error, logOutput string) error {
	if processErr != nil {
		message += ": " + processErr.Error()
	}
	if detail := strings.TrimSpace(logOutput); detail != "" {
		message += "\n" + detail
	}
	return errors.New(message)
}

func reserveLoopbackAddress() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("reserving Codex app-server address: %w", err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		return "", err
	}
	return address, nil
}

func stopChildProcess(child *exec.Cmd, done <-chan error) {
	if child == nil || child.Process == nil {
		return
	}
	select {
	case <-done:
		return
	default:
	}
	terminateCodexAppServerProcess(child)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}

func (bridge *codexBridge) queue(kind string, data string) {
	select {
	case bridge.reports <- bridgeReport{kind: kind, data: data}:
	case <-bridge.done:
	}
}

func (bridge *codexBridge) reportLoop() {
	defer close(bridge.reporterDone)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	pendingDeltas := make(map[string]codexDeltaReport)
	send := func(report bridgeReport) {
		_ = wshclient.CodexSessionEventCommand(RpcClient, wshrpc.CodexSessionEventData{
			BridgeId: bridge.bridgeId,
			BlockId:  bridge.blockId,
			Kind:     report.kind,
			Data:     report.data,
		}, &wshrpc.RpcOpts{Timeout: codexRpcTimeout})
	}
	flushDeltas := func() {
		for key, delta := range pendingDeltas {
			params, _ := json.Marshal(delta)
			envelope, _ := json.Marshal(map[string]any{
				"method": delta.Method,
				"params": json.RawMessage(params),
			})
			send(bridgeReport{kind: "notification", data: string(envelope)})
			delete(pendingDeltas, key)
		}
	}
	handle := func(report bridgeReport) {
		if delta, key, ok := parseCodexDeltaReport(report); ok {
			existing := pendingDeltas[key]
			if existing.ItemId == "" {
				existing = delta
			} else {
				existing.Delta += delta.Delta
			}
			pendingDeltas[key] = existing
			return
		}
		flushDeltas()
		send(report)
	}
	for {
		select {
		case <-bridge.done:
			for {
				select {
				case report := <-bridge.reports:
					handle(report)
				default:
					flushDeltas()
					return
				}
			}
		case report := <-bridge.reports:
			handle(report)
		case <-ticker.C:
			flushDeltas()
		}
	}
}

func parseCodexDeltaReport(report bridgeReport) (codexDeltaReport, string, bool) {
	if report.kind != "notification" {
		return codexDeltaReport{}, "", false
	}
	var envelope struct {
		Method string           `json:"method"`
		Params codexDeltaReport `json:"params"`
	}
	if json.Unmarshal([]byte(report.data), &envelope) != nil || envelope.Params.ItemId == "" {
		return codexDeltaReport{}, "", false
	}
	switch envelope.Method {
	case "item/agentMessage/delta",
		"item/plan/delta",
		"item/commandExecution/outputDelta",
		"item/reasoning/summaryTextDelta":
	default:
		return codexDeltaReport{}, "", false
	}
	envelope.Params.Method = envelope.Method
	key := envelope.Method + "\x00" + envelope.Params.ItemId
	if envelope.Params.SummaryIndex != nil {
		key += fmt.Sprintf("\x00%d", *envelope.Params.SummaryIndex)
	}
	return envelope.Params, key, true
}

func (proxy *codexProxy) run(client *websocket.Conn) {
	defer client.Close()
	defer proxy.upstream.Close()
	done := make(chan struct{}, 2)
	go func() {
		defer func() { done <- struct{}{} }()
		proxy.clientToServer(client)
	}()
	go func() {
		defer func() { done <- struct{}{} }()
		proxy.serverToClient(client)
	}()
	<-done
	proxy.closed.Store(true)
}

func (proxy *codexProxy) startPolling() {
	if proxy.pollFn == nil {
		return
	}
	proxy.pollOnce.Do(func() {
		go proxy.pollFn()
	})
}

func (proxy *codexProxy) clientToServer(client *websocket.Conn) {
	for {
		messageType, message, err := client.ReadMessage()
		if err != nil {
			return
		}
		proxy.trackTuiRequest(message)
		proxy.upstreamLock.Lock()
		err = proxy.upstream.WriteMessage(messageType, message)
		proxy.upstreamLock.Unlock()
		if err != nil {
			return
		}
	}
}

func (proxy *codexProxy) serverToClient(client *websocket.Conn) {
	for {
		messageType, message, err := proxy.upstream.ReadMessage()
		if err != nil {
			return
		}
		if proxy.observeServerMessage(message) {
			continue
		}
		if err := client.WriteMessage(messageType, message); err != nil {
			return
		}
	}
}

// observeServerMessage returns true when the message belongs to a Web action
// and must not be forwarded to the TUI.
func (proxy *codexProxy) observeServerMessage(message []byte) bool {
	var envelope rpcEnvelope
	if json.Unmarshal(message, &envelope) != nil {
		return false
	}
	if len(envelope.Id) != 0 && envelope.Method == "" {
		key := requestIdKey(envelope.Id)
		proxy.requestLock.Lock()
		_, isWebResponse := proxy.webRequestIds[key]
		if isWebResponse {
			delete(proxy.webRequestIds, key)
		}
		tuiMethod := proxy.tuiRequests[key]
		delete(proxy.tuiRequests, key)
		proxy.requestLock.Unlock()
		if isWebResponse {
			if len(envelope.Error) != 0 && string(envelope.Error) != "null" {
				proxy.bridge.queue("action-error", rpcErrorMessage(envelope.Error))
			}
			return true
		}
		if (tuiMethod == "thread/start" || tuiMethod == "thread/resume" || tuiMethod == "thread/fork") &&
			len(envelope.Result) != 0 && string(envelope.Result) != "null" {
			proxy.bridge.queue("snapshot", string(envelope.Result))
			// Picker connections only list/read threads and are intentionally
			// short-lived. Start Web action polling after the persistent thread
			// connection is known so a closing picker cannot consume an action.
			proxy.startPolling()
		}
		return false
	}
	if envelope.Method != "" && shouldReportCodexNotification(envelope.Method) {
		proxy.bridge.queue("notification", string(message))
	}
	return false
}

func (proxy *codexProxy) trackTuiRequest(message []byte) {
	var envelope rpcEnvelope
	if json.Unmarshal(message, &envelope) != nil || envelope.Method == "" || len(envelope.Id) == 0 {
		return
	}
	proxy.requestLock.Lock()
	proxy.tuiRequests[requestIdKey(envelope.Id)] = envelope.Method
	proxy.requestLock.Unlock()
}

func (proxy *codexProxy) pollActions() {
	for !proxy.closed.Load() {
		action, err := wshclient.CodexSessionPollCommand(RpcClient, wshrpc.CodexSessionPollData{
			BridgeId: proxy.bridge.bridgeId,
			BlockId:  proxy.bridge.blockId,
		}, &wshrpc.RpcOpts{Timeout: codexPollTimeout})
		if err != nil {
			if proxy.closed.Load() {
				return
			}
			time.Sleep(250 * time.Millisecond)
			continue
		}
		if action.Kind == "" || action.Kind == "noop" {
			continue
		}
		request, err := makeCodexActionRequest(action)
		if err != nil {
			proxy.bridge.queue("action-error", err.Error())
			continue
		}
		idRaw, _ := json.Marshal("wave-web:" + action.ActionId)
		key := requestIdKey(idRaw)
		proxy.requestLock.Lock()
		proxy.webRequestIds[key] = struct{}{}
		proxy.requestLock.Unlock()
		proxy.upstreamLock.Lock()
		err = proxy.upstream.WriteMessage(websocket.TextMessage, request)
		proxy.upstreamLock.Unlock()
		if err != nil {
			return
		}
	}
}

func makeCodexActionRequest(action wshrpc.CodexSessionAction) ([]byte, error) {
	if action.ActionId == "" || action.ThreadId == "" {
		return nil, errors.New("invalid Codex Web action")
	}
	params := map[string]any{
		"threadId": action.ThreadId,
	}
	switch action.Kind {
	case "turn/start":
		params["input"] = []map[string]any{{"type": "text", "text": action.Text}}
		params["clientUserMessageId"] = action.ActionId
	case "turn/steer":
		if action.TurnId == "" {
			return nil, errors.New("Codex steer action has no active turn")
		}
		params["expectedTurnId"] = action.TurnId
		params["input"] = []map[string]any{{"type": "text", "text": action.Text}}
		params["clientUserMessageId"] = action.ActionId
	case "turn/interrupt":
		if action.TurnId == "" {
			return nil, errors.New("Codex interrupt action has no active turn")
		}
		params["turnId"] = action.TurnId
	default:
		return nil, fmt.Errorf("unsupported Codex Web action %q", action.Kind)
	}
	return json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      "wave-web:" + action.ActionId,
		"method":  action.Kind,
		"params":  params,
	})
}

func shouldReportCodexNotification(method string) bool {
	switch method {
	case "error",
		"thread/started",
		"thread/status/changed",
		"thread/name/updated",
		"thread/closed",
		"turn/started",
		"turn/completed",
		"turn/plan/updated",
		"item/started",
		"item/completed",
		"item/agentMessage/delta",
		"item/plan/delta",
		"item/reasoning/summaryTextDelta",
		"item/commandExecution/outputDelta",
		"item/fileChange/patchUpdated",
		"item/mcpToolCall/progress":
		return true
	default:
		return false
	}
}

func requestIdKey(id json.RawMessage) string {
	return string(bytes.TrimSpace(id))
}

func rpcErrorMessage(raw json.RawMessage) string {
	var value struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &value) == nil && value.Message != "" {
		return value.Message
	}
	return string(raw)
}
