import { App } from "./ui/App.js";
import { WebGPUSpreadRenderer } from "riffle";

const app = new App(
  document.getElementById("spread-canvas"),
  document.getElementById("overlay-canvas"),
  document.getElementById("page-strip"),
  { rendererClass: WebGPUSpreadRenderer }
);

app.init();
