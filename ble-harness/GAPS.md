# GAPS — ELK-BLEDOM integration surface comparison

Feature backlog for the Homebridge fork.  Not a spec — priority TBD once the
`@stoprocent/noble` swap is stable.

---

## 1. bjclopes plugin (current Homebridge integration)

HomeKit characteristics exposed via a single `Lightbulb` service:

| Characteristic | HomeKit type | Range | Notes |
|---|---|---|---|
| On/Off | `Characteristic.On` | bool | Maps to BLE power command |
| Brightness | `Characteristic.Brightness` | 0–100 % | Maps to BLE brightness command (0–100, NOT 0–255) |
| Hue | `Characteristic.Hue` | 0–360° | Converted to RGB via HSL with fixed L=0.5; sent as RGB command |
| Saturation | `Characteristic.Saturation` | 0–100 % | Same colour path as Hue |

**Not exposed:** colour temperature, effects, music sync, white mode, scheduling.

---

## 2. dave-code-ruiz/elkbledom (Home Assistant integration)

HA entities exposed:

| Entity / feature | HA domain | Range | Notes |
|---|---|---|---|
| On/Off | `light` | bool | |
| Brightness | `light` | 0–255 | HA's native brightness scale |
| RGB colour | `light` | 0–255 per channel | Colour picker in Lovelace |

**Not exposed:** colour temperature, effects/modes, music sync, white mode,
scheduling.  Same surface as bjclopes in terms of colour model, though HA's
brightness is 0–255 vs Homebridge's 0–100.

---

## 3. Lotus Lantern app — features absent from both integrations

All items below are surfaced in the vendor app but not in either the
bjclopes plugin or the dave-code-ruiz integration.

### 3.1 Built-in effects / scene modes

**Description:** Breathing, flashing, strobe, colour-jump, colour-fade, and
roughly 20 additional static/dynamic patterns selectable in the app.

**Protocol support:** Yes.  The arduino12 documentation
(`ble_rgb_led_strip_controller`) lists a mode-selection command.  The
user154lt/ELK-BLEDOM-Command-Util project includes a working effect-command
implementation.  Frame format: `7E 05 03 <mode> <speed> FF FF 00 EF`.

**Difficulty (Homebridge fork):** Low for adding the BLE write; medium for
the HomeKit surface.

**HomeKit representation:** HomeKit's `Lightbulb` service has no native
effect concept.  Options:
- Expose each effect as a stateless `Switch` accessory (one switch per
  effect) — works, but clutters the Home app.
- Expose a single `Switch` plus a custom characteristic for effect index —
  invisible to Siri and most automations.
- Use HAP-nodejs custom characteristics — visible only in apps that support
  them (Eve, Home+, Controller for HomeKit).

### 3.2 Effect speed control

**Description:** A 0–100 slider that controls the speed of animated effects.

**Protocol support:** Yes — the `<speed>` byte in the effect command
(byte 4 in `7E 05 03 <mode> <speed> FF FF 00 EF`).

**Difficulty:** Low — a single byte parameter alongside the effect mode.

**HomeKit representation:** No native speed characteristic on Lightbulb.
Could be approximated with a `Fan` service (`RotationSpeed` characteristic
0–100 %) or a custom characteristic.

### 3.3 Music sync / microphone input

**Description:** The controller's built-in mic drives a reactive colour
animation.  The app lets the user enable mic mode and choose a sensitivity
level.

**Protocol support:** Likely a dedicated opcode — seen referenced in
ELK-BLEDOM-Command-Util but not fully documented.  Likely a one-byte
on/off toggle plus a sensitivity parameter.

**Difficulty:** Medium — protocol may need further reverse engineering for
sensitivity; mic data is processed on the strip's controller, not streamed
from the phone/Pi.

**HomeKit representation:** No native analogue.  A `Switch` for on/off is
the only clean option.  Sensitivity could be a slider via a custom
characteristic.

### 3.4 White / warm-white mode (CCT, RGBW variants)

**Description:** Some ELK-BLEDOM hardware variants include a dedicated white
(or warm-white) LED channel.  The app exposes a "white" slider separate from
RGB.

**Protocol support:** Conditional on hardware — RGBW variants use a
different colour command that includes a W byte.  Single-chip RGB-only strips
(the common variant) do not have this channel.

**Difficulty:** Low if your hardware supports it.  The bjclopes plugin was
written for RGB-only; a W-channel command would need a new opcode.

**HomeKit representation:** HomeKit's `Lightbulb` service supports
`ColorTemperature` (mired scale) natively.  For a true RGBW strip, the W
channel can be driven by `ColorTemperature` while RGB handles `Hue`/
`Saturation`.  This is a clean mapping if the firmware cooperates.

### 3.5 Scheduled timers

**Description:** The app can program the strip to turn on or off at a given
time, optionally recurring.

**Protocol support:** Referenced in community docs as a BLE write to a
separate characteristic; not well documented.

**Difficulty:** High — requires reading back current timer state, careful
byte-packing of time fields, and has no obvious benefit over HA/Homebridge
automations which can send the same on/off commands at scheduled times.

**HomeKit representation:** Homebridge automations already cover this
use-case natively.  Not worth implementing at the BLE level.

### 3.6 Segment / zone effects

**Description:** Some app versions show per-segment colour control (split
the strip into regions).

**Protocol support:** Not confirmed for common ELK-BLEDOM controllers.
May be firmware-specific or hardware-specific (addressable-LED variants only).

**Difficulty:** Unknown — protocol not documented in the references above.

**HomeKit representation:** HomeKit has no segment concept.  Each segment
would need its own accessory, which is complex to keep in sync.

---

## 4. Priority summary for the Homebridge fork

| Feature | Protocol known? | Homebridge difficulty | HomeKit fit |
|---|---|---|---|
| Effects / scene modes | Yes | Low (BLE) / Medium (HomeKit) | Poor (needs switch array) |
| Effect speed | Yes | Low | Poor (custom char or Fan service) |
| Music sync on/off | Partially | Medium | Poor (Switch only) |
| White/CCT channel | Hardware-dependent | Low | Good (`ColorTemperature`) |
| Scheduled timers | Partially | High | N/A (use automations instead) |
| Segments | Unknown | High | Very poor |

---

## 5. Notes on existing Device.js

Issues observed while reading Device.js for protocol reference.  **Not
fixed here** — noted only for future cleanup during the noble swap.

1. **HSL vs HSV colour model mismatch.**  `Device.js` stores `this.l = 0.5`
   and never changes it.  `set_hue` and `set_saturation` call
   `hslToRgb(h/360, s/100, 0.5)`.  HomeKit's `Hue` and `Saturation`
   characteristics belong to the HSB (= HSV) model, not HSL.  At L=0.5,
   HSL and HSB give similar results for saturated colours, but the mapping
   is not mathematically correct.  The symptom: colours appear slightly
   washed out, and full saturation (S=100 in HSB) does not correspond to a
   pure hue.  The `Brightness` characteristic is never fed into the colour
   calculation; brightness and colour are controlled by entirely separate
   BLE commands.

2. **`brightness` property range vs BLE range.**  The plugin stores
   brightness as 0–100 (matching HomeKit's scale) and passes it directly to
   the BLE brightness command.  The BLE command also expects 0–100 (not
   0–255 as HA uses).  This is correct, but the plugin doesn't document it,
   making it non-obvious.

3. **Power command byte 5 repetition.**  The power command repeats the
   on/off byte at both position 3 and position 5:
   `7E 04 04 <state> 00 <state> FF 00 EF`.  The purpose of the second
   occurrence is undocumented.  Both bjclopes and this harness send it
   verbatim.

4. **Callback-based write, not awaited.**  `this.write.write(buffer, true,
   callback)` is the legacy noble callback API.  The callback sets
   `this.power`/`this.brightness`, but since the outer function is `async`
   and does not `await` anything, callers (HomeKit characteristic handlers)
   return before the write has actually completed.  On a lossy BLE
   connection this can cause the plugin's internal state to diverge from the
   strip's actual state.  Fixing this is a natural side-effect of the noble
   swap to `writeAsync`.

5. **`debounceDisconnect` is unreachable.**  All three call sites in
   `set_power`, `set_brightness`, and `set_rgb` are commented out.  The
   function exists but is never called.  The plugin keeps the connection
   open indefinitely once established.

6. **No reconnect back-off.**  After a failed connect, the code calls
   `noble.startScanningAsync()` immediately with no delay.  On a device
   that is temporarily unreachable this can produce a tight retry loop.

7. **Silent command drop with stale state update before discovery.**
   `connectAndGetWriteCharacteristics` returns early (line 87) when
   `this.peripheral` is still `undefined` — i.e. before BLE discovery has
   found the device.  All `set_*` methods call it and then gate on
   `if (this.write)`, so if HomeKit sends a command at that point the BLE
   write never happens.  However, the state update (`this.power`,
   `this.brightness`, etc.) lives inside the write callback, which also
   never fires — meaning the plugin's cached state is *not* updated.  The
   command is silently dropped and no log message is emitted.  The strip and
   HomeKit's view of state diverge with no indication to the user or operator.
