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
corresponding `androidNeverForLocation: true` option still needs to be
passed when calling the plugin's scan API in Step 5.

## Pending / to be continued

- Step 5+ (BLE transport port, CI, docs) not yet started as of this note.
