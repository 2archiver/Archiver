/* Archiver — incremental SHA-256 for model files (no crypto.subtle buffering).

   crypto.subtle.digest needs the whole file in memory, which is the wrong
   shape for a model that is hundreds of megabytes on a phone. This module
   hashes a Blob in fixed-size slices, so memory stays at one slice no matter
   how large the file is. It runs in the hash worker (archiver-hash-worker.js)
   when one is available, and on the page otherwise.

   Exposed as globalThis.ArchiverSHA256 in browsers and workers, and as a
   CommonJS export for the Node test suite (tests/prep.js checks it against
   node:crypto on random data and on every slice boundary). */
(function (root) {
  'use strict';

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  var SLICE = 8 * 1024 * 1024;

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function SHA256() { this.reset(); }

  SHA256.prototype.reset = function () {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.totalBytes = 0;
    this.w = new Uint32Array(64);
    return this;
  };

  SHA256.prototype._compress = function (buf, off) {
    var w = this.w;
    var h = this.h;
    var i;
    for (i = 0; i < 16; i++) {
      var j = off + i * 4;
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (i = 16; i < 64; i++) {
      var x = w[i - 15];
      var y = w[i - 2];
      var s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      var s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3];
    var e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e;
      e = (d + t1) | 0;
      d = c; c = b; b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  };

  /* Feed bytes (a Uint8Array). Safe to call with any split of the input. */
  SHA256.prototype.update = function (data) {
    var len = data.length;
    var pos = 0;
    this.totalBytes += len;
    if (this.blockLen > 0) {
      var take = Math.min(64 - this.blockLen, len);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      pos = take;
      if (this.blockLen === 64) {
        this._compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    while (len - pos >= 64) {
      this._compress(data, pos);
      pos += 64;
    }
    if (pos < len) {
      this.block.set(data.subarray(pos), 0);
      this.blockLen = len - pos;
    }
    return this;
  };

  /* Finish and return lowercase hex. The object is spent afterwards. */
  SHA256.prototype.digestHex = function () {
    var bytes = this.totalBytes;
    var bitsHi = Math.floor(bytes / 0x20000000);      // high 32 bits of bytes*8
    var bitsLo = (bytes * 8) % 4294967296;            // low 32 bits of bytes*8
    var padLen = this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    var pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    pad[padLen] = (bitsHi >>> 24) & 255;
    pad[padLen + 1] = (bitsHi >>> 16) & 255;
    pad[padLen + 2] = (bitsHi >>> 8) & 255;
    pad[padLen + 3] = bitsHi & 255;
    pad[padLen + 4] = (bitsLo >>> 24) & 255;
    pad[padLen + 5] = (bitsLo >>> 16) & 255;
    pad[padLen + 6] = (bitsLo >>> 8) & 255;
    pad[padLen + 7] = bitsLo & 255;
    this.update(pad);
    var out = '';
    for (var i = 0; i < 8; i++) {
      out += ('00000000' + (this.h[i] >>> 0).toString(16)).slice(-8);
    }
    return out;
  };

  /* Hash a whole Uint8Array in one call (used by the Node tests). */
  function sha256Hex(bytes) {
    return new SHA256().update(bytes).digestHex();
  }

  /* Stream a Blob (or File) through the hasher one slice at a time. The
     optional onProgress(done, total) is throttled to about four calls a
     second, so a 400 MB file produces a few hundred messages, not thousands. */
  async function hashBlob(blob, options) {
    var opts = options || {};
    var slice = opts.chunk > 0 ? opts.chunk : SLICE;
    var total = blob.size;
    var hasher = new SHA256();
    var done = 0;
    var last = 0;
    while (done < total) {
      var end = Math.min(total, done + slice);
      var buf = new Uint8Array(await blob.slice(done, end).arrayBuffer());
      if (buf.length !== end - done) throw new Error('short read at byte ' + done);
      hasher.update(buf);
      done = end;
      if (typeof opts.onProgress === 'function') {
        var now = Date.now();
        if (done === total || now - last >= 250) {
          last = now;
          opts.onProgress(done, total);
        }
      }
    }
    return hasher.digestHex();
  }

  var api = { SHA256: SHA256, sha256Hex: sha256Hex, hashBlob: hashBlob, SLICE: SLICE };
  root.ArchiverSHA256 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
