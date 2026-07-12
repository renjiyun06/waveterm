// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildBlockTitleMeta, getBlockTitleMetaKey } from "./blocktitle";

describe("block titles", () => {
    it("uses header text for terminal-style headers", () => {
        expect(getBlockTitleMetaKey(true)).toBe("frame:text");
    });

    it("uses the frame title for standard block headers", () => {
        expect(getBlockTitleMetaKey(false)).toBe("frame:title");
    });

    it("trims custom titles and clears blank titles", () => {
        expect(buildBlockTitleMeta("frame:text", "  Backend  ")).toEqual({ "frame:text": "Backend" });
        expect(buildBlockTitleMeta("frame:title", "   ")).toEqual({ "frame:title": null });
    });
});
