'use strict';

var pathModule = require('path');
var util = require('util');

var Promise = require('bluebird');
var fs = require('fs-extra');
var _ = require('lodash');
var lxc = require('@sourcebox/lxc');

var btrfs = require('./btrfs');
var constants = require('./constants');
var prepareSubids = require('./subids');
var sbutil = require('./util');

function CreationContext(sourcebox, templateArgs, loopsize, progress) {
  this.sourcebox = sourcebox;
  this.path = sourcebox.path;

  this.templateArgs = templateArgs;
  this.loopsize = loopsize;

  this.toClean = {};

  this.getOptions = {
    path: this.path,
    defined: false
  };

  this.progress = progress || _.noop;
}

CreationContext.prototype.create = function () {
  return Promise.all([
    prepareSubids(),
    this.preparePath()
  ])
    .bind(this)
    .spread(function (ids) {
      this.subids = ids;
    })
    .then(function () {
      return this.createContainer(true);
    })
    .tap(function () {
      this.toClean.container = true;
    })
    .then(this.copyInit)
    .then(function () {
      this.progress('Starting container');
      this.sourcebox._containerPromise = Promise.resolve(this.container);
      return sbutil.using(this.sourcebox.manage(), this.createUser.bind(this));
    })
    .catch(function (err) {
      return this.cleanup()
        .bind(this)
        .catch(function (err) {
          this.progress('Cleanup failed: ' + err.message);
        })
        .throw(err);
    });
};

CreationContext.prototype.cleanup = function () {
  this.progress('Cleaning up');

  this.sourcebox._containerPromise = null;

  var toClean = this.toClean;

  return Promise.resolve()
    .bind(this)
    .then(function () {
      if (toClean.container) {
        return this.container.destroyAsync();
      }
    }).then(function () {
      if (toClean.loop) {
        return btrfs.destroyLoopMount(this.path);
      }
    }).then(function () {
      if (toClean.dir) {
        return fs.removeAsync(this.path);
      }
    });
};

CreationContext.prototype.preparePath = function () {
  return fs.ensureDirAsync(this.path)
    .bind(this)
    .then(function () {
      return fs.readdirAsync(this.path);
    })
    .then (function (files) {
      if (files.length) {
        throw new Error('Target directory is not empty');
      }
    })
    .tap(function () {
      this.toClean.dir = true;
    })
    .then(function () {
      if (this.loopsize) {
        this.progress('Creating loop filesystem');
        var file = pathModule.join(this.path, constants.LOOPFILE);
        return btrfs.createLoopMount(file, this.path, this.loopsize)
          .bind(this)
          .tap(function () {
            this.toClean.loop = true;
          });
      } else {
        return btrfs.isBtrfs(this.path);
      }
    })
    .then(function () {
      this.progress('Enabling quota');
      return btrfs.enableQuota(this.path);
    });
};

CreationContext.prototype.createContainer = function (workaround) {
  return lxc.getContainerAsync(constants.SOURCE_CONTAINER, this.getOptions)
    .bind(this)
    .tap(function (container) {
      this.container = container;
    })
    .then(this.setCreateConfig)
    .then(function () {
      this.progress('Creating container');
      return this.container.createAsync('download', 'btrfs', this.templateArgs)
        .bind(this)
        .catch(function (err) {
          if (workaround) {
            return this.lxcWorkaround()
              .then(this.createContainer.bind(this, false));
          } else {
            throw err;
          }
        });
    });
};

CreationContext.prototype.setCreateConfig =  function () {
  // for some reason setConfigItem() does not work for 'id_map', so as a
  // workaround we have to create a temporary config file and load it

  // TODO maybe set some other config values here, e.g. network = empty

  var contents =  _.map(this.subids, function(ids, key) {
    return util.format('lxc.id_map = %s 0 %d %d', key, ids.first, ids.count);
  }).join('\n');

  // Disable app armor by setting a default profile unconfined
  var aa_profile = util.format('lxc.aa_profile = %s', constants.APP_ARMOR_PROFILE);
  contents += '\n';
  contents += aa_profile;

  var self = this;

  return Promise.using(sbutil.withTempFile(), function (file) {
    return fs.writeAsync(file.fd, contents).then(function () {
        return self.container.loadConfigAsync(file.path);
      });
  });
};

CreationContext.prototype.copyInit = function () {
  this.progress('Copying init system');

  var src = pathModule.join(__dirname, '../build/', constants.INIT_COMMAND);
  var dst = pathModule.join(this.container.getConfigItem('lxc.rootfs'),
                            pathModule.join(constants.INIT_PATH, constants.INIT_COMMAND));

  // we have to use the basic nodejs fs utilties here instead of
  // container.openFile() because the container can't be started without an
  // init system

  var subids = this.subids;

  return fs.copyAsync(src, dst)
    .then(function () {
      return fs.chownAsync(dst, subids.u.first, subids.g.first);
    });
};

CreationContext.prototype.createUser = function (box) {
  this.progress('Creating sandbox user');

  var args = [
    '--uid', constants.UID,
    '--create-home',
    '--user-group',
    constants.USER
  ];

  var useradd = box.attach('useradd', args);
  return sbutil.processPromise(useradd)
    .catch(sbutil.rethrow('Failed to create sandbox user'));
};

CreationContext.prototype.lxcWorkaround = function () {
  // lxc has a stupid bug that causes the creation of unpriviledged containers
  // as root to fail. however, if there is a cached image available it works
  // fine. so as a workaround we create a priviledged container and delete it
  // afterwards. the unprivledged container can then use the cache

  this.progress('Failed to create container, this might be due to a bug in ' +
                'the LXC cache system');

  return lxc.getContainerAsync('lxc-workaround', this.getOptions)
  // TODO: maybe load an empty cfg first?!
    .bind(this)
    .then(function (container) {
      this.progress('Trying to create a temporary priviledged container as a workaround');
      return container.createAsync('download', 'btrfs', this.templateArgs)
        .return(container);
    })
    .then(function (container) {
      return container.destroyAsync();
    });
};

module.exports = CreationContext;
