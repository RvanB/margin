import { App } from "./ui/App.js";

const app = new App(
  document.getElementById("spread-canvas"),
  document.getElementById("overlay-canvas"),
  document.getElementById("page-strip")
);

app.init();
