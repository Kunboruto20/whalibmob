'use strict';

const { USyncDeviceProtocol } = require('./USyncDeviceProtocol');
const { USyncContactProtocol } = require('./USyncContactProtocol');
const { USyncStatusProtocol } = require('./USyncStatusProtocol');
const { USyncDisappearingModeProtocol } = require('./USyncDisappearingModeProtocol');
const { USyncUsernameProtocol } = require('./USyncUsernameProtocol');
const { USyncLIDProtocol } = require('./USyncLIDProtocol');

module.exports = {
    USyncDeviceProtocol,
    USyncContactProtocol,
    USyncStatusProtocol,
    USyncDisappearingModeProtocol,
    USyncUsernameProtocol,
    USyncLIDProtocol
};
