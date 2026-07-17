import { getOpenBoard } from "../src/index.js";

const openboard = getOpenBoard();
const field = document.querySelector<HTMLTextAreaElement>("textarea");
if (!field) throw new Error("sticky note textarea is missing");

window.addEventListener("openboard:init", () => {
  field.value = String(openboard.getState().state?.text ?? "");
});
field.addEventListener("input", () => openboard.patch({ state: { text: field.value } }));
openboard.ready();
