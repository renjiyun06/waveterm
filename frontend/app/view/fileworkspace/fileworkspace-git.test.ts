// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    getGitFileStatus,
    getGitStatusForPath,
    getGitStatusKey,
    hasGitChangesForDirectory,
    isGitRepositoryRoot,
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
});
