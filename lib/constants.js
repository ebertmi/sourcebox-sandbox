'use strict';

var util = require('util');

var constants = {
  SOURCE_HOSTNAME: 'source',
  BOX_HOSTNAME: 'box',
  CONTAINER_NAME: '%s.box',
  INIT_PATH: '/sbin',
  INIT_COMMAND: 'sourcebox-init',
  LOOPFILE: 'sourcebox.fs',
  MIN_LOOP_SIZE: '1GB',
  USER: 'user',
  LANG: 'en_US.utf8',
  UID: 1000,
  SUBID_FIRST: 100000,
  SUBID_COUNT: 100000,
  APP_ARMOR_PROFILE: 'unconfined'
};

constants.SOURCE_CONTAINER = util.format(constants.CONTAINER_NAME,
                                         constants.SOURCE_HOSTNAME);

module.exports = constants;
