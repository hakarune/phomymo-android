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
 *
 * Visibility is controlled entirely via this panel's own inline
 * `style.display`, never via a CSS class. A previous version used the
 * Tailwind `hidden` utility class, but also set `display:flex` directly in
 * the same inline `style` attribute - an inline style always wins over a
 * class-based rule of the same property (regardless of whether Tailwind's
 * CDN runtime ever generated that rule), so toggling the class did
 * nothing: the panel was permanently visible from first paint, and
 * Close/Clear *looked* broken because their classList changes had zero
 * visual effect (Copy "worked" only because it doesn't touch the class at
 * all). Confirmed on a real device, not just suspected.
 */
(function () {
  var MAX_LINES = 2000;
  var lines = [];
  var panelEl = null;
  var logEl = null;
  var visible = false;

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
    if (logEl && visible) {
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

  function setVisible(next) {
    visible = next;
    panelEl.style.display = visible ? 'flex' : 'none';
    if (visible) renderLog();
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
        'font-size:12px;padding:8px 12px;border-radius:8px;min-height:36px;' +
        'background:rgba(31,41,55,0.65);color:#fff;border:none;' +
        'font-family:system-ui,sans-serif;'
    );

    panelEl = document.createElement('div');
    panelEl.id = 'debug-log-panel';
    // display is set exclusively by setVisible() below - never put a
    // display value here, and never rely on a CSS class for this element.
    panelEl.setAttribute(
      'style',
      'position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
        'height:min(32vh, 260px);display:none;' +
        'flex-direction:column;background:#111827;color:#d1d5db;' +
        'font-family:system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,0.3);'
    );
    panelEl.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#1f2937;flex-shrink:0;">' +
      '<span style="font-size:13px;font-weight:600;">Debug log</span>' +
      '<div style="display:flex;gap:8px;">' +
      '<button data-action="copy" style="font-size:12px;padding:6px 10px;border-radius:6px;background:#374151;color:#fff;border:none;min-height:32px;">Copy</button>' +
      '<button data-action="clear" style="font-size:12px;padding:6px 10px;border-radius:6px;background:#374151;color:#fff;border:none;min-height:32px;">Clear</button>' +
      '<button data-action="close" style="font-size:13px;font-weight:700;padding:6px 14px;border-radius:6px;background:#dc2626;color:#fff;border:none;min-height:32px;">✕ Close</button>' +
      '</div></div>' +
      '<pre id="debug-log-content" style="flex:1;margin:0;padding:8px 10px;overflow-y:auto;font-size:10.5px;line-height:1.4;white-space:pre-wrap;word-break:break-all;"></pre>';

    document.body.appendChild(btn);
    document.body.appendChild(panelEl);
    logEl = panelEl.querySelector('#debug-log-content');

    btn.addEventListener('click', function () {
      setVisible(!visible);
    });

    panelEl.querySelector('[data-action="close"]').addEventListener('click', function () {
      setVisible(false);
    });
    // Also close on tapping/clicking the header bar itself (outside the
    // three buttons) and on Escape, as bigger/easier close targets.
    panelEl.firstElementChild.addEventListener('click', function (e) {
      if (e.target === panelEl.firstElementChild || e.target.tagName === 'SPAN') setVisible(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && visible) setVisible(false);
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
