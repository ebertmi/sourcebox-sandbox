'use strict';

var cp = require('child_process');
var os = require('os');
var pathModule = require('path');
var util = require('util');

var Promise = require('bluebird');
var _ = require('lodash');
var fs = require('fs-extra');
var shortid = require('shortid');

var sbutil = require('./util');

// exceptions and error helpers

function ProcessError(message) {
  this.message = message;
}

util.inherits(ProcessError, Error);

function error(msg, cause) {
  var err = new Error(msg);

  if (cause instanceof Error) {
    err.cause = cause;

    Object.defineProperty(err, 'stack',  { value: cause.stack });
  }

  return err;
}

function rethrow(msg) {
  var args = arguments;

  return function (err) {
    if (args.length > 1) {
      msg = util.format.apply(util, args);
    }

    throw error(msg, err);
  };
}

exports.ProcessError = ProcessError;
exports.error = error;
exports.rethrow = rethrow;

// promise wrappers

function execFilePromise(file, args, options) {
  return new Promise(function (resolve, reject) {
    cp.execFile(file, args, options, function (err, stdout, stderr) {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve([stdout, stderr]);
      }
    });
  });
}

// simple wrap, does not capture stdio or stderr
function processPromise(process) {
  return new Promise(function (resolve, reject) {
    process.on('error', function (err) {
      reject(err);
    });

    process.on('exit', function (code, signal) {
      if (code === 0) {
        resolve();
      } else {
        var error = new ProcessError('Command failed: ' + process.spawnfile);
        error.code = code;
        error.signal = signal;

        reject(error);
      }
    });
  });
}

function streamPromise(stream) {
  return new Promise(function (resolve, reject) {
    stream.on('end', resolve);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function using(box, fn) {
  var resource = Promise.resolve(box)
    .disposer(function (box) {
      return box.stop ? box.stop() : box.destroy();
    });

  return Promise.using(resource, fn);
}
exports.execFilePromise = execFilePromise;
exports.processPromise = processPromise;
exports.streamPromise = streamPromise;
exports.using = using;

// fs helpers

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

// the with* functions are bluebird disposers
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

exports.isDir = isDir;
exports.withOpen = withOpen;
exports.withTempFile = withTempFile;

// convert human size strings to bytes

var units = 'KMGTPE';
var byteRegex = /^\s*(\d+(?:\.\d*)?)\s*(?:([KMGTPE])(i)?)?B?\s*$/i;

function toBytes(str) {
  var matches = byteRegex.exec(str);

  if (!matches) {
    throw new Error('Invalid size string');
  }

  var factor = parseFloat(matches[1], 10);
  var exponent = matches[2] ? units.indexOf(matches[2].toUpperCase()) + 1 : 0;
  var base = matches[3] ? 1024 : 1000;

  return factor * Math.pow(base, exponent);
}

function parseBytes(bytes, allowZero) {
  if (_.isString(bytes)) {
    bytes = toBytes(bytes);
  }

  bytes = Math.round(bytes);


  if (!isFinite(bytes) || bytes < 0 || (!allowZero && bytes === 0)) {
    throw new Error('Only finite positive values are allowed');
  }

  return bytes;
}

exports.toBytes = toBytes;
exports.parseBytes = parseBytes;

function getArch(arch) {
  if (!arch || arch === 'host') {
    var mapping =  {
      'ia32': 'i386',
      'x64': 'amd64',
      'arm': 'armel'
    };

    return mapping[process.arch];
  }

  return arch;
}

exports.getArch = getArch;
