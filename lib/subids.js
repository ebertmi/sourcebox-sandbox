'use strict';

var fs = require('fs-extra');
var path = require('path');
var util = require('util');

var Promise = require('bluebird');

var constants = require('./constants');
var sbutil = require('./util');

var first = constants.SUBID_FIRST;
var count = constants.SUBID_COUNT;

function getOrCreateSubIds(group) {
  var file = path.join('/etc/', group ? 'subgid' : 'subuid');

  return fs.readFileAsync(file, 'utf8')
    .then(extractSubIds)
    .catch(function () {
      // maybe log that we are adding subuids
      return createSubIds(group);
    });
}

function extractSubIds(data) {
    var matches = data.match(/^root:(\d+):(\d+)$/m);

    if (!matches) {
      throw new Error('No subids found');
    }

    return {
      first: +matches[1],
      count: +matches[2]
    };
}

function createSubIds(group) {
  // TODO make sure the range we are adding is unused
  var cmd = group ? '--add-subgids' : '--add-subuids';
  var range = util.format('%d-%d', first, first + count - 1);

  return sbutil.execFilePromise('usermod', [cmd, range, 'root'])
    .return({
      first: first,
      count: count
    });
}

module.exports = function() {
  return Promise.props({
    u: getOrCreateSubIds(false),
    g: getOrCreateSubIds(true),
  });
};
