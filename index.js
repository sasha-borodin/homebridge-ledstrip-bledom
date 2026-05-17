const Device = require('./Device');
const { name: pluginName } = require('./package.json');

let Service, Characteristic;

('use strict');
module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory(pluginName, 'LedStrip', LedStrip);
};

function LedStrip(log, config, api) {
  this.log = log;
  this.config = config;
  this.homebridge = api;

  this.bulb = new Service.Lightbulb(this.config.name);
  // Set up Event Handler for bulb on/off
  this.bulb
    .getCharacteristic(Characteristic.On)
    .onGet(this.getPower.bind(this))
    .onSet(this.setPower.bind(this));
  this.bulb
    .getCharacteristic(Characteristic.Brightness)
    .onGet(this.getBrightness.bind(this))
    .onSet(this.setBrightness.bind(this));
  this.bulb
    .getCharacteristic(Characteristic.Hue)
    .onGet(this.getHue.bind(this))
    .onSet(this.setHue.bind(this));
  this.bulb
    .getCharacteristic(Characteristic.Saturation)
    .onGet(this.getSaturation.bind(this))
    .onSet(this.setSaturation.bind(this));

  this.log('all event handler was setup.');

  if (!this.config.uuid) return;
  this.uuid = this.config.uuid;

  this.log('Device UUID:', this.uuid);

  this.device = new Device(this.uuid);
}

LedStrip.prototype = {
  getServices: function () {
    if (!this.bulb) return [];
    this.log('Homekit asked to report service');
    const infoService = new Service.AccessoryInformation();
    infoService.setCharacteristic(Characteristic.Manufacturer, 'LedStrip');
    return [infoService, this.bulb];
  },
  getPower: function () {
    this.log('Homekit Asked Power State', this.device.connected);
    return this.device.power;
  },
  setPower: async function (on) {
    this.log('Homekit Gave New Power State' + ' ' + on);
    await this.device.set_power(on);
  },
  getBrightness: function () {
    this.log('Homekit Asked Brightness');
    return this.device.brightness;
  },
  setBrightness: async function (brightness) {
    this.log('Homekit Set Brightness', brightness);
    await this.device.set_brightness(brightness);
  },
  getHue: function () {
    return this.device.hue;
  },
  setHue: async function (hue) {
    this.log('Homekit Set Hue', hue);
    await this.device.set_hue(hue);
  },
  getSaturation: function () {
    return this.device.saturation;
  },
  setSaturation: async function (saturation) {
    this.log('Homekit Set Saturation', saturation);
    await this.device.set_saturation(saturation);
  }
};
