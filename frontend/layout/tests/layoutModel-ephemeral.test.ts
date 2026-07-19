// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, createStore } from "jotai";
import { describe, expect, test } from "vitest";
import { LayoutModel } from "../lib/layoutModel";

function makeLayoutModel(onDelete?: (data: TabLayoutData) => Promise<void>): {
    layoutModel: LayoutModel;
    store: ReturnType<typeof createStore>;
} {
    const store = createStore();
    const tabAtom = atom({
        oid: "tab-test",
        layoutstate: "layout-test",
        blockids: [],
    } as Tab);
    return {
        layoutModel: new LayoutModel(tabAtom, store.get, store.set, undefined, undefined, onDelete),
        store,
    };
}

describe("ephemeral workbench tabs", () => {
    test("keeps multiple nodes per mode and remembers the selected tab", () => {
        const { layoutModel, store } = makeLayoutModel();
        const firstTerminal = layoutModel.newEphemeralSessionNode("term-1", "terminal", "top", "term", false);
        const secondTerminal = layoutModel.newEphemeralSessionNode("term-2", "terminal", "top", "term", false);
        const browser = layoutModel.newEphemeralSessionNode("web-1", "browser", "top", "web", false);

        expect(layoutModel.getEphemeralSessionNodes("terminal")).toEqual([firstTerminal, secondTerminal]);
        expect(layoutModel.isEphemeralSessionBlock("term-2")).toBe(true);

        expect(layoutModel.showEphemeralSession("terminal", firstTerminal.id)).toBe(true);
        expect(store.get(layoutModel.ephemeralNode)?.id).toBe(firstTerminal.id);
        expect(layoutModel.showEphemeralSession("browser", browser.id)).toBe(true);
        expect(layoutModel.showEphemeralSession("terminal")).toBe(true);
        expect(store.get(layoutModel.ephemeralNode)?.id).toBe(firstTerminal.id);
    });

    test("closes an active tab, selects its neighbor, and preserves the final tab", async () => {
        const deletedBlockIds: string[] = [];
        const { layoutModel, store } = makeLayoutModel(async (data) => {
            deletedBlockIds.push(data.blockId);
        });
        const firstTerminal = layoutModel.newEphemeralSessionNode("term-1", "terminal", "top", "term", false);
        const secondTerminal = layoutModel.newEphemeralSessionNode("term-2", "terminal", "top", "term", false);
        layoutModel.showEphemeralSession("terminal", firstTerminal.id);

        await expect(layoutModel.closeEphemeralSessionNode(firstTerminal.id)).resolves.toBe(true);
        expect(layoutModel.getEphemeralSessionNodes("terminal")).toEqual([secondTerminal]);
        expect(store.get(layoutModel.ephemeralNode)?.id).toBe(secondTerminal.id);
        expect(deletedBlockIds).toEqual(["term-1"]);

        await expect(layoutModel.closeEphemeralSessionNode(secondTerminal.id)).resolves.toBe(false);
        expect(layoutModel.getEphemeralSessionNodes("terminal")).toEqual([secondTerminal]);
        expect(deletedBlockIds).toEqual(["term-1"]);
    });
});
