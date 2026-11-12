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

## CI build and release signing (Step 6)

- `.github/workflows/build-apk.yml`: triggers on push to `main`, `v*` tags,
  and manual `workflow_dispatch`. Runs on `ubuntu-latest` (a normal Linux
  filesystem - the symlink/FUSE issue from Step 4 only affects this local
  Termux environment, not CI). Steps: checkout, setup-node (LTS),
  setup-java (Temurin 17), `npm ci`, `npx cap sync android`, then either a
  signed `assembleRelease` or an unsigned-path `assembleDebug`, chosen by
  whether the `KEYSTORE_BASE64` secret is set. The choice is driven by a
  job-level `env.HAS_KEYSTORE` (set from `secrets.KEYSTORE_BASE64 != ''`),
  not by referencing `secrets.*` directly inside each step's `if:` -
  GitHub's docs say secrets can't be used directly in `if:` conditionals,
  so the secret is mirrored into an env var once and steps branch on that
  instead (caught by the Step 6 audit - the first version of this workflow
  used `if: secrets.KEYSTORE_BASE64 != ''` directly, which is unsupported).
  Uploads whichever APK was produced as a workflow artifact; on
  `v*` tags, also creates/updates a GitHub Release and attaches it via
  `gh release create`/`gh release upload` (the GitHub CLI, already on the
  runner, authenticated with the automatic `GITHUB_TOKEN` - avoided adding
  a third-party marketplace action for this step).
- `android/app/build.gradle`: added a `signingConfigs.release` block that
  only activates (reads `KEYSTORE_PATH`/`KEYSTORE_PASSWORD`/`KEY_ALIAS`/
  `KEY_PASSWORD` from the environment) when `KEYSTORE_PATH` is set, so a
  plain local `assembleRelease` with no env vars still produces a build
  (just unsigned) rather than erroring - though in practice the CI workflow
  only ever calls `assembleRelease` when the secret is present, falling
  back to `assembleDebug` otherwise.
- **Release keystore: generated.** The user chose to set up proper release
  signing. Java wasn't installed locally (confirmed absent in Step 0 - not
  needed to build, since CI does that), so `openjdk-17` was installed via
  `pkg install` just to get `keytool` (a reversible, standard dev-tool
  install, not a project change). Generated with
  `keytool -genkeypair -keyalg RSA -keysize 2048 -validity 10000`, alias
  `phomymo-android`. **Important correction while generating it**: modern
  `keytool` defaults to a PKCS12 keystore, which (unlike the old JKS format)
  does not support a separate key password from the store password -
  passing `-keypass` is silently ignored (keytool prints a warning).
  Verified this directly (opening the private key entry with the store
  password as the key password succeeds). So `KEY_PASSWORD` and
  `KEYSTORE_PASSWORD` must be set to the **same** value when creating the
  GitHub secrets in Step 8 - there is only one real password here, not two.
- The keystore file itself was written to
  `/storage/emulated/0/Download/phomymo-android-release.keystore` (outside
  this repo, as required - it is never git-tracked, and `*.keystore` is
  already in `.gitignore`). The password was shown to the user once in
  chat (not written to any file in this repo or elsewhere) with instructions
  to save it immediately in a password manager; it is not repeated here.
- `gh secret set` for `KEYSTORE_BASE64`/`KEYSTORE_PASSWORD`/`KEY_ALIAS`/
  `KEY_PASSWORD` is deferred to **Step 8**, since GitHub Actions secrets
  belong to a specific repo and the repo doesn't exist yet (it's created in
  Step 8, per the task prompt's own ordering: "Do NOT push or create
  anything on GitHub until Step 1 is confirmed").
- `.gitignore` re-checked against everything `cap add android`/`cap sync`
  have generated so far - already sufficient from Steps 3-4 (`*.keystore`
  covers the new keystore path too; android/.gitignore, auto-generated by
  Capacitor, separately covers `*.apk`/`capacitor.config.json`/
  `capacitor.plugins.json`/`config.xml` inside `android/`). No changes
  needed.

## Deviation: CI needs Java 21, not Java 17 (found during first real CI run, Step 8)

The task prompt specified Temurin 17 for the build workflow. The very
first CI run (triggered by pushing to GitHub in Step 8) failed with
`error: invalid source release: 21` compiling `:capacitor-android`.
`node_modules/@capacitor/android/capacitor/build.gradle` sets
`sourceCompatibility`/`targetCompatibility` to `JavaVersion.VERSION_21` -
Capacitor 8.6.0's own Android library requires a JDK that can compile for
Java 21, which JDK 17 cannot do. Changed
`.github/workflows/build-apk.yml`'s `setup-java` step to Temurin 21.
This is a hard requirement of the Capacitor version resolved in Step 4
(latest at the time, 8.6.0), not a mistake specific to this project.

## Documentation (Step 7)

- `README.md`: privacy statement, supported-printers table (built
  specifically for the M110, but **not yet verified on real hardware** -
  other upstream-supported models should work via the same BLE transport
  but are even less verified), Limitations (M110C unsupported - BLE scan
  never sees a Classic/SPP device at all; USB/PM-241 unavailable - WebView
  has no WebUSB), install instructions, and credits. The first draft of
  this section said the app had been "built and tested for the M110,"
  which the Step 7 audit correctly called out as a false claim contradicting
  this file's own "nothing has been exercised on a real device" notes
  elsewhere - fixed to say "built for" without implying real-hardware
  testing happened.
- `TESTING.md`: the first-real-device checklist requested by the task
  prompt - first connect, print text/QR/barcode, 40x30mm and 50x30mm
  labels, disconnect/reconnect, cold-restart the app, and an airplane-mode
  test (Bluetooth re-enabled) specifically to prove the no-network claim
  end to end, not just via static analysis.

## First real-device test findings (post-launch)

The app was installed on a real phone and the first connect attempt to an
M110 failed - this is the first real signal from actual hardware, not
static analysis, and found two genuine bugs:

1. **Native BLE `connect()` could hang indefinitely with zero log output.**
   Screenshots showed the Connect button stuck on "Connecting..." while
   the Debug log panel stayed completely empty - meaning some call inside
   `connect()` never resolved or rejected. The most likely culprit:
   `BleClient.initialize()` has no documented timeout at all (unlike
   `connect()`/`getServices()`/etc., which default to 10s/5s per the
   plugin's `TimeoutOptions`), so if the native side never responds, the
   whole chain just hangs forever with nothing to show for it. Fixed by
   adding a `withTimeout()` helper in `ble-native.js` and wrapping every
   native call that didn't already have a clear bound: `initialize()`
   (15s), `isEnabled()` (8s), the pre-connect `disconnect()` (5s),
   `connect()` itself (20s, as defense-in-depth beyond the plugin's own
   default), and `getServices()` (10s). Also added a `console.log` as the
   very first line of `connect()`, before anything that could hang, so the
   Debug log can never again be completely empty while a connect attempt
   is in progress - at minimum we'll know the native path was actually
   entered.
2. **The Debug log panel itself was a UX trap** - first attempt at a fix
   (reducing height, bigger Close button) didn't actually fix it. On
   retry, the user reported the panel was open immediately on launch, with
   no way to close it (Close/Clear appeared to do nothing - only Copy
   "worked"). **Root cause found and confirmed**: the panel's own inline
   `style` attribute set `display:flex` directly, while visibility was
   meant to be controlled by toggling a Tailwind `hidden` utility class
   (`display:none`). An inline style always wins over a class-based rule
   for the same property, regardless of whether Tailwind's CDN runtime
   ever generated that rule - so toggling the class could never have any
   visual effect, full stop. The panel was permanently visible from first
   paint. Close/Clear "looked" broken because their `classList` changes
   genuinely did nothing; Copy worked because it never touched the class
   at all. Rewrote `debug-log.js` to control visibility exclusively via a
   JS-owned `panelEl.style.display`, with the base inline style never
   setting `display` and no class involved anywhere. This is a purely
   mechanical CSS-specificity bug, not a Tailwind-timing issue as
   originally guessed.

Retrying on the device after the first round of fixes, the user confirmed
BLE connect to the M110 now works with no problem - so whatever caused the
original indefinite hang (timeout-bounded but not root-caused in the first
fix) is resolved in practice, whether that was the `withTimeout()` wrapper
genuinely catching a real hang, a stale app/Bluetooth-stack state cleared
by reinstalling, or both.

## Debug log panel removed (user request, after confirming it works)

The visibility fix above worked - the panel no longer opened itself. But
with BLE connect and printing both confirmed working on a real M110, the
user asked for the panel to be removed entirely: it was no longer needed,
and its floating toggle button (fixed bottom-left) was physically
obstructing the mobile toolbar's "Text" button. Deleted `www/debug-log.js`
and its `<script>` tag in `index.html`; updated stale comments in
`app.js`/`ble-native.js` and the "Debug log" instructions in `TESTING.md`
that referenced it. This overrides the original task prompt's Step 5
instruction to add an in-app log panel - reasonable given it served its
purpose (diagnosing the connect-hang bug) and the explicit, informed
request to remove it now that real-device testing no longer needs it. If
a future issue needs log capture again, `adb logcat` works fine for a
sideloaded APK, or the panel can be restored from git history
(`www/debug-log.js` as of commit `51c4aa1`).

## App icon (replacing the Capacitor default)

Replaced the generic Capacitor-generated launcher icon (teal grid background
+ a generic circular glyph) with a custom "label strip" mark - a warm paper
strip with printed text rows, on a dark ink-teal background. Picked after
sketching six concept directions for the user to choose from (tag, print-
in-progress strip, label roll, tag+signal, thermal stamp, barcode strip);
they picked the print-in-progress strip and left the colors to me:
background `#16211D` (deep ink-teal, distinct from generic Material teal),
foreground strip `#F3EFE4` (warm paper), printed rows cut out in the
background color for guaranteed contrast at small sizes. Content sized to
stay inside the ~66dp adaptive-icon safe-zone circle (verified by checking
corner distance from center, and by rendering a masked preview) so it
isn't clipped by circular/squircle launcher masks.

Implementation: `drawable-v24/ic_launcher_foreground.xml` (new vector,
two paths: the cream strip, then the ink row cutouts on top) and
`values/ic_launcher_background.xml`'s color changed to the ink tone.
`mipmap-anydpi-v26/ic_launcher.xml`/`ic_launcher_round.xml` were pointed at
`@drawable/ic_launcher_foreground` instead of `@mipmap/ic_launcher_foreground`
(the Capacitor template had them referencing a mipmap PNG per density,
even though a `drawable-v24` vector already existed unused) - this means
API 26+ now renders the icon from one scalable vector instead of five
separate PNGs, and the old `drawable/ic_launcher_background.xml` (an
unused teal grid-pattern vector - confirmed via grep that nothing
referenced it; the adaptive-icon XML used `@color/ic_launcher_background`
directly) and the five now-dead `mipmap-*/ic_launcher_foreground.png`
files were deleted.

For pre-API-26 devices (minSdk 24, so Android 7.0/7.1 - negligible real
install base today but still the declared minimum), regenerated flattened
`mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png` (square) and
`ic_launcher_round.png` (circle-clipped) at 48/72/96/144/192px from the
same source art via `rsvg-convert`, rather than leaving Capacitor's
generic default in place for that fallback path.

No asset-generation tool (`@capacitor/assets` or similar) is installed in
this project - confirmed nothing in `package.json`/`capacitor.config.json`
references one - so `npx cap sync android` won't regenerate or overwrite
these hand-authored files.

## Versioning convention (v1.0.1)

Bumped `android/app/build.gradle`'s `versionCode`/`versionName` (1 → 2,
"1.0" → "1.0.1") to match the `v1.0.1` tag. This matters beyond
cosmetics: reinstalling an APK with the same package name and signing
certificate but an unchanged `versionCode` can be rejected or treated
ambiguously by Android's package installer UI (tap-to-install from a file
manager, which is how this has been tested so far) - a real version bump
makes it an unambiguous update. Going forward, bump both before tagging
any `vX.Y.Z` release.

## In-app attribution + fresh offline re-audit (user-requested, urgent)

- The in-app Info dialog (`#info-dialog`, opened via the info button on
  both desktop and mobile) only said "Phomymo" / "Not affiliated with
  Phomemo" - true but not an explicit origin credit, and nothing in the
  app itself (as opposed to README/NOTICE.md, which a user installing the
  APK never sees) stated this is an unofficial Android wrapper built on
  transcriptionstream's open-source web app. Added: the dialog title now
  reads "Phomymo Android (unofficial)"; a new attribution box explicitly
  credits the upstream GitHub repo (linked) and states "unofficial... not
  affiliated with, endorsed by, or supported by Phomemo or the Phomymo
  author." Also fixed the dialog's stale "Requires Chrome, Edge, or
  Chromium" line, which is wrong for the native app - `showInfoDialog()`
  now swaps it to "Works fully offline" when `isNativeApp()` is true.
- Re-ran a full fresh grep of all of `www/` (not just incrementally, the
  whole tree again) for `http(s)://` outside `vendor/`/`docs/` to double
  check nothing new had crept in since the last full pass. Still clean:
  every hit is an SVG/XML namespace string, inert SEO `<meta>` content, a
  default placeholder string (`https://example.com` in a QR/barcode
  element's default text), or a user-initiated `target="_blank"` anchor
  (GitHub/Stripe/affordablemagic.net - requires an explicit tap, opens the
  system browser, doesn't touch in-app functionality). Also checked
  `docs/manual.html` specifically (reachable from the Info dialog) - its
  images are all local; it has one stale sentence telling the reader to
  open the live website, left as-is since it's prose a user would have to
  act on themselves, not an automatic network call. `initLocalFonts()`
  uses the device's installed fonts via the Local Font Access API (no
  network), and is a no-op if that API isn't present (likely the case in
  this WebView, so the button just stays hidden - not broken).

## Pending / to be continued

- Printing itself (text/QR/barcode, the two label sizes, disconnect/
  reconnect, cold-restart, airplane-mode test from TESTING.md) is still
  unverified beyond the user's manual confirmation that printing works -
  the detailed TESTING.md checklist hasn't been explicitly gone through
  item by item as far as this log knows.
