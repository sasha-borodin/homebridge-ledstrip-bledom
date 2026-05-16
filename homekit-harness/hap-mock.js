'use strict';

/**
 * homekit-harness/hap-mock.js
 *
 * Minimal fake of the homebridge / HAP API surface used by the plugin.
 *
 * The plugin (index.js) calls:
 *   homebridge.hap.Service.Lightbulb          — constructor
 *   homebridge.hap.Service.AccessoryInformation — constructor
 *   homebridge.hap.Characteristic.{On,Brightness,Hue,Saturation,Manufacturer}
 *   homebridge.registerAccessory(plugin, name, Ctor)
 *
 * Each Lightbulb instance exposes:
 *   service.getCharacteristic(char)  → stub with .on('get'|'set', handler)
 *
 * The returned mockHB object additionally exposes:
 *   getRegisteredCtor()              → the LedStrip constructor captured by registerAccessory
 *   simulateGet(charKey)             → Promise<value>  (calls the registered get handler)
 *   simulateSet(charKey, value)      → Promise<void>   (calls the registered set handler)
 */

const CHARS = {
  On:           'On',
  Brightness:   'Brightness',
  Hue:          'Hue',
  Saturation:   'Saturation',
  Manufacturer: 'Manufacturer',
};

function makeCharStub() {
  const handlers = { get: null, set: null };
  const stub = {
    on(event, fn) {
      handlers[event] = fn;
      return stub;
    },
    setCharacteristic() {
      return stub;
    },
    _handlers: handlers,
  };
  return stub;
}

function createMockHomebridge() {
  const charStubs = {};
  let registeredCtor = null;

  class MockLightbulb {
    getCharacteristic(charKey) {
      if (!charStubs[charKey]) charStubs[charKey] = makeCharStub();
      return charStubs[charKey];
    }
  }

  class MockAccessoryInformation {
    setCharacteristic() { return this; }
  }

  const mockHB = {
    hap: {
      Service: {
        Lightbulb: MockLightbulb,
        AccessoryInformation: MockAccessoryInformation,
      },
      Characteristic: CHARS,
    },

    registerAccessory(_plugin, _name, Ctor) {
      registeredCtor = Ctor;
    },

    getRegisteredCtor() {
      return registeredCtor;
    },

    simulateGet(charKey) {
      return new Promise((resolve, reject) => {
        const stub = charStubs[charKey];
        if (!stub || !stub._handlers.get) {
          return reject(new Error(`No get handler registered for characteristic "${charKey}"`));
        }
        stub._handlers.get((err, value) => {
          if (err) reject(err);
          else resolve(value);
        });
      });
    },

    simulateSet(charKey, value) {
      return new Promise((resolve, reject) => {
        const stub = charStubs[charKey];
        if (!stub || !stub._handlers.set) {
          return reject(new Error(`No set handler registered for characteristic "${charKey}"`));
        }
        stub._handlers.set(value, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };

  return mockHB;
}

module.exports = { createMockHomebridge, CHARS };
