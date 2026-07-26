'use strict';

class USyncContactProtocol {
    constructor() {
        this.name = 'contact';
    }

    getQueryElement() {
        return {
            tag: 'contact',
            attrs: {}
        };
    }

    getUserElement(user) {
        if (user.phone) {
            return {
                tag: 'contact',
                attrs: {},
                content: user.phone
            };
        }
        if (user.username) {
            return {
                tag: 'contact',
                attrs: {
                    username: user.username,
                    ...(user.usernameKey ? { pin: user.usernameKey } : {}),
                    ...(user.lid ? { lid: user.lid } : {})
                }
            };
        }
        if (user.type) {
            return {
                tag: 'contact',
                attrs: { type: user.type }
            };
        }
        return {
            tag: 'contact',
            attrs: {}
        };
    }

    parser(node) {
        if (node.tag === 'contact' || node.description === 'contact') {
            const attrs = node.attrs || {};
            if (attrs.code && +attrs.code !== 200) return false;
            return attrs.type === 'in';
        }
        return false;
    }
}

module.exports = { USyncContactProtocol };
