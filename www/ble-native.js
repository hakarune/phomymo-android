/**
 * Native BLE transport for Phomymo, using the @capacitor-community/bluetooth-le
 * plugin instead of the Web Bluetooth API. Used only when running inside the
 * packaged Android app (see BLENativeTransport.isAvailable()); the plain
 * Web Bluetooth transport in ble.js is still used when the same www/ folder
 * is opened in a desktop/mobile browser for testing.
 *
 * This mirrors the public interface of BLETransport (ble.js) - connect(),
 * disconnect(), send(), sendChunked(), query(), queryAll(), isConnected(),
 * getDeviceName(), onDisconnect, onPrinterInfo, printerInfo - so app.js can
 * use either transport interchangeably. The printer protocol itself (GATT
 * service/characteristic UUIDs, chunk size/delay, status query commands,
 * notification frame parsing) is shared with ble.js via imports, so the two
 * transports can never drift out of sync on the wire protocol.
 *
 * Depends on two classic (non-module) scripts being loaded before this one,
 * see index.html: vendor/js/capacitor-core.js (sets up window.Capacitor and
 * window.capacitorExports) and vendor/js/capacitor-bluetooth-le.js (sets up
 * window.capacitorCommunityBluetoothLe, which exposes the BleClient wrapper
 * recommended by the plugin's docs). The plugin's own ESM build can't be
 * imported directly here because it uses a bare `import ... from
 * '@capacitor/core'` specifier, which only resolves with a bundler - this
 * app intentionally has none (see NOTES.md).
 */

import { BLE } from './constants.js';
import { QUERY_COMMANDS, parseNotificationFrame } from './ble.js';

// Same name-prefix list as ble.js's Web Bluetooth filters. Unlike Web
// Bluetooth's requestDevice(), this plugin's requestDevice() only accepts a
// single name/namePrefix string, not a list of OR'd filters - so instead of
// fighting that, we scan unfiltered with requestLEScan() and do all
// filtering (and the "show all devices" toggle) ourselves in JS, in our own
// device-picker UI below.
const NAME_PREFIXES = ['M', 'D', 'P', 'Q', 'T', 'A', 'Mr.in', 'Phomemo'];

function matchesKnownPrefix(name) {
  if (!name) return false;
  return NAME_PREFIXES.some((p) => name.startsWith(p));
}

function getBleClient() {
  return window.capacitorCommunityBluetoothLe?.BleClient || null;
}

function toFullUUID(uuidOrNumber) {
  if (typeof uuidOrNumber === 'number') {
    const numberToUUID = window.capacitorCommunityBluetoothLe?.numberToUUID;
    if (numberToUUID) return numberToUUID(uuidOrNumber).toLowerCase();
    // Fallback manual conversion (standard Bluetooth Base UUID), in case the
    // vendored plugin build ever changes its exports.
    return `${uuidOrNumber.toString(16).padStart(8, '0')}-0000-1000-8000-00805f9b34fb`;
  }
  return String(uuidOrNumber).toLowerCase();
}

/**
 * Detect permission-flavored errors from the native plugin and show a
 * dedicated dialog with a button to open this app's Settings page, since
 * "please re-run adb logcat" isn't actionable for a non-technical user.
 */
function handleBleError(e) {
  const msg = (e && e.message) || String(e);
  console.error('[BLE native] Error:', msg);
  if (/permission/i.test(msg) || /denied/i.test(msg)) {
    showPermissionDeniedDialog();
    const err = new Error(
      'Bluetooth permission was denied. See the dialog for how to allow it in Settings, then try connecting again.'
    );
    err.isPermissionError = true;
    err.original = e;
    return err;
  }
  return e;
}

function showPermissionDeniedDialog() {
  const BleClient = getBleClient();
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-gray-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl w-[380px] max-w-full p-5 space-y-3">
      <h3 class="text-base font-semibold text-gray-900">Bluetooth permission needed</h3>
      <p class="text-sm text-gray-600">This app needs Bluetooth ("Nearby devices") permission to find and connect to your printer. Please allow it in Settings, then come back and try Connect again.</p>
      <div class="flex justify-end gap-2 pt-2">
        <button data-action="close" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">Close</button>
        <button data-action="settings" class="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600">Open Settings</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-action="close"]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-action="settings"]').addEventListener('click', async () => {
    overlay.remove();
    try {
      await BleClient.openAppSettings();
    } catch (e) {
      console.warn('[BLE native] openAppSettings() failed:', e.message);
    }
  });
}

/**
 * Advertised BLE device names are attacker-controlled input (any nearby
 * device can broadcast an arbitrary name) and get rendered via innerHTML
 * in the device picker below - escape before interpolating.
 */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/**
 * Race a promise against a timeout, so a native plugin call that never
 * resolves or rejects (observed: BleClient.initialize() hanging silently,
 * leaving the Connect button stuck on "Connecting..." forever with no
 * error and nothing logged) can't leave the UI stuck indefinitely. Most
 * of this plugin's calls (connect, getServices, etc.) have their own
 * documented internal timeouts (10s/5s per TimeoutOptions) - this is only
 * needed for the few that don't, like initialize().
 */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function signalIndicator(rssi) {
  if (rssi === undefined || rssi === null) return '';
  if (rssi >= -60) return '📶📶📶';
  if (rssi >= -75) return '📶📶';
  if (rssi >= -90) return '📶';
  return '·';
}

/**
 * Scan for nearby BLE devices and show an in-app picker (our own UI, not
 * the OS-native requestDevice() dialog - see the comment on NAME_PREFIXES
 * for why). Resolves with {deviceId, name} on selection, rejects on cancel
 * or timeout.
 */
function pickDeviceViaScan({ showAllDevices = false } = {}) {
  const BleClient = getBleClient();

  return new Promise((resolve, reject) => {
    const found = new Map(); // deviceId -> {deviceId, name, rssi}
    let settled = false;
    let currentShowAll = showAllDevices;
    let timeoutId = null;

    const overlay = document.createElement('div');
    overlay.id = 'ble-native-picker';
    overlay.className = 'fixed inset-0 bg-gray-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-[420px] max-w-full overflow-hidden flex flex-col max-h-[80vh]">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <h3 class="text-base font-semibold text-gray-900">Select your printer</h3>
          <button data-action="cancel" class="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>
        <div class="px-5 py-2 border-b border-gray-100 flex-shrink-0">
          <label class="flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" id="ble-picker-show-all" ${showAllDevices ? 'checked' : ''} />
            Show all Bluetooth devices (not just recognized printer names)
          </label>
        </div>
        <div id="ble-picker-list" class="flex-1 overflow-y-auto divide-y divide-gray-100">
          <div class="px-5 py-8 text-center text-sm text-gray-400">Scanning for printers...</div>
        </div>
        <div class="px-5 py-3 border-t border-gray-100 text-xs text-gray-400 flex-shrink-0">
          Don't see your printer? Make sure it's an M110 (Bluetooth LE), not an
          M110C (Bluetooth Classic) - M110C isn't supported by this app.
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('#ble-picker-list');
    const showAllCheckbox = overlay.querySelector('#ble-picker-show-all');

    function render() {
      const entries = [...found.values()].filter((e) => currentShowAll || matchesKnownPrefix(e.name));
      entries.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
      if (entries.length === 0) {
        listEl.innerHTML = '<div class="px-5 py-8 text-center text-sm text-gray-400">Scanning for printers...</div>';
        return;
      }
      listEl.innerHTML = entries
        .map(
          (e) => `
        <button data-device-id="${escapeHtml(e.deviceId)}" class="w-full text-left px-5 py-3 hover:bg-gray-50 flex items-center justify-between">
          <span class="text-sm text-gray-900">${escapeHtml(e.name || 'Unknown device')}</span>
          <span class="text-xs text-gray-400">${signalIndicator(e.rssi)}</span>
        </button>
      `
        )
        .join('');
    }

    async function cleanup() {
      clearTimeout(timeoutId);
      try {
        await BleClient.stopLEScan();
      } catch (e) {
        console.warn('[BLE native] stopLEScan() error (ignored):', e.message);
      }
      overlay.remove();
    }

    overlay.querySelector('[data-action="cancel"]').addEventListener('click', async () => {
      if (settled) return;
      settled = true;
      await cleanup();
      reject(new Error('Device selection cancelled'));
    });

    showAllCheckbox.addEventListener('change', (e) => {
      currentShowAll = e.target.checked;
      render();
    });

    listEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-device-id]');
      if (!btn || settled) return;
      settled = true;
      const entry = found.get(btn.dataset.deviceId);
      await cleanup();
      resolve(entry);
    });

    timeoutId = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await cleanup();
      reject(new Error('No printer found (scan timed out after 20 seconds)'));
    }, 20000);

    console.log('[BLE native] Starting scan, showAllDevices=', showAllDevices);
    BleClient.requestLEScan({}, (result) => {
      const name = result.localName || result.device.name || '';
      console.log(
        '[BLE native] Scan result:',
        name || '(unnamed)',
        'rssi=' + result.rssi,
        'id=' + result.device.deviceId
      );
      found.set(result.device.deviceId, { deviceId: result.device.deviceId, name, rssi: result.rssi });
      render();
    }).catch(async (e) => {
      if (settled) return;
      settled = true;
      await cleanup();
      reject(handleBleError(e));
    });
  });
}

let sharedInstance = null;
let bleInitialized = false;

export class BLENativeTransport {
  constructor() {
    this.deviceId = null;
    this.deviceName = null;
    this.connected = false;
    this.onDisconnect = null;
    this.onPrinterInfo = null; // Callback for printer info updates (same shape as BLETransport)
    this._serviceUuid = null;
    this._writeCharUuid = null;
    this._notifyCharUuid = null;
    this._useWriteWithResponse = false;
    this._responseWaiters = []; // pending waitForResponse() callers, see handleNotification()
    this.printerInfo = {
      battery: null,
      paper: null,
      firmware: null,
      serial: null,
      cover: null,
      version: null,
      mac: null,
      power: null,
      label: null,
    };
  }

  static getShared() {
    if (!sharedInstance) {
      sharedInstance = new BLENativeTransport();
    }
    return sharedInstance;
  }

  /**
   * True only inside the packaged native app, with the plugin loaded.
   * Does NOT fall back to true in a plain browser - ble.js (Web Bluetooth)
   * is used there instead, so the same www/ folder keeps working in Chrome.
   */
  static isAvailable() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && getBleClient());
  }

  async _ensureInitialized() {
    const BleClient = getBleClient();
    if (!BleClient) {
      throw new Error('Bluetooth plugin not available in this build.');
    }
    if (bleInitialized) return;
    console.log('[BLE native] Initializing BleClient (androidNeverForLocation: true)...');
    try {
      await withTimeout(
        BleClient.initialize({ androidNeverForLocation: true }),
        15000,
        'Bluetooth did not respond to initialize() within 15 seconds. Try force-closing and reopening the app, or check that Bluetooth is turned on.'
      );
      bleInitialized = true;
      console.log('[BLE native] Initialized');
    } catch (e) {
      throw handleBleError(e);
    }
  }

  /**
   * Main connect method, same signature as BLETransport.connect().
   * @param {Object} options
   * @param {boolean} options.showAllDevices - If true, the device picker shows every Bluetooth device, not just recognized printer name prefixes
   */
  async connect({ showAllDevices = false } = {}) {
    // Always log at least this one line immediately, synchronously, before
    // anything that could hang - so a stuck "Connecting..." state always
    // leaves some trace in logcat/remote-debugging, even without an in-app
    // log viewer (see NOTES.md - the in-app Debug log panel was removed).
    console.log('[BLE native] connect() called, showAllDevices=', showAllDevices);

    await this._ensureInitialized();
    const BleClient = getBleClient();

    if (this.isConnected()) {
      console.log('[BLE native] Already connected');
      return true;
    }

    try {
      const enabled = await withTimeout(BleClient.isEnabled(), 8000, 'Checking whether Bluetooth is on timed out.');
      if (!enabled) {
        console.log('[BLE native] Bluetooth is off, requesting enable...');
        await BleClient.requestEnable();
      }
    } catch (e) {
      console.error('[BLE native] Bluetooth enable check/request failed:', e.message);
      throw new Error('Bluetooth is turned off. Please enable Bluetooth and try again.');
    }

    const picked = await pickDeviceViaScan({ showAllDevices });
    console.log('[BLE native] Selected device:', picked.name || '(unnamed)', picked.deviceId);

    // Some Android devices refuse connect() if the OS thinks a stale GATT
    // connection is still open; disconnecting first is the documented fix.
    try {
      await withTimeout(BleClient.disconnect(picked.deviceId), 5000, 'pre-connect disconnect() timed out');
    } catch (e) {
      // Expected when the device wasn't actually connected, or a timeout
      // from our own safety wrapper - ignore either way, this is just a
      // best-effort cleanup step.
    }

    try {
      console.log('[BLE native] Connecting GATT...');
      await withTimeout(
        BleClient.connect(picked.deviceId, (deviceId) => {
          console.log('[BLE native] Disconnected:', deviceId);
          this.connected = false;
          this._serviceUuid = null;
          this._writeCharUuid = null;
          this._notifyCharUuid = null;
          if (this.onDisconnect) this.onDisconnect();
        }),
        20000,
        'Connecting to the printer timed out after 20 seconds.'
      );
    } catch (e) {
      throw handleBleError(e);
    }

    this.deviceId = picked.deviceId;
    this.deviceName = picked.name || 'Unknown';

    console.log('[BLE native] Connected, reading discovered services...');
    const services = await withTimeout(
      BleClient.getServices(picked.deviceId),
      10000,
      'Reading services from the printer timed out after 10 seconds.'
    );
    console.log('[BLE native] Services found:', services.map((s) => s.uuid).join(', ') || '(none)');

    const candidateServiceUuids = (BLE.ALT_SERVICE_UUIDS || [BLE.SERVICE_UUID]).map(toFullUUID);
    const writeCharUuid = toFullUUID(BLE.WRITE_CHAR_UUID);
    const notifyCharUuid = toFullUUID(BLE.NOTIFY_CHAR_UUID);

    const matchedService = services.find((svc) => candidateServiceUuids.includes(svc.uuid.toLowerCase()));

    if (!matchedService) {
      await this.disconnect();
      throw new Error('No compatible Bluetooth service found on this device.');
    }

    this._serviceUuid = matchedService.uuid;
    console.log('[BLE native] Using service:', this._serviceUuid);

    const writeChar = matchedService.characteristics.find((c) => c.uuid.toLowerCase() === writeCharUuid);
    if (!writeChar) {
      await this.disconnect();
      throw new Error('Write characteristic not found on the matched service.');
    }
    this._writeCharUuid = writeChar.uuid;
    console.log('[BLE native] Write characteristic properties:', writeChar.properties);
    this._useWriteWithResponse = !writeChar.properties.writeWithoutResponse && writeChar.properties.write;
    if (this._useWriteWithResponse) {
      console.log('[BLE native] Device requires write (with response)');
    }

    const notifyChar = matchedService.characteristics.find((c) => c.uuid.toLowerCase() === notifyCharUuid);
    if (notifyChar) {
      try {
        await BleClient.startNotifications(picked.deviceId, this._serviceUuid, notifyChar.uuid, (value) => {
          this.handleNotification(value);
        });
        this._notifyCharUuid = notifyChar.uuid;
        console.log('[BLE native] Notifications enabled');
      } catch (e) {
        console.warn('[BLE native] Notifications not available:', e.message);
      }
    } else {
      console.warn('[BLE native] Notify characteristic not found - battery/paper/firmware status queries will not work');
    }

    this.connected = true;
    console.log('[BLE native] Ready:', this.deviceName);
    return true;
  }

  /**
   * Disconnect from device
   */
  async disconnect() {
    const BleClient = getBleClient();
    if (this.deviceId && BleClient) {
      if (this._notifyCharUuid) {
        try {
          await BleClient.stopNotifications(this.deviceId, this._serviceUuid, this._notifyCharUuid);
        } catch (e) {
          // Ignore - device may already be disconnected
        }
      }
      try {
        await BleClient.disconnect(this.deviceId);
      } catch (e) {
        console.warn('[BLE native] disconnect() error (ignored):', e.message);
      }
    }
    this.connected = false;
    this.deviceId = null;
    this.deviceName = null;
    this._serviceUuid = null;
    this._writeCharUuid = null;
    this._notifyCharUuid = null;
  }

  /**
   * Send data to the printer (single write)
   */
  async send(data) {
    if (!this.isConnected()) {
      throw new Error('Not connected');
    }
    const BleClient = getBleClient();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (this._useWriteWithResponse) {
      await BleClient.write(this.deviceId, this._serviceUuid, this._writeCharUuid, view);
    } else {
      try {
        await BleClient.writeWithoutResponse(this.deviceId, this._serviceUuid, this._writeCharUuid, view);
      } catch (e) {
        console.warn('[BLE native] writeWithoutResponse failed, trying write:', e.message);
        this._useWriteWithResponse = true;
        await BleClient.write(this.deviceId, this._serviceUuid, this._writeCharUuid, view);
      }
    }
  }

  /**
   * Send data in chunks with delays (same chunk size/delay as BLETransport)
   */
  async sendChunked(data, onProgress = null) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const totalChunks = Math.ceil(bytes.length / BLE.CHUNK_SIZE);

    for (let i = 0; i < bytes.length; i += BLE.CHUNK_SIZE) {
      const chunk = bytes.slice(i, Math.min(i + BLE.CHUNK_SIZE, bytes.length));
      await this.send(chunk);
      await this.delay(BLE.CHUNK_DELAY_MS);

      if (onProgress) {
        const chunkNum = Math.floor(i / BLE.CHUNK_SIZE) + 1;
        const progress = Math.round(((i + chunk.length) / bytes.length) * 100);
        onProgress(chunkNum, totalChunks, progress);
      }
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isConnected() {
    return this.connected && !!this.deviceId;
  }

  getDeviceName() {
    return this.deviceName || 'Unknown';
  }

  /**
   * Wait for a response from the printer (BLE notification).
   * Used by the P12 protocol to wait for status query responses - mirrors
   * BLETransport.waitForResponse() in ble.js. Resolved from handleNotification()
   * below, independently of that method's own frame parsing, since a
   * P12-style response may not match the 0x1A field-frame format at all.
   * @param {number} timeout - Maximum time to wait in ms (default 500)
   * @returns {Promise<DataView|null>} Response data or null if timeout
   */
  async waitForResponse(timeout = 500) {
    if (!this._notifyCharUuid) {
      await this.delay(timeout);
      return null;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      this._responseWaiters.push({ resolve, timer });
    });
  }

  /**
   * Handle a notification value (DataView) from the printer.
   * Shares the exact same frame parser as ble.js (see parseNotificationFrame).
   */
  handleNotification(value) {
    const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    console.log('[BLE native <<<]', Array.from(data).map((b) => b.toString(16).padStart(2, '0')).join(' '));

    // Resolve any pending waitForResponse() callers with the raw value,
    // independently of the parsing below (mirrors ble.js, where
    // waitForResponse listens on its own, separate from handleNotification).
    if (this._responseWaiters.length) {
      const waiters = this._responseWaiters;
      this._responseWaiters = [];
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(value);
      }
    }

    const parsed = parseNotificationFrame(data);
    if (!parsed) return;

    if (parsed.kind === 'result') {
      console.log('[BLE native] Result:', parsed.value);
      return;
    }
    if (parsed.kind === 'printerType') {
      console.log('[BLE native] Printer type:', parsed.value);
      return;
    }
    if (parsed.kind === 'unknown') {
      console.log('[BLE native] Unknown response type:', parsed.type.toString(16));
      return;
    }

    const { field, value: fieldValue, stored } = parsed;
    if (stored) {
      this.printerInfo[field] = fieldValue;
    }
    console.log(`[BLE native] Printer ${field}:`, fieldValue);

    if (this.onPrinterInfo) {
      this.onPrinterInfo(field, fieldValue, this.printerInfo);
    }
  }

  /**
   * Query printer for status information
   * @param {string} queryType - One of: battery, firmware, serial, paper, cover, version, mac, power, label
   */
  async query(queryType) {
    if (!this.isConnected()) {
      throw new Error('Not connected');
    }
    const command = QUERY_COMMANDS[queryType];
    if (!command) {
      throw new Error(`Unknown query type: ${queryType}`);
    }
    console.log(`[BLE native] Querying ${queryType}...`);
    await this.send(new Uint8Array(command));
  }

  /**
   * Query all available printer info
   */
  async queryAll() {
    if (!this.isConnected()) {
      throw new Error('Not connected');
    }
    console.log('[BLE native] Querying all printer info...');
    const queries = ['battery', 'paper', 'firmware', 'serial'];
    for (const q of queries) {
      try {
        await this.query(q);
        await this.delay(100);
      } catch (e) {
        console.warn(`[BLE native] Query ${q} failed:`, e.message);
      }
    }
  }

  getPrinterInfo() {
    return { ...this.printerInfo };
  }

  resetPrinterInfo() {
    this.printerInfo = {
      battery: null,
      paper: null,
      firmware: null,
      serial: null,
      cover: null,
      version: null,
      mac: null,
      power: null,
      label: null,
    };
  }
}
