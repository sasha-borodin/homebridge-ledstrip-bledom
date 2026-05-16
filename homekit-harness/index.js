'use strict';

/**
 * homekit-harness/index.js
 *
 * Exercises the ELK-BLEDOM Homebridge plugin (../index.js + ../Device.js) the
 * way Homebridge would: via simulated HomeKit characteristic get/set calls
 * driven through a minimal HAP mock.
 *
 * Assumes:
 *   1. ../Device.js has been updated to use @stoprocent/noble.
 *   2. All six GAPS.md issues have been fixed (HSV colour model, brightness
 *      V-coupling, writeAsync, debounceDisconnect call sites uncommented,
 *      reconnect back-off, pre-discovery command handling).
 *
 * The harness requires --device=<uuid> because the plugin matches peripherals
 * by UUID.  Obtain the UUID first via:
 *   node ../ble-harness/index.js --test-discover
 *
 * Usage:
 *   node index.js --device=<uuid>                    # full test suite
 *   node index.js --device=<uuid> --test-hsv-accuracy
 *
 * Run with --help for the full flag list.
 */

const path = require('path');
const { createMockHomebridge, CHARS } = require('./hap-mock');

// ─── Logging ──────────────────────────────────────────────────────────────────

function ts() { return new Date().toTimeString().slice(0, 8); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function pluginLog(msg) { log(`[plugin] ${msg}`); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hexStr(buf) {
  return buf.toString('hex').match(/.{2}/g).join(' ').toUpperCase();
}

// Reference HSV→RGB implementation, independent of plugin source.
// h: 0–360, s: 0–100, v: 0–100  →  [r, g, b] each 0–255.
function hsvToRgb(h, s, v) {
  s /= 100;
  v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if      (h <  60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Usage: node index.js --device=<uuid> [options] [--test-* ...]

The device UUID is required.  To find it, run:
  node ../ble-harness/index.js --test-discover

Connection options:
  --device=<uuid>           BLE peripheral UUID to target (required).
  --scan-timeout=<seconds>  Abort if not connected within N seconds (default: 15).
  --keep-alive              Skip auto-disconnect at the end.

Test flags (if none given, the full suite runs):
  --test-discover
  --test-get-initial-state
  --test-power-on
  --test-power-off
  --test-set-brightness=N    N is 0–100
  --test-set-hue=N           N is 0–360
  --test-set-saturation=N    N is 0–100
  --test-hsv-accuracy        Automated PASS/FAIL spot-checks (no visual needed)
  --test-compound-color      Hue=120, Sat=80, Brightness=60 in sequence
  --test-color-sweep         Hue 0→330° in 30° steps at S=100, V=100; visual

Examples:
  node index.js --device=aabbccdd1122 --test-hsv-accuracy
  node index.js --device=aabbccdd1122
  node index.js --device=aabbccdd1122 --keep-alive --test-color-sweep
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const opts = { device: null, scanTimeout: 15, keepAlive: false, tests: [] };

  for (const arg of args) {
    if (arg.startsWith('--device=')) {
      opts.device = arg.slice('--device='.length);
    } else if (arg.startsWith('--scan-timeout=')) {
      const n = parseInt(arg.slice('--scan-timeout='.length), 10);
      if (isNaN(n) || n < 1) {
        console.error(`Invalid --scan-timeout value: ${arg}`);
        process.exit(1);
      }
      opts.scanTimeout = n;
    } else if (arg === '--keep-alive') {
      opts.keepAlive = true;
    } else if (arg.startsWith('--test-')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) opts.tests.push({ name: arg.slice(2), value: null });
      else opts.tests.push({ name: arg.slice(2, eqIdx), value: arg.slice(eqIdx + 1) });
    } else {
      console.error(`Unknown argument: ${arg}  (run with --help for usage)`);
      process.exit(1);
    }
  }

  return opts;
}

// ─── Plugin bootstrap ─────────────────────────────────────────────────────────

function bootPlugin(opts) {
  const mockHB = createMockHomebridge();
  const pluginInit = require(path.join(__dirname, '..', 'index.js'));
  pluginInit(mockHB);

  const LedStrip = mockHB.getRegisteredCtor();
  if (!LedStrip) throw new Error('Plugin did not call homebridge.registerAccessory()');

  const config = { name: 'harness-strip', uuid: opts.device };
  const accessory = new LedStrip(pluginLog, config, mockHB);

  if (!accessory.device) {
    throw new Error(
      'Plugin did not create a Device instance.  ' +
      'Ensure --device=<uuid> is specified and the plugin reads config.uuid.'
    );
  }

  return { mockHB, accessory, device: accessory.device };
}

async function waitForConnection(device, scanTimeout) {
  log('Waiting for BLE device to connect…');
  const deadline = Date.now() + scanTimeout * 1000;
  while (!device.connected) {
    if (Date.now() > deadline) {
      throw new Error(`BLE connection timed out after ${scanTimeout}s`);
    }
    await sleep(200);
  }
}

// ─── Write interceptor ────────────────────────────────────────────────────────

// Wraps device.write.writeAsync so we can capture the most recent BLE buffer.
// Must be called after device.write is populated (i.e. after connection).
// Assumes fix #3 (writeAsync) is applied.
function installWriteInterceptor(device) {
  if (!device.write || typeof device.write.writeAsync !== 'function') {
    log('Warning: device.write.writeAsync not found — accuracy checks will be skipped.');
    return { lastBuf: null };
  }
  const state = { lastBuf: null };
  const orig = device.write.writeAsync.bind(device.write);
  device.write.writeAsync = async (buf, withoutResponse) => {
    state.lastBuf = Buffer.from(buf); // copy so it isn't mutated
    return orig(buf, withoutResponse);
  };
  return state;
}

// ─── Individual tests ─────────────────────────────────────────────────────────

function testDiscover(device) {
  const p = device.peripheral;
  log('DISCOVER result (via plugin):');
  log(`  uuid             : ${p?.uuid ?? device.uuid}`);
  log(`  local name       : ${p?.advertisement?.localName || '(none)'}`);
  log(`  address          : ${p?.address || '(unavailable on macOS)'}`);
  log(`  rssi             : ${p?.rssi ?? '?'} dBm`);
  log(`  service UUIDs    : ${(p?.advertisement?.serviceUuids || []).join(', ') || '(none)'}`);
  log(`  connected        : ${device.connected}`);
}

async function testGetInitialState(mockHB) {
  log('GET initial state (before any set commands):');
  const power      = await mockHB.simulateGet(CHARS.On);
  const brightness = await mockHB.simulateGet(CHARS.Brightness);
  const hue        = await mockHB.simulateGet(CHARS.Hue);
  const saturation = await mockHB.simulateGet(CHARS.Saturation);
  log(`  On         : ${power}    (expected false)`);
  log(`  Brightness : ${brightness}  (expected 100)`);
  log(`  Hue        : ${hue}       (expected 0)`);
  log(`  Saturation : ${saturation}       (expected 0)`);
}

async function testPowerOn(mockHB) {
  await mockHB.simulateSet(CHARS.On, true);
  const val = await mockHB.simulateGet(CHARS.On);
  log(`Power ON  → get returns: ${val}  (expected true)  strip should be on`);
}

async function testPowerOff(mockHB) {
  await mockHB.simulateSet(CHARS.On, false);
  const val = await mockHB.simulateGet(CHARS.On);
  log(`Power OFF → get returns: ${val}  (expected false)  strip should be off`);
}

async function testSetBrightness(mockHB, value) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0 || n > 100) throw new Error(`--test-set-brightness: N must be 0–100, got "${value}"`);
  await mockHB.simulateSet(CHARS.Brightness, n);
  const val = await mockHB.simulateGet(CHARS.Brightness);
  log(`Set Brightness ${n}% → get returns: ${val}`);
}

async function testSetHue(mockHB, value) {
  const h = parseInt(value, 10);
  if (isNaN(h) || h < 0 || h > 360) throw new Error(`--test-set-hue: N must be 0–360, got "${value}"`);
  const s = await mockHB.simulateGet(CHARS.Saturation);
  const v = await mockHB.simulateGet(CHARS.Brightness);
  const [er, eg, eb] = hsvToRgb(h, s, v);
  log(`Set Hue ${h}° (S=${s}%, V=${v}%) → expected RGB (${er}, ${eg}, ${eb})`);
  await mockHB.simulateSet(CHARS.Hue, h);
  const val = await mockHB.simulateGet(CHARS.Hue);
  log(`  get Hue returns: ${val}`);
}

async function testSetSaturation(mockHB, value) {
  const s = parseInt(value, 10);
  if (isNaN(s) || s < 0 || s > 100) throw new Error(`--test-set-saturation: N must be 0–100, got "${value}"`);
  const h = await mockHB.simulateGet(CHARS.Hue);
  const v = await mockHB.simulateGet(CHARS.Brightness);
  const [er, eg, eb] = hsvToRgb(h, s, v);
  log(`Set Saturation ${s}% (H=${h}°, V=${v}%) → expected RGB (${er}, ${eg}, ${eb})`);
  await mockHB.simulateSet(CHARS.Saturation, s);
  const val = await mockHB.simulateGet(CHARS.Saturation);
  log(`  get Saturation returns: ${val}`);
}

// Extracts R,G,B bytes from a captured BLE write buffer if it is an RGB command.
// RGB command frame: 7E 07 05 03 RR GG BB 10 EF
function extractRgb(buf) {
  if (!buf || buf.length < 9) return null;
  if (buf[0] !== 0x7e || buf[1] !== 0x07 || buf[8] !== 0xef) return null;
  return [buf[4], buf[5], buf[6]];
}

async function testHsvAccuracy(mockHB, writeState) {
  log('HSV accuracy spot-checks (automated PASS/FAIL):');

  // Each case sets all three of H, S, V so the result is deterministic regardless
  // of prior test state.  The last BLE write after simulateSet(Saturation) should
  // be the RGB command that encodes the full HSV triple (assuming V-coupled fix).
  const cases = [
    { label: 'red       H=0,   S=100, V=100', h: 0,   s: 100, v: 100, expected: [255, 0,   0  ] },
    { label: 'green     H=120, S=100, V=100', h: 120, s: 100, v: 100, expected: [0,   255, 0  ] },
    { label: 'blue      H=240, S=100, V=100', h: 240, s: 100, v: 100, expected: [0,   0,   255] },
    { label: 'white     H=0,   S=0,   V=100', h: 0,   s: 0,   v: 100, expected: [255, 255, 255] },
    { label: 'mid-gray  H=0,   S=0,   V=50 ', h: 0,   s: 0,   v: 50,  expected: [128, 128, 128] },
    { label: 'pink      H=0,   S=50,  V=100', h: 0,   s: 50,  v: 100, expected: [255, 128, 128] },
  ];

  let passed = 0;
  for (const c of cases) {
    writeState.lastBuf = null;

    // Set all three dimensions; final simulateSet(Saturation) triggers the RGB write.
    await mockHB.simulateSet(CHARS.Brightness, c.v);
    await mockHB.simulateSet(CHARS.Hue, c.h);
    await mockHB.simulateSet(CHARS.Saturation, c.s);

    const rgb = extractRgb(writeState.lastBuf);
    if (!rgb) {
      const raw = writeState.lastBuf ? hexStr(writeState.lastBuf) : '(none)';
      log(`  SKIP  ${c.label}  — last write not an RGB command: ${raw}`);
      continue;
    }

    const [ar, ag, ab] = rgb;
    const [er, eg, eb] = c.expected;
    const ok = ar === er && ag === eg && ab === eb;
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.label}`);
    if (!ok) log(`         expected (${er}, ${eg}, ${eb})  got (${ar}, ${ag}, ${ab})`);
    if (ok) passed++;
  }

  log(`  Result: ${passed}/${cases.length} passed`);
}

async function testCompoundColor(mockHB, writeState) {
  log('Compound color: hue=120, saturation=80, brightness=60 (sequential)');

  // Reset to known baseline
  await mockHB.simulateSet(CHARS.Hue, 0);
  await mockHB.simulateSet(CHARS.Saturation, 0);
  await mockHB.simulateSet(CHARS.Brightness, 100);

  // Step 1: set hue only (S=0, V=100 → white-ish green)
  writeState.lastBuf = null;
  await mockHB.simulateSet(CHARS.Hue, 120);
  const [e1r, e1g, e1b] = hsvToRgb(120, 0, 100);
  const rgb1 = extractRgb(writeState.lastBuf);
  log(`  After hue=120  (S=0,  V=100): expected (${e1r}, ${e1g}, ${e1b})` +
      (rgb1 ? `  got (${rgb1[0]}, ${rgb1[1]}, ${rgb1[2]})` : '  (no RGB write captured)'));

  // Step 2: set saturation (H=120, S=80, V=100 → bright green)
  writeState.lastBuf = null;
  await mockHB.simulateSet(CHARS.Saturation, 80);
  const [e2r, e2g, e2b] = hsvToRgb(120, 80, 100);
  const rgb2 = extractRgb(writeState.lastBuf);
  log(`  After sat=80   (H=120, V=100): expected (${e2r}, ${e2g}, ${e2b})` +
      (rgb2 ? `  got (${rgb2[0]}, ${rgb2[1]}, ${rgb2[2]})` : '  (no RGB write captured)'));

  // Step 3: set brightness then re-trigger hue to get V-coupled RGB write.
  // (set_brightness itself only sends the brightness BLE command; the RGB
  // command with the new V is sent when hue or saturation is next set.)
  await mockHB.simulateSet(CHARS.Brightness, 60);
  writeState.lastBuf = null;
  await mockHB.simulateSet(CHARS.Hue, 120); // re-send with V=60
  const [e3r, e3g, e3b] = hsvToRgb(120, 80, 60);
  const rgb3 = extractRgb(writeState.lastBuf);
  log(`  After bri=60   (H=120, S=80):  expected (${e3r}, ${e3g}, ${e3b})` +
      (rgb3 ? `  got (${rgb3[0]}, ${rgb3[1]}, ${rgb3[2]})` : '  (no RGB write captured)'));

  const h = await mockHB.simulateGet(CHARS.Hue);
  const s = await mockHB.simulateGet(CHARS.Saturation);
  const v = await mockHB.simulateGet(CHARS.Brightness);
  log(`  Plugin cached state: H=${h}° S=${s}% V=${v}%`);
}

async function testColorSweep(mockHB) {
  log('Color sweep: hue 0→330° in 30° steps at S=100, V=100 (visual)');
  await mockHB.simulateSet(CHARS.Saturation, 100);
  await mockHB.simulateSet(CHARS.Brightness, 100);
  for (let h = 0; h < 360; h += 30) {
    const [r, g, b] = hsvToRgb(h, 100, 100);
    log(`  hue ${String(h).padStart(3)}° → expected RGB (${r}, ${g}, ${b})`);
    await mockHB.simulateSet(CHARS.Hue, h);
    await sleep(500);
  }
}

// ─── Full test suite ──────────────────────────────────────────────────────────

async function runFullSuite(mockHB, device, writeState) {
  log('════ FULL TEST SUITE ════');

  log('── 1. Discover info ──');
  testDiscover(device);
  await sleep(500);

  log('── 2. Initial state ──');
  await testGetInitialState(mockHB);
  await sleep(500);

  log('── 3. Power on ──');
  await testPowerOn(mockHB);
  await sleep(1500);

  log('── 4. Brightness samples ──');
  await testSetBrightness(mockHB, '25');
  await sleep(500);
  await testSetBrightness(mockHB, '75');
  await sleep(500);
  await testSetBrightness(mockHB, '100');
  await sleep(1000);

  log('── 5. HSV accuracy ──');
  await testHsvAccuracy(mockHB, writeState);
  await sleep(1000);

  log('── 6. Compound colour ──');
  await testCompoundColor(mockHB, writeState);
  await sleep(1500);

  log('── 7. Colour sweep ──');
  await testColorSweep(mockHB);
  await sleep(1000);

  log('── 8. Power off ──');
  await testPowerOff(mockHB);

  log('════ SUITE COMPLETE ════');
}

// ─── Per-flag dispatch ────────────────────────────────────────────────────────

async function runTest(test, mockHB, device, writeState) {
  switch (test.name) {
    case 'test-discover':
      testDiscover(device);
      break;
    case 'test-get-initial-state':
      await testGetInitialState(mockHB);
      break;
    case 'test-power-on':
      await testPowerOn(mockHB);
      break;
    case 'test-power-off':
      await testPowerOff(mockHB);
      break;
    case 'test-set-brightness':
      await testSetBrightness(mockHB, test.value);
      break;
    case 'test-set-hue':
      await testSetHue(mockHB, test.value);
      break;
    case 'test-set-saturation':
      await testSetSaturation(mockHB, test.value);
      break;
    case 'test-hsv-accuracy':
      await testHsvAccuracy(mockHB, writeState);
      break;
    case 'test-compound-color':
      await testCompoundColor(mockHB, writeState);
      break;
    case 'test-color-sweep':
      await testColorSweep(mockHB);
      break;
    default:
      throw new Error(`Unknown test flag: --${test.name}  (run with --help for usage)`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.device) {
    console.error('Error: --device=<uuid> is required.\n');
    console.error('Obtain the UUID first:');
    console.error('  node ../ble-harness/index.js --test-discover\n');
    process.exitCode = 1;
    return;
  }

  // Boot plugin via HAP mock
  let mockHB, device;
  try {
    ({ mockHB, device } = bootPlugin(opts));
  } catch (err) {
    log(`ERROR: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Test initial (pre-connection) state — exercises read path before discovery.
  // Note: simulateSet before connection is NOT tested here; that is a manual
  // test for the issue-6 fix (pre-discovery command queuing / error reporting).
  log('Pre-connection getter check:');
  await testGetInitialState(mockHB);

  // The plugin's Device drives BLE scanning internally; wait for it to connect.
  try {
    await waitForConnection(device, opts.scanTimeout);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const name = device.peripheral?.advertisement?.localName || device.uuid;
  log(`Connected to "${name}"`);

  // Install write interceptor for byte-level accuracy checks.
  const writeState = installWriteInterceptor(device);

  // Run tests
  try {
    if (opts.tests.length === 0) {
      await runFullSuite(mockHB, device, writeState);
    } else {
      for (const test of opts.tests) {
        await runTest(test, mockHB, device, writeState);
        await sleep(1500);
      }
    }
  } catch (err) {
    log(`ERROR during test: ${err.message}`);
    process.exitCode = 1;
  }

  // Disconnect
  if (!opts.keepAlive) {
    try {
      log('Disconnecting…');
      await device.peripheral.disconnectAsync();
      log('Disconnected. Done.');
    } catch (err) {
      log(`Warning: disconnect error: ${err.message}`);
    }
  } else {
    log('--keep-alive set. Press Ctrl+C when done.');
    return;
  }
}

main()
  .then(() => setTimeout(() => process.exit(process.exitCode || 0), 500).unref())
  .catch((err) => {
    log(`Fatal: ${err.message}`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 500).unref();
  });
