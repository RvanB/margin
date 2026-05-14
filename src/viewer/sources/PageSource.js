// Abstract bridge between the viewer and whoever provides the underlying
// pages. The viewer asks the source for page count, per-page metadata, and
// pixel data; the source emits events when those change.
//
// Subclasses must implement `getPageCount`, `getPageMetadata`,
// `getPagePreview`, and `getPageHighRes`. They can use `emit` to broadcast
// `pagechanged` / `pagecountchanged` events.
export class PageSource {
  constructor() {
    this.listeners = new Map();
  }

  on(event, fn) {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    arr.push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }

  emit(event, ...args) {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const fn of arr.slice()) fn(...args);
  }

  notifyPageChanged(index) { this.emit("pagechanged", index); }
  notifyPageCountChanged() { this.emit("pagecountchanged"); }

  getPageCount() { throw new Error("PageSource.getPageCount not implemented"); }
  getPageMetadata(_index) { throw new Error("PageSource.getPageMetadata not implemented"); }
  async getPagePreview(_index) { throw new Error("PageSource.getPagePreview not implemented"); }
  async getPageHighRes(_index, _targetEdgePx) { throw new Error("PageSource.getPageHighRes not implemented"); }
  dispose() {}
}
