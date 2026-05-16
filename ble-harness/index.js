'use strict';

/**
 * ble-harness/index.js
 *
 * Standalone BLE test harness for ELK-BLED LED strips.
 * Depends on @stoprocent/noble; no Homebridge, no plugin imports.
 *
 * Usage:
 *   node index.js                          # full test suite
 *   node index.js --test-turn-on           # single test
 *   node index.js --test-set-brightness=75 # test with value
 *
 * Run `node index.js --help` or see ble-harness/README.md for full flag list.
 */

const noble = require('@stoprocent/noble');
const protocol = require('./protocol');

// ─── Logging ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toTimeString().slice(0, 8); // HH:MM:SS
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Format a Buffer as spaced hex for log output. */
function hexStr(buf) {
  return buf.toString('hex').match(/.{2}/g).join(' ').toUpperCase();
}

/** Write a command buffer to the characteristic and log it. */
async function send(writeChar, buf, description) {
  log(`${description} → [${hexStr(buf)}]`);
  await writeChar.writeAsync(buf, true /* withoutResponse */);
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Usage: node index.js [options] [--test-* ...]

Connection options:
  --device=<name|uuid>      Target a specific strip by local name or UUID.
                            Default: first peripheral whose name starts with
                            "ELK-BLED" (case-insensitive) or that advertises
                            service fff0.
  --scan-timeout=<seconds>  Abort if no device is found (default: 15).
  --keep-alive              Skip auto-disconnect at the end.

Test flags (if none given, the full suite runs):
  --test-discover
  --test-turn-on
  --test-turn-off
  --test-set-brightness=N   N is 0–100
  --test-set-hue=N          N is 0–360 (S=100, V=100)
  --test-set-saturation=N   N is 0–100 (H=0, V=100)
  --test-set-rgb=RRGGBB     6-char hex
  --test-set-rgba=RRGGBBAA  8-char hex; AA is mapped to brightness 0–100
                            via: brightness = round(AA / 0xFF * 100)
  --test-cycle-colors       R → G → B → off, 2 s each
  --test-brightness-sweep   10 %→100 % in steps, then back down
  --test-hue-sweep          0°→360° at S=100 V=100, 12 steps

Examples:
  node index.js
  node index.js --test-discover
  node index.js --test-turn-on --test-set-brightness=80 --test-set-hue=120
  node index.js --device=ELK-BLEDM --test-set-rgb=FF4400
  node index.js --keep-alive --test-turn-on --test-set-hue=240
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const opts = {
    device: null,
    scanTimeout: 15,
    keepAlive: false,
    tests: [], // [{ name: 'test-turn-on', value: null }, ...]
  };

  for (const arg of args) {
    if (arg.startsWith('--device=')) {
      opts.device = arg.slice('--device='.length);
    } else if (arg.startsWith('--scan-timeout=')) {
      const n = parseInt(arg.slice('--scan-timeout='.length), 10);
      if (isNaN(n) || n < 1) {
        console.error(`Invalid --scan-timeout value: ${arg}`);
        process.exitCode = 1;
        process.exit(1);
      }
      opts.scanTimeout = n;
    } else if (arg === '--keep-alive') {
      opts.keepAlive = true;
    } else if (arg.startsWith('--test-')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) {
        opts.tests.push({ name: arg.slice(2), value: null }); // e.g. 'test-turn-on'
      } else {
        opts.tests.push({ name: arg.slice(2, eqIdx), value: arg.slice(eqIdx + 1) });
      }
    } else {
      console.error(`Unknown argument: ${arg}  (run with --help for usage)`);
      process.exitCode = 1;
      process.exit(1);
    }
  }

  return opts;
}

// ─── Device discovery ─────────────────────────────────────────────────────────

function matchesDevice(peripheral, opts) {
  const localName = (peripheral.advertisement.localName || '').toLowerCase();
  const uuid      = peripheral.uuid.toLowerCase();
  const svcUuids  = peripheral.advertisement.serviceUuids || [];

  if (opts.device) {
    const target = opts.device.toLowerCase();
    // Match by local name prefix or by UUID (with/without hyphens)
    return localName === target ||
           localName.startsWith(target) ||
           uuid === target.replace(/-/g, '') ||
           uuid === target;
  }

  // Default: ELK-BLED by name or by write service UUID
  return localName.startsWith('elk-bled') || svcUuids.includes('fff0');
}

/**
 * Wait for BT to power on, scan until we find a matching peripheral,
 * then return it.  Throws if nothing is found within scanTimeout seconds.
 */
async function findDevice(opts) {
  log('Waiting for Bluetooth adapter to power on…');
  await noble.waitForPoweredOnAsync();
  log('Bluetooth powered on. Starting scan…');
  await noble.startScanningAsync([], /* allowDuplicates */ false);

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`No ELK-BLED device found within ${opts.scanTimeout}s`)),
      opts.scanTimeout * 1000,
    )
  );

  const discoverPromise = (async () => {
    for await (const peripheral of noble.discoverAsync()) {
      const name = peripheral.advertisement.localName || '(no name)';
      log(`  seen: ${name}  uuid=${peripheral.uuid}  rssi=${peripheral.rssi}`);
      if (matchesDevice(peripheral, opts)) {
        return peripheral;
      }
    }
    throw new Error('Scan ended without finding a matching device');
  })();

  try {
    return await Promise.race([discoverPromise, timeoutPromise]);
  } finally {
    await noble.stopScanningAsync();
  }
}

// ─── BLE connection ───────────────────────────────────────────────────────────

/**
 * Connect to peripheral, discover services/characteristics, return the
 * fff3 write characteristic on service fff0.
 */
async function connect(peripheral) {
  const name = peripheral.advertisement.localName || peripheral.uuid;
  log(`Connecting to "${name}" (${peripheral.uuid})…`);
  await peripheral.connectAsync();
  log('Connected. Discovering services and characteristics…');

  await peripheral.discoverAllServicesAndCharacteristicsAsync();

  const service = peripheral.services.find((s) => s.uuid === 'fff0');
  if (!service) throw new Error('Service fff0 not found on device');

  const writeChar = service.characteristics.find((c) => c.uuid === 'fff3');
  if (!writeChar) throw new Error('Characteristic fff3 not found on service fff0');

  log('Write characteristic fff3 ready.');
  return writeChar;
}

// ─── Individual tests ─────────────────────────────────────────────────────────

function testDiscover(peripheral) {
  log('DISCOVER result:');
  log(`  local name : ${peripheral.advertisement.localName || '(none)'}`);
  log(`  uuid       : ${peripheral.uuid}`);
  log(`  address    : ${peripheral.address || '(unavailable on macOS)'}`);
  log(`  rssi       : ${peripheral.rssi} dBm`);
  log(`  service UUIDs advertised: ${(peripheral.advertisement.serviceUuids || []).join(', ') || '(none)'}`);
}

async function testTurnOn(writeChar) {
  await send(writeChar, protocol.cmdPowerOn(), 'turning on');
}

async function testTurnOff(writeChar) {
  await send(writeChar, protocol.cmdPowerOff(), 'turning off');
}

async function testSetBrightness(writeChar, value) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0 || n > 100) throw new Error(`--test-set-brightness: N must be 0–100, got ${value}`);
  await send(writeChar, protocol.cmdSetBrightness(n), `set brightness ${n}%`);
}

async function testSetHue(writeChar, value) {
  const h = parseInt(value, 10);
  if (isNaN(h) || h < 0 || h > 360) throw new Error(`--test-set-hue: N must be 0–360, got ${value}`);
  await send(writeChar, protocol.cmdSetHSV(h, 100, 100), `set hue ${h}° (S=100, V=100)`);
}

async function testSetSaturation(writeChar, value) {
  const s = parseInt(value, 10);
  if (isNaN(s) || s < 0 || s > 100) throw new Error(`--test-set-saturation: N must be 0–100, got ${value}`);
  await send(writeChar, protocol.cmdSetHSV(0, s, 100), `set saturation ${s}% (H=0°, V=100)`);
}

async function testSetRGB(writeChar, value) {
  if (!/^[0-9a-fA-F]{6}$/.test(value)) throw new Error(`--test-set-rgb: must be 6-char hex, got "${value}"`);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  await send(writeChar, protocol.cmdSetRGB(r, g, b), `set RGB #${value.toUpperCase()}`);
}

/**
 * --test-set-rgba=RRGGBBAA
 *
 * The strip has no real alpha channel. AA is treated as an opacity-style
 * brightness hint: brightness% = round(AA / 0xFF * 100).
 * Two writes are issued: first the RGB colour, then the brightness level.
 * AA=0xFF → 100%, AA=0x80 → 50%, AA=0x00 → 0%.
 */
async function testSetRGBA(writeChar, value) {
  if (!/^[0-9a-fA-F]{8}$/.test(value)) throw new Error(`--test-set-rgba: must be 8-char hex, got "${value}"`);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const a = parseInt(value.slice(6, 8), 16);
  const brightness = Math.round((a / 0xff) * 100);
  await send(writeChar, protocol.cmdSetRGB(r, g, b),          `set RGB #${value.slice(0, 6).toUpperCase()} (from RGBA)`);
  await sleep(100);
  await send(writeChar, protocol.cmdSetBrightness(brightness), `set brightness ${brightness}% (from alpha 0x${value.slice(6, 8).toUpperCase()} = ${a}/255)`);
}

async function testCycleColors(writeChar) {
  const colors = [
    { name: 'red',   r: 255, g: 0,   b: 0   },
    { name: 'green', r: 0,   g: 255, b: 0   },
    { name: 'blue',  r: 0,   g: 0,   b: 255 },
  ];
  for (const c of colors) {
    await send(writeChar, protocol.cmdSetRGB(c.r, c.g, c.b), `cycle: ${c.name}`);
    await sleep(2000);
  }
  await send(writeChar, protocol.cmdPowerOff(), 'cycle: off');
}

async function testBrightnessSweep(writeChar) {
  const steps = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
  for (const level of steps) {
    await send(writeChar, protocol.cmdSetBrightness(level), `brightness sweep: ${level}%`);
    await sleep(300);
  }
}

async function testHueSweep(writeChar) {
  // 12 steps: 0°, 30°, 60°, … 330°
  for (let h = 0; h < 360; h += 30) {
    await send(writeChar, protocol.cmdSetHSV(h, 100, 100), `hue sweep: ${h}°`);
    await sleep(500);
  }
}

// ─── Full test suite (no arguments) ──────────────────────────────────────────

async function runFullSuite(peripheral, writeChar) {
  log('════ FULL TEST SUITE ════');

  log('── 1. Discover info ──');
  testDiscover(peripheral);
  await sleep(500);

  log('── 2. Power on ──');
  await testTurnOn(writeChar);
  await sleep(1500);

  log('── 3. Brightness sweep ──');
  await testBrightnessSweep(writeChar);
  await sleep(1500);

  log('── 4. Hue sweep ──');
  await testHueSweep(writeChar);
  await sleep(1500);

  log('── 5. Colour cycle ──');
  await testCycleColors(writeChar);
  await sleep(1500);

  log('── 6. Power off ──');
  await testTurnOff(writeChar);

  log('════ SUITE COMPLETE ════');
}

// ─── Per-flag dispatch ────────────────────────────────────────────────────────

async function runTest(test, peripheral, writeChar) {
  switch (test.name) {
    case 'test-discover':
      testDiscover(peripheral);
      break;
    case 'test-turn-on':
      await testTurnOn(writeChar);
      break;
    case 'test-turn-off':
      await testTurnOff(writeChar);
      break;
    case 'test-set-brightness':
      await testSetBrightness(writeChar, test.value);
      break;
    case 'test-set-hue':
      await testSetHue(writeChar, test.value);
      break;
    case 'test-set-saturation':
      await testSetSaturation(writeChar, test.value);
      break;
    case 'test-set-rgb':
      await testSetRGB(writeChar, test.value);
      break;
    case 'test-set-rgba':
      await testSetRGBA(writeChar, test.value);
      break;
    case 'test-cycle-colors':
      await testCycleColors(writeChar);
      break;
    case 'test-brightness-sweep':
      await testBrightnessSweep(writeChar);
      break;
    case 'test-hue-sweep':
      await testHueSweep(writeChar);
      break;
    default:
      throw new Error(`Unknown test flag: --${test.name}  (run with --help for usage)`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  // ── Find device ──
  let peripheral;
  try {
    peripheral = await findDevice(opts);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const name = peripheral.advertisement.localName || peripheral.uuid;
  log(`Found: "${name}"  uuid=${peripheral.uuid}  rssi=${peripheral.rssi} dBm`);

  // ── Connect ──
  let writeChar;
  try {
    writeChar = await connect(peripheral);
  } catch (err) {
    log(`ERROR connecting: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // ── Run tests ──
  try {
    if (opts.tests.length === 0) {
      await runFullSuite(peripheral, writeChar);
    } else {
      for (const test of opts.tests) {
        await runTest(test, peripheral, writeChar);
        await sleep(1500);
      }
    }
  } catch (err) {
    log(`ERROR during test: ${err.message}`);
    process.exitCode = 1;
  }

  // ── Disconnect ──
  if (!opts.keepAlive) {
    try {
      log('Disconnecting…');
      await peripheral.disconnectAsync();
      log('Disconnected. Done.');
    } catch (err) {
      log(`Warning: disconnect error: ${err.message}`);
    }
  } else {
    log('--keep-alive set: leaving strip connected. Press Ctrl+C when done.');
    return; // keep process alive
  }
}

main()
  .then(() => {
    // noble can keep the event loop open; give it a moment then force exit.
    setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
  })
  .catch((err) => {
    log(`Fatal: ${err.message}`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 500).unref();
  });
