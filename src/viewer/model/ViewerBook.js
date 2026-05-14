import { ViewerPage } from "./ViewerPage.js";

// The viewer's view of the book. Mirrors page count + per-page metadata from
// a PageSource. `pages[i]` is a stable ViewerPage whose `metadata` field is
// re-pointed when the source's notifyPageChanged / notifyPageCountChanged
// events fire.
export class ViewerBook {
  constructor(source) {
    this.source = source;
    this.pages = [];
    this.syncAll();
    source.on("pagecountchanged", () => this.syncAll());
    source.on("pagechanged", index => this.syncPage(index));
  }

  syncAll() {
    const count = this.source.getPageCount();
    while (this.pages.length < count) this.pages.push(new ViewerPage());
    if (this.pages.length > count) this.pages.length = count;
    for (let i = 0; i < count; i++) this.syncPage(i);
  }

  syncPage(index) {
    if (index < 0 || index >= this.pages.length) return;
    const meta = this.source.getPageMetadata(index);
    const page = this.pages[index];
    page.aspectRatio = meta?.aspectRatio ?? 1;
    page.metadata = meta?.passthrough ?? meta ?? null;
  }

  numSpreads() {
    return Math.max(1, Math.ceil((this.pages.length + 1) / 2));
  }

  spreadPages(spreadIndex) {
    const leftIndex = spreadIndex * 2 - 1;
    const rightIndex = spreadIndex * 2;
    return [
      leftIndex >= 0 ? this.pages[leftIndex] ?? null : null,
      this.pages[rightIndex] ?? null,
    ];
  }

  spreadPageEntries(spreadIndex) {
    const leftIndex = spreadIndex * 2 - 1;
    const rightIndex = spreadIndex * 2;
    const leftShowThroughIndex = leftIndex - 1;
    const rightShowThroughIndex = rightIndex + 1;
    return {
      left: {
        page: leftIndex >= 0 ? this.pages[leftIndex] ?? null : null,
        pageIndex: leftIndex,
        showThroughPage: leftShowThroughIndex >= 0
          ? this.pages[leftShowThroughIndex] ?? null
          : null,
      },
      right: {
        page: this.pages[rightIndex] ?? null,
        pageIndex: rightIndex,
        showThroughPage: this.pages[rightShowThroughIndex] ?? null,
      },
    };
  }
}
