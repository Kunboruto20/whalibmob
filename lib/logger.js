'use strict';

const _noop = {
  trace: () => {},
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {}
};

let _logger = _noop;

function configureLogger(opts) {
  if (!opts || opts === false) {
    _logger = _noop;
    return;
  }
  try {
    const pino = require('pino');
    const pinoOpts = (opts === true) ? { level: 'debug' } : opts;
    _logger = pino(pinoOpts);
  } catch (_) {
    _logger = _noop;
  }
}

function getLogger() {
  return _logger;
}

function dbg(msg)  { _logger.debug(msg); }
function warn(msg) { _logger.warn(msg); }
function err(msg)  { _logger.error(msg); }
function info(msg) { _logger.info(msg); }

module.exports = { configureLogger, getLogger, dbg, warn, err, info };
