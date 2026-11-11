/* Archiver 5.6 — temporary minimal prep controller.
   Full controller is being restored; this keeps the app loading. */
(function (root) {
  'use strict';
  var VERSION = '5.6';
  var S = { version: VERSION, phase: 'idle', backend: null, model: null, reason: 'Prepare now to load the model.', auto: true, cancelled: false, pct: 0, error: null, durable: null, persist: 'unknown' };
  var subs = [];
  function emit() { for (var i = 0; i < subs.length; i++) try { subs[i](snapshot()); } catch (_) {} }
  function snapshot() { var o = {}; for (var k in S) o[k] = S[k]; return o; }
  function setPhase(p, patch) { S.phase = p; if (patch) for (var k in patch) S[k] = patch[k]; emit(); }
  root.ArchiverPrep = {
    VERSION: VERSION,
    init: function () { return Promise.resolve(); },
    configure: function () {},
    scheduleAuto: function () {},
    maybeAuto: function () { return Promise.resolve(false); },
    prepareNow: function () {
      setPhase('failed', { reason: 'Model preparation module is being restored. Hard-refresh after the next deploy.', error: { category: 'runtime', message: 'prep stub' } });
      return Promise.resolve(false);
    },
    ensureReady: function () { return Promise.resolve(false); },
    cancel: function () { S.cancelled = true; },
    setAuto: function (on) { S.auto = !!on; emit(); return S.auto; },
    status: snapshot,
    subscribe: function (fn) { subs.push(fn); return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
    reportFailure: function () {}
  };
})(typeof self !== 'undefined' ? self : this);
