import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromMatterLevel, planAccessories, toMatterLevel } from '../src/matter.js';

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
