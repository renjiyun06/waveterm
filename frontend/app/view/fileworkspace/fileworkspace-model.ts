// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { PreviewModel } from "@/app/view/preview/preview-model";
import { fireAndForget, isBlank, makeConnRoute } from "@/util/util";
import { formatRemoteUri } from "@/util/waveutil";
import * as jotai from "jotai";
import { FileWorkspaceView } from "./fileworkspace";
import type { FileWorkspaceEnv } from "./fileworkspaceenv";

const GitRefreshIntervalMs = 3000;
const PersistStateDelayMs = 250;
const ExplorerDefaultWidth = 28;
const ExplorerMinWidth = 16;
const ExplorerMaxWidth = 48;

export type FileWorkspaceDirectoryState = {
    entries: FileInfo[];
    loading: boolean;
    error?: string;
};

export type FileWorkspaceTab = {
    id: string;
    rootId: string;
    connection: string;
    path: string;
    name: string;
    savedContent: string;
    draftContent: string;
    edit: boolean;
    gitDiffHunks: GitDiffHunk[];
    gitFileStatus: string;
};

function normalizeConnection(connection: string): string {
    return isBlank(connection) ? "local" : connection;
}

function getDirectoryKey(rootId: string, path: string): string {
    return `${rootId}:${path}`;
}

function getRootName(path: string): string {
    const normalized = path.replace(/[\\/]+$/, "");
    const parts = normalized.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

function clampExplorerWidth(width: number): number {
    if (width == null || !Number.isFinite(width)) {
        return ExplorerDefaultWidth;
    }
    return Math.min(ExplorerMaxWidth, Math.max(ExplorerMinWidth, width));
}

export class FileWorkspaceViewModel implements ViewModel {
    viewType = "fileworkspace";
    blockId: string;
    env: FileWorkspaceEnv;
    previewModel: PreviewModel;

    viewIcon = jotai.atom<string>("folder-tree");
    viewName = jotai.atom<string>("File Workspace");
    manageConnection = jotai.atom<boolean>(true);
    filterOutNowsh = jotai.atom<boolean>(true);
    noPadding = jotai.atom<boolean>(true);

    rootsAtom: jotai.Atom<FileWorkspaceRoot[]>;
    activeRootsAtom: jotai.Atom<FileWorkspaceRoot[]>;
    connectionAtom: jotai.Atom<string>;
    opacityAtom: jotai.Atom<number>;
    panelWidthAtom: jotai.Atom<number>;
    panelHeightAtom: jotai.Atom<number>;
    activeTabAtom: jotai.Atom<FileWorkspaceTab>;
    selectedRootIdAtom: jotai.Atom<string>;
    selectedPathAtom: jotai.Atom<string>;
    tabsAtom = jotai.atom<FileWorkspaceTab[]>([]);
    activeTabIdAtom = jotai.atom<string>("");
    explorerWidthAtom = jotai.atom<number>(ExplorerDefaultWidth);
    explorerLayoutVersionAtom = jotai.atom<number>(0);
    directoryStatesAtom = jotai.atom<Record<string, FileWorkspaceDirectoryState>>({});
    expandedDirectoriesAtom = jotai.atom<string[]>([]);
    gitStatusesAtom = jotai.atom<Record<string, GitStatusResponse>>({});
    gitErrorsAtom = jotai.atom<Record<string, string>>({});
    addRootOpenAtom = jotai.atom<boolean>(false);
    addRootPathAtom = jotai.atom<string>("~");
    addRootErrorAtom = jotai.atom<string>("");
    addingRootAtom = jotai.atom<boolean>(false);

    disposed = false;
    gitRefreshPending = false;
    gitPollTimer: ReturnType<typeof setInterval>;
    persistStateTimer: ReturnType<typeof setTimeout>;
    diffEpoch = 0;
    activeConnection: string;
    workspaceStates: FileWorkspaceState[] = [];

    constructor(initOpts: ViewModelInitType) {
        this.blockId = initOpts.blockId;
        this.env = initOpts.waveEnv;
        this.previewModel = new PreviewModel(initOpts);

        this.connectionAtom = jotai.atom((get) => {
            return normalizeConnection(get(this.env.getBlockMetaKeyAtom(this.blockId, "connection")));
        });
        this.rootsAtom = jotai.atom((get) => {
            const workspace = get(this.env.atoms.workspace);
            return workspace?.meta?.["fileworkspace:roots"] ?? [];
        });
        this.activeRootsAtom = jotai.atom((get) => {
            const connection = get(this.connectionAtom);
            return get(this.rootsAtom).filter((root) => normalizeConnection(root.connection) == connection);
        });
        this.activeTabAtom = jotai.atom((get) => {
            const activeTabId = get(this.activeTabIdAtom);
            return get(this.tabsAtom).find((tab) => tab.id == activeTabId);
        });
        this.selectedRootIdAtom = jotai.atom((get) => get(this.activeTabAtom)?.rootId ?? "");
        this.selectedPathAtom = jotai.atom((get) => get(this.activeTabAtom)?.path ?? "");
        this.opacityAtom = this.env.getSettingsKeyAtom("fileworkspace:opacity");
        this.panelWidthAtom = this.env.getSettingsKeyAtom("fileworkspace:width");
        this.panelHeightAtom = this.env.getSettingsKeyAtom("fileworkspace:height");

        const workspace = globalStore.get(this.env.atoms.workspace);
        this.workspaceStates = (workspace?.meta?.["fileworkspace:states"] ?? []).map((state) => ({
            ...state,
            expanded: [...(state.expanded ?? [])],
        }));
        this.activeConnection = globalStore.get(this.connectionAtom);
        this.restoreConnectionState(this.activeConnection);

        this.previewModel.onFileSaved = () => {
            this.captureActiveTab();
            fireAndForget(() => this.refreshGitStatuses());
        };
        this.gitPollTimer = setInterval(() => {
            fireAndForget(() => this.refreshGitStatuses());
        }, GitRefreshIntervalMs);
        setTimeout(() => {
            if (!this.disposed) {
                fireAndForget(() => this.refreshForActiveConnection());
            }
        }, 0);
    }

    get viewComponent(): ViewComponent {
        return FileWorkspaceView;
    }

    getCurrentConnection(): string {
        return globalStore.get(this.connectionAtom);
    }

    getRoots(): FileWorkspaceRoot[] {
        return globalStore.get(this.rootsAtom);
    }

    getActiveRoots(): FileWorkspaceRoot[] {
        return globalStore.get(this.activeRootsAtom);
    }

    getTabs(): FileWorkspaceTab[] {
        return globalStore.get(this.tabsAtom);
    }

    getActiveTab(): FileWorkspaceTab {
        return globalStore.get(this.activeTabAtom);
    }

    setAddRootPath(path: string) {
        globalStore.set(this.addRootPathAtom, path);
        globalStore.set(this.addRootErrorAtom, "");
    }

    openAddRoot() {
        globalStore.set(this.addRootOpenAtom, true);
        globalStore.set(this.addRootErrorAtom, "");
    }

    closeAddRoot() {
        globalStore.set(this.addRootOpenAtom, false);
        globalStore.set(this.addRootErrorAtom, "");
    }

    toggleAddRoot() {
        if (globalStore.get(this.addRootOpenAtom)) {
            this.closeAddRoot();
            return;
        }
        this.openAddRoot();
    }

    async persistRoots(roots: FileWorkspaceRoot[]) {
        const workspace = globalStore.get(this.env.atoms.workspace);
        if (!workspace?.oid) {
            throw new Error("No active workspace");
        }
        await this.env.rpc.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("workspace", workspace.oid),
            meta: { "fileworkspace:roots": roots },
        });
    }

    updateCachedConnectionState(connection: string, expanded?: string[], explorerWidth?: number) {
        const normalizedConnection = normalizeConnection(connection);
        const stateIndex = this.workspaceStates.findIndex(
            (state) => normalizeConnection(state.connection) == normalizedConnection
        );
        const currentState =
            stateIndex >= 0
                ? this.workspaceStates[stateIndex]
                : {
                      connection: normalizedConnection,
                      expanded: [],
                      explorerwidth: ExplorerDefaultWidth,
                  };
        const nextState: FileWorkspaceState = {
            ...currentState,
            connection: normalizedConnection,
            expanded: expanded != null ? [...expanded] : [...(currentState.expanded ?? [])],
            explorerwidth:
                explorerWidth != null
                    ? clampExplorerWidth(explorerWidth)
                    : clampExplorerWidth(currentState.explorerwidth),
        };
        if (stateIndex >= 0) {
            this.workspaceStates = this.workspaceStates.map((state, index) =>
                index == stateIndex ? nextState : state
            );
            return;
        }
        this.workspaceStates = [...this.workspaceStates, nextState];
    }

    schedulePersistWorkspaceStates() {
        if (this.persistStateTimer != null) {
            clearTimeout(this.persistStateTimer);
        }
        this.persistStateTimer = setTimeout(() => {
            this.persistStateTimer = null;
            fireAndForget(() => this.persistWorkspaceStates());
        }, PersistStateDelayMs);
    }

    async persistWorkspaceStates() {
        const workspace = globalStore.get(this.env.atoms.workspace);
        if (!workspace?.oid) {
            return;
        }
        await this.env.rpc.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("workspace", workspace.oid),
            meta: { "fileworkspace:states": this.workspaceStates },
        });
    }

    restoreConnectionState(connection: string) {
        const normalizedConnection = normalizeConnection(connection);
        const state = this.workspaceStates.find((item) => normalizeConnection(item.connection) == normalizedConnection);
        if (state != null) {
            globalStore.set(this.expandedDirectoriesAtom, [...(state.expanded ?? [])]);
            globalStore.set(this.explorerWidthAtom, clampExplorerWidth(state.explorerwidth));
            globalStore.set(this.explorerLayoutVersionAtom, (version) => version + 1);
            return;
        }
        const expanded = this.getRoots()
            .filter((root) => normalizeConnection(root.connection) == normalizedConnection)
            .map((root) => getDirectoryKey(root.id, root.path));
        globalStore.set(this.expandedDirectoriesAtom, expanded);
        globalStore.set(this.explorerWidthAtom, ExplorerDefaultWidth);
        globalStore.set(this.explorerLayoutVersionAtom, (version) => version + 1);
        this.updateCachedConnectionState(normalizedConnection, expanded, ExplorerDefaultWidth);
        this.schedulePersistWorkspaceStates();
    }

    setExplorerWidth(width: number) {
        const nextWidth = clampExplorerWidth(width);
        if (Math.abs(globalStore.get(this.explorerWidthAtom) - nextWidth) < 0.1) {
            return;
        }
        globalStore.set(this.explorerWidthAtom, nextWidth);
        this.updateCachedConnectionState(this.activeConnection, undefined, nextWidth);
        this.schedulePersistWorkspaceStates();
    }

    captureActiveTab() {
        const activeTab = this.getActiveTab();
        if (!activeTab) {
            return;
        }
        const nextTab: FileWorkspaceTab = {
            ...activeTab,
            savedContent: globalStore.get(this.previewModel.fileContentSaved),
            draftContent: globalStore.get(this.previewModel.newFileContent),
            edit: globalStore.get(this.previewModel.editMode),
            gitDiffHunks: globalStore.get(this.previewModel.gitDiffHunksAtom),
            gitFileStatus: globalStore.get(this.previewModel.gitFileStatusAtom),
        };
        globalStore.set(
            this.tabsAtom,
            this.getTabs().map((tab) => (tab.id == nextTab.id ? nextTab : tab))
        );
    }

    updateTab(tabId: string, update: Partial<FileWorkspaceTab>) {
        globalStore.set(
            this.tabsAtom,
            this.getTabs().map((tab) => (tab.id == tabId ? { ...tab, ...update } : tab))
        );
    }

    hasUnsavedTabs(): boolean {
        this.captureActiveTab();
        return this.getTabs().some((tab) => tab.draftContent != null);
    }

    async showTab(tab: FileWorkspaceTab) {
        await this.env.rpc.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: {
                connection: normalizeConnection(tab.connection),
                file: tab.path,
                edit: tab.edit,
            },
        });
        globalStore.set(this.activeTabIdAtom, tab.id);
        globalStore.set(this.previewModel.fileContentSaved, tab.savedContent);
        globalStore.set(this.previewModel.newFileContent, tab.draftContent);
        globalStore.set(this.previewModel.gitDiffHunksAtom, tab.gitDiffHunks ?? []);
        globalStore.set(this.previewModel.gitFileStatusAtom, tab.gitFileStatus ?? "");
        globalStore.set(this.previewModel.errorMsgAtom, null);
        await this.refreshSelectedFileDiff();
    }

    async activateTab(tabId: string) {
        if (globalStore.get(this.activeTabIdAtom) == tabId) {
            return;
        }
        this.captureActiveTab();
        const tab = this.getTabs().find((item) => item.id == tabId);
        if (!tab) {
            return;
        }
        await this.showTab(tab);
    }

    async clearTabs() {
        this.diffEpoch++;
        globalStore.set(this.tabsAtom, []);
        globalStore.set(this.activeTabIdAtom, "");
        globalStore.set(this.previewModel.fileContentSaved, null);
        globalStore.set(this.previewModel.newFileContent, null);
        globalStore.set(this.previewModel.gitDiffHunksAtom, []);
        globalStore.set(this.previewModel.gitFileStatusAtom, "");
        await this.env.rpc.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: { file: "", edit: false },
        });
    }

    async closeTab(tabId: string) {
        this.captureActiveTab();
        const tabs = this.getTabs();
        const tabIndex = tabs.findIndex((tab) => tab.id == tabId);
        if (tabIndex < 0) {
            return;
        }
        const tab = tabs[tabIndex];
        if (tab.draftContent != null && !window.confirm(`Discard unsaved changes in ${tab.name}?`)) {
            return;
        }
        const remainingTabs = tabs.filter((item) => item.id != tabId);
        globalStore.set(this.tabsAtom, remainingTabs);
        if (globalStore.get(this.activeTabIdAtom) != tabId) {
            return;
        }
        globalStore.set(this.activeTabIdAtom, "");
        const nextTab = remainingTabs[Math.min(tabIndex, remainingTabs.length - 1)];
        if (nextTab) {
            await this.showTab(nextTab);
            return;
        }
        await this.clearTabs();
    }

    async handleConnectionChanged(connection: string): Promise<boolean> {
        if (connection == this.activeConnection) {
            return true;
        }
        if (this.hasUnsavedTabs() && !window.confirm("Discard unsaved changes and switch connections?")) {
            await this.env.rpc.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
                meta: { connection: this.activeConnection },
            });
            return false;
        }
        this.activeConnection = connection;
        await this.clearTabs();
        this.restoreConnectionState(connection);
        return true;
    }

    async addRoot() {
        if (globalStore.get(this.addingRootAtom)) {
            return;
        }
        const inputPath = globalStore.get(this.addRootPathAtom).trim();
        if (!inputPath) {
            globalStore.set(this.addRootErrorAtom, "Enter a directory path");
            return;
        }
        globalStore.set(this.addingRootAtom, true);
        globalStore.set(this.addRootErrorAtom, "");
        try {
            const connection = this.getCurrentConnection();
            const fileInfo = await this.env.rpc.FileInfoCommand(TabRpcClient, {
                info: { path: formatRemoteUri(inputPath, connection) },
            });
            if (!fileInfo || fileInfo.notfound) {
                throw new Error("Directory not found");
            }
            if (!fileInfo.isdir) {
                throw new Error("Path is not a directory");
            }
            const canonicalPath = fileInfo.path;
            const roots = this.getRoots();
            const duplicate = roots.some(
                (root) => normalizeConnection(root.connection) == connection && root.path == canonicalPath
            );
            if (duplicate) {
                throw new Error("Directory is already in this workspace");
            }
            const root: FileWorkspaceRoot = {
                id: crypto.randomUUID(),
                connection,
                path: canonicalPath,
                name: fileInfo.name || getRootName(canonicalPath),
            };
            await this.persistRoots([...roots, root]);
            globalStore.set(this.addRootOpenAtom, false);
            globalStore.set(this.addRootPathAtom, "~");
            this.setDirectoryExpanded(root.id, root.path, true);
            await Promise.all([this.loadDirectory(root, root.path), this.refreshGitStatus(root)]);
        } catch (error) {
            globalStore.set(this.addRootErrorAtom, error instanceof Error ? error.message : String(error));
        } finally {
            globalStore.set(this.addingRootAtom, false);
        }
    }

    async removeRoot(rootId: string) {
        this.captureActiveTab();
        const roots = this.getRoots();
        const rootTabs = this.getTabs().filter((tab) => tab.rootId == rootId);
        if (
            rootTabs.some((tab) => tab.draftContent != null) &&
            !window.confirm("Discard unsaved changes and remove this folder?")
        ) {
            return;
        }

        const activeTabId = globalStore.get(this.activeTabIdAtom);
        const activeTabRemoved = rootTabs.some((tab) => tab.id == activeTabId);
        const remainingTabs = this.getTabs().filter((tab) => tab.rootId != rootId);
        globalStore.set(this.tabsAtom, remainingTabs);
        await this.persistRoots(roots.filter((root) => root.id != rootId));

        const rootPrefix = `${rootId}:`;
        const expanded = globalStore.get(this.expandedDirectoriesAtom).filter((key) => !key.startsWith(rootPrefix));
        globalStore.set(this.expandedDirectoriesAtom, expanded);
        this.updateCachedConnectionState(this.activeConnection, expanded);
        this.schedulePersistWorkspaceStates();

        if (activeTabRemoved) {
            globalStore.set(this.activeTabIdAtom, "");
            if (remainingTabs.length > 0) {
                await this.showTab(remainingTabs[remainingTabs.length - 1]);
            } else {
                await this.clearTabs();
            }
        }

        const statuses = { ...globalStore.get(this.gitStatusesAtom) };
        const errors = { ...globalStore.get(this.gitErrorsAtom) };
        delete statuses[rootId];
        delete errors[rootId];
        globalStore.set(this.gitStatusesAtom, statuses);
        globalStore.set(this.gitErrorsAtom, errors);
    }

    setDirectoryExpanded(rootId: string, path: string, expanded: boolean) {
        const key = getDirectoryKey(rootId, path);
        const expandedDirectories = new Set(globalStore.get(this.expandedDirectoriesAtom));
        if (expanded) {
            expandedDirectories.add(key);
        } else {
            expandedDirectories.delete(key);
        }
        const nextExpanded = Array.from(expandedDirectories);
        globalStore.set(this.expandedDirectoriesAtom, nextExpanded);
        this.updateCachedConnectionState(this.activeConnection, nextExpanded);
        this.schedulePersistWorkspaceStates();
    }

    async toggleDirectory(root: FileWorkspaceRoot, path: string) {
        const key = getDirectoryKey(root.id, path);
        const expandedDirectories = new Set(globalStore.get(this.expandedDirectoriesAtom));
        if (expandedDirectories.has(key)) {
            this.setDirectoryExpanded(root.id, path, false);
            return;
        }
        this.setDirectoryExpanded(root.id, path, true);
        await this.loadDirectory(root, path);
    }

    async loadDirectory(root: FileWorkspaceRoot, path: string, force = false) {
        const key = getDirectoryKey(root.id, path);
        const currentStates = globalStore.get(this.directoryStatesAtom);
        if (!force && (currentStates[key]?.loading || currentStates[key]?.entries)) {
            return;
        }
        globalStore.set(this.directoryStatesAtom, {
            ...currentStates,
            [key]: { entries: currentStates[key]?.entries ?? [], loading: true },
        });
        try {
            const entries = await this.env.rpc.FileListCommand(TabRpcClient, {
                path: formatRemoteUri(path, root.connection),
            });
            entries.sort((left, right) => {
                if (left.isdir != right.isdir) {
                    return left.isdir ? -1 : 1;
                }
                return (left.name || left.path).localeCompare(right.name || right.path);
            });
            const states = globalStore.get(this.directoryStatesAtom);
            globalStore.set(this.directoryStatesAtom, {
                ...states,
                [key]: { entries, loading: false },
            });
        } catch (error) {
            const states = globalStore.get(this.directoryStatesAtom);
            globalStore.set(this.directoryStatesAtom, {
                ...states,
                [key]: {
                    entries: states[key]?.entries ?? [],
                    loading: false,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }

    async openFile(root: FileWorkspaceRoot, fileInfo: FileInfo) {
        const connection = normalizeConnection(root.connection);
        const existingTab = this.getTabs().find(
            (tab) => normalizeConnection(tab.connection) == connection && tab.path == fileInfo.path
        );
        if (existingTab) {
            await this.activateTab(existingTab.id);
            return;
        }
        this.captureActiveTab();
        const tab: FileWorkspaceTab = {
            id: crypto.randomUUID(),
            rootId: root.id,
            connection,
            path: fileInfo.path,
            name: fileInfo.name || getRootName(fileInfo.path),
            savedContent: null,
            draftContent: null,
            edit: false,
            gitDiffHunks: [],
            gitFileStatus: "",
        };
        globalStore.set(this.tabsAtom, [...this.getTabs(), tab]);
        await this.showTab(tab);
    }

    async refreshGitStatus(root: FileWorkspaceRoot): Promise<GitStatusResponse | null> {
        try {
            const response = await this.env.rpc.RemoteGitStatusCommand(
                TabRpcClient,
                { path: root.path },
                { route: makeConnRoute(root.connection), timeout: 10000 }
            );
            if (this.disposed) {
                return response;
            }
            const statuses = { ...globalStore.get(this.gitStatusesAtom), [root.id]: response };
            const errors = { ...globalStore.get(this.gitErrorsAtom) };
            delete errors[root.id];
            globalStore.set(this.gitStatusesAtom, statuses);
            globalStore.set(this.gitErrorsAtom, errors);
            return response;
        } catch (error) {
            if (!this.disposed) {
                globalStore.set(this.gitErrorsAtom, {
                    ...globalStore.get(this.gitErrorsAtom),
                    [root.id]: error instanceof Error ? error.message : String(error),
                });
            }
            return null;
        }
    }

    async refreshGitStatuses() {
        if (this.gitRefreshPending || this.disposed) {
            return;
        }
        this.gitRefreshPending = true;
        try {
            await Promise.all(this.getActiveRoots().map((root) => this.refreshGitStatus(root)));
            if (globalStore.get(this.previewModel.newFileContent) == null) {
                await this.refreshSelectedFileDiff();
            }
        } finally {
            this.gitRefreshPending = false;
        }
    }

    async setOpacity(opacity: number) {
        const nextOpacity = Math.min(1, Math.max(0.2, opacity));
        await this.env.rpc.SetConfigCommand(TabRpcClient, {
            "fileworkspace:opacity": nextOpacity,
        });
    }

    async setPanelWidth(width: number) {
        const nextWidth = Math.min(1, Math.max(0.4, width));
        await this.env.rpc.SetConfigCommand(TabRpcClient, {
            "fileworkspace:width": nextWidth,
        });
    }

    async setPanelHeight(height: number) {
        const nextHeight = Math.min(1, Math.max(0.3, height));
        await this.env.rpc.SetConfigCommand(TabRpcClient, {
            "fileworkspace:height": nextHeight,
        });
    }

    async refreshSelectedFileDiff() {
        const activeTab = this.getActiveTab();
        const root = this.getRoots().find((item) => item.id == activeTab?.rootId);
        if (!root || !activeTab?.path) {
            globalStore.set(this.previewModel.gitDiffHunksAtom, []);
            globalStore.set(this.previewModel.gitFileStatusAtom, "");
            return;
        }
        const tabId = activeTab.id;
        const epoch = ++this.diffEpoch;
        try {
            const response = await this.env.rpc.RemoteGitFileDiffCommand(
                TabRpcClient,
                { path: activeTab.path },
                { route: makeConnRoute(root.connection), timeout: 10000 }
            );
            if (this.disposed || epoch != this.diffEpoch || globalStore.get(this.activeTabIdAtom) != tabId) {
                return;
            }
            const gitDiffHunks = response?.hunks ?? [];
            const gitFileStatus = response?.status ?? "";
            globalStore.set(this.previewModel.gitDiffHunksAtom, gitDiffHunks);
            globalStore.set(this.previewModel.gitFileStatusAtom, gitFileStatus);
            this.updateTab(tabId, { gitDiffHunks, gitFileStatus });
        } catch {
            if (!this.disposed && epoch == this.diffEpoch && globalStore.get(this.activeTabIdAtom) == tabId) {
                globalStore.set(this.previewModel.gitDiffHunksAtom, []);
                globalStore.set(this.previewModel.gitFileStatusAtom, "");
                this.updateTab(tabId, { gitDiffHunks: [], gitFileStatus: "" });
            }
        }
    }

    async refreshForActiveConnection() {
        const roots = this.getActiveRoots();
        const expandedDirectories = globalStore.get(this.expandedDirectoriesAtom);
        const directoryLoads: Promise<void>[] = [];
        for (const root of roots) {
            const prefix = `${root.id}:`;
            for (const key of expandedDirectories) {
                if (!key.startsWith(prefix)) {
                    continue;
                }
                directoryLoads.push(this.loadDirectory(root, key.slice(prefix.length)));
            }
        }
        await Promise.all([...directoryLoads, this.refreshGitStatuses()]);
    }

    async saveFile() {
        await this.previewModel.handleFileSave();
    }

    keyDownHandler(event: WaveKeyboardEvent): boolean {
        return this.previewModel.keyDownHandler(event);
    }

    nodeModelClose() {
        if (this.requestClose()) {
            this.previewModel.nodeModel.onClose();
        }
    }

    requestClose(): boolean {
        return !this.hasUnsavedTabs() || window.confirm("Discard unsaved changes and close the file workspace?");
    }

    giveFocus(): boolean {
        const container = document.querySelector<HTMLElement>(`[data-fileworkspace="${this.blockId}"]`);
        container?.focus();
        return container != null;
    }

    dispose() {
        this.disposed = true;
        clearInterval(this.gitPollTimer);
        if (this.persistStateTimer != null) {
            clearTimeout(this.persistStateTimer);
            this.persistStateTimer = null;
            fireAndForget(() => this.persistWorkspaceStates());
        }
    }
}

export { getDirectoryKey, normalizeConnection };
