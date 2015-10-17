'use strict';

var pathModule = require('path');
var util = require('util');

var Promise = require('bluebird');
var _  = require('lodash');
var fs = require('fs-extra');
var lxc = require('@sourcebox/lxc');
var shortid = require('shortid');

var Box = require('./box');
var CreationContext = require('./create');
var constants = require('./constants');
var btrfs = require('./btrfs');
var sbutil = require('./util');

Promise.promisifyAll(lxc);
// 'start stop destroy create clone loadConfig saveConfig openFile getContainer'.split(' ')
Promise.promisifyAll(fs);

// FIXME find some sane defaults
var defaultConfig = {
  hostname: constants.HOSTNAME,
  limits: {
    diskspace: '100MB',
    memory: '30MB', // going to low here will slow gcc to a crawl
    cpu: 0.10, // 10%
    processes: 20, // requires very recent kernel 4.3+
  },
};

var manageOptions = {
  uid: 0,
  gid: 0,
  cwd: '/root',
  env: {
    USER: 'root',
    HOME: '/root',
    LANG: constants.LANG
  },
  cgroup: false,
  // all namespaces except net
  namespaces: ['user', 'mount', 'pid', 'uts', 'ipc']
};

var initCommand = pathModule.join('/', constants.INIT_PATH, constants.INIT_COMMAND);

function applyConfig(box, config) {
  box.container.setConfigItem('lxc.utsname', config.hostname);

  var limits = config.limits;

  if (limits.memory != null) {
    box.setMemoryLimit(limits.memory);
  }

  if (limits.cpu != null) {
    var cpu = limits.cpu;
    if (_.isPlainObject(cpu)) {
      box.setCpuLimit(cpu.quota, cpu.period);
    } else {
      box.setCpuLimit(cpu);
    }
  }

  if (limits.processes != null) {
    box.setProcessLimit(limits.processes);
  }

  if (limits.diskspace != null) {
    return box.setDiskspaceLimit(limits.diskspace);
  }
}

function Sourcebox(dir, config) {
  if (!(this instanceof Sourcebox)) {
    return new Sourcebox(dir, config);
  }

  this.config = _.defaultsDeep({}, defaultConfig, config);

  this.path = pathModule.resolve(dir);
}

module.exports = exports = Sourcebox;

/**
 * Initializes the source container.
 *
 * It's completely optional to call this method.
 * Calling it will speed up the creation of the FIRST sandbox.
 * It can be useful to detect errors with the source container.
 * If its not called manually, it will be called by the first call to createSandbox
 */
Sourcebox.prototype.init = function (callback) {
  var loopfile = pathModule.join(this.path, constants.LOOPFILE);

  if (!this._containerPromise) {
    this._containerPromise = sbutil.isDir(this.path)
      .bind(this)
      .then (function () {
        return fs.statAsync(loopfile)
          .bind(this)
          .then(function () {
            // a loopfile exists, try to mount it
            return btrfs.mountLoopfile(loopfile, this.path);
          }, _.noop)
          .catch(sbutil.rethrow('Failed to mount loop filesystem'));
      })
      .then(function () {
        // make sure path is a btrfs filesystem
        return btrfs.isBtrfs(this.path)
          .catch(sbutil.rethrow('Path is not a btrfs filesystem'));
      })
      .then(function () {
        return lxc.getContainerAsync(constants.SOURCE, {
          path: this.path,
          defined: true
        });
      });
  }

  return this._containerPromise
    .bind()
    .return() // do not leak container here, only throw errors
    .nodeify(callback);
};

Sourcebox.prototype._getContainer = function () {
  if (this._containerPromise) {
    return this._containerPromise;
  } else {
    return this.init()
      .return(this._containerPromise);
  }
};

Sourcebox.prototype.box = function (config, callback) {
  if (!_.isPlainObject(config)) {
    callback = config;
    config = null;
  }

  config = _.defaultsDeep({}, config, this.config);

  var name = util.format(constants.BOX, shortid.generate());

  return this._getContainer()
    .bind(this)
    .then(function (container) {
      return container.cloneAsync(name, {
        snapshot: true,
        keepname: true,
        keepmac: true
      });
    })
    .then(function (clone) {
      var box = new Box(this, clone);

      return box.container.startAsync(initCommand)
        .then(function () {
          return applyConfig(box, config);
        })
        .catch(function (err) {
          return box.destroy()
            .then(function () {
              throw err;
            }, function (destroyErr) {
              var aggregateError = new Promise.AggregateError();
              aggregateError.push(err);
              aggregateError.push(destroyErr);
              throw aggregateError;
            });
        })
        .return(box);
    })
    .nodeify(callback);
};

// starts the source container
// creates a box of the source container, not a clone
// no limits ofc
Sourcebox.prototype.manage = function (callback) {
  return this._getContainer()
    .then(function (container) {
      var configKey = 'lxc.mount.entry';

      try {
        var mounts = container.getConfigItem(configKey);

        if (!_.contains(mounts), constants.RESOLVMOUNT) {
          container.appendConfigItem(configKey, constants.RESOLVMOUNT);
        }
      } catch (err) {
        throw new Error('Failed to set up \'/etc/resolv.conf\' bind mount');
      }

      return container.startAsync(initCommand).return(container);
    })
    .then(function (container) {
      var box = new Box(null, container, manageOptions);

      // Override methods since this is not a sandbox
      box.destroy = function () {
        throw new Error('Cannot destroy the source container');
      };

      box.stop = function (callback) {
        return this.container.stopAsync().nodeify(callback);
      };

      return box;
    })
    .nodeify(callback);
};

// create a new sourcebox instance
Sourcebox.prototype.create = function (config, callback) {
  // TODO maybe lock init() and stuff while creation is in progress, and lock
  // creation if init() completed

  if (!config.distro || !config.release) {
    throw new Error('Distro and release are required');
  }

  var templateArgs = [
    '-d', config.distro,
    '-r', config.release,
    '-a', sbutil.getArch(config.arch)
  ];

  if (this.variant) {
    this.templateArgs.push('-v', config.variant);
  }

  var loopsize;

  if (config.loopsize) {
    loopsize = sbutil.parseBytes(config.loopsize);
    var min = sbutil.toBytes(constants.MIN_LOOP_SIZE);
    if (loopsize < min) {
      throw new Error(util.format('Loop file must be at least %s',
                                  constants.MIN_LOOP_SIZE));
    }
  }

  var context = new CreationContext(this, templateArgs, loopsize, config.progress);

  return context
    .create()
    .bind()
    .nodeify(callback);
};

exports.using = sbutil.using;
