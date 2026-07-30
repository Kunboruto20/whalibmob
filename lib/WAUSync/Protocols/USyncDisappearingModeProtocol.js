'use strict';

class USyncDisappearingModeProtocol {
    constructor() {
        this.name = 'disappearing_mode';
    }

    getQueryElement() {
        return {
            tag: 'disappearing_mode',
            attrs: {}
        };
    }

    getUserElement() {
        return null;
    }

    parser(node) {
        if (node.tag === 'disappearing_mode' || node.description === 'disappearing_mode') {
            const attrs = node.attrs || {};
            const duration = +attrs.duration;
            const setAt = new Date(+(attrs.t || 0) * 1000);
            return { duration, setAt };
        }
    }
}

module.exports = { USyncDisappearingModeProtocol };
