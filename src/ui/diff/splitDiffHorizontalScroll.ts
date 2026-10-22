import type { MergeView } from "@codemirror/merge";
import type { EditorView } from "@codemirror/view";

/**
 * Horizontal scrollbars for the split diff view without line wrapping.
 *
 * The merge view only scrolls vertically as a whole, so the native
 * horizontal scrollbars of both editors would sit at the very end of the
 * document. Instead, a scrollbar for each editor sticks to the bottom of the
 * view, and the horizontal scroll position of both editors and their
 * scrollbars is kept in sync.
 *
 * @author 启年
 * @createTime 2026-10-20 13:20
 */
export class SplitDiffHorizontalScroll {
    /** The row containing the scrollbars of both editors. */
    private readonly barEl: HTMLElement;

    /** The scrollbar tracks of editor a and b. */
    private readonly trackEls: [HTMLElement, HTMLElement];

    /** The fillers defining the scroll width of the tracks. */
    private readonly fillerEls: [HTMLElement, HTMLElement];

    /**
     * Elements, whose next scroll event was caused by the synchronization
     * and must not be synchronized again.
     */
    private readonly syncedEls = new Set<HTMLElement>();

    /** Updates the scrollbars, when the merge view gets resized. */
    private readonly resizeObserver: ResizeObserver;

    /** The pending animation frame of a scheduled update. */
    private updateFrame: number | undefined;

    /** The window containing the view, which may be a popout window. */
    private readonly win: Window & typeof globalThis;

    /**
     * Creates the scrollbars below the merge view.
     *
     * @param mergeView The merge view to scroll horizontally.
     * @param container The view container, which scrolls vertically.
     */
    constructor(
        private readonly mergeView: MergeView,
        container: HTMLElement
    ) {
        this.barEl = container.createDiv({ cls: "git-diff-hscroll" });
        const trackA = this.barEl.createDiv({ cls: "git-diff-hscroll-track" });
        const trackB = this.barEl.createDiv({ cls: "git-diff-hscroll-track" });
        this.trackEls = [trackA, trackB];
        this.fillerEls = [
            trackA.createDiv({ cls: "git-diff-hscroll-filler" }),
            trackB.createDiv({ cls: "git-diff-hscroll-filler" }),
        ];

        // Synchronize every scroll of an editor or a scrollbar to the others
        for (const el of this.scrollEls()) {
            el.addEventListener("scroll", () => this.sync(el), {
                passive: true,
            });
        }

        // Observe and schedule frames in the window, which contains the view
        this.win = container.win as Window & typeof globalThis;
        // Editor widths change with the view width
        this.resizeObserver = new this.win.ResizeObserver(() =>
            this.scheduleUpdate()
        );
        this.resizeObserver.observe(this.mergeView.dom);
        this.scheduleUpdate();
    }

    /**
     * Returns all elements, whose horizontal scroll position is synchronized.
     */
    private scrollEls(): HTMLElement[] {
        return [
            this.mergeView.a.scrollDOM,
            this.mergeView.b.scrollDOM,
            ...this.trackEls,
        ];
    }

    /**
     * Applies the horizontal scroll position of the scrolled element to all
     * other synchronized elements.
     *
     * @param source The element, which got scrolled.
     */
    private sync(source: HTMLElement): void {
        // Ignore the scroll event caused by the synchronization itself
        if (this.syncedEls.delete(source)) return;

        const left = source.scrollLeft;
        for (const el of this.scrollEls()) {
            if (el === source || el.scrollLeft === left) continue;
            const before = el.scrollLeft;
            el.scrollLeft = left;
            // Only a changed position fires a scroll event, a clamped one may not
            if (el.scrollLeft !== before) {
                this.syncedEls.add(el);
            }
        }
    }

    /**
     * Schedules an update of the scrollbar positions and widths for the next
     * frame, so multiple changes are measured only once.
     */
    scheduleUpdate(): void {
        if (this.updateFrame !== undefined) return;
        this.updateFrame = this.win.requestAnimationFrame(() => {
            this.updateFrame = undefined;
            this.update();
        });
    }

    /**
     * Aligns each scrollbar with its editor and sets its scroll width to the
     * scroll width of that editor.
     */
    private update(): void {
        // The scrollbars are hidden, while lines are wrapped
        if (this.barEl.offsetParent === null) return;

        const editors: [EditorView, EditorView] = [
            this.mergeView.a,
            this.mergeView.b,
        ];
        // Position each track relative to the end of the previous one
        let previousRight = this.barEl.getBoundingClientRect().left;
        editors.forEach((editor, index) => {
            const rect = editor.dom.getBoundingClientRect();
            this.trackEls[index]!.setCssStyles({
                marginLeft: `${rect.left - previousRight}px`,
                width: `${rect.width}px`,
            });
            this.fillerEls[index]!.setCssStyles({
                width: `${editor.scrollDOM.scrollWidth}px`,
            });
            previousRight = rect.right;
        });
        // Keep the tracks at the scroll position of their editors
        editors.forEach((editor, index) => {
            const track = this.trackEls[index]!;
            const before = track.scrollLeft;
            track.scrollLeft = editor.scrollDOM.scrollLeft;
            if (track.scrollLeft !== before) {
                this.syncedEls.add(track);
            }
        });
    }

    /**
     * Removes the scrollbars and stops observing the merge view.
     */
    destroy(): void {
        if (this.updateFrame !== undefined) {
            this.win.cancelAnimationFrame(this.updateFrame);
            this.updateFrame = undefined;
        }
        this.resizeObserver.disconnect();
        this.barEl.remove();
    }
}
