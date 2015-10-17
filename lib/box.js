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

/**
 * two forms
 *
 * if 0 < quota < 1:
 * set quota as percentage of period
 *
 * otherwise both values are interpreted as time in us
 *
 * period is optional
 */
Box.prototype.setCpuLimit = function (quota, period) {
  if (quota === null) {
    return this.container.setCgroupItem('cpu.cfs_quota_us', -1);
  }

  if (!period) {
    // FIXME this throws a very unhelpful error
    period = this.container.getCgroupItem('cpu.cfs_period_us');
  } else {
    period = Math.round(period);
  }

  if (quota <= 0 || period <= 0 || !isFinite(quota) || !isFinite(period)) {
      throw new RangeError('Only finite positive values are allowed');
  }

  if (quota < 1) {
    quota = Math.round(period * quota);
  }

  if (!this.container.setCgroupItem('cpu.cfs_period_us', period) ||
      !this.container.setCgroupItem('cpu.cfs_quota_us', quota)) {
    throw new Error('Failed to set CPU limit');
  }
};

Box.prototype.setMemoryLimit = function (size) {
  if (size == null) {
    size = -1;
  } else {
    size = sbutil.parseBytes(size);
  }

  if (!this.container.setCgroupItem('memory.limit_in_bytes', size) ||
      !this.container.setCgroupItem('memory.memsw.limit_in_bytes', size)) {
    throw new Error('Failed to set memory limit');
  }
};

Box.prototype.setProcessLimit = function (count) {
  if (count == null) {
    count = 'max';
  } else {
    if (!isFinite(count) || count < 0) {
      throw new RangeError('Only finite positive values are allowed');
    }

    count = Math.floor(count) + 1; // +1 for init (is init even in the cgroup??)
  }

  if (!this.container.setCgroupItem('pids.max', count)) {
    throw new Error('Failed to set process limit');
  }
};

Box.prototype.setDiskspaceLimit = function (size, callback) {
  if (size == null) {
    size = 'none';
  } else {
    size = sbutil.parseBytes(size, true);
  }

  var rootfs = this.container.getConfigItem('lxc.rootfs');
  return btrfs.setQuota(rootfs, size).nodeify(callback);
};

Box.prototype.attach = function (command, args, options) {
  if (!_.isArray(args)) {
    options = args;
    args = [];
  }

  options = _.defaultsDeep({}, options, this._attachOptions);

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
    .nodeify(callback);
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
    flag: 'r'
  });

  return sbfs.readFile(this, path, options).nodeify(callback);
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

  return sbfs.writeFile(this, path, data, options).nodeify(callback);
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
      .nodeify(callback);
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

// mv? touch is blödsin

// best effort destroy
Box.prototype.destroy = function (callback) {
  if (this.destroyed) {
    return Promise.reject(new Error('destroy has already been called'))
      .nodeify(callback);
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
  return Promise.settle([btrfs.destroyQuota(rootfs), stopRetry])
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
        throw(errors[0]);
      }
    });
};

module.exports = Box;
