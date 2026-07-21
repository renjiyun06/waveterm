// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PreviewView } from "@/app/view/preview/preview";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useMemo, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
    getGitFileStatus,
    getGitStatusForPath,
    hasGitChangesForDirectory,
    isGitRepositoryRoot,
    normalizeGitPath,
} from "./fileworkspace-git";
import type { FileWorkspaceTab, FileWorkspaceViewModel } from "./fileworkspace-model";
import { getDirectoryKey } from "./fileworkspace-model";
import "./fileworkspace.scss";

function getStatusClass(status: string): string {
    if (status == "A") {
        return "text-green-400";
    }
    if (status == "D") {
        return "text-red-400";
    }
    if (status == "?") {
        return "text-sky-400";
    }
    return "text-amber-400";
}

const FileStatusBadge = memo(({ status }: { status: string }) => {
    if (!status) {
        return null;
    }
    return <span className={`ml-auto pl-2 text-[10px] font-bold ${getStatusClass(status)}`}>{status}</span>;
});
FileStatusBadge.displayName = "FileStatusBadge";

type DirectoryBranchProps = {
    model: FileWorkspaceViewModel;
    root: FileWorkspaceRoot;
    path: string;
    depth: number;
};

const DirectoryBranch = memo(({ model, root, path, depth }: DirectoryBranchProps) => {
    const directoryStates = useAtomValue(model.directoryStatesAtom);
    const expandedDirectories = useAtomValue(model.expandedDirectoriesAtom);
    const gitStatuses = useAtomValue(model.gitStatusesAtom);
    const selectedPath = useAtomValue(model.selectedPathAtom);
    const state = directoryStates[getDirectoryKey(root.id, path)];

    if (state?.loading && !state.entries.length) {
        return (
            <div className="px-3 py-1 text-[11px] text-secondary" style={{ paddingLeft: 22 + depth * 14 }}>
                Loading…
            </div>
        );
    }
    if (state?.error && !state.entries.length) {
        return (
            <div className="px-3 py-1 text-[11px] text-red-400" style={{ paddingLeft: 22 + depth * 14 }}>
                {state.error}
            </div>
        );
    }
    return (
        <>
            {(state?.entries ?? []).map((entry) => {
                const entryPath = entry.path;
                const entryKey = getDirectoryKey(root.id, entryPath);
                const expanded = expandedDirectories.includes(entryKey);
                const gitStatus = getGitStatusForPath(gitStatuses, root.id, entryPath);
                const repositoryRoot = entry.isdir && isGitRepositoryRoot(gitStatus, entryPath);
                const fileStatus = entry.isdir ? "" : getGitFileStatus(gitStatus, entryPath);
                const directoryDirty = entry.isdir && hasGitChangesForDirectory(gitStatuses, root.id, entryPath);
                const selected = selectedPath == entryPath;
                return (
                    <div key={entryPath}>
                        <button
                            type="button"
                            className={`group flex h-6 w-full items-center pr-2 text-left text-[12px] hover:bg-white/5 cursor-pointer ${
                                selected ? "bg-accent/15 text-primary" : "text-secondary"
                            }`}
                            style={{ paddingLeft: 8 + depth * 14 }}
                            onClick={() => {
                                if (entry.isdir) {
                                    fireAndForget(() => model.toggleDirectory(root, entryPath));
                                } else {
                                    fireAndForget(() => model.openFile(root, entry));
                                }
                            }}
                            title={entryPath}
                        >
                            <span className="flex w-4 shrink-0 items-center justify-center text-[9px]">
                                {entry.isdir && (
                                    <i className={`fa-sharp fa-solid fa-chevron-${expanded ? "down" : "right"}`} />
                                )}
                            </span>
                            <i
                                className={`mr-1.5 w-3.5 text-center fa-sharp fa-solid ${
                                    entry.isdir ? (expanded ? "fa-folder-open" : "fa-folder") : "fa-file"
                                } ${directoryDirty ? "text-amber-400" : "text-secondary"}`}
                            />
                            <span className="min-w-0 truncate">{entry.name || entry.path}</span>
                            {repositoryRoot && (
                                <span
                                    className="ml-2 max-w-24 truncate text-[10px] text-secondary"
                                    title={gitStatus?.branch || "HEAD"}
                                >
                                    <i className="fa-sharp fa-solid fa-code-branch mr-1" />
                                    {gitStatus?.branch || "HEAD"}
                                </span>
                            )}
                            {directoryDirty && (
                                <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                            )}
                            <FileStatusBadge status={fileStatus} />
                        </button>
                        {entry.isdir && expanded && (
                            <DirectoryBranch model={model} root={root} path={entryPath} depth={depth + 1} />
                        )}
                    </div>
                );
            })}
        </>
    );
});
DirectoryBranch.displayName = "DirectoryBranch";

const WorkspaceRoot = memo(({ model, root }: { model: FileWorkspaceViewModel; root: FileWorkspaceRoot }) => {
    const expandedDirectories = useAtomValue(model.expandedDirectoriesAtom);
    const gitStatuses = useAtomValue(model.gitStatusesAtom);
    const gitErrors = useAtomValue(model.gitErrorsAtom);
    const selectedRootId = useAtomValue(model.selectedRootIdAtom);
    const rootKey = getDirectoryKey(root.id, root.path);
    const expanded = expandedDirectories.includes(rootKey);
    const gitStatus = getGitStatusForPath(gitStatuses, root.id, root.path);
    const rootDirty = hasGitChangesForDirectory(gitStatuses, root.id, root.path);
    const gitError = gitErrors[getDirectoryKey(root.id, normalizeGitPath(root.path))];
    const selected = selectedRootId == root.id;

    return (
        <div className="border-b border-border/40 last:border-b-0">
            <div
                className={`group flex min-h-8 items-center px-2 text-[12px] ${
                    selected ? "bg-white/5" : "hover:bg-white/[0.03]"
                }`}
            >
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center text-left cursor-pointer"
                    onClick={() => {
                        fireAndForget(() => model.toggleDirectory(root, root.path));
                    }}
                    title={`${root.connection}:${root.path}`}
                >
                    <span className="flex w-4 shrink-0 items-center justify-center text-[9px]">
                        <i className={`fa-sharp fa-solid fa-chevron-${expanded ? "down" : "right"}`} />
                    </span>
                    <i className="fa-sharp fa-solid fa-folder-tree mr-1.5 text-accent" />
                    <span className="min-w-0 truncate font-medium text-primary">{root.name || root.path}</span>
                    {rootDirty && <span className="ml-2 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />}
                </button>
                {gitStatus?.isrepo && (
                    <span className="ml-2 max-w-24 truncate text-[10px] text-secondary" title={gitStatus.branch}>
                        <i className="fa-sharp fa-solid fa-code-branch mr-1" />
                        {gitStatus.branch || "HEAD"}
                    </span>
                )}
                <button
                    type="button"
                    className="ml-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-secondary hover:bg-white/10 hover:text-primary group-hover:flex cursor-pointer"
                    title="Remove folder from workspace"
                    onClick={() => fireAndForget(() => model.removeRoot(root.id))}
                >
                    <i className="fa-sharp fa-solid fa-xmark" />
                </button>
            </div>
            {gitError && (
                <div className="px-6 pb-1 text-[10px] text-red-400" title={gitError}>
                    Git status unavailable
                </div>
            )}
            {expanded && <DirectoryBranch model={model} root={root} path={root.path} depth={1} />}
        </div>
    );
});
WorkspaceRoot.displayName = "WorkspaceRoot";

const AddRootForm = memo(({ model }: { model: FileWorkspaceViewModel }) => {
    const connection = useAtomValue(model.connectionAtom);
    const path = useAtomValue(model.addRootPathAtom);
    const error = useAtomValue(model.addRootErrorAtom);
    const adding = useAtomValue(model.addingRootAtom);

    return (
        <div className="border-b border-border/60 bg-black/10 p-2">
            <div className="mb-1 text-[10px] text-secondary">Add a folder on {connection}</div>
            <div className="flex gap-1">
                <input
                    autoFocus
                    className="h-7 min-w-0 flex-1 rounded border border-border bg-black/20 px-2 text-[12px] text-primary outline-none focus:border-accent"
                    value={path}
                    placeholder="~/project"
                    onChange={(event) => model.setAddRootPath(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key == "Enter") {
                            fireAndForget(() => model.addRoot());
                        } else if (event.key == "Escape") {
                            model.closeAddRoot();
                        }
                    }}
                />
                <button
                    type="button"
                    className="rounded bg-accent/80 px-2 text-[11px] text-primary hover:bg-accent transition-colors cursor-pointer"
                    disabled={adding}
                    onClick={() => fireAndForget(() => model.addRoot())}
                >
                    {adding ? "Adding…" : "Add"}
                </button>
            </div>
            {error && <div className="mt-1 text-[10px] text-red-400">{error}</div>}
        </div>
    );
});
AddRootForm.displayName = "AddRootForm";

const ExplorerPane = memo(({ model }: { model: FileWorkspaceViewModel }) => {
    const roots = useAtomValue(model.activeRootsAtom);
    const connection = useAtomValue(model.connectionAtom);
    const addRootOpen = useAtomValue(model.addRootOpenAtom);

    return (
        <div className="flex h-full min-w-0 flex-col border-r border-border/60 bg-black/10">
            <div className="flex h-9 shrink-0 items-center border-b border-border/60 px-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-secondary">Folders</span>
                <span className="ml-2 min-w-0 truncate text-[10px] text-secondary">{connection}</span>
                <button
                    type="button"
                    className="ml-auto flex h-6 w-6 items-center justify-center rounded text-secondary hover:bg-white/10 hover:text-primary cursor-pointer"
                    title="Refresh folders and Git status"
                    onClick={() => fireAndForget(() => model.refreshForActiveConnection())}
                >
                    <i className="fa-sharp fa-solid fa-arrows-rotate" />
                </button>
                <button
                    type="button"
                    className="flex h-6 w-6 items-center justify-center rounded text-secondary hover:bg-white/10 hover:text-primary cursor-pointer"
                    title="Add folder"
                    onClick={() => model.toggleAddRoot()}
                >
                    <i className="fa-sharp fa-solid fa-folder-plus" />
                </button>
            </div>
            {addRootOpen && <AddRootForm model={model} />}
            <div className="min-h-0 flex-1 overflow-auto">
                {roots.length == 0 ? (
                    <div className="flex h-full flex-col items-center justify-center px-5 text-center text-secondary">
                        <i className="fa-sharp fa-solid fa-folder-open mb-2 text-2xl opacity-50" />
                        <div className="text-[12px]">No folders for {connection}</div>
                        <button
                            type="button"
                            className="mt-2 text-[11px] text-accent hover:underline cursor-pointer"
                            onClick={() => model.openAddRoot()}
                        >
                            Add a folder
                        </button>
                    </div>
                ) : (
                    roots.map((root) => <WorkspaceRoot key={root.id} model={model} root={root} />)
                )}
            </div>
        </div>
    );
});
ExplorerPane.displayName = "ExplorerPane";

type FileTabProps = {
    model: FileWorkspaceViewModel;
    tab: FileWorkspaceTab;
    active: boolean;
    dirty: boolean;
    gitStatus: string;
};

const FileTab = memo(({ model, tab, active, dirty, gitStatus }: FileTabProps) => {
    return (
        <div
            className={`group flex h-full min-w-28 max-w-56 shrink-0 items-center border-r border-border/50 ${
                active ? "bg-white/[0.08] text-primary" : "bg-black/10 text-secondary hover:bg-white/[0.04]"
            }`}
            title={tab.path}
        >
            <button
                type="button"
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 text-left cursor-pointer"
                onClick={() => fireAndForget(() => model.activateTab(tab.id))}
            >
                <i className="fa-sharp fa-solid fa-file-code shrink-0 text-[10px]" />
                <span className="min-w-0 flex-1 truncate text-[11px]">{tab.name}</span>
                {gitStatus && (
                    <span className={`shrink-0 text-[9px] font-bold ${getStatusClass(gitStatus)}`}>{gitStatus}</span>
                )}
                {dirty && (
                    <span className="shrink-0 text-[12px] leading-none text-amber-300" title="Unsaved changes">
                        ●
                    </span>
                )}
            </button>
            <button
                type="button"
                aria-label={`Close ${tab.name}`}
                className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] opacity-0 hover:bg-white/10 group-hover:opacity-100 cursor-pointer"
                onClick={(event) => {
                    event.stopPropagation();
                    fireAndForget(() => model.closeTab(tab.id));
                }}
            >
                <i className="fa-sharp fa-solid fa-xmark" />
            </button>
        </div>
    );
});
FileTab.displayName = "FileTab";

const FileTabs = memo(({ model }: { model: FileWorkspaceViewModel }) => {
    const tabs = useAtomValue(model.tabsAtom);
    const activeTabId = useAtomValue(model.activeTabIdAtom);
    const activeDraft = useAtomValue(model.previewModel.newFileContent);
    const activeGitStatus = useAtomValue(model.previewModel.gitFileStatusAtom);

    if (tabs.length == 0) {
        return null;
    }
    return (
        <div className="fileworkspace-tabs flex h-8 shrink-0 overflow-x-auto border-b border-border/60">
            {tabs.map((tab) => {
                const active = tab.id == activeTabId;
                return (
                    <FileTab
                        key={tab.id}
                        model={model}
                        tab={tab}
                        active={active}
                        dirty={active ? activeDraft != null : tab.draftContent != null}
                        gitStatus={active ? activeGitStatus : tab.gitFileStatus}
                    />
                );
            })}
        </div>
    );
});
FileTabs.displayName = "FileTabs";

const EditorPane = memo(
    ({ model, blockRef }: { model: FileWorkspaceViewModel; blockRef: React.RefObject<HTMLDivElement> }) => {
        const selectedPath = useAtomValue(model.selectedPathAtom);
        const activeTabId = useAtomValue(model.activeTabIdAtom);
        const newFileContent = useAtomValue(model.previewModel.newFileContent);
        const canPreview = useAtomValue(model.previewModel.canPreview);
        const editMode = useAtomValue(model.previewModel.editMode);
        const gitFileStatus = useAtomValue(model.previewModel.gitFileStatusAtom);
        const editorContentRef = useRef<HTMLDivElement>(null);

        if (!selectedPath) {
            return (
                <div className="flex h-full min-w-0 flex-col">
                    <FileTabs model={model} />
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-secondary">
                        <i className="fa-sharp fa-solid fa-file-code mb-3 text-3xl opacity-40" />
                        <div className="text-[12px]">Select a file to preview or edit</div>
                    </div>
                </div>
            );
        }
        return (
            <div className="flex h-full min-w-0 flex-col">
                <FileTabs model={model} />
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
                    <span className="min-w-0 flex-1 truncate text-[10px] text-secondary" title={selectedPath}>
                        {selectedPath}
                    </span>
                    {gitFileStatus && (
                        <span className={`text-[10px] font-bold ${getStatusClass(gitFileStatus)}`}>
                            {gitFileStatus}
                        </span>
                    )}
                    {newFileContent != null && (
                        <span className="text-[13px] text-amber-300" title="Unsaved changes">
                            ●
                        </span>
                    )}
                    {canPreview && (
                        <button
                            type="button"
                            className="rounded px-2 py-1 text-[10px] text-secondary hover:bg-white/10 hover:text-primary cursor-pointer"
                            onClick={() => fireAndForget(() => model.previewModel.setEditMode(!editMode))}
                        >
                            {editMode ? "Preview" : "Edit"}
                        </button>
                    )}
                    {newFileContent != null && (
                        <>
                            <button
                                type="button"
                                className="rounded px-2 py-1 text-[10px] text-secondary hover:bg-white/10 hover:text-primary cursor-pointer"
                                onClick={() => fireAndForget(() => model.previewModel.handleFileRevert())}
                            >
                                Revert
                            </button>
                            <button
                                type="button"
                                className="rounded bg-accent/80 px-2 py-1 text-[10px] text-primary hover:bg-accent transition-colors cursor-pointer"
                                onClick={() => fireAndForget(() => model.saveFile())}
                            >
                                Save
                            </button>
                        </>
                    )}
                </div>
                <div className="fileworkspace-preview min-h-0 flex-1">
                    <PreviewView
                        key={activeTabId}
                        blockId={model.blockId}
                        blockRef={blockRef}
                        contentRef={editorContentRef}
                        model={model.previewModel}
                    />
                </div>
            </div>
        );
    }
);
EditorPane.displayName = "EditorPane";

function FileWorkspaceView({ blockId, blockRef, model }: ViewComponentProps<FileWorkspaceViewModel>) {
    const connection = useAtomValue(model.connectionAtom);
    const roots = useAtomValue(model.activeRootsAtom);
    const explorerWidth = useAtomValue(model.explorerWidthAtom);
    const explorerLayoutVersion = useAtomValue(model.explorerLayoutVersionAtom);
    const rootsKey = useMemo(() => roots.map((root) => root.id).join(","), [roots]);

    useEffect(() => {
        fireAndForget(async () => {
            if (await model.handleConnectionChanged(connection)) {
                await model.refreshForActiveConnection();
            }
        });
    }, [connection, rootsKey]);

    return (
        <div
            data-fileworkspace={blockId}
            tabIndex={-1}
            className="fileworkspace-slide-in flex h-full w-full min-w-0 overflow-hidden outline-none"
        >
            <PanelGroup
                key={`${connection}:${explorerLayoutVersion}`}
                direction="horizontal"
                onLayout={(sizes) => model.setExplorerWidth(sizes[0])}
            >
                <Panel defaultSize={explorerWidth} minSize={16} maxSize={48}>
                    <ExplorerPane model={model} />
                </Panel>
                <PanelResizeHandle className="w-1 bg-transparent hover:bg-accent/30 transition-colors cursor-col-resize" />
                <Panel minSize={40}>
                    <EditorPane model={model} blockRef={blockRef} />
                </Panel>
            </PanelGroup>
        </div>
    );
}

export { FileWorkspaceView };
