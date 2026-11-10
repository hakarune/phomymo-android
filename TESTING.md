# Testing checklist (first real-device test)

Nothing in this app has been run on a real phone or a real printer yet —
everything so far is code review and static analysis (see NOTES.md). This
checklist is for whoever installs the APK on their phone with a Phomemo
M110, to find out what actually works.

If anything fails: open the **Debug log** button (bottom-left corner of
the app), tap **Copy**, and paste it back along with which step failed.

## Before you start

- [ ] Phone's Bluetooth is turned on.
- [ ] The M110 is powered on and has paper loaded.
- [ ] You've installed the APK (see README.md "Installing the APK").

## 1. First connect

- [ ] Open the app. It loads to the label designer (not a blank/white
      screen — if it's blank, see NOTES.md's note about the removed
      `INTERNET` permission, that's the first thing to try reverting).
- [ ] Tap **Connect**. If this is the very first connection, Android may
      ask for a Bluetooth permission — allow it.
- [ ] A device picker appears showing nearby Bluetooth devices. Your M110
      should appear in the list (it may take a few seconds to show up).
- [ ] Select it. Status should change to "Connected: M110 ..." and the
      printer model/label size should auto-detect.

**If your printer doesn't appear in the list**: check the "Show all
Bluetooth devices" checkbox in the picker, in case its advertised name
doesn't match the expected prefixes. If it still doesn't appear at all,
double check it's an **M110**, not an **M110C** — the M110C uses Bluetooth
Classic, which this app cannot support at all (see README.md Limitations).

## 2. Print a few basic labels

- [ ] Add a text element, type something, and print it. Confirm the
      physical label matches what's on screen.
- [ ] Add a QR code element with some text/URL, print it, and scan it with
      another phone to confirm it decodes correctly.
- [ ] Add a barcode element (try Code128), print it, and scan it if you
      have a barcode scanner app, or at least visually confirm it printed
      cleanly (no gaps/smearing).

## 3. Label sizes

- [ ] Switch label size to **40×30 mm**, print a simple label, confirm the
      physical dimensions match.
- [ ] Switch label size to **50×30 mm**, print a simple label, confirm the
      physical dimensions match.

## 4. Connection resilience

- [ ] Tap **Disconnect**, then **Connect** again and reselect the printer.
      Confirm it reconnects and prints successfully afterward.
- [ ] Fully close the app (swipe it away from recent apps), reopen it, and
      connect again. Confirm it still works from a cold start.

## 5. Confirm it's actually offline

- [ ] Turn on **Airplane mode**, then turn **Bluetooth back on** (airplane
      mode disables Bluetooth by default on most phones, but you can
      re-enable just Bluetooth while airplane mode stays on for everything
      else). Connect to the printer and print a label. If this works, it
      proves the app has no network dependency at all — it's printing with
      zero internet access.

## Reporting back

Whatever happens — success or failure — the most useful things to send
back are:

1. Which checklist items passed/failed.
2. The **Debug log** contents (Copy button) if anything failed, especially
   around connecting or the first print.
3. The exact printer model name shown when connecting (in case it's an
   M110 variant with a different advertised name than expected).
