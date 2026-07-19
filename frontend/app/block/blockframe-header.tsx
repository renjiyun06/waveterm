// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getBlockTitleMetaKey } from "@/app/block/blocktitle";
import {
    blockViewToIcon,
    blockViewToName,
    getViewIconElem,
    OptMagnifyButton,
    renderHeaderElements,
} from "@/app/block/blockutil";
import { ConnectionButton } from "@/app/block/connectionbutton";
import { DurableSessionFlyover } from "@/app/block/durable-session-flyover";
import { Popover, PopoverButton, PopoverContent } from "@/app/element/popover";
import { getBlockBadgeAtom } from "@/app/store/badge";
import {
    createBlockSplitHorizontally,
    createBlockSplitVertically,
    recordTEvent,
    refocusNode,
    WOS,
} from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { switchEphemeralWorkbenchMode, uxCloseBlock } from "@/app/store/keymodel";
import { modalsModel } from "@/app/store/modalmodel";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { IconButton } from "@/element/iconbutton";
import type { EphemeralSessionMode } from "@/layout/index";
import { NodeModel } from "@/layout/index";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import * as util from "@/util/util";
import { cn, makeIconClass } from "@/util/util";
import { flip, shift } from "@floating-ui/react";
import * as jotai from "jotai";
import * as React from "react";
import { BlockEnv } from "./blockenv";
import { BlockFrameProps } from "./blocktypes";

function handleHeaderContextMenu(
    e: React.MouseEvent<HTMLDivElement>,
    blockId: string,
    viewModel: ViewModel,
    nodeModel: NodeModel,
    blockEnv: BlockEnv
) {
    e.preventDefault();
    e.stopPropagation();
    const magnified = globalStore.get(nodeModel.isMagnified);
    const ephemeralSession = globalStore.get(nodeModel.isEphemeralSession);
    const useTermHeader = viewModel?.useTermHeader ? globalStore.get(viewModel.useTermHeader) : false;
    const titleKey = getBlockTitleMetaKey(useTermHeader);
    const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
    const blockData = globalStore.get(blockAtom);
    const currentTitle = blockData?.meta?.[titleKey];
    const menu: ContextMenuItem[] = [
        {
            label: "Rename Block",
            click: () => {
                modalsModel.pushModal("RenameBlockModal", {
                    blockId,
                    currentTitle: typeof currentTitle === "string" ? currentTitle : "",
                    titleKey,
                });
            },
        },
    ];
    if (!ephemeralSession) {
        menu.push(
            {
                label: magnified ? "Un-Magnify Block" : "Magnify Block",
                click: () => {
                    nodeModel.toggleMagnify();
                },
            },
            { type: "separator" }
        );
    }
    menu.push({
        label: "Copy BlockId",
        click: () => {
            navigator.clipboard.writeText(blockId);
        },
    });
    let extraItems = viewModel
        ?.getSettingsMenuItems?.()
        ?.filter(
            (item) => !ephemeralSession || (item.label !== "Split Horizontally" && item.label !== "Split Vertically")
        );
    if (ephemeralSession) {
        extraItems = extraItems?.slice();
        while (extraItems?.[0]?.type === "separator") {
            extraItems.shift();
        }
    }
    if (extraItems && extraItems.length > 0) menu.push({ type: "separator" }, ...extraItems);
    menu.push(
        { type: "separator" },
        {
            label: "Close Block",
            click: () => uxCloseBlock(blockId),
        }
    );
    blockEnv.showContextMenu(menu, e);
}

type HeaderTextElemsProps = {
    viewModel: ViewModel;
    blockId: string;
    preview: boolean;
    error?: Error;
};

const HeaderTextElems = React.memo(({ viewModel, blockId, preview, error }: HeaderTextElemsProps) => {
    const waveEnv = useWaveEnv<BlockEnv>();
    const frameTextAtom = waveEnv.getBlockMetaKeyAtom(blockId, "frame:text");
    const frameText = jotai.useAtomValue(frameTextAtom);
    let headerTextUnion = util.useAtomValueSafe(viewModel?.viewText);
    headerTextUnion = frameText ?? headerTextUnion;

    const headerTextElems: React.ReactElement[] = [];
    if (typeof headerTextUnion === "string") {
        if (!util.isBlank(headerTextUnion)) {
            headerTextElems.push(
                <div key="text" className="block-frame-text ellipsis">
                    &lrm;{headerTextUnion}
                </div>
            );
        }
    } else if (Array.isArray(headerTextUnion)) {
        headerTextElems.push(...renderHeaderElements(headerTextUnion, preview));
    }
    if (error != null) {
        const copyHeaderErr = () => {
            navigator.clipboard.writeText(error.message + "\n" + error.stack);
        };
        headerTextElems.push(
            <div className="iconbutton disabled" key="controller-status" onClick={copyHeaderErr}>
                <i
                    className="fa-sharp fa-solid fa-triangle-exclamation"
                    title={"Error Rendering View Header: " + error.message}
                />
            </div>
        );
    }

    return <div className="block-frame-textelems-wrapper">{headerTextElems}</div>;
});
HeaderTextElems.displayName = "HeaderTextElems";

const ephemeralModes: Array<{
    mode: EphemeralSessionMode;
    label: string;
    icon: string;
}> = [
    { mode: "files", label: "Files", icon: "folder-tree" },
    { mode: "terminal", label: "Terminal", icon: "terminal" },
    { mode: "browser", label: "Browser", icon: "globe" },
];

const EphemeralModeSwitcher = React.memo(({ nodeModel }: { nodeModel: NodeModel }) => {
    const activeMode = nodeModel.ephemeralSessionMode;
    return (
        <div className="ephemeral-workbench-mode-switcher" role="tablist" aria-label="Workbench mode">
            {ephemeralModes.map(({ mode, label, icon }) => (
                <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={activeMode === mode}
                    className={cn("ephemeral-workbench-mode", activeMode === mode && "active")}
                    title={label}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        util.fireAndForget(() => switchEphemeralWorkbenchMode(mode));
                    }}
                >
                    <i className={makeIconClass(icon, true)} />
                    <span>{label}</span>
                </button>
            ))}
        </div>
    );
});
EphemeralModeSwitcher.displayName = "EphemeralModeSwitcher";

type WorkbenchSettingSliderProps = {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    deferPointerCommit?: boolean;
    onChange: (value: number) => void;
};

const WorkbenchSettingSlider = React.memo(
    ({ label, value, min, max, step, deferPointerCommit = false, onChange }: WorkbenchSettingSliderProps) => {
        const [draftValue, setDraftValue] = React.useState(value);
        const pointerActiveRef = React.useRef(false);

        React.useEffect(() => {
            if (!pointerActiveRef.current) {
                setDraftValue(value);
            }
        }, [value]);

        const commitPointerValue = (element: HTMLInputElement) => {
            if (!deferPointerCommit || !pointerActiveRef.current) {
                return;
            }
            pointerActiveRef.current = false;
            onChange(Number(element.value));
        };

        return (
            <label className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2 text-[11px] text-secondary">
                <span>{label}</span>
                <input
                    aria-label={label}
                    className="ephemeral-workbench-setting-slider min-w-0 cursor-pointer"
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={draftValue}
                    onPointerDown={(event) => {
                        event.stopPropagation();
                        if (deferPointerCommit) {
                            pointerActiveRef.current = true;
                            event.currentTarget.setPointerCapture?.(event.pointerId);
                        }
                    }}
                    onPointerUp={(event) => commitPointerValue(event.currentTarget)}
                    onPointerCancel={() => {
                        pointerActiveRef.current = false;
                        setDraftValue(value);
                    }}
                    onBlur={(event) => commitPointerValue(event.currentTarget)}
                    onChange={(event) => {
                        const nextValue = Number(event.target.value);
                        setDraftValue(nextValue);
                        if (!deferPointerCommit || !pointerActiveRef.current) {
                            onChange(nextValue);
                        }
                    }}
                />
                <span className="text-right tabular-nums text-primary">{Math.round(draftValue * 100)}%</span>
            </label>
        );
    }
);
WorkbenchSettingSlider.displayName = "WorkbenchSettingSlider";

type WorkbenchSettingKey = "fileworkspace:opacity" | "fileworkspace:width" | "fileworkspace:height";

const WorkbenchAppearanceSettings = React.memo(() => {
    const blockEnv = useWaveEnv<BlockEnv>();
    const opacity = jotai.useAtomValue(blockEnv.getSettingsKeyAtom("fileworkspace:opacity")) ?? 0.9;
    const panelWidth = jotai.useAtomValue(blockEnv.getSettingsKeyAtom("fileworkspace:width")) ?? 1;
    const panelHeight = jotai.useAtomValue(blockEnv.getSettingsKeyAtom("fileworkspace:height")) ?? 0.78;

    React.useEffect(() => {
        getLayoutModelForStaticTab()?.updateTree(false);
    }, [panelWidth, panelHeight]);

    const setWorkbenchSetting = (key: WorkbenchSettingKey, value: number) => {
        const settings: SettingsType = { [key]: value };
        util.fireAndForget(() => blockEnv.rpc.SetConfigCommand(TabRpcClient, settings));
    };

    return (
        <Popover placement="bottom-end" middleware={[flip({ padding: 8 }), shift({ padding: 8 })]}>
            <PopoverButton
                className="ghost grey !flex !h-6 !w-6 !items-center !justify-center !p-0 cursor-pointer"
                title="Workbench appearance"
                aria-label="Workbench appearance"
                onPointerDown={(event) => event.stopPropagation()}
            >
                <i className="fa-sharp fa-solid fa-sliders" />
            </PopoverButton>
            <PopoverContent
                className="ephemeral-workbench-settings-popover"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="mb-3 text-[11px] font-semibold text-primary">Workbench appearance</div>
                <div className="flex flex-col gap-3">
                    <WorkbenchSettingSlider
                        label="Opacity"
                        value={opacity}
                        min={0.2}
                        max={1}
                        step={0.05}
                        onChange={(value) => setWorkbenchSetting("fileworkspace:opacity", value)}
                    />
                    <WorkbenchSettingSlider
                        label="Width"
                        value={panelWidth}
                        min={0.4}
                        max={1}
                        step={0.05}
                        deferPointerCommit={true}
                        onChange={(value) => setWorkbenchSetting("fileworkspace:width", value)}
                    />
                    <WorkbenchSettingSlider
                        label="Height"
                        value={panelHeight}
                        min={0.3}
                        max={1}
                        step={0.05}
                        onChange={(value) => setWorkbenchSetting("fileworkspace:height", value)}
                    />
                </div>
            </PopoverContent>
        </Popover>
    );
});
WorkbenchAppearanceSettings.displayName = "WorkbenchAppearanceSettings";

type HeaderEndIconsProps = {
    viewModel: ViewModel;
    nodeModel: NodeModel;
    blockId: string;
};

const HeaderEndIcons = React.memo(({ viewModel, nodeModel, blockId }: HeaderEndIconsProps) => {
    const blockEnv = useWaveEnv<BlockEnv>();
    const endIconButtons = util.useAtomValueSafe(viewModel?.endIconButtons);
    const magnified = jotai.useAtomValue(nodeModel.isMagnified);
    const ephemeral = jotai.useAtomValue(nodeModel.isEphemeral);
    const ephemeralSession = jotai.useAtomValue(nodeModel.isEphemeralSession);
    const numLeafs = jotai.useAtomValue(nodeModel.numLeafs);
    const magnifyDisabled = numLeafs <= 1;
    const showSplitButtons = jotai.useAtomValue(blockEnv.getSettingsKeyAtom("term:showsplitbuttons"));

    const endIconsElem: React.ReactElement[] = [];

    if (endIconButtons && endIconButtons.length > 0) {
        endIconsElem.push(...endIconButtons.map((button, idx) => <IconButton key={idx} decl={button} />));
    }
    if (showSplitButtons && viewModel?.viewType === "term" && !ephemeralSession) {
        const splitHorizontalDecl: IconButtonDecl = {
            elemtype: "iconbutton",
            icon: "columns",
            title: "Split Horizontally",
            click: (e) => {
                e.stopPropagation();
                const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
                const blockData = globalStore.get(blockAtom);
                const blockDef: BlockDef = {
                    meta: blockData?.meta || { view: "term", controller: "shell" },
                };
                createBlockSplitHorizontally(blockDef, blockId, "after");
            },
        };
        const splitVerticalDecl: IconButtonDecl = {
            elemtype: "iconbutton",
            icon: "grip-lines",
            title: "Split Vertically",
            click: (e) => {
                e.stopPropagation();
                const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
                const blockData = globalStore.get(blockAtom);
                const blockDef: BlockDef = {
                    meta: blockData?.meta || { view: "term", controller: "shell" },
                };
                createBlockSplitVertically(blockDef, blockId, "after");
            },
        };
        endIconsElem.push(<IconButton key="split-horizontal" decl={splitHorizontalDecl} />);
        endIconsElem.push(<IconButton key="split-vertical" decl={splitVerticalDecl} />);
    }
    if (ephemeralSession) {
        endIconsElem.push(<EphemeralModeSwitcher key="workbench-modes" nodeModel={nodeModel} />);
        endIconsElem.push(<WorkbenchAppearanceSettings key="workbench-appearance" />);
    }
    const settingsDecl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "cog",
        title: "Settings",
        click: (e) => handleHeaderContextMenu(e, blockId, viewModel, nodeModel, blockEnv),
    };
    endIconsElem.push(<IconButton key="settings" decl={settingsDecl} className="block-frame-settings" />);
    if (!ephemeralSession) {
        if (ephemeral) {
            const addToLayoutDecl: IconButtonDecl = {
                elemtype: "iconbutton",
                icon: "circle-plus",
                title: "Add to Layout",
                click: () => {
                    nodeModel.addEphemeralNodeToLayout();
                },
            };
            endIconsElem.push(<IconButton key="add-to-layout" decl={addToLayoutDecl} />);
        } else {
            endIconsElem.push(
                <OptMagnifyButton
                    key="unmagnify"
                    magnified={magnified}
                    toggleMagnify={() => {
                        nodeModel.toggleMagnify();
                        setTimeout(() => refocusNode(blockId), 50);
                    }}
                    disabled={magnifyDisabled}
                />
            );
        }
    }

    const closeDecl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "xmark-large",
        title: "Close",
        click: () => uxCloseBlock(nodeModel.blockId),
    };
    endIconsElem.push(<IconButton key="close" decl={closeDecl} className="block-frame-default-close" />);

    return <div className="block-frame-end-icons">{endIconsElem}</div>;
});
HeaderEndIcons.displayName = "HeaderEndIcons";

const BlockFrame_Header = ({
    nodeModel,
    viewModel,
    preview,
    connBtnRef,
    changeConnModalAtom,
    error,
}: BlockFrameProps & { changeConnModalAtom: jotai.PrimitiveAtom<boolean>; error?: Error }) => {
    const waveEnv = useWaveEnv<BlockEnv>();
    const metaView = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "view"));
    const metaFrameTitle = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "frame:title"));
    const metaFrameIcon = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "frame:icon"));
    const metaConnection = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "connection"));
    let viewName = util.useAtomValueSafe(viewModel?.viewName) ?? blockViewToName(metaView);
    let viewIconUnion = util.useAtomValueSafe(viewModel?.viewIcon) ?? blockViewToIcon(metaView);
    const preIconButton = util.useAtomValueSafe(viewModel?.preIconButton);
    const useTermHeader = util.useAtomValueSafe(viewModel?.useTermHeader);
    const termConfigedDurable = util.useAtomValueSafe(viewModel?.termConfigedDurable);
    const hideViewName = util.useAtomValueSafe(viewModel?.hideViewName);
    const badge = jotai.useAtomValue(getBlockBadgeAtom(useTermHeader ? nodeModel.blockId : null));
    const magnified = jotai.useAtomValue(nodeModel.isMagnified);
    const prevMagifiedState = React.useRef(magnified);
    const manageConnection = util.useAtomValueSafe(viewModel?.manageConnection);
    const iconColor = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "icon:color"));
    const dragHandleRef = preview ? null : nodeModel.dragHandleRef;
    const ephemeralSession = jotai.useAtomValue(nodeModel.isEphemeralSession);
    const isTerminalBlock = metaView === "term";
    viewName = metaFrameTitle ?? viewName;
    viewIconUnion = metaFrameIcon ?? viewIconUnion;

    React.useEffect(() => {
        if (magnified && !preview && !prevMagifiedState.current) {
            waveEnv.rpc.ActivityCommand(TabRpcClient, { nummagnify: 1 });
            recordTEvent("action:magnify", { "block:view": viewName });
        }
        prevMagifiedState.current = magnified;
    }, [magnified]);

    const viewIconElem = getViewIconElem(viewIconUnion, iconColor);

    return (
        <div
            className={cn("block-frame-default-header", useTermHeader && "!pl-[2px]")}
            data-role="block-header"
            ref={dragHandleRef}
            onContextMenu={(e) => handleHeaderContextMenu(e, nodeModel.blockId, viewModel, nodeModel, waveEnv)}
        >
            {!useTermHeader && (
                <>
                    {preIconButton && <IconButton decl={preIconButton} className="block-frame-preicon-button" />}
                    <div className="block-frame-default-header-iconview">
                        {viewIconElem}
                        {viewName && !hideViewName && <div className="block-frame-view-type">{viewName}</div>}
                    </div>
                </>
            )}
            {manageConnection && (
                <ConnectionButton
                    ref={connBtnRef}
                    key="connbutton"
                    connection={metaConnection}
                    changeConnModalAtom={changeConnModalAtom}
                    isTerminalBlock={isTerminalBlock}
                />
            )}
            {useTermHeader && termConfigedDurable != null && (
                <DurableSessionFlyover
                    key="durable-status"
                    blockId={nodeModel.blockId}
                    viewModel={viewModel}
                    placement="bottom"
                    divClassName="iconbutton disabled text-[13px] ml-[-4px]"
                />
            )}
            {useTermHeader && badge && (
                <div className="pointer-events-none flex items-center px-1" style={{ color: badge.color || "#fbbf24" }}>
                    <i className={makeIconClass(badge.icon, true, { defaultIcon: "circle-small" })} />
                </div>
            )}
            <HeaderTextElems viewModel={viewModel} blockId={nodeModel.blockId} preview={preview} error={error} />
            <HeaderEndIcons viewModel={viewModel} nodeModel={nodeModel} blockId={nodeModel.blockId} />
        </div>
    );
};

export { BlockFrame_Header };
