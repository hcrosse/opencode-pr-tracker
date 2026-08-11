// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = import.meta.require;

// node_modules/.bun/graceful-fs@4.2.11/node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS((exports, module) => {
  var constants = __require("constants");
  var origCwd = process.cwd;
  var cwd = null;
  var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
  process.cwd = function() {
    if (!cwd)
      cwd = origCwd.call(process);
    return cwd;
  };
  try {
    process.cwd();
  } catch (er) {}
  if (typeof process.chdir === "function") {
    chdir = process.chdir;
    process.chdir = function(d) {
      cwd = null;
      chdir.call(process, d);
    };
    if (Object.setPrototypeOf)
      Object.setPrototypeOf(process.chdir, chdir);
  }
  var chdir;
  module.exports = patch;
  function patch(fs) {
    if (constants.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
      patchLchmod(fs);
    }
    if (!fs.lutimes) {
      patchLutimes(fs);
    }
    fs.chown = chownFix(fs.chown);
    fs.fchown = chownFix(fs.fchown);
    fs.lchown = chownFix(fs.lchown);
    fs.chmod = chmodFix(fs.chmod);
    fs.fchmod = chmodFix(fs.fchmod);
    fs.lchmod = chmodFix(fs.lchmod);
    fs.chownSync = chownFixSync(fs.chownSync);
    fs.fchownSync = chownFixSync(fs.fchownSync);
    fs.lchownSync = chownFixSync(fs.lchownSync);
    fs.chmodSync = chmodFixSync(fs.chmodSync);
    fs.fchmodSync = chmodFixSync(fs.fchmodSync);
    fs.lchmodSync = chmodFixSync(fs.lchmodSync);
    fs.stat = statFix(fs.stat);
    fs.fstat = statFix(fs.fstat);
    fs.lstat = statFix(fs.lstat);
    fs.statSync = statFixSync(fs.statSync);
    fs.fstatSync = statFixSync(fs.fstatSync);
    fs.lstatSync = statFixSync(fs.lstatSync);
    if (fs.chmod && !fs.lchmod) {
      fs.lchmod = function(path, mode, cb) {
        if (cb)
          process.nextTick(cb);
      };
      fs.lchmodSync = function() {};
    }
    if (fs.chown && !fs.lchown) {
      fs.lchown = function(path, uid, gid, cb) {
        if (cb)
          process.nextTick(cb);
      };
      fs.lchownSync = function() {};
    }
    if (platform === "win32") {
      fs.rename = typeof fs.rename !== "function" ? fs.rename : function(fs$rename) {
        function rename(from, to, cb) {
          var start = Date.now();
          var backoff = 0;
          fs$rename(from, to, function CB(er) {
            if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 60000) {
              setTimeout(function() {
                fs.stat(to, function(stater, st) {
                  if (stater && stater.code === "ENOENT")
                    fs$rename(from, to, CB);
                  else
                    cb(er);
                });
              }, backoff);
              if (backoff < 100)
                backoff += 10;
              return;
            }
            if (cb)
              cb(er);
          });
        }
        if (Object.setPrototypeOf)
          Object.setPrototypeOf(rename, fs$rename);
        return rename;
      }(fs.rename);
    }
    fs.read = typeof fs.read !== "function" ? fs.read : function(fs$read) {
      function read(fd, buffer, offset, length, position, callback_) {
        var callback;
        if (callback_ && typeof callback_ === "function") {
          var eagCounter = 0;
          callback = function(er, _, __) {
            if (er && er.code === "EAGAIN" && eagCounter < 10) {
              eagCounter++;
              return fs$read.call(fs, fd, buffer, offset, length, position, callback);
            }
            callback_.apply(this, arguments);
          };
        }
        return fs$read.call(fs, fd, buffer, offset, length, position, callback);
      }
      if (Object.setPrototypeOf)
        Object.setPrototypeOf(read, fs$read);
      return read;
    }(fs.read);
    fs.readSync = typeof fs.readSync !== "function" ? fs.readSync : function(fs$readSync) {
      return function(fd, buffer, offset, length, position) {
        var eagCounter = 0;
        while (true) {
          try {
            return fs$readSync.call(fs, fd, buffer, offset, length, position);
          } catch (er) {
            if (er.code === "EAGAIN" && eagCounter < 10) {
              eagCounter++;
              continue;
            }
            throw er;
          }
        }
      };
    }(fs.readSync);
    function patchLchmod(fs2) {
      fs2.lchmod = function(path, mode, callback) {
        fs2.open(path, constants.O_WRONLY | constants.O_SYMLINK, mode, function(err, fd) {
          if (err) {
            if (callback)
              callback(err);
            return;
          }
          fs2.fchmod(fd, mode, function(err2) {
            fs2.close(fd, function(err22) {
              if (callback)
                callback(err2 || err22);
            });
          });
        });
      };
      fs2.lchmodSync = function(path, mode) {
        var fd = fs2.openSync(path, constants.O_WRONLY | constants.O_SYMLINK, mode);
        var threw = true;
        var ret;
        try {
          ret = fs2.fchmodSync(fd, mode);
          threw = false;
        } finally {
          if (threw) {
            try {
              fs2.closeSync(fd);
            } catch (er) {}
          } else {
            fs2.closeSync(fd);
          }
        }
        return ret;
      };
    }
    function patchLutimes(fs2) {
      if (constants.hasOwnProperty("O_SYMLINK") && fs2.futimes) {
        fs2.lutimes = function(path, at, mt, cb) {
          fs2.open(path, constants.O_SYMLINK, function(er, fd) {
            if (er) {
              if (cb)
                cb(er);
              return;
            }
            fs2.futimes(fd, at, mt, function(er2) {
              fs2.close(fd, function(er22) {
                if (cb)
                  cb(er2 || er22);
              });
            });
          });
        };
        fs2.lutimesSync = function(path, at, mt) {
          var fd = fs2.openSync(path, constants.O_SYMLINK);
          var ret;
          var threw = true;
          try {
            ret = fs2.futimesSync(fd, at, mt);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs2.closeSync(fd);
              } catch (er) {}
            } else {
              fs2.closeSync(fd);
            }
          }
          return ret;
        };
      } else if (fs2.futimes) {
        fs2.lutimes = function(_a, _b, _c, cb) {
          if (cb)
            process.nextTick(cb);
        };
        fs2.lutimesSync = function() {};
      }
    }
    function chmodFix(orig) {
      if (!orig)
        return orig;
      return function(target, mode, cb) {
        return orig.call(fs, target, mode, function(er) {
          if (chownErOk(er))
            er = null;
          if (cb)
            cb.apply(this, arguments);
        });
      };
    }
    function chmodFixSync(orig) {
      if (!orig)
        return orig;
      return function(target, mode) {
        try {
          return orig.call(fs, target, mode);
        } catch (er) {
          if (!chownErOk(er))
            throw er;
        }
      };
    }
    function chownFix(orig) {
      if (!orig)
        return orig;
      return function(target, uid, gid, cb) {
        return orig.call(fs, target, uid, gid, function(er) {
          if (chownErOk(er))
            er = null;
          if (cb)
            cb.apply(this, arguments);
        });
      };
    }
    function chownFixSync(orig) {
      if (!orig)
        return orig;
      return function(target, uid, gid) {
        try {
          return orig.call(fs, target, uid, gid);
        } catch (er) {
          if (!chownErOk(er))
            throw er;
        }
      };
    }
    function statFix(orig) {
      if (!orig)
        return orig;
      return function(target, options, cb) {
        if (typeof options === "function") {
          cb = options;
          options = null;
        }
        function callback(er, stats) {
          if (stats) {
            if (stats.uid < 0)
              stats.uid += 4294967296;
            if (stats.gid < 0)
              stats.gid += 4294967296;
          }
          if (cb)
            cb.apply(this, arguments);
        }
        return options ? orig.call(fs, target, options, callback) : orig.call(fs, target, callback);
      };
    }
    function statFixSync(orig) {
      if (!orig)
        return orig;
      return function(target, options) {
        var stats = options ? orig.call(fs, target, options) : orig.call(fs, target);
        if (stats) {
          if (stats.uid < 0)
            stats.uid += 4294967296;
          if (stats.gid < 0)
            stats.gid += 4294967296;
        }
        return stats;
      };
    }
    function chownErOk(er) {
      if (!er)
        return true;
      if (er.code === "ENOSYS")
        return true;
      var nonroot = !process.getuid || process.getuid() !== 0;
      if (nonroot) {
        if (er.code === "EINVAL" || er.code === "EPERM")
          return true;
      }
      return false;
    }
  }
});

// node_modules/.bun/graceful-fs@4.2.11/node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS((exports, module) => {
  var Stream = __require("stream").Stream;
  module.exports = legacy;
  function legacy(fs) {
    return {
      ReadStream,
      WriteStream
    };
    function ReadStream(path, options) {
      if (!(this instanceof ReadStream))
        return new ReadStream(path, options);
      Stream.call(this);
      var self = this;
      this.path = path;
      this.fd = null;
      this.readable = true;
      this.paused = false;
      this.flags = "r";
      this.mode = 438;
      this.bufferSize = 64 * 1024;
      options = options || {};
      var keys = Object.keys(options);
      for (var index = 0, length = keys.length;index < length; index++) {
        var key = keys[index];
        this[key] = options[key];
      }
      if (this.encoding)
        this.setEncoding(this.encoding);
      if (this.start !== undefined) {
        if (typeof this.start !== "number") {
          throw TypeError("start must be a Number");
        }
        if (this.end === undefined) {
          this.end = Infinity;
        } else if (typeof this.end !== "number") {
          throw TypeError("end must be a Number");
        }
        if (this.start > this.end) {
          throw new Error("start must be <= end");
        }
        this.pos = this.start;
      }
      if (this.fd !== null) {
        process.nextTick(function() {
          self._read();
        });
        return;
      }
      fs.open(this.path, this.flags, this.mode, function(err, fd) {
        if (err) {
          self.emit("error", err);
          self.readable = false;
          return;
        }
        self.fd = fd;
        self.emit("open", fd);
        self._read();
      });
    }
    function WriteStream(path, options) {
      if (!(this instanceof WriteStream))
        return new WriteStream(path, options);
      Stream.call(this);
      this.path = path;
      this.fd = null;
      this.writable = true;
      this.flags = "w";
      this.encoding = "binary";
      this.mode = 438;
      this.bytesWritten = 0;
      options = options || {};
      var keys = Object.keys(options);
      for (var index = 0, length = keys.length;index < length; index++) {
        var key = keys[index];
        this[key] = options[key];
      }
      if (this.start !== undefined) {
        if (typeof this.start !== "number") {
          throw TypeError("start must be a Number");
        }
        if (this.start < 0) {
          throw new Error("start must be >= zero");
        }
        this.pos = this.start;
      }
      this.busy = false;
      this._queue = [];
      if (this.fd === null) {
        this._open = fs.open;
        this._queue.push([this._open, this.path, this.flags, this.mode, undefined]);
        this.flush();
      }
    }
  }
});

// node_modules/.bun/graceful-fs@4.2.11/node_modules/graceful-fs/clone.js
var require_clone = __commonJS((exports, module) => {
  module.exports = clone;
  var getPrototypeOf = Object.getPrototypeOf || function(obj) {
    return obj.__proto__;
  };
  function clone(obj) {
    if (obj === null || typeof obj !== "object")
      return obj;
    if (obj instanceof Object)
      var copy = { __proto__: getPrototypeOf(obj) };
    else
      var copy = Object.create(null);
    Object.getOwnPropertyNames(obj).forEach(function(key) {
      Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
    });
    return copy;
  }
});

// node_modules/.bun/graceful-fs@4.2.11/node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS((exports, module) => {
  var fs = __require("fs");
  var polyfills = require_polyfills();
  var legacy = require_legacy_streams();
  var clone = require_clone();
  var util = __require("util");
  var gracefulQueue;
  var previousSymbol;
  if (typeof Symbol === "function" && typeof Symbol.for === "function") {
    gracefulQueue = Symbol.for("graceful-fs.queue");
    previousSymbol = Symbol.for("graceful-fs.previous");
  } else {
    gracefulQueue = "___graceful-fs.queue";
    previousSymbol = "___graceful-fs.previous";
  }
  function noop() {}
  function publishQueue(context, queue2) {
    Object.defineProperty(context, gracefulQueue, {
      get: function() {
        return queue2;
      }
    });
  }
  var debug = noop;
  if (util.debuglog)
    debug = util.debuglog("gfs4");
  else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
    debug = function() {
      var m = util.format.apply(util, arguments);
      m = "GFS4: " + m.split(/\n/).join(`
GFS4: `);
      console.error(m);
    };
  if (!fs[gracefulQueue]) {
    queue = global[gracefulQueue] || [];
    publishQueue(fs, queue);
    fs.close = function(fs$close) {
      function close(fd, cb) {
        return fs$close.call(fs, fd, function(err) {
          if (!err) {
            resetQueue();
          }
          if (typeof cb === "function")
            cb.apply(this, arguments);
        });
      }
      Object.defineProperty(close, previousSymbol, {
        value: fs$close
      });
      return close;
    }(fs.close);
    fs.closeSync = function(fs$closeSync) {
      function closeSync(fd) {
        fs$closeSync.apply(fs, arguments);
        resetQueue();
      }
      Object.defineProperty(closeSync, previousSymbol, {
        value: fs$closeSync
      });
      return closeSync;
    }(fs.closeSync);
    if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
      process.on("exit", function() {
        debug(fs[gracefulQueue]);
        __require("assert").equal(fs[gracefulQueue].length, 0);
      });
    }
  }
  var queue;
  if (!global[gracefulQueue]) {
    publishQueue(global, fs[gracefulQueue]);
  }
  module.exports = patch(clone(fs));
  if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
    module.exports = patch(fs);
    fs.__patched = true;
  }
  function patch(fs2) {
    polyfills(fs2);
    fs2.gracefulify = patch;
    fs2.createReadStream = createReadStream;
    fs2.createWriteStream = createWriteStream;
    var fs$readFile = fs2.readFile;
    fs2.readFile = readFile;
    function readFile(path, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      return go$readFile(path, options, cb);
      function go$readFile(path2, options2, cb2, startTime) {
        return fs$readFile(path2, options2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$readFile, [path2, options2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$writeFile = fs2.writeFile;
    fs2.writeFile = writeFile;
    function writeFile(path, data, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      return go$writeFile(path, data, options, cb);
      function go$writeFile(path2, data2, options2, cb2, startTime) {
        return fs$writeFile(path2, data2, options2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$writeFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$appendFile = fs2.appendFile;
    if (fs$appendFile)
      fs2.appendFile = appendFile;
    function appendFile(path, data, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      return go$appendFile(path, data, options, cb);
      function go$appendFile(path2, data2, options2, cb2, startTime) {
        return fs$appendFile(path2, data2, options2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$appendFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$copyFile = fs2.copyFile;
    if (fs$copyFile)
      fs2.copyFile = copyFile;
    function copyFile(src, dest, flags, cb) {
      if (typeof flags === "function") {
        cb = flags;
        flags = 0;
      }
      return go$copyFile(src, dest, flags, cb);
      function go$copyFile(src2, dest2, flags2, cb2, startTime) {
        return fs$copyFile(src2, dest2, flags2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$copyFile, [src2, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$readdir = fs2.readdir;
    fs2.readdir = readdir;
    var noReaddirOptionVersions = /^v[0-5]\./;
    function readdir(path, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path2, options2, cb2, startTime) {
        return fs$readdir(path2, fs$readdirCallback(path2, options2, cb2, startTime));
      } : function go$readdir2(path2, options2, cb2, startTime) {
        return fs$readdir(path2, options2, fs$readdirCallback(path2, options2, cb2, startTime));
      };
      return go$readdir(path, options, cb);
      function fs$readdirCallback(path2, options2, cb2, startTime) {
        return function(err, files) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([
              go$readdir,
              [path2, options2, cb2],
              err,
              startTime || Date.now(),
              Date.now()
            ]);
          else {
            if (files && files.sort)
              files.sort();
            if (typeof cb2 === "function")
              cb2.call(this, err, files);
          }
        };
      }
    }
    if (process.version.substr(0, 4) === "v0.8") {
      var legStreams = legacy(fs2);
      ReadStream = legStreams.ReadStream;
      WriteStream = legStreams.WriteStream;
    }
    var fs$ReadStream = fs2.ReadStream;
    if (fs$ReadStream) {
      ReadStream.prototype = Object.create(fs$ReadStream.prototype);
      ReadStream.prototype.open = ReadStream$open;
    }
    var fs$WriteStream = fs2.WriteStream;
    if (fs$WriteStream) {
      WriteStream.prototype = Object.create(fs$WriteStream.prototype);
      WriteStream.prototype.open = WriteStream$open;
    }
    Object.defineProperty(fs2, "ReadStream", {
      get: function() {
        return ReadStream;
      },
      set: function(val) {
        ReadStream = val;
      },
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(fs2, "WriteStream", {
      get: function() {
        return WriteStream;
      },
      set: function(val) {
        WriteStream = val;
      },
      enumerable: true,
      configurable: true
    });
    var FileReadStream = ReadStream;
    Object.defineProperty(fs2, "FileReadStream", {
      get: function() {
        return FileReadStream;
      },
      set: function(val) {
        FileReadStream = val;
      },
      enumerable: true,
      configurable: true
    });
    var FileWriteStream = WriteStream;
    Object.defineProperty(fs2, "FileWriteStream", {
      get: function() {
        return FileWriteStream;
      },
      set: function(val) {
        FileWriteStream = val;
      },
      enumerable: true,
      configurable: true
    });
    function ReadStream(path, options) {
      if (this instanceof ReadStream)
        return fs$ReadStream.apply(this, arguments), this;
      else
        return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
    }
    function ReadStream$open() {
      var that = this;
      open(that.path, that.flags, that.mode, function(err, fd) {
        if (err) {
          if (that.autoClose)
            that.destroy();
          that.emit("error", err);
        } else {
          that.fd = fd;
          that.emit("open", fd);
          that.read();
        }
      });
    }
    function WriteStream(path, options) {
      if (this instanceof WriteStream)
        return fs$WriteStream.apply(this, arguments), this;
      else
        return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
    }
    function WriteStream$open() {
      var that = this;
      open(that.path, that.flags, that.mode, function(err, fd) {
        if (err) {
          that.destroy();
          that.emit("error", err);
        } else {
          that.fd = fd;
          that.emit("open", fd);
        }
      });
    }
    function createReadStream(path, options) {
      return new fs2.ReadStream(path, options);
    }
    function createWriteStream(path, options) {
      return new fs2.WriteStream(path, options);
    }
    var fs$open = fs2.open;
    fs2.open = open;
    function open(path, flags, mode, cb) {
      if (typeof mode === "function")
        cb = mode, mode = null;
      return go$open(path, flags, mode, cb);
      function go$open(path2, flags2, mode2, cb2, startTime) {
        return fs$open(path2, flags2, mode2, function(err, fd) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$open, [path2, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    return fs2;
  }
  function enqueue(elem) {
    debug("ENQUEUE", elem[0].name, elem[1]);
    fs[gracefulQueue].push(elem);
    retry();
  }
  var retryTimer;
  function resetQueue() {
    var now = Date.now();
    for (var i = 0;i < fs[gracefulQueue].length; ++i) {
      if (fs[gracefulQueue][i].length > 2) {
        fs[gracefulQueue][i][3] = now;
        fs[gracefulQueue][i][4] = now;
      }
    }
    retry();
  }
  function retry() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (fs[gracefulQueue].length === 0)
      return;
    var elem = fs[gracefulQueue].shift();
    var fn = elem[0];
    var args = elem[1];
    var err = elem[2];
    var startTime = elem[3];
    var lastTime = elem[4];
    if (startTime === undefined) {
      debug("RETRY", fn.name, args);
      fn.apply(null, args);
    } else if (Date.now() - startTime >= 60000) {
      debug("TIMEOUT", fn.name, args);
      var cb = args.pop();
      if (typeof cb === "function")
        cb.call(null, err);
    } else {
      var sinceAttempt = Date.now() - lastTime;
      var sinceStart = Math.max(lastTime - startTime, 1);
      var desiredDelay = Math.min(sinceStart * 1.2, 100);
      if (sinceAttempt >= desiredDelay) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args.concat([startTime]));
      } else {
        fs[gracefulQueue].push(elem);
      }
    }
    if (retryTimer === undefined) {
      retryTimer = setTimeout(retry, 0);
    }
  }
});

// node_modules/.bun/retry@0.12.0/node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS((exports, module) => {
  function RetryOperation(timeouts, options) {
    if (typeof options === "boolean") {
      options = { forever: options };
    }
    this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
    this._timeouts = timeouts;
    this._options = options || {};
    this._maxRetryTime = options && options.maxRetryTime || Infinity;
    this._fn = null;
    this._errors = [];
    this._attempts = 1;
    this._operationTimeout = null;
    this._operationTimeoutCb = null;
    this._timeout = null;
    this._operationStart = null;
    if (this._options.forever) {
      this._cachedTimeouts = this._timeouts.slice(0);
    }
  }
  module.exports = RetryOperation;
  RetryOperation.prototype.reset = function() {
    this._attempts = 1;
    this._timeouts = this._originalTimeouts;
  };
  RetryOperation.prototype.stop = function() {
    if (this._timeout) {
      clearTimeout(this._timeout);
    }
    this._timeouts = [];
    this._cachedTimeouts = null;
  };
  RetryOperation.prototype.retry = function(err) {
    if (this._timeout) {
      clearTimeout(this._timeout);
    }
    if (!err) {
      return false;
    }
    var currentTime = new Date().getTime();
    if (err && currentTime - this._operationStart >= this._maxRetryTime) {
      this._errors.unshift(new Error("RetryOperation timeout occurred"));
      return false;
    }
    this._errors.push(err);
    var timeout = this._timeouts.shift();
    if (timeout === undefined) {
      if (this._cachedTimeouts) {
        this._errors.splice(this._errors.length - 1, this._errors.length);
        this._timeouts = this._cachedTimeouts.slice(0);
        timeout = this._timeouts.shift();
      } else {
        return false;
      }
    }
    var self = this;
    var timer = setTimeout(function() {
      self._attempts++;
      if (self._operationTimeoutCb) {
        self._timeout = setTimeout(function() {
          self._operationTimeoutCb(self._attempts);
        }, self._operationTimeout);
        if (self._options.unref) {
          self._timeout.unref();
        }
      }
      self._fn(self._attempts);
    }, timeout);
    if (this._options.unref) {
      timer.unref();
    }
    return true;
  };
  RetryOperation.prototype.attempt = function(fn, timeoutOps) {
    this._fn = fn;
    if (timeoutOps) {
      if (timeoutOps.timeout) {
        this._operationTimeout = timeoutOps.timeout;
      }
      if (timeoutOps.cb) {
        this._operationTimeoutCb = timeoutOps.cb;
      }
    }
    var self = this;
    if (this._operationTimeoutCb) {
      this._timeout = setTimeout(function() {
        self._operationTimeoutCb();
      }, self._operationTimeout);
    }
    this._operationStart = new Date().getTime();
    this._fn(this._attempts);
  };
  RetryOperation.prototype.try = function(fn) {
    console.log("Using RetryOperation.try() is deprecated");
    this.attempt(fn);
  };
  RetryOperation.prototype.start = function(fn) {
    console.log("Using RetryOperation.start() is deprecated");
    this.attempt(fn);
  };
  RetryOperation.prototype.start = RetryOperation.prototype.try;
  RetryOperation.prototype.errors = function() {
    return this._errors;
  };
  RetryOperation.prototype.attempts = function() {
    return this._attempts;
  };
  RetryOperation.prototype.mainError = function() {
    if (this._errors.length === 0) {
      return null;
    }
    var counts = {};
    var mainError = null;
    var mainErrorCount = 0;
    for (var i = 0;i < this._errors.length; i++) {
      var error = this._errors[i];
      var message = error.message;
      var count = (counts[message] || 0) + 1;
      counts[message] = count;
      if (count >= mainErrorCount) {
        mainError = error;
        mainErrorCount = count;
      }
    }
    return mainError;
  };
});

// node_modules/.bun/retry@0.12.0/node_modules/retry/lib/retry.js
var require_retry = __commonJS((exports) => {
  var RetryOperation = require_retry_operation();
  exports.operation = function(options) {
    var timeouts = exports.timeouts(options);
    return new RetryOperation(timeouts, {
      forever: options && options.forever,
      unref: options && options.unref,
      maxRetryTime: options && options.maxRetryTime
    });
  };
  exports.timeouts = function(options) {
    if (options instanceof Array) {
      return [].concat(options);
    }
    var opts = {
      retries: 10,
      factor: 2,
      minTimeout: 1 * 1000,
      maxTimeout: Infinity,
      randomize: false
    };
    for (var key in options) {
      opts[key] = options[key];
    }
    if (opts.minTimeout > opts.maxTimeout) {
      throw new Error("minTimeout is greater than maxTimeout");
    }
    var timeouts = [];
    for (var i = 0;i < opts.retries; i++) {
      timeouts.push(this.createTimeout(i, opts));
    }
    if (options && options.forever && !timeouts.length) {
      timeouts.push(this.createTimeout(i, opts));
    }
    timeouts.sort(function(a, b) {
      return a - b;
    });
    return timeouts;
  };
  exports.createTimeout = function(attempt, opts) {
    var random = opts.randomize ? Math.random() + 1 : 1;
    var timeout = Math.round(random * opts.minTimeout * Math.pow(opts.factor, attempt));
    timeout = Math.min(timeout, opts.maxTimeout);
    return timeout;
  };
  exports.wrap = function(obj, options, methods) {
    if (options instanceof Array) {
      methods = options;
      options = null;
    }
    if (!methods) {
      methods = [];
      for (var key in obj) {
        if (typeof obj[key] === "function") {
          methods.push(key);
        }
      }
    }
    for (var i = 0;i < methods.length; i++) {
      var method = methods[i];
      var original = obj[method];
      obj[method] = function retryWrapper(original2) {
        var op = exports.operation(options);
        var args = Array.prototype.slice.call(arguments, 1);
        var callback = args.pop();
        args.push(function(err) {
          if (op.retry(err)) {
            return;
          }
          if (err) {
            arguments[0] = op.mainError();
          }
          callback.apply(this, arguments);
        });
        op.attempt(function() {
          original2.apply(obj, args);
        });
      }.bind(obj, original);
      obj[method].options = options;
    }
  };
});

// node_modules/.bun/signal-exit@3.0.7/node_modules/signal-exit/signals.js
var require_signals = __commonJS((exports, module) => {
  module.exports = [
    "SIGABRT",
    "SIGALRM",
    "SIGHUP",
    "SIGINT",
    "SIGTERM"
  ];
  if (process.platform !== "win32") {
    module.exports.push("SIGVTALRM", "SIGXCPU", "SIGXFSZ", "SIGUSR2", "SIGTRAP", "SIGSYS", "SIGQUIT", "SIGIOT");
  }
  if (process.platform === "linux") {
    module.exports.push("SIGIO", "SIGPOLL", "SIGPWR", "SIGSTKFLT", "SIGUNUSED");
  }
});

// node_modules/.bun/signal-exit@3.0.7/node_modules/signal-exit/index.js
var require_signal_exit = __commonJS((exports, module) => {
  var process2 = global.process;
  var processOk = function(process3) {
    return process3 && typeof process3 === "object" && typeof process3.removeListener === "function" && typeof process3.emit === "function" && typeof process3.reallyExit === "function" && typeof process3.listeners === "function" && typeof process3.kill === "function" && typeof process3.pid === "number" && typeof process3.on === "function";
  };
  if (!processOk(process2)) {
    module.exports = function() {
      return function() {};
    };
  } else {
    assert = __require("assert");
    signals = require_signals();
    isWin = /^win/i.test(process2.platform);
    EE = __require("events");
    if (typeof EE !== "function") {
      EE = EE.EventEmitter;
    }
    if (process2.__signal_exit_emitter__) {
      emitter = process2.__signal_exit_emitter__;
    } else {
      emitter = process2.__signal_exit_emitter__ = new EE;
      emitter.count = 0;
      emitter.emitted = {};
    }
    if (!emitter.infinite) {
      emitter.setMaxListeners(Infinity);
      emitter.infinite = true;
    }
    module.exports = function(cb, opts) {
      if (!processOk(global.process)) {
        return function() {};
      }
      assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
      if (loaded === false) {
        load();
      }
      var ev = "exit";
      if (opts && opts.alwaysLast) {
        ev = "afterexit";
      }
      var remove = function() {
        emitter.removeListener(ev, cb);
        if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) {
          unload();
        }
      };
      emitter.on(ev, cb);
      return remove;
    };
    unload = function unload2() {
      if (!loaded || !processOk(global.process)) {
        return;
      }
      loaded = false;
      signals.forEach(function(sig) {
        try {
          process2.removeListener(sig, sigListeners[sig]);
        } catch (er) {}
      });
      process2.emit = originalProcessEmit;
      process2.reallyExit = originalProcessReallyExit;
      emitter.count -= 1;
    };
    module.exports.unload = unload;
    emit = function emit2(event, code, signal) {
      if (emitter.emitted[event]) {
        return;
      }
      emitter.emitted[event] = true;
      emitter.emit(event, code, signal);
    };
    sigListeners = {};
    signals.forEach(function(sig) {
      sigListeners[sig] = function listener() {
        if (!processOk(global.process)) {
          return;
        }
        var listeners = process2.listeners(sig);
        if (listeners.length === emitter.count) {
          unload();
          emit("exit", null, sig);
          emit("afterexit", null, sig);
          if (isWin && sig === "SIGHUP") {
            sig = "SIGINT";
          }
          process2.kill(process2.pid, sig);
        }
      };
    });
    module.exports.signals = function() {
      return signals;
    };
    loaded = false;
    load = function load2() {
      if (loaded || !processOk(global.process)) {
        return;
      }
      loaded = true;
      emitter.count += 1;
      signals = signals.filter(function(sig) {
        try {
          process2.on(sig, sigListeners[sig]);
          return true;
        } catch (er) {
          return false;
        }
      });
      process2.emit = processEmit;
      process2.reallyExit = processReallyExit;
    };
    module.exports.load = load;
    originalProcessReallyExit = process2.reallyExit;
    processReallyExit = function processReallyExit2(code) {
      if (!processOk(global.process)) {
        return;
      }
      process2.exitCode = code || 0;
      emit("exit", process2.exitCode, null);
      emit("afterexit", process2.exitCode, null);
      originalProcessReallyExit.call(process2, process2.exitCode);
    };
    originalProcessEmit = process2.emit;
    processEmit = function processEmit2(ev, arg) {
      if (ev === "exit" && processOk(global.process)) {
        if (arg !== undefined) {
          process2.exitCode = arg;
        }
        var ret = originalProcessEmit.apply(this, arguments);
        emit("exit", process2.exitCode, null);
        emit("afterexit", process2.exitCode, null);
        return ret;
      } else {
        return originalProcessEmit.apply(this, arguments);
      }
    };
  }
  var assert;
  var signals;
  var isWin;
  var EE;
  var emitter;
  var unload;
  var emit;
  var sigListeners;
  var loaded;
  var load;
  var originalProcessReallyExit;
  var processReallyExit;
  var originalProcessEmit;
  var processEmit;
});

// node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/mtime-precision.js
var require_mtime_precision = __commonJS((exports, module) => {
  var cacheSymbol = Symbol();
  function probe(file, fs, callback) {
    const cachedPrecision = fs[cacheSymbol];
    if (cachedPrecision) {
      return fs.stat(file, (err, stat) => {
        if (err) {
          return callback(err);
        }
        callback(null, stat.mtime, cachedPrecision);
      });
    }
    const mtime = new Date(Math.ceil(Date.now() / 1000) * 1000 + 5);
    fs.utimes(file, mtime, mtime, (err) => {
      if (err) {
        return callback(err);
      }
      fs.stat(file, (err2, stat) => {
        if (err2) {
          return callback(err2);
        }
        const precision = stat.mtime.getTime() % 1000 === 0 ? "s" : "ms";
        Object.defineProperty(fs, cacheSymbol, { value: precision });
        callback(null, stat.mtime, precision);
      });
    });
  }
  function getMtime(precision) {
    let now = Date.now();
    if (precision === "s") {
      now = Math.ceil(now / 1000) * 1000;
    }
    return new Date(now);
  }
  exports.probe = probe;
  exports.getMtime = getMtime;
});

// node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/lockfile.js
var require_lockfile = __commonJS((exports, module) => {
  var path = __require("path");
  var fs = require_graceful_fs();
  var retry = require_retry();
  var onExit = require_signal_exit();
  var mtimePrecision = require_mtime_precision();
  var locks = {};
  function getLockFile(file, options) {
    return options.lockfilePath || `${file}.lock`;
  }
  function resolveCanonicalPath(file, options, callback) {
    if (!options.realpath) {
      return callback(null, path.resolve(file));
    }
    options.fs.realpath(file, callback);
  }
  function acquireLock(file, options, callback) {
    const lockfilePath = getLockFile(file, options);
    options.fs.mkdir(lockfilePath, (err) => {
      if (!err) {
        return mtimePrecision.probe(lockfilePath, options.fs, (err2, mtime, mtimePrecision2) => {
          if (err2) {
            options.fs.rmdir(lockfilePath, () => {});
            return callback(err2);
          }
          callback(null, mtime, mtimePrecision2);
        });
      }
      if (err.code !== "EEXIST") {
        return callback(err);
      }
      if (options.stale <= 0) {
        return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
      }
      options.fs.stat(lockfilePath, (err2, stat) => {
        if (err2) {
          if (err2.code === "ENOENT") {
            return acquireLock(file, { ...options, stale: 0 }, callback);
          }
          return callback(err2);
        }
        if (!isLockStale(stat, options)) {
          return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
        }
        removeLock(file, options, (err3) => {
          if (err3) {
            return callback(err3);
          }
          acquireLock(file, { ...options, stale: 0 }, callback);
        });
      });
    });
  }
  function isLockStale(stat, options) {
    return stat.mtime.getTime() < Date.now() - options.stale;
  }
  function removeLock(file, options, callback) {
    options.fs.rmdir(getLockFile(file, options), (err) => {
      if (err && err.code !== "ENOENT") {
        return callback(err);
      }
      callback();
    });
  }
  function updateLock(file, options) {
    const lock2 = locks[file];
    if (lock2.updateTimeout) {
      return;
    }
    lock2.updateDelay = lock2.updateDelay || options.update;
    lock2.updateTimeout = setTimeout(() => {
      lock2.updateTimeout = null;
      options.fs.stat(lock2.lockfilePath, (err, stat) => {
        const isOverThreshold = lock2.lastUpdate + options.stale < Date.now();
        if (err) {
          if (err.code === "ENOENT" || isOverThreshold) {
            return setLockAsCompromised(file, lock2, Object.assign(err, { code: "ECOMPROMISED" }));
          }
          lock2.updateDelay = 1000;
          return updateLock(file, options);
        }
        const isMtimeOurs = lock2.mtime.getTime() === stat.mtime.getTime();
        if (!isMtimeOurs) {
          return setLockAsCompromised(file, lock2, Object.assign(new Error("Unable to update lock within the stale threshold"), { code: "ECOMPROMISED" }));
        }
        const mtime = mtimePrecision.getMtime(lock2.mtimePrecision);
        options.fs.utimes(lock2.lockfilePath, mtime, mtime, (err2) => {
          const isOverThreshold2 = lock2.lastUpdate + options.stale < Date.now();
          if (lock2.released) {
            return;
          }
          if (err2) {
            if (err2.code === "ENOENT" || isOverThreshold2) {
              return setLockAsCompromised(file, lock2, Object.assign(err2, { code: "ECOMPROMISED" }));
            }
            lock2.updateDelay = 1000;
            return updateLock(file, options);
          }
          lock2.mtime = mtime;
          lock2.lastUpdate = Date.now();
          lock2.updateDelay = null;
          updateLock(file, options);
        });
      });
    }, lock2.updateDelay);
    if (lock2.updateTimeout.unref) {
      lock2.updateTimeout.unref();
    }
  }
  function setLockAsCompromised(file, lock2, err) {
    lock2.released = true;
    if (lock2.updateTimeout) {
      clearTimeout(lock2.updateTimeout);
    }
    if (locks[file] === lock2) {
      delete locks[file];
    }
    lock2.options.onCompromised(err);
  }
  function lock(file, options, callback) {
    options = {
      stale: 1e4,
      update: null,
      realpath: true,
      retries: 0,
      fs,
      onCompromised: (err) => {
        throw err;
      },
      ...options
    };
    options.retries = options.retries || 0;
    options.retries = typeof options.retries === "number" ? { retries: options.retries } : options.retries;
    options.stale = Math.max(options.stale || 0, 2000);
    options.update = options.update == null ? options.stale / 2 : options.update || 0;
    options.update = Math.max(Math.min(options.update, options.stale / 2), 1000);
    resolveCanonicalPath(file, options, (err, file2) => {
      if (err) {
        return callback(err);
      }
      const operation = retry.operation(options.retries);
      operation.attempt(() => {
        acquireLock(file2, options, (err2, mtime, mtimePrecision2) => {
          if (operation.retry(err2)) {
            return;
          }
          if (err2) {
            return callback(operation.mainError());
          }
          const lock2 = locks[file2] = {
            lockfilePath: getLockFile(file2, options),
            mtime,
            mtimePrecision: mtimePrecision2,
            options,
            lastUpdate: Date.now()
          };
          updateLock(file2, options);
          callback(null, (releasedCallback) => {
            if (lock2.released) {
              return releasedCallback && releasedCallback(Object.assign(new Error("Lock is already released"), { code: "ERELEASED" }));
            }
            unlock(file2, { ...options, realpath: false }, releasedCallback);
          });
        });
      });
    });
  }
  function unlock(file, options, callback) {
    options = {
      fs,
      realpath: true,
      ...options
    };
    resolveCanonicalPath(file, options, (err, file2) => {
      if (err) {
        return callback(err);
      }
      const lock2 = locks[file2];
      if (!lock2) {
        return callback(Object.assign(new Error("Lock is not acquired/owned by you"), { code: "ENOTACQUIRED" }));
      }
      lock2.updateTimeout && clearTimeout(lock2.updateTimeout);
      lock2.released = true;
      delete locks[file2];
      removeLock(file2, options, callback);
    });
  }
  function check(file, options, callback) {
    options = {
      stale: 1e4,
      realpath: true,
      fs,
      ...options
    };
    options.stale = Math.max(options.stale || 0, 2000);
    resolveCanonicalPath(file, options, (err, file2) => {
      if (err) {
        return callback(err);
      }
      options.fs.stat(getLockFile(file2, options), (err2, stat) => {
        if (err2) {
          return err2.code === "ENOENT" ? callback(null, false) : callback(err2);
        }
        return callback(null, !isLockStale(stat, options));
      });
    });
  }
  function getLocks() {
    return locks;
  }
  onExit(() => {
    for (const file in locks) {
      const options = locks[file].options;
      try {
        options.fs.rmdirSync(getLockFile(file, options));
      } catch (e) {}
    }
  });
  exports.lock = lock;
  exports.unlock = unlock;
  exports.check = check;
  exports.getLocks = getLocks;
});

// node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js
var require_adapter = __commonJS((exports, module) => {
  var fs = require_graceful_fs();
  function createSyncFs(fs2) {
    const methods = ["mkdir", "realpath", "stat", "rmdir", "utimes"];
    const newFs = { ...fs2 };
    methods.forEach((method) => {
      newFs[method] = (...args) => {
        const callback = args.pop();
        let ret;
        try {
          ret = fs2[`${method}Sync`](...args);
        } catch (err) {
          return callback(err);
        }
        callback(null, ret);
      };
    });
    return newFs;
  }
  function toPromise(method) {
    return (...args) => new Promise((resolve, reject) => {
      args.push((err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
      method(...args);
    });
  }
  function toSync(method) {
    return (...args) => {
      let err;
      let result;
      args.push((_err, _result) => {
        err = _err;
        result = _result;
      });
      method(...args);
      if (err) {
        throw err;
      }
      return result;
    };
  }
  function toSyncOptions(options) {
    options = { ...options };
    options.fs = createSyncFs(options.fs || fs);
    if (typeof options.retries === "number" && options.retries > 0 || options.retries && typeof options.retries.retries === "number" && options.retries.retries > 0) {
      throw Object.assign(new Error("Cannot use retries with the sync api"), { code: "ESYNC" });
    }
    return options;
  }
  module.exports = {
    toPromise,
    toSync,
    toSyncOptions
  };
});

// node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/index.js
var require_proper_lockfile = __commonJS((exports, module) => {
  var lockfile = require_lockfile();
  var { toPromise, toSync, toSyncOptions } = require_adapter();
  async function lock(file, options) {
    const release = await toPromise(lockfile.lock)(file, options);
    return toPromise(release);
  }
  function lockSync(file, options) {
    const release = toSync(lockfile.lock)(file, toSyncOptions(options));
    return toSync(release);
  }
  function unlock(file, options) {
    return toPromise(lockfile.unlock)(file, options);
  }
  function unlockSync(file, options) {
    return toSync(lockfile.unlock)(file, toSyncOptions(options));
  }
  function check(file, options) {
    return toPromise(lockfile.check)(file, options);
  }
  function checkSync(file, options) {
    return toSync(lockfile.check)(file, toSyncOptions(options));
  }
  module.exports = lock;
  module.exports.lock = lock;
  module.exports.unlock = unlock;
  module.exports.lockSync = lockSync;
  module.exports.unlockSync = unlockSync;
  module.exports.check = check;
  module.exports.checkSync = checkSync;
});

// src/tui.tsx
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { createSignal, onCleanup } from "solid-js";

// src/github.ts
import { execFile } from "child_process";

// src/exhaustive.ts
function casesHandled(value) {
  throw new Error(`Unhandled case: ${String(value)}`);
}

// src/url.ts
var invalidPullRequestUrl = {
  ok: false,
  error: {
    tag: "InvalidPullRequestUrl",
    message: "Expected https://github.com/<owner>/<repository>/pull/<positive-integer>"
  }
};
var segmentPattern = /^[A-Za-z0-9._-]+$/;
function parsePullRequestUrl(input) {
  if (input.trim() !== input)
    return invalidPullRequestUrl;
  if (!input.startsWith("https://"))
    return invalidPullRequestUrl;
  const authorityEnd = input.indexOf("/", "https://".length);
  if (authorityEnd === -1)
    return invalidPullRequestUrl;
  if (input.slice("https://".length, authorityEnd).toLowerCase() !== "github.com") {
    return invalidPullRequestUrl;
  }
  const rawPath = input.slice(authorityEnd).split(/[?#]/, 1).join("");
  for (const segment of rawPath.split("/")) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return invalidPullRequestUrl;
    }
    if (decoded === "." || decoded === "..")
      return invalidPullRequestUrl;
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return invalidPullRequestUrl;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.search !== "" || parsed.hash !== "") {
    return invalidPullRequestUrl;
  }
  const segments = parsed.pathname.split("/");
  if (segments.length !== 5 || segments[0] !== "" || segments[3] !== "pull") {
    return invalidPullRequestUrl;
  }
  const owner = segments[1];
  const repository = segments[2];
  const numberText = segments[4];
  if (owner === undefined || repository === undefined || numberText === undefined || !segmentPattern.test(owner) || !segmentPattern.test(repository) || !/^\d+$/.test(numberText)) {
    return invalidPullRequestUrl;
  }
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0)
    return invalidPullRequestUrl;
  const url = `https://github.com/${owner}/${repository}/pull/${number}`;
  const value = { url, owner, repository, number };
  return { ok: true, value };
}
function formatPullRequestRef(pullRequest) {
  return `${pullRequest.owner}/${pullRequest.repository}#${pullRequest.number}`;
}

// src/github.ts
var invalidGitHubResponse = {
  ok: false,
  error: {
    tag: "InvalidGitHubResponse",
    message: "GitHub returned an invalid pull request response"
  }
};
var githubBatchLimitExceeded = {
  ok: false,
  error: {
    tag: "GitHubBatchLimitExceeded",
    limit: 20,
    message: "GitHub batch cannot contain more than 20 pull requests"
  }
};
var checkRunPending = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING"]);
var checkRunPassed = new Set(["SUCCESS"]);
var checkRunFailed = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
var checkRunIgnored = new Set(["NEUTRAL", "SKIPPED"]);
var statusContextPending = new Set(["EXPECTED", "PENDING"]);
var statusContextPassed = new Set(["SUCCESS"]);
var statusContextFailed = new Set(["ERROR", "FAILURE"]);
var maximumPullRequestsPerBatch = 20;
var pullRequestSelection = `__typename ... on PullRequest { title state url mergedAt mergeable statusCheckRollup { contexts(first: 1) { checkRunCount statusContextCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } }`;
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function classifyCountState(state, states) {
  if (states.failed.has(state))
    return "failed";
  if (states.pending.has(state))
    return "pending";
  if (states.passed.has(state))
    return "passed";
  if (states.ignored?.has(state))
    return "ignored";
  return;
}
function aggregateCounts(input, expectedTotal, states) {
  if (!Array.isArray(input) || !Number.isInteger(expectedTotal) || Number(expectedTotal) < 0) {
    return invalidGitHubResponse;
  }
  const buckets = new Set;
  const seenStates = new Set;
  let total = 0;
  for (const item of input) {
    if (!isRecord(item) || typeof item.state !== "string" || !Number.isInteger(item.count) || Number(item.count) < 0 || seenStates.has(item.state)) {
      return invalidGitHubResponse;
    }
    const bucket = classifyCountState(item.state, states);
    if (bucket === undefined && Number(item.count) > 0)
      return invalidGitHubResponse;
    seenStates.add(item.state);
    total += Number(item.count);
    if (bucket !== undefined && Number(item.count) > 0)
      buckets.add(bucket);
  }
  return total === expectedTotal ? { ok: true, value: buckets } : invalidGitHubResponse;
}
function parseStatusCheckRollup(input) {
  if (input === null)
    return { ok: true, value: "none" };
  if (!isRecord(input) || !isRecord(input.contexts))
    return invalidGitHubResponse;
  const contexts = input.contexts;
  const checkRuns = aggregateCounts(contexts.checkRunCountsByState, contexts.checkRunCount, {
    passed: checkRunPassed,
    pending: checkRunPending,
    failed: checkRunFailed,
    ignored: checkRunIgnored
  });
  if (!checkRuns.ok)
    return checkRuns;
  const statusContexts = aggregateCounts(contexts.statusContextCountsByState, contexts.statusContextCount, {
    passed: statusContextPassed,
    pending: statusContextPending,
    failed: statusContextFailed
  });
  if (!statusContexts.ok)
    return statusContexts;
  const buckets = new Set([...checkRuns.value, ...statusContexts.value]);
  if (buckets.has("failed"))
    return { ok: true, value: "failed" };
  if (buckets.has("pending"))
    return { ok: true, value: "pending" };
  if (buckets.has("passed"))
    return { ok: true, value: "passed" };
  return { ok: true, value: "none" };
}
function samePullRequest(left, right) {
  return left.number === right.number && left.owner.toLowerCase() === right.owner.toLowerCase() && left.repository.toLowerCase() === right.repository.toLowerCase();
}
function parseMergeability(input) {
  switch (input) {
    case "MERGEABLE":
      return { ok: true, value: "mergeable" };
    case "CONFLICTING":
      return { ok: true, value: "conflicting" };
    case "UNKNOWN":
      return { ok: true, value: "unknown" };
    default:
      return invalidGitHubResponse;
  }
}
function parseResponse(input, pullRequest) {
  if (!isRecord(input) || input.__typename !== "PullRequest" || typeof input.title !== "string" || input.title.trim() === "") {
    return invalidGitHubResponse;
  }
  if (input.state !== "OPEN" && input.state !== "CLOSED" && input.state !== "MERGED") {
    return invalidGitHubResponse;
  }
  if (input.mergedAt !== null && typeof input.mergedAt !== "string")
    return invalidGitHubResponse;
  if (typeof input.mergedAt === "string" && Number.isNaN(new Date(input.mergedAt).valueOf())) {
    return invalidGitHubResponse;
  }
  if (input.state === "MERGED" && typeof input.mergedAt !== "string")
    return invalidGitHubResponse;
  if (input.state !== "MERGED" && input.mergedAt !== null)
    return invalidGitHubResponse;
  if (typeof input.url !== "string")
    return invalidGitHubResponse;
  const responseUrl = parsePullRequestUrl(input.url);
  if (!responseUrl.ok || !samePullRequest(responseUrl.value, pullRequest))
    return invalidGitHubResponse;
  const ci = parseStatusCheckRollup(input.statusCheckRollup);
  if (!ci.ok)
    return ci;
  const mergeability = parseMergeability(input.mergeable);
  if (!mergeability.ok)
    return mergeability;
  let state;
  switch (input.state) {
    case "OPEN":
      state = { tag: "Open", ci: ci.value, mergeability: mergeability.value };
      break;
    case "MERGED":
      state = { tag: "Merged" };
      break;
    case "CLOSED":
      state = { tag: "Closed" };
      break;
    default:
      return casesHandled(input.state);
  }
  return {
    ok: true,
    value: {
      tag: "Available",
      pullRequest,
      title: input.title,
      state,
      stale: false
    }
  };
}
function createBatchQuery(size) {
  const variables = Array.from({ length: size }, (_, index) => `$url${index}: URI!`).join(", ");
  const fields = Array.from({ length: size }, (_, index) => `pr${index}: resource(url: $url${index}) { ${pullRequestSelection} }`).join(" ");
  return `query BatchPullRequests(${variables}) { ${fields} }`;
}
function parseGraphqlErrorAliases(input, size) {
  if (input === undefined)
    return { ok: true, value: new Set };
  if (!Array.isArray(input))
    return invalidGitHubResponse;
  const aliases = new Set;
  for (const error of input) {
    if (!isRecord(error) || typeof error.message !== "string" || !Array.isArray(error.path) || typeof error.path[0] !== "string") {
      return invalidGitHubResponse;
    }
    const match = /^pr([0-9]+)$/.exec(error.path[0]);
    if (match === null)
      return invalidGitHubResponse;
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= size)
      return invalidGitHubResponse;
    aliases.add(index);
  }
  return { ok: true, value: aliases };
}
function parseBatchResponse(input, pullRequests) {
  if (!isRecord(input) || !isRecord(input.data))
    return invalidGitHubResponse;
  const data = input.data;
  const errorAliases = parseGraphqlErrorAliases(input.errors, pullRequests.length);
  if (!errorAliases.ok)
    return errorAliases;
  return {
    ok: true,
    value: pullRequests.map((pullRequest, index) => errorAliases.value.has(index) ? invalidGitHubResponse : parseResponse(data[`pr${index}`], pullRequest))
  };
}
function isCancellation(cause, signal) {
  if (signal?.aborted)
    return true;
  return cause instanceof Error && cause.name === "AbortError";
}

class ProcessExecutionError extends Error {
  stdout;
  name;
  constructor(cause, stdout) {
    super(cause.message, { cause });
    this.stdout = stdout;
    this.name = cause.name;
  }
}
function processFailureStdout(cause) {
  if (!isRecord(cause) || typeof cause.stdout !== "string" || cause.stdout.trim() === "")
    return;
  return cause.stdout;
}
var execFileRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8", ...options.signal ? { signal: options.signal } : {} }, (error, stdout) => {
    if (error) {
      reject(new ProcessExecutionError(error, stdout));
      return;
    }
    resolve({ stdout });
  });
});
function createGitHubClient(runner = execFileRunner) {
  return {
    async get(pullRequests, options = {}) {
      if (pullRequests.length === 0)
        return { ok: true, value: [] };
      if (pullRequests.length > maximumPullRequestsPerBatch)
        return githubBatchLimitExceeded;
      const query = createBatchQuery(pullRequests.length);
      const args = ["api", "graphql", "--method", "POST", "-f", `query=${query}`];
      for (const [index, pullRequest] of pullRequests.entries()) {
        args.push("-f", `url${index}=${pullRequest.url}`);
      }
      let stdout;
      let executionCause;
      try {
        const output = await runner("gh", args, options);
        stdout = output.stdout;
      } catch (cause) {
        if (isCancellation(cause, options.signal)) {
          return {
            ok: false,
            error: {
              tag: "GitHubCancelled",
              message: "GitHub status request cancelled",
              cause
            }
          };
        }
        const partialStdout = processFailureStdout(cause);
        if (partialStdout !== undefined) {
          stdout = partialStdout;
          executionCause = cause;
        } else {
          return {
            ok: false,
            error: {
              tag: "GitHubUnavailable",
              message: "GitHub status unavailable",
              cause
            }
          };
        }
      }
      let decoded;
      try {
        decoded = JSON.parse(stdout);
      } catch {
        return executionCause === undefined ? invalidGitHubResponse : {
          ok: false,
          error: {
            tag: "GitHubUnavailable",
            message: "GitHub status unavailable",
            cause: executionCause
          }
        };
      }
      const parsed = parseBatchResponse(decoded, pullRequests);
      if (executionCause === undefined || parsed.ok)
        return parsed;
      return {
        ok: false,
        error: {
          tag: "GitHubUnavailable",
          message: "GitHub status unavailable",
          cause: executionCause
        }
      };
    }
  };
}
var openAppearances = {
  passed: { tone: "green", label: "checks passed", strikethrough: false },
  pending: { tone: "yellow", label: "checks pending", strikethrough: false },
  failed: { tone: "red", label: "checks failed", strikethrough: false },
  none: { tone: "gray", label: "no checks", strikethrough: false }
};
function stateAppearance(state) {
  switch (state.tag) {
    case "Open": {
      switch (state.mergeability) {
        case "conflicting":
          return { tone: "red", label: "merge conflict", strikethrough: false };
        case "mergeable":
        case "unknown":
          return openAppearances[state.ci];
        default:
          return casesHandled(state.mergeability);
      }
    }
    case "Merged":
      return { tone: "purple", label: "merged", strikethrough: true };
    case "Closed":
      return { tone: "red", label: "closed", strikethrough: true };
    default:
      return casesHandled(state);
  }
}
function statusAppearance(status) {
  if (status.tag === "Unavailable") {
    return { tone: "gray", label: "status unavailable", strikethrough: false };
  }
  const appearance = stateAppearance(status.state);
  return status.stale ? { ...appearance, label: `${appearance.label} (stale)` } : appearance;
}

// src/state.ts
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
var maximumPullRequestsPerSession = 20;
var invalidStateFile = {
  ok: false,
  error: {
    tag: "InvalidStateFile",
    message: "The session pull request state file is invalid"
  }
};
var lockStaleMilliseconds = 1e4;
var lockUpdateMilliseconds = 2000;
function stateUnavailable(operation, message, cause) {
  return { tag: "StateUnavailable", operation, message, cause };
}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function parseState(input) {
  if (!isRecord2(input) || !hasExactKeys(input, ["version", "pullRequests"]))
    return invalidStateFile;
  if (input.version !== 1 || !Array.isArray(input.pullRequests))
    return invalidStateFile;
  if (input.pullRequests.length > maximumPullRequestsPerSession)
    return invalidStateFile;
  const attachments = [];
  const seen = new Set;
  for (const item of input.pullRequests) {
    if (!isRecord2(item) || !hasExactKeys(item, ["url", "attachedAt"]))
      return invalidStateFile;
    if (typeof item.url !== "string" || typeof item.attachedAt !== "string")
      return invalidStateFile;
    const parsed = parsePullRequestUrl(item.url);
    if (!parsed.ok || parsed.value.url !== item.url || seen.has(item.url))
      return invalidStateFile;
    const attachedAt = new Date(item.attachedAt);
    if (Number.isNaN(attachedAt.valueOf()) || attachedAt.toISOString() !== item.attachedAt)
      return invalidStateFile;
    seen.add(item.url);
    attachments.push({ pullRequest: parsed.value, attachedAt: item.attachedAt });
  }
  return { ok: true, value: attachments };
}
function isMissingFile(cause) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
function fileName(sessionID) {
  return `${createHash("sha256").update(sessionID).digest("hex")}.json`;
}
function defaultStateDirectory(environment = process.env, home = homedir()) {
  const dataHome = environment.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "opencode", "opencode-pr-tracker");
}
function createStateStore(options = {}) {
  const directory = options.directory ?? defaultStateDirectory();
  const now = options.now ?? (() => new Date);
  async function acquireLock(sessionID) {
    const stateFile = join(directory, fileName(sessionID));
    let compromised;
    try {
      await mkdir(directory, { recursive: true });
      const release = await import_proper_lockfile.lock(stateFile, {
        realpath: false,
        stale: lockStaleMilliseconds,
        update: lockUpdateMilliseconds,
        retries: { retries: 50, factor: 1, minTimeout: 10, maxTimeout: 100 },
        onCompromised: (error) => {
          compromised = error;
        }
      });
      return { ok: true, value: { release, compromised: () => compromised } };
    } catch (cause) {
      return {
        ok: false,
        error: stateUnavailable("write", "Unable to lock the session pull request state", cause)
      };
    }
  }
  async function withLock(sessionID, operation) {
    const lock = await acquireLock(sessionID);
    if (!lock.ok)
      return lock;
    let result;
    try {
      result = await operation();
    } catch (cause) {
      await lock.value.release().catch(() => {
        return;
      });
      throw cause;
    }
    try {
      await lock.value.release();
    } catch (cause) {
      return {
        ok: false,
        error: stateUnavailable("write", "Unable to unlock the session pull request state", cause)
      };
    }
    const compromise = lock.value.compromised();
    if (compromise !== undefined) {
      return {
        ok: false,
        error: stateUnavailable("write", "The session pull request state lock was compromised", compromise)
      };
    }
    return result;
  }
  async function readExisting(sessionID) {
    const path = join(directory, fileName(sessionID));
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch (cause) {
      if (isMissingFile(cause))
        return { ok: true, value: undefined };
      return {
        ok: false,
        error: stateUnavailable("read", "Unable to read the session pull request state", cause)
      };
    }
    let decoded;
    try {
      decoded = JSON.parse(content);
    } catch {
      return invalidStateFile;
    }
    return parseState(decoded);
  }
  async function read(sessionID) {
    const result = await readExisting(sessionID);
    if (!result.ok)
      return result;
    return { ok: true, value: result.value ?? [] };
  }
  async function write(sessionID, attachments) {
    const destination = join(directory, fileName(sessionID));
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const state = {
      version: 1,
      pullRequests: attachments.map((attachment) => ({
        url: attachment.pullRequest.url,
        attachedAt: attachment.attachedAt
      }))
    };
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}
`, { mode: 384 });
      await rename(temporary, destination);
      return { ok: true, value: undefined };
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => {
        return;
      });
      return {
        ok: false,
        error: stateUnavailable("write", "Unable to write the session pull request state", cause)
      };
    }
  }
  return {
    list: read,
    async attach(sessionID, pullRequest) {
      return withLock(sessionID, async () => {
        const current = await read(sessionID);
        if (!current.ok)
          return current;
        if (current.value.some((attachment) => attachment.pullRequest.url === pullRequest.url)) {
          return { ok: true, value: "already_attached" };
        }
        if (current.value.length >= maximumPullRequestsPerSession) {
          return {
            ok: false,
            error: {
              tag: "AttachmentLimitReached",
              limit: maximumPullRequestsPerSession,
              message: "A session can track at most 20 pull requests"
            }
          };
        }
        const written = await write(sessionID, [...current.value, { pullRequest, attachedAt: now().toISOString() }]);
        if (!written.ok)
          return written;
        return { ok: true, value: "added" };
      });
    },
    async detach(sessionID, pullRequest) {
      return withLock(sessionID, async () => {
        const current = await read(sessionID);
        if (!current.ok)
          return current;
        const next = current.value.filter((attachment) => attachment.pullRequest.url !== pullRequest.url);
        if (next.length === current.value.length)
          return { ok: true, value: "absent" };
        const written = await write(sessionID, next);
        if (!written.ok)
          return written;
        return { ok: true, value: "removed" };
      });
    },
    async detachByNumber(sessionID, number) {
      return withLock(sessionID, async () => {
        const current = await read(sessionID);
        if (!current.ok)
          return current;
        const matches = current.value.filter((attachment) => attachment.pullRequest.number === number);
        if (matches.length === 0)
          return { ok: true, value: { tag: "absent" } };
        if (matches.length > 1) {
          return {
            ok: true,
            value: { tag: "ambiguous", pullRequests: matches.map((attachment) => attachment.pullRequest) }
          };
        }
        const match = matches[0];
        if (match === undefined)
          return { ok: true, value: { tag: "absent" } };
        const next = current.value.filter((attachment) => attachment.pullRequest.url !== match.pullRequest.url);
        const written = await write(sessionID, next);
        if (!written.ok)
          return written;
        return { ok: true, value: { tag: "removed", pullRequest: match.pullRequest } };
      });
    },
    async removeSession(sessionID) {
      return withLock(sessionID, async () => {
        const current = await readExisting(sessionID);
        if (!current.ok)
          return current;
        if (current.value === undefined)
          return { ok: true, value: "absent" };
        try {
          await rm(join(directory, fileName(sessionID)), { force: true });
          return { ok: true, value: "removed" };
        } catch (cause) {
          return {
            ok: false,
            error: stateUnavailable("write", "Unable to remove the session pull request state", cause)
          };
        }
      });
    }
  };
}

// src/tui.tsx
var pollIntervalMilliseconds = 60000;
var defaultScheduler = {
  setInterval: (task, delay) => globalThis.setInterval(task, delay),
  clearInterval: (handle) => globalThis.clearInterval(handle)
};
function attachPullRequest(store, sessionID, input) {
  const pullRequest = parsePullRequestUrl(input);
  if (!pullRequest.ok)
    return Promise.resolve(pullRequest);
  return store.attach(sessionID, pullRequest.value);
}
function startSessionPolling(input) {
  const scheduler = input.scheduler ?? defaultScheduler;
  const statuses = new Map;
  const controller = new AbortController;
  let timer;
  let timerRegistered = false;
  let stopped = false;
  let inFlight;
  let refreshQueued = false;
  function project(attachments) {
    return attachments.map((attachment) => ({
      attachment,
      status: statuses.get(attachment.pullRequest.url) ?? {
        tag: "Unavailable"
      }
    }));
  }
  async function poll() {
    const attachments = await input.store.list(input.sessionID);
    if (stopped)
      return;
    if (!attachments.ok) {
      input.publish([]);
      input.onStateFailure(attachments.error);
      return;
    }
    const attachedUrls = new Set(attachments.value.map((attachment) => attachment.pullRequest.url));
    for (const url of statuses.keys()) {
      if (!attachedUrls.has(url))
        statuses.delete(url);
    }
    input.publish(project(attachments.value));
    const refreshable = attachments.value.filter((attachment) => {
      const previous = statuses.get(attachment.pullRequest.url);
      return previous?.tag !== "Available" || previous.state.tag !== "Merged";
    });
    const batch = await input.github.get(refreshable.map((attachment) => attachment.pullRequest), {
      signal: controller.signal
    });
    if (stopped || !batch.ok && batch.error.tag === "GitHubCancelled")
      return;
    for (const [index, attachment] of refreshable.entries()) {
      const previous = statuses.get(attachment.pullRequest.url);
      const result = batch.ok ? batch.value[index] : undefined;
      if (result?.ok) {
        statuses.set(attachment.pullRequest.url, result.value);
        continue;
      }
      statuses.set(attachment.pullRequest.url, previous?.tag === "Available" ? {
        ...previous,
        stale: true
      } : {
        tag: "Unavailable"
      });
    }
    if (!stopped)
      input.publish(project(attachments.value));
  }
  function refresh() {
    if (stopped)
      return Promise.resolve();
    if (inFlight) {
      refreshQueued = true;
      return inFlight;
    }
    const wrapped = poll().finally(() => {
      inFlight = undefined;
      if (refreshQueued && !stopped) {
        refreshQueued = false;
        return refresh();
      }
      return;
    });
    inFlight = wrapped;
    return wrapped;
  }
  return {
    start() {
      if (stopped)
        return Promise.resolve();
      if (!timerRegistered) {
        timer = scheduler.setInterval(() => {
          refresh().catch(input.onError);
        }, pollIntervalMilliseconds);
        timerRegistered = true;
      }
      return refresh();
    },
    refresh,
    stop() {
      if (stopped)
        return;
      stopped = true;
      controller.abort();
      if (timerRegistered)
        scheduler.clearInterval(timer);
    }
  };
}
async function openPullRequest(pullRequest, options = {}) {
  const platform = options.platform ?? process.platform;
  const executable = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined;
  if (executable === undefined) {
    return {
      ok: false,
      error: {
        tag: "UnsupportedPlatform",
        message: `Opening pull requests is unsupported on ${platform}`,
        platform
      }
    };
  }
  try {
    await (options.runner ?? execFileRunner)(executable, [pullRequest.url], options.signal ? {
      signal: options.signal
    } : {});
    return {
      ok: true,
      value: undefined
    };
  } catch (cause) {
    return {
      ok: false,
      error: {
        tag: "OpenPullRequestFailed",
        message: "Unable to open the pull request",
        cause
      }
    };
  }
}
function createRefreshBus() {
  const listeners = new Map;
  return {
    emit(sessionID) {
      for (const listener of listeners.get(sessionID) ?? [])
        listener();
    },
    subscribe(sessionID, listener) {
      const sessionListeners = listeners.get(sessionID) ?? new Set;
      sessionListeners.add(listener);
      listeners.set(sessionID, sessionListeners);
      return () => {
        sessionListeners.delete(listener);
        if (sessionListeners.size === 0)
          listeners.delete(sessionID);
      };
    }
  };
}
function currentSessionID(api) {
  const route = api.route.current;
  if (route.name !== "session" || !("params" in route))
    return;
  return typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined;
}
function promptForPullRequest(api) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished)
        return;
      finished = true;
      api.ui.dialog.clear();
      resolve(value);
    };
    api.ui.dialog.setSize("medium");
    api.ui.dialog.replace(() => {
      const [error, setError] = createSignal();
      const DialogPrompt = api.ui.DialogPrompt;
      return _$createComponent(DialogPrompt, {
        title: "Attach pull request",
        placeholder: "https://github.com/owner/repository/pull/123",
        description: () => error() ? (() => {
          var _el$ = _$createElement("text");
          _$insert(_el$, error);
          _$effect((_$p) => _$setProp(_el$, "fg", api.theme.current.error, _$p));
          return _el$;
        })() : null,
        onConfirm: (value) => {
          const parsed = parsePullRequestUrl(value);
          if (!parsed.ok) {
            setError(parsed.error.message);
            return;
          }
          finish(parsed.value);
        },
        onCancel: () => finish(undefined)
      });
    }, () => {
      if (!finished)
        resolve(undefined);
    });
  });
}
function selectPullRequest(api, title, attachments) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished)
        return;
      finished = true;
      api.ui.dialog.clear();
      resolve(value);
    };
    api.ui.dialog.setSize("medium");
    api.ui.dialog.replace(() => {
      const DialogSelect = api.ui.DialogSelect;
      return _$createComponent(DialogSelect, {
        title,
        get options() {
          return attachments.map((attachment) => ({
            title: formatPullRequestRef(attachment.pullRequest),
            value: attachment.pullRequest,
            description: attachment.pullRequest.url
          }));
        },
        onSelect: (option) => finish(option.value)
      });
    }, () => {
      if (!finished)
        resolve(undefined);
    });
  });
}
function showStateFailure(api, failure) {
  api.ui.toast({
    variant: "error",
    title: "Pull request tracker",
    message: failure.message
  });
}
function toneColor(theme, tone) {
  const colors = {
    green: theme.success,
    yellow: theme.warning,
    red: theme.error,
    purple: theme.secondary,
    gray: theme.textMuted
  };
  return colors[tone];
}
function PullRequestSidebar(props) {
  const [items, setItems] = createSignal([]);
  const [failure, setFailure] = createSignal();
  const polling = startSessionPolling({
    sessionID: props.sessionID,
    store: props.dependencies.store,
    github: props.dependencies.github,
    publish: (value) => {
      setFailure(undefined);
      setItems(value);
    },
    onStateFailure: (error) => setFailure(error.message),
    onError: () => setFailure("Unable to refresh pull request status")
  });
  polling.start().catch(() => setFailure("Unable to refresh pull request status"));
  const unsubscribe = props.refreshBus.subscribe(props.sessionID, () => {
    polling.refresh().catch(() => setFailure("Unable to refresh pull request status"));
  });
  const onAbort = () => polling.stop();
  props.api.lifecycle.signal.addEventListener("abort", onAbort, {
    once: true
  });
  onCleanup(() => {
    unsubscribe();
    polling.stop();
    props.api.lifecycle.signal.removeEventListener("abort", onAbort);
  });
  return (() => {
    var _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("b");
    _$insertNode(_el$2, _el$3);
    _$setProp(_el$2, "flexDirection", "column");
    _$setProp(_el$2, "gap", 1);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$4, _$createTextNode(`Pull requests`));
    _$insert(_el$2, (() => {
      var _c$ = _$memo(() => !!failure());
      return () => _c$() ? (() => {
        var _el$6 = _$createElement("text");
        _$insert(_el$6, failure);
        _$effect((_$p) => _$setProp(_el$6, "fg", props.api.theme.current.error, _$p));
        return _el$6;
      })() : null;
    })(), null);
    _$insert(_el$2, (() => {
      var _c$2 = _$memo(() => !!(!failure() && items().length === 0));
      return () => _c$2() ? (() => {
        var _el$7 = _$createElement("text");
        _$insertNode(_el$7, _$createTextNode(`No pull requests attached`));
        _$effect((_$p) => _$setProp(_el$7, "fg", props.api.theme.current.textMuted, _$p));
        return _el$7;
      })() : null;
    })(), null);
    _$insert(_el$2, () => items().map((item) => {
      const appearance = statusAppearance(item.status);
      const attributes = appearance.strikethrough ? TextAttributes.STRIKETHROUGH : TextAttributes.NONE;
      const title = item.status.tag === "Available" ? item.status.title : "Title unavailable";
      return (() => {
        var _el$9 = _$createElement("box"), _el$0 = _$createElement("text"), _el$1 = _$createElement("b"), _el$10 = _$createTextNode(` `), _el$11 = _$createElement("text");
        _$insertNode(_el$9, _el$0);
        _$insertNode(_el$9, _el$11);
        _$setProp(_el$9, "flexDirection", "column");
        _$setProp(_el$9, "onMouseUp", () => {
          openPullRequest(item.attachment.pullRequest, {
            ...props.dependencies.runner ? {
              runner: props.dependencies.runner
            } : {},
            signal: props.api.lifecycle.signal
          }).then((result) => {
            if (!result.ok) {
              props.api.ui.toast({
                variant: "error",
                title: "Pull request tracker",
                message: result.error.message
              });
            }
          }).catch(() => {
            props.api.ui.toast({
              variant: "error",
              title: "Pull request tracker",
              message: "Unable to open the pull request"
            });
          });
        });
        _$insertNode(_el$0, _el$1);
        _$insertNode(_el$0, _el$10);
        _$setProp(_el$0, "attributes", attributes);
        _$insert(_el$1, () => formatPullRequestRef(item.attachment.pullRequest));
        _$insert(_el$0, () => appearance.label, null);
        _$setProp(_el$11, "attributes", attributes);
        _$insert(_el$11, title);
        _$effect((_p$) => {
          var _v$ = toneColor(props.api.theme.current, appearance.tone), _v$2 = props.api.theme.current.textMuted;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$0, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$11, "fg", _v$2, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$9;
      })();
    }), null);
    _$effect((_$p) => _$setProp(_el$3, "fg", props.api.theme.current.text, _$p));
    return _el$2;
  })();
}
function registerTui(api, dependencies) {
  const refreshBus = createRefreshBus();
  api.event.on("session.updated", (event) => refreshBus.emit(event.properties.sessionID));
  api.event.on("message.updated", (event) => refreshBus.emit(event.properties.sessionID));
  api.event.on("message.part.updated", (event) => refreshBus.emit(event.properties.sessionID));
  const disposeCommands = api.keymap.registerLayer({
    commands: [{
      name: "pr.attach",
      title: "Attach pull request",
      category: "Plugin",
      namespace: "palette",
      slashName: "pr-attach",
      async run() {
        const sessionID = currentSessionID(api);
        if (sessionID === undefined) {
          api.ui.toast({
            variant: "warning",
            title: "Pull request tracker",
            message: "Open a session first"
          });
          return;
        }
        const pullRequest = await promptForPullRequest(api);
        if (pullRequest === undefined)
          return;
        const result = await dependencies.store.attach(sessionID, pullRequest);
        if (!result.ok) {
          showStateFailure(api, result.error);
          return;
        }
        const message = result.value === "added" ? `Attached ${formatPullRequestRef(pullRequest)}` : `${formatPullRequestRef(pullRequest)} is already attached`;
        api.ui.toast({
          variant: "success",
          title: "Pull request tracker",
          message
        });
        refreshBus.emit(sessionID);
      }
    }, {
      name: "pr.open",
      title: "Open pull request",
      category: "Plugin",
      namespace: "palette",
      slashName: "pr-open",
      async run() {
        const sessionID = currentSessionID(api);
        if (sessionID === undefined) {
          api.ui.toast({
            variant: "warning",
            title: "Pull request tracker",
            message: "Open a session first"
          });
          return;
        }
        const attachments = await dependencies.store.list(sessionID);
        if (!attachments.ok) {
          showStateFailure(api, attachments.error);
          return;
        }
        if (attachments.value.length === 0) {
          api.ui.toast({
            variant: "info",
            title: "Pull request tracker",
            message: "No pull requests are attached"
          });
          return;
        }
        const pullRequest = await selectPullRequest(api, "Open pull request", attachments.value);
        if (pullRequest === undefined)
          return;
        const result = await openPullRequest(pullRequest, {
          ...dependencies.runner ? {
            runner: dependencies.runner
          } : {},
          signal: api.lifecycle.signal
        });
        if (!result.ok) {
          api.ui.toast({
            variant: "error",
            title: "Pull request tracker",
            message: result.error.message
          });
        }
      }
    }, {
      name: "pr.detach",
      title: "Detach pull request",
      category: "Plugin",
      namespace: "palette",
      slashName: "pr-detach",
      async run() {
        const sessionID = currentSessionID(api);
        if (sessionID === undefined) {
          api.ui.toast({
            variant: "warning",
            title: "Pull request tracker",
            message: "Open a session first"
          });
          return;
        }
        const attachments = await dependencies.store.list(sessionID);
        if (!attachments.ok) {
          showStateFailure(api, attachments.error);
          return;
        }
        if (attachments.value.length === 0) {
          api.ui.toast({
            variant: "info",
            title: "Pull request tracker",
            message: "No pull requests are attached"
          });
          return;
        }
        const pullRequest = await selectPullRequest(api, "Detach pull request", attachments.value);
        if (pullRequest === undefined)
          return;
        const result = await dependencies.store.detach(sessionID, pullRequest);
        if (!result.ok) {
          showStateFailure(api, result.error);
          return;
        }
        const message = result.value === "removed" ? `Detached ${formatPullRequestRef(pullRequest)}` : `${formatPullRequestRef(pullRequest)} was not attached`;
        api.ui.toast({
          variant: "success",
          title: "Pull request tracker",
          message
        });
        refreshBus.emit(sessionID);
      }
    }],
    bindings: []
  });
  api.lifecycle.onDispose(disposeCommands);
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(_context, value) {
        return _$createComponent(PullRequestSidebar, {
          api,
          get sessionID() {
            return value.session_id;
          },
          dependencies,
          refreshBus
        });
      }
    }
  });
}
var plugin = {
  id: "opencode-pr-tracker",
  async tui(api, options) {
    if (options?.enabled === false)
      return;
    registerTui(api, {
      store: createStateStore(),
      github: createGitHubClient()
    });
  }
};
var tui_default = plugin;
export {
  startSessionPolling,
  registerTui,
  openPullRequest,
  tui_default as default,
  attachPullRequest
};

//# debugId=213B714DA2A75B8764756E2164756E21
