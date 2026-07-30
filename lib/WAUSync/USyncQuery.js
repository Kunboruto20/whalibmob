'use strict';

const { USyncDeviceProtocol } = require('./Protocols/USyncDeviceProtocol');
const { USyncContactProtocol } = require('./Protocols/USyncContactProtocol');
const { USyncStatusProtocol } = require('./Protocols/USyncStatusProtocol');
const { USyncDisappearingModeProtocol } = require('./Protocols/USyncDisappearingModeProtocol');
const { USyncUsernameProtocol } = require('./Protocols/USyncUsernameProtocol');
const { USyncLIDProtocol } = require('./Protocols/USyncLIDProtocol');

function findChild(node, desc) {
    if (!node || !Array.isArray(node.content)) return null;
    return node.content.find(c => c && (c.description === desc || c.tag === desc)) || null;
}

class USyncQuery {
    constructor() {
        this.protocols = [];
        this.users = [];
        this.context = 'interactive';
        this.mode = 'query';
    }

    withMode(mode) {
        this.mode = mode;
        return this;
    }

    withContext(context) {
        this.context = context;
        return this;
    }

    withUser(user) {
        this.users.push(user);
        return this;
    }

    parseUSyncQueryResult(result) {
        if (!result || (result.attrs && result.attrs.type !== 'result')) {
            return;
        }

        const protocolMap = Object.fromEntries(
            this.protocols.map(protocol => [protocol.name, protocol.parser.bind(protocol)])
        );

        const queryResult = {
            list: [],
            sideList: []
        };

        const usyncNode = findChild(result, 'usync');
        const listNode = usyncNode ? findChild(usyncNode, 'list') : undefined;

        if (listNode && Array.isArray(listNode.content)) {
            queryResult.list = listNode.content.reduce((acc, node) => {
                const id = node && node.attrs && (node.attrs.jid || node.attrs.id);
                if (id) {
                    const data = Array.isArray(node.content)
                        ? Object.fromEntries(
                            node.content
                                .map(content => {
                                    const proto = content && (content.tag || content.description);
                                    const parser = proto && protocolMap[proto];
                                    if (parser) {
                                        return [proto, parser(content)];
                                    }
                                    return [proto, null];
                                })
                                .filter(([, b]) => b !== null)
                          )
                        : {};
                    acc.push({ ...data, id });
                }
                return acc;
            }, []);
        }

        return queryResult;
    }

    withDeviceProtocol() {
        this.protocols.push(new USyncDeviceProtocol());
        return this;
    }

    withContactProtocol() {
        this.protocols.push(new USyncContactProtocol());
        return this;
    }

    withStatusProtocol() {
        this.protocols.push(new USyncStatusProtocol());
        return this;
    }

    withDisappearingModeProtocol() {
        this.protocols.push(new USyncDisappearingModeProtocol());
        return this;
    }

    withLIDProtocol() {
        this.protocols.push(new USyncLIDProtocol());
        return this;
    }

    withUsernameProtocol() {
        this.protocols.push(new USyncUsernameProtocol());
        return this;
    }
}

module.exports = { USyncQuery };
