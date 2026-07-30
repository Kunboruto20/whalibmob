'use strict';

class USyncStatusProtocol {
    constructor() {
        this.name = 'status';
    }

    getQueryElement() {
        return {
            tag: 'status',
            attrs: {}
        };
    }

    getUserElement() {
        return null;
    }

    parser(node) {
        if (node.tag === 'status' || node.description === 'status') {
            let status = node.content != null ? node.content.toString() : null;
            const attrs = node.attrs || {};
            const setAt = new Date(+(attrs.t || 0) * 1000);

            if (!status) {
                if (attrs.code && +attrs.code === 401) {
                    status = '';
                } else {
                    status = null;
                }
            } else if (typeof status === 'string' && status.length === 0) {
                status = null;
            }

            return { status, setAt };
        }
    }
}

module.exports = { USyncStatusProtocol };
