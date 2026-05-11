import { App } from "./ui/App.js";
import { WebGPUSpreadRenderer } from "./rendering/WebGPUSpreadRenderer.js";

const rendererParam = new URL(window.location.href).searchParams.get("renderer");
const rendererClass = rendererParam === "webgpu" ? WebGPUSpreadRenderer : undefined;

const app = new App(
  document.getElementById("spread-canvas"),
  document.getElementById("overlay-canvas"),
  document.getElementById("page-strip"),
  { rendererClass }
);

app.init();
