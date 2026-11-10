# Phomymo Android (unofficial)

A standalone, offline Android app for designing and printing labels on
Phomemo thermal printers over Bluetooth LE — built by wrapping the
browser-based [Phomymo](https://github.com/transcriptionstream/phomymo)
label designer in [Capacitor](https://capacitorjs.com/) with a native BLE
transport, so it works in a plain Android WebView (which has no Web
Bluetooth API).

**This is an unofficial, community-built wrapper.** It is not affiliated
with, endorsed by, or supported by Phomemo (the printer manufacturer) or by
the author of Phomymo. See [NOTICE.md](NOTICE.md) for attribution and
license details.

## Privacy

This app is fully offline and tracker-free:

- No analytics, no crash reporting, no telemetry, no cloud services.
- No network access at all — every library it uses (fonts, barcode/QR/PDF
  generation, the Capacitor runtime) is bundled inside the app, not loaded
  from the internet. The `INTERNET` permission has been removed from the
  Android manifest (unverified on real hardware as of this writing — if
  the app shows a blank screen on first launch instead of the label
  designer, that permission removal is the first thing to try reverting;
  see NOTES.md).
- Your label designs and settings stay in the app's local storage on your
  phone. Nothing is ever uploaded anywhere.
- The only network-ish thing the app does is Bluetooth LE communication
  with your printer, which never leaves your phone and the printer.

See [NOTES.md](NOTES.md) for the detailed, file-by-file verification of
these claims.

## Supported printers

This app talks Bluetooth LE using the same protocol as upstream Phomymo.
It was **built specifically for the Phomemo M110** — that's the printer
this project targets — but as of this writing it has **not yet been
verified on real hardware** (see [TESTING.md](TESTING.md) for the
checklist that still needs to be run). Other models in upstream's
supported list (P12, A30, M02 family, M03, T02, M04S, M110S, M120,
M200/M220/M221/M250/M260, D-series, Q30/Q30S) should work too since they
share the same BLE transport, but are even less verified than the M110.

## Limitations

- **M110C is not supported.** The M110C variant uses Bluetooth Classic
  (SPP), not Bluetooth LE. The native BLE plugin this app uses only talks
  BLE, and Android's BLE scan will simply never see a Classic/SPP device —
  an M110C will not appear in the device list at all. There is no
  workaround for this within this app. If you have an M110 (not M110C),
  you're fine.
- **USB / PM-241 printing is not available.** The PM-241 shipping-label
  printer connects over USB (WebUSB in the browser version), and Android's
  WebView has no WebUSB API. Use a desktop or Android Chrome browser with
  the original [Phomymo web app](https://phomymo.affordablemagic.net) for
  PM-241 printing instead.
- Nothing in this app has been verified end-to-end on a real printer by
  its author (see NOTES.md) — only code review and static analysis. The
  first real-device test is up to whoever installs it; see
  [TESTING.md](TESTING.md).

## Installing the APK

1. Go to this repo's **Actions** tab, or its **Releases** page (for tagged
   versions), on GitHub.
2. Download the `phomymo-android-apk` artifact (from a workflow run) or the
   `.apk` file attached to a release.
3. On your Android phone, enable "Install unknown apps" for whichever app
   you used to download the file (Settings → Apps → *that app* → Install
   unknown apps), since this isn't distributed through the Play Store.
4. Open the downloaded `.apk` file and install it.
5. Open the app, tap **Connect**, and select your printer from the list
   (see [TESTING.md](TESTING.md) for a first-run checklist).

If a future update is signed with a different key than what you currently
have installed (for example, if you're on a debug build - see NOTES.md),
Android will refuse to install over it. Uninstall the old version first in
that case.

## Project structure

This repo wraps upstream Phomymo's browser code (`www/`, vendored from
[transcriptionstream/phomymo](https://github.com/transcriptionstream/phomymo))
with a Capacitor Android shell (`android/`) and a native BLE transport
(`www/ble-native.js`) that's used only when running inside the packaged
app; the same `www/` folder still works in a desktop browser via the
original Web Bluetooth transport (`www/ble.js`). See
[NOTES.md](NOTES.md) for the full list of build decisions and deviations
from the original plan.

## Building it yourself

```bash
npm ci
npx cap sync android
cd android
./gradlew assembleDebug   # or assembleRelease, with signing env vars set - see NOTES.md
```

The GitHub Actions workflow (`.github/workflows/build-apk.yml`) does this
automatically on every push to `main`, on `v*` tags, or on demand.

## Credits

- [Phomymo](https://github.com/transcriptionstream/phomymo) by
  transcriptionstream — the label designer this app wraps.
- BLE/protocol research: [vivier/phomemo-tools](https://github.com/vivier/phomemo-tools),
  [yaddran/thermal-print](https://github.com/yaddran/thermal-print).
- [@capacitor-community/bluetooth-le](https://github.com/capacitor-community/bluetooth-le)
  — the native BLE plugin this app's Android transport is built on.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) (the latter
explains a gap in upstream's own license file).
