/* Headless check for the browser engine: loads the same two files the page
   loads, in the same order, inside a VM that stands in for the browser. Catches
   the class of bug that only appears at runtime — the notesFor() crash once
   shipped past two syntax checks.

   Note the fetch stub: the engine runs in its own VM global, so assigning
   global.fetch in the test process does nothing. It has to be injected here. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', 'web');

const ctx = { console, setTimeout, clearTimeout, URL, AbortController, DOMException };
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.document = {}; ctx.navigator = {}; ctx.location = {};
ctx.__fetch = null;
ctx.fetch = (...args) => {
  if (!ctx.__fetch) throw new Error('no fetch stub installed');
  return ctx.__fetch(...args);
};
vm.createContext(ctx);
for (const f of ['archiver-knowledge.js', 'archiver-comprehension.js', 'archiver-engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
module.exports = ctx.Archiver;
module.exports.__ctx = ctx;
