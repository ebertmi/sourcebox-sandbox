'use strict';

var util = require('util');
var pathModule = require('path');
var os = require('os');

var Promise = require('bluebird');
var _ = require('lodash');
var fs = require('fs-extra');
var shortid = require('shortid');

var sbutil = require('./util');

function isDir(path) {
  return fs.statAsync(path)
    .then(function (stats) {
      if (!stats.isDirectory()) {
        var msg = util.format('\'%s\' is not a directory', path);
        throw new Error(msg);
      }
    }, function (err) {
      var msg = util.format('Unable to access \'%s\'', path);
      throw sbutil.error(msg, err);
    });
}

exports.isDir = isDir;

// bluebird disposers for resource cleanup

function withOpen(path, flags, mode) {
  return fs.openAsync(path, flags, mode)
    .disposer(function (fd) {
      return fs.closeAsync(fd);
    });
}

function withTempFile(mode) {
  var file = pathModule.join(os.tmpdir(),
      util.format('%s.sourcebox', shortid.generate()));

  return fs.openAsync(file, 'wx', mode || '0600')
    .then(function (fd) {
      return {
        fd: fd,
        path: file
      };
    })
    .disposer(function (file) {
      return Promise.all([
        fs.closeAsync(file.fd),
        fs.unlinkAsync(file.path)
      ]);
    });
}

exports.withOpen = withOpen;
exports.withTempFile = withTempFile;

// btrfs

function btrfs() {
  return sbutil.execFilePromise('btrfs', _.toArray(arguments));
}


function isBtrfs(path) {
  return btrfs('filesystem', 'label', path)
    .catch(sbutil.rethrow('\'%s\' does not appear to be a btrfs filesystem', path))
    .return();
}


function enableQuota(path) {
  return btrfs('quota', 'enable', path)
    .catch(sbutil.rethrow('Failed to enable quota for \'%s\'', path));
}


function setQuota(path, size) {
  return btrfs('qgroup', 'limit', '-e', size, path)
    .catch(sbutil.rethrow('Failed to set quota for \'%s\'', path));
}


function destroyQuota(path) {
  return btrfs('qgroup', 'show', '-F', path)
    .spread(function (stdout) {
      var line = stdout.split('\n')[2];

      if (line) {
        var matches = line.match(/^(\d+\/\d+) /);

        if (matches) {
          return btrfs('qgroup', 'destroy', matches[1], path);
        }
      }

      var err = new Error('Unable to find qgroup id in \'btrfs qgroup show\' output');
      err.stdout = stdout;

      throw err;
    })
    .catch(sbutil.rethrow('Failed to destroy quota for \'%s\'', path));
}

exports.btrfs = btrfs;
exports.isBtrfs = isBtrfs;
exports.enableQuota = enableQuota;
exports.setQuota = setQuota;
exports.destroyQuota = destroyQuota;

// loop mounts

function mountLoopFile(file, dir) {
  return sbutil.execFilePromise('mount', [
    '-o', 'loop',
    file, dir
  ]);
}

function createLoopMount(file, dir, size) {
  return Promise.using(withOpen(file, 'wx'), function (fd) {
      return fs.ftruncateAsync(fd, size);
  }).then(function () {
    return sbutil.execFilePromise('mkfs.btrfs', [file])
      .then(function () {
        return exports.mountLoopFile(file, dir);
      })
      .catch(function (err) {
        return fs.unlinkAsync(file)
        .throw(err);
      });
  });
}

function destroyLoopMount(dir) {
  return sbutil.execFilePromise('umount', [dir])
    .then(function () {
      return fs.removeAsync(dir);
    });
}

exports.mountLoopFile = mountLoopFile;
exports.createLoopMount = createLoopMount;
exports.destroyLoopMount = destroyLoopMount;
