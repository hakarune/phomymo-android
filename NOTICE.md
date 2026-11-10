# Notice

This project is an **unofficial** Android wrapper around the browser-based
label designer [Phomymo](https://github.com/transcriptionstream/phomymo) by
transcriptionstream, vendored at upstream commit
`1f58d3f0e7f941b9143277cda828380149e56855` (2026-05-17).

It is **not affiliated with, endorsed by, or supported by Phomemo** (the
printer manufacturer) or by the author of Phomymo. "Phomemo" and any related
marks are property of their respective owners and are not used by this
project's branding. The app is named "Phomymo Android (unofficial)" to make
that clear.

## License

Upstream Phomymo's `README.md` states "MIT License - see LICENSE file for
details," but as of the vendored commit **no `LICENSE` file exists in the
upstream repository** (confirmed via `git clone` and the GitHub API, which
reports `license: null` for the repo), and `package.json` lists
`"license": "ISC"` — most likely an unedited default from `npm init` rather
than an intentional declaration.

This project treats the upstream README's explicit MIT statement as the
license grant for the vendored `www/` code (a public, written statement of
license intent by the repository's maintainer), and includes the standard
MIT license text in `LICENSE`. If upstream publishes a formal `LICENSE` file
in the future, this repository should be updated to match it exactly.

This wrapper's own code (Capacitor config, native BLE transport shim,
Android project, CI workflows, documentation) is also MIT licensed, per
`LICENSE`.

## Third-party libraries (vendored, offline)

The following libraries, previously loaded from CDNs by upstream, are
vendored locally under `www/vendor/` so the app works with zero network
access. See each library's own license file for terms:

- [JsBarcode](https://github.com/lindell/JsBarcode) (MIT)
- [QRCode.js](https://github.com/davidshimjs/qrcodejs) (MIT)
- [jsPDF](https://github.com/parallax/jsPDF) (MIT)
- [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0)
- [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) (MIT)
- [Inter font](https://github.com/rsms/inter) and other Google Fonts families (see `www/vendor/fonts/LICENSES.md`)

## Printer protocol credits

Per upstream's README, BLE/protocol research and inspiration came from:

- [vivier/phomemo-tools](https://github.com/vivier/phomemo-tools)
- [yaddran/thermal-print](https://github.com/yaddran/thermal-print)
