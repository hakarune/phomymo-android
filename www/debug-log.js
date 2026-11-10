/**
 * In-app debug log panel.
 *
 * Captures console.log/warn/error output (both ble.js and ble-native.js
 * already log every BLE step verbosely) into a ring buffer and shows it in
 * a small slide-up panel with a "Copy" button, so a real-device tester who
 * hits a connection problem can copy the log and paste it back for
 * debugging, without needing `adb logcat` or a USB cable.
 *
 * Plain classic script (not a module) loaded early in index.html, so the
 * console patch is installed before app.js's first log call.
 */
(function () {
  var MAX_LINES = 2000;
  var lines = [];
  var panelEl = null;
  var logEl = null;

  function timestamp() {
    var d = new Date();
    return (
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0') + '.' +
      String(d.getMilliseconds()).padStart(3, '0')
    );
  }

  function formatArgs(args) {
    return Array.from(args)
      .map(function (a) {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch (e) {
          return String(a);
        }
      })
      .join(' ');
  }

  function record(level, args) {
    var line = '[' + timestamp() + '] ' + level + ' ' + formatArgs(args);
    lines.push(line);
    if (lines.length > MAX_LINES) {
      lines.splice(0, lines.length - MAX_LINES);
    }
    if (logEl && panelEl && !panelEl.classList.contains('hidden')) {
      renderLog();
    }
  }

  ['log', 'warn', 'error'].forEach(function (level) {
    var original = console[level].bind(console);
    console[level] = function () {
      record(level.toUpperCase(), arguments);
      original.apply(console, arguments);
    };
  });

  window.addEventListener('error', function (e) {
    record('ERROR', ['Uncaught:', e.message, e.filename + ':' + e.lineno]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    record('ERROR', ['Unhandled promise rejection:', e.reason && e.reason.message || e.reason]);
  });

  function renderLog() {
    logEl.textContent = lines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function copyLog() {
    var text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Fallback for contexts without Clipboard API permission
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function buildPanel() {
    var btn = document.createElement('button');
    btn.id = 'debug-log-toggle';
    btn.textContent = 'Debug log';
    btn.setAttribute(
      'style',
      'position:fixed;left:8px;bottom:8px;z-index:9999;' +
        'font-size:11px;padding:4px 8px;border-radius:6px;' +
        'background:rgba(31,41,55,0.75);color:#fff;border:none;' +
        'font-family:system-ui,sans-serif;opacity:0.55;'
    );

    panelEl = document.createElement('div');
    panelEl.id = 'debug-log-panel';
    panelEl.className = 'hidden';
    panelEl.setAttribute(
      'style',
      'position:fixed;left:0;right:0;bottom:0;z-index:9999;height:40vh;' +
        'background:#111827;color:#d1d5db;display:flex;flex-direction:column;' +
        'font-family:system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,0.3);'
    );
    panelEl.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#1f2937;flex-shrink:0;">' +
      '<span style="font-size:12px;font-weight:600;">Debug log</span>' +
      '<div style="display:flex;gap:6px;">' +
      '<button data-action="copy" style="font-size:11px;padding:3px 8px;border-radius:5px;background:#374151;color:#fff;border:none;">Copy</button>' +
      '<button data-action="clear" style="font-size:11px;padding:3px 8px;border-radius:5px;background:#374151;color:#fff;border:none;">Clear</button>' +
      '<button data-action="close" style="font-size:11px;padding:3px 8px;border-radius:5px;background:#374151;color:#fff;border:none;">Close</button>' +
      '</div></div>' +
      '<pre id="debug-log-content" style="flex:1;margin:0;padding:8px 10px;overflow-y:auto;font-size:10.5px;line-height:1.4;white-space:pre-wrap;word-break:break-all;"></pre>';

    document.body.appendChild(btn);
    document.body.appendChild(panelEl);
    logEl = panelEl.querySelector('#debug-log-content');

    btn.addEventListener('click', function () {
      panelEl.classList.toggle('hidden');
      if (!panelEl.classList.contains('hidden')) renderLog();
    });

    panelEl.querySelector('[data-action="close"]').addEventListener('click', function () {
      panelEl.classList.add('hidden');
    });
    panelEl.querySelector('[data-action="clear"]').addEventListener('click', function () {
      lines = [];
      renderLog();
    });
    panelEl.querySelector('[data-action="copy"]').addEventListener('click', async function (e) {
      var ok = await copyLog();
      var original = e.target.textContent;
      e.target.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(function () {
        e.target.textContent = original;
      }, 1200);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
