// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import "./style.css";

type ChatMessage = {
    id: string;
    role: "user" | "assistant";
    kind?: "message" | "reasoning" | "plan" | "tool";
    toolType?: string;
    title?: string;
    text: string;
    input?: string;
    output?: string;
    status?: string;
    truncated?: boolean;
    createdAt: number;
};

type CodexSession = {
    blockId: string;
    tabId?: string;
    workspaceId?: string;
    connection?: string;
    threadId?: string;
    title: string;
    cwd?: string;
    state: string;
    activeTurnId?: string;
    error?: string;
    updatedAt: number;
    revision: number;
    messages: ChatMessage[];
};

type RawCodexSession = Omit<CodexSession, "messages"> & {
    messages?: ChatMessage[] | null;
};

const getElement = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing element #${id}`);
    return element as T;
};

const appShell = getElement<HTMLDivElement>("app-shell");
const loginScreen = getElement<HTMLDivElement>("login-screen");
const loginForm = getElement<HTMLFormElement>("login-form");
const loginError = getElement<HTMLDivElement>("login-error");
const accessToken = getElement<HTMLInputElement>("access-token");
const sessionList = getElement<HTMLDivElement>("session-list");
const sessionSearch = getElement<HTMLInputElement>("session-search");
const sessionCount = getElement<HTMLSpanElement>("session-count");
const conversationTitle = getElement<HTMLDivElement>("conversation-title");
const conversationMeta = getElement<HTMLDivElement>("conversation-meta");
const connectionState = getElement<HTMLDivElement>("connection-state");
const connectionLabel = getElement<HTMLSpanElement>("connection-label");
const emptyState = getElement<HTMLDivElement>("empty-state");
const messageList = getElement<HTMLDivElement>("message-list");
const chatScroll = getElement<HTMLElement>("chat-scroll");
const composer = getElement<HTMLFormElement>("composer");
const messageInput = getElement<HTMLTextAreaElement>("message-input");
const sendButton = getElement<HTMLButtonElement>("send-message");
const interruptButton = getElement<HTMLButtonElement>("interrupt");
const sessionError = getElement<HTMLDivElement>("session-error");
const sidebar = getElement<HTMLElement>("sidebar");
const sidebarBackdrop = getElement<HTMLDivElement>("sidebar-backdrop");

let sessions: CodexSession[] = [];
let selectedBlockId = localStorage.getItem("wave-codex-selected") ?? "";
let eventSource: EventSource | null = null;
let sending = false;
let composing = false;
let checkingAuth = false;
let renderedBlockId = "";
let renderedSessionListKey = "";

const api = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (init?.body) headers.set("Content-Type", "application/json");
    return fetch(path, { ...init, headers, credentials: "same-origin" });
};

const parseError = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { error?: string };
        return body.error ?? `请求失败 (${response.status})`;
    } catch {
        return `请求失败 (${response.status})`;
    }
};

const selectedSession = (): CodexSession | undefined => sessions.find((session) => session.blockId === selectedBlockId);

const stateLabel = (state: string): string => {
    switch (state) {
        case "starting":
            return "正在启动";
        case "working":
        case "active":
            return "正在处理";
        case "waitingOnApproval":
            return "等待桌面批准";
        case "waitingOnUserInput":
            return "等待输入";
        case "error":
            return "出现错误";
        default:
            return "可继续";
    }
};

const stateClass = (state: string): string => {
    if (state === "working" || state === "active") return "working";
    if (state === "error") return "error";
    if (state === "starting") return "starting";
    if (state.startsWith("waiting")) return "waiting";
    return "idle";
};

const compactPath = (path?: string): string => {
    if (!path) return "";
    const normalized = path.replaceAll("\\", "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 2) return path;
    return `…/${parts.slice(-2).join("/")}`;
};

const closeSidebar = () => {
    sidebar.classList.remove("open");
    sidebarBackdrop.classList.remove("visible");
};

const openSidebar = () => {
    sidebar.classList.add("open");
    sidebarBackdrop.classList.add("visible");
};

const selectSession = (blockId: string) => {
    selectedBlockId = blockId;
    localStorage.setItem("wave-codex-selected", blockId);
    closeSidebar();
    render();
};

const renderSessionList = () => {
    const query = sessionSearch.value.trim().toLocaleLowerCase();
    const filtered = sessions.filter((session) =>
        `${session.title} ${session.cwd ?? ""} ${session.connection ?? ""}`.toLocaleLowerCase().includes(query)
    );
    const renderKey = JSON.stringify([
        query,
        selectedBlockId,
        sessions.map((session) => [session.blockId, session.title, session.state, session.connection, session.cwd]),
    ]);
    if (renderKey === renderedSessionListKey) return;
    renderedSessionListKey = renderKey;
    sessionList.replaceChildren();
    for (const session of filtered) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "session-item";
        button.classList.toggle("selected", session.blockId === selectedBlockId);
        button.addEventListener("click", () => selectSession(session.blockId));

        const heading = document.createElement("div");
        heading.className = "session-item-heading";
        const title = document.createElement("span");
        title.className = "session-item-title";
        title.textContent = session.title;
        const badge = document.createElement("span");
        badge.className = `session-badge ${stateClass(session.state)}`;
        badge.textContent = stateLabel(session.state);
        heading.append(title, badge);

        const meta = document.createElement("div");
        meta.className = "session-item-meta";
        const connection = session.connection && session.connection !== "local" ? session.connection : "本机";
        meta.textContent = [connection, compactPath(session.cwd)].filter(Boolean).join(" · ");
        button.append(heading, meta);
        sessionList.append(button);
    }
    if (filtered.length === 0) {
        const notice = document.createElement("div");
        notice.className = "list-empty";
        notice.textContent = sessions.length === 0 ? "还没有正在运行的 Codex 会话" : "没有匹配的会话";
        sessionList.append(notice);
    }
    sessionCount.textContent = `${sessions.length} 个会话`;
};

const activityStatusLabel = (status?: string): string => {
    switch (status) {
        case "inProgress":
        case "streaming":
            return "进行中";
        case "failed":
            return "失败";
        case "declined":
            return "已拒绝";
        default:
            return "已完成";
    }
};

const activityStatusClass = (status?: string): string => {
    if (status === "inProgress" || status === "streaming") return "running";
    if (status === "failed") return "failed";
    if (status === "declined") return "declined";
    return "completed";
};

const toolIcon = (toolType?: string): string => {
    switch (toolType) {
        case "command":
            return ">_";
        case "file":
            return "Δ";
        case "mcp":
            return "M";
        case "dynamic":
            return "◆";
        case "collab":
            return "◎";
        case "web":
            return "⌕";
        case "image":
            return "▧";
        case "wait":
            return "◷";
        case "context":
            return "≋";
        default:
            return "•";
    }
};

const renderConversationMessage = (article: HTMLElement, message: ChatMessage) => {
    if (article.dataset.layout !== "message") {
        article.replaceChildren();
        const label = document.createElement("div");
        label.className = "message-label";
        const bubble = document.createElement("div");
        bubble.className = "message-bubble";
        article.append(label, bubble);
        article.dataset.layout = "message";
    }
    article.className = `message ${message.role}`;
    const label = article.querySelector<HTMLElement>(".message-label")!;
    label.textContent = message.role === "user" ? "你" : "Codex";
    const bubble = article.querySelector<HTMLElement>(".message-bubble")!;
    const text = message.text || (message.status === "streaming" ? "…" : "");
    if (bubble.textContent !== text) bubble.textContent = text;
};

const renderNarrativeItem = (article: HTMLElement, message: ChatMessage, kind: "reasoning" | "plan") => {
    if (article.dataset.layout !== kind) {
        article.replaceChildren();
        const heading = document.createElement("div");
        heading.className = "timeline-label";
        const dot = document.createElement("span");
        dot.className = "timeline-label-dot";
        const label = document.createElement("span");
        label.className = "timeline-label-text";
        heading.append(dot, label);
        const content = document.createElement("div");
        content.className = "timeline-copy";
        article.append(heading, content);
        article.dataset.layout = kind;
    }
    article.className = `timeline-item ${kind} ${activityStatusClass(message.status)}`;
    article.querySelector<HTMLElement>(".timeline-label-text")!.textContent =
        message.title || (kind === "reasoning" ? "思考" : "计划");
    const fallback = kind === "reasoning" ? "正在思考…" : "正在整理计划…";
    const content = article.querySelector<HTMLElement>(".timeline-copy")!;
    const text = message.text || fallback;
    if (content.textContent !== text) content.textContent = text;
};

const createToolSection = (name: string, label: string): HTMLElement => {
    const section = document.createElement("section");
    section.className = "tool-detail-section";
    section.dataset.toolSection = name;
    const heading = document.createElement("div");
    heading.className = "tool-detail-label";
    heading.textContent = label;
    const content = document.createElement("pre");
    section.append(heading, content);
    return section;
};

const renderToolItem = (article: HTMLElement, message: ChatMessage) => {
    if (article.dataset.layout !== "tool") {
        article.replaceChildren();
        const details = document.createElement("details");
        details.className = "tool-card";
        const summary = document.createElement("summary");
        const icon = document.createElement("span");
        icon.className = "tool-icon";
        const copy = document.createElement("span");
        copy.className = "tool-summary-copy";
        const title = document.createElement("span");
        title.className = "tool-title";
        const preview = document.createElement("span");
        preview.className = "tool-preview";
        copy.append(title, preview);
        const state = document.createElement("span");
        state.className = "tool-state";
        const chevron = document.createElement("span");
        chevron.className = "tool-chevron";
        chevron.textContent = "⌄";
        summary.append(icon, copy, state, chevron);
        const body = document.createElement("div");
        body.className = "tool-detail-body";
        body.append(createToolSection("input", "调用信息"), createToolSection("output", "结果与输出"));
        const truncated = document.createElement("div");
        truncated.className = "tool-truncated";
        truncated.textContent = "内容过长，已保留开头和末尾。";
        body.append(truncated);
        details.append(summary, body);
        summary.addEventListener("click", (event) => {
            if (details.classList.contains("no-details")) event.preventDefault();
        });
        article.append(details);
        article.dataset.layout = "tool";
    }
    article.className = "timeline-item tool";
    const details = article.querySelector<HTMLDetailsElement>(".tool-card")!;
    details.className = `tool-card ${message.toolType ?? "generic"} ${activityStatusClass(message.status)}`;
    details.querySelector<HTMLElement>(".tool-icon")!.textContent = toolIcon(message.toolType);
    details.querySelector<HTMLElement>(".tool-title")!.textContent = message.title || "工具调用";
    details.querySelector<HTMLElement>(".tool-preview")!.textContent =
        message.text || (message.status === "inProgress" ? "等待结果…" : "查看详情");
    const state = details.querySelector<HTMLElement>(".tool-state")!;
    state.className = `tool-state ${activityStatusClass(message.status)}`;
    state.textContent = activityStatusLabel(message.status);

    const inputSection = details.querySelector<HTMLElement>('[data-tool-section="input"]')!;
    const outputSection = details.querySelector<HTMLElement>('[data-tool-section="output"]')!;
    inputSection.hidden = !message.input;
    outputSection.hidden = !message.output;
    inputSection.querySelector("pre")!.textContent = message.input ?? "";
    outputSection.querySelector("pre")!.textContent = message.output ?? "";
    const truncated = details.querySelector<HTMLElement>(".tool-truncated")!;
    truncated.hidden = !message.truncated;
    const hasDetails = Boolean(message.input || message.output || message.truncated);
    details.classList.toggle("no-details", !hasDetails);
    if (!hasDetails) details.open = false;
};

const renderMessages = (session?: CodexSession) => {
    const nextBlockId = session?.blockId ?? "";
    const sessionChanged = renderedBlockId !== nextBlockId;
    if (sessionChanged) {
        messageList.replaceChildren();
        renderedBlockId = nextBlockId;
    }
    const wasNearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 100;
    const messages = session?.messages ?? [];
    if (!session || messages.length === 0) {
        messageList.replaceChildren();
        messageList.hidden = true;
        emptyState.hidden = false;
        const title = emptyState.querySelector("h1");
        const text = emptyState.querySelector("p");
        if (session) {
            if (title) title.textContent = session.threadId ? "这段对话还没有消息" : "Codex 正在建立会话";
            if (text) {
                text.textContent = session.threadId
                    ? "你可以从这里发送第一条消息，桌面端 Codex TUI 会同步显示。"
                    : "完成 Codex 的会话选择后，这里会自动载入历史消息。";
            }
        } else {
            if (title) title.textContent = "从终端继续你的 Codex 对话";
            if (text)
                text.textContent = "在任意 Wave 终端运行 codex、codex resume 或 codex fork，对应会话会自动出现在这里。";
        }
        return;
    }
    emptyState.hidden = true;
    messageList.hidden = false;
    const existing = new Map<string, HTMLElement>();
    for (const child of Array.from(messageList.children)) {
        const article = child as HTMLElement;
        if (article.dataset.messageId) existing.set(article.dataset.messageId, article);
    }
    const retained = new Set<string>();
    messages.forEach((message, index) => {
        let article = existing.get(message.id);
        if (!article) {
            article = document.createElement("article");
        }
        retained.add(message.id);
        article.dataset.messageId = message.id;
        const kind = message.kind ?? "message";
        if (kind === "tool") {
            renderToolItem(article, message);
        } else if (kind === "reasoning" || kind === "plan") {
            renderNarrativeItem(article, message, kind);
        } else {
            renderConversationMessage(article, message);
        }
        const currentAtIndex = messageList.children.item(index);
        if (currentAtIndex !== article) messageList.insertBefore(article, currentAtIndex);
    });
    for (const [messageId, article] of existing) {
        if (!retained.has(messageId)) article.remove();
    }
    requestAnimationFrame(() => {
        if (sessionChanged || wasNearBottom) {
            chatScroll.scrollTop = chatScroll.scrollHeight;
        }
    });
};

const updateComposer = (session?: CodexSession) => {
    const ready = Boolean(session?.threadId);
    messageInput.disabled = !ready || sending;
    sendButton.disabled = !ready || sending || messageInput.value.trim() === "";
    messageInput.placeholder = ready ? "给 Codex 发送消息…" : "选择一个已就绪的 Codex 会话";
    interruptButton.hidden = !session?.activeTurnId;
    sessionError.hidden = !session?.error;
    sessionError.textContent = session?.error ?? "";
};

const render = () => {
    if (sessions.length > 0 && !selectedSession()) {
        selectedBlockId = sessions[0].blockId;
        localStorage.setItem("wave-codex-selected", selectedBlockId);
    }
    const selected = selectedSession();
    renderSessionList();
    if (selected) {
        conversationTitle.textContent = selected.title;
        const connection = selected.connection && selected.connection !== "local" ? selected.connection : "本机";
        conversationMeta.textContent = [connection, compactPath(selected.cwd)].filter(Boolean).join(" · ");
    } else {
        conversationTitle.textContent = "等待 Codex 会话";
        conversationMeta.textContent = "请先在 Wave 终端中运行 codex";
    }
    renderMessages(selected);
    updateComposer(selected);
};

const applySessions = (nextSessions?: RawCodexSession[] | null) => {
    sessions = (Array.isArray(nextSessions) ? nextSessions : []).map((session) => ({
        ...session,
        messages: Array.isArray(session.messages) ? session.messages : [],
    }));
    render();
};

const connectEvents = () => {
    eventSource?.close();
    connectionState.dataset.state = "connecting";
    connectionLabel.textContent = "连接中";
    eventSource = new EventSource("/api/events");
    eventSource.addEventListener("sessions", (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { sessions?: RawCodexSession[] | null };
        applySessions(payload.sessions);
        connectionState.dataset.state = "online";
        connectionLabel.textContent = "已同步";
    });
    eventSource.onerror = async () => {
        connectionState.dataset.state = "offline";
        connectionLabel.textContent = "重连中";
        if (checkingAuth) return;
        checkingAuth = true;
        try {
            const response = await api("/api/session");
            if (response.status === 401) showLogin();
        } catch {
            // EventSource will retry automatically while the service is unreachable.
        } finally {
            checkingAuth = false;
        }
    };
};

const showApp = () => {
    loginScreen.hidden = true;
    appShell.hidden = false;
    connectEvents();
};

const showLogin = () => {
    eventSource?.close();
    eventSource = null;
    appShell.hidden = true;
    loginScreen.hidden = false;
    requestAnimationFrame(() => accessToken.focus());
};

const autoSizeComposer = () => {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
    updateComposer(selectedSession());
};

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.textContent = "";
    let response: Response;
    try {
        response = await api("/api/login", {
            method: "POST",
            body: JSON.stringify({ token: accessToken.value }),
        });
    } catch {
        loginError.textContent = "无法连接到 Wave Codex 服务";
        return;
    }
    if (!response.ok) {
        loginError.textContent = await parseError(response);
        accessToken.select();
        return;
    }
    accessToken.value = "";
    showApp();
});

composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const session = selectedSession();
    const text = messageInput.value.trim();
    if (!session?.threadId || !text || sending) return;
    sending = true;
    updateComposer(session);
    let response: Response;
    try {
        response = await api(`/api/sessions/${encodeURIComponent(session.blockId)}/messages`, {
            method: "POST",
            body: JSON.stringify({ text }),
        });
    } catch {
        sending = false;
        updateComposer(selectedSession());
        sessionError.hidden = false;
        sessionError.textContent = "消息发送失败，请检查连接后重试";
        return;
    }
    sending = false;
    if (!response.ok) {
        updateComposer(selectedSession());
        sessionError.hidden = false;
        sessionError.textContent = await parseError(response);
        return;
    }
    messageInput.value = "";
    autoSizeComposer();
    messageInput.focus();
});

messageInput.addEventListener("input", autoSizeComposer);
messageInput.addEventListener("compositionstart", () => {
    composing = true;
});
messageInput.addEventListener("compositionend", () => {
    composing = false;
});
messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing) {
        event.preventDefault();
        composer.requestSubmit();
    }
});

interruptButton.addEventListener("click", async () => {
    const session = selectedSession();
    if (!session?.activeTurnId) return;
    let response: Response;
    try {
        response = await api(`/api/sessions/${encodeURIComponent(session.blockId)}/interrupt`, { method: "POST" });
    } catch {
        sessionError.hidden = false;
        sessionError.textContent = "停止请求发送失败，请检查连接后重试";
        return;
    }
    if (!response.ok) {
        sessionError.hidden = false;
        sessionError.textContent = await parseError(response);
    }
});

sessionSearch.addEventListener("input", renderSessionList);
getElement<HTMLButtonElement>("sidebar-open").addEventListener("click", openSidebar);
getElement<HTMLButtonElement>("sidebar-close").addEventListener("click", closeSidebar);
sidebarBackdrop.addEventListener("click", closeSidebar);
getElement<HTMLButtonElement>("logout").addEventListener("click", async () => {
    try {
        await api("/api/logout", { method: "POST" });
    } catch {
        // Clear local UI even if the server became unavailable.
    }
    sessions = [];
    showLogin();
});

const syncVisualViewport = () => {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    const offsetTop = viewport?.offsetTop ?? 0;
    document.documentElement.style.setProperty("--visual-height", `${Math.round(height)}px`);
    document.documentElement.style.setProperty("--visual-top", `${Math.round(offsetTop)}px`);
};

window.visualViewport?.addEventListener("resize", syncVisualViewport);
window.visualViewport?.addEventListener("scroll", syncVisualViewport);
window.addEventListener("resize", syncVisualViewport);
window.addEventListener("pageshow", syncVisualViewport);
syncVisualViewport();

void (async () => {
    try {
        const response = await api("/api/session");
        if (response.ok) {
            showApp();
        } else {
            showLogin();
        }
    } catch {
        showLogin();
        loginError.textContent = "无法连接到 Wave Codex 服务";
    }
})();
