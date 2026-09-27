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
    // If a browser opens instead of downloads, do not replace the app's tab.
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      // There is no cross-browser download-complete event. Give Safari a full
      // minute to start consuming the URL, then release the temporary objects.
      setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(url);
      }, 60000);
    }
  }
  window.ArchiverDownload = { save };
})();
