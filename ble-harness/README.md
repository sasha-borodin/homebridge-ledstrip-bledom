# ble-harness

Standalone BLE test harness for ELK-BLEDOM LED strips.

Exercises the strip directly at the BLE protocol layer using
`@stoprocent/noble` — independent of Homebridge and the plugin.  Use it to
verify the strip works from a macOS host before touching the plugin code.

---

## Requirements

- macOS (Apple Silicon or Intel), Node.js ≥ 20
- Bluetooth hardware (built-in or USB)
- `@stoprocent/noble` is the only npm dependency

## Installation

```sh
cd ble-harness
npm install
```

---

## Running

### Full test suite (default)

Runs: discover → power on → brightness sweep → hue sweep → colour cycle →
power off → disconnect.  About 1.5 s pause between steps so you can visually
verify each one.

```sh
node index.js
# or
npm test
```

### Targeted tests

Pass one or more `--test-*` flags.  Tests run in the order given, with a 1.5 s
pause between each.

```sh
node index.js --test-turn-on
node index.js --test-turn-on --test-set-brightness=75 --test-set-hue=120
node index.js --test-set-rgb=FF4400
node index.js --test-cycle-colors --test-turn-off
```

---

## Test flags

| Flag | Description |
|---|---|
| `--test-discover` | Scan, find strip, print name / UUID / RSSI, then disconnect. |
| `--test-turn-on` | Send power-on command. |
| `--test-turn-off` | Send power-off command. |
| `--test-set-brightness=N` | N is 0–100 (%). |
| `--test-set-hue=N` | N is 0–360 (degrees); sent at S=100, V=100. |
| `--test-set-saturation=N` | N is 0–100 (%); sent at H=0°, V=100. |
| `--test-set-rgb=RRGGBB` | 6-char hex colour, e.g. `FF4400` or `00FF80`. |
| `--test-set-rgba=RRGGBBAA` | 8-char hex.  The `AA` byte is mapped to brightness: `brightness% = round(AA / 0xFF × 100)`.  The strip has no real alpha channel — two writes are issued: first RGB, then brightness. `0xFF` → 100%, `0x80` → 50%, `0x00` → 0%. |
| `--test-cycle-colors` | Red → Green → Blue, 2 s each, then off. |
| `--test-brightness-sweep` | 10 %→100 % in steps, then back down to 10 %. |
| `--test-hue-sweep` | 0°→330° in 30° steps (12 steps) at S=100, V=100. |

---

## Connection options

| Flag | Default | Description |
|---|---|---|
| `--device=<name\|uuid>` | (first ELK-BLEDOM) | Target a specific strip by local name prefix or CoreBluetooth UUID. |
| `--scan-timeout=<s>` | 15 | Seconds to wait before giving up. |
| `--keep-alive` | off | Skip auto-disconnect; leave strip connected until Ctrl+C. |

Examples:

```sh
# Target a specific device by name
node index.js --device="ELK-BLEDOM" --test-turn-on

# Longer scan timeout on a busy 2.4 GHz environment
node index.js --scan-timeout=30 --test-discover

# Leave the strip on at a chosen colour for inspection
node index.js --keep-alive --test-turn-on --test-set-rgb=8000FF
```

---

## Troubleshooting

### macOS Bluetooth permission prompt

On first run, macOS will show a dialog: *"Terminal" would like to use
Bluetooth*.  Click **OK**.  If you accidentally denied it:

> System Settings → Privacy & Security → Bluetooth → enable the entry for
> Terminal (or whichever app you're running Node from).

### Strip doesn't respond / only one BLE central at a time

The ELK-BLEDOM strip accepts only one BLE central connection at a time.  If
the **Lotus Lantern** app (or any other controller) is connected, the harness
will scan successfully but the `connectAsync()` call will fail or hang.

Fix: **force-quit** the Lotus Lantern app on your phone before running the
harness.  On iOS: swipe up from the home bar, find Lotus Lantern, swipe up to
kill it.

### noble fails to enter `poweredOn` state

Symptoms: the harness prints "Waiting for Bluetooth adapter to power on…" and
hangs, or exits with a state-change error.

Steps to try:
1. Open System Settings → Bluetooth and confirm Bluetooth is on.
2. If Bluetooth is on but noble still doesn't fire `poweredOn`, toggle
   Bluetooth off and back on.
3. On Apple Silicon, some USB BLE adapters conflict with the built-in
   controller; unplug any USB BT dongles.
4. Restart the Bluetooth daemon:
   ```sh
   sudo pkill bluetoothd
   ```
   macOS will restart it automatically.
5. Check that no other `node` process is already running noble against the
   same adapter (`ps aux | grep node`).

### "Service fff0 not found" error after connecting

The strip is connected but the expected service wasn't discovered.  This can
happen if the strip's firmware is mid-transition.  Try:
1. Power-cycle the strip (unplug, wait 5 s, plug back in).
2. Increase `--scan-timeout` to give the strip time to fully boot.

### Harness hangs after tests complete

noble can keep the Node event loop open.  The harness schedules a forced
`process.exit()` 500 ms after `main()` resolves, so it should always
terminate.  If it doesn't, Ctrl+C is safe — BLE state on macOS is cleaned up
by the OS when the process exits.
