/* Keep downloads separate from top-level navigation. Safari can dereference a
   blob asynchronously, so a detached anchor and a 1-second revoke race it.
   This does not make blob: URLs durable bookmarks: use the HTTPS site URL. */
(function () {
  'use strict';
  function save(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(url);
      }, 60000);
    }
  }
  window.ArchiverDownload = { save };

  /* 5.6: load browser search on static hosts (github.io) so WEB works without Render.
     5.7: only when the page did not already load it. Since 5.7 the module ships as
     a deferred script tag as well, and loading it twice would register the same
     installer twice (harmless, but a wasted request on a slow phone). */
  try {
    if (!window.ArchiverBrowserSearch) {
      var s = document.createElement('script');
      s.src = new URL('static/archiver-browser-search.js', document.baseURI).href;
      s.async = false;
      document.head.appendChild(s);
    }
  } catch (_) {}
})();
