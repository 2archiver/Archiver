/* Archiver — streams a stored model file through SHA-256 off the main thread.

   Request:  { id, blob, chunk? }      (blob = a File/Blob read from storage)
   Replies:  { id, type: 'progress', done, total }   throttled
             { id, type: 'done', hex }
             { id, type: 'error', message }

   The page never buffers the file: each slice is read, hashed and dropped. */
'use strict';
importScripts('archiver-sha256.js');

self.onmessage = function (event) {
  var msg = event.data || {};
  var id = msg.id;
  self.ArchiverSHA256.hashBlob(msg.blob, {
    chunk: msg.chunk,
    onProgress: function (done, total) {
      self.postMessage({ id: id, type: 'progress', done: done, total: total });
    }
  }).then(function (hex) {
    self.postMessage({ id: id, type: 'done', hex: hex });
  }, function (err) {
    self.postMessage({ id: id, type: 'error', message: String((err && err.message) || err) });
  });
};
