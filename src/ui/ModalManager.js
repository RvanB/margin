import { enhanceNumberInputs } from "./CustomSliderControl.js";

export class ModalManager {
  constructor(modalHost) {
    this.modalHost = modalHost;
  }

  isOpen() {
    return !!this.modalHost?.open;
  }

  close() {
    if (!this.modalHost) return;
    if (this.modalHost.open) this.modalHost.close();
    this.modalHost.innerHTML = "";
  }

  show({ title, templateId, onOpen = null } = {}) {
    if (!this.modalHost) return null;
    this.close();

    const shellTemplate = document.getElementById("tpl-modal-shell");
    const bodyTemplate = document.getElementById(templateId);
    if (!shellTemplate || !bodyTemplate) return null;

    const shell = shellTemplate.content.firstElementChild.cloneNode(true);
    shell.querySelector(".modal-title").textContent = title || "";
    const content = shell.querySelector(".modal-content");
    content.appendChild(bodyTemplate.content.cloneNode(true));
    enhanceNumberInputs(content);
    this.modalHost.appendChild(shell);

    const controller = new AbortController();
    const { signal } = controller;
    const close = () => this.modalHost?.close();

    shell.querySelectorAll("[data-modal-close]").forEach(button => {
      button.addEventListener("click", close, { signal });
    });
    this.modalHost.addEventListener("click", event => {
      if (event.target === this.modalHost) close();
    }, { signal });
    this.modalHost.addEventListener("close", () => {
      controller.abort();
      this.modalHost.innerHTML = "";
    }, { once: true, signal });
    this.modalHost.showModal();

    onOpen?.({ dialog: this.modalHost, shell, content, signal });
    return { dialog: this.modalHost, shell, content, signal };
  }
}
