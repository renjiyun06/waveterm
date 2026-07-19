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

export type FileWorkspaceDirectoryState = {
    entries: FileInfo[];
    loading: boolean;
    error?: string;
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
    selectedRootIdAtom = jotai.atom<string>("");
    selectedPathAtom = jotai.atom<string>("");
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
    diffEpoch = 0;
    activeConnection: string;

    constructor(initOpts: ViewModelInitType) {
        this.blockId = initOpts.blockId;
        this.env = initOpts.waveEnv;
        this.previewModel = new PreviewModel(initOpts);
        this.previewModel.onFileSaved = () => {
            fireAndForget(() => this.refreshGitStatuses());
        };

        this.connectionAtom = jotai.atom((get) => {
            return normalizeConnection(get(this.env.getBlockMetaKeyAtom(this.blockId, "connection")));
        });
        this.activeConnection = globalStore.get(this.connectionAtom);
        this.opacityAtom = this.env.getSettingsKeyAtom("window:magnifiedblockopacity");
        this.rootsAtom = jotai.atom((get) => {
            const workspace = get(this.env.atoms.workspace);
            return workspace?.meta?.["fileworkspace:roots"] ?? [];
        });
        this.activeRootsAtom = jotai.atom((get) => {
            const connection = get(this.connectionAtom);
            return get(this.rootsAtom).filter((root) => normalizeConnection(root.connection) == connection);
        });
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
        } else {
            this.openAddRoot();
        }
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

    async handleConnectionChanged(connection: string): Promise<boolean> {
        if (connection == this.activeConnection) {
            return true;
        }
        if (!this.confirmDiscardUnsaved("Discard unsaved changes and switch connections?")) {
            await this.env.rpc.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
                meta: { connection: this.activeConnection },
            });
            return false;
        }
        this.activeConnection = connection;
        globalStore.set(this.selectedRootIdAtom, "");
        globalStore.set(this.selectedPathAtom, "");
        globalStore.set(this.previewModel.fileContentSaved, null);
        globalStore.set(this.previewModel.newFileContent, null);
        globalStore.set(this.previewModel.gitDiffHunksAtom, []);
        globalStore.set(this.previewModel.gitFileStatusAtom, "");
        await this.env.rpc.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: { file: "", edit: false },
        });
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
            globalStore.set(this.selectedRootIdAtom, root.id);
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
        const roots = this.getRoots();
        if (
            globalStore.get(this.selectedRootIdAtom) == rootId &&
            !this.confirmDiscardUnsaved("Discard unsaved changes and remove this folder?")
        ) {
            return;
        }
        await this.persistRoots(roots.filter((root) => root.id != rootId));
        if (globalStore.get(this.selectedRootIdAtom) == rootId) {
            globalStore.set(this.selectedRootIdAtom, "");
            globalStore.set(this.selectedPathAtom, "");
            globalStore.set(this.previewModel.gitDiffHunksAtom, []);
            globalStore.set(this.previewModel.gitFileStatusAtom, "");
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
        globalStore.set(this.expandedDirectoriesAtom, Array.from(expandedDirectories));
    }

    async toggleDirectory(root: FileWorkspaceRoot, path: string) {
        const key = getDirectoryKey(root.id, path);
        const expandedDirectories = new Set(globalStore.get(this.expandedDirectoriesAtom));
        if (expandedDirectories.has(key)) {
            expandedDirectories.delete(key);
            globalStore.set(this.expandedDirectoriesAtom, Array.from(expandedDirectories));
            return;
        }
        expandedDirectories.add(key);
        globalStore.set(this.expandedDirectoriesAtom, Array.from(expandedDirectories));
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
                opts: { all: true },
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
        const selectedPath = globalStore.get(this.selectedPathAtom);
        if (selectedPath == fileInfo.path) {
            return;
        }
        if (!this.confirmDiscardUnsaved("Discard unsaved changes and open another file?")) {
            return;
        }
        globalStore.set(this.selectedRootIdAtom, root.id);
        globalStore.set(this.selectedPathAtom, fileInfo.path);
        globalStore.set(this.previewModel.fileContentSaved, null);
        globalStore.set(this.previewModel.newFileContent, null);
        globalStore.set(this.previewModel.gitDiffHunksAtom, []);
        globalStore.set(this.previewModel.gitFileStatusAtom, "");
        await this.env.rpc.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: {
                connection: normalizeConnection(root.connection),
                file: fileInfo.path,
                edit: false,
            },
        });
        await this.refreshSelectedFileDiff();
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
            "window:magnifiedblockopacity": nextOpacity,
        });
    }

    async refreshSelectedFileDiff() {
        const selectedPath = globalStore.get(this.selectedPathAtom);
        const selectedRootId = globalStore.get(this.selectedRootIdAtom);
        const root = this.getRoots().find((item) => item.id == selectedRootId);
        if (!root || !selectedPath) {
            globalStore.set(this.previewModel.gitDiffHunksAtom, []);
            globalStore.set(this.previewModel.gitFileStatusAtom, "");
            return;
        }
        const epoch = ++this.diffEpoch;
        try {
            const response = await this.env.rpc.RemoteGitFileDiffCommand(
                TabRpcClient,
                { path: selectedPath },
                { route: makeConnRoute(root.connection), timeout: 10000 }
            );
            if (this.disposed || epoch != this.diffEpoch) {
                return;
            }
            globalStore.set(this.previewModel.gitDiffHunksAtom, response?.hunks ?? []);
            globalStore.set(this.previewModel.gitFileStatusAtom, response?.status ?? "");
        } catch {
            if (!this.disposed && epoch == this.diffEpoch) {
                globalStore.set(this.previewModel.gitDiffHunksAtom, []);
                globalStore.set(this.previewModel.gitFileStatusAtom, "");
            }
        }
    }

    async refreshForActiveConnection() {
        const roots = this.getActiveRoots();
        const expandedDirectories = new Set(globalStore.get(this.expandedDirectoriesAtom));
        for (const root of roots) {
            const key = getDirectoryKey(root.id, root.path);
            if (!expandedDirectories.has(key)) {
                expandedDirectories.add(key);
            }
        }
        globalStore.set(this.expandedDirectoriesAtom, Array.from(expandedDirectories));
        await Promise.all([...roots.map((root) => this.loadDirectory(root, root.path)), this.refreshGitStatuses()]);
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

    confirmDiscardUnsaved(message: string): boolean {
        return globalStore.get(this.previewModel.newFileContent) == null || window.confirm(message);
    }

    requestClose(): boolean {
        return this.confirmDiscardUnsaved("Discard unsaved changes and close the file workspace?");
    }

    giveFocus(): boolean {
        const container = document.querySelector<HTMLElement>(`[data-fileworkspace="${this.blockId}"]`);
        container?.focus();
        return container != null;
    }

    dispose() {
        this.disposed = true;
        clearInterval(this.gitPollTimer);
    }
}

export { getDirectoryKey, normalizeConnection };
