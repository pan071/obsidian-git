import { html } from "diff2html";
import type { EventRef, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { ItemView, Menu, Platform } from "obsidian";
import { DIFF_VIEW_CONFIG } from "src/constants";
import { SimpleGit } from "src/gitManager/simpleGit";
import type ObsidianGit from "src/main";
import type { DiffViewState } from "src/types";
import {
    getSourceFile,
    mapLineBetweenTexts,
    openFileAtLine,
} from "src/ui/diff/sourceLine";

export default class DiffView extends ItemView {
    parser: DOMParser;
    gettingDiff = false;
    state!: DiffViewState;
    gitRefreshRef!: EventRef;
    gitViewRefreshRef!: EventRef;

    /**
     * The diff row clicked last. Used to resolve the current line, as the
     * rendered diff has no cursor.
     */
    private lastClickedRow: HTMLTableRowElement | undefined;

    constructor(
        leaf: WorkspaceLeaf,
        private plugin: ObsidianGit
    ) {
        super(leaf);
        this.parser = new DOMParser();
        this.navigation = true;
        this.contentEl.addClass("git-diff");
        this.gitRefreshRef = this.app.workspace.on(
            "obsidian-git:status-changed",
            () => {
                this.refresh().catch(console.error);
            }
        );
        // Remember the clicked row as the current line
        this.registerDomEvent(this.contentEl, "mousedown", (event) => {
            const row = this.rowOfEvent(event);
            if (row) this.lastClickedRow = row;
        });
        this.registerDomEvent(this.contentEl, "contextmenu", (event) =>
            this.showContextMenu(event)
        );
    }

    /**
     * Returns the diff table row the event target belongs to.
     *
     * @param event The mouse event inside the diff.
     * @returns The row or `undefined` if the target is not inside a row.
     */
    private rowOfEvent(event: MouseEvent): HTMLTableRowElement | undefined {
        if (!(event.target instanceof Element)) return undefined;
        return event.target.closest("tr") ?? undefined;
    }

    /**
     * Shows the context menu with the copy and open source file items.
     *
     * @param event The context menu event.
     */
    private showContextMenu(event: MouseEvent): void {
        const row = this.rowOfEvent(event);
        // Keep the default behavior outside of the diff rows
        if (!row) return;
        event.preventDefault();
        this.lastClickedRow = row;

        const selectedText = activeWindow.getSelection()?.toString() ?? "";
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle("Copy")
                .setIcon("copy")
                .setDisabled(selectedText.length === 0)
                .onClick(() => navigator.clipboard.writeText(selectedText))
        );
        menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle("Open in editor at this line")
                .setIcon("file-input")
                .setDisabled(!this.canOpenSourceFile())
                .onClick(() =>
                    this.openSourceFileAtRow(row).catch((e) =>
                        this.plugin.displayError(e)
                    )
                )
        );
        menu.showAtMouseEvent(event);
    }

    /**
     * Whether the file of this diff can be opened in a normal editor.
     */
    canOpenSourceFile(): boolean {
        return getSourceFile(this.plugin, this.state?.bFile) !== undefined;
    }

    /**
     * Opens the working tree file at the line of the row clicked last or the
     * first changed line, if no row got clicked yet.
     */
    async openSourceFileAtCursor(): Promise<void> {
        const row =
            this.lastClickedRow?.isConnected === true
                ? this.lastClickedRow
                : this.contentEl.querySelector<HTMLTableRowElement>(
                      "tr:has(.d2h-ins, .d2h-del)"
                  );
        if (row) await this.openSourceFileAtRow(row);
    }

    /**
     * Reads the new side line number of a diff row.
     *
     * @param row The diff table row.
     * @returns The 1-based line number or `undefined` for removed and info rows.
     */
    private newSideLineOfRow(row: Element): number | undefined {
        const text = row.querySelector(".line-num2")?.textContent?.trim();
        const line = text ? Number.parseInt(text) : NaN;
        return Number.isNaN(line) ? undefined : line;
    }

    /**
     * Resolves the new side line of a row. Removed lines have no new side
     * line, so the line following the removal is used.
     *
     * @param row The diff table row.
     * @returns The 1-based line number on the new side of the diff.
     */
    private resolveNewSideLine(row: HTMLTableRowElement): number {
        const rows = Array.from(this.contentEl.querySelectorAll("tr"));
        const index = rows.indexOf(row);
        // The first following row with a new side line follows the removal
        for (let i = index; i < rows.length; i++) {
            const line = this.newSideLineOfRow(rows[i]!);
            if (line !== undefined) return line;
        }
        // The removal is at the end of the file, so use the line after the last one
        for (let i = index - 1; i >= 0; i--) {
            const line = this.newSideLineOfRow(rows[i]!);
            if (line !== undefined) return line + 1;
        }
        return 1;
    }

    /**
     * Opens the working tree file at the line matching the given row.
     *
     * @param row The diff table row.
     */
    async openSourceFileAtRow(row: HTMLTableRowElement): Promise<void> {
        const file = getSourceFile(this.plugin, this.state?.bFile);
        if (!file) return;
        let line = this.resolveNewSideLine(row);

        // The new side is not the working tree, so map it to the current file
        if (this.state.bRef != undefined) {
            const newSideText = await this.plugin.gitManager.show(
                this.state.bRef,
                this.state.bFile,
                false
            );
            const workingTreeText = await this.app.vault.read(file);
            line = mapLineBetweenTexts(newSideText, workingTreeText, line);
        }

        await openFileAtLine(this.plugin, file, line);
    }

    getViewType(): string {
        return DIFF_VIEW_CONFIG.type;
    }

    getDisplayText(): string {
        if (this.state?.bFile != null) {
            let fileName = this.state.bFile.split("/").last();
            if (fileName?.endsWith(".md")) fileName = fileName.slice(0, -3);

            return `Diff: ${fileName}`;
        }
        return DIFF_VIEW_CONFIG.name;
    }

    getIcon(): string {
        return DIFF_VIEW_CONFIG.icon;
    }

    async setState(state: DiffViewState, _: ViewStateResult): Promise<void> {
        this.state = state;

        if (Platform.isMobile) {
            //Update view title on mobile only to show the file name of the diff
            this.leaf.view.titleEl.textContent = this.getDisplayText();
        }

        await this.refresh();
    }

    getState(): Record<string, unknown> {
        return this.state;
    }

    onClose(): Promise<void> {
        this.app.workspace.offref(this.gitRefreshRef);
        this.app.workspace.offref(this.gitViewRefreshRef);
        return super.onClose();
    }

    async onOpen(): Promise<void> {
        await this.refresh();
        return super.onOpen();
    }

    async refresh(): Promise<void> {
        if (this.state?.bFile && !this.gettingDiff && this.plugin.gitManager) {
            this.gettingDiff = true;
            try {
                let diff = await this.plugin.gitManager.getDiffString(
                    this.state.bFile,
                    this.state.aRef == "HEAD",
                    this.state.bRef
                );
                this.contentEl.empty();

                const vaultPath = this.plugin.gitManager.getRelativeVaultPath(
                    this.state.bFile
                );
                if (!diff) {
                    if (
                        this.plugin.gitManager instanceof SimpleGit &&
                        (await this.plugin.gitManager.isTracked(
                            this.state.bFile
                        ))
                    ) {
                        // File is tracked but no changes
                        diff = [
                            `--- ${this.state.aFile}`,
                            `+++ ${this.state.bFile}`,
                            "",
                        ].join("\n");
                    } else if (await this.app.vault.adapter.exists(vaultPath)) {
                        const content =
                            await this.app.vault.adapter.read(vaultPath);
                        const header = `--- /dev/null
+++ ${this.state.bFile}
@@ -0,0 +1,${content.split("\n").length} @@`;

                        diff = [
                            ...header.split("\n"),
                            ...content.split("\n").map((line) => `+${line}`),
                        ].join("\n");
                    }
                }

                if (diff) {
                    const diffEl = this.parser
                        .parseFromString(html(diff), "text/html")
                        .querySelector(".d2h-file-diff");
                    this.contentEl.append(diffEl!);
                } else {
                    const div = this.contentEl.createDiv({
                        cls: "obsidian-git-center",
                    });
                    div.createSpan({
                        text: "⚠️",
                        attr: { style: "font-size: 2em" },
                    });
                    div.createEl("br");
                    div.createSpan({
                        text: "File not found: " + this.state.bFile,
                    });
                }
            } finally {
                this.gettingDiff = false;
            }
        }
    }
}
