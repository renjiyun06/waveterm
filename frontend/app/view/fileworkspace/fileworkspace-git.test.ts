// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    getGitFileStatus,
    getGitStatusForPath,
    getGitStatusKey,
    hasGitChangesForDirectory,
    isGitRepositoryRoot,
    normalizeGitPath,
    withGitStatusWorkspaceRoot,
} from "./fileworkspace-git";

const status = (root: string, files: GitFileStatus[] = []): GitStatusResponse => ({
    isrepo: true,
    dirty: files.length > 0,
    root,
    branch: "personal",
    files,
    ts: 1,
});

describe("file workspace Git repository mapping", () => {
    it("selects the nearest discovered repository for a path", () => {
        const outer = status("/work", [{ path: "project/a.txt", abspath: "/work/project/a.txt", status: "M" }]);
        const nested = status("/work/project", [{ path: "a.txt", abspath: "/work/project/a.txt", status: "?" }]);
        const statuses = {
            [getGitStatusKey("root-1", outer.root)]: outer,
            [getGitStatusKey("root-1", nested.root)]: nested,
            [getGitStatusKey("root-2", nested.root)]: status("/work/project"),
        };

        const selected = getGitStatusForPath(statuses, "root-1", "/work/project/a.txt");
        expect(selected).toBe(nested);
        expect(getGitFileStatus(selected, "/work/project/a.txt")).toBe("?");
        expect(isGitRepositoryRoot(selected, "/work/project")).toBe(true);
    });

    it("aggregates dirty nested repositories into a non-Git parent", () => {
        const nested = status("/workspace/waveterm", [
            { path: "main.go", abspath: "/workspace/waveterm/main.go", status: "M" },
        ]);
        const statuses = { [getGitStatusKey("root-1", nested.root)]: nested };

        expect(getGitStatusForPath(statuses, "root-1", "/workspace")).toBeUndefined();
        expect(hasGitChangesForDirectory(statuses, "root-1", "/workspace")).toBe(true);
        expect(hasGitChangesForDirectory(statuses, "root-1", "/workspace/other")).toBe(false);
    });

    it("matches Windows paths without case or separator differences", () => {
        const windows = status("C:/Users/Test/Repo", [
            { path: "src/a.ts", abspath: "C:/Users/Test/Repo/src/a.ts", status: "M" },
        ]);
        const statuses = { [getGitStatusKey("root-1", windows.root)]: windows };
        const selected = getGitStatusForPath(statuses, "root-1", "c:\\users\\test\\repo\\src\\a.ts");
        expect(selected).toBe(windows);
        expect(getGitFileStatus(selected, "c:\\users\\test\\repo\\src\\a.ts")).toBe("M");
    });

    it("preserves POSIX and Windows filesystem roots", () => {
        expect(normalizeGitPath("/")).toBe("/");
        expect(normalizeGitPath("C:\\")).toBe("c:/");

        const rootRepository = status("C:/", [{ path: "a.txt", abspath: "C:/a.txt", status: "M" }]);
        rootRepository.resolvedpath = "C:/src";
        const mapped = withGitStatusWorkspaceRoot(rootRepository, "c:\\src");
        const statuses = { [getGitStatusKey("root-1", mapped.root)]: mapped };
        expect(mapped.workspaceRoot).toBeUndefined();
        expect(getGitStatusForPath(statuses, "root-1", "c:\\a.txt")).toBe(mapped);
        expect(hasGitChangesForDirectory(statuses, "root-1", "c:\\")).toBe(true);
    });

    it("maps tilde workspace paths to the resolved repository path", () => {
        const resolved = status("/home/lamarck/aion/aperture", [
            {
                path: "workspace/projects/memory/workbench.json",
                abspath: "/home/lamarck/aion/aperture/workspace/projects/memory/workbench.json",
                status: "M",
            },
        ]);
        resolved.resolvedpath = "/home/lamarck/aion/aperture";
        const mapped = withGitStatusWorkspaceRoot(resolved, "~/aion/aperture");
        const statuses = { [getGitStatusKey("root-1", mapped.root)]: mapped };

        expect(mapped.workspaceRoot).toBe("~/aion/aperture");
        expect(getGitStatusForPath(statuses, "root-1", "~/aion/aperture")).toBe(mapped);
        expect(isGitRepositoryRoot(mapped, "~/aion/aperture")).toBe(true);
        expect(getGitFileStatus(mapped, "~/aion/aperture/workspace/projects/memory/workbench.json")).toBe("M");
        expect(hasGitChangesForDirectory(statuses, "root-1", "~/aion")).toBe(true);
    });

    it("derives the workspace repository root when probing a descendant", () => {
        const resolved = status("/home/lamarck/workspace/repo", [
            { path: "src/a.ts", abspath: "/home/lamarck/workspace/repo/src/a.ts", status: "M" },
        ]);
        resolved.resolvedpath = "/home/lamarck/workspace/repo/src";
        const mapped = withGitStatusWorkspaceRoot(resolved, "~/workspace/repo/src");

        expect(mapped.workspaceRoot).toBe("~/workspace/repo");
        expect(getGitFileStatus(mapped, "~/workspace/repo/src/a.ts")).toBe("M");
        expect(isGitRepositoryRoot(mapped, "~/workspace/repo")).toBe(true);
    });
});
