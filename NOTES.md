# Notes, decisions, and deviations

Running log kept during the build. See the task prompt ("Phomymo Android App
Prompt.md") for the original plan this deviates from.

## Upstream

- Vendored commit: `transcriptionstream/phomymo@1f58d3f0e7f941b9143277cda828380149e56855` (2026-05-17).
- **License gap**: upstream's README states "MIT License - see LICENSE file
  for details," but no `LICENSE` file exists in the upstream repo (verified
  via clone + `gh api repos/transcriptionstream/phomymo` → `license: null`),
  and `package.json` says `"license": "ISC"` (looks like an unedited
  `npm init` default, not an intentional choice). This repo's `LICENSE`
  uses standard MIT text on the strength of the README's explicit
  statement. See `NOTICE.md` for details. If upstream ever adds a real
  LICENSE file, reconcile with it.
- `src/web/_headers` (a Cloudflare Pages cache-control config file) was
  copied along with the rest of `src/web` to honor "keep file structure,"
  but it has no effect in a Capacitor/WebView context and can be ignored or
  deleted.
- The upstream repo's root-level `screenshot.png` / `screenshot-mobile.png`
  are referenced by SEO `<meta>` tags (og:image, twitter:image, JSON-LD) in
  `index.html` pointing at `https://phomymo.affordablemagic.net/screenshot.png`.
  These are inert in a packaged app (no crawler will ever see them, and
  `<meta>` content attributes are not auto-fetched by the WebView), so they
  were left as dead metadata rather than vendoring unused images.
- `www/docs/` (manual.html + ~25 screenshot PNGs, ~6MB) was copied verbatim
  from upstream's `src/web/docs/`. It's upstream's user manual; it bloats
  the APK slightly but isn't wired into the app's own UI. Left in place for
  fidelity to "keep file structure"; safe to delete later if APK size matters.

## Offline vendoring (Step 3)

External runtime dependencies found via grep and vendored under `www/vendor/`:

| Dependency | Was loaded from | Now at |
|---|---|---|
| Tailwind CSS (JIT, play-cdn build) | `cdn.tailwindcss.com` | `vendor/js/tailwindcss-cdn.js` |
| Google Fonts CSS + 62 woff2 files (10 families) | `fonts.googleapis.com` / `fonts.gstatic.com` | `vendor/css/google-fonts.css` + `vendor/fonts/*.woff2` |
| JsBarcode 3.11.5 | jsdelivr | `vendor/js/JsBarcode.all.min.js` |
| QRCode.js 1.5.1 | cdnjs | `vendor/js/qrcode.min.js` |
| jsPDF 2.5.1 | cdnjs | `vendor/js/jspdf.umd.min.js` |
| pdf.js 4.0.379 (+ worker) | cdnjs | `vendor/js/pdf.min.mjs`, `vendor/js/pdf.worker.min.mjs` |
| "Affordable Magic" promo logo (`<img>`, rendered unconditionally in header/footer/about-dialog, 4 call sites across index.html + app.js) | `affordablemagic.net` | `vendor/images/affordablemagic-400w.png` |

Verified by grepping all of `www/` for `http(s)://`: only remaining hits are
SVG/XML namespace strings (`w3.org`), inert SEO `<meta>` content, and
user-initiated outbound links (GitHub repo, Stripe donate, affordablemagic.net
homepage) that require an explicit tap and open the system browser — none of
these fire automatically. `fetch('./printers.json')` in `printer.js` is a
same-origin relative fetch and works offline inside the packaged app.
`pdf.js` usage in `canvas.js` only ever calls `getDocument({ data: ... })`
with local file bytes (never a URL), and jsPDF usage in `app.js` only calls
`.save()`, not the `pdfobjectnewwindow` option (the only jsPDF code path that
would reach out to a CDN) — so neither library makes network calls in
practice.

## Environment: shared storage has no symlink support (Step 4)

`/storage/emulated/0/Programs/Github` (this project's location, per the
task) is a FUSE filesystem (confirmed via `stat -f`: `Type: fuse`). FUSE on
this device does not support symlinks (`ln -s` here fails with
`Permission denied`). `npm install` relies on symlinks for
`node_modules/.bin/*`, so installing `@capacitor/cli` directly in this
directory failed with `EACCES ... symlink`.

**Workaround**: all `npm install` / `npx cap ...` commands were run in a
scratch mirror on Termux's native filesystem
(`/data/data/com.termux/files/home/build-mirrors/phomymo-android`, which
does support symlinks), then the generated/edited source files (`android/`
minus build outputs, `capacitor.config.json`, `package.json`,
`package-lock.json`) were `rsync`'d back into the real project directory.
`node_modules/` itself is never synced back (it's gitignored and CI
reinstalls it fresh via `npm ci` on a normal Linux filesystem, which has no
symlink problem). This mirror is scratch-only and not part of the repo;
if continuing this project locally in future, re-run `npm install` in the
mirror before using `npx cap` commands rather than running them directly
in the git-tracked folder.

Capacitor's `npx cap add android` itself worked fine (no symlink step
needed): installed `@capacitor/core`, `@capacitor/android`, `@capacitor/cli`
(dev), `@capacitor-community/bluetooth-le`, all at their latest versions
compatible together (Capacitor 8.6.0, bluetooth-le 8.3.0 which requires
`@capacitor/core >=8.0.0`). minSdk/targetSdk/compileSdk were left at the
Capacitor-8 defaults (24/36/36). `allowBackup` set to `false`. `INTERNET`
permission removed from the manifest (commented explanation left in place);
this is unverified on a real device — see the comment in
`android/app/src/main/AndroidManifest.xml` and restore it first if the app
shows a blank screen on first launch. `BLUETOOTH_SCAN` is declared with
`usesPermissionFlags="neverForLocation"` (overriding the plugin's own
manifest entry via `tools:node="replace"`) since the app only connects to
named printers and never derives physical location from scan results; the
corresponding `androidNeverForLocation: true` option is passed in Step 5's
`ble-native.js`, at `BleClient.initialize()` time (not per-scan-call - that's
where the real plugin's `InitializeOptions` actually expects it).

## Native BLE transport (Step 5)

- **No bundler, so Capacitor's JS runtime is vendored as classic UMD scripts,
  not ESM.** The plugin's recommended usage is `import { BleClient } from
  '@capacitor-community/bluetooth-le'`, but its ESM build (`dist/esm/*.js`)
  uses a bare `import ... from '@capacitor/core'` specifier that only
  resolves with a bundler. Its "unpkg" browser builds don't have that
  problem: `@capacitor/core`'s `dist/capacitor.js` is a self-contained UMD
  that defines `window.capacitorExports` (and augments the native-injected
  `window.Capacitor` with `Plugins`/`registerPlugin`/etc.), and the plugin's
  `dist/plugin.js` is `(function(exports, core){...})({}, capacitorExports)`
  - i.e. it expects `capacitorExports` as a plain global, which is exactly
    what loading `capacitor.js` via a classic `<script src>` tag produces.
  So both are vendored as plain classic scripts (`vendor/js/capacitor-core.js`,
  `vendor/js/capacitor-bluetooth-le.js`, loaded in that order, before
  `app.js`), giving `window.capacitorCommunityBluetoothLe.BleClient` with no
  bundler needed. This is harmless outside the native app too: in a plain
  browser `window.Capacitor.isNativePlatform()` is `false` (the platform
  detection in `capacitor.js` only recognizes `window.androidBridge` /
  `window.webkit.messageHandlers.bridge`, neither of which exist in a
  regular browser), so `ble-native.js`'s `isAvailable()` stays false and
  `ble.js` (Web Bluetooth) is used instead, same as before.
- **Custom device-picker UI instead of the plugin's native `requestDevice()`
  dialog.** Web Bluetooth's `requestDevice()` takes a `filters` array (OR of
  many `{namePrefix}` entries), which is how upstream's `ble.js` matches 8
  different printer name prefixes in one call. This plugin's
  `requestDevice()`/`RequestBleDeviceOptions` only accepts a single
  `name`/`namePrefix` string - no OR-of-many-prefixes equivalent. Rather
  than restrict native users to one prefix (or always show every nearby BLE
  device), `ble-native.js` scans unfiltered via `requestLEScan()` and
  renders its own in-app device list (filtering by the same 8 prefixes
  client-side, with a "show all devices" checkbox, sorted by RSSI). This
  also means RSSI is actually visible per device, matching the upstream
  README's connection tip ("select the device showing a signal strength
  indicator") more directly than the OS picker would.
- **Protocol parsing shared, not duplicated.** `ble.js` was refactored to
  export `QUERY_COMMANDS` and a new pure function `parseNotificationFrame()`
  (previously private to the `BLETransport` class/inline in
  `handleNotification`). `ble-native.js` imports both, so the GATT
  service/characteristic UUIDs, chunk size/delay (`constants.js`'s `BLE`
  object), status-query command bytes, and notification-frame parsing all
  come from one place for both transports - they cannot drift apart. This
  was verified behavior-preserving field-by-field against the original
  switch statement (see commit diff).
- `waitForResponse()` (used only by the P12 protocol family in `printer.js`,
  not by the M110) is implemented in `ble-native.js` via an internal waiter
  queue resolved from the single `startNotifications` callback, since the
  plugin (unlike Web Bluetooth characteristics) doesn't support attaching a
  second concurrent listener to the same characteristic.
- **`checkCompatibility()` in `app.js` had to be patched.** It previously
  set `state.canPrint = false` whenever `'bluetooth' in navigator` is false
  - which is always true in an Android WebView (no Web Bluetooth there) -
  and `handleConnect()` hard-blocks printing when `canPrint` is false. Left
  unpatched, the native app would always show the "Limited Browser Support"
  warning and refuse to print, even with a working native BLE transport.
  Fixed by skipping the browser-only checks (`isSecureContext`,
  `navigator.bluetooth`, `navigator.usb`) when `isNativeApp()` is true.
- **USB/PM-241 hiding mostly happens for free.** Upstream's `init()` already
  removes the desktop `#conn-type` dropdown's "USB" option when
  `!('usb' in navigator)` - true automatically in a WebView, no native-specific
  code needed. One real gap found and fixed: upstream never removed the
  equivalent option from the **mobile** menu's `#mobile-conn-type` select
  (a latent upstream inconsistency, not native-specific - it affects any
  browser without WebUSB, e.g. Firefox/Safari too), which matters a lot here
  since the native app always renders at phone width. Added a console log
  (visible in the Debug log panel) explaining why USB disappeared, since
  upstream's existing message is a generic `console.warn` easy to miss.
- **M110C (Bluetooth Classic) is fundamentally unsupported** - this plugin
  only talks BLE, and Android's BLE scan simply never sees a Classic/SPP
  device, so an M110C won't appear in the device list at all. Upstream
  itself has zero mentions of "M110C" anywhere in its code. Added a help
  line in the device-picker modal footer; also needs a mention in
  README.md's Limitations section (Step 7).
- **Permission denial**: `BleClient.initialize()`/`connect()` errors whose
  message matches `/permission|denied/i` trigger a dedicated in-app dialog
  with an "Open Settings" button (`BleClient.openAppSettings()`), rather
  than just a generic status-bar error message.
- **Debug log panel** (`debug-log.js`): patches `console.log/warn/error` and
  `window.onerror`/`unhandledrejection` into a 2000-line ring buffer, shown
  via a small always-present "Debug log" button (bottom-left) with Copy/
  Clear/Close. Present in both the native app and the browser fallback.
- **Another dormant network path, like pdf.js's (Step 3)**: the vendored
  `vendor/js/capacitor-core.js` bundles a `CapacitorHttp` web-plugin whose
  `request()` method calls `fetch()`. Nothing in this app calls
  `Capacitor.Plugins.CapacitorHttp.*`, so it's unreachable today - but if a
  future change ever does (e.g. a "check for updates" feature), that would
  reintroduce a real network call. Vendoring a smaller, hand-picked subset
  of `@capacitor/core` instead of its full bundle was considered but judged
  not worth the added maintenance risk for ~8KB of unreachable code.
- All of the above is static-analysis/code-review verified only - **nothing
  in Step 5 has been exercised on a real device or even in a real browser
  yet.** The custom scan/picker UI, the service/characteristic UUID
  matching against `getServices()`, and the permission-denial dialog in
  particular should get extra attention during the first real-device test
  (see TESTING.md, Step 7).

## Pending / to be continued

- Step 6+ (CI build/signing, docs) not yet started as of this note.
