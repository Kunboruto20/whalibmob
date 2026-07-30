'use strict';

class USyncUsernameProtocol {
    constructor() {
        this.name = 'username';
    }

    getQueryElement() {
        return {
            tag: 'username',
            attrs: {}
        };
    }

    getUserElement() {
        return null;
    }

    parser(node) {
        if (node.tag === 'username' || node.description === 'username') {
            return typeof node.content === 'string' ? node.content : null;
        }
        return null;
    }
}

module.exports = { USyncUsernameProtocol };
