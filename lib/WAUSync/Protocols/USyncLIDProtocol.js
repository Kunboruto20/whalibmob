'use strict';

class USyncLIDProtocol {
    constructor() {
        this.name = 'lid';
    }

    getQueryElement() {
        return {
            tag: 'lid',
            attrs: {}
        };
    }

    getUserElement(user) {
        if (user.lid) {
            return {
                tag: 'lid',
                attrs: { jid: user.lid }
            };
        }
        return null;
    }

    parser(node) {
        if (node.tag === 'lid' || node.description === 'lid') {
            const attrs = node.attrs || {};
            return attrs.val || null;
        }
        return null;
    }
}

module.exports = { USyncLIDProtocol };
