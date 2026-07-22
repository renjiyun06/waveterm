// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const GitStatusKeySeparator = "\u0000";

export type FileWorkspaceGitStatus = GitStatusResponse & {
    workspaceRoot?: string;
};

export function normalizeGitPath(path: string): string {
    let normalized = (path ?? "").replace(/\\/g, "/");
    if (normalized !== "/" && !/^[a-zA-Z]:\/$/.test(normalized)) {
        normalized = normalized.replace(/\/+$/, "");
    }
    return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

export function getGitStatusKey(rootId: string, repositoryPath: string): string {
    return `${rootId}${GitStatusKeySeparator}${normalizeGitPath(repositoryPath)}`;
}

export function getGitStatusKeyPrefix(rootId: string): string {
    return `${rootId}${GitStatusKeySeparator}`;
}

export function getRootGitStatuses(
    statuses: Record<string, FileWorkspaceGitStatus>,
    rootId: string
): FileWorkspaceGitStatus[] {
    const prefix = getGitStatusKeyPrefix(rootId);
    return Object.entries(statuses)
        .filter(([key, status]) => key.startsWith(prefix) && status?.isrepo && status.root)
        .map(([, status]) => status);
}

function pathIsWithin(path: string, parent: string): boolean {
    const normalizedPath = normalizeGitPath(path);
    const normalizedParent = normalizeGitPath(parent);
    const descendantPrefix = normalizedParent.endsWith("/") ? normalizedParent : normalizedParent + "/";
    return normalizedPath === normalizedParent || normalizedPath.startsWith(descendantPrefix);
}

function joinGitPath(root: string, relativePath: string): string {
    const normalizedRoot = normalizeGitPath(root);
    const normalizedRelative = (relativePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalizedRelative) return normalizedRoot;
    return normalizedRoot === "/" ? `/${normalizedRelative}` : `${normalizedRoot}/${normalizedRelative}`;
}

function getGitStatusRoots(status: FileWorkspaceGitStatus | undefined): string[] {
    if (!status) return [];
    return Array.from(new Set([normalizeGitPath(status.root), normalizeGitPath(status.workspaceRoot)].filter(Boolean)));
}

function getGitFilePaths(status: FileWorkspaceGitStatus, file: GitFileStatus): string[] {
    const paths = [normalizeGitPath(file.abspath)];
    if (status.workspaceRoot && file.path) {
        paths.push(normalizeGitPath(joinGitPath(status.workspaceRoot, file.path)));
    }
    return Array.from(new Set(paths.filter(Boolean)));
}

export function withGitStatusWorkspaceRoot(status: GitStatusResponse, queriedPath: string): FileWorkspaceGitStatus {
    const repositoryRoot = normalizeGitPath(status.root);
    const resolvedPath = normalizeGitPath(status.resolvedpath);
    const workspacePath = normalizeGitPath(queriedPath);
    if (!repositoryRoot || !resolvedPath || !workspacePath || !pathIsWithin(resolvedPath, repositoryRoot)) {
        return status;
    }
    const repositoryPrefix = repositoryRoot.endsWith("/") ? repositoryRoot : repositoryRoot + "/";
    const relativePath = resolvedPath === repositoryRoot ? "" : resolvedPath.slice(repositoryPrefix.length);
    const suffix = relativePath ? `/${relativePath}` : "";
    if (suffix && !workspacePath.endsWith(suffix)) {
        return status;
    }
    let workspaceRoot = suffix ? workspacePath.slice(0, -suffix.length) : workspacePath;
    if (!workspaceRoot && workspacePath.startsWith("/")) {
        workspaceRoot = "/";
    } else if (/^[a-zA-Z]:$/.test(workspaceRoot)) {
        workspaceRoot += "/";
    }
    if (!workspaceRoot || workspaceRoot === repositoryRoot) {
        return status;
    }
    return { ...status, workspaceRoot };
}

export function getGitStatusForPath(
    statuses: Record<string, FileWorkspaceGitStatus>,
    rootId: string,
    path: string
): FileWorkspaceGitStatus | undefined {
    let closest: FileWorkspaceGitStatus | undefined;
    let closestRootLength = -1;
    for (const status of getRootGitStatuses(statuses, rootId)) {
        for (const repositoryRoot of getGitStatusRoots(status)) {
            if (!pathIsWithin(path, repositoryRoot)) continue;
            if (repositoryRoot.length > closestRootLength) {
                closest = status;
                closestRootLength = repositoryRoot.length;
            }
        }
    }
    return closest;
}

export function isGitRepositoryRoot(status: FileWorkspaceGitStatus | undefined, path: string): boolean {
    const normalizedPath = normalizeGitPath(path);
    return Boolean(status?.isrepo && getGitStatusRoots(status).some((root) => root === normalizedPath));
}

export function getGitFileStatus(status: FileWorkspaceGitStatus | undefined, path: string): string {
    const normalizedPath = normalizeGitPath(path);
    return status?.files?.find((file) => getGitFilePaths(status, file).includes(normalizedPath))?.status ?? "";
}

export function hasGitChangesForDirectory(
    statuses: Record<string, FileWorkspaceGitStatus>,
    rootId: string,
    path: string
): boolean {
    const normalizedPath = normalizeGitPath(path);
    const prefix = normalizedPath.endsWith("/") ? normalizedPath : normalizedPath + "/";
    for (const status of getRootGitStatuses(statuses, rootId)) {
        for (const repositoryRoot of getGitStatusRoots(status)) {
            if (status.dirty && (repositoryRoot === normalizedPath || repositoryRoot.startsWith(prefix))) {
                return true;
            }
            if (!pathIsWithin(path, repositoryRoot)) continue;
            if (
                status.files?.some((file) =>
                    getGitFilePaths(status, file).some(
                        (filePath) => filePath === normalizedPath || filePath.startsWith(prefix)
                    )
                )
            ) {
                return true;
            }
        }
    }
    return false;
}
