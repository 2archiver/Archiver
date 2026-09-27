/* Download lifecycle regression; no browser or network required. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
for (const throws of [false, true]) {
  const events = [];
  let callback, delay, anchor;
  const ctx = {
    Blob,
    URL: {
      createObjectURL: () => { events.push('create'); return 'blob:test'; },
      revokeObjectURL: url => { assert.equal(url, 'blob:test'); events.push('revoke'); }
    },
    document: {
      body: { appendChild: a => { assert.equal(a, anchor); events.push('attach'); } },
      createElement: () => (anchor = {
        style: {},
        click() { events.push('click'); if (throws) throw Error('download blocked'); },
        remove() { events.push('remove'); }
      })
    },
    setTimeout: (fn, ms) => { callback = fn; delay = ms; }
  };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync('web/archiver-download.js', 'utf8'), ctx);
  const save = () => ctx.ArchiverDownload.save('hello', 'chat.md', 'text/markdown');
  if (throws) assert.throws(save, /blocked/); else save();
  assert.deepEqual(events, ['create', 'attach', 'click']);
  assert.equal(anchor.download, 'chat.md');
  assert.equal(anchor.target, '_blank');
  assert.equal(delay, 60000);
  callback();
  assert.deepEqual(events, ['create', 'attach', 'click', 'remove', 'revoke']);
}
console.log('Download attachment, navigation isolation and delayed cleanup checks passed.');
