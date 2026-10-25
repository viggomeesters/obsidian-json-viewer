import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import esbuild from "esbuild";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLDetailsElement = dom.window.HTMLDetailsElement;
const prototype = dom.window.HTMLElement.prototype;
prototype.appendText = function (text) { this.appendChild(document.createTextNode(text)); };
prototype.empty = function () { this.replaceChildren(); };
prototype.addClass = function (...classes) { this.classList.add(...classes); };
prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
prototype.toggleClass = function (name, enabled) { this.classList.toggle(name, enabled); };
prototype.setText = function (text) { this.textContent = text; };
prototype.instanceOf = function (kind) { return this instanceof kind; };
prototype.scrollIntoView = function () {};
prototype.createEl = function (tag, options = {}) {
  const el = document.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text) el.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
  this.appendChild(el);
  return el;
};
prototype.createDiv = function (options) { return this.createEl("div", options); };
prototype.createSpan = function (options) { return this.createEl("span", options); };
globalThis.createDiv = (options) => document.createElement("div").createDiv(options);

class TFile { constructor(extension) { this.extension = extension; this.basename = "fixture"; this.path = `fixture.${extension}`; this.name = this.path; } }
class TextFileView { constructor() { this.contentEl = document.createElement("div"); } }
class Plugin {
  registerView(_id, factory) { this.factory = factory; }
  registerExtensions() {}
  addCommand() {}
}
const stubs = { Plugin, TFile, TextFileView, Notice: class {}, setIcon() {} };
const result = await esbuild.build({ entryPoints: ["src/main.ts"], bundle: true, format: "cjs", platform: "browser", external: ["obsidian"], write: false, logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)((name) => { assert.equal(name, "obsidian"); return stubs; }, module, module.exports);
const plugin = new module.exports.default();
await plugin.onload();
const view = plugin.factory({});
view.file = new TFile("json");
const content = JSON.stringify(Array.from({ length: 1600 }, (_, index) => ({ id: index, value: `row-${index}` })));
view.setViewData(content);
assert.ok(view.contentEl.querySelectorAll("*").length < 6000, "initial DOM must stay bounded for a large document");
assert.equal(view.contentEl.querySelector(".json-viewer__raw pre"), null, "collapsed raw source must remain lazy");

const root = view.contentEl.querySelector(".json-viewer__tree details");
assert.ok(root);
assert.ok(view.contentEl.querySelector(".json-viewer__more"), "large arrays offer paging");
const before = root.children.length;
view.contentEl.querySelector(".json-viewer__more").click();
assert.ok(root.children.length > before, "paging actually creates another batch");
assert.ok(root.children.length < 600, "one click does not render every record");

const search = view.contentEl.querySelector("input");
search.value = "row-1599";
search.dispatchEvent(new dom.window.Event("input"));
await new Promise((resolve) => window.setTimeout(resolve, 250));
assert.match(view.contentEl.querySelector(".json-viewer__tree").textContent, /row-1599/, "search finds an unrendered record");
assert.ok(view.contentEl.querySelectorAll("*").length < 6000);

const raw = view.contentEl.querySelector(".json-viewer__raw");
raw.open = true;
raw.dispatchEvent(new dom.window.Event("toggle"));
assert.ok(raw.querySelector("pre"), "opening raw source really renders it");

view.file = new TFile("jsonl");
view.setViewData('{"a/b":{"~key":1}}\ninvalid\n');
assert.match(view.contentEl.textContent, /Parse errors/);
assert.ok(view.contentEl.querySelector('[data-path="/0/a~1b/~0key"]'), "JSONL pointers retain escaped keys and record identity");
const copyButtons = view.contentEl.querySelectorAll(".json-viewer__copy");
assert.ok(copyButtons.length > 0);

view.file = new TFile("json");
view.setViewData(JSON.stringify("hello needle"));
const scalarSearch = view.contentEl.querySelector("input");
scalarSearch.value = "needle";
scalarSearch.dispatchEvent(new dom.window.Event("input"));
await new Promise((resolve) => window.setTimeout(resolve, 250));
assert.match(view.contentEl.querySelector(".json-viewer__tree").textContent, /hello needle/);

view.setViewData(content);
const longRaw = view.contentEl.querySelector(".json-viewer__raw");
longRaw.open = true;
longRaw.dispatchEvent(new dom.window.Event("toggle"));
assert.ok(longRaw.querySelectorAll("*").length < 8000, "one minified source line must also be paged");
assert.ok(longRaw.querySelector("button"), "long lines provide source paging");
while (longRaw.querySelector("button")) longRaw.querySelector("button").click();
assert.equal(Array.from(longRaw.querySelectorAll(".json-viewer__source-code")).map((el) => el.textContent).join("\n"), content, "source paging retains every character without duplication");
view.clear();
assert.equal(view.contentEl.children.length, 0);
dom.window.close();
console.log("JSON rendering, paging, source laziness and JSONL preservation passed.");
