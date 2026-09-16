import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromMatterLevel, planAccessories, serialFor, toMatterLevel, trimName } from '../src/matter.js';

describe('the Matter level scale', () => {
    it('carries a percentage across', () => {
        assert.equal(toMatterLevel(100), 254);
        assert.equal(toMatterLevel(50), 127);
        assert.equal(fromMatterLevel(254), 100);
        assert.equal(fromMatterLevel(127), 50);
    });

    it('never reports a lit device as level zero, which Matter reads as off', () => {
        assert.equal(toMatterLevel(0), 1);
    });

    it('stays in range whatever it is given', () => {
        assert.equal(toMatterLevel(140), 254);
        assert.equal(toMatterLevel(-5), 1);
        assert.equal(fromMatterLevel(400), 100);
        assert.equal(fromMatterLevel(undefined), 0);
    });
});

describe('what a TV shows over Matter', () => {
    const inputs = [
        { name: 'HDMI1', reference: 'com.webos.app.hdmi1', mode: 0 },
        { name: 'AppleTV', reference: 'com.webos.app.hdmi2', mode: 0 },
    ];

    it('publishes the power, then one switch per input', () => {
        const plan = planAccessories({ name: 'LG UP75' }, inputs);

        assert.deepEqual(plan.map(entry => entry.kind), ['power', 'input', 'input']);
        assert.deepEqual(plan.map(entry => entry.name), ['LG UP75', 'LG UP75 HDMI1', 'LG UP75 AppleTV']);
        assert.equal(plan[1].reference, 'com.webos.app.hdmi1');
    });

    it('publishes the backlight only where it is being controlled', () => {
        const withBacklight = planAccessories({ name: 'LG UP75', picture: { backlightControl: true } }, []);
        assert.deepEqual(withBacklight.map(entry => entry.kind), ['power', 'backlight']);

        const without = planAccessories({ name: 'LG UP75', picture: { backlightControl: false } }, []);
        assert.deepEqual(without.map(entry => entry.kind), ['power']);
    });

    it('can be asked for the power alone', () => {
        const plan = planAccessories({ name: 'LG UP75', picture: { backlightControl: true }, matter: { inputs: false, backlight: false } }, inputs);
        assert.deepEqual(plan.map(entry => entry.kind), ['power']);
    });

    it('gives each accessory a key of its own, so they do not collide', () => {
        const keys = planAccessories({ name: 'LG UP75', picture: { backlightControl: true } }, inputs).map(entry => entry.key);
        assert.equal(new Set(keys).size, keys.length);
    });

    it('leaves out an input the config cannot address', () => {
        const plan = planAccessories({ name: 'LG UP75' }, [{ name: 'Nameless' }, { reference: 'com.webos.app.hdmi3' }]);
        assert.deepEqual(plan.map(entry => entry.kind), ['power']);
    });
});

describe('what a bridged accessory calls itself', () => {
    it('keeps the serial number within what the spec allows', () => {
        // A controller that reads a longer one can refuse the whole bridge rather than the one
        // device, which is how the Aqara app failed to finish adding the TVs.
        const serial = serialFor('B0:37:95:59:4B:62', 'i1');
        assert.equal(serial, 'B03795594B62-i1');
        assert.ok(serial.length <= 32);
        assert.ok(serialFor('192.168.1.168', 'backlight-com.webos.app.hdmi1').length <= 32);
    });

    it('keeps the name within it too', () => {
        assert.equal(trimName('LG UP75'), 'LG UP75');
        assert.equal(trimName('x'.repeat(40)).length, 32);
    });

    it('gives every accessory of one TV its own serial', () => {
        const plan = planAccessories({ name: 'LG UP75', picture: { backlightControl: true } }, [
            { name: 'XBOX', reference: 'com.webos.app.hdmi1', mode: 0 },
            { name: 'Apple TV', reference: 'com.webos.app.hdmi2', mode: 0 },
        ]);
        const serials = plan.map(entry => serialFor('B0:37:95:59:4B:62', entry.key));
        assert.equal(new Set(serials).size, serials.length);
    });
});
