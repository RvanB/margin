export class Book {
  constructor({
    pages = [],
    layout = null,
    display = null,
  } = {}) {
    this.pages = pages;
    this.layout = {
      pw: 5.5,
      ph: 8.5,
      ratio: 0.647,
      b: 0.611,
      mInner: 1,
      mTop: 1.545,
      mBottom: 3.091,
      ...layout,
    };
    this.display = {
      paperColor: "#ffffff",
      contentBlendMode: "source-over",
      ...display,
    };
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
    return {
      left: {
        page: leftIndex >= 0 ? this.pages[leftIndex] ?? null : null,
        pageIndex: leftIndex,
      },
      right: {
        page: this.pages[rightIndex] ?? null,
        pageIndex: rightIndex,
      },
    };
  }

  addPage(page) {
    this.pages.push(page);
  }

  removePage(index) {
    this.pages.splice(index, 1);
  }
}
