import { normalizeContentAlignX, normalizeContentAlignY } from "../model/Page.js";
import { applyPaperPreset, getPaperPresetOptions, normalizePaperPreset } from "../model/paper.js";
import {
  getEditingPage,
  getEffectiveContentAlignX,
  getEffectiveContentAlignY,
  getSelectedPages,
} from "../util/helpers.js";
import {
  enhanceCustomSliderInputs,
  enhanceNumberInputs,
  refreshCustomSliderControls,
} from "./CustomSliderControl.js";

export class ToolbarController {
  constructor(app) {
    this.app = app;
    this.toolbar = app.toolbar;
    this.listeners = [];
  }

  #control(id) {
    return this.toolbar?.querySelector(`#${id}`) || document.getElementById(id);
  }

  #getNumber(id) {
    return parseFloat(document.getElementById(id)?.value) || 0;
  }

  #setComputed(id, value, warn = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
    const row = el.closest(".computed-row");
    row?.classList.toggle("warn", !!warn);
  }

  #addListener(elOrId, type, fn) {
    const el = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
    if (!el) return;
    el.addEventListener(type, fn);
    this.listeners.push({ el, type, fn });
  }

  clearListeners() {
    for (const { el, type, fn } of this.listeners) {
      el.removeEventListener(type, fn);
    }
    this.listeners = [];
  }

  closeOpenMenus() {
    document.querySelectorAll(".menu-dropdown[open], .menu-submenu[open]").forEach(menu => menu.removeAttribute("open"));
  }

  mountToolbar(mode) {
    const template = document.getElementById(`tpl-${mode}`);
    this.toolbar.innerHTML = "";
    this.toolbar.appendChild(template.content.cloneNode(true));
    enhanceCustomSliderInputs(this.toolbar);
    enhanceNumberInputs(this.toolbar);
    globalThis.htmx?.process(this.toolbar);
    refreshCustomSliderControls(this.toolbar);
    this.syncMenuState();
  }

  populatePaperPresetMenu() {
    const list = document.getElementById("paper-color-list");
    if (!list || list.children.length) return;
    getPaperPresetOptions().forEach(({ id, label }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-list-item paper-preset-item";
      button.dataset.paperPreset = id;
      button.textContent = label;
      button.addEventListener("click", () => {
        this.setPaperPreset(id);
        this.closeOpenMenus();
      });
      list.appendChild(button);
    });
  }

  setPaperPreset(presetId) {
    const app = this.app;
    applyPaperPreset(app.book.display, presetId);
    if (!app.placedPreviewManager.refreshIfLayoutChanged()) {
      app.pageStrip.invalidateAllThumbnails();
    }
    this.syncMenuState();
    app.redraw();
    app.schedulePreviewRedraw();
  }

  syncMenuState() {
    const app = this.app;
    this.populatePaperPresetMenu();
    const activePaperPreset = normalizePaperPreset(app.book.display.paperPreset);
    document.querySelectorAll(".paper-preset-item").forEach(button => {
      const isActive = button.dataset.paperPreset === activePaperPreset;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    const showMarginArrows = document.getElementById("show-margin-arrows");
    if (showMarginArrows) showMarginArrows.checked = app.uiState.showMarginArrows;
    const showLayoutContent = document.getElementById("show-layout-content");
    if (showLayoutContent) showLayoutContent.checked = app.uiState.showLayoutContent;
    const showPageBorder = document.getElementById("show-page-border");
    if (showPageBorder) showPageBorder.checked = app.uiState.showPageBorder;
    const paperThickness = document.getElementById("paper-thickness");
    if (paperThickness) paperThickness.value = String(app.book.display.paperThickness ?? 0.5);
    const paperTextureStrength = document.getElementById("paper-texture-strength");
    if (paperTextureStrength) paperTextureStrength.value = String(app.book.display.paperTextureStrength ?? 0.2);
    const vdg = document.getElementById("vdg");
    if (vdg) vdg.checked = app.uiState.showVdG;
    document.querySelectorAll(".mode-menu-item").forEach(button => {
      button.classList.toggle("active", button.dataset.mode === app.uiState.appMode);
    });
  }

  updateComputedRows(margins) {
    this.#setComputed("c-inner", `${margins.inner.toFixed(3)}″`);
    this.#setComputed("c-top", `${margins.top.toFixed(3)}″`);
    this.#setComputed("c-outer", margins.ok ? `${margins.outer.toFixed(3)}″` : "invalid", !margins.ok);
    this.#setComputed("c-bottom", `${margins.bottom.toFixed(3)}″`);
    this.#setComputed("c-tw", margins.ok ? `${margins.tw.toFixed(3)}″` : "invalid", !margins.ok);
    this.#setComputed("c-th", margins.ok ? `${margins.th.toFixed(3)}″` : "invalid", !margins.ok);
  }

  syncInputs() {
    const ratioInput = document.getElementById("ratio");
    const sameAsPage = document.getElementById("ratio-same-as-page")?.checked;
    if (ratioInput) ratioInput.disabled = !!sameAsPage;
    if (sameAsPage && ratioInput) ratioInput.value = (this.#getNumber("pw") / this.#getNumber("ph")).toFixed(3);
    refreshCustomSliderControls(this.toolbar);
  }

  syncBookLayoutFromInputs() {
    const app = this.app;
    this.syncInputs();
    app.book.layout.pw = this.#getNumber("pw");
    app.book.layout.ph = this.#getNumber("ph");
    app.book.layout.ratio = this.#getNumber("ratio");
    app.book.layout.b = this.#getNumber("b-input");
    app.book.layout.mInner = this.#getNumber("m-inner");
    app.book.layout.mTop = this.#getNumber("m-top");
    app.book.layout.mBottom = this.#getNumber("m-bottom");
    app.layoutControlsState.preserveRatio = !!document.getElementById("preserve-ratio")?.checked;
    app.layoutControlsState.ratioSameAsPage = !!document.getElementById("ratio-same-as-page")?.checked;
    app.uiState.showVdG = !!document.getElementById("vdg")?.checked;
    app.placedPreviewManager.refreshIfLayoutChanged();
  }

  restoreLayoutInputs() {
    const app = this.app;
    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    setValue("pw", app.book.layout.pw);
    setValue("ph", app.book.layout.ph);
    setValue("page-ratio", (app.book.layout.pw / app.book.layout.ph).toFixed(3));
    setValue("ratio", app.book.layout.ratio);
    setValue("b-input", app.book.layout.b);
    setValue("m-inner", app.book.layout.mInner);
    setValue("m-top", app.book.layout.mTop);
    setValue("m-bottom", app.book.layout.mBottom);
    const preserveRatio = document.getElementById("preserve-ratio");
    if (preserveRatio) preserveRatio.checked = app.layoutControlsState.preserveRatio;
    const ratioSameAsPage = document.getElementById("ratio-same-as-page");
    if (ratioSameAsPage) ratioSameAsPage.checked = app.layoutControlsState.ratioSameAsPage;
    const showMarginArrows = document.getElementById("show-margin-arrows");
    if (showMarginArrows) showMarginArrows.checked = app.uiState.showMarginArrows;
    const showLayoutContent = document.getElementById("show-layout-content");
    if (showLayoutContent) showLayoutContent.checked = app.uiState.showLayoutContent;
    const showPageBorder = document.getElementById("show-page-border");
    if (showPageBorder) showPageBorder.checked = app.uiState.showPageBorder;
    const vdg = document.getElementById("vdg");
    if (vdg) vdg.checked = app.uiState.showVdG;
    this.syncInputs();
    refreshCustomSliderControls(this.toolbar);
    this.syncMenuState();
  }

  applyVdGLayoutValues() {
    const pageWidth = this.#getNumber("pw") || 5.5;
    const pageHeight = this.#getNumber("ph") || 8.5;
    const b = pageWidth / 9;
    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    setValue("b-input", b.toFixed(3));
    setValue("m-inner", "1");
    setValue("m-top", (pageHeight / pageWidth).toFixed(3));
    setValue("m-bottom", (2 * pageHeight / pageWidth).toFixed(3));
    setValue("ratio", (pageWidth / pageHeight).toFixed(3));
    const ratioSameAsPage = document.getElementById("ratio-same-as-page");
    if (ratioSameAsPage) ratioSameAsPage.checked = true;
    refreshCustomSliderControls(this.toolbar);
  }

  initLayoutListeners() {
    const app = this.app;
    this.#addListener("page-ratio", "change", event => {
      const ratio = parseFloat(event.target.value);
      if (!ratio || ratio <= 0) return;
      const pw = this.#getNumber("pw");
      const ph = this.#getNumber("ph");
      if (ratio < pw / ph) {
        document.getElementById("pw").value = (ph * ratio).toFixed(3);
      } else {
        document.getElementById("ph").value = (pw / ratio).toFixed(3);
      }
      app.redraw();
    });

    this.#addListener("pw", "input", () => {
      const pw = this.#getNumber("pw");
      if (document.getElementById("preserve-ratio")?.checked) {
        const ratio = parseFloat(document.getElementById("page-ratio")?.value);
        if (ratio) document.getElementById("ph").value = (pw / ratio).toFixed(3);
      } else {
        document.getElementById("page-ratio").value = (pw / this.#getNumber("ph")).toFixed(3);
      }
      app.redraw();
    });

    this.#addListener("ph", "input", () => {
      const ph = this.#getNumber("ph");
      if (document.getElementById("preserve-ratio")?.checked) {
        const ratio = parseFloat(document.getElementById("page-ratio")?.value);
        if (ratio) document.getElementById("pw").value = (ph * ratio).toFixed(3);
      } else {
        document.getElementById("page-ratio").value = (this.#getNumber("pw") / ph).toFixed(3);
      }
      app.redraw();
    });

    ["ratio", "m-inner", "m-top", "m-bottom"].forEach(id => this.#addListener(id, "input", () => app.redraw()));
    this.#addListener("b-input", "input", () => app.redraw());
    this.#addListener("ratio-same-as-page", "change", () => app.redraw());
    this.#addListener("preserve-ratio", "change", () => app.redraw());
    this.#addListener("vdg-snap", "click", () => {
      this.applyVdGLayoutValues();
      app.redraw();
    });
  }

  initContentListeners() {
    const app = this.app;
    const applyToSelected = (mutate) => {
      const pages = getSelectedPages(app.book, app.uiState);
      for (const page of pages) mutate(page);
      app.placedPreviewManager.markPagesDirty(pages);
      this.syncPageUI();
      app.redraw();
    };

    this.#addListener("cover-check", "change", event => {
      applyToSelected(page => { page.cover = event.target.checked; });
    });

    this.#addListener("spread-check", "change", event => {
      applyToSelected(page => { page.spread = event.target.checked; });
    });

    this.#addListener("content-align-x", "change", event => {
      const value = normalizeContentAlignX(event.target.value);
      applyToSelected(page => { page.contentAlignX = value; });
    });

    this.#addListener("content-align-y", "change", event => {
      const value = normalizeContentAlignY(event.target.value);
      applyToSelected(page => { page.contentAlignY = value; });
    });

    if (app.book.pages.length) this.syncPageUI();
  }

  syncPageUI() {
    const app = this.app;
    const section = this.#control("toolbar");
    if (section) section.style.display = "";
    if (!getEditingPage(app.book, app.uiState)) return;
    const selectedPages = getSelectedPages(app.book, app.uiState);
    const syncToggle = (id, key) => {
      const input = this.#control(id);
      if (!input) return;
      const allEnabled = selectedPages.every(selectedPage => !!selectedPage?.[key]);
      const allDisabled = selectedPages.every(selectedPage => !selectedPage?.[key]);
      input.checked = allEnabled;
      input.indeterminate = !allEnabled && !allDisabled;
    };

    syncToggle("cover-check", "cover");
    syncToggle("spread-check", "spread");
    const syncSelect = (id, getter) => {
      const input = this.#control(id);
      if (!input) return;
      const values = selectedPages.map(getter);
      const first = values[0] || "";
      input.value = values.every(value => value === first) ? first : "";
    };
    syncSelect("content-align-x", page => getEffectiveContentAlignX(app.book, page));
    syncSelect("content-align-y", page => getEffectiveContentAlignY(page));
    const selectionCount = this.#control("selection-count");
    if (selectionCount) {
      const count = app.uiState.selectedPageIdxs.size;
      selectionCount.textContent = count > 1 ? `${count} pages` : "";
    }
  }
}
