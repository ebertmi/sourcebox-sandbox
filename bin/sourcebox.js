#!/usr/bin/env node
'use strict';

var util = require('util');

var yargs = require('yargs');

var seeHelp =  'See \'--help\' for usage info.';

// Yargs CLI configuration
var argv = yargs
  .usage('Usage: sourcebox <command> [options] [<args>...]')

  .command('create', 'Create a new sourcebox', function (yargs) {
    argv = yargs
      .usage('Usage: sourcebox create [options] <path>')
      /*.demand(2, 2, 'Insufficient or trailing arguments.')*/

      .describe('interactive', 'Interactively create a new sourcebox ' +
                'instance. All other options are ignored')
      .describe('distro', 'The distribution to use')
      .describe('release', 'The release to use')
      .describe('arch', 'The architecture to use')
      .describe('variant', 'The variant to use')
      .describe('loop', 'If specified, create a loop mount of the given size ' +
                'in bytes. Accepts common suffixes like MB, GB etc.')

      .alias('i', 'interactive')
      .alias('d', 'distro')
      .alias('r', 'release')
      .alias('a', 'arch')
      .alias('v', 'variant')
      .alias('l', 'loop')

      .default('v', 'default')
      .default('a', 'host', util.format('Same as host (%s)', process.arch))

      .boolean('i')

      .requiresArg(['distro', 'release', 'arch', 'variant'])

      .help('help').alias('h', 'help')

      .example('sourcebox create --interactive ~/foo',
               'Interactively create a sourcebox instance in \'~/foo\'')
      .example('sourcebox create -d debian -r jessie -l 2GB /bar',
               'Create a Debian Jessie sourcebox in \'/bar\' using a 2 GB loop mount')

      .string('_')
      .strict()
      .showHelpOnFail(false, seeHelp)
      .argv;
  })

  .command('list', 'Print the list of available images', function (yargs) {
    argv = yargs
      .usage('Usage: sourcebox list [options]')
      /*.demand(1, 1, 'Trailing arguments.')*/

      .help('help').alias('h', 'help')

      .strict()
      .showHelpOnFail(false, seeHelp)
      .argv;
  })

  .command('manage', 'Manage a previously created sourcebox', function (yargs) {
    argv = yargs
    .usage(['Usage: sourcebox manage [options] <path> [--] [<cmd> [<args>...]]\n',
           'If no command is specified, a bash instance will be executed.'].join('\n'))
    /*.demand(2, 'Insufficient arguments.')*/

    .describe('directory', 'Directory to run the command in')

    .alias('d', 'directory')
    .default('d', '/root')
    .requiresArg('directory')

    .help('help').alias('h', 'help')

    .example('sourcebox manage ~/foo -- ls -la /etc',
             'List all files in the /etc directory of the container \'~/foo\'')
    .example('sourcebox manage /bar < script.sh',
             'Execute \'script.sh\' inside the container \'/bar\'')

    .epilogue('Note:\nFor each call to \'manage\', the sourcebox instance will have to be ' +
              'initialized, started, the command executed and the sourcebox instance shut ' +
              'down again. If you have several commands to run, its much better ' +
              'to pass them to a single instance of bash inside the container. See ' +
              'examples.')
    .string('_')
    .strict()
    .showHelpOnFail(false, seeHelp)
    .argv;
  })

  .completion('completion', 'Generate a bash completion script')

  .help('help').alias('h', 'help')

  .version(function () {
    return util.format('%s\nsourcebox %s\nlxc %s',
                       require('fs').readFileSync(__dirname + '/logo.txt', 'utf8'),
                       require('../package').version,
                       require('@sourcebox/lxc').version
                      );
  })

  .alias('V', 'version')

  .epilogue('To get help on a command, use \'sourcebox --help <command>\'.')
  .string('_')
  .strict()
  .showHelpOnFail(false, seeHelp)
  .argv;

// Get the command and the path from the args
var command = argv._.shift();
var path = argv._.shift();

// If no command has been specified show the help information and exit
if (!command) {
  yargs.showHelp();
  process.exit(1);
}

// Command to function mapping
var commands = {
  list: list,
  manage: manage,
  create: create,
};

// Get the function to the user specified command
var fn = commands[command];

// Check if the command is valid
if (!fn) {
  console.error(util.format('Unknown command: \'%s\'\n', command));
  console.error(seeHelp);
  process.exit(1);
}

// only require dependencies when a known command is specified to speed up the program
var readline = require('readline');
var constants = require('constants');
var pathModule = require('path');

var Promise = require('bluebird');
var _ = require('lodash');
var chalk = require('chalk');
var csvparse = Promise.promisify(require('csv-parse'));
var inquirer = require('inquirer');
var lxc = require('@sourcebox/lxc');
var request = Promise.promisify(require('request'), { multiArgs: true });
var semver = require('semver');
var table = require('text-table');

var Sourcebox = require('..');
var sbutil = require('../lib/util');
var sbconstants = require('../lib/constants');


/**
 * The Progess bar shows a spinner on the terminal output
 */
function Progress() {
  this.stream = process.stderr;
  chalk.enabled = this.stream.isTTY;

  this.spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  this.template = chalk.green('%s') + ' ' + chalk.bold('%s');
}

Progress.prototype.write = function (prefix, msg) {
  readline.clearLine(this.stream, 1);
  readline.cursorTo(this.stream, 0);
  this.stream.write(util.format(this.template, prefix, msg));
};

Progress.prototype.update = function (msg) {
  if (!this.stream.isTTY) {
    return this.stream.write(msg + '\n');
  }

  var self = this;
  var pos = 0;
  this.stop();

  this.msg = msg;

  function update() {
    var prefix = self.spinner[pos];
    pos = ++pos % self.spinner.length;
    self.write(prefix, msg);
  }

  update();

  this.interval = setInterval(update, 60);
};

Progress.prototype.stop = function () {
  if (!this.stream.isTTY) {
    return;
  }

  clearInterval(this.interval);

  if (this.msg) {
    this.write('!', this.msg + '\n');
    this.msg = null;
  }
};

var progress = new Progress();

// Launch the given command (e.g. create, manage, list)
fn();


/**
 * Retrieves a list of images for the various distros.
 */
function list() {
  progress.update('Retrieving list of images');
  getImageList()
    .finally(progress.stop.bind(progress))
    .then(function (list) {
      list.unshift(['DISTRO', 'RELEASE', 'ARCH', 'VARIANT']);
      console.log(table(list));
      process.exit(0);
    })
    .catch(function (err) {
      console.error(err.message);
    });
}

/**
 * Creates a new sourcebox container from the specified command line args or using the interactive mode.
 */
function create() {
  rootCheck();

  if (!(argv.interactive || (argv.distro && argv.release))) {
    console.error('Must specify either \'--interactive\' or ' +
                  'a \'--distro\' and \'--release\'.\n');
    console.error(seeHelp);
    process.exit(1);
  }

  var configP;

  if (argv.interactive) {
    configP = interactive(progress);
  } else {
    configP = Promise.resolve({
      distro: argv.distro,
      release: argv.release,
      arch: argv.arch,
      variant: argv.variant,
      loopsize: argv.loop,
    });
  }

  configP
    .then(function (config) {
      config.progress = progress.update.bind(progress);

      var sourcebox = new Sourcebox(path);
      return sourcebox.create(config);
    })
    .finally(progress.stop.bind(progress))
    .then(function () {
      console.log('Created new sourcebox in \'%s\'', pathModule.resolve(path));
      process.exit(0);
    })
    .catch(function (err) {
      console.error('Failed to create sourcebox:', err.message);
      process.exit(1);
    });
}

/**
 * Allows to manage a previously created sourcebox sandbox instance. You can either pass in a script or command to execute on the sourcebox container
 * or launch a terminal inside the container for installing/managing the base container.
 * The sourcebox server needs to be restarted after changes, so that they are applied to the users.
 */
function manage() {
  rootCheck();

  var command = argv._.shift() || 'bash';
  var term = process.stdin.isTTY && process.stdout.isTTY;

  var sourcebox = new Sourcebox(path);

  sourcebox.init().then(function () {
    progress.update('Starting sourcebox');

    return Sourcebox.using(sourcebox.manage(), function (box) {
      progress.update('Attaching to sourcebox');

      var child = box.attach(command, argv._, {
        term: term && {
          columns: process.stdout.columns,
          rows: process.stdout.rows
        },
        cwd: argv.directory,
        env: {
          TERM: process.env.TERM || null
        }
      });

      child.on('attach', progress.stop.bind(progress));

      function resize() {
        child.stdin.resize(process.stdout.columns,
                           process.stdout.rows);
      }

      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout);

      if (term) {
        process.stdin.setRawMode(true);
        process.stdout.on('resize', resize);
      } else {
        child.stderr.pipe(process.stderr);
      }

      return sbutil.processPromise(child)
        .catch(sbutil.ProcessError, function (err) {
          return err.code || constants[err.signal] + 128 || 1;
        })
        .catch(_.matches({code: 'ENOENT'}),
               sbutil.rethrow('Command not found: %s', command))
        .finally(function () {
          process.stdout.removeListener('resize', resize);
          progress.update('Stopping sourcebox');
        });
    });
  })
  .finally(progress.stop.bind(progress))
  .then(function (code) {
    process.exit(code || 0);
  })
  .catch(function (err) {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

/**
 * Check if the executing user has root rights.
 */
function rootCheck() {
  if (process.getuid() !== 0) {
    console.error('Sourcebox requires root permissions');
    process.exit(1);
  }
}

function getImageList() {
  // hardcoded for now. very ugly, but there is no easy way to get this from lxc
  var imageUrl = 'https://images.linuxcontainers.org/meta/1.0/index-user';
  var compatLevel = semver.gte(lxc.version, '1.1.0') ? 2 : 1;

  return request(imageUrl + '.' + compatLevel)
    .spread(function (header, body) {
      if (header.statusCode == 404) {
        // retry without compatLevel, that's what lxc does
        return request(imageUrl);
      }
      return [header, body];
    })
    .spread(function (header, body) {
      if (header.statusCode != 200) {
        throw new Error(header.statusCode + ' ' + header.statusMessage);
      }

      return csvparse(body, {
        delimiter: ';',
      });
    })
    .then(function (list) {
      return list.map(function (row) {
        return row.slice(0, 4);
      });
    })
    .catch (function (err) {
      throw new Error('Failed to get list of images: ' + err.message);
    });
}

function capitalize(values) {
  return values.map(function (value) {
    return {
      name: _.capitalize(value),
      value: value
    };
  });
}

/**
 * Start inquirer (command line questions) with the given set of questions
 * 
 * @param {Array} questions
 * @returns {Promise}
 */
function inquirerPromise(questions) {
  return inquirer.prompt(questions);
}

function imageListToDistros(list) {
  return list.reduce(function (distros, image) {
    var distro = image[0];
    var release = image[1];
    var arch = image[2];
    var variant = image [3];

    if (variant !== 'default') {
      return distros;
    }

    var releases = distros[distro] = distros[distro] || {};
    var archs = releases[release] = releases[release] || [];
    archs.push(arch);

    return distros;
  }, {});
}

/**
 * Creates the interactive creation mode by retrieving the distro images and then asking for all params.
 * 
 * @returns {Promise}
 */
function interactive() {
  if (!process.stdout.isTTY) {
    return Promise.reject(new Error('Interactive mode requires a terminal'));
  }

  progress.update('Retrieving list of images');

  return getImageList()
    .tap(progress.stop.bind(progress))
    .then(function (list) {
      var distros = imageListToDistros(list);

      return [
        {
          name: 'distro',
          message: 'Choose a distribution:',
          type: 'list',
          choices: capitalize(Object.keys(distros))
        }, {
          name: 'release',
          message: 'Choose a release:',
          type: 'list',
          choices: function (answers) {
            return capitalize(Object.keys(distros[answers.distro]));
          }
        }, {
          name: 'arch',
          message: 'Choose an architecture. It is recommended ' +
            'to pick the same architecture as the host system:',
          type: 'list',
          default: 'host',
          choices: function (answers) {
            return [
              { name: 'Same as host system', value: 'host' },
              new inquirer.Separator()
            ].concat(distros[answers.distro][answers.release]);
          }
        }, {
          name: 'createloop',
          message: 'Sourcebox requires Btrfs. If the target path ' +
            'does not reside on a Btrfs partition, you can create ' +
            'a loop mount. Create a loop mount?',
          type: 'confirm',
          default: false,
        }, {
          name: 'loopsize',
          message: util.format('Enter the size of the loop mount (at least %s):',
                               sbconstants.MIN_LOOP_SIZE),
          type: 'input',
          when: function (answers) {
            return answers.createloop;
          },
          default: '4GB',
          validate: function (input) {
            try {
              var min = sbutil.toBytes(sbconstants.MIN_LOOP_SIZE);
              if (sbutil.toBytes(input) < min) {
                return util.format('Loop file must be at least %s',
                                   sbconstants.MIN_LOOP_SIZE);
              } else {
                return true;
              }
            } catch (err) {
              return err.message;
            }
          }
        }
      ];
    })
    .then(inquirerPromise);
}
