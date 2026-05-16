const noble = require("@stoprocent/noble");

function log(message) {
  console.log(`[homebridge-ledstrip]:`, message);
}

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

module.exports = class Device {
  constructor(uuid) {
    this.uuid = uuid;
    this.connected = false;
    this.power = false;
    this.brightness = 100;
    this.hue = 0;
    this.saturation = 0;
    this.peripheral = undefined;
    this.debounceTimer = null;

    noble.on("stateChange", (state) => {
      if (state == "poweredOn") {
        noble.startScanningAsync();
      } else {
        if (this.peripheral) this.peripheral.disconnect();
        this.connected = false;
      }
    });

    noble.on("discover", async (peripheral) => {
      if (peripheral.uuid === this.uuid) {
        if (this.connected || (this.peripheral && this.peripheral.state === 'connecting')) {
          return;
        }

        log(`Discovered target device: ${peripheral.uuid}`);
        this.peripheral = peripheral;
        noble.stopScanning();

        try {
          await this.connectAndGetWriteCharacteristics();
        } catch (err) {
          log(`Connect failed after discovery: ${err.message}`);
          this.peripheral = undefined;
          this.connected = false;
          await new Promise(r => setTimeout(r, 5000));
          noble.startScanningAsync();
        }
      }
    });
  }

  async connectAndGetWriteCharacteristics() {
    if (!this.peripheral) return;

    if (this.peripheral.state !== 'connected') {
      log(`Connecting to ${this.peripheral.uuid}...`);
      try {
        await this.peripheral.connectAsync();

        const { characteristics } =
          await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
            ["fff0"],
            ["fff3"]
          );
        this.write = characteristics[0];
        this.connected = true;
        log(`Connected`);
      } catch (err) {
        log(`Connection error: ${err.message}`);
        throw err;
      }
    }
  }

  debounceDisconnect() {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(async () => {
      if (this.peripheral) {
        log("Disconnecting...");
        await this.peripheral.disconnectAsync();
        log("Disconnected");
        this.connected = false;
      }
    }, 5000);
  }

  async set_power(status) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (!this.write) {
      log("Command dropped: device not yet discovered");
      return;
    }
    const buffer = Buffer.from(
      `7e0404${status ? "01" : "00"}00${status ? "01" : "00"}ff00ef`,
      "hex"
    );
    try {
      await this.write.writeAsync(buffer, true);
      this.power = status;
      log("Power command sent");
      this.debounceDisconnect();
    } catch (err) {
      log("Power write error: " + err.message);
    }
  }

  async set_brightness(level) {
    if (level > 100 || level < 0) return;
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (!this.write) {
      log("Command dropped: device not yet discovered");
      return;
    }
    const level_hex = ("0" + level.toString(16)).slice(-2);
    const buffer = Buffer.from(`7e0401${level_hex}ffffff00ef`, "hex");
    try {
      await this.write.writeAsync(buffer, true);
      this.brightness = level;
      log("Brightness command sent");
      this.debounceDisconnect();
    } catch (err) {
      log("Brightness write error: " + err.message);
    }
  }

  async set_rgb(r, g, b) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (!this.write) {
      log("Command dropped: device not yet discovered");
      return;
    }
    const rhex = ("0" + r.toString(16)).slice(-2);
    const ghex = ("0" + g.toString(16)).slice(-2);
    const bhex = ("0" + b.toString(16)).slice(-2);
    const buffer = Buffer.from(`7e070503${rhex}${ghex}${bhex}10ef`, "hex");
    try {
      await this.write.writeAsync(buffer, true);
      log("Colour command sent");
      this.debounceDisconnect();
    } catch (err) {
      log("Colour write error: " + err.message);
    }
  }

  async set_hue(hue) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (!this.write) {
      log("Command dropped: device not yet discovered");
      return;
    }
    this.hue = hue;
    const rgb = hsvToRgb(this.hue, this.saturation, this.brightness);
    await this.set_rgb(rgb[0], rgb[1], rgb[2]);
  }

  async set_saturation(saturation) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (!this.write) {
      log("Command dropped: device not yet discovered");
      return;
    }
    this.saturation = saturation;
    const rgb = hsvToRgb(this.hue, this.saturation, this.brightness);
    await this.set_rgb(rgb[0], rgb[1], rgb[2]);
  }
};
