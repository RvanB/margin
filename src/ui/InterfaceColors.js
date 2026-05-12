import { normalizeHexColor } from "../util/helpers.js";

export class InterfaceColors {
  constructor({ initial = {}, onChange = null } = {}) {
    this.colors = {
      foreground: normalizeHexColor(initial.foreground, "#000000"),
      background: normalizeHexColor(initial.background, "#ffffff"),
    };
    this.onChange = onChange;
  }

  get foreground() {
    return this.colors.foreground;
  }

  get background() {
    return this.colors.background;
  }

  apply() {
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--ui-foreground", this.colors.foreground);
    rootStyle.setProperty("--ui-background", this.colors.background);
  }

  set(nextColors = {}) {
    this.colors = {
      foreground: normalizeHexColor(nextColors.foreground, this.colors.foreground),
      background: normalizeHexColor(nextColors.background, this.colors.background),
    };
    this.apply();
    this.onChange?.();
  }

  openEditor(modalManager) {
    modalManager.show({
      title: "Interface colors",
      templateId: "tpl-interface-colors-modal",
      onOpen: ({ content, signal }) => {
        const foregroundInput = content.querySelector("#interface-foreground-color");
        const backgroundInput = content.querySelector("#interface-background-color");
        const foregroundValue = content.querySelector("#interface-foreground-value");
        const backgroundValue = content.querySelector("#interface-background-value");
        if (!foregroundInput || !backgroundInput || !foregroundValue || !backgroundValue) return;

        const sync = () => {
          foregroundInput.value = this.colors.foreground;
          backgroundInput.value = this.colors.background;
          foregroundValue.textContent = this.colors.foreground;
          backgroundValue.textContent = this.colors.background;
        };

        foregroundInput.addEventListener("input", () => {
          this.set({ foreground: foregroundInput.value });
          sync();
        }, { signal });
        backgroundInput.addEventListener("input", () => {
          this.set({ background: backgroundInput.value });
          sync();
        }, { signal });

        sync();
      },
    });
  }
}
