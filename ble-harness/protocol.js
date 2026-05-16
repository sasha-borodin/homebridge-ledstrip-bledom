'use strict';

/**
 * ELK-BLEDOM BLE protocol command builders.
 *
 * All functions return a Buffer ready to write to:
 *   service UUID  : fff0
 *   characteristic: fff3
 *
 * Byte patterns are mirrored from Device.js in the parent plugin directory.
 * No import of plugin source — this is a faithful copy, not a shared module.
 *
 * General frame layout (all commands are 9 bytes):
 *   7E  <group>  <opcode>  <payload × 5>  EF
 *
 * References:
 *   https://github.com/user154lt/ELK-BLEDOM-Command-Util
 *   https://github.com/arduino12/ble_rgb_led_strip_controller/blob/master/README.md
 */

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Convert HSV to RGB.
 * h: 0–360, s: 0–100, v: 0–100
 * Returns [r, g, b] each 0–255.
 *
 * NOTE: The bjclopes plugin uses HSL with a fixed L=0.5 (not HSV) for its
 * internal color model, so results from cmdSetHSV will differ slightly from
 * what the plugin sends for equivalent hue/saturation values. See GAPS.md for
 * a full explanation.
 */
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
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

// ─── Exported command builders ────────────────────────────────────────────────

/**
 * Power ON.
 *
 * 7E 04 04 01 00 01 FF 00 EF
 * ───────────────────────────
 * 7E        frame start
 * 04        command group (power / brightness commands)
 * 04        opcode: power control
 * 01        power state: 0x01 = on
 * 00        reserved
 * 01        power state repeated (purpose unclear; mirrors plugin verbatim)
 * FF 00     reserved / padding
 * EF        frame end
 */
function cmdPowerOn() {
  return Buffer.from('7e0404010001ff00ef', 'hex');
}

/**
 * Power OFF.
 *
 * 7E 04 04 00 00 00 FF 00 EF
 * ───────────────────────────
 * (same layout as cmdPowerOn; state bytes set to 0x00)
 */
function cmdPowerOff() {
  return Buffer.from('7e0404000000ff00ef', 'hex');
}

/**
 * Set brightness.
 * @param {number} level  0–100 (percentage; NOT 0–255)
 *
 * 7E 04 01 LL FF FF FF 00 EF
 * ───────────────────────────
 * 7E        frame start
 * 04        command group
 * 01        opcode: brightness
 * LL        level, 0x00–0x64 (decimal 0–100)
 * FF FF FF  color bytes (all-max / white; unchanged when only brightness varies)
 * 00        reserved
 * EF        frame end
 */
function cmdSetBrightness(level) {
  if (level < 0 || level > 100) throw new RangeError(`brightness must be 0–100, got ${level}`);
  const ll = ('0' + level.toString(16)).slice(-2);
  return Buffer.from(`7e0401${ll}ffffff00ef`, 'hex');
}

/**
 * Set colour via direct RGB values.
 * @param {number} r  0–255
 * @param {number} g  0–255
 * @param {number} b  0–255
 *
 * 7E 07 05 03 RR GG BB 10 EF
 * ───────────────────────────
 * 7E        frame start
 * 07        command group (colour commands)
 * 05        opcode: manual colour
 * 03        colour mode: 0x03 = direct RGB
 * RR GG BB  red, green, blue (0x00–0xFF each)
 * 10        colour-order flag: 0x10 = RGB (vs BGR/GRB variants)
 * EF        frame end
 */
function cmdSetRGB(r, g, b) {
  const rh = ('0' + r.toString(16)).slice(-2);
  const gh = ('0' + g.toString(16)).slice(-2);
  const bh = ('0' + b.toString(16)).slice(-2);
  return Buffer.from(`7e070503${rh}${gh}${bh}10ef`, 'hex');
}

/**
 * Set colour via HSV.
 * Converts to RGB internally, then calls the RGB command.
 * @param {number} h  0–360  hue (degrees)
 * @param {number} s  0–100  saturation (percent)
 * @param {number} v  0–100  value / brightness (percent)
 *
 * This uses proper HSV→RGB (not the plugin's HSL-with-fixed-L=0.5 approach).
 * When s=100 and v=100 you get fully saturated colours at full brightness.
 */
function cmdSetHSV(h, s, v) {
  const [r, g, b] = hsvToRgb(h, s, v);
  return cmdSetRGB(r, g, b);
}

module.exports = { cmdPowerOn, cmdPowerOff, cmdSetBrightness, cmdSetRGB, cmdSetHSV };
