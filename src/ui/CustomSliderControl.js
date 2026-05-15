import { parseNumber } from "../util/helpers.js";

function getNumberInputPrecision(input) {
  const step = String(input?.step || "");
  if (!step.includes(".")) return 0;
  return step.split(".")[1].length;
}

function formatNumberInputValue(input, value) {
  const numeric = parseNumber(value, 0);
  const precision = getNumberInputPrecision(input);
  return precision > 0 ? numeric.toFixed(precision) : String(Math.round(numeric));
}

function getCustomSliderBounds(input) {
  const min = parseNumber(input.min, 0);
  const step = parseNumber(input.step, 1) || 1;
  const value = parseNumber(input.value, min);
  const explicitMax = input.max === "" ? NaN : parseNumber(input.max, NaN);
  const sliderMax = parseNumber(input.dataset.sliderMax, NaN);
  let max = Number.isFinite(explicitMax)
    ? explicitMax
    : Number.isFinite(sliderMax)
      ? sliderMax
      : Math.max(min + step * 100, value);
  if (value > max) max = value;
  return { min, max, step, value };
}

function setNumberInputValue(input, value, { emitChange = false } = {}) {
  if (!input) return;
  const min = input.min === "" ? -Infinity : parseNumber(input.min, -Infinity);
  const max = input.max === "" ? Infinity : parseNumber(input.max, Infinity);
  const numeric = Math.max(min, Math.min(max, parseNumber(value, parseNumber(input.value, min || 0))));
  input.value = formatNumberInputValue(input, numeric);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  if (emitChange) input.dispatchEvent(new Event("change", { bubbles: true }));
}

function formatCustomSliderValue(input, value = parseNumber(input?.value, 0)) {
  return `${formatNumberInputValue(input, value)}${input?.dataset?.sliderSuffix || ""}`;
}

function openCustomSliderEditor(input) {
  const ui = input?._customSliderUi;
  if (!ui || input.disabled) return;
  ui.valueButton.hidden = true;
  ui.valueEditor.hidden = false;
  ui.valueEditor.value = input.value;
  ui.valueEditor.focus();
  ui.valueEditor.select();
}

function closeCustomSliderEditor(input, { commit = false } = {}) {
  const ui = input?._customSliderUi;
  if (!ui) return;
  if (commit && ui.valueEditor.value !== "") {
    setNumberInputValue(input, ui.valueEditor.value, { emitChange: true });
  }
  ui.valueEditor.hidden = true;
  ui.valueButton.hidden = false;
  updateCustomSliderControl(input);
}

function updateCustomSliderControl(input) {
  const ui = input?._customSliderUi;
  if (!ui) return;
  const { min, max, step, value } = getCustomSliderBounds(input);
  const percent = max > min ? (value - min) / (max - min) : 0;
  ui.control.style.setProperty("--slider-percent", `${Math.max(0, Math.min(1, percent))}`);
  ui.range.min = String(min);
  ui.range.max = String(max);
  ui.range.step = String(step);
  ui.range.value = formatNumberInputValue(input, value);
  if (!ui.valueEditor.hidden) ui.valueEditor.value = formatNumberInputValue(input, value);
  ui.valueButton.textContent = formatCustomSliderValue(input, value);
  ui.range.disabled = !!input.disabled;
  ui.valueButton.disabled = !!input.disabled;
  ui.minusButton.disabled = !!input.disabled;
  ui.plusButton.disabled = !!input.disabled;
  ui.valueEditor.disabled = !!input.disabled;
  ui.control.classList.toggle("disabled", !!input.disabled);
}

export function refreshCustomSliderControls(scope) {
  if (!scope) return;
  scope.querySelectorAll('input[type="number"][data-custom-slider="true"]').forEach(input => {
    updateCustomSliderControl(input);
  });
}

export function enhanceCustomSliderInputs(scope) {
  if (!scope) return;
  scope.querySelectorAll('input[type="number"][data-custom-slider="true"]').forEach(input => {
    if (input.dataset.customSliderEnhanced === "true") {
      updateCustomSliderControl(input);
      return;
    }
    input.dataset.customSliderEnhanced = "true";
    input.hidden = true;
    input.classList.add("custom-slider-source");

    const control = document.createElement("div");
    control.className = "custom-slider-control";
    input.parentNode?.insertBefore(control, input);
    control.appendChild(input);

    const createNudgeButton = (direction, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `custom-slider-nudge custom-slider-nudge-${direction > 0 ? "plus" : "minus"}`;
      button.textContent = label;
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => {
        if (input.disabled) return;
        if (direction > 0) input.stepUp();
        else input.stepDown();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      return button;
    };

    const minusButton = createNudgeButton(-1, "-");
    const plusButton = createNudgeButton(1, "+");
    const main = document.createElement("div");
    main.className = "custom-slider-main";
    const range = document.createElement("input");
    range.type = "range";
    range.className = "custom-slider-range";
    const valueRow = document.createElement("div");
    valueRow.className = "custom-slider-value-row";
    const valueButton = document.createElement("button");
    valueButton.type = "button";
    valueButton.className = "custom-slider-value";
    const valueEditor = document.createElement("input");
    valueEditor.type = "number";
    valueEditor.className = "custom-slider-value-editor";
    valueEditor.hidden = true;
    valueRow.append(valueButton, valueEditor);
    main.append(range, valueRow);
    control.append(minusButton, main, plusButton);

    valueButton.addEventListener("click", () => openCustomSliderEditor(input));
    valueEditor.addEventListener("blur", () => closeCustomSliderEditor(input, { commit: true }));
    valueEditor.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        closeCustomSliderEditor(input, { commit: true });
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeCustomSliderEditor(input, { commit: false });
      }
    });
    range.addEventListener("input", () => {
      setNumberInputValue(input, range.value);
    });
    input.addEventListener("input", () => updateCustomSliderControl(input));
    input.addEventListener("change", () => updateCustomSliderControl(input));

    input._customSliderUi = {
      control,
      range,
      valueButton,
      valueEditor,
      minusButton,
      plusButton,
    };
    updateCustomSliderControl(input);
  });
}

export function enhanceNumberInputs(scope) {
  if (!scope) return;
  scope.querySelectorAll('input[type="number"]').forEach(input => {
    if (input.dataset.customSlider === "true") return;
    if (input.classList.contains("custom-slider-value-editor")) return;
    if (input.dataset.customStepper === "true") return;
    input.dataset.customStepper = "true";
    const wrapper = document.createElement("span");
    wrapper.className = "number-input-wrap";
    input.parentNode?.insertBefore(wrapper, input);
    const createButton = (direction, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `number-stepper-btn number-stepper-${direction > 0 ? "up" : "down"}`;
      button.textContent = label;
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => {
        if (input.disabled) return;
        if (direction > 0) input.stepUp();
        else input.stepDown();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return button;
    };
    wrapper.appendChild(createButton(-1, "-"));
    wrapper.appendChild(input);
    wrapper.appendChild(createButton(1, "+"));
  });
}
