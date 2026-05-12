const DISABLE_DURING_EXPORT_IDS = [
  "load-content-btn",
  "export-pages-btn",
  "save-project-btn",
  "load-project-btn",
  "interface-colors-btn",
  "canvas-zoom-in",
  "canvas-zoom-out",
  "show-layout-content",
  "show-margin-arrows",
  "show-page-border",
  "vdg",
];

export class BusyIndicator {
  constructor() {
    this.exporting = false;
    this.loading = false;
    this.exportProgress = { current: 0, total: 0, label: "" };
    this.loadProgress = { current: 0, total: 0, label: "" };
  }

  get isExporting() {
    return this.exporting;
  }

  setExporting(value) {
    this.exporting = !!value;
    if (!this.exporting) this.exportProgress = { current: 0, total: 0, label: "" };
    this.sync();
  }

  setLoading(value) {
    this.loading = !!value;
    if (!this.loading) this.loadProgress = { current: 0, total: 0, label: "" };
    this.sync();
  }

  setExportProgress(label, current = 0, total = 0) {
    this.exportProgress = { label, current, total };
    this.sync();
  }

  setLoadProgress(label, current = 0, total = 0) {
    this.loadProgress = { label, current, total };
    this.sync();
  }

  sync() {
    document.body.dataset.exporting = this.exporting ? "true" : "false";
    const overlay = document.getElementById("busy-overlay");
    if (overlay) overlay.hidden = !this.exporting;
    const status = document.getElementById("export-status");
    const statusText = document.getElementById("export-status-text");
    const progressFill = document.getElementById("export-progress-fill");
    const showingExportProgress = this.exporting;
    const showingLoadProgress = this.loading && !showingExportProgress;
    if (status) status.hidden = !(showingExportProgress || showingLoadProgress);
    if (statusText) {
      const progressState = showingExportProgress ? this.exportProgress : this.loadProgress;
      const { current, total, label } = progressState;
      statusText.textContent = (showingExportProgress || showingLoadProgress)
        ? `${label}${total > 0 ? ` ${current} / ${total}` : ""}`
        : "";
    }
    if (progressFill) {
      const progressState = showingExportProgress ? this.exportProgress : this.loadProgress;
      const { current, total } = progressState;
      const progress = total > 0 ? (current / total) * 100 : 0;
      progressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    }
    DISABLE_DURING_EXPORT_IDS.forEach(id => {
      const control = document.getElementById(id);
      if (control) control.disabled = this.exporting;
    });
    document.querySelectorAll(".paper-preset-item").forEach(button => {
      button.disabled = this.exporting;
    });
    document.querySelectorAll(".mode-menu-item").forEach(button => {
      button.disabled = this.exporting;
    });
  }
}
