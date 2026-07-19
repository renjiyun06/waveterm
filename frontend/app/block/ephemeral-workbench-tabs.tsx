// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WOS } from "@/app/store/global";
import { createEphemeralWorkbenchTab } from "@/app/store/keymodel";
import type { EphemeralSessionMode, LayoutNode, NodeModel } from "@/layout/index";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import * as util from "@/util/util";
import clsx from "clsx";
import * as jotai from "jotai";
import * as React from "react";

function getEphemeralWorkbenchTabLabel(
    block: Block | null | undefined,
    mode: EphemeralSessionMode,
    index: number
): string {
    const customTitle =
        mode === "terminal"
            ? (block?.meta?.["frame:text"] ?? block?.meta?.["frame:title"])
            : block?.meta?.["frame:title"];
    if (typeof customTitle === "string" && customTitle.trim()) {
        return customTitle.trim();
    }

    if (mode === "browser") {
        const url = block?.meta?.url;
        if (typeof url === "string" && url.trim()) {
            try {
                const parsedUrl = new URL(url);
                return parsedUrl.hostname.replace(/^www\./, "") || url;
            } catch {
                return url;
            }
        }
        return `Browser ${index + 1}`;
    }

    return `Terminal ${index + 1}`;
}

type EphemeralWorkbenchTabProps = {
    mode: EphemeralSessionMode;
    node: LayoutNode;
    index: number;
    active: boolean;
    canClose: boolean;
    onSelect: () => void;
    onClose: () => void;
};

const EphemeralWorkbenchTab = React.memo(
    ({ mode, node, index, active, canClose, onSelect, onClose }: EphemeralWorkbenchTabProps) => {
        const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", node.data.blockId));
        const block = jotai.useAtomValue(blockAtom);
        const label = getEphemeralWorkbenchTabLabel(block, mode, index);

        return (
            <div className={clsx("ephemeral-workbench-tab", active && "active")} role="tab" aria-selected={active}>
                <button type="button" className="ephemeral-workbench-tab-label" title={label} onClick={onSelect}>
                    <i className={util.makeIconClass(mode === "terminal" ? "terminal" : "globe", true)} />
                    <span>{label}</span>
                </button>
                <button
                    type="button"
                    className="ephemeral-workbench-tab-close"
                    aria-label={`Close ${label}`}
                    title={canClose ? "Close tab" : "At least one tab must remain"}
                    disabled={!canClose}
                    onClick={onClose}
                >
                    <i className={util.makeIconClass("xmark", true)} />
                </button>
            </div>
        );
    }
);
EphemeralWorkbenchTab.displayName = "EphemeralWorkbenchTab";

const EphemeralWorkbenchTabs = React.memo(({ nodeModel }: { nodeModel: NodeModel }) => {
    const mode = nodeModel.ephemeralSessionMode;
    const layoutModel = getLayoutModelForStaticTab();
    const nodesByMode = jotai.useAtomValue(layoutModel.ephemeralSessionNodes);
    const activeNode = jotai.useAtomValue(layoutModel.ephemeralNode);
    const [creating, setCreating] = React.useState(false);

    if (mode !== "terminal" && mode !== "browser") {
        return null;
    }

    const tabs = nodesByMode[mode] ?? [];
    const createTab = () => {
        if (creating) {
            return;
        }
        setCreating(true);
        util.fireAndForget(async () => {
            try {
                await createEphemeralWorkbenchTab(mode);
            } finally {
                setCreating(false);
            }
        });
    };

    return (
        <div
            className="ephemeral-workbench-tabs"
            role="tablist"
            aria-label={mode === "terminal" ? "Terminal tabs" : "Browser tabs"}
        >
            <div className="ephemeral-workbench-tabs-scroll">
                {tabs.map((tab, index) => (
                    <EphemeralWorkbenchTab
                        key={tab.id}
                        mode={mode}
                        node={tab}
                        index={index}
                        active={activeNode?.id === tab.id}
                        canClose={tabs.length > 1}
                        onSelect={() => layoutModel.showEphemeralSession(mode, tab.id)}
                        onClose={() => util.fireAndForget(() => layoutModel.closeEphemeralSessionNode(tab.id))}
                    />
                ))}
            </div>
            <button
                type="button"
                className="ephemeral-workbench-tab-new"
                aria-label={`New ${mode} tab`}
                title={`New ${mode} tab`}
                disabled={creating}
                onClick={createTab}
            >
                <i
                    className={clsx(
                        util.makeIconClass(creating ? "spinner-third" : "plus", true),
                        creating && "fa-spin"
                    )}
                />
            </button>
        </div>
    );
});
EphemeralWorkbenchTabs.displayName = "EphemeralWorkbenchTabs";

export { EphemeralWorkbenchTabs, getEphemeralWorkbenchTabLabel };
