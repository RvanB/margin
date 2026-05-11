import { App } from "./ui/App.js";
import { WebGPUSpreadRenderer } from "./rendering/WebGPUSpreadRenderer.js";

const app = new App(
  document.getElementById("spread-canvas"),
  document.getElementById("overlay-canvas"),
  document.getElementById("page-strip"),
  { rendererClass: WebGPUSpreadRenderer }
);

app.init();
