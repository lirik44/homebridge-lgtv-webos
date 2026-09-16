import EventEmitter from 'events';

/**
 * How long after a command the TV is read back, to catch up with what it actually did.
 * A webOS TV answers a launch request before it has switched, and a TV woken by magic packet
 * takes several seconds to say it is on.
 */
const RefreshAfterCommand = [1000, 4000, 12000];

/** The Matter level scale, which runs 1..254 where a percentage runs 0..100. */
const MatterLevelMax = 254;

/** What the Matter spec allows for a bridged device's serial number and name. */
const SerialNumberMax = 32;
const NameMax = 32;

/**
 * Turns a percentage into the level a Matter controller works in.
 *
 * @param {number} percent 0..100.
 * @returns {number} 1..254. Level 0 means "off" in Matter, so the dimmest lit value is 1.
 */
export function toMatterLevel(percent) {
    const level = Math.round((Number(percent) || 0) * (MatterLevelMax / 100));
    return Math.max(1, Math.min(MatterLevelMax, level));
}

/**
 * Turns a Matter level back into the percentage the TV takes.
 *
 * @param {number} level 1..254.
 * @returns {number} 0..100.
 */
export function fromMatterLevel(level) {
    const percent = Math.round((Number(level) || 0) / (MatterLevelMax / 100));
    return Math.max(0, Math.min(100, percent));
}

/**
 * Works out what to expose over Matter for one TV.
 *
 * Matter has a device type for a television, but no controller renders it: neither Apple Home nor
 * the Aqara app know what to do with a media player, and an accessory they cannot render is an
 * accessory that does not appear. So the TV is published as the plain devices every controller
 * does render - a switch for the power, one per input, and a dimmer for the backlight. That is the
 * same arrangement this plugin's Matterbridge sibling settled on.
 *
 * @param {object} device The device configuration, as it appears in the platform config.
 * @param {Array<{name: string, reference: string, mode: number}>} inputs The inputs to expose.
 * @returns {Array<{kind: string, key: string, name: string, reference?: string}>} What to publish,
 *   in the order it should appear.
 */
export function planAccessories(device, inputs = []) {
    const matter = device?.matter ?? {};
    const name = device?.name ?? 'LG TV';
    const plan = [{ kind: 'power', key: 'power', name: trimName(name) }];

    if (matter.inputs !== false) {
        let index = 0;
        for (const input of inputs) {
            if (!input?.reference || !input?.name) {
                continue;
            }
            index += 1;
            // The key becomes part of a serial number, which the spec keeps short, so it counts
            // the inputs rather than spelling out references like com.webos.app.hdmi1.
            plan.push({ kind: 'input', key: `i${index}`, name: trimName(`${name} ${input.name}`), reference: input.reference });
        }
    }

    // Only worth publishing what the TV is actually being asked to control.
    if (matter.backlight !== false && device?.picture?.backlightControl) {
        plan.push({ kind: 'backlight', key: 'bl', name: trimName(`${name} Backlight`) });
    }

    return plan;
}

/**
 * @param {string} name The name to show in the controller app.
 * @returns {string} It, within what the spec allows a bridged device's name to be.
 */
export function trimName(name) {
    return String(name).slice(0, NameMax);
}

/**
 * Builds the serial number a bridged accessory is published with.
 *
 * The spec allows 32 characters, and a controller that reads a longer one can refuse the whole
 * bridge rather than the one device - which is how a TV's inputs, spelled out as
 * `192.168.1.168-input-com.webos.app.hdmi1`, kept the Aqara app from finishing.
 *
 * @param {string} mac The TV's MAC address, its one stable identifier.
 * @param {string} key What this accessory stands for.
 * @returns {string} A serial number within the limit.
 */
export function serialFor(mac, key) {
    const base = String(mac ?? '').replace(/[^\w]/g, '').toUpperCase();
    return `${base}-${key}`.slice(0, SerialNumberMax);
}

/**
 * Publishes one TV over Matter, alongside the HomeKit accessory rather than instead of it.
 *
 * HomeKit reads a characteristic whenever it wants one; a Matter controller keeps its own copy and
 * only learns of a change when the node reports it. So everything this class does comes down to
 * two things: send what the controller asks for to the same place the HomeKit handlers send it,
 * and report back every change the TV makes, whoever made it.
 */
export class LgWebOsMatter extends EventEmitter {
    /**
     * @param {object} api The Homebridge API.
     * @param {object} lgDevice The started device, which owns the connection and the state.
     * @param {object} device Its configuration, as it appears in the platform config.
     */
    constructor(api, lgDevice, device) {
        super();
        this.api = api;
        this.lgDevice = lgDevice;
        this.device = device;
        this.accessories = new Map();
        this.published = new Map();
        this.refreshTimers = [];
        this.syncInterval = null;
    }

    /**
     * @param {object} api The Homebridge API.
     * @returns {boolean} Whether this Homebridge can publish over Matter at all.
     */
    static isAvailable(api) {
        return !!(api?.isMatterAvailable?.() && api?.isMatterEnabled?.() && api?.matter?.registerPlatformAccessories);
    }

    /**
     * Builds and registers everything this TV shows over Matter.
     *
     * @returns {Promise<boolean>} Whether anything was published.
     */
    async register(cached = []) {
        if (this.device?.matter?.enable === false) {
            await this.unregisterStale(cached);
            return false;
        }
        if (!LgWebOsMatter.isAvailable(this.api)) {
            this.emit('debug', 'Matter is not enabled for this bridge, publishing over HomeKit only');
            return false;
        }

        const matter = this.api.matter;
        const inputs = (this.lgDevice.inputsServices ?? []).map(input => ({ name: input.name, reference: input.reference, mode: input.mode }));
        const plan = planAccessories(this.device, inputs);
        const toRegister = [];

        for (const entry of plan) {
            const uuid = matter.uuid.generate(`lgwebos-matter-${this.device.host}-${entry.key}`);
            const accessory = {
                UUID: uuid,
                displayName: entry.name,
                deviceType: this.deviceTypeFor(entry.kind),
                manufacturer: 'LG Electronics',
                model: this.lgDevice.savedInfo?.modelName ?? 'webOS TV',
                serialNumber: serialFor(this.device.mac ?? this.device.host, entry.key),
                clusters: this.clustersFor(entry.kind),
                handlers: this.handlersFor(entry),
                context: { host: this.device.host, key: entry.key },
            };

            toRegister.push(accessory);
            this.accessories.set(uuid, entry);
        }

        try {
            await matter.registerPlatformAccessories(this.pluginName, this.platformName, toRegister);
        } catch (error) {
            this.emit('warn', `Matter registration failed: ${error}`);
            return false;
        }

        await this.unregisterStale(cached);
        this.emit('success', `Published ${toRegister.length} Matter accessory(ies): ${plan.map(entry => entry.name).join(', ')}`);
        this.startStateSync();
        return true;
    }

    /**
     * Takes away what this TV used to publish and no longer does.
     *
     * A controller keeps whatever it was once given: turn the inputs off in the config and,
     * without this, they stay in the Aqara app for ever as devices that answer nothing.
     *
     * @param {Array<object>} cached The accessories Homebridge restored for this plugin.
     * @returns {Promise<void>} Resolves once they are gone.
     */
    async unregisterStale(cached = []) {
        const stale = cached.filter(accessory => accessory?.context?.host === this.device.host && !this.accessories.has(accessory.UUID));
        if (stale.length === 0) {
            return;
        }

        try {
            await this.api.matter.unregisterPlatformAccessories(this.pluginName, this.platformName, stale);
            this.emit('success', `Removed ${stale.length} Matter accessory(ies) no longer published: ${stale.map(accessory => accessory.displayName).join(', ')}`);
        } catch (error) {
            this.emit('warn', `Could not remove the Matter accessories no longer published: ${error}`);
        }
    }

    /**
     * @param {string} pluginName The plugin identifier to register under.
     * @param {string} platformName The platform name to register under.
     * @returns {LgWebOsMatter} This object, so the names can be set where it is built.
     */
    registeredAs(pluginName, platformName) {
        this.pluginName = pluginName;
        this.platformName = platformName;
        return this;
    }

    /**
     * @param {string} kind What the accessory stands for.
     * @returns {object} The Matter device type to publish it as.
     */
    deviceTypeFor(kind) {
        const types = this.api.matter.deviceTypes;
        if (kind === 'backlight') {
            // A dimmer is rendered with a slider by every controller; a dimmable outlet is not.
            return types.DimmableLight;
        }
        // An outlet keeps the TV out of "turn off all the lights"; a light is there for anyone
        // whose controller only offers scenes over lights.
        return this.device?.matter?.switchStyle === 'light' ? types.OnOffLight : types.OnOffOutlet;
    }

    /**
     * @param {string} kind What the accessory stands for.
     * @returns {object} The cluster state it is registered with.
     */
    clustersFor(kind) {
        if (kind === 'backlight') {
            return { onOff: { onOff: false }, levelControl: { currentLevel: toMatterLevel(this.lgDevice.backlight ?? 0) } };
        }
        return { onOff: { onOff: false } };
    }

    /**
     * @param {{kind: string, reference?: string}} entry The accessory to wire up.
     * @returns {object} Its command handlers, which drive the TV the same way HomeKit does.
     */
    handlersFor(entry) {
        const acted = (result) => {
            this.refreshSoon();
            return { success: result !== false };
        };

        switch (entry.kind) {
            case 'power':
                return {
                    onOff: {
                        on: async () => acted(await this.lgDevice.setPower(true)),
                        off: async () => acted(await this.lgDevice.setPower(false)),
                    },
                };

            case 'input':
                return {
                    onOff: {
                        // Switching away from an input means nothing on a TV: it is always showing
                        // something. Turning one on is the whole command.
                        on: async () => acted(await this.lgDevice.setInputReference(entry.reference)),
                        off: async () => acted(true),
                    },
                };

            case 'backlight':
                return {
                    onOff: {
                        on: async () => acted(await this.lgDevice.setBacklight(100)),
                        off: async () => acted(await this.lgDevice.setBacklight(0)),
                    },
                    levelControl: {
                        moveToLevel: async (request) => acted(await this.lgDevice.setBacklight(fromMatterLevel(request?.level))),
                        moveToLevelWithOnOff: async (request) => acted(await this.lgDevice.setBacklight(fromMatterLevel(request?.level))),
                    },
                };

            default:
                return undefined;
        }
    }

    /**
     * Reports the current state of every published accessory, and keeps doing so.
     *
     * @returns {void}
     */
    startStateSync() {
        const seconds = Math.max(Number(this.device?.matter?.stateSyncSeconds) || 60, 15);
        this.stopStateSync();
        this.syncInterval = setInterval(() => this.update(), seconds * 1000);
        this.update();
    }

    /**
     * @returns {void}
     */
    stopStateSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        for (const timer of this.refreshTimers) {
            clearTimeout(timer);
        }
        this.refreshTimers = [];
    }

    /**
     * Reads the TV back a few times after it has been commanded.
     *
     * @returns {void}
     */
    refreshSoon() {
        for (const timer of this.refreshTimers) {
            clearTimeout(timer);
        }
        this.refreshTimers = RefreshAfterCommand.map(delay => setTimeout(() => this.update(), delay));
    }

    /**
     * Reports whatever has changed since the last time.
     *
     * @returns {void}
     */
    update() {
        const matter = this.api?.matter;
        if (!matter?.updateAccessoryState) {
            return;
        }

        for (const [uuid, entry] of this.accessories) {
            const clusters = this.stateFor(entry);
            for (const [cluster, attributes] of Object.entries(clusters)) {
                const key = `${uuid}:${cluster}`;
                const payload = JSON.stringify(attributes);
                if (this.published.get(key) === payload) {
                    continue;
                }

                this.published.set(key, payload);
                Promise.resolve(matter.updateAccessoryState(uuid, cluster, attributes))
                    .catch(error => this.emit('warn', `Could not report ${cluster} of ${entry.name}: ${error}`));
                this.emit('debug', `Matter: ${entry.name} ${cluster} = ${payload}`);
            }
        }
    }

    /**
     * @param {{kind: string, reference?: string}} entry The accessory to describe.
     * @returns {object} What its clusters should say right now.
     */
    stateFor(entry) {
        const power = this.lgDevice.power === true;

        switch (entry.kind) {
            case 'power':
                return { onOff: { onOff: power } };

            case 'input':
                // An input is "on" when the TV is on and showing it.
                return { onOff: { onOff: power && this.lgDevice.reference === entry.reference } };

            case 'backlight':
                return {
                    onOff: { onOff: power },
                    levelControl: { currentLevel: toMatterLevel(this.lgDevice.backlight ?? 0) },
                };

            default:
                return {};
        }
    }
}
