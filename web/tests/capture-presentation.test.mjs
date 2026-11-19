import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const context = {};
const source = await readFile(new URL("../capture-presentation.js", import.meta.url), "utf8")
  .catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
vm.runInNewContext(source, context);
function helper() {
  assert.ok(context.SherryCapturePresentation, "The capture presentation helper is missing");
  return context.SherryCapturePresentation;
}
const labels = (chat) => Array.from(helper().sourceCategories(chat), (item) => item.label);

test("missing provenance never masquerades as Web", () => {
  assert.deepEqual(labels({}), ["Unknown source"]);
});
test("native phone and desktop origins stay distinct from browser capture", () => {
  assert.deepEqual(labels({ primary_surface: "android" }), ["Mobile"]);
  assert.deepEqual(labels({ primary_surface: "desktop" }), ["Desktop"]);
  assert.deepEqual(labels({ primary_surface: "web" }), ["Web"]);
});
test("terminal and IDE sources are described as desktop capture", () => {
  for (const surface of ["cli", "ide"]) assert.deepEqual(labels({ primary_surface: surface }), ["Desktop"]);
});
test("detail exposes all recorded device categories without repeating Desktop", () => {
  assert.deepEqual(labels({ primary_surface: "web", events: [
    { surface: "android" }, { surface: "ide" }, { surface: "desktop" }, { surface: "web" }
  ] }), ["Web", "Desktop", "Mobile"]);
});
test("a sparse detail can use recorded primary or explicit surface metadata", () => {
  assert.deepEqual(labels({ primary_surface: "android", events: [{ role: "user" }] }), ["Mobile"]);
  assert.deepEqual(labels({ capture_surfaces: ["web", "android"] }), ["Web", "Mobile"]);
});
test("invalid or future surface values remain unknown", () => {
  assert.deepEqual(labels({ primary_surface: "future-device" }), ["Unknown source"]);
});
test("speaker labels do not turn unknown or tool messages into AI answers", () => {
  const { speakerLabel } = helper();
  assert.equal(speakerLabel("user", "ChatGPT"), "You");
  assert.equal(speakerLabel("assistant", "ChatGPT"), "ChatGPT");
  assert.equal(speakerLabel("unknown", "ChatGPT"), "Shared excerpt");
  assert.equal(speakerLabel("tool", "ChatGPT"), "Tool");
  assert.equal(speakerLabel("system", "ChatGPT"), "System");
  assert.equal(speakerLabel("unrecognized", "ChatGPT"), "Message");
  assert.equal(speakerLabel("constructor", "ChatGPT"), "Message");
  assert.equal(speakerLabel("__proto__", "ChatGPT"), "Message");
});
