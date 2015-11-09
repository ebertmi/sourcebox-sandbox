'use strict';

var fs = require('fs-extra');
var util = require('util');
var kMaxLength = require('buffer').kMaxLength;

var Promise = require('bluebird');

function ReadStream(box, path, options) {
  this.box = box;

  if (options) {
    this.uid = options.uid;
    this.gid = options.gid;
  }

  ReadStream.super_.call(this, path, options);
}

util.inherits(ReadStream, fs.ReadStream);

ReadStream.prototype.open = function () {
  var options = {
    mode: this.mode,
    uid: this.uid,
    gid: this.gid
  };

  this.box.openFile(this.path, this.flags, options)
    .bind(this)
    .then(function (fd) {
      this.fd = fd;
      this.emit('open', fd);
      this.read();
    })
    .catch(function (err) {
      if (this.autoClose) {
        this.destroy();
        this.emit('error', err);
      }
    });
};

function WriteStream(box, path, options) {
  this.box = box;

  if (options) {
    this.uid = options.uid;
    this.gid = options.gid;
  }

  WriteStream.super_.call(this, path, options);
}

util.inherits(WriteStream, fs.WriteStream);

WriteStream.prototype.open = function () {
  var options = {
    mode: this.mode,
    uid: this.uid,
    gid: this.gid
  };

  this.box.openFile(this.path, this.flags, options)
    .bind(this)
    .then(function (fd) {
      this.fd = fd;
      this.emit('open', fd);
    })
    .catch(function (err) {
      this.destroy();
      this.emit('error', err);
    });
};

exports.ReadStream = ReadStream;
exports.WriteStream = WriteStream;


// Due to frequent code changes, simply wrapping node's filesystem functions
// with fs.open() overridden by box.openFile proved not to be feasible.
// Therefor some of the basic read/write functions had to be reimplemented,
// while borrowing heavily from node's fs module.

function assertEncoding(encoding) {
  if (encoding && !Buffer.isEncoding(encoding)) {
    throw new Error('Unknown encoding: ' + encoding);
  }
}

function writeAll(fd, buffer, offset, length, position, callback) {
  fs.write(fd, buffer, offset, length, position, function (writeErr, written) {
    if (writeErr) {
      fs.close(fd, function () {
        if (callback) {
          callback(writeErr);
        }
      });
    } else {
      if (written === length) {
        fs.close(fd, callback);
      } else {
        offset += written;
        length -= written;
        position += written;
        writeAll(fd, buffer, offset, length, position, callback);
      }
    }
  });
}

function writeFile(box, path, data, options, callback) {
  assertEncoding(options.encoding);

  box.openFile(path, options.flag, options, function (openErr, fd) {
    if (openErr) {
      if (callback) {
        callback(openErr);
      }
    } else {
      var buffer = (data instanceof Buffer) ? data : new Buffer('' + data,
          options.encoding || 'utf8');
      var position = /a/.test(options.flag) ? null : 0;
      writeAll(fd, buffer, 0, buffer.length, position, callback);
    }
  });
}

function readFile(box, path, options, callback) {
  var encoding = options.encoding;
  var maxSize = options.maxSize;

  assertEncoding(encoding);

  // first, stat the file, so we know the size.
  var size;
  var buffer; // single buffer with file data
  var buffers; // list for when size is unknown
  var pos = 0;
  var fd;

  box.openFile(path, options.flag, options, function (er, fd_) {
    if (er) {
      return callback(er);
    }
    fd = fd_;

    fs.fstat(fd, function (er, st) {
      if (er) {
        return fs.close(fd, function () {
          callback(er);
        });
      }

      size = st.size;

      if (size === 0) {
        // the kernel lies about many files.
        // Go ahead and try to read some bytes.
        buffers = [];
        return read();
      }

      if (size > kMaxLength) {
        var err = new RangeError('File size is greater than possible Buffer');
        return fs.close(fd, function () {
          callback(err);
        });
      }
      buffer = new Buffer(size);
      read();
    });
  });

  function read() {
    if (size === 0) {
      buffer = new Buffer(8192);
      fs.read(fd, buffer, 0, 8192, -1, afterRead);
    } else {
      fs.read(fd, buffer, pos, size - pos, -1, afterRead);
    }
  }

  function afterRead(er, bytesRead) {
    if (er) {
      return fs.close(fd, function () {
        return callback(er);
      });
    }

    if (bytesRead === 0) {
      return close();
    }

    pos += bytesRead;

    if (pos > maxSize) {
      return fs.close(fd, function () {
        return callback(new RangeError('File size is greater than allowed'));
      });
    } else if (size !== 0) {
      if (pos === size) {
        close();
      } else {
        read();
      }
    } else {
      // unknown size, just read until we don't get bytes.
      buffers.push(buffer.slice(0, bytesRead));
      read();
    }
  }

  function close() {
    fs.close(fd, function (er) {
      if (size === 0) {
        // collected the data into the buffers list.
        buffer = Buffer.concat(buffers, pos);
      } else if (pos < size) {
        buffer = buffer.slice(0, pos);
      }

      if (encoding) {
        buffer = buffer.toString(encoding);
      }

      return callback(er, buffer);
    });
  }
}

exports.readFile = Promise.promisify(readFile);
exports.writeFile = Promise.promisify(writeFile);
