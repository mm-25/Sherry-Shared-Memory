import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("const backdropPointerStarts = new WeakMap();");
const end = source.indexOf("function renderPipelineDetails()", start);
assert.ok(start >= 0 && end > start);
const context = { WeakMap };
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.handlers = { rememberDialogBackdropPointer, closeDialogFromBackdrop };`, context);
const { rememberDialogBackdropPointer, closeDialogFromBackdrop } = context.handlers;

function dialog() {
  return {
    closed: false,
    close() { this.closed = true; },
    getBoundingClientRect() { return { left: 100, right: 500, top: 100, bottom: 500 }; }
  };
}

test("a native sort-option click outside the dialog bounds does not dismiss it", () => {
  const target = dialog();
  const select = {};
  rememberDialogBackdropPointer({ currentTarget: target, target: select, clientX: 450, clientY: 130 });
  closeDialogFromBackdrop({ currentTarget: target, target, clientX: 550, clientY: 130 });
  assert.equal(target.closed, false);
});

test("a deliberate backdrop pointer click still dismisses the dialog", () => {
  const target = dialog();
  rememberDialogBackdropPointer({ currentTarget: target, target, clientX: 550, clientY: 130 });
  closeDialogFromBackdrop({ currentTarget: target, target, clientX: 550, clientY: 130 });
  assert.equal(target.closed, true);
});
