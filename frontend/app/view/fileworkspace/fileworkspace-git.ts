// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const GitStatusKeySeparator = "\u0000";

export function normalizeGitPath(path: string): string {
    const normalized = (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

export function getGitStatusKey(rootId: string, repositoryPath: string): string {
    return `${rootId}${GitStatusKeySeparator}${normalizeGitPath(repositoryPath)}`;
}

export function getGitStatusKeyPrefix(rootId: string): string {
    return `${rootId}${GitStatusKeySeparator}`;
}

export function getRootGitStatuses(statuses: Record<string, GitStatusResponse>, rootId: string): GitStatusResponse[] {
    const prefix = getGitStatusKeyPrefix(rootId);
    return Object.entries(statuses)
        .filter(([key, status]) => key.startsWith(prefix) && status?.isrepo && status.root)
        .map(([, status]) => status);
}

function pathIsWithin(path: string, parent: string): boolean {
    const normalizedPath = normalizeGitPath(path);
    const normalizedParent = normalizeGitPath(parent);
    return normalizedPath === normalizedParent || normalizedPath.startsWith(normalizedParent + "/");
}

export function getGitStatusForPath(
    statuses: Record<string, GitStatusResponse>,
    rootId: string,
    path: string
): GitStatusResponse | undefined {
    let closest: GitStatusResponse | undefined;
    for (const status of getRootGitStatuses(statuses, rootId)) {
        if (!pathIsWithin(path, status.root)) continue;
        if (!closest || normalizeGitPath(status.root).length > normalizeGitPath(closest.root).length) {
            closest = status;
        }
    }
    return closest;
}

export function isGitRepositoryRoot(status: GitStatusResponse | undefined, path: string): boolean {
    return Boolean(status?.isrepo && normalizeGitPath(status.root) === normalizeGitPath(path));
}

export function getGitFileStatus(status: GitStatusResponse | undefined, path: string): string {
    const normalizedPath = normalizeGitPath(path);
    return status?.files?.find((file) => normalizeGitPath(file.abspath) === normalizedPath)?.status ?? "";
}

export function hasGitChangesForDirectory(
    statuses: Record<string, GitStatusResponse>,
    rootId: string,
    path: string
): boolean {
    const normalizedPath = normalizeGitPath(path);
    const prefix = normalizedPath + "/";
    for (const status of getRootGitStatuses(statuses, rootId)) {
        const repositoryRoot = normalizeGitPath(status.root);
        if (status.dirty && (repositoryRoot === normalizedPath || repositoryRoot.startsWith(prefix))) {
            return true;
        }
        if (!pathIsWithin(path, repositoryRoot)) continue;
        if (
            status.files?.some((file) => {
                const filePath = normalizeGitPath(file.abspath);
                return filePath === normalizedPath || filePath.startsWith(prefix);
            })
        ) {
            return true;
        }
    }
    return false;
}
