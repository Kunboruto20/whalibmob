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

        if (node.tag === 'devices' || node.description === 'devices') {
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

        return { deviceList, keyIndex };
    }
}

module.exports = { USyncDeviceProtocol };
