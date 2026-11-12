/* Shared helpers for the manual test fixtures. */
'use strict';

(() => {
  const pending = [];
  let sink = null;

  function flush() {
    sink = document.getElementById('log');
    if (!sink) return;
    for (const item of pending.splice(0)) sink.append(item);
  }

  function log(text, tone) {
    const line = document.createElement('div');
    line.className = 'line' + (tone ? ' ' + tone : '');
    line.textContent = text;
    if (sink) sink.append(line);
    else pending.push(line);
  }

  window.THG = {
    log,

    /** Subscribes to the guard's DOM event so blocks are visible on the page. */
    watch() {
      document.addEventListener('thg:blocked', (event) => {
        const detail = event.detail || {};
        log(`DIBLOKIR oleh ekstensi — ${detail.kind} / ${detail.reason}`, 'blocked');
      });
    },

    /** Interprets whatever window.open returned. */
    reportOpened(handle) {
      if (handle && handle.__thgStub) log('DIBLOKIR — ekstensi mengembalikan stub', 'blocked');
      else if (handle) log('DIIZINKAN — tab/jendela baru terbuka', 'allowed');
      else log('DIBLOKIR browser — window.open mengembalikan null', 'blocked');
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', flush);
  } else {
    flush();
  }
})();
