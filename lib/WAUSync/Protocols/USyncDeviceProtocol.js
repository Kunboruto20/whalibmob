'use strict';

function findChild(node, desc) {
    if (!node || !Array.isArray(node.content)) return null;
    return node.content.find(c => c && (c.description === desc || c.tag === desc)) || null;
}

class USyncDeviceProtocol {
    constructor() {
        this.name = 'devices';
    }

    getQueryElement() {
        return {
            tag: 'devices',
            attrs: { version: '2' }
        };
    }

    getUserElement() {
        return null;
    }

    parser(node) {
        const deviceList = [];
        let keyIndex = undefined;
        let error = undefined;

        if (node.tag === 'devices' || node.description === 'devices') {
            // Surface a server-side error instead of degrading silently: an
            // <error> child (or an error attr) means the device list is absent,
            // and without this the caller would fall back to device 0 only and
            // silently drop every companion device.
            const errorNode = findChild(node, 'error');
            if (errorNode || (node.attrs && node.attrs.error)) {
                const a = (errorNode && errorNode.attrs) || node.attrs || {};
                error = {
                    code: a.code || a.error || 'unknown',
                    text: a.text || a.reason || ''
                };
            }

            const deviceListNode = findChild(node, 'device-list');
            const keyIndexNode = findChild(node, 'key-index-list');

            if (Array.isArray(deviceListNode && deviceListNode.content)) {
                for (const item of deviceListNode.content) {
                    const tag = item && (item.tag || item.description);
                    const attrs = item && item.attrs;
                    if (tag === 'device' && attrs) {
                        const id = +attrs.id;
                        const ki = +attrs['key-index'];
                        deviceList.push({
                            id,
                            keyIndex: ki,
                            isHosted: !!(attrs['is_hosted'] && attrs['is_hosted'] === 'true')
                        });
                    }
                }
            }

            if (keyIndexNode) {
                const attrs = keyIndexNode.attrs || {};
                keyIndex = {
                    timestamp: +attrs['ts'],
                    signedKeyIndex: keyIndexNode.content,
                    expectedTimestamp: attrs['expected_ts'] ? +attrs['expected_ts'] : undefined
                };
            }
        }

        return { deviceList, keyIndex, error };
    }
}

module.exports = { USyncDeviceProtocol };
