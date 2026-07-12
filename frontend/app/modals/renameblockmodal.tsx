// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { buildBlockTitleMeta, type BlockTitleMetaKey } from "@/app/block/blocktitle";
import { Input } from "@/app/element/input";
import { Modal } from "@/app/modals/modal";
import { modalsModel } from "@/app/store/modalmodel";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as React from "react";

type RenameBlockModalProps = {
    blockId: string;
    currentTitle?: string;
    titleKey: BlockTitleMetaKey;
};

const RenameBlockModal = ({ blockId, currentTitle = "", titleKey }: RenameBlockModalProps) => {
    const [title, setTitle] = React.useState(currentTitle);
    const [error, setError] = React.useState("");
    const [saving, setSaving] = React.useState(false);

    const closeModal = React.useCallback(() => {
        if (!saving) {
            modalsModel.popModal();
        }
    }, [saving]);

    const saveTitle = React.useCallback(async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", blockId),
                meta: buildBlockTitleMeta(titleKey, title),
            });
            modalsModel.popModal();
        } catch (error) {
            setError(error instanceof Error ? error.message : "Unable to rename block");
            setSaving(false);
        }
    }, [blockId, saving, title, titleKey]);

    const handleKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void saveTitle();
            }
        },
        [saveTitle]
    );

    return (
        <Modal
            className="w-[420px] pt-8 pb-4"
            okLabel={saving ? "Saving..." : "Save"}
            cancelLabel="Cancel"
            onOk={() => void saveTitle()}
            onCancel={closeModal}
            onClose={closeModal}
            onClickBackdrop={closeModal}
            okDisabled={saving}
            cancelDisabled={saving}
        >
            <div className="flex flex-col gap-2">
                <div className="text-[16px] font-semibold text-primary">Rename Block</div>
                <label className="flex flex-col gap-2 text-[12px] text-secondary">
                    <span>Block title</span>
                    <Input
                        value={title}
                        onChange={setTitle}
                        onKeyDown={handleKeyDown}
                        placeholder="Use the default title"
                        autoFocus
                        autoSelect
                        disabled={saving}
                        className="w-full"
                    />
                </label>
                <div className="text-[11px] text-secondary">Leave blank to restore the default title.</div>
                {error && <div className="text-[12px] text-error">{error}</div>}
            </div>
        </Modal>
    );
};

RenameBlockModal.displayName = "RenameBlockModal";

export { RenameBlockModal };
