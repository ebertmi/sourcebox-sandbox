'use strict';

var pathModule = require('path');

var Promise = require('bluebird');
var _  = require('lodash');
var retry = require('bluebird-retry');

var btrfs = require('./btrfs');
var constants = require('./constants');
var sbfs = require('./fs');
var sbutil = require('./util');

var home = pathModule.join('/home', constants.USER);

var sandboxOptions = {
  uid: constants.UID,
  gid: constants.UID,
  cwd: home,
  env: {
    USER: constants.USER,
    HOME: home,
    LANG: constants.LANG
  }
};

var fileOptions = {
  cgroup: false,
  // all namespaces except pid and ipc
  namespaces: ['user', 'mount', 'uts', 'net']
};

// wrapper around basic lxc api
// lots of convenience methods!
function Box(source, container, options) {
  this.source = source;
  this._attachOptions = options || sandboxOptions;
  this.container = container;
  this.name = container._name;
}

// quota
//  default: -1
//  min: 1ms
//  max: infinity
//
// period
//  default: 100ms
//  min: 1ms
//  max: 1s
//
// three ways to call this:
//
// value = null: removes limit
// value = number: sets quota in ms
// value = object: {quota: quota, period: period}
Box.prototype.setCpuLimit = function (value, microseconds) {
  try {
    if (value == null) {
      this.container.setCgroupItem('cpu.cfs_quota_us', -1);
      return;
    }

    var quota;
    var period;

    if (_.isNumber(value)) {
      quota = value;
    } else if (_.isPlainObject(value)) {
      quota = value.quota;
      period = value.period;
    } else {
      throw new TypeError('Invalid argument');
    }

    if (quota) {
      quota = Math.round(quota) * (microseconds ? 1 : 1000);

      if (quota < 1000) {
        throw new Error('Quota must be at least 1ms');
      }

      this.container.setCgroupItem('cpu.cfs_quota_us', quota);
    }

    if (period) {
      period = Math.round(period) * (microseconds ? 1 : 1000);

      if (period < 1000 || period > 1000 * 1000) {
        throw new Error('Period must be between 1ms and 1s');
      }

      this.container.setCgroupItem('cpu.cfs_period_us', period);
    }
  } catch (err) {
    throw new Error('Failed to set CPU limit: ' + err.message);
  }
};

Box.prototype.setMemoryLimit = function (size) {
  try {
    if (size == null) {
      size = -1;
    } else {
      size = sbutil.parseBytes(size);
    }

    this.container.setCgroupItem('memory.limit_in_bytes', size);
    this.container.setCgroupItem('memory.memsw.limit_in_bytes', size);
  } catch (err) {
    throw new Error('Failed to set memory limit: ' + err.message);
  }
};

Box.prototype.setProcessLimit = function (count) {
  try {
    if (count == null) {
      count = 'max';
    } else {
      if (!isFinite(count) || count < 0) {
        throw new RangeError('Only finite positive values are allowed');
      }

      count = Math.floor(count) + 1; // +1 for init
    }

    this.container.setCgroupItem('pids.max', count);
  } catch (err) {
    throw new Error('Failed to set process limit: ' + err.message);
  }
};

Box.prototype.setDiskspaceLimit = function (size, callback) {
  if (size == null) {
    size = 'none';
  } else {
    size = sbutil.parseBytes(size, true);
  }

  var rootfs = this.container.getConfigItem('lxc.rootfs');
  return btrfs.setQuota(rootfs, size).asCallback(callback);
};

Box.prototype.attach = function (command, args, options) {
  if (!_.isArray(args)) {
    options = args;
    args = [];
  }

  options = _.defaultsDeep({}, options, this._attachOptions);

  if (!pathModule.isAbsolute(options.cwd)) {
    options.cwd = pathModule.join(this._attachOptions.cwd, options.cwd);
  }

  return this.container.attach(command, args, options);
};

Box.prototype.spawn = Box.prototype.exec = Box.prototype.attach;

Box.prototype.openFile = function (path, flags, options, callback) {
  if (!pathModule.isAbsolute(path)) {
    path = pathModule.join(this._attachOptions.cwd, path);
  }

  if (_.isFunction(options)) {
    callback = options;
    options = this._attachOptions;
  } else {
    options = _.defaults({}, options, this._attachOptions);
  }

  return this.container.openFileAsync(path, flags, options)
    .asCallback(callback);
};

Box.prototype.readFile = function (path, options, callback) {
  if (_.isString(options)) {
    options = { encoding: options };
  } else if (_.isFunction(options)) {
    callback = options;
    options = {};
  }

  options = _.defaults({}, options, {
    encoding: 'utf8',
    flag: 'r',
    maxSize: Infinity
  });

  if (!_.isNumber(options.maxSize)) {
    options.maxSize = sbutil.toBytes(options.maxSize);
  }

  return sbfs.readFile(this, path, options).asCallback(callback);
};

Box.prototype.writeFile = function (path, data, options, callback) {
  if (_.isString(options)) {
    options = { encoding: options };
  } else if (_.isFunction(options)) {
    callback = options;
    options = {};
  }

  options = _.defaults({}, options, {
    encoding: 'utf8',
    flag: 'w'
  });

  return sbfs.writeFile(this, path, data, options).asCallback(callback);
};

Box.prototype.createReadStream = function (path, options) {
  return new sbfs.ReadStream(this, path, options);
};

Box.prototype.createWriteStream = function (path, options) {
  return new sbfs.WriteStream(this, path, options);
};

// a bunch of convenience fs functions. these depend on binaries in the container
// and are not "sandboxed", meaning that resource limits dont apply (except
// disk space which always applies), so be careful
//
// for writing, use open or read/write streams + nodejs fs api functions that take a fd
//
function wrapCommand(command, argumentMap) {
  return function (path, options, callback) {
    var args = [];

    if (_.isFunction(options)) {
      callback = options;
    } else if (options) {
      _.each(argumentMap, function (v, k) {
        if (options[k]) {
          args.push(v);
        }
      });
    }

    args.push('--');

    if (_.isArray(path)) {
      args.push.apply(args, path);
    } else {
      args.push(path);
    }

    var child = this.attach(command, args, fileOptions);

    return sbutil.processPromise(child)
      .asCallback(callback);
  };
}

Box.prototype.mkdir = wrapCommand('mkdir', {
  parents: '-p'
});

Box.prototype.rm = wrapCommand('rm', {
  recursive: '-r',
  force: '-f',
  dir: '-d',
});

Box.prototype.cp = wrapCommand('cp', {
  archive: '-a',
  recursive: '-r'
});

Box.prototype.ln = wrapCommand('ln', {
  symlink: '-s'
});

// mv, cp, ln?

// best effort destroy
Box.prototype.destroy = function (callback) {
  if (this.destroyed) {
    return Promise.reject(new Error('destroy has already been called'))
      .asCallback(callback);
  }

  this.destroyed = true;

  var rootfs = this.container.getConfigItem('lxc.rootfs');

  // For unknown lxc reasons, container.stop() sometimes reports fails when in
  // reality it succeeds. Happens when there are a lot of stop() calls going on
  // at once. So we just retry a bunch of times with exponential backoff.
  var stopRetry = retry(this.container.stopAsync.bind(this.container), {
    interval: 200,
    max_tries: 5,
    backoff: 2
  });

  // use settle and reflect to always call all destroy steps, even if something
  // fails early in the chain
  return Promise.all([btrfs.destroyQuota(rootfs).reflect(), stopRetry.reflect()])
    .bind(this)
    .then(function (results) {
      return this.container.destroyAsync()
        .reflect()
        .then(function (result) {
          results.push(result);
          return results;
        });
    })
    .then(function (results) {
      var errors = results.reduce(function (errors, result) {
        if (result.isRejected()) {
          errors.push(result.reason());
        }
        return errors;
      }, []);

      if (errors.length >= 2) {
        var error = new Promise.AggregateError('Destruction failed with multiple errors');
        error.push.apply(error, errors);
        throw error;
      } else if (errors.length) {
        throw sbutil.error('Destruction incomplete: ' + errors[0].message, errors[0]);
      }
    });
};

module.exports = Box;
