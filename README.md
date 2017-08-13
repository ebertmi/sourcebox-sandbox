sourcebox/sandbox
=================

Easy-to-use sandbox library that uses `lxc` and `btrfs` and `cgroups` for enforcing configurable limits. This lib depends on [sourcebox-lxc](https://github.com/ebertmi/sourcebox-lxc) that implements a `lxc` binding for node.

## install
See `INSTALL.md` for a *"detailed"* installation guide.

## linux kernel

To be able to use all sandboxing features, a very recent linux kernel (4.3.0+) is
required.

### kernel config

The following kernel config settings have to be changed from the debian
defaults. These enable cgroup limits for process IDs, CPU time and swap memory.

```bash
CONFIG_CGROUP_PIDS=y
CONFIG_MEMCG_SWAP_ENABLED=y
CONFIG_CFS_BANDWIDTH=y
```

## sourcebox command

This package provides the `sourcebox` CLI command. To add it to your path,
you can either install this package globally using `npm install -g` or run `npm
link` in the package directory.


```bash
Usage: sourcebox <command> [options] [<args>...]

Commands:
  create      Create a new sourcebox
  list        Print the list of available images
  manage      Manage a previously created sourcebox

  completion  Generate a bash completion script

Options:
  -h, --help     Show help  [boolean]
  -V, --version  Show version number  [boolean]

To get help on a command, use 'sourcebox --help <command>'.
```

### create

Creates a new sourcebox instance at the specified path, which has to be empty.

```bash
Usage: sourcebox create [options] <path>

Options:
  -i, --interactive  Interactively create a new sourcebox instance. All other
                     options are ignored                               [boolean]
  -d, --distro       The distribution to use
  -r, --release      The release to use
  -a, --arch         The architecture to use       [default: Same as host (x64)]
  -v, --variant      The variant to use                     [default: "default"]
  -l, --loop         If specified, create a loop mount of the given size in
                     bytes. Accepts common suffixes like MB, GB etc.
  -h, --help         Show help                                         [boolean]

Examples:
  sourcebox create --interactive ~/foo      Interactively create a sourcebox
                                            instance in '~/foo'
  sourcebox create -d debian -r jessie -l   Create a Debian Jessie sourcebox in
  2GB /bar
```

### list

Lists the available container images that can be used when creating a
sourcebox.

```
Usage: sourcebox list [options]

Options:
  -h, --help  Show help                                                [boolean]
```

### manage

Manages a previously created sourcebox instance by starting the template
container with networking enabled and running a command as root.

```bash
Usage: sourcebox manage [options] <path> [--] [<cmd> [<args>...]]

If no command is specified, a bash instance will be executed.

Options:
  -d, --directory  Directory to run the command in            [default: "/root"]
  -h, --help       Show help                                           [boolean]

Examples:
  sourcebox manage ~/foo -- ls -la /etc  List all files in the /etc directory of
                                         the container '~/foo'
  sourcebox manage /bar < script.sh      Execute 'script.sh' inside the
                                         container '/bar'

Note:
For each call to 'manage', the sourcebox instance will have to be initialized,
started, the command executed and the sourcebox instance shut down again. If you
have several commands to run, its much betterto pass them to a single instance
of bash inside the container. See examples.
```
