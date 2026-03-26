#!/usr/bin/env bun
// @bun
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __moduleCache = /* @__PURE__ */ new WeakMap;
var __toCommonJS = (from) => {
  var entry = __moduleCache.get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function")
    __getOwnPropNames(from).map((key) => !__hasOwnProp.call(entry, key) && __defProp(entry, key, {
      get: () => from[key],
      enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
    }));
  __moduleCache.set(from, entry);
  return entry;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/lib/repo.ts
var exports_repo = {};
__export(exports_repo, {
  getWorkDir: () => getWorkDir,
  getRepoRoot: () => getRepoRoot,
  getIndexPath: () => getIndexPath,
  findRepoRoot: () => findRepoRoot
});
import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
function findRepoRoot(startPath) {
  let current = resolve(startPath || process.cwd());
  const root = dirname(current);
  while (current !== root) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current)
      break;
    current = parent;
  }
  if (existsSync(join(current, ".git"))) {
    return current;
  }
  return null;
}
function getRepoRoot(startPath) {
  const root = findRepoRoot(startPath);
  if (!root) {
    throw new Error("Not in a git repository. Run this command from within a git repository, " + "or specify --repo-root explicitly.");
  }
  return root;
}
function getWorkDir(repoRoot) {
  return join(repoRoot, "work");
}
function getIndexPath(repoRoot) {
  return join(getWorkDir(repoRoot), "index.json");
}
var init_repo = () => {};

// ../../node_modules/.bun/graceful-fs@4.2.11/node_modules/graceful-fs/polyfills.js
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

// ../../node_modules/.bun/graceful-fs@4.2.11/node_modules/graceful-fs/legacy-streams.js
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

// ../../node_modules/.bun/graceful-fs@4.2.11/node_modules/graceful-fs/clone.js
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

// ../../node_modules/.bun/graceful-fs@4.2.11/node_modules/graceful-fs/graceful-fs.js
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
      var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir(path2, options2, cb2, startTime) {
        return fs$readdir(path2, fs$readdirCallback(path2, options2, cb2, startTime));
      } : function go$readdir(path2, options2, cb2, startTime) {
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

// ../../node_modules/.bun/retry@0.12.0/node_modules/retry/lib/retry_operation.js
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

// ../../node_modules/.bun/retry@0.12.0/node_modules/retry/lib/retry.js
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

// ../../node_modules/.bun/signal-exit@3.0.7/node_modules/signal-exit/signals.js
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

// ../../node_modules/.bun/signal-exit@3.0.7/node_modules/signal-exit/index.js
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
    unload = function unload() {
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
    emit = function emit(event, code, signal) {
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
    load = function load() {
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
    processReallyExit = function processReallyExit(code) {
      if (!processOk(global.process)) {
        return;
      }
      process2.exitCode = code || 0;
      emit("exit", process2.exitCode, null);
      emit("afterexit", process2.exitCode, null);
      originalProcessReallyExit.call(process2, process2.exitCode);
    };
    originalProcessEmit = process2.emit;
    processEmit = function processEmit(ev, arg) {
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

// ../../node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/mtime-precision.js
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

// ../../node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/lockfile.js
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

// ../../node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js
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
    return (...args) => new Promise((resolve2, reject) => {
      args.push((err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve2(result);
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

// ../../node_modules/.bun/proper-lockfile@4.1.2/node_modules/proper-lockfile/index.js
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

// src/lib/index.ts
var exports_lib = {};
__export(exports_lib, {
  setStreamStatus: () => setStreamStatus,
  setStreamPlanningSession: () => setStreamPlanningSession,
  setStreamGitHubMeta: () => setStreamGitHubMeta,
  setCurrentStream: () => setCurrentStream,
  saveIndexSafe: () => saveIndexSafe,
  saveIndex: () => saveIndex,
  resolveStreamId: () => resolveStreamId,
  modifyIndex: () => modifyIndex,
  loadIndex: () => loadIndex,
  getStream: () => getStream,
  getResolvedStream: () => getResolvedStream,
  getPlanningSessionId: () => getPlanningSessionId,
  getOrCreateIndex: () => getOrCreateIndex,
  getNextOrderNumber: () => getNextOrderNumber,
  getCurrentStreamId: () => getCurrentStreamId,
  getCurrentStream: () => getCurrentStream,
  formatOrderNumber: () => formatOrderNumber,
  findStream: () => findStream,
  deleteStream: () => deleteStream,
  clearCurrentStream: () => clearCurrentStream,
  atomicWriteFile: () => atomicWriteFile
});
import { existsSync as existsSync2, readFileSync, writeFileSync, renameSync, rmSync } from "fs";
import { join as join2 } from "path";
function atomicWriteJSON(path, data) {
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2));
  renameSync(tempPath, path);
}
function atomicWriteFile(path, content) {
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, content);
  renameSync(tempPath, path);
}
async function withIndexLock(indexPath, fn) {
  const release = await lockfile.lock(indexPath, {
    retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 }
  });
  try {
    return fn();
  } finally {
    await release();
  }
}
function getOrCreateIndex(repoRoot) {
  const indexPath = getIndexPath(repoRoot);
  if (existsSync2(indexPath)) {
    const content = readFileSync(indexPath, "utf-8");
    return JSON.parse(content);
  }
  return {
    version: "1.0.0",
    last_updated: new Date().toISOString(),
    streams: []
  };
}
function loadIndex(repoRoot) {
  const indexPath = getIndexPath(repoRoot);
  if (!existsSync2(indexPath)) {
    throw new Error(`No workstreams index found at ${indexPath}`);
  }
  const content = readFileSync(indexPath, "utf-8");
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse index.json at ${indexPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function saveIndex(repoRoot, index) {
  const indexPath = getIndexPath(repoRoot);
  const orderedIndex = {
    version: index.version,
    last_updated: new Date().toISOString(),
    ...index.current_stream !== undefined ? { current_stream: index.current_stream } : {},
    streams: index.streams
  };
  atomicWriteJSON(indexPath, orderedIndex);
}
async function saveIndexSafe(repoRoot, index) {
  const indexPath = getIndexPath(repoRoot);
  await withIndexLock(indexPath, () => {
    const orderedIndex = {
      version: index.version,
      last_updated: new Date().toISOString(),
      ...index.current_stream !== undefined ? { current_stream: index.current_stream } : {},
      streams: index.streams
    };
    atomicWriteJSON(indexPath, orderedIndex);
  });
}
async function modifyIndex(repoRoot, fn) {
  const indexPath = getIndexPath(repoRoot);
  return withIndexLock(indexPath, () => {
    const index = loadIndex(repoRoot);
    const result = fn(index);
    saveIndex(repoRoot, index);
    return result;
  });
}
function findStream(index, streamIdOrName) {
  return index.streams.find((s) => s.id === streamIdOrName || s.name === streamIdOrName);
}
function getStream(index, streamIdOrName) {
  const stream = findStream(index, streamIdOrName);
  if (!stream) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  return stream;
}
function getNextOrderNumber(index) {
  if (index.streams.length === 0)
    return 0;
  return Math.max(...index.streams.map((s) => s.order)) + 1;
}
function formatOrderNumber(order) {
  return order.toString().padStart(3, "0");
}
function getCurrentStreamId(index) {
  return index.current_stream;
}
function getCurrentStream(index) {
  if (!index.current_stream) {
    throw new Error("No current workstream set. Use 'work current --set <id>' to set one.");
  }
  return getStream(index, index.current_stream);
}
function setCurrentStream(repoRoot, streamIdOrName) {
  const index = loadIndex(repoRoot);
  const stream = getStream(index, streamIdOrName);
  index.current_stream = stream.id;
  saveIndex(repoRoot, index);
  return stream;
}
function clearCurrentStream(repoRoot) {
  const index = loadIndex(repoRoot);
  delete index.current_stream;
  saveIndex(repoRoot, index);
}
function resolveStreamId(index, streamIdOrName) {
  if (streamIdOrName === "current") {
    return index.current_stream;
  }
  if (streamIdOrName) {
    return streamIdOrName;
  }
  return index.current_stream;
}
function getResolvedStream(index, streamIdOrName) {
  const resolvedId = resolveStreamId(index, streamIdOrName);
  if (!resolvedId) {
    throw new Error("No workstream specified and no current workstream set. Use --stream <id> or 'work current --set <id>'");
  }
  return getStream(index, resolvedId);
}
function setStreamStatus(repoRoot, streamIdOrName, status) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  const stream = index.streams[streamIndex];
  if (status === undefined) {
    delete stream.status;
  } else {
    stream.status = status;
  }
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
  return stream;
}
async function deleteStream(repoRoot, streamIdOrName, options) {
  return modifyIndex(repoRoot, (index) => {
    const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
    if (streamIndex === -1) {
      throw new Error(`Workstream "${streamIdOrName}" not found`);
    }
    const stream = index.streams[streamIndex];
    index.streams.splice(streamIndex, 1);
    if (index.current_stream === stream.id) {
      delete index.current_stream;
    }
    if (options?.deleteFiles) {
      const streamDir = join2(getWorkDir(repoRoot), stream.id);
      if (existsSync2(streamDir)) {
        rmSync(streamDir, { recursive: true });
      }
    }
    return {
      deleted: true,
      streamId: stream.id,
      streamPath: stream.path
    };
  });
}
function setStreamGitHubMeta(repoRoot, streamIdOrName, meta) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  const stream = index.streams[streamIndex];
  if (meta === undefined) {
    delete stream.github;
  } else {
    stream.github = {
      ...stream.github,
      ...meta
    };
  }
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
  return stream;
}
function setStreamPlanningSession(repoRoot, streamIdOrName, sessionId) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  const stream = index.streams[streamIndex];
  stream.planningSession = {
    sessionId,
    createdAt: new Date().toISOString()
  };
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
  return stream;
}
function getPlanningSessionId(repoRoot, streamIdOrName) {
  const index = loadIndex(repoRoot);
  const stream = findStream(index, streamIdOrName);
  if (!stream) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  return stream.planningSession?.sessionId ?? null;
}
var lockfile;
var init_lib = __esm(() => {
  init_repo();
  lockfile = __toESM(require_proper_lockfile(), 1);
});

// ../../node_modules/.bun/marked@17.0.1/node_modules/marked/lib/marked.esm.js
function L() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
function Z(u) {
  T = u;
}
function k(u, e = "") {
  let t = typeof u == "string" ? u : u.source, n = { replace: (r, i) => {
    let s = typeof i == "string" ? i : i.source;
    return s = s.replace(m.caret, "$1"), t = t.replace(r, s), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
function w(u, e) {
  if (e) {
    if (m.escapeTest.test(u))
      return u.replace(m.escapeReplace, ke);
  } else if (m.escapeTestNoEncode.test(u))
    return u.replace(m.escapeReplaceNoEncode, ke);
  return u;
}
function X(u) {
  try {
    u = encodeURI(u).replace(m.percentDecode, "%");
  } catch {
    return null;
  }
  return u;
}
function J(u, e) {
  let t = u.replace(m.findPipe, (i, s, a) => {
    let o = false, l = s;
    for (;--l >= 0 && a[l] === "\\"; )
      o = !o;
    return o ? "|" : " |";
  }), n = t.split(m.splitPipe), r = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e)
    if (n.length > e)
      n.splice(e);
    else
      for (;n.length < e; )
        n.push("");
  for (;r < n.length; r++)
    n[r] = n[r].trim().replace(m.slashPipe, "|");
  return n;
}
function z(u, e, t) {
  let n = u.length;
  if (n === 0)
    return "";
  let r = 0;
  for (;r < n; ) {
    let i = u.charAt(n - r - 1);
    if (i === e && !t)
      r++;
    else if (i !== e && t)
      r++;
    else
      break;
  }
  return u.slice(0, n - r);
}
function de(u, e) {
  if (u.indexOf(e[1]) === -1)
    return -1;
  let t = 0;
  for (let n = 0;n < u.length; n++)
    if (u[n] === "\\")
      n++;
    else if (u[n] === e[0])
      t++;
    else if (u[n] === e[1] && (t--, t < 0))
      return n;
  return t > 0 ? -2 : -1;
}
function ge(u, e, t, n, r) {
  let i = e.href, s = e.title || null, a = u[1].replace(r.other.outputLinkReplace, "$1");
  n.state.inLink = true;
  let o = { type: u[0].charAt(0) === "!" ? "image" : "link", raw: t, href: i, title: s, text: a, tokens: n.inlineTokens(a) };
  return n.state.inLink = false, o;
}
function Je(u, e, t) {
  let n = u.match(t.other.indentCodeCompensation);
  if (n === null)
    return e;
  let r = n[1];
  return e.split(`
`).map((i) => {
    let s = i.match(t.other.beginningSpace);
    if (s === null)
      return i;
    let [a] = s;
    return a.length >= r.length ? i.slice(r.length) : i;
  }).join(`
`);
}
function d(u3, e) {
  return _.parse(u3, e);
}
var T, C, me, m, xe, be, Re, I, Te, N, re, se, Oe, Q, we, F, ye, Pe, v = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul", j, Se, ie, $e, U, te, _e, Le, Me, ze, oe, Ae, D, K, ae, Ce, le, Ie, Ee, Be, ue, qe, ve, pe = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)", De, He, Ze, Ge, Ne, Qe, Fe, q, je, ce, he, Ue, ne, W, Ke, G, We, E, M, Xe, ke = (u) => Xe[u], y = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0)
      return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let n = t[0].replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: t[0], codeBlockStyle: "indented", text: this.options.pedantic ? n : z(n, `
`) };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let n = t[0], r = Je(n, t[3] || "", this.rules);
      return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: r };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let n = t[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let r = z(n, "#");
        (this.options.pedantic || !r || this.rules.other.endingSpaceChar.test(r)) && (n = r.trim());
      }
      return { type: "heading", raw: t[0], depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t)
      return { type: "hr", raw: z(t[0], `
`) };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let n = z(t[0], `
`).split(`
`), r = "", i = "", s = [];
      for (;n.length > 0; ) {
        let a = false, o = [], l;
        for (l = 0;l < n.length; l++)
          if (this.rules.other.blockquoteStart.test(n[l]))
            o.push(n[l]), a = true;
          else if (!a)
            o.push(n[l]);
          else
            break;
        n = n.slice(l);
        let p = o.join(`
`), c = p.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        r = r ? `${r}
${p}` : p, i = i ? `${i}
${c}` : c;
        let g = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(c, s, true), this.lexer.state.top = g, n.length === 0)
          break;
        let h = s.at(-1);
        if (h?.type === "code")
          break;
        if (h?.type === "blockquote") {
          let R = h, f = R.raw + `
` + n.join(`
`), O = this.blockquote(f);
          s[s.length - 1] = O, r = r.substring(0, r.length - R.raw.length) + O.raw, i = i.substring(0, i.length - R.text.length) + O.text;
          break;
        } else if (h?.type === "list") {
          let R = h, f = R.raw + `
` + n.join(`
`), O = this.list(f);
          s[s.length - 1] = O, r = r.substring(0, r.length - h.raw.length) + O.raw, i = i.substring(0, i.length - R.raw.length) + O.raw, n = f.substring(s.at(-1).raw.length).split(`
`);
          continue;
        }
      }
      return { type: "blockquote", raw: r, tokens: s, text: i };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      let n = t[1].trim(), r = n.length > 1, i = { type: "list", raw: "", ordered: r, start: r ? +n.slice(0, -1) : "", loose: false, items: [] };
      n = r ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`, this.options.pedantic && (n = r ? n : "[*+-]");
      let s = this.rules.other.listItemRegex(n), a = false;
      for (;e; ) {
        let l = false, p = "", c = "";
        if (!(t = s.exec(e)) || this.rules.block.hr.test(e))
          break;
        p = t[0], e = e.substring(p.length);
        let g = t[2].split(`
`, 1)[0].replace(this.rules.other.listReplaceTabs, (O) => " ".repeat(3 * O.length)), h = e.split(`
`, 1)[0], R = !g.trim(), f = 0;
        if (this.options.pedantic ? (f = 2, c = g.trimStart()) : R ? f = t[1].length + 1 : (f = t[2].search(this.rules.other.nonSpaceChar), f = f > 4 ? 1 : f, c = g.slice(f), f += t[1].length), R && this.rules.other.blankLine.test(h) && (p += h + `
`, e = e.substring(h.length + 1), l = true), !l) {
          let O = this.rules.other.nextBulletRegex(f), V = this.rules.other.hrRegex(f), Y = this.rules.other.fencesBeginRegex(f), ee = this.rules.other.headingBeginRegex(f), fe = this.rules.other.htmlBeginRegex(f);
          for (;e; ) {
            let H = e.split(`
`, 1)[0], A;
            if (h = H, this.options.pedantic ? (h = h.replace(this.rules.other.listReplaceNesting, "  "), A = h) : A = h.replace(this.rules.other.tabCharGlobal, "    "), Y.test(h) || ee.test(h) || fe.test(h) || O.test(h) || V.test(h))
              break;
            if (A.search(this.rules.other.nonSpaceChar) >= f || !h.trim())
              c += `
` + A.slice(f);
            else {
              if (R || g.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || Y.test(g) || ee.test(g) || V.test(g))
                break;
              c += `
` + h;
            }
            !R && !h.trim() && (R = true), p += H + `
`, e = e.substring(H.length + 1), g = A.slice(f);
          }
        }
        i.loose || (a ? i.loose = true : this.rules.other.doubleBlankLine.test(p) && (a = true)), i.items.push({ type: "list_item", raw: p, task: !!this.options.gfm && this.rules.other.listIsTask.test(c), loose: false, text: c, tokens: [] }), i.raw += p;
      }
      let o = i.items.at(-1);
      if (o)
        o.raw = o.raw.trimEnd(), o.text = o.text.trimEnd();
      else
        return;
      i.raw = i.raw.trimEnd();
      for (let l of i.items) {
        if (this.lexer.state.top = false, l.tokens = this.lexer.blockTokens(l.text, []), l.task) {
          if (l.text = l.text.replace(this.rules.other.listReplaceTask, ""), l.tokens[0]?.type === "text" || l.tokens[0]?.type === "paragraph") {
            l.tokens[0].raw = l.tokens[0].raw.replace(this.rules.other.listReplaceTask, ""), l.tokens[0].text = l.tokens[0].text.replace(this.rules.other.listReplaceTask, "");
            for (let c = this.lexer.inlineQueue.length - 1;c >= 0; c--)
              if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[c].src)) {
                this.lexer.inlineQueue[c].src = this.lexer.inlineQueue[c].src.replace(this.rules.other.listReplaceTask, "");
                break;
              }
          }
          let p = this.rules.other.listTaskCheckbox.exec(l.raw);
          if (p) {
            let c = { type: "checkbox", raw: p[0] + " ", checked: p[0] !== "[ ]" };
            l.checked = c.checked, i.loose ? l.tokens[0] && ["paragraph", "text"].includes(l.tokens[0].type) && "tokens" in l.tokens[0] && l.tokens[0].tokens ? (l.tokens[0].raw = c.raw + l.tokens[0].raw, l.tokens[0].text = c.raw + l.tokens[0].text, l.tokens[0].tokens.unshift(c)) : l.tokens.unshift({ type: "paragraph", raw: c.raw, text: c.raw, tokens: [c] }) : l.tokens.unshift(c);
          }
        }
        if (!i.loose) {
          let p = l.tokens.filter((g) => g.type === "space"), c = p.length > 0 && p.some((g) => this.rules.other.anyLine.test(g.raw));
          i.loose = c;
        }
      }
      if (i.loose)
        for (let l of i.items) {
          l.loose = true;
          for (let p of l.tokens)
            p.type === "text" && (p.type = "paragraph");
        }
      return i;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t)
      return { type: "html", block: true, raw: t[0], pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: t[0] };
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      let n = t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal, " "), r = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", i = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
      return { type: "def", tag: n, raw: t[0], href: r, title: i };
    }
  }
  table(e) {
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2]))
      return;
    let n = J(t[1]), r = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), i = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], s = { type: "table", raw: t[0], header: [], align: [], rows: [] };
    if (n.length === r.length) {
      for (let a of r)
        this.rules.other.tableAlignRight.test(a) ? s.align.push("right") : this.rules.other.tableAlignCenter.test(a) ? s.align.push("center") : this.rules.other.tableAlignLeft.test(a) ? s.align.push("left") : s.align.push(null);
      for (let a = 0;a < n.length; a++)
        s.header.push({ text: n[a], tokens: this.lexer.inline(n[a]), header: true, align: s.align[a] });
      for (let a of i)
        s.rows.push(J(a, s.header.length).map((o, l) => ({ text: o, tokens: this.lexer.inline(o), header: false, align: s.align[l] })));
      return s;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t)
      return { type: "heading", raw: t[0], depth: t[2].charAt(0) === "=" ? 1 : 2, text: t[1], tokens: this.lexer.inline(t[1]) };
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
      return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t)
      return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t)
      return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t)
      return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
  }
  link(e) {
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let n = t[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(n)) {
        if (!this.rules.other.endAngleBracket.test(n))
          return;
        let s = z(n.slice(0, -1), "\\");
        if ((n.length - s.length) % 2 === 0)
          return;
      } else {
        let s = de(t[2], "()");
        if (s === -2)
          return;
        if (s > -1) {
          let o = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + s;
          t[2] = t[2].substring(0, s), t[0] = t[0].substring(0, o).trim(), t[3] = "";
        }
      }
      let r = t[2], i = "";
      if (this.options.pedantic) {
        let s = this.rules.other.pedanticHrefTitle.exec(r);
        s && (r = s[1], i = s[3]);
      } else
        i = t[3] ? t[3].slice(1, -1) : "";
      return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(n) ? r = r.slice(1) : r = r.slice(1, -1)), ge(t, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: i && i.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
    }
  }
  reflink(e, t) {
    let n;
    if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
      let r = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), i = t[r.toLowerCase()];
      if (!i) {
        let s = n[0].charAt(0);
        return { type: "text", raw: s, text: s };
      }
      return ge(n, i, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, n = "") {
    let r = this.rules.inline.emStrongLDelim.exec(e);
    if (!r || r[3] && n.match(this.rules.other.unicodeAlphaNumeric))
      return;
    if (!(r[1] || r[2] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let s = [...r[0]].length - 1, a, o, l = s, p = 0, c = r[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      for (c.lastIndex = 0, t = t.slice(-1 * e.length + s);(r = c.exec(t)) != null; ) {
        if (a = r[1] || r[2] || r[3] || r[4] || r[5] || r[6], !a)
          continue;
        if (o = [...a].length, r[3] || r[4]) {
          l += o;
          continue;
        } else if ((r[5] || r[6]) && s % 3 && !((s + o) % 3)) {
          p += o;
          continue;
        }
        if (l -= o, l > 0)
          continue;
        o = Math.min(o, o + l + p);
        let g = [...r[0]][0].length, h = e.slice(0, s + r.index + g + o);
        if (Math.min(s, o) % 2) {
          let f = h.slice(1, -1);
          return { type: "em", raw: h, text: f, tokens: this.lexer.inlineTokens(f) };
        }
        let R = h.slice(2, -2);
        return { type: "strong", raw: h, text: R, tokens: this.lexer.inlineTokens(R) };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), r = this.rules.other.nonSpaceChar.test(n), i = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
      return r && i && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t)
      return { type: "br", raw: t[0] };
  }
  del(e) {
    let t = this.rules.inline.del.exec(e);
    if (t)
      return { type: "del", raw: t[0], text: t[2], tokens: this.lexer.inlineTokens(t[2]) };
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let n, r;
      return t[2] === "@" ? (n = t[1], r = "mailto:" + n) : (n = t[1], r = n), { type: "link", raw: t[0], text: n, href: r, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  url(e) {
    let t;
    if (t = this.rules.inline.url.exec(e)) {
      let n, r;
      if (t[2] === "@")
        n = t[0], r = "mailto:" + n;
      else {
        let i;
        do
          i = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
        while (i !== t[0]);
        n = t[0], t[1] === "www." ? r = "http://" + t[0] : r = t[0];
      }
      return { type: "link", raw: t[0], text: n, href: r, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: t[0], escaped: n };
    }
  }
}, x = class u {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    this.tokens = [], this.tokens.links = Object.create(null), this.options = e || T, this.options.tokenizer = this.options.tokenizer || new y, this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, top: true };
    let t = { other: m, block: E.normal, inline: M.normal };
    this.options.pedantic ? (t.block = E.pedantic, t.inline = M.pedantic) : this.options.gfm && (t.block = E.gfm, this.options.breaks ? t.inline = M.breaks : t.inline = M.gfm), this.tokenizer.rules = t;
  }
  static get rules() {
    return { block: E, inline: M };
  }
  static lex(e, t) {
    return new u(t).lex(e);
  }
  static lexInline(e, t) {
    return new u(t).inlineTokens(e);
  }
  lex(e) {
    e = e.replace(m.carriageReturn, `
`), this.blockTokens(e, this.tokens);
    for (let t = 0;t < this.inlineQueue.length; t++) {
      let n = this.inlineQueue[t];
      this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e, t = [], n = false) {
    for (this.options.pedantic && (e = e.replace(m.tabCharGlobal, "    ").replace(m.spaceLine, ""));e; ) {
      let r;
      if (this.options.extensions?.block?.some((s) => (r = s.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false))
        continue;
      if (r = this.tokenizer.space(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        r.raw.length === 1 && s !== undefined ? s.raw += `
` : t.push(r);
        continue;
      }
      if (r = this.tokenizer.code(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.at(-1).src = s.text) : t.push(r);
        continue;
      }
      if (r = this.tokenizer.fences(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.heading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.hr(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.blockquote(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.list(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.html(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.def(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.raw, this.inlineQueue.at(-1).src = s.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
        continue;
      }
      if (r = this.tokenizer.table(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.lheading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      let i = e;
      if (this.options.extensions?.startBlock) {
        let s = 1 / 0, a = e.slice(1), o;
        this.options.extensions.startBlock.forEach((l) => {
          o = l.call({ lexer: this }, a), typeof o == "number" && o >= 0 && (s = Math.min(s, o));
        }), s < 1 / 0 && s >= 0 && (i = e.substring(0, s + 1));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(i))) {
        let s = t.at(-1);
        n && s?.type === "paragraph" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r), n = i.length !== e.length, e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r);
        continue;
      }
      if (e) {
        let s = "Infinite loop on byte: " + e.charCodeAt(0);
        if (this.options.silent) {
          console.error(s);
          break;
        } else
          throw new Error(s);
      }
    }
    return this.state.top = true, t;
  }
  inline(e, t = []) {
    return this.inlineQueue.push({ src: e, tokens: t }), t;
  }
  inlineTokens(e, t = []) {
    let n = e, r = null;
    if (this.tokens.links) {
      let o = Object.keys(this.tokens.links);
      if (o.length > 0)
        for (;(r = this.tokenizer.rules.inline.reflinkSearch.exec(n)) != null; )
          o.includes(r[0].slice(r[0].lastIndexOf("[") + 1, -1)) && (n = n.slice(0, r.index) + "[" + "a".repeat(r[0].length - 2) + "]" + n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex));
    }
    for (;(r = this.tokenizer.rules.inline.anyPunctuation.exec(n)) != null; )
      n = n.slice(0, r.index) + "++" + n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
    let i;
    for (;(r = this.tokenizer.rules.inline.blockSkip.exec(n)) != null; )
      i = r[2] ? r[2].length : 0, n = n.slice(0, r.index + i) + "[" + "a".repeat(r[0].length - i - 2) + "]" + n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
    n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
    let s = false, a = "";
    for (;e; ) {
      s || (a = ""), s = false;
      let o;
      if (this.options.extensions?.inline?.some((p) => (o = p.call({ lexer: this }, e, t)) ? (e = e.substring(o.raw.length), t.push(o), true) : false))
        continue;
      if (o = this.tokenizer.escape(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.tag(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.link(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(o.raw.length);
        let p = t.at(-1);
        o.type === "text" && p?.type === "text" ? (p.raw += o.raw, p.text += o.text) : t.push(o);
        continue;
      }
      if (o = this.tokenizer.emStrong(e, n, a)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.codespan(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.br(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.del(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.autolink(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (!this.state.inLink && (o = this.tokenizer.url(e))) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      let l = e;
      if (this.options.extensions?.startInline) {
        let p = 1 / 0, c = e.slice(1), g;
        this.options.extensions.startInline.forEach((h) => {
          g = h.call({ lexer: this }, c), typeof g == "number" && g >= 0 && (p = Math.min(p, g));
        }), p < 1 / 0 && p >= 0 && (l = e.substring(0, p + 1));
      }
      if (o = this.tokenizer.inlineText(l)) {
        e = e.substring(o.raw.length), o.raw.slice(-1) !== "_" && (a = o.raw.slice(-1)), s = true;
        let p = t.at(-1);
        p?.type === "text" ? (p.raw += o.raw, p.text += o.text) : t.push(o);
        continue;
      }
      if (e) {
        let p = "Infinite loop on byte: " + e.charCodeAt(0);
        if (this.options.silent) {
          console.error(p);
          break;
        } else
          throw new Error(p);
      }
    }
    return t;
  }
}, P = class {
  options;
  parser;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: n }) {
    let r = (t || "").match(m.notSpaceStart)?.[0], i = e.replace(m.endingNewline, "") + `
`;
    return r ? '<pre><code class="language-' + w(r) + '">' + (n ? i : w(i, true)) + `</code></pre>
` : "<pre><code>" + (n ? i : w(i, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let { ordered: t, start: n } = e, r = "";
    for (let a = 0;a < e.items.length; a++) {
      let o = e.items[a];
      r += this.listitem(o);
    }
    let i = t ? "ol" : "ul", s = t && n !== 1 ? ' start="' + n + '"' : "";
    return "<" + i + s + `>
` + r + "</" + i + `>
`;
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "", n = "";
    for (let i = 0;i < e.header.length; i++)
      n += this.tablecell(e.header[i]);
    t += this.tablerow({ text: n });
    let r = "";
    for (let i = 0;i < e.rows.length; i++) {
      let s = e.rows[i];
      n = "";
      for (let a = 0;a < s.length; a++)
        n += this.tablecell(s[a]);
      r += this.tablerow({ text: n });
    }
    return r && (r = `<tbody>${r}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + r + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
    return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${w(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, tokens: n }) {
    let r = this.parser.parseInline(n), i = X(e);
    if (i === null)
      return r;
    e = i;
    let s = '<a href="' + e + '"';
    return t && (s += ' title="' + w(t) + '"'), s += ">" + r + "</a>", s;
  }
  image({ href: e, title: t, text: n, tokens: r }) {
    r && (n = this.parser.parseInline(r, this.parser.textRenderer));
    let i = X(e);
    if (i === null)
      return w(n);
    e = i;
    let s = `<img src="${e}" alt="${n}"`;
    return t && (s += ` title="${w(t)}"`), s += ">", s;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : ("escaped" in e) && e.escaped ? e.text : w(e.text);
  }
}, $ = class {
  strong({ text: e }) {
    return e;
  }
  em({ text: e }) {
    return e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e }) {
    return e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e }) {
    return "" + e;
  }
  image({ text: e }) {
    return "" + e;
  }
  br() {
    return "";
  }
  checkbox({ raw: e }) {
    return e;
  }
}, b = class u2 {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    this.options = e || T, this.options.renderer = this.options.renderer || new P, this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new $;
  }
  static parse(e, t) {
    return new u2(t).parse(e);
  }
  static parseInline(e, t) {
    return new u2(t).parseInline(e);
  }
  parse(e) {
    let t = "";
    for (let n = 0;n < e.length; n++) {
      let r = e[n];
      if (this.options.extensions?.renderers?.[r.type]) {
        let s = r, a = this.options.extensions.renderers[s.type].call({ parser: this }, s);
        if (a !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "def", "paragraph", "text"].includes(s.type)) {
          t += a || "";
          continue;
        }
      }
      let i = r;
      switch (i.type) {
        case "space": {
          t += this.renderer.space(i);
          break;
        }
        case "hr": {
          t += this.renderer.hr(i);
          break;
        }
        case "heading": {
          t += this.renderer.heading(i);
          break;
        }
        case "code": {
          t += this.renderer.code(i);
          break;
        }
        case "table": {
          t += this.renderer.table(i);
          break;
        }
        case "blockquote": {
          t += this.renderer.blockquote(i);
          break;
        }
        case "list": {
          t += this.renderer.list(i);
          break;
        }
        case "checkbox": {
          t += this.renderer.checkbox(i);
          break;
        }
        case "html": {
          t += this.renderer.html(i);
          break;
        }
        case "def": {
          t += this.renderer.def(i);
          break;
        }
        case "paragraph": {
          t += this.renderer.paragraph(i);
          break;
        }
        case "text": {
          t += this.renderer.text(i);
          break;
        }
        default: {
          let s = 'Token with "' + i.type + '" type was not found.';
          if (this.options.silent)
            return console.error(s), "";
          throw new Error(s);
        }
      }
    }
    return t;
  }
  parseInline(e, t = this.renderer) {
    let n = "";
    for (let r = 0;r < e.length; r++) {
      let i = e[r];
      if (this.options.extensions?.renderers?.[i.type]) {
        let a = this.options.extensions.renderers[i.type].call({ parser: this }, i);
        if (a !== false || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(i.type)) {
          n += a || "";
          continue;
        }
      }
      let s = i;
      switch (s.type) {
        case "escape": {
          n += t.text(s);
          break;
        }
        case "html": {
          n += t.html(s);
          break;
        }
        case "link": {
          n += t.link(s);
          break;
        }
        case "image": {
          n += t.image(s);
          break;
        }
        case "checkbox": {
          n += t.checkbox(s);
          break;
        }
        case "strong": {
          n += t.strong(s);
          break;
        }
        case "em": {
          n += t.em(s);
          break;
        }
        case "codespan": {
          n += t.codespan(s);
          break;
        }
        case "br": {
          n += t.br(s);
          break;
        }
        case "del": {
          n += t.del(s);
          break;
        }
        case "text": {
          n += t.text(s);
          break;
        }
        default: {
          let a = 'Token with "' + s.type + '" type was not found.';
          if (this.options.silent)
            return console.error(a), "";
          throw new Error(a);
        }
      }
    }
    return n;
  }
}, S, B = class {
  defaults = L();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = b;
  Renderer = P;
  TextRenderer = $;
  Lexer = x;
  Tokenizer = y;
  Hooks = S;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t) {
    let n = [];
    for (let r of e)
      switch (n = n.concat(t.call(this, r)), r.type) {
        case "table": {
          let i = r;
          for (let s of i.header)
            n = n.concat(this.walkTokens(s.tokens, t));
          for (let s of i.rows)
            for (let a of s)
              n = n.concat(this.walkTokens(a.tokens, t));
          break;
        }
        case "list": {
          let i = r;
          n = n.concat(this.walkTokens(i.items, t));
          break;
        }
        default: {
          let i = r;
          this.defaults.extensions?.childTokens?.[i.type] ? this.defaults.extensions.childTokens[i.type].forEach((s) => {
            let a = i[s].flat(1 / 0);
            n = n.concat(this.walkTokens(a, t));
          }) : i.tokens && (n = n.concat(this.walkTokens(i.tokens, t)));
        }
      }
    return n;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return e.forEach((n) => {
      let r = { ...n };
      if (r.async = this.defaults.async || r.async || false, n.extensions && (n.extensions.forEach((i) => {
        if (!i.name)
          throw new Error("extension name required");
        if ("renderer" in i) {
          let s = t.renderers[i.name];
          s ? t.renderers[i.name] = function(...a) {
            let o = i.renderer.apply(this, a);
            return o === false && (o = s.apply(this, a)), o;
          } : t.renderers[i.name] = i.renderer;
        }
        if ("tokenizer" in i) {
          if (!i.level || i.level !== "block" && i.level !== "inline")
            throw new Error("extension level must be 'block' or 'inline'");
          let s = t[i.level];
          s ? s.unshift(i.tokenizer) : t[i.level] = [i.tokenizer], i.start && (i.level === "block" ? t.startBlock ? t.startBlock.push(i.start) : t.startBlock = [i.start] : i.level === "inline" && (t.startInline ? t.startInline.push(i.start) : t.startInline = [i.start]));
        }
        "childTokens" in i && i.childTokens && (t.childTokens[i.name] = i.childTokens);
      }), r.extensions = t), n.renderer) {
        let i = this.defaults.renderer || new P(this.defaults);
        for (let s in n.renderer) {
          if (!(s in i))
            throw new Error(`renderer '${s}' does not exist`);
          if (["options", "parser"].includes(s))
            continue;
          let a = s, o = n.renderer[a], l = i[a];
          i[a] = (...p) => {
            let c = o.apply(i, p);
            return c === false && (c = l.apply(i, p)), c || "";
          };
        }
        r.renderer = i;
      }
      if (n.tokenizer) {
        let i = this.defaults.tokenizer || new y(this.defaults);
        for (let s in n.tokenizer) {
          if (!(s in i))
            throw new Error(`tokenizer '${s}' does not exist`);
          if (["options", "rules", "lexer"].includes(s))
            continue;
          let a = s, o = n.tokenizer[a], l = i[a];
          i[a] = (...p) => {
            let c = o.apply(i, p);
            return c === false && (c = l.apply(i, p)), c;
          };
        }
        r.tokenizer = i;
      }
      if (n.hooks) {
        let i = this.defaults.hooks || new S;
        for (let s in n.hooks) {
          if (!(s in i))
            throw new Error(`hook '${s}' does not exist`);
          if (["options", "block"].includes(s))
            continue;
          let a = s, o = n.hooks[a], l = i[a];
          S.passThroughHooks.has(s) ? i[a] = (p) => {
            if (this.defaults.async && S.passThroughHooksRespectAsync.has(s))
              return (async () => {
                let g = await o.call(i, p);
                return l.call(i, g);
              })();
            let c = o.call(i, p);
            return l.call(i, c);
          } : i[a] = (...p) => {
            if (this.defaults.async)
              return (async () => {
                let g = await o.apply(i, p);
                return g === false && (g = await l.apply(i, p)), g;
              })();
            let c = o.apply(i, p);
            return c === false && (c = l.apply(i, p)), c;
          };
        }
        r.hooks = i;
      }
      if (n.walkTokens) {
        let i = this.defaults.walkTokens, s = n.walkTokens;
        r.walkTokens = function(a) {
          let o = [];
          return o.push(s.call(this, a)), i && (o = o.concat(i.call(this, a))), o;
        };
      }
      this.defaults = { ...this.defaults, ...r };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t) {
    return x.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return b.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, r) => {
      let i = { ...r }, s = { ...this.defaults, ...i }, a = this.onError(!!s.silent, !!s.async);
      if (this.defaults.async === true && i.async === false)
        return a(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n > "u" || n === null)
        return a(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string")
        return a(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
      if (s.hooks && (s.hooks.options = s, s.hooks.block = e), s.async)
        return (async () => {
          let o = s.hooks ? await s.hooks.preprocess(n) : n, p = await (s.hooks ? await s.hooks.provideLexer() : e ? x.lex : x.lexInline)(o, s), c = s.hooks ? await s.hooks.processAllTokens(p) : p;
          s.walkTokens && await Promise.all(this.walkTokens(c, s.walkTokens));
          let h = await (s.hooks ? await s.hooks.provideParser() : e ? b.parse : b.parseInline)(c, s);
          return s.hooks ? await s.hooks.postprocess(h) : h;
        })().catch(a);
      try {
        s.hooks && (n = s.hooks.preprocess(n));
        let l = (s.hooks ? s.hooks.provideLexer() : e ? x.lex : x.lexInline)(n, s);
        s.hooks && (l = s.hooks.processAllTokens(l)), s.walkTokens && this.walkTokens(l, s.walkTokens);
        let c = (s.hooks ? s.hooks.provideParser() : e ? b.parse : b.parseInline)(l, s);
        return s.hooks && (c = s.hooks.postprocess(c)), c;
      } catch (o) {
        return a(o);
      }
    };
  }
  onError(e, t) {
    return (n) => {
      if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let r = "<p>An error occurred:</p><pre>" + w(n.message + "", true) + "</pre>";
        return t ? Promise.resolve(r) : r;
      }
      if (t)
        return Promise.reject(n);
      throw n;
    };
  }
}, _, Dt, Ht, Zt, Gt, Nt, Ft, jt;
var init_marked_esm = __esm(() => {
  T = L();
  C = { exec: () => null };
  me = (() => {
    try {
      return !!new RegExp("(?<=1)(?<!1)");
    } catch {
      return false;
    }
  })();
  m = { codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceTabs: /^\t+/, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, unescapeTest: /&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/ig, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (u) => new RegExp(`^( {0,3}${u})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: (u) => new RegExp(`^ {0,${Math.min(3, u - 1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`), hrRegex: (u) => new RegExp(`^ {0,${Math.min(3, u - 1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`), fencesBeginRegex: (u) => new RegExp(`^ {0,${Math.min(3, u - 1)}}(?:\`\`\`|~~~)`), headingBeginRegex: (u) => new RegExp(`^ {0,${Math.min(3, u - 1)}}#`), htmlBeginRegex: (u) => new RegExp(`^ {0,${Math.min(3, u - 1)}}<(?:[a-z].*>|!--)`, "i") };
  xe = /^(?:[ \t]*(?:\n|$))+/;
  be = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
  Re = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
  I = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  Te = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
  N = /(?:[*+-]|\d{1,9}[.)])/;
  re = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
  se = k(re).replace(/bull/g, N).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
  Oe = k(re).replace(/bull/g, N).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
  Q = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/;
  we = /^[^\n]+/;
  F = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
  ye = k(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", F).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
  Pe = k(/^( {0,3}bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g, N).getRegex();
  j = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  Se = k("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i").replace("comment", j).replace("tag", v).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
  ie = k(Q).replace("hr", I).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", v).getRegex();
  $e = k(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", ie).getRegex();
  U = { blockquote: $e, code: be, def: ye, fences: Re, heading: Te, hr: I, html: Se, lheading: se, list: Pe, newline: xe, paragraph: ie, table: C, text: we };
  te = k("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", I).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}\t)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", v).getRegex();
  _e = { ...U, lheading: Oe, table: te, paragraph: k(Q).replace("hr", I).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", te).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", v).getRegex() };
  Le = { ...U, html: k(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", j).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: C, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: k(Q).replace("hr", I).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", se).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
  Me = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
  ze = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
  oe = /^( {2,}|\\)\n(?!\s*$)/;
  Ae = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
  D = /[\p{P}\p{S}]/u;
  K = /[\s\p{P}\p{S}]/u;
  ae = /[^\s\p{P}\p{S}]/u;
  Ce = k(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, K).getRegex();
  le = /(?!~)[\p{P}\p{S}]/u;
  Ie = /(?!~)[\s\p{P}\p{S}]/u;
  Ee = /(?:[^\s\p{P}\p{S}]|~)/u;
  Be = k(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", me ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
  ue = /^(?:\*+(?:((?!\*)punct)|[^\s*]))|^_+(?:((?!_)punct)|([^\s_]))/;
  qe = k(ue, "u").replace(/punct/g, D).getRegex();
  ve = k(ue, "u").replace(/punct/g, le).getRegex();
  De = k(pe, "gu").replace(/notPunctSpace/g, ae).replace(/punctSpace/g, K).replace(/punct/g, D).getRegex();
  He = k(pe, "gu").replace(/notPunctSpace/g, Ee).replace(/punctSpace/g, Ie).replace(/punct/g, le).getRegex();
  Ze = k("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, ae).replace(/punctSpace/g, K).replace(/punct/g, D).getRegex();
  Ge = k(/\\(punct)/, "gu").replace(/punct/g, D).getRegex();
  Ne = k(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
  Qe = k(j).replace("(?:-->|$)", "-->").getRegex();
  Fe = k("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", Qe).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
  q = /(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+[^`]*?`+(?!`)|[^\[\]\\`])*?/;
  je = k(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]*(?:\n[ \t]*)?)(title))?\s*\)/).replace("label", q).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
  ce = k(/^!?\[(label)\]\[(ref)\]/).replace("label", q).replace("ref", F).getRegex();
  he = k(/^!?\[(ref)\](?:\[\])?/).replace("ref", F).getRegex();
  Ue = k("reflink|nolink(?!\\()", "g").replace("reflink", ce).replace("nolink", he).getRegex();
  ne = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
  W = { _backpedal: C, anyPunctuation: Ge, autolink: Ne, blockSkip: Be, br: oe, code: ze, del: C, emStrongLDelim: qe, emStrongRDelimAst: De, emStrongRDelimUnd: Ze, escape: Me, link: je, nolink: he, punctuation: Ce, reflink: ce, reflinkSearch: Ue, tag: Fe, text: Ae, url: C };
  Ke = { ...W, link: k(/^!?\[(label)\]\((.*?)\)/).replace("label", q).getRegex(), reflink: k(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", q).getRegex() };
  G = { ...W, emStrongRDelimAst: He, emStrongLDelim: ve, url: k(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol", ne).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: k(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol", ne).getRegex() };
  We = { ...G, br: k(oe).replace("{2,}", "*").getRegex(), text: k(G.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
  E = { normal: U, gfm: _e, pedantic: Le };
  M = { normal: W, gfm: G, breaks: We, pedantic: Ke };
  Xe = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  S = class {
    options;
    block;
    constructor(e) {
      this.options = e || T;
    }
    static passThroughHooks = new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
    static passThroughHooksRespectAsync = new Set(["preprocess", "postprocess", "processAllTokens"]);
    preprocess(e) {
      return e;
    }
    postprocess(e) {
      return e;
    }
    processAllTokens(e) {
      return e;
    }
    emStrongMask(e) {
      return e;
    }
    provideLexer() {
      return this.block ? x.lex : x.lexInline;
    }
    provideParser() {
      return this.block ? b.parse : b.parseInline;
    }
  };
  _ = new B;
  d.options = d.setOptions = function(u3) {
    return _.setOptions(u3), d.defaults = _.defaults, Z(d.defaults), d;
  };
  d.getDefaults = L;
  d.defaults = T;
  d.use = function(...u3) {
    return _.use(...u3), d.defaults = _.defaults, Z(d.defaults), d;
  };
  d.walkTokens = function(u3, e) {
    return _.walkTokens(u3, e);
  };
  d.parseInline = _.parseInline;
  d.Parser = b;
  d.parser = b.parse;
  d.Renderer = P;
  d.TextRenderer = $;
  d.Lexer = x;
  d.lexer = x.lex;
  d.Tokenizer = y;
  d.Hooks = S;
  d.parse = d;
  Dt = d.options;
  Ht = d.setOptions;
  Zt = d.use;
  Gt = d.walkTokens;
  Nt = d.parseInline;
  Ft = b.parse;
  jt = x.lex;
});

// src/lib/stream-parser.ts
var exports_stream_parser = {};
__export(exports_stream_parser, {
  parseStreamDocument: () => parseStreamDocument,
  getStreamPreview: () => getStreamPreview
});
function extractTextFromTokens(tokens) {
  let text = "";
  for (const token of tokens) {
    if (token.type === "paragraph") {
      const para = token;
      text += para.text + `
`;
    } else if (token.type === "text") {
      const txt = token;
      text += txt.text + `
`;
    }
  }
  return text.trim();
}
function extractListItems(tokens) {
  const items = [];
  for (const token of tokens) {
    if (token.type === "list") {
      const list = token;
      for (const item of list.items) {
        items.push(item.text.trim());
      }
    }
  }
  return items;
}
function extractStreamName(tokens) {
  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token;
      if (heading.depth === 1) {
        const match = heading.text.match(/^Plan:\s*(.+)$/i);
        if (match) {
          return match[1].trim();
        }
      }
    }
  }
  return null;
}
function findSectionContent(tokens, sectionName) {
  const sectionTokens = [];
  let inSection = false;
  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token;
      if (heading.depth === 2) {
        if (heading.text.toLowerCase() === sectionName.toLowerCase()) {
          inSection = true;
          continue;
        } else if (inSection) {
          break;
        }
      }
    }
    if (inSection) {
      sectionTokens.push(token);
    }
  }
  return sectionTokens;
}
function extractSummary(tokens) {
  const sectionTokens = findSectionContent(tokens, "Summary");
  return extractTextFromTokens(sectionTokens);
}
function extractReferences(tokens) {
  const sectionTokens = findSectionContent(tokens, "References");
  return extractListItems(sectionTokens);
}
function parseStageHeading(text) {
  const match = text.match(/^Stage\s+(\d+):\s*(.*)$/i);
  if (match) {
    return {
      number: parseInt(match[1], 10),
      name: match[2].trim()
    };
  }
  return null;
}
function parseBatchHeading(text) {
  const match = text.match(/^Batch\s+(\d{1,2}):\s*(.*)$/i);
  if (match) {
    const num = parseInt(match[1], 10);
    return {
      number: num,
      prefix: num.toString().padStart(2, "0"),
      name: match[2].trim()
    };
  }
  return null;
}
function parseThreadHeading(text) {
  const match = text.match(/^Thread\s+(\d+):\s*(.*)$/i);
  if (match) {
    return {
      number: parseInt(match[1], 10),
      name: match[2].trim()
    };
  }
  return null;
}
function detectThreadSection(text) {
  const trimmed = text.trim().toLowerCase();
  if (/^\**summary/i.test(trimmed))
    return "summary";
  if (/^\**details/i.test(trimmed))
    return "details";
  return null;
}
function parseQuestions(items) {
  return items.map((item) => {
    const checkMatch = item.match(/^\[([x ])\]\s*(.*)$/im);
    if (checkMatch) {
      return {
        question: checkMatch[2].trim(),
        resolved: checkMatch[1].toLowerCase() === "x"
      };
    }
    const firstLine = item.split(`
`)[0].trim();
    return {
      question: firstLine,
      resolved: false
    };
  });
}
function parseStreamDocument(content, errors) {
  const lexer = new x;
  const tokens = lexer.lex(content);
  const streamName = extractStreamName(tokens);
  if (!streamName) {
    errors.push({
      section: "Header",
      message: 'Missing or invalid workstream name. Expected "# Plan: {name}"'
    });
    return null;
  }
  const summary = extractSummary(tokens);
  if (!summary) {
    errors.push({
      section: "Summary",
      message: "Missing or empty Summary section"
    });
  }
  const references = extractReferences(tokens);
  const stages = parseStages(tokens, errors);
  return {
    streamName,
    summary: summary || "",
    references,
    stages
  };
}
function parseStages(tokens, errors) {
  const stages = [];
  const stagesTokens = findSectionContent(tokens, "Stages");
  let currentStage = null;
  let state = {
    currentStage: null,
    currentSection: null,
    currentBatch: null,
    currentThread: null,
    currentThreadSection: null
  };
  let definitionBuffer = [];
  let constitutionBuffer = [];
  let questionsBuffer = [];
  let currentBatch = null;
  let batchSummaryBuffer = [];
  let currentThread = null;
  let threadSummaryBuffer = [];
  let threadDetailsBuffer = [];
  function saveCurrentThread() {
    if (currentThread && currentBatch) {
      currentThread.summary = threadSummaryBuffer.join(`
`).trim();
      currentThread.details = threadDetailsBuffer.join(`
`).trim();
      currentBatch.threads.push(currentThread);
    }
    currentThread = null;
    threadSummaryBuffer = [];
    threadDetailsBuffer = [];
  }
  function saveCurrentBatch() {
    if (currentBatch && currentStage) {
      saveCurrentThread();
      currentBatch.summary = batchSummaryBuffer.join(`
`).trim();
      currentStage.batches.push(currentBatch);
    }
    currentBatch = null;
    batchSummaryBuffer = [];
  }
  function saveCurrentStage() {
    if (currentStage) {
      currentStage.definition = definitionBuffer.join(`
`).trim();
      currentStage.constitution = constitutionBuffer.join(`
`).trim();
      currentStage.questions = parseQuestions(questionsBuffer);
      saveCurrentBatch();
      stages.push(currentStage);
    }
    currentStage = null;
    definitionBuffer = [];
    constitutionBuffer = [];
    questionsBuffer = [];
  }
  for (const token of stagesTokens) {
    if (token.type === "heading") {
      const heading = token;
      if (heading.depth === 3) {
        const stageInfo = parseStageHeading(heading.text);
        if (stageInfo) {
          saveCurrentStage();
          currentStage = {
            id: stageInfo.number,
            name: stageInfo.name,
            definition: "",
            constitution: "",
            questions: [],
            batches: []
          };
          state.currentStage = stageInfo.number;
          state.currentSection = null;
          state.currentBatch = null;
          state.currentThread = null;
        }
      }
      if (heading.depth === 4 && currentStage) {
        const lower = heading.text.toLowerCase();
        if (lower.includes("definition")) {
          state.currentSection = "definition";
        } else if (lower.includes("constitution")) {
          state.currentSection = "constitution";
        } else if (lower.includes("questions")) {
          state.currentSection = "questions";
        } else if (lower.includes("batches") || lower.includes("threads")) {
          state.currentSection = "batches";
          state.currentBatch = null;
          state.currentThread = null;
        } else {
          state.currentSection = null;
        }
      }
      if (heading.depth === 5 && state.currentSection === "batches") {
        const batchInfo = parseBatchHeading(heading.text);
        if (batchInfo && currentStage) {
          saveCurrentBatch();
          currentBatch = {
            id: batchInfo.number,
            prefix: batchInfo.prefix,
            name: batchInfo.name,
            summary: "",
            threads: []
          };
          state.currentBatch = batchInfo.number;
          state.currentThread = null;
          state.currentThreadSection = null;
          continue;
        }
      }
      if (heading.depth === 6 && state.currentSection === "batches" && currentBatch) {
        const threadInfo = parseThreadHeading(heading.text);
        if (threadInfo) {
          saveCurrentThread();
          currentThread = {
            id: threadInfo.number,
            name: threadInfo.name,
            summary: "",
            details: ""
          };
          state.currentThread = threadInfo.number;
          state.currentThreadSection = null;
        }
      }
      continue;
    }
    if (token.type === "paragraph") {
      const para = token;
      let text = para.text;
      if (state.currentSection === "constitution") {}
      if (state.currentSection === "batches" && currentThread) {
        const threadSection = detectThreadSection(text);
        if (threadSection) {
          state.currentThreadSection = threadSection;
          text = text.replace(/^\s*\**\s*(summary|details)\s*:?\s*\**\s*:?\s*/i, "").trim();
          if (!text) {
            continue;
          }
        }
      }
      if (state.currentSection === "definition") {
        if (!text.startsWith("<!--")) {
          definitionBuffer.push(text);
        }
      } else if (state.currentSection === "constitution") {
        if (!text.startsWith("<!--")) {
          constitutionBuffer.push(text);
        }
      } else if (state.currentSection === "batches" && currentBatch && !currentThread) {
        if (!text.startsWith("<!--")) {
          batchSummaryBuffer.push(text);
        }
      } else if (state.currentSection === "batches" && currentThread) {
        if (!text.startsWith("<!--")) {
          if (state.currentThreadSection === "summary") {
            threadSummaryBuffer.push(text);
          } else if (state.currentThreadSection === "details") {
            threadDetailsBuffer.push(text);
          }
        }
      }
    }
    if (token.type === "list") {
      const list = token;
      if (state.currentSection === "constitution") {
        const items = list.items.map((item) => item.text.trim());
        constitutionBuffer.push(...items.map((item) => `- ${item}`));
      } else if (state.currentSection === "questions") {
        const questionItems = list.items.map((item) => {
          if (item.task) {
            const prefix = item.checked ? "[x]" : "[ ]";
            return `${prefix} ${item.text.trim()}`;
          }
          return item.text.trim();
        });
        questionsBuffer.push(...questionItems);
      } else if (state.currentSection === "batches" && currentThread) {
        if (state.currentThreadSection === "details") {
          const items = list.items.map((item) => item.text.trim());
          threadDetailsBuffer.push(...items.map((item) => `- ${item}`));
        }
      }
    }
    if (token.type === "code" && state.currentSection === "batches" && currentThread) {
      if (state.currentThreadSection === "details") {
        const code = token;
        threadDetailsBuffer.push("```" + (code.lang || "") + `
` + code.text + "\n```");
      }
    }
  }
  saveCurrentStage();
  return stages;
}
function getStreamPreview(content) {
  const errors = [];
  const doc = parseStreamDocument(content, errors);
  if (!doc) {
    return {
      streamName: null,
      summary: "",
      stageCount: 0,
      stages: [],
      questionCounts: { open: 0, resolved: 0 }
    };
  }
  let openQuestions = 0;
  let resolvedQuestions = 0;
  const stages = doc.stages.map((stage) => {
    for (const q2 of stage.questions) {
      if (q2.resolved)
        resolvedQuestions++;
      else
        openQuestions++;
    }
    const totalThreads = stage.batches.reduce((sum, batch) => sum + batch.threads.length, 0);
    return {
      number: stage.id,
      name: stage.name,
      batchCount: stage.batches.length,
      threadCount: totalThreads,
      batches: stage.batches.map((batch) => ({
        number: batch.id,
        prefix: batch.prefix,
        name: batch.name,
        threadCount: batch.threads.length,
        threads: batch.threads.map((t) => ({
          number: t.id,
          name: t.name
        }))
      }))
    };
  });
  return {
    streamName: doc.streamName,
    summary: doc.summary.slice(0, 200) + (doc.summary.length > 200 ? "..." : ""),
    stageCount: doc.stages.length,
    stages,
    questionCounts: { open: openQuestions, resolved: resolvedQuestions }
  };
}
var init_stream_parser = __esm(() => {
  init_marked_esm();
});

// src/lib/threads.ts
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "fs";
import { join as join4 } from "path";
function getThreadsFilePath(repoRoot, streamId) {
  const workDir = getWorkDir(repoRoot);
  return join4(workDir, streamId, "threads.json");
}
function createEmptyThreadsFile(streamId) {
  return {
    version: THREADS_FILE_VERSION,
    stream_id: streamId,
    last_updated: new Date().toISOString(),
    threads: []
  };
}
function loadThreads(repoRoot, streamId) {
  const filePath = getThreadsFilePath(repoRoot, streamId);
  if (!existsSync4(filePath)) {
    return null;
  }
  const content = readFileSync3(filePath, "utf-8");
  return JSON.parse(content);
}
function saveThreads(repoRoot, streamId, threadsFile) {
  const filePath = getThreadsFilePath(repoRoot, streamId);
  threadsFile.last_updated = new Date().toISOString();
  atomicWriteFile(filePath, JSON.stringify(threadsFile, null, 2));
}
function getThreadMetadata(repoRoot, streamId, threadId) {
  const threadsFile = loadThreads(repoRoot, streamId);
  if (!threadsFile)
    return null;
  return threadsFile.threads.find((t) => t.threadId === threadId) || null;
}
function updateThreadMetadata(repoRoot, streamId, threadId, data) {
  let threadsFile = loadThreads(repoRoot, streamId);
  if (!threadsFile) {
    threadsFile = createEmptyThreadsFile(streamId);
  }
  const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === threadId);
  if (threadIndex === -1) {
    const newThread = {
      threadId,
      sessions: data.sessions || [],
      ...data.currentSessionId && { currentSessionId: data.currentSessionId },
      ...data.opencodeSessionId && { opencodeSessionId: data.opencodeSessionId }
    };
    threadsFile.threads.push(newThread);
    saveThreads(repoRoot, streamId, threadsFile);
    return newThread;
  }
  const thread = threadsFile.threads[threadIndex];
  if (data.sessions !== undefined)
    thread.sessions = data.sessions;
  if (data.currentSessionId !== undefined)
    thread.currentSessionId = data.currentSessionId;
  if (data.opencodeSessionId !== undefined)
    thread.opencodeSessionId = data.opencodeSessionId;
  saveThreads(repoRoot, streamId, threadsFile);
  return thread;
}
async function withThreadsLock(threadsPath, fn) {
  if (!existsSync4(threadsPath)) {
    atomicWriteFile(threadsPath, JSON.stringify(createEmptyThreadsFile(""), null, 2));
  }
  const release = await lockfile2.lock(threadsPath, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 }
  });
  try {
    return fn();
  } finally {
    await release();
  }
}
async function updateThreadMetadataLocked(repoRoot, streamId, threadId, data) {
  const filePath = getThreadsFilePath(repoRoot, streamId);
  return withThreadsLock(filePath, () => {
    return updateThreadMetadata(repoRoot, streamId, threadId, data);
  });
}
function startThreadSession(repoRoot, streamId, threadId, agentName, model, sessionId) {
  const session = {
    sessionId,
    agentName,
    model,
    startedAt: new Date().toISOString(),
    status: "running"
  };
  let threadsFile = loadThreads(repoRoot, streamId);
  if (!threadsFile) {
    threadsFile = createEmptyThreadsFile(streamId);
  }
  const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === threadId);
  if (threadIndex === -1) {
    threadsFile.threads.push({
      threadId,
      sessions: [session],
      currentSessionId: sessionId
    });
  } else {
    threadsFile.threads[threadIndex].sessions.push(session);
    threadsFile.threads[threadIndex].currentSessionId = sessionId;
  }
  saveThreads(repoRoot, streamId, threadsFile);
  return session;
}
function completeThreadSession(repoRoot, streamId, threadId, sessionId, status, exitCode) {
  const threadsFile = loadThreads(repoRoot, streamId);
  if (!threadsFile)
    return null;
  const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === threadId);
  if (threadIndex === -1)
    return null;
  const thread = threadsFile.threads[threadIndex];
  const sessionIndex = thread.sessions.findIndex((s) => s.sessionId === sessionId);
  if (sessionIndex === -1)
    return null;
  const session = thread.sessions[sessionIndex];
  session.status = status;
  session.completedAt = new Date().toISOString();
  if (exitCode !== undefined) {
    session.exitCode = exitCode;
  }
  thread.currentSessionId = undefined;
  saveThreads(repoRoot, streamId, threadsFile);
  return session;
}
async function startMultipleThreadSessionsLocked(repoRoot, streamId, sessions) {
  const filePath = getThreadsFilePath(repoRoot, streamId);
  return withThreadsLock(filePath, () => {
    let threadsFile = loadThreads(repoRoot, streamId);
    if (!threadsFile) {
      threadsFile = createEmptyThreadsFile(streamId);
    }
    const createdSessions = [];
    const now = new Date().toISOString();
    for (const sessionInfo of sessions) {
      const session = {
        sessionId: sessionInfo.sessionId,
        agentName: sessionInfo.agentName,
        model: sessionInfo.model,
        startedAt: now,
        status: "running"
      };
      const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === sessionInfo.threadId);
      if (threadIndex === -1) {
        threadsFile.threads.push({
          threadId: sessionInfo.threadId,
          sessions: [session],
          currentSessionId: sessionInfo.sessionId
        });
      } else {
        threadsFile.threads[threadIndex].sessions.push(session);
        threadsFile.threads[threadIndex].currentSessionId = sessionInfo.sessionId;
      }
      createdSessions.push(session);
    }
    saveThreads(repoRoot, streamId, threadsFile);
    return createdSessions;
  });
}
async function completeMultipleThreadSessionsLocked(repoRoot, streamId, completions) {
  const filePath = getThreadsFilePath(repoRoot, streamId);
  return withThreadsLock(filePath, () => {
    const threadsFile = loadThreads(repoRoot, streamId);
    if (!threadsFile)
      return [];
    const updatedSessions = [];
    const now = new Date().toISOString();
    for (const completion of completions) {
      const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === completion.threadId);
      if (threadIndex === -1)
        continue;
      const thread = threadsFile.threads[threadIndex];
      const sessionIndex = thread.sessions.findIndex((s) => s.sessionId === completion.sessionId);
      if (sessionIndex === -1)
        continue;
      const session = thread.sessions[sessionIndex];
      session.status = completion.status;
      session.completedAt = now;
      if (completion.exitCode !== undefined) {
        session.exitCode = completion.exitCode;
      }
      thread.currentSessionId = undefined;
      updatedSessions.push(session);
    }
    if (updatedSessions.length > 0) {
      saveThreads(repoRoot, streamId, threadsFile);
    }
    return updatedSessions;
  });
}
async function setSynthesisOutput(repoRoot, streamId, threadId, synthesis) {
  const filePath = getThreadsFilePath(repoRoot, streamId);
  await withThreadsLock(filePath, () => {
    let threadsFile = loadThreads(repoRoot, streamId);
    if (!threadsFile) {
      threadsFile = createEmptyThreadsFile(streamId);
    }
    const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === threadId);
    if (threadIndex === -1) {
      console.warn(`[threads] setSynthesisOutput: Thread ${threadId} not found in stream ${streamId}`);
      return;
    }
    threadsFile.threads[threadIndex].synthesis = synthesis;
    saveThreads(repoRoot, streamId, threadsFile);
  });
}
function getLastSessionForThread(repoRoot, streamId, threadId) {
  const thread = getThreadMetadata(repoRoot, streamId, threadId);
  if (!thread || thread.sessions.length === 0) {
    return null;
  }
  const sortedSessions = [...thread.sessions].sort((a, b2) => new Date(b2.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sortedSessions[0] || null;
}
function getOpencodeSessionId(repoRoot, streamId, threadId) {
  const thread = getThreadMetadata(repoRoot, streamId, threadId);
  return thread?.opencodeSessionId || null;
}
function getWorkingAgentSessionId(repoRoot, streamId, threadId) {
  const thread = getThreadMetadata(repoRoot, streamId, threadId);
  return thread?.workingAgentSessionId || null;
}
function extractThreadIdFromTaskId(taskId) {
  const parts = taskId.split(".");
  if (parts.length !== 4)
    return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}
function migrateFromTasksJson(repoRoot, streamId, tasksFile) {
  const result = {
    threadsCreated: 0,
    sessionsMigrated: 0,
    errors: []
  };
  let threadsFile = loadThreads(repoRoot, streamId);
  if (!threadsFile) {
    threadsFile = createEmptyThreadsFile(streamId);
  }
  const threadMap = new Map;
  for (const thread of threadsFile.threads) {
    threadMap.set(thread.threadId, thread);
  }
  const tasksByThread = new Map;
  for (const task of tasksFile.tasks) {
    const threadId = extractThreadIdFromTaskId(task.id);
    if (!threadId) {
      result.errors.push(`Invalid task ID format: ${task.id}`);
      continue;
    }
    if (!tasksByThread.has(threadId)) {
      tasksByThread.set(threadId, []);
    }
    tasksByThread.get(threadId).push(task);
  }
  for (const [threadId, tasks] of tasksByThread) {
    let thread = threadMap.get(threadId);
    const isNew = !thread;
    if (!thread) {
      thread = {
        threadId,
        sessions: []
      };
      threadMap.set(threadId, thread);
      result.threadsCreated++;
    }
    for (const task of tasks) {
      if (task.sessions && task.sessions.length > 0) {
        const existingSessionIds = new Set(thread.sessions.map((s) => s.sessionId));
        for (const session of task.sessions) {
          if (!existingSessionIds.has(session.sessionId)) {
            thread.sessions.push(session);
            result.sessionsMigrated++;
          }
        }
      }
      if (!thread.currentSessionId && task.currentSessionId) {
        thread.currentSessionId = task.currentSessionId;
      }
    }
  }
  threadsFile.threads = Array.from(threadMap.values()).sort((a, b2) => a.threadId.localeCompare(b2.threadId, undefined, { numeric: true }));
  saveThreads(repoRoot, streamId, threadsFile);
  return result;
}
var lockfile2, THREADS_FILE_VERSION = "1.0.0";
var init_threads = __esm(() => {
  init_lib();
  init_repo();
  lockfile2 = __toESM(require_proper_lockfile(), 1);
});

// src/lib/tasks.ts
import { existsSync as existsSync5, readFileSync as readFileSync4, copyFileSync } from "fs";
import { join as join5 } from "path";
function getTasksFilePath(repoRoot, streamId) {
  const workDir = getWorkDir(repoRoot);
  return join5(workDir, streamId, "tasks.json");
}
function createEmptyTasksFile(streamId) {
  return {
    version: TASKS_FILE_VERSION,
    stream_id: streamId,
    last_updated: new Date().toISOString(),
    tasks: []
  };
}
function hasSessionsInTasksJson(tasksFile) {
  return tasksFile.tasks.some((task) => task.sessions && task.sessions.length > 0 || task.currentSessionId);
}
function createTasksJsonBackup(repoRoot, streamId) {
  const filePath = getTasksFilePath(repoRoot, streamId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = filePath.replace(".json", `.backup-${timestamp}.json`);
  copyFileSync(filePath, backupPath);
  return backupPath;
}
function clearSessionsFromTasks(tasksFile) {
  return {
    ...tasksFile,
    tasks: tasksFile.tasks.map((task) => ({
      ...task,
      sessions: undefined,
      currentSessionId: undefined
    }))
  };
}
function migrateSessionsToThreads(repoRoot, streamId, tasksFile) {
  try {
    if (!hasSessionsInTasksJson(tasksFile)) {
      return { migrated: false };
    }
    const backupPath = createTasksJsonBackup(repoRoot, streamId);
    const result = migrateFromTasksJson(repoRoot, streamId, tasksFile);
    if (result.errors.length > 0) {
      return {
        migrated: false,
        backupPath,
        error: `Migration errors: ${result.errors.join(", ")}`
      };
    }
    const cleanedTasksFile = clearSessionsFromTasks(tasksFile);
    writeTasksFile(repoRoot, streamId, cleanedTasksFile);
    return { migrated: true, backupPath };
  } catch (err) {
    return {
      migrated: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
function extractThreadIdFromTaskId2(taskId) {
  const parts = taskId.split(".");
  if (parts.length !== 4) {
    throw new Error(`Invalid task ID format: ${taskId}. Expected "SS.BB.TT.NN"`);
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}
function generateSessionId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ses_${timestamp}_${random}`;
}
function startTaskSession(repoRoot, streamId, taskId, agentName, model) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return null;
  const taskIndex = tasksFile.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1)
    return null;
  const threadId = extractThreadIdFromTaskId2(taskId);
  const sessionId = generateSessionId();
  return startThreadSession(repoRoot, streamId, threadId, agentName, model, sessionId);
}
function completeTaskSession(repoRoot, streamId, taskId, sessionId, status, exitCode) {
  const threadId = extractThreadIdFromTaskId2(taskId);
  return completeThreadSession(repoRoot, streamId, threadId, sessionId, status, exitCode);
}
async function startMultipleSessionsLocked(repoRoot, streamId, sessions) {
  const filePath = getTasksFilePath(repoRoot, streamId);
  if (!existsSync5(filePath))
    return [];
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return [];
  const threadSessions = [];
  for (const sessionInfo of sessions) {
    const taskIndex = tasksFile.tasks.findIndex((t) => t.id === sessionInfo.taskId);
    if (taskIndex === -1)
      continue;
    const threadId = extractThreadIdFromTaskId2(sessionInfo.taskId);
    threadSessions.push({
      threadId,
      agentName: sessionInfo.agentName,
      model: sessionInfo.model,
      sessionId: sessionInfo.sessionId
    });
  }
  if (threadSessions.length === 0)
    return [];
  return startMultipleThreadSessionsLocked(repoRoot, streamId, threadSessions);
}
async function completeMultipleSessionsLocked(repoRoot, streamId, completions) {
  if (completions.length === 0)
    return [];
  const threadCompletions = completions.map((completion) => ({
    threadId: extractThreadIdFromTaskId2(completion.taskId),
    sessionId: completion.sessionId,
    status: completion.status,
    exitCode: completion.exitCode
  }));
  return completeMultipleThreadSessionsLocked(repoRoot, streamId, threadCompletions);
}
function readTasksFile(repoRoot, streamId) {
  const filePath = getTasksFilePath(repoRoot, streamId);
  if (!existsSync5(filePath)) {
    return null;
  }
  const content = readFileSync4(filePath, "utf-8");
  let tasksFile = JSON.parse(content);
  if (hasSessionsInTasksJson(tasksFile)) {
    console.warn(`\x1B[33mWarning: Deprecated session data found in tasks.json for stream ${streamId}.\x1B[0m`);
    console.warn(`\x1B[33mAuto-migrating sessions to threads.json and clearing from tasks.json...\x1B[0m`);
    const migrationResult = migrateSessionsToThreads(repoRoot, streamId, tasksFile);
    if (migrationResult.migrated) {
      const cleanedContent = readFileSync4(filePath, "utf-8");
      tasksFile = JSON.parse(cleanedContent);
    }
  }
  return tasksFile;
}
function writeTasksFile(repoRoot, streamId, tasksFile) {
  const filePath = getTasksFilePath(repoRoot, streamId);
  tasksFile.last_updated = new Date().toISOString();
  atomicWriteFile(filePath, JSON.stringify(tasksFile, null, 2));
}
function getTaskById(repoRoot, streamId, taskId) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return null;
  return tasksFile.tasks.find((t) => t.id === taskId) || null;
}
function getTasks(repoRoot, streamId, status) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return [];
  if (status) {
    return tasksFile.tasks.filter((t) => t.status === status);
  }
  return tasksFile.tasks;
}
function updateTaskStatus(repoRoot, streamId, taskId, optionsOrStatus, legacyBreadcrumb) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return null;
  const taskIndex = tasksFile.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1)
    return null;
  const task = tasksFile.tasks[taskIndex];
  let opts;
  if (typeof optionsOrStatus === "string") {
    opts = { status: optionsOrStatus, breadcrumb: legacyBreadcrumb };
  } else {
    opts = optionsOrStatus;
  }
  if (opts.status)
    task.status = opts.status;
  if (opts.breadcrumb)
    task.breadcrumb = opts.breadcrumb;
  if (opts.report)
    task.report = opts.report;
  if (opts.assigned_agent)
    task.assigned_agent = opts.assigned_agent;
  task.updated_at = new Date().toISOString();
  writeTasksFile(repoRoot, streamId, tasksFile);
  return task;
}
function addTasks(repoRoot, streamId, newTasks) {
  let tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile) {
    tasksFile = createEmptyTasksFile(streamId);
  }
  const existingTasksMap = new Map(tasksFile.tasks.map((t) => [t.id, t]));
  for (const newTask of newTasks) {
    const existing = existingTasksMap.get(newTask.id);
    if (existing) {
      existingTasksMap.set(newTask.id, {
        ...newTask,
        status: existing.status,
        created_at: existing.created_at,
        updated_at: existing.updated_at,
        sessions: existing.sessions,
        currentSessionId: existing.currentSessionId
      });
    } else {
      existingTasksMap.set(newTask.id, newTask);
    }
  }
  tasksFile.tasks = Array.from(existingTasksMap.values()).sort((a, b2) => a.id.localeCompare(b2.id, undefined, { numeric: true }));
  writeTasksFile(repoRoot, streamId, tasksFile);
  return tasksFile;
}
function getTaskCounts(repoRoot, streamId) {
  const tasks = getTasks(repoRoot, streamId);
  return {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    in_progress: tasks.filter((t) => t.status === "in_progress").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    cancelled: tasks.filter((t) => t.status === "cancelled").length
  };
}
function sortTasksById(tasks) {
  tasks.sort((a, b2) => {
    const aParts = a.id.split(".").map(Number);
    const bParts = b2.id.split(".").map(Number);
    for (let i = 0;i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] ?? 0;
      const bVal = bParts[i] ?? 0;
      if (aVal !== bVal)
        return aVal - bVal;
    }
    return 0;
  });
}
function groupTasks(tasks, options = {}) {
  const { byBatch = true } = options;
  if (byBatch) {
    const grouped = new Map;
    for (const task of tasks) {
      if (!grouped.has(task.stage_name)) {
        grouped.set(task.stage_name, new Map);
      }
      const stageMap = grouped.get(task.stage_name);
      const batchName = task.batch_name || "Batch 01";
      if (!stageMap.has(batchName)) {
        stageMap.set(batchName, new Map);
      }
      const batchMap = stageMap.get(batchName);
      if (!batchMap.has(task.thread_name)) {
        batchMap.set(task.thread_name, []);
      }
      batchMap.get(task.thread_name).push(task);
    }
    for (const stageMap of grouped.values()) {
      for (const batchMap of stageMap.values()) {
        for (const threadTasks of batchMap.values()) {
          sortTasksById(threadTasks);
        }
      }
    }
    return grouped;
  } else {
    const grouped = new Map;
    for (const task of tasks) {
      if (!grouped.has(task.stage_name)) {
        grouped.set(task.stage_name, new Map);
      }
      const stageMap = grouped.get(task.stage_name);
      if (!stageMap.has(task.thread_name)) {
        stageMap.set(task.thread_name, []);
      }
      stageMap.get(task.thread_name).push(task);
    }
    for (const stageMap of grouped.values()) {
      for (const threadTasks of stageMap.values()) {
        sortTasksById(threadTasks);
      }
    }
    return grouped;
  }
}
function discoverThreadsInBatch(repoRoot, streamId, stageNum, batchNum) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return null;
  const stageStr = stageNum.toString().padStart(2, "0");
  const batchStr = batchNum.toString().padStart(2, "0");
  const batchPrefix = `${stageStr}.${batchStr}.`;
  const threadMap = new Map;
  for (const task of tasksFile.tasks) {
    if (!task.id.startsWith(batchPrefix))
      continue;
    try {
      const parsed = parseTaskId(task.id);
      const threadId = formatThreadId(parsed.stage, parsed.batch, parsed.thread);
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, []);
      }
      threadMap.get(threadId).push(task);
    } catch {}
  }
  const threads = [];
  for (const [threadId, tasks] of threadMap) {
    tasks.sort((a, b2) => a.id.localeCompare(b2.id, undefined, { numeric: true }));
    const firstTask = tasks[0];
    const parsed = parseTaskId(firstTask.id);
    threads.push({
      threadId,
      threadNum: parsed.thread,
      threadName: firstTask.thread_name,
      stageName: firstTask.stage_name,
      batchName: firstTask.batch_name,
      stageNum: parsed.stage,
      batchNum: parsed.batch,
      firstTaskId: firstTask.id,
      assignedAgent: firstTask.assigned_agent,
      taskCount: tasks.length
    });
  }
  threads.sort((a, b2) => a.threadNum - b2.threadNum);
  return threads;
}
function getBatchMetadata(repoRoot, streamId, stageNum, batchNum) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return null;
  const stageStr = stageNum.toString().padStart(2, "0");
  const batchStr = batchNum.toString().padStart(2, "0");
  const batchPrefix = `${stageStr}.${batchStr}.`;
  const firstTask = tasksFile.tasks.find((t) => t.id.startsWith(batchPrefix));
  if (!firstTask)
    return null;
  return {
    stageName: firstTask.stage_name,
    batchName: firstTask.batch_name
  };
}
function parseTaskId(taskId) {
  const parts = taskId.split(".");
  if (parts.length === 4) {
    const parsed = parts.map((p) => parseInt(p, 10));
    if (parsed.every((n) => !isNaN(n))) {
      return {
        stage: parsed[0],
        batch: parsed[1],
        thread: parsed[2],
        task: parsed[3]
      };
    }
  }
  throw new Error(`Invalid task ID format: ${taskId}. Expected "stage.batch.thread.task" (e.g., "01.01.02.03")`);
}
function formatTaskId(stage, batch, thread, task) {
  const stageStr = stage.toString().padStart(2, "0");
  const batchStr = batch.toString().padStart(2, "0");
  const threadStr = thread.toString().padStart(2, "0");
  const taskStr = task.toString().padStart(2, "0");
  return `${stageStr}.${batchStr}.${threadStr}.${taskStr}`;
}
function parseThreadId(threadId) {
  const parts = threadId.split(".");
  if (parts.length === 3) {
    const parsed = parts.map((p) => parseInt(p, 10));
    if (parsed.every((n) => !isNaN(n))) {
      return {
        stage: parsed[0],
        batch: parsed[1],
        thread: parsed[2]
      };
    }
  }
  throw new Error(`Invalid thread ID format: ${threadId}. Expected "stage.batch.thread" (e.g., "01.01.02")`);
}
function formatThreadId(stage, batch, thread) {
  const stageStr = stage.toString().padStart(2, "0");
  const batchStr = batch.toString().padStart(2, "0");
  const threadStr = thread.toString().padStart(2, "0");
  return `${stageStr}.${batchStr}.${threadStr}`;
}
function getTasksByThread(repoRoot, streamId, stageNumber, batchNumber, threadNumber) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return [];
  const stageStr = stageNumber.toString().padStart(2, "0");
  const batchStr = batchNumber.toString().padStart(2, "0");
  const threadStr = threadNumber.toString().padStart(2, "0");
  const threadPrefix = `${stageStr}.${batchStr}.${threadStr}.`;
  return tasksFile.tasks.filter((t) => t.id.startsWith(threadPrefix));
}
function updateTasksByThread(repoRoot, streamId, stageNumber, batchNumber, threadNumber, options) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return [];
  const stageStr = stageNumber.toString().padStart(2, "0");
  const batchStr = batchNumber.toString().padStart(2, "0");
  const threadStr = threadNumber.toString().padStart(2, "0");
  const threadPrefix = `${stageStr}.${batchStr}.${threadStr}.`;
  const updatedTasks = [];
  const now = new Date().toISOString();
  for (const task of tasksFile.tasks) {
    if (task.id.startsWith(threadPrefix)) {
      if (options.status)
        task.status = options.status;
      if (options.breadcrumb)
        task.breadcrumb = options.breadcrumb;
      if (options.report)
        task.report = options.report;
      if (options.assigned_agent)
        task.assigned_agent = options.assigned_agent;
      task.updated_at = now;
      updatedTasks.push(task);
    }
  }
  if (updatedTasks.length > 0) {
    writeTasksFile(repoRoot, streamId, tasksFile);
  }
  return updatedTasks;
}
function deleteTask(repoRoot, streamId, taskId) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return null;
  const taskIndex = tasksFile.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1)
    return null;
  const [deletedTask] = tasksFile.tasks.splice(taskIndex, 1);
  writeTasksFile(repoRoot, streamId, tasksFile);
  return deletedTask;
}
function deleteTasksByStage(repoRoot, streamId, stageNumber) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return [];
  const stagePrefix = `${stageNumber.toString().padStart(2, "0")}.`;
  const deletedTasks = [];
  tasksFile.tasks = tasksFile.tasks.filter((t) => {
    if (t.id.startsWith(stagePrefix)) {
      deletedTasks.push(t);
      return false;
    }
    return true;
  });
  if (deletedTasks.length > 0) {
    writeTasksFile(repoRoot, streamId, tasksFile);
  }
  return deletedTasks;
}
function deleteTasksByThread(repoRoot, streamId, stageNumber, batchNumber, threadNumber) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return [];
  const batchStr = batchNumber.toString().padStart(2, "0");
  const stageStr = stageNumber.toString().padStart(2, "0");
  const threadPrefix = `${stageStr}.${batchStr}.${threadNumber}.`;
  const deletedTasks = [];
  tasksFile.tasks = tasksFile.tasks.filter((t) => {
    if (t.id.startsWith(threadPrefix)) {
      deletedTasks.push(t);
      return false;
    }
    return true;
  });
  if (deletedTasks.length > 0) {
    writeTasksFile(repoRoot, streamId, tasksFile);
  }
  return deletedTasks;
}
function deleteTasksByBatch(repoRoot, streamId, stageNumber, batchNumber) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return [];
  const batchStr = batchNumber.toString().padStart(2, "0");
  const stageStr = stageNumber.toString().padStart(2, "0");
  const batchPrefix = `${stageStr}.${batchStr}.`;
  const deletedTasks = [];
  tasksFile.tasks = tasksFile.tasks.filter((t) => {
    if (t.id.startsWith(batchPrefix)) {
      deletedTasks.push(t);
      return false;
    }
    return true;
  });
  if (deletedTasks.length > 0) {
    writeTasksFile(repoRoot, streamId, tasksFile);
  }
  return deletedTasks;
}
var TASKS_FILE_VERSION = "1.0.0";
var init_tasks = __esm(() => {
  init_lib();
  init_repo();
  init_threads();
});

// src/lib/tasks-md.ts
var exports_tasks_md = {};
__export(exports_tasks_md, {
  serializeTasksMd: () => serializeTasksMd,
  parseTasksMd: () => parseTasksMd,
  generateTasksMdFromTasks: () => generateTasksMdFromTasks,
  generateTasksMdFromPlan: () => generateTasksMdFromPlan,
  generateTasksMdForRevision: () => generateTasksMdForRevision,
  detectNewStages: () => detectNewStages
});
function detectNewStages(doc, existingTasks) {
  const stagesWithTasks = new Set;
  for (const task of existingTasks) {
    try {
      const { stage } = parseTaskId(task.id);
      stagesWithTasks.add(stage);
    } catch {}
  }
  const allStageIds = doc.stages.map((stage) => stage.id);
  const newStages = allStageIds.filter((stageId) => !stagesWithTasks.has(stageId));
  return newStages.sort((a, b2) => a - b2);
}
function generateTasksMdFromPlan(streamName, doc) {
  const lines = [];
  lines.push(`# Tasks: ${streamName}`);
  lines.push("");
  for (const stage of doc.stages) {
    const stageIdPadded = stage.id.toString().padStart(2, "0");
    lines.push(`## Stage ${stageIdPadded}: ${stage.name}`);
    lines.push("");
    for (const batch of stage.batches) {
      lines.push(`### Batch ${batch.prefix}: ${batch.name}`);
      lines.push("");
      for (const thread of batch.threads) {
        const threadIdPadded = thread.id.toString().padStart(2, "0");
        lines.push(`#### Thread ${threadIdPadded}: ${thread.name} @agent:`);
        const taskId = formatTaskId(stage.id, batch.id, thread.id, 1);
        lines.push(`- [ ] Task ${taskId}: `);
        lines.push("");
      }
    }
  }
  return lines.join(`
`);
}
function generateTasksMdFromTasks(streamName, tasks) {
  const lines = [];
  lines.push(`# Tasks: ${streamName}`);
  lines.push("");
  const tasksByStage = new Map;
  const stageNames = new Map;
  const batchNames = new Map;
  const threadNames = new Map;
  const threadAgents = new Map;
  for (const task of tasks) {
    try {
      const { stage, batch, thread } = parseTaskId(task.id);
      if (!tasksByStage.has(stage)) {
        tasksByStage.set(stage, new Map);
        stageNames.set(stage, task.stage_name);
      }
      const batches = tasksByStage.get(stage);
      const batchKey = batch.toString().padStart(2, "0");
      if (!batches.has(batchKey)) {
        batches.set(batchKey, new Map);
        batchNames.set(batchKey, task.batch_name);
      }
      const threads = batches.get(batchKey);
      const threadKey = `${stage}.${batchKey}.${thread}`;
      if (!threads.has(thread)) {
        threads.set(thread, []);
        threadNames.set(threadKey, task.thread_name);
        threadAgents.set(threadKey, task.assigned_agent);
      }
      threads.get(thread).push(task);
    } catch (e) {
      continue;
    }
  }
  const sortedStages = Array.from(tasksByStage.keys()).sort((a, b2) => a - b2);
  for (const stageId of sortedStages) {
    const batches = tasksByStage.get(stageId);
    const stageIdPadded = stageId.toString().padStart(2, "0");
    const stageName = stageNames.get(stageId) || `Stage ${stageIdPadded}`;
    lines.push(`## Stage ${stageIdPadded}: ${stageName}`);
    lines.push("");
    const sortedBatches = Array.from(batches.keys()).sort();
    for (const batchKey of sortedBatches) {
      const threads = batches.get(batchKey);
      const batchName = batchNames.get(batchKey) || `Batch ${batchKey}`;
      lines.push(`### Batch ${batchKey}: ${batchName}`);
      lines.push("");
      const sortedThreads = Array.from(threads.keys()).sort((a, b2) => a - b2);
      for (const threadId of sortedThreads) {
        const threadTasks = threads.get(threadId);
        threadTasks.sort((a, b2) => a.id.localeCompare(b2.id, undefined, { numeric: true }));
        const threadKey = `${stageId}.${batchKey}.${threadId}`;
        const threadName = threadNames.get(threadKey) || `Thread ${threadId}`;
        const threadIdPadded = threadId.toString().padStart(2, "0");
        const agentAssignment = threadAgents.get(threadKey);
        const agentSuffix = agentAssignment ? ` @agent:${agentAssignment}` : "";
        lines.push(`#### Thread ${threadIdPadded}: ${threadName}${agentSuffix}`);
        for (const task of threadTasks) {
          const check = task.status === "completed" ? "x" : task.status === "in_progress" ? "~" : task.status === "blocked" ? "!" : task.status === "cancelled" ? "-" : " ";
          lines.push(`- [${check}] Task ${task.id}: ${task.name}`);
          if (task.report) {
            lines.push(`  > Report: ${task.report}`);
          }
        }
        lines.push("");
      }
    }
  }
  return lines.join(`
`);
}
function generateTasksMdForRevision(streamName, existingTasks, doc, newStageNumbers) {
  const lines = [];
  const newStageSet = new Set(newStageNumbers);
  lines.push(`# Tasks: ${streamName}`);
  lines.push("");
  const tasksByStage = new Map;
  for (const task of existingTasks) {
    try {
      const { stage } = parseTaskId(task.id);
      if (!tasksByStage.has(stage)) {
        tasksByStage.set(stage, []);
      }
      tasksByStage.get(stage).push(task);
    } catch {}
  }
  for (const stage of doc.stages) {
    const stageIdPadded = stage.id.toString().padStart(2, "0");
    lines.push(`## Stage ${stageIdPadded}: ${stage.name}`);
    lines.push("");
    if (newStageSet.has(stage.id)) {
      for (const batch of stage.batches) {
        lines.push(`### Batch ${batch.prefix}: ${batch.name}`);
        lines.push("");
        for (const thread of batch.threads) {
          const threadIdPadded = thread.id.toString().padStart(2, "0");
          lines.push(`#### Thread ${threadIdPadded}: ${thread.name} @agent:`);
          const taskId = formatTaskId(stage.id, batch.id, thread.id, 1);
          lines.push(`- [ ] Task ${taskId}: `);
          lines.push("");
        }
      }
    } else {
      const stageTasks = tasksByStage.get(stage.id) || [];
      const tasksByBatch = new Map;
      const batchNames = new Map;
      const threadNames = new Map;
      const threadAgents = new Map;
      for (const task of stageTasks) {
        try {
          const { batch, thread } = parseTaskId(task.id);
          if (!tasksByBatch.has(batch)) {
            tasksByBatch.set(batch, new Map);
            batchNames.set(batch, task.batch_name);
          }
          const threads = tasksByBatch.get(batch);
          const threadKey = `${batch}.${thread}`;
          if (!threads.has(thread)) {
            threads.set(thread, []);
            threadNames.set(threadKey, task.thread_name);
            threadAgents.set(threadKey, task.assigned_agent);
          }
          threads.get(thread).push(task);
        } catch {}
      }
      const sortedBatches = Array.from(tasksByBatch.keys()).sort((a, b2) => a - b2);
      for (const batchId of sortedBatches) {
        const threads = tasksByBatch.get(batchId);
        const batchKey = batchId.toString().padStart(2, "0");
        const batchName = batchNames.get(batchId) || `Batch ${batchKey}`;
        lines.push(`### Batch ${batchKey}: ${batchName}`);
        lines.push("");
        const sortedThreads = Array.from(threads.keys()).sort((a, b2) => a - b2);
        for (const threadId of sortedThreads) {
          const threadTasks = threads.get(threadId);
          threadTasks.sort((a, b2) => a.id.localeCompare(b2.id, undefined, { numeric: true }));
          const threadKey = `${batchId}.${threadId}`;
          const threadName = threadNames.get(threadKey) || `Thread ${threadId}`;
          const threadIdPadded = threadId.toString().padStart(2, "0");
          const agentAssignment = threadAgents.get(threadKey);
          const agentSuffix = agentAssignment ? ` @agent:${agentAssignment}` : "";
          lines.push(`#### Thread ${threadIdPadded}: ${threadName}${agentSuffix}`);
          for (const task of threadTasks) {
            const check = task.status === "completed" ? "x" : task.status === "in_progress" ? "~" : task.status === "blocked" ? "!" : task.status === "cancelled" ? "-" : " ";
            lines.push(`- [${check}] Task ${task.id}: ${task.name}`);
            if (task.report) {
              lines.push(`  > Report: ${task.report}`);
            }
          }
          lines.push("");
        }
      }
    }
  }
  return lines.join(`
`);
}
function parseTasksMd(content, streamId) {
  const lexer = new x;
  const tokens = lexer.lex(content);
  const tasks = [];
  const errors = [];
  let currentStage = null;
  let currentBatch = null;
  let currentThread = null;
  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token;
      if (heading.depth === 2) {
        const match = heading.text.match(/^Stage\s+(\d+):\s*(.*)$/i);
        if (match) {
          currentStage = {
            id: parseInt(match[1], 10),
            name: match[2].trim()
          };
          currentBatch = null;
          currentThread = null;
        } else {}
      } else if (heading.depth === 3 && currentStage) {
        const match = heading.text.match(/^Batch\s+(\d{1,2}):\s*(.*)$/i);
        if (match) {
          currentBatch = {
            id: parseInt(match[1], 10),
            name: match[2].trim()
          };
          currentThread = null;
        }
      } else if (heading.depth === 4 && currentStage && currentBatch) {
        const match = heading.text.match(THREAD_HEADER_REGEX);
        if (match) {
          currentThread = {
            id: parseInt(match[1], 10),
            name: match[2].trim(),
            assigned_agent: match[3] || undefined
          };
        }
      }
    }
    if (token.type === "list" && currentStage && currentBatch && currentThread) {
      const list = token;
      for (const item of list.items) {
        let text = item.text;
        let statusChar = "";
        if (item.task) {
          statusChar = item.checked ? "x" : " ";
        } else {
          const checkMatch = text.match(/^\s*\[([xX~!\-\s])\]\s+(.*)$/);
          if (checkMatch && checkMatch[1]) {
            statusChar = checkMatch[1].toLowerCase();
            text = checkMatch[2];
          } else {
            continue;
          }
        }
        if (text) {
          let report;
          const reportMatch = text.match(/>\s*Report:\s*(.*)/i);
          if (reportMatch) {
            report = reportMatch[1].trim();
            text = text.replace(/>\s*Report:\s*.*$/i, "").trim();
          }
          const contentMatch = text.match(/^\s*(?:Task\s+([\d\.]+):\s*)?([^\n]*)/i);
          if (contentMatch) {
            const idString = contentMatch[1];
            const description = contentMatch[2]?.trim();
            if (description) {
              const status = statusChar === "x" ? "completed" : statusChar === "~" ? "in_progress" : statusChar === "!" ? "blocked" : statusChar === "-" ? "cancelled" : "pending";
              let taskId = idString;
              if (taskId) {
                try {
                  const parsed = parseTaskId(taskId);
                  if (parsed.stage !== currentStage.id || parsed.batch !== currentBatch.id || parsed.thread !== currentThread.id) {
                    errors.push(`Task ID ${taskId} does not match hierarchy (Stage ${currentStage.id}, Batch ${currentBatch.id}, Thread ${currentThread.id})`);
                    continue;
                  }
                } catch (e) {
                  errors.push(`Invalid task ID format: ${taskId}`);
                  continue;
                }
              } else {
                errors.push(`Task missing ID: "${description}". Format should be "- [ ] Task 01.01.01.01: Description"`);
                continue;
              }
              const now = new Date().toISOString();
              const task = {
                id: taskId,
                name: description,
                stage_name: currentStage.name,
                batch_name: currentBatch.name,
                thread_name: currentThread.name,
                status,
                created_at: now,
                updated_at: now,
                report,
                assigned_agent: currentThread.assigned_agent
              };
              tasks.push(task);
            }
          }
        }
      }
    }
  }
  return { tasks, errors };
}
function serializeTasksMd(content, tasks) {
  const lexer = new x;
  const tokens = lexer.lex(content);
  const threadAgents = new Map;
  let currentStage = null;
  let currentBatch = null;
  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token;
      if (heading.depth === 2) {
        const match = heading.text.match(/^Stage\s+(\d+):/i);
        if (match) {
          currentStage = parseInt(match[1], 10);
          currentBatch = null;
        }
      } else if (heading.depth === 3 && currentStage !== null) {
        const match = heading.text.match(/^Batch\s+(\d{1,2}):/i);
        if (match) {
          currentBatch = parseInt(match[1], 10);
        }
      } else if (heading.depth === 4 && currentStage !== null && currentBatch !== null) {
        const match = heading.text.match(THREAD_HEADER_REGEX);
        if (match && match[3]) {
          const threadId = parseInt(match[1], 10);
          const agentName = match[3];
          const stageKey = currentStage.toString().padStart(2, "0");
          const batchKey = currentBatch.toString().padStart(2, "0");
          const threadKey = threadId.toString().padStart(2, "0");
          const fullKey = `${stageKey}.${batchKey}.${threadKey}`;
          threadAgents.set(fullKey, agentName);
        }
      }
    }
  }
  return tasks.map((task) => {
    try {
      const { stage, batch, thread } = parseTaskId(task.id);
      const stageKey = stage.toString().padStart(2, "0");
      const batchKey = batch.toString().padStart(2, "0");
      const threadKey = thread.toString().padStart(2, "0");
      const fullKey = `${stageKey}.${batchKey}.${threadKey}`;
      const agentName = threadAgents.get(fullKey);
      if (agentName) {
        return { ...task, assigned_agent: agentName };
      }
      return task;
    } catch {
      return task;
    }
  });
}
var THREAD_HEADER_REGEX;
var init_tasks_md = __esm(() => {
  init_marked_esm();
  init_tasks();
  THREAD_HEADER_REGEX = /^Thread\s+(\d+):\s*([^@]*?)(?:\s+@agent:([a-zA-Z0-9_-]*))?\s*$/i;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS((exports) => {
  var ALIAS = Symbol.for("yaml.alias");
  var DOC = Symbol.for("yaml.document");
  var MAP = Symbol.for("yaml.map");
  var PAIR = Symbol.for("yaml.pair");
  var SCALAR = Symbol.for("yaml.scalar");
  var SEQ = Symbol.for("yaml.seq");
  var NODE_TYPE = Symbol.for("yaml.node.type");
  var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
  var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
  var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
  var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
  var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
  var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
  function isCollection(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case MAP:
        case SEQ:
          return true;
      }
    return false;
  }
  function isNode(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case ALIAS:
        case MAP:
        case SCALAR:
        case SEQ:
          return true;
      }
    return false;
  }
  var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
  exports.ALIAS = ALIAS;
  exports.DOC = DOC;
  exports.MAP = MAP;
  exports.NODE_TYPE = NODE_TYPE;
  exports.PAIR = PAIR;
  exports.SCALAR = SCALAR;
  exports.SEQ = SEQ;
  exports.hasAnchor = hasAnchor;
  exports.isAlias = isAlias;
  exports.isCollection = isCollection;
  exports.isDocument = isDocument;
  exports.isMap = isMap;
  exports.isNode = isNode;
  exports.isPair = isPair;
  exports.isScalar = isScalar;
  exports.isSeq = isSeq;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/visit.js
var require_visit = __commonJS((exports) => {
  var identity = require_identity();
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove node");
  function visit(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      visit_(null, node, visitor_, Object.freeze([]));
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  function visit_(key, node, visitor, path) {
    const ctrl = callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visit_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = visit_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = visit_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = visit_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  async function visitAsync(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      await visitAsync_(null, node, visitor_, Object.freeze([]));
  }
  visitAsync.BREAK = BREAK;
  visitAsync.SKIP = SKIP;
  visitAsync.REMOVE = REMOVE;
  async function visitAsync_(key, node, visitor, path) {
    const ctrl = await callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visitAsync_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = await visitAsync_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = await visitAsync_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = await visitAsync_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  function initVisitor(visitor) {
    if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
      return Object.assign({
        Alias: visitor.Node,
        Map: visitor.Node,
        Scalar: visitor.Node,
        Seq: visitor.Node
      }, visitor.Value && {
        Map: visitor.Value,
        Scalar: visitor.Value,
        Seq: visitor.Value
      }, visitor.Collection && {
        Map: visitor.Collection,
        Seq: visitor.Collection
      }, visitor);
    }
    return visitor;
  }
  function callVisitor(key, node, visitor, path) {
    if (typeof visitor === "function")
      return visitor(key, node, path);
    if (identity.isMap(node))
      return visitor.Map?.(key, node, path);
    if (identity.isSeq(node))
      return visitor.Seq?.(key, node, path);
    if (identity.isPair(node))
      return visitor.Pair?.(key, node, path);
    if (identity.isScalar(node))
      return visitor.Scalar?.(key, node, path);
    if (identity.isAlias(node))
      return visitor.Alias?.(key, node, path);
    return;
  }
  function replaceNode(key, path, node) {
    const parent = path[path.length - 1];
    if (identity.isCollection(parent)) {
      parent.items[key] = node;
    } else if (identity.isPair(parent)) {
      if (key === "key")
        parent.key = node;
      else
        parent.value = node;
    } else if (identity.isDocument(parent)) {
      parent.contents = node;
    } else {
      const pt = identity.isAlias(parent) ? "alias" : "scalar";
      throw new Error(`Cannot replace node with ${pt} parent`);
    }
  }
  exports.visit = visit;
  exports.visitAsync = visitAsync;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS((exports) => {
  var identity = require_identity();
  var visit = require_visit();
  var escapeChars = {
    "!": "%21",
    ",": "%2C",
    "[": "%5B",
    "]": "%5D",
    "{": "%7B",
    "}": "%7D"
  };
  var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);

  class Directives {
    constructor(yaml, tags) {
      this.docStart = null;
      this.docEnd = false;
      this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
      this.tags = Object.assign({}, Directives.defaultTags, tags);
    }
    clone() {
      const copy = new Directives(this.yaml, this.tags);
      copy.docStart = this.docStart;
      return copy;
    }
    atDocument() {
      const res = new Directives(this.yaml, this.tags);
      switch (this.yaml.version) {
        case "1.1":
          this.atNextDocument = true;
          break;
        case "1.2":
          this.atNextDocument = false;
          this.yaml = {
            explicit: Directives.defaultYaml.explicit,
            version: "1.2"
          };
          this.tags = Object.assign({}, Directives.defaultTags);
          break;
      }
      return res;
    }
    add(line, onError) {
      if (this.atNextDocument) {
        this.yaml = { explicit: Directives.defaultYaml.explicit, version: "1.1" };
        this.tags = Object.assign({}, Directives.defaultTags);
        this.atNextDocument = false;
      }
      const parts = line.trim().split(/[ \t]+/);
      const name = parts.shift();
      switch (name) {
        case "%TAG": {
          if (parts.length !== 2) {
            onError(0, "%TAG directive should contain exactly two parts");
            if (parts.length < 2)
              return false;
          }
          const [handle, prefix] = parts;
          this.tags[handle] = prefix;
          return true;
        }
        case "%YAML": {
          this.yaml.explicit = true;
          if (parts.length !== 1) {
            onError(0, "%YAML directive should contain exactly one part");
            return false;
          }
          const [version] = parts;
          if (version === "1.1" || version === "1.2") {
            this.yaml.version = version;
            return true;
          } else {
            const isValid = /^\d+\.\d+$/.test(version);
            onError(6, `Unsupported YAML version ${version}`, isValid);
            return false;
          }
        }
        default:
          onError(0, `Unknown directive ${name}`, true);
          return false;
      }
    }
    tagName(source, onError) {
      if (source === "!")
        return "!";
      if (source[0] !== "!") {
        onError(`Not a valid tag: ${source}`);
        return null;
      }
      if (source[1] === "<") {
        const verbatim = source.slice(2, -1);
        if (verbatim === "!" || verbatim === "!!") {
          onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
          return null;
        }
        if (source[source.length - 1] !== ">")
          onError("Verbatim tags must end with a >");
        return verbatim;
      }
      const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
      if (!suffix)
        onError(`The ${source} tag has no suffix`);
      const prefix = this.tags[handle];
      if (prefix) {
        try {
          return prefix + decodeURIComponent(suffix);
        } catch (error) {
          onError(String(error));
          return null;
        }
      }
      if (handle === "!")
        return source;
      onError(`Could not resolve tag: ${source}`);
      return null;
    }
    tagString(tag) {
      for (const [handle, prefix] of Object.entries(this.tags)) {
        if (tag.startsWith(prefix))
          return handle + escapeTagName(tag.substring(prefix.length));
      }
      return tag[0] === "!" ? tag : `!<${tag}>`;
    }
    toString(doc) {
      const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
      const tagEntries = Object.entries(this.tags);
      let tagNames;
      if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
        const tags = {};
        visit.visit(doc.contents, (_key, node) => {
          if (identity.isNode(node) && node.tag)
            tags[node.tag] = true;
        });
        tagNames = Object.keys(tags);
      } else
        tagNames = [];
      for (const [handle, prefix] of tagEntries) {
        if (handle === "!!" && prefix === "tag:yaml.org,2002:")
          continue;
        if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
          lines.push(`%TAG ${handle} ${prefix}`);
      }
      return lines.join(`
`);
    }
  }
  Directives.defaultYaml = { explicit: false, version: "1.2" };
  Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
  exports.Directives = Directives;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS((exports) => {
  var identity = require_identity();
  var visit = require_visit();
  function anchorIsValid(anchor) {
    if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
      const sa = JSON.stringify(anchor);
      const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
      throw new Error(msg);
    }
    return true;
  }
  function anchorNames(root) {
    const anchors = new Set;
    visit.visit(root, {
      Value(_key, node) {
        if (node.anchor)
          anchors.add(node.anchor);
      }
    });
    return anchors;
  }
  function findNewAnchor(prefix, exclude) {
    for (let i = 1;; ++i) {
      const name = `${prefix}${i}`;
      if (!exclude.has(name))
        return name;
    }
  }
  function createNodeAnchors(doc, prefix) {
    const aliasObjects = [];
    const sourceObjects = new Map;
    let prevAnchors = null;
    return {
      onAnchor: (source) => {
        aliasObjects.push(source);
        prevAnchors ?? (prevAnchors = anchorNames(doc));
        const anchor = findNewAnchor(prefix, prevAnchors);
        prevAnchors.add(anchor);
        return anchor;
      },
      setAnchors: () => {
        for (const source of aliasObjects) {
          const ref = sourceObjects.get(source);
          if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
            ref.node.anchor = ref.anchor;
          } else {
            const error = new Error("Failed to resolve repeated object (this should not happen)");
            error.source = source;
            throw error;
          }
        }
      },
      sourceObjects
    };
  }
  exports.anchorIsValid = anchorIsValid;
  exports.anchorNames = anchorNames;
  exports.createNodeAnchors = createNodeAnchors;
  exports.findNewAnchor = findNewAnchor;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS((exports) => {
  function applyReviver(reviver, obj, key, val) {
    if (val && typeof val === "object") {
      if (Array.isArray(val)) {
        for (let i = 0, len = val.length;i < len; ++i) {
          const v0 = val[i];
          const v1 = applyReviver(reviver, val, String(i), v0);
          if (v1 === undefined)
            delete val[i];
          else if (v1 !== v0)
            val[i] = v1;
        }
      } else if (val instanceof Map) {
        for (const k2 of Array.from(val.keys())) {
          const v0 = val.get(k2);
          const v1 = applyReviver(reviver, val, k2, v0);
          if (v1 === undefined)
            val.delete(k2);
          else if (v1 !== v0)
            val.set(k2, v1);
        }
      } else if (val instanceof Set) {
        for (const v0 of Array.from(val)) {
          const v1 = applyReviver(reviver, val, v0, v0);
          if (v1 === undefined)
            val.delete(v0);
          else if (v1 !== v0) {
            val.delete(v0);
            val.add(v1);
          }
        }
      } else {
        for (const [k2, v0] of Object.entries(val)) {
          const v1 = applyReviver(reviver, val, k2, v0);
          if (v1 === undefined)
            delete val[k2];
          else if (v1 !== v0)
            val[k2] = v1;
        }
      }
    }
    return reviver.call(obj, key, val);
  }
  exports.applyReviver = applyReviver;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS((exports) => {
  var identity = require_identity();
  function toJS(value, arg, ctx) {
    if (Array.isArray(value))
      return value.map((v2, i) => toJS(v2, String(i), ctx));
    if (value && typeof value.toJSON === "function") {
      if (!ctx || !identity.hasAnchor(value))
        return value.toJSON(arg, ctx);
      const data = { aliasCount: 0, count: 1, res: undefined };
      ctx.anchors.set(value, data);
      ctx.onCreate = (res2) => {
        data.res = res2;
        delete ctx.onCreate;
      };
      const res = value.toJSON(arg, ctx);
      if (ctx.onCreate)
        ctx.onCreate(res);
      return res;
    }
    if (typeof value === "bigint" && !ctx?.keep)
      return Number(value);
    return value;
  }
  exports.toJS = toJS;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS((exports) => {
  var applyReviver = require_applyReviver();
  var identity = require_identity();
  var toJS = require_toJS();

  class NodeBase {
    constructor(type) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: type });
    }
    clone() {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      if (!identity.isDocument(doc))
        throw new TypeError("A document argument is required");
      const ctx = {
        anchors: new Map,
        doc,
        keep: true,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this, "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
  }
  exports.NodeBase = NodeBase;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS((exports) => {
  var anchors = require_anchors();
  var visit = require_visit();
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();

  class Alias extends Node.NodeBase {
    constructor(source) {
      super(identity.ALIAS);
      this.source = source;
      Object.defineProperty(this, "tag", {
        set() {
          throw new Error("Alias nodes cannot have tags");
        }
      });
    }
    resolve(doc, ctx) {
      let nodes;
      if (ctx?.aliasResolveCache) {
        nodes = ctx.aliasResolveCache;
      } else {
        nodes = [];
        visit.visit(doc, {
          Node: (_key, node) => {
            if (identity.isAlias(node) || identity.hasAnchor(node))
              nodes.push(node);
          }
        });
        if (ctx)
          ctx.aliasResolveCache = nodes;
      }
      let found = undefined;
      for (const node of nodes) {
        if (node === this)
          break;
        if (node.anchor === this.source)
          found = node;
      }
      return found;
    }
    toJSON(_arg, ctx) {
      if (!ctx)
        return { source: this.source };
      const { anchors: anchors2, doc, maxAliasCount } = ctx;
      const source = this.resolve(doc, ctx);
      if (!source) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new ReferenceError(msg);
      }
      let data = anchors2.get(source);
      if (!data) {
        toJS.toJS(source, null, ctx);
        data = anchors2.get(source);
      }
      if (data?.res === undefined) {
        const msg = "This should not happen: Alias anchor was not resolved?";
        throw new ReferenceError(msg);
      }
      if (maxAliasCount >= 0) {
        data.count += 1;
        if (data.aliasCount === 0)
          data.aliasCount = getAliasCount(doc, source, anchors2);
        if (data.count * data.aliasCount > maxAliasCount) {
          const msg = "Excessive alias count indicates a resource exhaustion attack";
          throw new ReferenceError(msg);
        }
      }
      return data.res;
    }
    toString(ctx, _onComment, _onChompKeep) {
      const src = `*${this.source}`;
      if (ctx) {
        anchors.anchorIsValid(this.source);
        if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new Error(msg);
        }
        if (ctx.implicitKey)
          return `${src} `;
      }
      return src;
    }
  }
  function getAliasCount(doc, node, anchors2) {
    if (identity.isAlias(node)) {
      const source = node.resolve(doc);
      const anchor = anchors2 && source && anchors2.get(source);
      return anchor ? anchor.count * anchor.aliasCount : 0;
    } else if (identity.isCollection(node)) {
      let count = 0;
      for (const item of node.items) {
        const c = getAliasCount(doc, item, anchors2);
        if (c > count)
          count = c;
      }
      return count;
    } else if (identity.isPair(node)) {
      const kc = getAliasCount(doc, node.key, anchors2);
      const vc = getAliasCount(doc, node.value, anchors2);
      return Math.max(kc, vc);
    }
    return 1;
  }
  exports.Alias = Alias;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS((exports) => {
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();
  var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";

  class Scalar extends Node.NodeBase {
    constructor(value) {
      super(identity.SCALAR);
      this.value = value;
    }
    toJSON(arg, ctx) {
      return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
    }
    toString() {
      return String(this.value);
    }
  }
  Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
  Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
  Scalar.PLAIN = "PLAIN";
  Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
  Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
  exports.Scalar = Scalar;
  exports.isScalarValue = isScalarValue;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS((exports) => {
  var Alias = require_Alias();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var defaultTagPrefix = "tag:yaml.org,2002:";
  function findTagObject(value, tagName, tags) {
    if (tagName) {
      const match = tags.filter((t) => t.tag === tagName);
      const tagObj = match.find((t) => !t.format) ?? match[0];
      if (!tagObj)
        throw new Error(`Tag ${tagName} not found`);
      return tagObj;
    }
    return tags.find((t) => t.identify?.(value) && !t.format);
  }
  function createNode(value, tagName, ctx) {
    if (identity.isDocument(value))
      value = value.contents;
    if (identity.isNode(value))
      return value;
    if (identity.isPair(value)) {
      const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
      map.items.push(value);
      return map;
    }
    if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
      value = value.valueOf();
    }
    const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
    let ref = undefined;
    if (aliasDuplicateObjects && value && typeof value === "object") {
      ref = sourceObjects.get(value);
      if (ref) {
        ref.anchor ?? (ref.anchor = onAnchor(value));
        return new Alias.Alias(ref.anchor);
      } else {
        ref = { anchor: null, node: null };
        sourceObjects.set(value, ref);
      }
    }
    if (tagName?.startsWith("!!"))
      tagName = defaultTagPrefix + tagName.slice(2);
    let tagObj = findTagObject(value, tagName, schema.tags);
    if (!tagObj) {
      if (value && typeof value.toJSON === "function") {
        value = value.toJSON();
      }
      if (!value || typeof value !== "object") {
        const node2 = new Scalar.Scalar(value);
        if (ref)
          ref.node = node2;
        return node2;
      }
      tagObj = value instanceof Map ? schema[identity.MAP] : (Symbol.iterator in Object(value)) ? schema[identity.SEQ] : schema[identity.MAP];
    }
    if (onTagObj) {
      onTagObj(tagObj);
      delete ctx.onTagObj;
    }
    const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
    if (tagName)
      node.tag = tagName;
    else if (!tagObj.default)
      node.tag = tagObj.tag;
    if (ref)
      ref.node = node;
    return node;
  }
  exports.createNode = createNode;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS((exports) => {
  var createNode = require_createNode();
  var identity = require_identity();
  var Node = require_Node();
  function collectionFromPath(schema, path, value) {
    let v2 = value;
    for (let i = path.length - 1;i >= 0; --i) {
      const k2 = path[i];
      if (typeof k2 === "number" && Number.isInteger(k2) && k2 >= 0) {
        const a = [];
        a[k2] = v2;
        v2 = a;
      } else {
        v2 = new Map([[k2, v2]]);
      }
    }
    return createNode.createNode(v2, undefined, {
      aliasDuplicateObjects: false,
      keepUndefined: false,
      onAnchor: () => {
        throw new Error("This should not happen, please report a bug.");
      },
      schema,
      sourceObjects: new Map
    });
  }
  var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;

  class Collection extends Node.NodeBase {
    constructor(type, schema) {
      super(type);
      Object.defineProperty(this, "schema", {
        value: schema,
        configurable: true,
        enumerable: false,
        writable: true
      });
    }
    clone(schema) {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (schema)
        copy.schema = schema;
      copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    addIn(path, value) {
      if (isEmptyPath(path))
        this.add(value);
      else {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.addIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
    deleteIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.delete(key);
      const node = this.get(key, true);
      if (identity.isCollection(node))
        return node.deleteIn(rest);
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
    getIn(path, keepScalar) {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (rest.length === 0)
        return !keepScalar && identity.isScalar(node) ? node.value : node;
      else
        return identity.isCollection(node) ? node.getIn(rest, keepScalar) : undefined;
    }
    hasAllNullValues(allowScalar) {
      return this.items.every((node) => {
        if (!identity.isPair(node))
          return false;
        const n = node.value;
        return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
      });
    }
    hasIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.has(key);
      const node = this.get(key, true);
      return identity.isCollection(node) ? node.hasIn(rest) : false;
    }
    setIn(path, value) {
      const [key, ...rest] = path;
      if (rest.length === 0) {
        this.set(key, value);
      } else {
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.setIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
  }
  exports.Collection = Collection;
  exports.collectionFromPath = collectionFromPath;
  exports.isEmptyPath = isEmptyPath;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS((exports) => {
  var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
  function indentComment(comment, indent) {
    if (/^\n+$/.test(comment))
      return comment.substring(1);
    return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
  }
  var lineComment = (str, indent, comment) => str.endsWith(`
`) ? indentComment(comment, indent) : comment.includes(`
`) ? `
` + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
  exports.indentComment = indentComment;
  exports.lineComment = lineComment;
  exports.stringifyComment = stringifyComment;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS((exports) => {
  var FOLD_FLOW = "flow";
  var FOLD_BLOCK = "block";
  var FOLD_QUOTED = "quoted";
  function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
    if (!lineWidth || lineWidth < 0)
      return text;
    if (lineWidth < minContentWidth)
      minContentWidth = 0;
    const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
    if (text.length <= endStep)
      return text;
    const folds = [];
    const escapedFolds = {};
    let end = lineWidth - indent.length;
    if (typeof indentAtStart === "number") {
      if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
        folds.push(0);
      else
        end = lineWidth - indentAtStart;
    }
    let split = undefined;
    let prev = undefined;
    let overflow = false;
    let i = -1;
    let escStart = -1;
    let escEnd = -1;
    if (mode === FOLD_BLOCK) {
      i = consumeMoreIndentedLines(text, i, indent.length);
      if (i !== -1)
        end = i + endStep;
    }
    for (let ch;ch = text[i += 1]; ) {
      if (mode === FOLD_QUOTED && ch === "\\") {
        escStart = i;
        switch (text[i + 1]) {
          case "x":
            i += 3;
            break;
          case "u":
            i += 5;
            break;
          case "U":
            i += 9;
            break;
          default:
            i += 1;
        }
        escEnd = i;
      }
      if (ch === `
`) {
        if (mode === FOLD_BLOCK)
          i = consumeMoreIndentedLines(text, i, indent.length);
        end = i + indent.length + endStep;
        split = undefined;
      } else {
        if (ch === " " && prev && prev !== " " && prev !== `
` && prev !== "\t") {
          const next = text[i + 1];
          if (next && next !== " " && next !== `
` && next !== "\t")
            split = i;
        }
        if (i >= end) {
          if (split) {
            folds.push(split);
            end = split + endStep;
            split = undefined;
          } else if (mode === FOLD_QUOTED) {
            while (prev === " " || prev === "\t") {
              prev = ch;
              ch = text[i += 1];
              overflow = true;
            }
            const j2 = i > escEnd + 1 ? i - 2 : escStart - 1;
            if (escapedFolds[j2])
              return text;
            folds.push(j2);
            escapedFolds[j2] = true;
            end = j2 + endStep;
            split = undefined;
          } else {
            overflow = true;
          }
        }
      }
      prev = ch;
    }
    if (overflow && onOverflow)
      onOverflow();
    if (folds.length === 0)
      return text;
    if (onFold)
      onFold();
    let res = text.slice(0, folds[0]);
    for (let i2 = 0;i2 < folds.length; ++i2) {
      const fold = folds[i2];
      const end2 = folds[i2 + 1] || text.length;
      if (fold === 0)
        res = `
${indent}${text.slice(0, end2)}`;
      else {
        if (mode === FOLD_QUOTED && escapedFolds[fold])
          res += `${text[fold]}\\`;
        res += `
${indent}${text.slice(fold + 1, end2)}`;
      }
    }
    return res;
  }
  function consumeMoreIndentedLines(text, i, indent) {
    let end = i;
    let start = i + 1;
    let ch = text[start];
    while (ch === " " || ch === "\t") {
      if (i < start + indent) {
        ch = text[++i];
      } else {
        do {
          ch = text[++i];
        } while (ch && ch !== `
`);
        end = i;
        start = i + 1;
        ch = text[start];
      }
    }
    return end;
  }
  exports.FOLD_BLOCK = FOLD_BLOCK;
  exports.FOLD_FLOW = FOLD_FLOW;
  exports.FOLD_QUOTED = FOLD_QUOTED;
  exports.foldFlowLines = foldFlowLines;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var foldFlowLines = require_foldFlowLines();
  var getFoldOptions = (ctx, isBlock) => ({
    indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
    lineWidth: ctx.options.lineWidth,
    minContentWidth: ctx.options.minContentWidth
  });
  var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
  function lineLengthOverLimit(str, lineWidth, indentLength) {
    if (!lineWidth || lineWidth < 0)
      return false;
    const limit = lineWidth - indentLength;
    const strLen = str.length;
    if (strLen <= limit)
      return false;
    for (let i = 0, start = 0;i < strLen; ++i) {
      if (str[i] === `
`) {
        if (i - start > limit)
          return true;
        start = i + 1;
        if (strLen - start <= limit)
          return false;
      }
    }
    return true;
  }
  function doubleQuotedString(value, ctx) {
    const json = JSON.stringify(value);
    if (ctx.options.doubleQuotedAsJSON)
      return json;
    const { implicitKey } = ctx;
    const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    let str = "";
    let start = 0;
    for (let i = 0, ch = json[i];ch; ch = json[++i]) {
      if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
        str += json.slice(start, i) + "\\ ";
        i += 1;
        start = i;
        ch = "\\";
      }
      if (ch === "\\")
        switch (json[i + 1]) {
          case "u":
            {
              str += json.slice(start, i);
              const code = json.substr(i + 2, 4);
              switch (code) {
                case "0000":
                  str += "\\0";
                  break;
                case "0007":
                  str += "\\a";
                  break;
                case "000b":
                  str += "\\v";
                  break;
                case "001b":
                  str += "\\e";
                  break;
                case "0085":
                  str += "\\N";
                  break;
                case "00a0":
                  str += "\\_";
                  break;
                case "2028":
                  str += "\\L";
                  break;
                case "2029":
                  str += "\\P";
                  break;
                default:
                  if (code.substr(0, 2) === "00")
                    str += "\\x" + code.substr(2);
                  else
                    str += json.substr(i, 6);
              }
              i += 5;
              start = i + 1;
            }
            break;
          case "n":
            if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
              i += 1;
            } else {
              str += json.slice(start, i) + `

`;
              while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                str += `
`;
                i += 2;
              }
              str += indent;
              if (json[i + 2] === " ")
                str += "\\";
              i += 1;
              start = i + 1;
            }
            break;
          default:
            i += 1;
        }
    }
    str = start ? str + json.slice(start) : json;
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
  }
  function singleQuotedString(value, ctx) {
    if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes(`
`) || /[ \t]\n|\n[ \t]/.test(value))
      return doubleQuotedString(value, ctx);
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
    return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function quotedString(value, ctx) {
    const { singleQuote } = ctx.options;
    let qs;
    if (singleQuote === false)
      qs = doubleQuotedString;
    else {
      const hasDouble = value.includes('"');
      const hasSingle = value.includes("'");
      if (hasDouble && !hasSingle)
        qs = singleQuotedString;
      else if (hasSingle && !hasDouble)
        qs = doubleQuotedString;
      else
        qs = singleQuote ? singleQuotedString : doubleQuotedString;
    }
    return qs(value, ctx);
  }
  var blockEndNewlines;
  try {
    blockEndNewlines = new RegExp(`(^|(?<!
))
+(?!
|$)`, "g");
  } catch {
    blockEndNewlines = /\n+(?!\n|$)/g;
  }
  function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
    const { blockQuote, commentString, lineWidth } = ctx.options;
    if (!blockQuote || /\n[\t ]+$/.test(value)) {
      return quotedString(value, ctx);
    }
    const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
    const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
    if (!value)
      return literal ? `|
` : `>
`;
    let chomp;
    let endStart;
    for (endStart = value.length;endStart > 0; --endStart) {
      const ch = value[endStart - 1];
      if (ch !== `
` && ch !== "\t" && ch !== " ")
        break;
    }
    let end = value.substring(endStart);
    const endNlPos = end.indexOf(`
`);
    if (endNlPos === -1) {
      chomp = "-";
    } else if (value === end || endNlPos !== end.length - 1) {
      chomp = "+";
      if (onChompKeep)
        onChompKeep();
    } else {
      chomp = "";
    }
    if (end) {
      value = value.slice(0, -end.length);
      if (end[end.length - 1] === `
`)
        end = end.slice(0, -1);
      end = end.replace(blockEndNewlines, `$&${indent}`);
    }
    let startWithSpace = false;
    let startEnd;
    let startNlPos = -1;
    for (startEnd = 0;startEnd < value.length; ++startEnd) {
      const ch = value[startEnd];
      if (ch === " ")
        startWithSpace = true;
      else if (ch === `
`)
        startNlPos = startEnd;
      else
        break;
    }
    let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
    if (start) {
      value = value.substring(start.length);
      start = start.replace(/\n+/g, `$&${indent}`);
    }
    const indentSize = indent ? "2" : "1";
    let header = (startWithSpace ? indentSize : "") + chomp;
    if (comment) {
      header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
      if (onComment)
        onComment();
    }
    if (!literal) {
      const foldedValue = value.replace(/\n+/g, `
$&`).replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
      let literalFallback = false;
      const foldOptions = getFoldOptions(ctx, true);
      if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
        foldOptions.onOverflow = () => {
          literalFallback = true;
        };
      }
      const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
      if (!literalFallback)
        return `>${header}
${indent}${body}`;
    }
    value = value.replace(/\n+/g, `$&${indent}`);
    return `|${header}
${indent}${start}${value}${end}`;
  }
  function plainString(item, ctx, onComment, onChompKeep) {
    const { type, value } = item;
    const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
    if (implicitKey && value.includes(`
`) || inFlow && /[[\]{},]/.test(value)) {
      return quotedString(value, ctx);
    }
    if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
      return implicitKey || inFlow || !value.includes(`
`) ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
    }
    if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes(`
`)) {
      return blockString(item, ctx, onComment, onChompKeep);
    }
    if (containsDocumentMarker(value)) {
      if (indent === "") {
        ctx.forceBlockIndent = true;
        return blockString(item, ctx, onComment, onChompKeep);
      } else if (implicitKey && indent === indentStep) {
        return quotedString(value, ctx);
      }
    }
    const str = value.replace(/\n+/g, `$&
${indent}`);
    if (actualString) {
      const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
      const { compat, tags } = ctx.doc.schema;
      if (tags.some(test) || compat?.some(test))
        return quotedString(value, ctx);
    }
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function stringifyString(item, ctx, onComment, onChompKeep) {
    const { implicitKey, inFlow } = ctx;
    const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
    let { type } = item;
    if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
        type = Scalar.Scalar.QUOTE_DOUBLE;
    }
    const _stringify = (_type) => {
      switch (_type) {
        case Scalar.Scalar.BLOCK_FOLDED:
        case Scalar.Scalar.BLOCK_LITERAL:
          return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
        case Scalar.Scalar.QUOTE_DOUBLE:
          return doubleQuotedString(ss.value, ctx);
        case Scalar.Scalar.QUOTE_SINGLE:
          return singleQuotedString(ss.value, ctx);
        case Scalar.Scalar.PLAIN:
          return plainString(ss, ctx, onComment, onChompKeep);
        default:
          return null;
      }
    };
    let res = _stringify(type);
    if (res === null) {
      const { defaultKeyType, defaultStringType } = ctx.options;
      const t = implicitKey && defaultKeyType || defaultStringType;
      res = _stringify(t);
      if (res === null)
        throw new Error(`Unsupported default string type ${t}`);
    }
    return res;
  }
  exports.stringifyString = stringifyString;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS((exports) => {
  var anchors = require_anchors();
  var identity = require_identity();
  var stringifyComment = require_stringifyComment();
  var stringifyString = require_stringifyString();
  function createStringifyContext(doc, options) {
    const opt = Object.assign({
      blockQuote: true,
      commentString: stringifyComment.stringifyComment,
      defaultKeyType: null,
      defaultStringType: "PLAIN",
      directives: null,
      doubleQuotedAsJSON: false,
      doubleQuotedMinMultiLineLength: 40,
      falseStr: "false",
      flowCollectionPadding: true,
      indentSeq: true,
      lineWidth: 80,
      minContentWidth: 20,
      nullStr: "null",
      simpleKeys: false,
      singleQuote: null,
      trueStr: "true",
      verifyAliasOrder: true
    }, doc.schema.toStringOptions, options);
    let inFlow;
    switch (opt.collectionStyle) {
      case "block":
        inFlow = false;
        break;
      case "flow":
        inFlow = true;
        break;
      default:
        inFlow = null;
    }
    return {
      anchors: new Set,
      doc,
      flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
      indent: "",
      indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
      inFlow,
      options: opt
    };
  }
  function getTagObject(tags, item) {
    if (item.tag) {
      const match = tags.filter((t) => t.tag === item.tag);
      if (match.length > 0)
        return match.find((t) => t.format === item.format) ?? match[0];
    }
    let tagObj = undefined;
    let obj;
    if (identity.isScalar(item)) {
      obj = item.value;
      let match = tags.filter((t) => t.identify?.(obj));
      if (match.length > 1) {
        const testMatch = match.filter((t) => t.test);
        if (testMatch.length > 0)
          match = testMatch;
      }
      tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
    } else {
      obj = item;
      tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
    }
    if (!tagObj) {
      const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
      throw new Error(`Tag not resolved for ${name} value`);
    }
    return tagObj;
  }
  function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
    if (!doc.directives)
      return "";
    const props = [];
    const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
    if (anchor && anchors.anchorIsValid(anchor)) {
      anchors$1.add(anchor);
      props.push(`&${anchor}`);
    }
    const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
    if (tag)
      props.push(doc.directives.tagString(tag));
    return props.join(" ");
  }
  function stringify(item, ctx, onComment, onChompKeep) {
    if (identity.isPair(item))
      return item.toString(ctx, onComment, onChompKeep);
    if (identity.isAlias(item)) {
      if (ctx.doc.directives)
        return item.toString(ctx);
      if (ctx.resolvedAliases?.has(item)) {
        throw new TypeError(`Cannot stringify circular structure without alias nodes`);
      } else {
        if (ctx.resolvedAliases)
          ctx.resolvedAliases.add(item);
        else
          ctx.resolvedAliases = new Set([item]);
        item = item.resolve(ctx.doc);
      }
    }
    let tagObj = undefined;
    const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
    tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
    const props = stringifyProps(node, tagObj, ctx);
    if (props.length > 0)
      ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
    const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
    if (!props)
      return str;
    return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
  }
  exports.createStringifyContext = createStringifyContext;
  exports.stringify = stringify;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
    const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
    let keyComment = identity.isNode(key) && key.comment || null;
    if (simpleKeys) {
      if (keyComment) {
        throw new Error("With simple keys, key nodes cannot have comments");
      }
      if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
        const msg = "With simple keys, collection cannot be used as a key value";
        throw new Error(msg);
      }
    }
    let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
    ctx = Object.assign({}, ctx, {
      allNullValues: false,
      implicitKey: !explicitKey && (simpleKeys || !allNullValues),
      indent: indent + indentStep
    });
    let keyCommentDone = false;
    let chompKeep = false;
    let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
    if (!explicitKey && !ctx.inFlow && str.length > 1024) {
      if (simpleKeys)
        throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
      explicitKey = true;
    }
    if (ctx.inFlow) {
      if (allNullValues || value == null) {
        if (keyCommentDone && onComment)
          onComment();
        return str === "" ? "?" : explicitKey ? `? ${str}` : str;
      }
    } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
      str = `? ${str}`;
      if (keyComment && !keyCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    if (keyCommentDone)
      keyComment = null;
    if (explicitKey) {
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      str = `? ${str}
${indent}:`;
    } else {
      str = `${str}:`;
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
    }
    let vsb, vcb, valueComment;
    if (identity.isNode(value)) {
      vsb = !!value.spaceBefore;
      vcb = value.commentBefore;
      valueComment = value.comment;
    } else {
      vsb = false;
      vcb = null;
      valueComment = null;
      if (value && typeof value === "object")
        value = doc.createNode(value);
    }
    ctx.implicitKey = false;
    if (!explicitKey && !keyComment && identity.isScalar(value))
      ctx.indentAtStart = str.length + 1;
    chompKeep = false;
    if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
      ctx.indent = ctx.indent.substring(2);
    }
    let valueCommentDone = false;
    const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
    let ws = " ";
    if (keyComment || vsb || vcb) {
      ws = vsb ? `
` : "";
      if (vcb) {
        const cs = commentString(vcb);
        ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
      }
      if (valueStr === "" && !ctx.inFlow) {
        if (ws === `
` && valueComment)
          ws = `

`;
      } else {
        ws += `
${ctx.indent}`;
      }
    } else if (!explicitKey && identity.isCollection(value)) {
      const vs0 = valueStr[0];
      const nl0 = valueStr.indexOf(`
`);
      const hasNewline = nl0 !== -1;
      const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
      if (hasNewline || !flow) {
        let hasPropsLine = false;
        if (hasNewline && (vs0 === "&" || vs0 === "!")) {
          let sp0 = valueStr.indexOf(" ");
          if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
            sp0 = valueStr.indexOf(" ", sp0 + 1);
          }
          if (sp0 === -1 || nl0 < sp0)
            hasPropsLine = true;
        }
        if (!hasPropsLine)
          ws = `
${ctx.indent}`;
      }
    } else if (valueStr === "" || valueStr[0] === `
`) {
      ws = "";
    }
    str += ws + valueStr;
    if (ctx.inFlow) {
      if (valueCommentDone && onComment)
        onComment();
    } else if (valueComment && !valueCommentDone) {
      str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
    } else if (chompKeep && onChompKeep) {
      onChompKeep();
    }
    return str;
  }
  exports.stringifyPair = stringifyPair;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/log.js
var require_log = __commonJS((exports) => {
  var node_process = __require("process");
  function debug(logLevel, ...messages) {
    if (logLevel === "debug")
      console.log(...messages);
  }
  function warn(logLevel, warning) {
    if (logLevel === "debug" || logLevel === "warn") {
      if (typeof node_process.emitWarning === "function")
        node_process.emitWarning(warning);
      else
        console.warn(warning);
    }
  }
  exports.debug = debug;
  exports.warn = warn;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var MERGE_KEY = "<<";
  var merge = {
    identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
    default: "key",
    tag: "tag:yaml.org,2002:merge",
    test: /^<<$/,
    resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
      addToJSMap: addMergeToJSMap
    }),
    stringify: () => MERGE_KEY
  };
  var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
  function addMergeToJSMap(ctx, map, value) {
    value = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (identity.isSeq(value))
      for (const it of value.items)
        mergeValue(ctx, map, it);
    else if (Array.isArray(value))
      for (const it of value)
        mergeValue(ctx, map, it);
    else
      mergeValue(ctx, map, value);
  }
  function mergeValue(ctx, map, value) {
    const source = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (!identity.isMap(source))
      throw new Error("Merge sources must be maps or map aliases");
    const srcMap = source.toJSON(null, ctx, Map);
    for (const [key, value2] of srcMap) {
      if (map instanceof Map) {
        if (!map.has(key))
          map.set(key, value2);
      } else if (map instanceof Set) {
        map.add(key);
      } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
        Object.defineProperty(map, key, {
          value: value2,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    }
    return map;
  }
  exports.addMergeToJSMap = addMergeToJSMap;
  exports.isMergeKey = isMergeKey;
  exports.merge = merge;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS((exports) => {
  var log = require_log();
  var merge = require_merge();
  var stringify = require_stringify();
  var identity = require_identity();
  var toJS = require_toJS();
  function addPairToJSMap(ctx, map, { key, value }) {
    if (identity.isNode(key) && key.addToJSMap)
      key.addToJSMap(ctx, map, value);
    else if (merge.isMergeKey(ctx, key))
      merge.addMergeToJSMap(ctx, map, value);
    else {
      const jsKey = toJS.toJS(key, "", ctx);
      if (map instanceof Map) {
        map.set(jsKey, toJS.toJS(value, jsKey, ctx));
      } else if (map instanceof Set) {
        map.add(jsKey);
      } else {
        const stringKey = stringifyKey(key, jsKey, ctx);
        const jsValue = toJS.toJS(value, stringKey, ctx);
        if (stringKey in map)
          Object.defineProperty(map, stringKey, {
            value: jsValue,
            writable: true,
            enumerable: true,
            configurable: true
          });
        else
          map[stringKey] = jsValue;
      }
    }
    return map;
  }
  function stringifyKey(key, jsKey, ctx) {
    if (jsKey === null)
      return "";
    if (typeof jsKey !== "object")
      return String(jsKey);
    if (identity.isNode(key) && ctx?.doc) {
      const strCtx = stringify.createStringifyContext(ctx.doc, {});
      strCtx.anchors = new Set;
      for (const node of ctx.anchors.keys())
        strCtx.anchors.add(node.anchor);
      strCtx.inFlow = true;
      strCtx.inStringifyKey = true;
      const strKey = key.toString(strCtx);
      if (!ctx.mapKeyWarned) {
        let jsonStr = JSON.stringify(strKey);
        if (jsonStr.length > 40)
          jsonStr = jsonStr.substring(0, 36) + '..."';
        log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
        ctx.mapKeyWarned = true;
      }
      return strKey;
    }
    return JSON.stringify(jsKey);
  }
  exports.addPairToJSMap = addPairToJSMap;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS((exports) => {
  var createNode = require_createNode();
  var stringifyPair = require_stringifyPair();
  var addPairToJSMap = require_addPairToJSMap();
  var identity = require_identity();
  function createPair(key, value, ctx) {
    const k2 = createNode.createNode(key, undefined, ctx);
    const v2 = createNode.createNode(value, undefined, ctx);
    return new Pair(k2, v2);
  }

  class Pair {
    constructor(key, value = null) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
      this.key = key;
      this.value = value;
    }
    clone(schema) {
      let { key, value } = this;
      if (identity.isNode(key))
        key = key.clone(schema);
      if (identity.isNode(value))
        value = value.clone(schema);
      return new Pair(key, value);
    }
    toJSON(_2, ctx) {
      const pair = ctx?.mapAsMap ? new Map : {};
      return addPairToJSMap.addPairToJSMap(ctx, pair, this);
    }
    toString(ctx, onComment, onChompKeep) {
      return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
    }
  }
  exports.Pair = Pair;
  exports.createPair = createPair;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS((exports) => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyCollection(collection, ctx, options) {
    const flow = ctx.inFlow ?? collection.flow;
    const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
    return stringify2(collection, ctx, options);
  }
  function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
    const { indent, options: { commentString } } = ctx;
    const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
    let chompKeep = false;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment2 = null;
      if (identity.isNode(item)) {
        if (!chompKeep && item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
        if (item.comment)
          comment2 = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (!chompKeep && ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
        }
      }
      chompKeep = false;
      let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
      if (comment2)
        str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
      if (chompKeep && comment2)
        chompKeep = false;
      lines.push(blockItemPrefix + str2);
    }
    let str;
    if (lines.length === 0) {
      str = flowChars.start + flowChars.end;
    } else {
      str = lines[0];
      for (let i = 1;i < lines.length; ++i) {
        const line = lines[i];
        str += line ? `
${indent}${line}` : `
`;
      }
    }
    if (comment) {
      str += `
` + stringifyComment.indentComment(commentString(comment), indent);
      if (onComment)
        onComment();
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
    const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
    itemIndent += indentStep;
    const itemCtx = Object.assign({}, ctx, {
      indent: itemIndent,
      inFlow: true,
      type: null
    });
    let reqNewline = false;
    let linesAtValue = 0;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment = null;
      if (identity.isNode(item)) {
        if (item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, false);
        if (item.comment)
          comment = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, false);
          if (ik.comment)
            reqNewline = true;
        }
        const iv = identity.isNode(item.value) ? item.value : null;
        if (iv) {
          if (iv.comment)
            comment = iv.comment;
          if (iv.commentBefore)
            reqNewline = true;
        } else if (item.value == null && ik?.comment) {
          comment = ik.comment;
        }
      }
      if (comment)
        reqNewline = true;
      let str = stringify.stringify(item, itemCtx, () => comment = null);
      if (i < items.length - 1)
        str += ",";
      if (comment)
        str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
      if (!reqNewline && (lines.length > linesAtValue || str.includes(`
`)))
        reqNewline = true;
      lines.push(str);
      linesAtValue = lines.length;
    }
    const { start, end } = flowChars;
    if (lines.length === 0) {
      return start + end;
    } else {
      if (!reqNewline) {
        const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
        reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
      }
      if (reqNewline) {
        let str = start;
        for (const line of lines)
          str += line ? `
${indentStep}${indent}${line}` : `
`;
        return `${str}
${indent}${end}`;
      } else {
        return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
      }
    }
  }
  function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
    if (comment && chompKeep)
      comment = comment.replace(/^\n+/, "");
    if (comment) {
      const ic = stringifyComment.indentComment(commentString(comment), indent);
      lines.push(ic.trimStart());
    }
  }
  exports.stringifyCollection = stringifyCollection;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS((exports) => {
  var stringifyCollection = require_stringifyCollection();
  var addPairToJSMap = require_addPairToJSMap();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  function findPair(items, key) {
    const k2 = identity.isScalar(key) ? key.value : key;
    for (const it of items) {
      if (identity.isPair(it)) {
        if (it.key === key || it.key === k2)
          return it;
        if (identity.isScalar(it.key) && it.key.value === k2)
          return it;
      }
    }
    return;
  }

  class YAMLMap extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:map";
    }
    constructor(schema) {
      super(identity.MAP, schema);
      this.items = [];
    }
    static from(schema, obj, ctx) {
      const { keepUndefined, replacer } = ctx;
      const map = new this(schema);
      const add = (key, value) => {
        if (typeof replacer === "function")
          value = replacer.call(obj, key, value);
        else if (Array.isArray(replacer) && !replacer.includes(key))
          return;
        if (value !== undefined || keepUndefined)
          map.items.push(Pair.createPair(key, value, ctx));
      };
      if (obj instanceof Map) {
        for (const [key, value] of obj)
          add(key, value);
      } else if (obj && typeof obj === "object") {
        for (const key of Object.keys(obj))
          add(key, obj[key]);
      }
      if (typeof schema.sortMapEntries === "function") {
        map.items.sort(schema.sortMapEntries);
      }
      return map;
    }
    add(pair, overwrite) {
      let _pair;
      if (identity.isPair(pair))
        _pair = pair;
      else if (!pair || typeof pair !== "object" || !("key" in pair)) {
        _pair = new Pair.Pair(pair, pair?.value);
      } else
        _pair = new Pair.Pair(pair.key, pair.value);
      const prev = findPair(this.items, _pair.key);
      const sortEntries = this.schema?.sortMapEntries;
      if (prev) {
        if (!overwrite)
          throw new Error(`Key ${_pair.key} already set`);
        if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
          prev.value.value = _pair.value;
        else
          prev.value = _pair.value;
      } else if (sortEntries) {
        const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
        if (i === -1)
          this.items.push(_pair);
        else
          this.items.splice(i, 0, _pair);
      } else {
        this.items.push(_pair);
      }
    }
    delete(key) {
      const it = findPair(this.items, key);
      if (!it)
        return false;
      const del = this.items.splice(this.items.indexOf(it), 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const it = findPair(this.items, key);
      const node = it?.value;
      return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? undefined;
    }
    has(key) {
      return !!findPair(this.items, key);
    }
    set(key, value) {
      this.add(new Pair.Pair(key, value), true);
    }
    toJSON(_2, ctx, Type) {
      const map = Type ? new Type : ctx?.mapAsMap ? new Map : {};
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const item of this.items)
        addPairToJSMap.addPairToJSMap(ctx, map, item);
      return map;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      for (const item of this.items) {
        if (!identity.isPair(item))
          throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
      }
      if (!ctx.allNullValues && this.hasAllNullValues(false))
        ctx = Object.assign({}, ctx, { allNullValues: true });
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "",
        flowChars: { start: "{", end: "}" },
        itemIndent: ctx.indent || "",
        onChompKeep,
        onComment
      });
    }
  }
  exports.YAMLMap = YAMLMap;
  exports.findPair = findPair;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS((exports) => {
  var identity = require_identity();
  var YAMLMap = require_YAMLMap();
  var map = {
    collection: "map",
    default: true,
    nodeClass: YAMLMap.YAMLMap,
    tag: "tag:yaml.org,2002:map",
    resolve(map2, onError) {
      if (!identity.isMap(map2))
        onError("Expected a mapping for this tag");
      return map2;
    },
    createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
  };
  exports.map = map;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS((exports) => {
  var createNode = require_createNode();
  var stringifyCollection = require_stringifyCollection();
  var Collection = require_Collection();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var toJS = require_toJS();

  class YAMLSeq extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:seq";
    }
    constructor(schema) {
      super(identity.SEQ, schema);
      this.items = [];
    }
    add(value) {
      this.items.push(value);
    }
    delete(key) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return false;
      const del = this.items.splice(idx, 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return;
      const it = this.items[idx];
      return !keepScalar && identity.isScalar(it) ? it.value : it;
    }
    has(key) {
      const idx = asItemIndex(key);
      return typeof idx === "number" && idx < this.items.length;
    }
    set(key, value) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        throw new Error(`Expected a valid index, not ${key}.`);
      const prev = this.items[idx];
      if (identity.isScalar(prev) && Scalar.isScalarValue(value))
        prev.value = value;
      else
        this.items[idx] = value;
    }
    toJSON(_2, ctx) {
      const seq = [];
      if (ctx?.onCreate)
        ctx.onCreate(seq);
      let i = 0;
      for (const item of this.items)
        seq.push(toJS.toJS(item, String(i++), ctx));
      return seq;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "- ",
        flowChars: { start: "[", end: "]" },
        itemIndent: (ctx.indent || "") + "  ",
        onChompKeep,
        onComment
      });
    }
    static from(schema, obj, ctx) {
      const { replacer } = ctx;
      const seq = new this(schema);
      if (obj && Symbol.iterator in Object(obj)) {
        let i = 0;
        for (let it of obj) {
          if (typeof replacer === "function") {
            const key = obj instanceof Set ? it : String(i++);
            it = replacer.call(obj, key, it);
          }
          seq.items.push(createNode.createNode(it, undefined, ctx));
        }
      }
      return seq;
    }
  }
  function asItemIndex(key) {
    let idx = identity.isScalar(key) ? key.value : key;
    if (idx && typeof idx === "string")
      idx = Number(idx);
    return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
  }
  exports.YAMLSeq = YAMLSeq;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS((exports) => {
  var identity = require_identity();
  var YAMLSeq = require_YAMLSeq();
  var seq = {
    collection: "seq",
    default: true,
    nodeClass: YAMLSeq.YAMLSeq,
    tag: "tag:yaml.org,2002:seq",
    resolve(seq2, onError) {
      if (!identity.isSeq(seq2))
        onError("Expected a sequence for this tag");
      return seq2;
    },
    createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
  };
  exports.seq = seq;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS((exports) => {
  var stringifyString = require_stringifyString();
  var string = {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify(item, ctx, onComment, onChompKeep) {
      ctx = Object.assign({ actualString: true }, ctx);
      return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
    }
  };
  exports.string = string;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var nullTag = {
    identify: (value) => value == null,
    createNode: () => new Scalar.Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^(?:~|[Nn]ull|NULL)?$/,
    resolve: () => new Scalar.Scalar(null),
    stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
  };
  exports.nullTag = nullTag;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var boolTag = {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
    resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
    stringify({ source, value }, ctx) {
      if (source && boolTag.test.test(source)) {
        const sv = source[0] === "t" || source[0] === "T";
        if (value === sv)
          return source;
      }
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
  };
  exports.boolTag = boolTag;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS((exports) => {
  function stringifyNumber({ format, minFractionDigits, tag, value }) {
    if (typeof value === "bigint")
      return String(value);
    const num = typeof value === "number" ? value : Number(value);
    if (!isFinite(num))
      return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
    let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
    if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^\d/.test(n)) {
      let i = n.indexOf(".");
      if (i < 0) {
        i = n.length;
        n += ".";
      }
      let d2 = minFractionDigits - (n.length - i - 1);
      while (d2-- > 0)
        n += "0";
    }
    return n;
  }
  exports.stringifyNumber = stringifyNumber;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str));
      const dot = str.indexOf(".");
      if (dot !== -1 && str[str.length - 1] === "0")
        node.minFractionDigits = str.length - dot - 1;
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value) && value >= 0)
      return prefix + value.toString(radix);
    return stringifyNumber.stringifyNumber(node);
  }
  var intOct = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^0o[0-7]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
    stringify: (node) => intStringify(node, 8, "0o")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^0x[0-9a-fA-F]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.boolTag,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float
  ];
  exports.schema = schema;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var map = require_map();
  var seq = require_seq();
  function intIdentify(value) {
    return typeof value === "bigint" || Number.isInteger(value);
  }
  var stringifyJSON = ({ value }) => JSON.stringify(value);
  var jsonScalars = [
    {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify: stringifyJSON
    },
    {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^null$/,
      resolve: () => null,
      stringify: stringifyJSON
    },
    {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^true$|^false$/,
      resolve: (str) => str === "true",
      stringify: stringifyJSON
    },
    {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^-?(?:0|[1-9][0-9]*)$/,
      resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
      stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
    },
    {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
      resolve: (str) => parseFloat(str),
      stringify: stringifyJSON
    }
  ];
  var jsonError = {
    default: true,
    tag: "",
    test: /^/,
    resolve(str, onError) {
      onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
      return str;
    }
  };
  var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
  exports.schema = schema;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS((exports) => {
  var node_buffer = __require("buffer");
  var Scalar = require_Scalar();
  var stringifyString = require_stringifyString();
  var binary = {
    identify: (value) => value instanceof Uint8Array,
    default: false,
    tag: "tag:yaml.org,2002:binary",
    resolve(src, onError) {
      if (typeof node_buffer.Buffer === "function") {
        return node_buffer.Buffer.from(src, "base64");
      } else if (typeof atob === "function") {
        const str = atob(src.replace(/[\n\r]/g, ""));
        const buffer = new Uint8Array(str.length);
        for (let i = 0;i < str.length; ++i)
          buffer[i] = str.charCodeAt(i);
        return buffer;
      } else {
        onError("This environment does not support reading binary tags; either Buffer or atob is required");
        return src;
      }
    },
    stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
      if (!value)
        return "";
      const buf = value;
      let str;
      if (typeof node_buffer.Buffer === "function") {
        str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
      } else if (typeof btoa === "function") {
        let s = "";
        for (let i = 0;i < buf.length; ++i)
          s += String.fromCharCode(buf[i]);
        str = btoa(s);
      } else {
        throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
      }
      type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
        const n = Math.ceil(str.length / lineWidth);
        const lines = new Array(n);
        for (let i = 0, o = 0;i < n; ++i, o += lineWidth) {
          lines[i] = str.substr(o, lineWidth);
        }
        str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? `
` : " ");
      }
      return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
    }
  };
  exports.binary = binary;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  var YAMLSeq = require_YAMLSeq();
  function resolvePairs(seq, onError) {
    if (identity.isSeq(seq)) {
      for (let i = 0;i < seq.items.length; ++i) {
        let item = seq.items[i];
        if (identity.isPair(item))
          continue;
        else if (identity.isMap(item)) {
          if (item.items.length > 1)
            onError("Each pair must have its own sequence indicator");
          const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
          if (item.commentBefore)
            pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
          if (item.comment) {
            const cn = pair.value ?? pair.key;
            cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
          }
          item = pair;
        }
        seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
      }
    } else
      onError("Expected a sequence for this tag");
    return seq;
  }
  function createPairs(schema, iterable, ctx) {
    const { replacer } = ctx;
    const pairs2 = new YAMLSeq.YAMLSeq(schema);
    pairs2.tag = "tag:yaml.org,2002:pairs";
    let i = 0;
    if (iterable && Symbol.iterator in Object(iterable))
      for (let it of iterable) {
        if (typeof replacer === "function")
          it = replacer.call(iterable, String(i++), it);
        let key, value;
        if (Array.isArray(it)) {
          if (it.length === 2) {
            key = it[0];
            value = it[1];
          } else
            throw new TypeError(`Expected [key, value] tuple: ${it}`);
        } else if (it && it instanceof Object) {
          const keys = Object.keys(it);
          if (keys.length === 1) {
            key = keys[0];
            value = it[key];
          } else {
            throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
          }
        } else {
          key = it;
        }
        pairs2.items.push(Pair.createPair(key, value, ctx));
      }
    return pairs2;
  }
  var pairs = {
    collection: "seq",
    default: false,
    tag: "tag:yaml.org,2002:pairs",
    resolve: resolvePairs,
    createNode: createPairs
  };
  exports.createPairs = createPairs;
  exports.pairs = pairs;
  exports.resolvePairs = resolvePairs;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS((exports) => {
  var identity = require_identity();
  var toJS = require_toJS();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var pairs = require_pairs();

  class YAMLOMap extends YAMLSeq.YAMLSeq {
    constructor() {
      super();
      this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
      this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
      this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
      this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
      this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
      this.tag = YAMLOMap.tag;
    }
    toJSON(_2, ctx) {
      if (!ctx)
        return super.toJSON(_2);
      const map = new Map;
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const pair of this.items) {
        let key, value;
        if (identity.isPair(pair)) {
          key = toJS.toJS(pair.key, "", ctx);
          value = toJS.toJS(pair.value, key, ctx);
        } else {
          key = toJS.toJS(pair, "", ctx);
        }
        if (map.has(key))
          throw new Error("Ordered maps must not include duplicate keys");
        map.set(key, value);
      }
      return map;
    }
    static from(schema, iterable, ctx) {
      const pairs$1 = pairs.createPairs(schema, iterable, ctx);
      const omap2 = new this;
      omap2.items = pairs$1.items;
      return omap2;
    }
  }
  YAMLOMap.tag = "tag:yaml.org,2002:omap";
  var omap = {
    collection: "seq",
    identify: (value) => value instanceof Map,
    nodeClass: YAMLOMap,
    default: false,
    tag: "tag:yaml.org,2002:omap",
    resolve(seq, onError) {
      const pairs$1 = pairs.resolvePairs(seq, onError);
      const seenKeys = [];
      for (const { key } of pairs$1.items) {
        if (identity.isScalar(key)) {
          if (seenKeys.includes(key.value)) {
            onError(`Ordered maps must not include duplicate keys: ${key.value}`);
          } else {
            seenKeys.push(key.value);
          }
        }
      }
      return Object.assign(new YAMLOMap, pairs$1);
    },
    createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
  };
  exports.YAMLOMap = YAMLOMap;
  exports.omap = omap;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  function boolStringify({ value, source }, ctx) {
    const boolObj = value ? trueTag : falseTag;
    if (source && boolObj.test.test(source))
      return source;
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
  var trueTag = {
    identify: (value) => value === true,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
    resolve: () => new Scalar.Scalar(true),
    stringify: boolStringify
  };
  var falseTag = {
    identify: (value) => value === false,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
    resolve: () => new Scalar.Scalar(false),
    stringify: boolStringify
  };
  exports.falseTag = falseTag;
  exports.trueTag = trueTag;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str.replace(/_/g, "")),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
      const dot = str.indexOf(".");
      if (dot !== -1) {
        const f = str.substring(dot + 1).replace(/_/g, "");
        if (f[f.length - 1] === "0")
          node.minFractionDigits = f.length;
      }
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  function intResolve(str, offset, radix, { intAsBigInt }) {
    const sign = str[0];
    if (sign === "-" || sign === "+")
      offset += 1;
    str = str.substring(offset).replace(/_/g, "");
    if (intAsBigInt) {
      switch (radix) {
        case 2:
          str = `0b${str}`;
          break;
        case 8:
          str = `0o${str}`;
          break;
        case 16:
          str = `0x${str}`;
          break;
      }
      const n2 = BigInt(str);
      return sign === "-" ? BigInt(-1) * n2 : n2;
    }
    const n = parseInt(str, radix);
    return sign === "-" ? -1 * n : n;
  }
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value)) {
      const str = value.toString(radix);
      return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
    }
    return stringifyNumber.stringifyNumber(node);
  }
  var intBin = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "BIN",
    test: /^[-+]?0b[0-1_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
    stringify: (node) => intStringify(node, 2, "0b")
  };
  var intOct = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^[-+]?0[0-7_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
    stringify: (node) => intStringify(node, 8, "0")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9][0-9_]*$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^[-+]?0x[0-9a-fA-F_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intBin = intBin;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();

  class YAMLSet extends YAMLMap.YAMLMap {
    constructor(schema) {
      super(schema);
      this.tag = YAMLSet.tag;
    }
    add(key) {
      let pair;
      if (identity.isPair(key))
        pair = key;
      else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
        pair = new Pair.Pair(key.key, null);
      else
        pair = new Pair.Pair(key, null);
      const prev = YAMLMap.findPair(this.items, pair.key);
      if (!prev)
        this.items.push(pair);
    }
    get(key, keepPair) {
      const pair = YAMLMap.findPair(this.items, key);
      return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
    }
    set(key, value) {
      if (typeof value !== "boolean")
        throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
      const prev = YAMLMap.findPair(this.items, key);
      if (prev && !value) {
        this.items.splice(this.items.indexOf(prev), 1);
      } else if (!prev && value) {
        this.items.push(new Pair.Pair(key));
      }
    }
    toJSON(_2, ctx) {
      return super.toJSON(_2, ctx, Set);
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      if (this.hasAllNullValues(true))
        return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
      else
        throw new Error("Set items must all have null values");
    }
    static from(schema, iterable, ctx) {
      const { replacer } = ctx;
      const set2 = new this(schema);
      if (iterable && Symbol.iterator in Object(iterable))
        for (let value of iterable) {
          if (typeof replacer === "function")
            value = replacer.call(iterable, value, value);
          set2.items.push(Pair.createPair(value, null, ctx));
        }
      return set2;
    }
  }
  YAMLSet.tag = "tag:yaml.org,2002:set";
  var set = {
    collection: "map",
    identify: (value) => value instanceof Set,
    nodeClass: YAMLSet,
    default: false,
    tag: "tag:yaml.org,2002:set",
    createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
    resolve(map, onError) {
      if (identity.isMap(map)) {
        if (map.hasAllNullValues(true))
          return Object.assign(new YAMLSet, map);
        else
          onError("Set items must all have null values");
      } else
        onError("Expected a mapping for this tag");
      return map;
    }
  };
  exports.YAMLSet = YAMLSet;
  exports.set = set;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  function parseSexagesimal(str, asBigInt) {
    const sign = str[0];
    const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
    const num = (n) => asBigInt ? BigInt(n) : Number(n);
    const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
    return sign === "-" ? num(-1) * res : res;
  }
  function stringifySexagesimal(node) {
    let { value } = node;
    let num = (n) => n;
    if (typeof value === "bigint")
      num = (n) => BigInt(n);
    else if (isNaN(value) || !isFinite(value))
      return stringifyNumber.stringifyNumber(node);
    let sign = "";
    if (value < 0) {
      sign = "-";
      value *= num(-1);
    }
    const _60 = num(60);
    const parts = [value % _60];
    if (value < 60) {
      parts.unshift(0);
    } else {
      value = (value - parts[0]) / _60;
      parts.unshift(value % _60);
      if (value >= 60) {
        value = (value - parts[0]) / _60;
        parts.unshift(value);
      }
    }
    return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
  }
  var intTime = {
    identify: (value) => typeof value === "bigint" || Number.isInteger(value),
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
    resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
    stringify: stringifySexagesimal
  };
  var floatTime = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
    resolve: (str) => parseSexagesimal(str, false),
    stringify: stringifySexagesimal
  };
  var timestamp = {
    identify: (value) => value instanceof Date,
    default: true,
    tag: "tag:yaml.org,2002:timestamp",
    test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})" + "(?:" + "(?:t|T|[ \\t]+)" + "([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)" + "(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?" + ")?$"),
    resolve(str) {
      const match = str.match(timestamp.test);
      if (!match)
        throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
      const [, year, month, day, hour, minute, second] = match.map(Number);
      const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
      let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
      const tz = match[8];
      if (tz && tz !== "Z") {
        let d2 = parseSexagesimal(tz, false);
        if (Math.abs(d2) < 30)
          d2 *= 60;
        date -= 60000 * d2;
      }
      return new Date(date);
    },
    stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
  };
  exports.floatTime = floatTime;
  exports.intTime = intTime;
  exports.timestamp = timestamp;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var binary = require_binary();
  var bool = require_bool2();
  var float = require_float2();
  var int = require_int2();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var set = require_set();
  var timestamp = require_timestamp();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.trueTag,
    bool.falseTag,
    int.intBin,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float,
    binary.binary,
    merge.merge,
    omap.omap,
    pairs.pairs,
    set.set,
    timestamp.intTime,
    timestamp.floatTime,
    timestamp.timestamp
  ];
  exports.schema = schema;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = require_schema();
  var schema$1 = require_schema2();
  var binary = require_binary();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var schema$2 = require_schema3();
  var set = require_set();
  var timestamp = require_timestamp();
  var schemas = new Map([
    ["core", schema.schema],
    ["failsafe", [map.map, seq.seq, string.string]],
    ["json", schema$1.schema],
    ["yaml11", schema$2.schema],
    ["yaml-1.1", schema$2.schema]
  ]);
  var tagsByName = {
    binary: binary.binary,
    bool: bool.boolTag,
    float: float.float,
    floatExp: float.floatExp,
    floatNaN: float.floatNaN,
    floatTime: timestamp.floatTime,
    int: int.int,
    intHex: int.intHex,
    intOct: int.intOct,
    intTime: timestamp.intTime,
    map: map.map,
    merge: merge.merge,
    null: _null.nullTag,
    omap: omap.omap,
    pairs: pairs.pairs,
    seq: seq.seq,
    set: set.set,
    timestamp: timestamp.timestamp
  };
  var coreKnownTags = {
    "tag:yaml.org,2002:binary": binary.binary,
    "tag:yaml.org,2002:merge": merge.merge,
    "tag:yaml.org,2002:omap": omap.omap,
    "tag:yaml.org,2002:pairs": pairs.pairs,
    "tag:yaml.org,2002:set": set.set,
    "tag:yaml.org,2002:timestamp": timestamp.timestamp
  };
  function getTags(customTags, schemaName, addMergeTag) {
    const schemaTags = schemas.get(schemaName);
    if (schemaTags && !customTags) {
      return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
    }
    let tags = schemaTags;
    if (!tags) {
      if (Array.isArray(customTags))
        tags = [];
      else {
        const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
      }
    }
    if (Array.isArray(customTags)) {
      for (const tag of customTags)
        tags = tags.concat(tag);
    } else if (typeof customTags === "function") {
      tags = customTags(tags.slice());
    }
    if (addMergeTag)
      tags = tags.concat(merge.merge);
    return tags.reduce((tags2, tag) => {
      const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
      if (!tagObj) {
        const tagName = JSON.stringify(tag);
        const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
      }
      if (!tags2.includes(tagObj))
        tags2.push(tagObj);
      return tags2;
    }, []);
  }
  exports.coreKnownTags = coreKnownTags;
  exports.getTags = getTags;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS((exports) => {
  var identity = require_identity();
  var map = require_map();
  var seq = require_seq();
  var string = require_string();
  var tags = require_tags();
  var sortMapEntriesByKey = (a, b2) => a.key < b2.key ? -1 : a.key > b2.key ? 1 : 0;

  class Schema {
    constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
      this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
      this.name = typeof schema === "string" && schema || "core";
      this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
      this.tags = tags.getTags(customTags, this.name, merge);
      this.toStringOptions = toStringDefaults ?? null;
      Object.defineProperty(this, identity.MAP, { value: map.map });
      Object.defineProperty(this, identity.SCALAR, { value: string.string });
      Object.defineProperty(this, identity.SEQ, { value: seq.seq });
      this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
    }
    clone() {
      const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
      copy.tags = this.tags.slice();
      return copy;
    }
  }
  exports.Schema = Schema;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS((exports) => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyDocument(doc, options) {
    const lines = [];
    let hasDirectives = options.directives === true;
    if (options.directives !== false && doc.directives) {
      const dir = doc.directives.toString(doc);
      if (dir) {
        lines.push(dir);
        hasDirectives = true;
      } else if (doc.directives.docStart)
        hasDirectives = true;
    }
    if (hasDirectives)
      lines.push("---");
    const ctx = stringify.createStringifyContext(doc, options);
    const { commentString } = ctx.options;
    if (doc.commentBefore) {
      if (lines.length !== 1)
        lines.unshift("");
      const cs = commentString(doc.commentBefore);
      lines.unshift(stringifyComment.indentComment(cs, ""));
    }
    let chompKeep = false;
    let contentComment = null;
    if (doc.contents) {
      if (identity.isNode(doc.contents)) {
        if (doc.contents.spaceBefore && hasDirectives)
          lines.push("");
        if (doc.contents.commentBefore) {
          const cs = commentString(doc.contents.commentBefore);
          lines.push(stringifyComment.indentComment(cs, ""));
        }
        ctx.forceBlockIndent = !!doc.comment;
        contentComment = doc.contents.comment;
      }
      const onChompKeep = contentComment ? undefined : () => chompKeep = true;
      let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
      if (contentComment)
        body += stringifyComment.lineComment(body, "", commentString(contentComment));
      if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
        lines[lines.length - 1] = `--- ${body}`;
      } else
        lines.push(body);
    } else {
      lines.push(stringify.stringify(doc.contents, ctx));
    }
    if (doc.directives?.docEnd) {
      if (doc.comment) {
        const cs = commentString(doc.comment);
        if (cs.includes(`
`)) {
          lines.push("...");
          lines.push(stringifyComment.indentComment(cs, ""));
        } else {
          lines.push(`... ${cs}`);
        }
      } else {
        lines.push("...");
      }
    } else {
      let dc = doc.comment;
      if (dc && chompKeep)
        dc = dc.replace(/^\n+/, "");
      if (dc) {
        if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
          lines.push("");
        lines.push(stringifyComment.indentComment(commentString(dc), ""));
      }
    }
    return lines.join(`
`) + `
`;
  }
  exports.stringifyDocument = stringifyDocument;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS((exports) => {
  var Alias = require_Alias();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var toJS = require_toJS();
  var Schema = require_Schema();
  var stringifyDocument = require_stringifyDocument();
  var anchors = require_anchors();
  var applyReviver = require_applyReviver();
  var createNode = require_createNode();
  var directives = require_directives();

  class Document {
    constructor(value, replacer, options) {
      this.commentBefore = null;
      this.comment = null;
      this.errors = [];
      this.warnings = [];
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const opt = Object.assign({
        intAsBigInt: false,
        keepSourceTokens: false,
        logLevel: "warn",
        prettyErrors: true,
        strict: true,
        stringKeys: false,
        uniqueKeys: true,
        version: "1.2"
      }, options);
      this.options = opt;
      let { version } = opt;
      if (options?._directives) {
        this.directives = options._directives.atDocument();
        if (this.directives.yaml.explicit)
          version = this.directives.yaml.version;
      } else
        this.directives = new directives.Directives({ version });
      this.setSchema(version, options);
      this.contents = value === undefined ? null : this.createNode(value, _replacer, options);
    }
    clone() {
      const copy = Object.create(Document.prototype, {
        [identity.NODE_TYPE]: { value: identity.DOC }
      });
      copy.commentBefore = this.commentBefore;
      copy.comment = this.comment;
      copy.errors = this.errors.slice();
      copy.warnings = this.warnings.slice();
      copy.options = Object.assign({}, this.options);
      if (this.directives)
        copy.directives = this.directives.clone();
      copy.schema = this.schema.clone();
      copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    add(value) {
      if (assertCollection(this.contents))
        this.contents.add(value);
    }
    addIn(path, value) {
      if (assertCollection(this.contents))
        this.contents.addIn(path, value);
    }
    createAlias(node, name) {
      if (!node.anchor) {
        const prev = anchors.anchorNames(this);
        node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
      }
      return new Alias.Alias(node.anchor);
    }
    createNode(value, replacer, options) {
      let _replacer = undefined;
      if (typeof replacer === "function") {
        value = replacer.call({ "": value }, "", value);
        _replacer = replacer;
      } else if (Array.isArray(replacer)) {
        const keyToStr = (v2) => typeof v2 === "number" || v2 instanceof String || v2 instanceof Number;
        const asStr = replacer.filter(keyToStr).map(String);
        if (asStr.length > 0)
          replacer = replacer.concat(asStr);
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
      const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || "a");
      const ctx = {
        aliasDuplicateObjects: aliasDuplicateObjects ?? true,
        keepUndefined: keepUndefined ?? false,
        onAnchor,
        onTagObj,
        replacer: _replacer,
        schema: this.schema,
        sourceObjects
      };
      const node = createNode.createNode(value, tag, ctx);
      if (flow && identity.isCollection(node))
        node.flow = true;
      setAnchors();
      return node;
    }
    createPair(key, value, options = {}) {
      const k2 = this.createNode(key, null, options);
      const v2 = this.createNode(value, null, options);
      return new Pair.Pair(k2, v2);
    }
    delete(key) {
      return assertCollection(this.contents) ? this.contents.delete(key) : false;
    }
    deleteIn(path) {
      if (Collection.isEmptyPath(path)) {
        if (this.contents == null)
          return false;
        this.contents = null;
        return true;
      }
      return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
    }
    get(key, keepScalar) {
      return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : undefined;
    }
    getIn(path, keepScalar) {
      if (Collection.isEmptyPath(path))
        return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
      return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : undefined;
    }
    has(key) {
      return identity.isCollection(this.contents) ? this.contents.has(key) : false;
    }
    hasIn(path) {
      if (Collection.isEmptyPath(path))
        return this.contents !== undefined;
      return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
    }
    set(key, value) {
      if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, [key], value);
      } else if (assertCollection(this.contents)) {
        this.contents.set(key, value);
      }
    }
    setIn(path, value) {
      if (Collection.isEmptyPath(path)) {
        this.contents = value;
      } else if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
      } else if (assertCollection(this.contents)) {
        this.contents.setIn(path, value);
      }
    }
    setSchema(version, options = {}) {
      if (typeof version === "number")
        version = String(version);
      let opt;
      switch (version) {
        case "1.1":
          if (this.directives)
            this.directives.yaml.version = "1.1";
          else
            this.directives = new directives.Directives({ version: "1.1" });
          opt = { resolveKnownTags: false, schema: "yaml-1.1" };
          break;
        case "1.2":
        case "next":
          if (this.directives)
            this.directives.yaml.version = version;
          else
            this.directives = new directives.Directives({ version });
          opt = { resolveKnownTags: true, schema: "core" };
          break;
        case null:
          if (this.directives)
            delete this.directives;
          opt = null;
          break;
        default: {
          const sv = JSON.stringify(version);
          throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
        }
      }
      if (options.schema instanceof Object)
        this.schema = options.schema;
      else if (opt)
        this.schema = new Schema.Schema(Object.assign(opt, options));
      else
        throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
    }
    toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      const ctx = {
        anchors: new Map,
        doc: this,
        keep: !json,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
    toJSON(jsonArg, onAnchor) {
      return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
    }
    toString(options = {}) {
      if (this.errors.length > 0)
        throw new Error("Document with errors cannot be stringified");
      if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
        const s = JSON.stringify(options.indent);
        throw new Error(`"indent" option must be a positive integer, not ${s}`);
      }
      return stringifyDocument.stringifyDocument(this, options);
    }
  }
  function assertCollection(contents) {
    if (identity.isCollection(contents))
      return true;
    throw new Error("Expected a YAML collection as document contents");
  }
  exports.Document = Document;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/errors.js
var require_errors = __commonJS((exports) => {
  class YAMLError extends Error {
    constructor(name, pos, code, message) {
      super();
      this.name = name;
      this.code = code;
      this.message = message;
      this.pos = pos;
    }
  }

  class YAMLParseError extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLParseError", pos, code, message);
    }
  }

  class YAMLWarning extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLWarning", pos, code, message);
    }
  }
  var prettifyError = (src, lc) => (error) => {
    if (error.pos[0] === -1)
      return;
    error.linePos = error.pos.map((pos) => lc.linePos(pos));
    const { line, col } = error.linePos[0];
    error.message += ` at line ${line}, column ${col}`;
    let ci = col - 1;
    let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
    if (ci >= 60 && lineStr.length > 80) {
      const trimStart = Math.min(ci - 39, lineStr.length - 79);
      lineStr = "…" + lineStr.substring(trimStart);
      ci -= trimStart - 1;
    }
    if (lineStr.length > 80)
      lineStr = lineStr.substring(0, 79) + "…";
    if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
      let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
      if (prev.length > 80)
        prev = prev.substring(0, 79) + `…
`;
      lineStr = prev + lineStr;
    }
    if (/[^ ]/.test(lineStr)) {
      let count = 1;
      const end = error.linePos[1];
      if (end?.line === line && end.col > col) {
        count = Math.max(1, Math.min(end.col - col, 80 - ci));
      }
      const pointer = " ".repeat(ci) + "^".repeat(count);
      error.message += `:

${lineStr}
${pointer}
`;
    }
  };
  exports.YAMLError = YAMLError;
  exports.YAMLParseError = YAMLParseError;
  exports.YAMLWarning = YAMLWarning;
  exports.prettifyError = prettifyError;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS((exports) => {
  function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
    let spaceBefore = false;
    let atNewline = startOnNewline;
    let hasSpace = startOnNewline;
    let comment = "";
    let commentSep = "";
    let hasNewline = false;
    let reqSpace = false;
    let tab = null;
    let anchor = null;
    let tag = null;
    let newlineAfterProp = null;
    let comma = null;
    let found = null;
    let start = null;
    for (const token of tokens) {
      if (reqSpace) {
        if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
          onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
        reqSpace = false;
      }
      if (tab) {
        if (atNewline && token.type !== "comment" && token.type !== "newline") {
          onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
        }
        tab = null;
      }
      switch (token.type) {
        case "space":
          if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("\t")) {
            tab = token;
          }
          hasSpace = true;
          break;
        case "comment": {
          if (!hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = token.source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += commentSep + cb;
          commentSep = "";
          atNewline = false;
          break;
        }
        case "newline":
          if (atNewline) {
            if (comment)
              comment += token.source;
            else if (!found || indicator !== "seq-item-ind")
              spaceBefore = true;
          } else
            commentSep += token.source;
          atNewline = true;
          hasNewline = true;
          if (anchor || tag)
            newlineAfterProp = token;
          hasSpace = true;
          break;
        case "anchor":
          if (anchor)
            onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
          if (token.source.endsWith(":"))
            onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
          anchor = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        case "tag": {
          if (tag)
            onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
          tag = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        }
        case indicator:
          if (anchor || tag)
            onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
          if (found)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
          found = token;
          atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
          hasSpace = false;
          break;
        case "comma":
          if (flow) {
            if (comma)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
            comma = token;
            atNewline = false;
            hasSpace = false;
            break;
          }
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
          atNewline = false;
          hasSpace = false;
      }
    }
    const last = tokens[tokens.length - 1];
    const end = last ? last.offset + last.source.length : offset;
    if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
      onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
    }
    if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
      onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
    return {
      comma,
      found,
      spaceBefore,
      comment,
      hasNewline,
      anchor,
      tag,
      newlineAfterProp,
      end,
      start: start ?? end
    };
  }
  exports.resolveProps = resolveProps;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS((exports) => {
  function containsNewline(key) {
    if (!key)
      return null;
    switch (key.type) {
      case "alias":
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        if (key.source.includes(`
`))
          return true;
        if (key.end) {
          for (const st of key.end)
            if (st.type === "newline")
              return true;
        }
        return false;
      case "flow-collection":
        for (const it of key.items) {
          for (const st of it.start)
            if (st.type === "newline")
              return true;
          if (it.sep) {
            for (const st of it.sep)
              if (st.type === "newline")
                return true;
          }
          if (containsNewline(it.key) || containsNewline(it.value))
            return true;
        }
        return false;
      default:
        return true;
    }
  }
  exports.containsNewline = containsNewline;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS((exports) => {
  var utilContainsNewline = require_util_contains_newline();
  function flowIndentCheck(indent, fc, onError) {
    if (fc?.type === "flow-collection") {
      const end = fc.end[0];
      if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
        const msg = "Flow end indicator should be more indented than parent";
        onError(end, "BAD_INDENT", msg, true);
      }
    }
  }
  exports.flowIndentCheck = flowIndentCheck;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS((exports) => {
  var identity = require_identity();
  function mapIncludes(ctx, items, search) {
    const { uniqueKeys } = ctx.options;
    if (uniqueKeys === false)
      return false;
    const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b2) => a === b2 || identity.isScalar(a) && identity.isScalar(b2) && a.value === b2.value;
    return items.some((pair) => isEqual(pair.key, search));
  }
  exports.mapIncludes = mapIncludes;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS((exports) => {
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  var utilMapIncludes = require_util_map_includes();
  var startColMsg = "All mapping items must start at the same column";
  function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
    const map = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    let offset = bm.offset;
    let commentEnd = null;
    for (const collItem of bm.items) {
      const { start, key, sep, value } = collItem;
      const keyProps = resolveProps.resolveProps(start, {
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: bm.indent,
        startOnNewline: true
      });
      const implicitKey = !keyProps.found;
      if (implicitKey) {
        if (key) {
          if (key.type === "block-seq")
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
          else if ("indent" in key && key.indent !== bm.indent)
            onError(offset, "BAD_INDENT", startColMsg);
        }
        if (!keyProps.anchor && !keyProps.tag && !sep) {
          commentEnd = keyProps.end;
          if (keyProps.comment) {
            if (map.comment)
              map.comment += `
` + keyProps.comment;
            else
              map.comment = keyProps.comment;
          }
          continue;
        }
        if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
          onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
        }
      } else if (keyProps.found?.indent !== bm.indent) {
        onError(offset, "BAD_INDENT", startColMsg);
      }
      ctx.atKey = true;
      const keyStart = keyProps.end;
      const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
      ctx.atKey = false;
      if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
        onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
      const valueProps = resolveProps.resolveProps(sep ?? [], {
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: bm.indent,
        startOnNewline: !key || key.type === "block-scalar"
      });
      offset = valueProps.end;
      if (valueProps.found) {
        if (implicitKey) {
          if (value?.type === "block-map" && !valueProps.hasNewline)
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
          if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
            onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
        offset = valueNode.range[2];
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      } else {
        if (implicitKey)
          onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
        if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      }
    }
    if (commentEnd && commentEnd < offset)
      onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
    map.range = [bm.offset, offset, commentEnd ?? offset];
    return map;
  }
  exports.resolveBlockMap = resolveBlockMap;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS((exports) => {
  var YAMLSeq = require_YAMLSeq();
  var resolveProps = require_resolve_props();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
    const seq = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = bs.offset;
    let commentEnd = null;
    for (const { start, value } of bs.items) {
      const props = resolveProps.resolveProps(start, {
        indicator: "seq-item-ind",
        next: value,
        offset,
        onError,
        parentIndent: bs.indent,
        startOnNewline: true
      });
      if (!props.found) {
        if (props.anchor || props.tag || value) {
          if (value?.type === "block-seq")
            onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
          else
            onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
        } else {
          commentEnd = props.end;
          if (props.comment)
            seq.comment = props.comment;
          continue;
        }
      }
      const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
      offset = node.range[2];
      seq.items.push(node);
    }
    seq.range = [bs.offset, offset, commentEnd ?? offset];
    return seq;
  }
  exports.resolveBlockSeq = resolveBlockSeq;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS((exports) => {
  function resolveEnd(end, offset, reqSpace, onError) {
    let comment = "";
    if (end) {
      let hasSpace = false;
      let sep = "";
      for (const token of end) {
        const { source, type } = token;
        switch (type) {
          case "space":
            hasSpace = true;
            break;
          case "comment": {
            if (reqSpace && !hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += sep + cb;
            sep = "";
            break;
          }
          case "newline":
            if (comment)
              sep += source;
            hasSpace = true;
            break;
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
        }
        offset += source.length;
      }
    }
    return { comment, offset };
  }
  exports.resolveEnd = resolveEnd;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilMapIncludes = require_util_map_includes();
  var blockMsg = "Block collections are not allowed within flow collections";
  var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
  function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
    const isMap = fc.start.source === "{";
    const fcName = isMap ? "flow map" : "flow sequence";
    const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
    const coll = new NodeClass(ctx.schema);
    coll.flow = true;
    const atRoot = ctx.atRoot;
    if (atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = fc.offset + fc.start.source.length;
    for (let i = 0;i < fc.items.length; ++i) {
      const collItem = fc.items[i];
      const { start, key, sep, value } = collItem;
      const props = resolveProps.resolveProps(start, {
        flow: fcName,
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (!props.found) {
        if (!props.anchor && !props.tag && !sep && !value) {
          if (i === 0 && props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
          else if (i < fc.items.length - 1)
            onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
          if (props.comment) {
            if (coll.comment)
              coll.comment += `
` + props.comment;
            else
              coll.comment = props.comment;
          }
          offset = props.end;
          continue;
        }
        if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
          onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
      }
      if (i === 0) {
        if (props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
      } else {
        if (!props.comma)
          onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
        if (props.comment) {
          let prevItemComment = "";
          loop:
            for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
          if (prevItemComment) {
            let prev = coll.items[coll.items.length - 1];
            if (identity.isPair(prev))
              prev = prev.value ?? prev.key;
            if (prev.comment)
              prev.comment += `
` + prevItemComment;
            else
              prev.comment = prevItemComment;
            props.comment = props.comment.substring(prevItemComment.length + 1);
          }
        }
      }
      if (!isMap && !sep && !props.found) {
        const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
        coll.items.push(valueNode);
        offset = valueNode.range[2];
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else {
        ctx.atKey = true;
        const keyStart = props.end;
        const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
        if (isBlock(key))
          onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
        ctx.atKey = false;
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          flow: fcName,
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (valueProps.found) {
          if (!isMap && !props.found && ctx.options.strict) {
            if (sep)
              for (const st of sep) {
                if (st === valueProps.found)
                  break;
                if (st.type === "newline") {
                  onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                  break;
                }
              }
            if (props.start < valueProps.found.offset - 1024)
              onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
          }
        } else if (value) {
          if ("source" in value && value.source?.[0] === ":")
            onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
          else
            onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
        if (valueNode) {
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        if (isMap) {
          const map = coll;
          if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
            onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
          map.items.push(pair);
        } else {
          const map = new YAMLMap.YAMLMap(ctx.schema);
          map.flow = true;
          map.items.push(pair);
          const endRange = (valueNode ?? keyNode).range;
          map.range = [keyNode.range[0], endRange[1], endRange[2]];
          coll.items.push(map);
        }
        offset = valueNode ? valueNode.range[2] : valueProps.end;
      }
    }
    const expectedEnd = isMap ? "}" : "]";
    const [ce2, ...ee] = fc.end;
    let cePos = offset;
    if (ce2?.source === expectedEnd)
      cePos = ce2.offset + ce2.source.length;
    else {
      const name = fcName[0].toUpperCase() + fcName.substring(1);
      const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
      onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
      if (ce2 && ce2.source.length !== 1)
        ee.unshift(ce2);
    }
    if (ee.length > 0) {
      const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
      if (end.comment) {
        if (coll.comment)
          coll.comment += `
` + end.comment;
        else
          coll.comment = end.comment;
      }
      coll.range = [fc.offset, cePos, end.offset];
    } else {
      coll.range = [fc.offset, cePos, cePos];
    }
    return coll;
  }
  exports.resolveFlowCollection = resolveFlowCollection;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveBlockMap = require_resolve_block_map();
  var resolveBlockSeq = require_resolve_block_seq();
  var resolveFlowCollection = require_resolve_flow_collection();
  function resolveCollection(CN, ctx, token, onError, tagName, tag) {
    const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
    const Coll = coll.constructor;
    if (tagName === "!" || tagName === Coll.tagName) {
      coll.tag = Coll.tagName;
      return coll;
    }
    if (tagName)
      coll.tag = tagName;
    return coll;
  }
  function composeCollection(CN, ctx, token, props, onError) {
    const tagToken = props.tag;
    const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
    if (token.type === "block-seq") {
      const { anchor, newlineAfterProp: nl } = props;
      const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
      if (lastProp && (!nl || nl.offset < lastProp.offset)) {
        const message = "Missing newline after block sequence props";
        onError(lastProp, "MISSING_CHAR", message);
      }
    }
    const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
    if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
      return resolveCollection(CN, ctx, token, onError, tagName);
    }
    let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
    if (!tag) {
      const kt = ctx.schema.knownTags[tagName];
      if (kt?.collection === expType) {
        ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
        tag = kt;
      } else {
        if (kt) {
          onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
        } else {
          onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
        }
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
    }
    const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
    const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
    const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
    node.range = coll.range;
    node.tag = tagName;
    if (tag?.format)
      node.format = tag.format;
    return node;
  }
  exports.composeCollection = composeCollection;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS((exports) => {
  var Scalar = require_Scalar();
  function resolveBlockScalar(ctx, scalar, onError) {
    const start = scalar.offset;
    const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
    if (!header)
      return { value: "", type: null, comment: "", range: [start, start, start] };
    const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
    const lines = scalar.source ? splitLines(scalar.source) : [];
    let chompStart = lines.length;
    for (let i = lines.length - 1;i >= 0; --i) {
      const content = lines[i][1];
      if (content === "" || content === "\r")
        chompStart = i;
      else
        break;
    }
    if (chompStart === 0) {
      const value2 = header.chomp === "+" && lines.length > 0 ? `
`.repeat(Math.max(1, lines.length - 1)) : "";
      let end2 = start + header.length;
      if (scalar.source)
        end2 += scalar.source.length;
      return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
    }
    let trimIndent = scalar.indent + header.indent;
    let offset = scalar.offset + header.length;
    let contentStart = 0;
    for (let i = 0;i < chompStart; ++i) {
      const [indent, content] = lines[i];
      if (content === "" || content === "\r") {
        if (header.indent === 0 && indent.length > trimIndent)
          trimIndent = indent.length;
      } else {
        if (indent.length < trimIndent) {
          const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
          onError(offset + indent.length, "MISSING_CHAR", message);
        }
        if (header.indent === 0)
          trimIndent = indent.length;
        contentStart = i;
        if (trimIndent === 0 && !ctx.atRoot) {
          const message = "Block scalar values in collections must be indented";
          onError(offset, "BAD_INDENT", message);
        }
        break;
      }
      offset += indent.length + content.length + 1;
    }
    for (let i = lines.length - 1;i >= chompStart; --i) {
      if (lines[i][0].length > trimIndent)
        chompStart = i + 1;
    }
    let value = "";
    let sep = "";
    let prevMoreIndented = false;
    for (let i = 0;i < contentStart; ++i)
      value += lines[i][0].slice(trimIndent) + `
`;
    for (let i = contentStart;i < chompStart; ++i) {
      let [indent, content] = lines[i];
      offset += indent.length + content.length + 1;
      const crlf = content[content.length - 1] === "\r";
      if (crlf)
        content = content.slice(0, -1);
      if (content && indent.length < trimIndent) {
        const src = header.indent ? "explicit indentation indicator" : "first line";
        const message = `Block scalar lines must not be less indented than their ${src}`;
        onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
        indent = "";
      }
      if (type === Scalar.Scalar.BLOCK_LITERAL) {
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
      } else if (indent.length > trimIndent || content[0] === "\t") {
        if (sep === " ")
          sep = `
`;
        else if (!prevMoreIndented && sep === `
`)
          sep = `

`;
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
        prevMoreIndented = true;
      } else if (content === "") {
        if (sep === `
`)
          value += `
`;
        else
          sep = `
`;
      } else {
        value += sep + content;
        sep = " ";
        prevMoreIndented = false;
      }
    }
    switch (header.chomp) {
      case "-":
        break;
      case "+":
        for (let i = chompStart;i < lines.length; ++i)
          value += `
` + lines[i][0].slice(trimIndent);
        if (value[value.length - 1] !== `
`)
          value += `
`;
        break;
      default:
        value += `
`;
    }
    const end = start + header.length + scalar.source.length;
    return { value, type, comment: header.comment, range: [start, end, end] };
  }
  function parseBlockScalarHeader({ offset, props }, strict, onError) {
    if (props[0].type !== "block-scalar-header") {
      onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
      return null;
    }
    const { source } = props[0];
    const mode = source[0];
    let indent = 0;
    let chomp = "";
    let error = -1;
    for (let i = 1;i < source.length; ++i) {
      const ch = source[i];
      if (!chomp && (ch === "-" || ch === "+"))
        chomp = ch;
      else {
        const n = Number(ch);
        if (!indent && n)
          indent = n;
        else if (error === -1)
          error = offset + i;
      }
    }
    if (error !== -1)
      onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
    let hasSpace = false;
    let comment = "";
    let length = source.length;
    for (let i = 1;i < props.length; ++i) {
      const token = props[i];
      switch (token.type) {
        case "space":
          hasSpace = true;
        case "newline":
          length += token.source.length;
          break;
        case "comment":
          if (strict && !hasSpace) {
            const message = "Comments must be separated from other tokens by white space characters";
            onError(token, "MISSING_CHAR", message);
          }
          length += token.source.length;
          comment = token.source.substring(1);
          break;
        case "error":
          onError(token, "UNEXPECTED_TOKEN", token.message);
          length += token.source.length;
          break;
        default: {
          const message = `Unexpected token in block scalar header: ${token.type}`;
          onError(token, "UNEXPECTED_TOKEN", message);
          const ts = token.source;
          if (ts && typeof ts === "string")
            length += ts.length;
        }
      }
    }
    return { mode, indent, chomp, comment, length };
  }
  function splitLines(source) {
    const split = source.split(/\n( *)/);
    const first = split[0];
    const m2 = first.match(/^( *)/);
    const line0 = m2?.[1] ? [m2[1], first.slice(m2[1].length)] : ["", first];
    const lines = [line0];
    for (let i = 1;i < split.length; i += 2)
      lines.push([split[i], split[i + 1]]);
    return lines;
  }
  exports.resolveBlockScalar = resolveBlockScalar;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var resolveEnd = require_resolve_end();
  function resolveFlowScalar(scalar, strict, onError) {
    const { offset, type, source, end } = scalar;
    let _type;
    let value;
    const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
    switch (type) {
      case "scalar":
        _type = Scalar.Scalar.PLAIN;
        value = plainValue(source, _onError);
        break;
      case "single-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_SINGLE;
        value = singleQuotedValue(source, _onError);
        break;
      case "double-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_DOUBLE;
        value = doubleQuotedValue(source, _onError);
        break;
      default:
        onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
        return {
          value: "",
          type: null,
          comment: "",
          range: [offset, offset + source.length, offset + source.length]
        };
    }
    const valueEnd = offset + source.length;
    const re2 = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
    return {
      value,
      type: _type,
      comment: re2.comment,
      range: [offset, valueEnd, re2.offset]
    };
  }
  function plainValue(source, onError) {
    let badChar = "";
    switch (source[0]) {
      case "\t":
        badChar = "a tab character";
        break;
      case ",":
        badChar = "flow indicator character ,";
        break;
      case "%":
        badChar = "directive indicator character %";
        break;
      case "|":
      case ">": {
        badChar = `block scalar indicator ${source[0]}`;
        break;
      }
      case "@":
      case "`": {
        badChar = `reserved character ${source[0]}`;
        break;
      }
    }
    if (badChar)
      onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
    return foldLines(source);
  }
  function singleQuotedValue(source, onError) {
    if (source[source.length - 1] !== "'" || source.length === 1)
      onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
    return foldLines(source.slice(1, -1)).replace(/''/g, "'");
  }
  function foldLines(source) {
    let first, line;
    try {
      first = new RegExp(`(.*?)(?<![ 	])[ 	]*\r?
`, "sy");
      line = new RegExp(`[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?
`, "sy");
    } catch {
      first = /(.*?)[ \t]*\r?\n/sy;
      line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
    }
    let match = first.exec(source);
    if (!match)
      return source;
    let res = match[1];
    let sep = " ";
    let pos = first.lastIndex;
    line.lastIndex = pos;
    while (match = line.exec(source)) {
      if (match[1] === "") {
        if (sep === `
`)
          res += sep;
        else
          sep = `
`;
      } else {
        res += sep + match[1];
        sep = " ";
      }
      pos = line.lastIndex;
    }
    const last = /[ \t]*(.*)/sy;
    last.lastIndex = pos;
    match = last.exec(source);
    return res + sep + (match?.[1] ?? "");
  }
  function doubleQuotedValue(source, onError) {
    let res = "";
    for (let i = 1;i < source.length - 1; ++i) {
      const ch = source[i];
      if (ch === "\r" && source[i + 1] === `
`)
        continue;
      if (ch === `
`) {
        const { fold, offset } = foldNewline(source, i);
        res += fold;
        i = offset;
      } else if (ch === "\\") {
        let next = source[++i];
        const cc = escapeCodes[next];
        if (cc)
          res += cc;
        else if (next === `
`) {
          next = source[i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "\r" && source[i + 1] === `
`) {
          next = source[++i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "x" || next === "u" || next === "U") {
          const length = { x: 2, u: 4, U: 8 }[next];
          res += parseCharCode(source, i + 1, length, onError);
          i += length;
        } else {
          const raw = source.substr(i - 1, 2);
          onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
          res += raw;
        }
      } else if (ch === " " || ch === "\t") {
        const wsStart = i;
        let next = source[i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
        if (next !== `
` && !(next === "\r" && source[i + 2] === `
`))
          res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
      } else {
        res += ch;
      }
    }
    if (source[source.length - 1] !== '"' || source.length === 1)
      onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
    return res;
  }
  function foldNewline(source, offset) {
    let fold = "";
    let ch = source[offset + 1];
    while (ch === " " || ch === "\t" || ch === `
` || ch === "\r") {
      if (ch === "\r" && source[offset + 2] !== `
`)
        break;
      if (ch === `
`)
        fold += `
`;
      offset += 1;
      ch = source[offset + 1];
    }
    if (!fold)
      fold = " ";
    return { fold, offset };
  }
  var escapeCodes = {
    "0": "\x00",
    a: "\x07",
    b: "\b",
    e: "\x1B",
    f: "\f",
    n: `
`,
    r: "\r",
    t: "\t",
    v: "\v",
    N: "",
    _: " ",
    L: "\u2028",
    P: "\u2029",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    "\t": "\t"
  };
  function parseCharCode(source, offset, length, onError) {
    const cc = source.substr(offset, length);
    const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
    const code = ok ? parseInt(cc, 16) : NaN;
    if (isNaN(code)) {
      const raw = source.substr(offset - 2, length + 2);
      onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
      return raw;
    }
    return String.fromCodePoint(code);
  }
  exports.resolveFlowScalar = resolveFlowScalar;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  function composeScalar(ctx, token, tagToken, onError) {
    const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
    const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
    let tag;
    if (ctx.options.stringKeys && ctx.atKey) {
      tag = ctx.schema[identity.SCALAR];
    } else if (tagName)
      tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
    else if (token.type === "scalar")
      tag = findScalarTagByTest(ctx, value, token, onError);
    else
      tag = ctx.schema[identity.SCALAR];
    let scalar;
    try {
      const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
      scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
      scalar = new Scalar.Scalar(value);
    }
    scalar.range = range;
    scalar.source = value;
    if (type)
      scalar.type = type;
    if (tagName)
      scalar.tag = tagName;
    if (tag.format)
      scalar.format = tag.format;
    if (comment)
      scalar.comment = comment;
    return scalar;
  }
  function findScalarTagByName(schema, value, tagName, tagToken, onError) {
    if (tagName === "!")
      return schema[identity.SCALAR];
    const matchWithTest = [];
    for (const tag of schema.tags) {
      if (!tag.collection && tag.tag === tagName) {
        if (tag.default && tag.test)
          matchWithTest.push(tag);
        else
          return tag;
      }
    }
    for (const tag of matchWithTest)
      if (tag.test?.test(value))
        return tag;
    const kt = schema.knownTags[tagName];
    if (kt && !kt.collection) {
      schema.tags.push(Object.assign({}, kt, { default: false, test: undefined }));
      return kt;
    }
    onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
    return schema[identity.SCALAR];
  }
  function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
    const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
    if (schema.compat) {
      const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
      if (tag.tag !== compat.tag) {
        const ts = directives.tagString(tag.tag);
        const cs = directives.tagString(compat.tag);
        const msg = `Value may be parsed as either ${ts} or ${cs}`;
        onError(token, "TAG_RESOLVE_FAILED", msg, true);
      }
    }
    return tag;
  }
  exports.composeScalar = composeScalar;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS((exports) => {
  function emptyScalarPosition(offset, before, pos) {
    if (before) {
      pos ?? (pos = before.length);
      for (let i = pos - 1;i >= 0; --i) {
        let st = before[i];
        switch (st.type) {
          case "space":
          case "comment":
          case "newline":
            offset -= st.source.length;
            continue;
        }
        st = before[++i];
        while (st?.type === "space") {
          offset += st.source.length;
          st = before[++i];
        }
        break;
      }
    }
    return offset;
  }
  exports.emptyScalarPosition = emptyScalarPosition;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS((exports) => {
  var Alias = require_Alias();
  var identity = require_identity();
  var composeCollection = require_compose_collection();
  var composeScalar = require_compose_scalar();
  var resolveEnd = require_resolve_end();
  var utilEmptyScalarPosition = require_util_empty_scalar_position();
  var CN = { composeNode, composeEmptyNode };
  function composeNode(ctx, token, props, onError) {
    const atKey = ctx.atKey;
    const { spaceBefore, comment, anchor, tag } = props;
    let node;
    let isSrcToken = true;
    switch (token.type) {
      case "alias":
        node = composeAlias(ctx, token, onError);
        if (anchor || tag)
          onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
        break;
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "block-scalar":
        node = composeScalar.composeScalar(ctx, token, tag, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
        break;
      case "block-map":
      case "block-seq":
      case "flow-collection":
        node = composeCollection.composeCollection(CN, ctx, token, props, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
        break;
      default: {
        const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
        onError(token, "UNEXPECTED_TOKEN", message);
        node = composeEmptyNode(ctx, token.offset, undefined, null, props, onError);
        isSrcToken = false;
      }
    }
    if (anchor && node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
      const msg = "With stringKeys, all keys must be strings";
      onError(tag ?? token, "NON_STRING_KEY", msg);
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      if (token.type === "scalar" && token.source === "")
        node.comment = comment;
      else
        node.commentBefore = comment;
    }
    if (ctx.options.keepSourceTokens && isSrcToken)
      node.srcToken = token;
    return node;
  }
  function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
    const token = {
      type: "scalar",
      offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
      indent: -1,
      source: ""
    };
    const node = composeScalar.composeScalar(ctx, token, tag, onError);
    if (anchor) {
      node.anchor = anchor.source.substring(1);
      if (node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      node.comment = comment;
      node.range[2] = end;
    }
    return node;
  }
  function composeAlias({ options }, { offset, source, end }, onError) {
    const alias = new Alias.Alias(source.substring(1));
    if (alias.source === "")
      onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
    if (alias.source.endsWith(":"))
      onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
    const valueEnd = offset + source.length;
    const re2 = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
    alias.range = [offset, valueEnd, re2.offset];
    if (re2.comment)
      alias.comment = re2.comment;
    return alias;
  }
  exports.composeEmptyNode = composeEmptyNode;
  exports.composeNode = composeNode;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS((exports) => {
  var Document = require_Document();
  var composeNode = require_compose_node();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  function composeDoc(options, directives, { offset, start, value, end }, onError) {
    const opts = Object.assign({ _directives: directives }, options);
    const doc = new Document.Document(undefined, opts);
    const ctx = {
      atKey: false,
      atRoot: true,
      directives: doc.directives,
      options: doc.options,
      schema: doc.schema
    };
    const props = resolveProps.resolveProps(start, {
      indicator: "doc-start",
      next: value ?? end?.[0],
      offset,
      onError,
      parentIndent: 0,
      startOnNewline: true
    });
    if (props.found) {
      doc.directives.docStart = true;
      if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
        onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
    }
    doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
    const contentEnd = doc.contents.range[2];
    const re2 = resolveEnd.resolveEnd(end, contentEnd, false, onError);
    if (re2.comment)
      doc.comment = re2.comment;
    doc.range = [offset, contentEnd, re2.offset];
    return doc;
  }
  exports.composeDoc = composeDoc;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS((exports) => {
  var node_process = __require("process");
  var directives = require_directives();
  var Document = require_Document();
  var errors = require_errors();
  var identity = require_identity();
  var composeDoc = require_compose_doc();
  var resolveEnd = require_resolve_end();
  function getErrorPos(src) {
    if (typeof src === "number")
      return [src, src + 1];
    if (Array.isArray(src))
      return src.length === 2 ? src : [src[0], src[1]];
    const { offset, source } = src;
    return [offset, offset + (typeof source === "string" ? source.length : 1)];
  }
  function parsePrelude(prelude) {
    let comment = "";
    let atComment = false;
    let afterEmptyLine = false;
    for (let i = 0;i < prelude.length; ++i) {
      const source = prelude[i];
      switch (source[0]) {
        case "#":
          comment += (comment === "" ? "" : afterEmptyLine ? `

` : `
`) + (source.substring(1) || " ");
          atComment = true;
          afterEmptyLine = false;
          break;
        case "%":
          if (prelude[i + 1]?.[0] !== "#")
            i += 1;
          atComment = false;
          break;
        default:
          if (!atComment)
            afterEmptyLine = true;
          atComment = false;
      }
    }
    return { comment, afterEmptyLine };
  }

  class Composer {
    constructor(options = {}) {
      this.doc = null;
      this.atDirectives = false;
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
      this.onError = (source, code, message, warning) => {
        const pos = getErrorPos(source);
        if (warning)
          this.warnings.push(new errors.YAMLWarning(pos, code, message));
        else
          this.errors.push(new errors.YAMLParseError(pos, code, message));
      };
      this.directives = new directives.Directives({ version: options.version || "1.2" });
      this.options = options;
    }
    decorate(doc, afterDoc) {
      const { comment, afterEmptyLine } = parsePrelude(this.prelude);
      if (comment) {
        const dc = doc.contents;
        if (afterDoc) {
          doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
        } else if (afterEmptyLine || doc.directives.docStart || !dc) {
          doc.commentBefore = comment;
        } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
          let it = dc.items[0];
          if (identity.isPair(it))
            it = it.key;
          const cb = it.commentBefore;
          it.commentBefore = cb ? `${comment}
${cb}` : comment;
        } else {
          const cb = dc.commentBefore;
          dc.commentBefore = cb ? `${comment}
${cb}` : comment;
        }
      }
      if (afterDoc) {
        Array.prototype.push.apply(doc.errors, this.errors);
        Array.prototype.push.apply(doc.warnings, this.warnings);
      } else {
        doc.errors = this.errors;
        doc.warnings = this.warnings;
      }
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
    }
    streamInfo() {
      return {
        comment: parsePrelude(this.prelude).comment,
        directives: this.directives,
        errors: this.errors,
        warnings: this.warnings
      };
    }
    *compose(tokens, forceDoc = false, endOffset = -1) {
      for (const token of tokens)
        yield* this.next(token);
      yield* this.end(forceDoc, endOffset);
    }
    *next(token) {
      if (node_process.env.LOG_STREAM)
        console.dir(token, { depth: null });
      switch (token.type) {
        case "directive":
          this.directives.add(token.source, (offset, message, warning) => {
            const pos = getErrorPos(token);
            pos[0] += offset;
            this.onError(pos, "BAD_DIRECTIVE", message, warning);
          });
          this.prelude.push(token.source);
          this.atDirectives = true;
          break;
        case "document": {
          const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
          if (this.atDirectives && !doc.directives.docStart)
            this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
          this.decorate(doc, false);
          if (this.doc)
            yield this.doc;
          this.doc = doc;
          this.atDirectives = false;
          break;
        }
        case "byte-order-mark":
        case "space":
          break;
        case "comment":
        case "newline":
          this.prelude.push(token.source);
          break;
        case "error": {
          const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
          const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
          if (this.atDirectives || !this.doc)
            this.errors.push(error);
          else
            this.doc.errors.push(error);
          break;
        }
        case "doc-end": {
          if (!this.doc) {
            const msg = "Unexpected doc-end without preceding document";
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
            break;
          }
          this.doc.directives.docEnd = true;
          const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
          this.decorate(this.doc, true);
          if (end.comment) {
            const dc = this.doc.comment;
            this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
          }
          this.doc.range[2] = end.offset;
          break;
        }
        default:
          this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
      }
    }
    *end(forceDoc = false, endOffset = -1) {
      if (this.doc) {
        this.decorate(this.doc, true);
        yield this.doc;
        this.doc = null;
      } else if (forceDoc) {
        const opts = Object.assign({ _directives: this.directives }, this.options);
        const doc = new Document.Document(undefined, opts);
        if (this.atDirectives)
          this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
        doc.range = [0, endOffset, endOffset];
        this.decorate(doc, false);
        yield doc;
      }
    }
  }
  exports.Composer = Composer;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS((exports) => {
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  var errors = require_errors();
  var stringifyString = require_stringifyString();
  function resolveAsScalar(token, strict = true, onError) {
    if (token) {
      const _onError = (pos, code, message) => {
        const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
        if (onError)
          onError(offset, code, message);
        else
          throw new errors.YAMLParseError([offset, offset + 1], code, message);
      };
      switch (token.type) {
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
        case "block-scalar":
          return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
      }
    }
    return null;
  }
  function createScalarToken(value, context) {
    const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey,
      indent: indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    const end = context.end ?? [
      { type: "newline", offset: -1, indent, source: `
` }
    ];
    switch (source[0]) {
      case "|":
      case ">": {
        const he2 = source.indexOf(`
`);
        const head = source.substring(0, he2);
        const body = source.substring(he2 + 1) + `
`;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, end))
          props.push({ type: "newline", offset: -1, indent, source: `
` });
        return { type: "block-scalar", offset, indent, props, source: body };
      }
      case '"':
        return { type: "double-quoted-scalar", offset, indent, source, end };
      case "'":
        return { type: "single-quoted-scalar", offset, indent, source, end };
      default:
        return { type: "scalar", offset, indent, source, end };
    }
  }
  function setScalarValue(token, value, context = {}) {
    let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
    let indent = "indent" in token ? token.indent : null;
    if (afterKey && typeof indent === "number")
      indent += 2;
    if (!type)
      switch (token.type) {
        case "single-quoted-scalar":
          type = "QUOTE_SINGLE";
          break;
        case "double-quoted-scalar":
          type = "QUOTE_DOUBLE";
          break;
        case "block-scalar": {
          const header = token.props[0];
          if (header.type !== "block-scalar-header")
            throw new Error("Invalid block scalar header");
          type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
          break;
        }
        default:
          type = "PLAIN";
      }
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey: implicitKey || indent === null,
      indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    switch (source[0]) {
      case "|":
      case ">":
        setBlockScalarValue(token, source);
        break;
      case '"':
        setFlowScalarValue(token, source, "double-quoted-scalar");
        break;
      case "'":
        setFlowScalarValue(token, source, "single-quoted-scalar");
        break;
      default:
        setFlowScalarValue(token, source, "scalar");
    }
  }
  function setBlockScalarValue(token, source) {
    const he2 = source.indexOf(`
`);
    const head = source.substring(0, he2);
    const body = source.substring(he2 + 1) + `
`;
    if (token.type === "block-scalar") {
      const header = token.props[0];
      if (header.type !== "block-scalar-header")
        throw new Error("Invalid block scalar header");
      header.source = head;
      token.source = body;
    } else {
      const { offset } = token;
      const indent = "indent" in token ? token.indent : -1;
      const props = [
        { type: "block-scalar-header", offset, indent, source: head }
      ];
      if (!addEndtoBlockProps(props, "end" in token ? token.end : undefined))
        props.push({ type: "newline", offset: -1, indent, source: `
` });
      for (const key of Object.keys(token))
        if (key !== "type" && key !== "offset")
          delete token[key];
      Object.assign(token, { type: "block-scalar", indent, props, source: body });
    }
  }
  function addEndtoBlockProps(props, end) {
    if (end)
      for (const st of end)
        switch (st.type) {
          case "space":
          case "comment":
            props.push(st);
            break;
          case "newline":
            props.push(st);
            return true;
        }
    return false;
  }
  function setFlowScalarValue(token, source, type) {
    switch (token.type) {
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        token.type = type;
        token.source = source;
        break;
      case "block-scalar": {
        const end = token.props.slice(1);
        let oa = source.length;
        if (token.props[0].type === "block-scalar-header")
          oa -= token.props[0].source.length;
        for (const tok of end)
          tok.offset += oa;
        delete token.props;
        Object.assign(token, { type, source, end });
        break;
      }
      case "block-map":
      case "block-seq": {
        const offset = token.offset + source.length;
        const nl = { type: "newline", offset, indent: token.indent, source: `
` };
        delete token.items;
        Object.assign(token, { type, source, end: [nl] });
        break;
      }
      default: {
        const indent = "indent" in token ? token.indent : -1;
        const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type, indent, source, end });
      }
    }
  }
  exports.createScalarToken = createScalarToken;
  exports.resolveAsScalar = resolveAsScalar;
  exports.setScalarValue = setScalarValue;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS((exports) => {
  var stringify = (cst) => ("type" in cst) ? stringifyToken(cst) : stringifyItem(cst);
  function stringifyToken(token) {
    switch (token.type) {
      case "block-scalar": {
        let res = "";
        for (const tok of token.props)
          res += stringifyToken(tok);
        return res + token.source;
      }
      case "block-map":
      case "block-seq": {
        let res = "";
        for (const item of token.items)
          res += stringifyItem(item);
        return res;
      }
      case "flow-collection": {
        let res = token.start.source;
        for (const item of token.items)
          res += stringifyItem(item);
        for (const st of token.end)
          res += st.source;
        return res;
      }
      case "document": {
        let res = stringifyItem(token);
        if (token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
      default: {
        let res = token.source;
        if ("end" in token && token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
    }
  }
  function stringifyItem({ start, key, sep, value }) {
    let res = "";
    for (const st of start)
      res += st.source;
    if (key)
      res += stringifyToken(key);
    if (sep)
      for (const st of sep)
        res += st.source;
    if (value)
      res += stringifyToken(value);
    return res;
  }
  exports.stringify = stringify;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS((exports) => {
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove item");
  function visit(cst, visitor) {
    if ("type" in cst && cst.type === "document")
      cst = { start: cst.start, value: cst.value };
    _visit(Object.freeze([]), cst, visitor);
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  visit.itemAtPath = (cst, path) => {
    let item = cst;
    for (const [field, index] of path) {
      const tok = item?.[field];
      if (tok && "items" in tok) {
        item = tok.items[index];
      } else
        return;
    }
    return item;
  };
  visit.parentCollection = (cst, path) => {
    const parent = visit.itemAtPath(cst, path.slice(0, -1));
    const field = path[path.length - 1][0];
    const coll = parent?.[field];
    if (coll && "items" in coll)
      return coll;
    throw new Error("Parent collection not found");
  };
  function _visit(path, item, visitor) {
    let ctrl = visitor(item, path);
    if (typeof ctrl === "symbol")
      return ctrl;
    for (const field of ["key", "value"]) {
      const token = item[field];
      if (token && "items" in token) {
        for (let i = 0;i < token.items.length; ++i) {
          const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            token.items.splice(i, 1);
            i -= 1;
          }
        }
        if (typeof ctrl === "function" && field === "key")
          ctrl = ctrl(item, path);
      }
    }
    return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
  }
  exports.visit = visit;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS((exports) => {
  var cstScalar = require_cst_scalar();
  var cstStringify = require_cst_stringify();
  var cstVisit = require_cst_visit();
  var BOM = "\uFEFF";
  var DOCUMENT = "\x02";
  var FLOW_END = "\x18";
  var SCALAR = "\x1F";
  var isCollection = (token) => !!token && ("items" in token);
  var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
  function prettyToken(token) {
    switch (token) {
      case BOM:
        return "<BOM>";
      case DOCUMENT:
        return "<DOC>";
      case FLOW_END:
        return "<FLOW_END>";
      case SCALAR:
        return "<SCALAR>";
      default:
        return JSON.stringify(token);
    }
  }
  function tokenType(source) {
    switch (source) {
      case BOM:
        return "byte-order-mark";
      case DOCUMENT:
        return "doc-mode";
      case FLOW_END:
        return "flow-error-end";
      case SCALAR:
        return "scalar";
      case "---":
        return "doc-start";
      case "...":
        return "doc-end";
      case "":
      case `
`:
      case `\r
`:
        return "newline";
      case "-":
        return "seq-item-ind";
      case "?":
        return "explicit-key-ind";
      case ":":
        return "map-value-ind";
      case "{":
        return "flow-map-start";
      case "}":
        return "flow-map-end";
      case "[":
        return "flow-seq-start";
      case "]":
        return "flow-seq-end";
      case ",":
        return "comma";
    }
    switch (source[0]) {
      case " ":
      case "\t":
        return "space";
      case "#":
        return "comment";
      case "%":
        return "directive-line";
      case "*":
        return "alias";
      case "&":
        return "anchor";
      case "!":
        return "tag";
      case "'":
        return "single-quoted-scalar";
      case '"':
        return "double-quoted-scalar";
      case "|":
      case ">":
        return "block-scalar-header";
    }
    return null;
  }
  exports.createScalarToken = cstScalar.createScalarToken;
  exports.resolveAsScalar = cstScalar.resolveAsScalar;
  exports.setScalarValue = cstScalar.setScalarValue;
  exports.stringify = cstStringify.stringify;
  exports.visit = cstVisit.visit;
  exports.BOM = BOM;
  exports.DOCUMENT = DOCUMENT;
  exports.FLOW_END = FLOW_END;
  exports.SCALAR = SCALAR;
  exports.isCollection = isCollection;
  exports.isScalar = isScalar;
  exports.prettyToken = prettyToken;
  exports.tokenType = tokenType;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS((exports) => {
  var cst = require_cst();
  function isEmpty(ch) {
    switch (ch) {
      case undefined:
      case " ":
      case `
`:
      case "\r":
      case "\t":
        return true;
      default:
        return false;
    }
  }
  var hexDigits = new Set("0123456789ABCDEFabcdef");
  var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
  var flowIndicatorChars = new Set(",[]{}");
  var invalidAnchorChars = new Set(` ,[]{}
\r	`);
  var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);

  class Lexer {
    constructor() {
      this.atEnd = false;
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      this.buffer = "";
      this.flowKey = false;
      this.flowLevel = 0;
      this.indentNext = 0;
      this.indentValue = 0;
      this.lineEndPos = null;
      this.next = null;
      this.pos = 0;
    }
    *lex(source, incomplete = false) {
      if (source) {
        if (typeof source !== "string")
          throw TypeError("source is not a string");
        this.buffer = this.buffer ? this.buffer + source : source;
        this.lineEndPos = null;
      }
      this.atEnd = !incomplete;
      let next = this.next ?? "stream";
      while (next && (incomplete || this.hasChars(1)))
        next = yield* this.parseNext(next);
    }
    atLineEnd() {
      let i = this.pos;
      let ch = this.buffer[i];
      while (ch === " " || ch === "\t")
        ch = this.buffer[++i];
      if (!ch || ch === "#" || ch === `
`)
        return true;
      if (ch === "\r")
        return this.buffer[i + 1] === `
`;
      return false;
    }
    charAt(n) {
      return this.buffer[this.pos + n];
    }
    continueScalar(offset) {
      let ch = this.buffer[offset];
      if (this.indentNext > 0) {
        let indent = 0;
        while (ch === " ")
          ch = this.buffer[++indent + offset];
        if (ch === "\r") {
          const next = this.buffer[indent + offset + 1];
          if (next === `
` || !next && !this.atEnd)
            return offset + indent + 1;
        }
        return ch === `
` || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
      }
      if (ch === "-" || ch === ".") {
        const dt = this.buffer.substr(offset, 3);
        if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
          return -1;
      }
      return offset;
    }
    getLine() {
      let end = this.lineEndPos;
      if (typeof end !== "number" || end !== -1 && end < this.pos) {
        end = this.buffer.indexOf(`
`, this.pos);
        this.lineEndPos = end;
      }
      if (end === -1)
        return this.atEnd ? this.buffer.substring(this.pos) : null;
      if (this.buffer[end - 1] === "\r")
        end -= 1;
      return this.buffer.substring(this.pos, end);
    }
    hasChars(n) {
      return this.pos + n <= this.buffer.length;
    }
    setNext(state) {
      this.buffer = this.buffer.substring(this.pos);
      this.pos = 0;
      this.lineEndPos = null;
      this.next = state;
      return null;
    }
    peek(n) {
      return this.buffer.substr(this.pos, n);
    }
    *parseNext(next) {
      switch (next) {
        case "stream":
          return yield* this.parseStream();
        case "line-start":
          return yield* this.parseLineStart();
        case "block-start":
          return yield* this.parseBlockStart();
        case "doc":
          return yield* this.parseDocument();
        case "flow":
          return yield* this.parseFlowCollection();
        case "quoted-scalar":
          return yield* this.parseQuotedScalar();
        case "block-scalar":
          return yield* this.parseBlockScalar();
        case "plain-scalar":
          return yield* this.parsePlainScalar();
      }
    }
    *parseStream() {
      let line = this.getLine();
      if (line === null)
        return this.setNext("stream");
      if (line[0] === cst.BOM) {
        yield* this.pushCount(1);
        line = line.substring(1);
      }
      if (line[0] === "%") {
        let dirEnd = line.length;
        let cs = line.indexOf("#");
        while (cs !== -1) {
          const ch = line[cs - 1];
          if (ch === " " || ch === "\t") {
            dirEnd = cs - 1;
            break;
          } else {
            cs = line.indexOf("#", cs + 1);
          }
        }
        while (true) {
          const ch = line[dirEnd - 1];
          if (ch === " " || ch === "\t")
            dirEnd -= 1;
          else
            break;
        }
        const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
        yield* this.pushCount(line.length - n);
        this.pushNewline();
        return "stream";
      }
      if (this.atLineEnd()) {
        const sp = yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - sp);
        yield* this.pushNewline();
        return "stream";
      }
      yield cst.DOCUMENT;
      return yield* this.parseLineStart();
    }
    *parseLineStart() {
      const ch = this.charAt(0);
      if (!ch && !this.atEnd)
        return this.setNext("line-start");
      if (ch === "-" || ch === ".") {
        if (!this.atEnd && !this.hasChars(4))
          return this.setNext("line-start");
        const s = this.peek(3);
        if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
          yield* this.pushCount(3);
          this.indentValue = 0;
          this.indentNext = 0;
          return s === "---" ? "doc" : "stream";
        }
      }
      this.indentValue = yield* this.pushSpaces(false);
      if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
        this.indentNext = this.indentValue;
      return yield* this.parseBlockStart();
    }
    *parseBlockStart() {
      const [ch0, ch1] = this.peek(2);
      if (!ch1 && !this.atEnd)
        return this.setNext("block-start");
      if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
        const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
        this.indentNext = this.indentValue + 1;
        this.indentValue += n;
        return yield* this.parseBlockStart();
      }
      return "doc";
    }
    *parseDocument() {
      yield* this.pushSpaces(true);
      const line = this.getLine();
      if (line === null)
        return this.setNext("doc");
      let n = yield* this.pushIndicators();
      switch (line[n]) {
        case "#":
          yield* this.pushCount(line.length - n);
        case undefined:
          yield* this.pushNewline();
          return yield* this.parseLineStart();
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel = 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          return "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "doc";
        case '"':
        case "'":
          return yield* this.parseQuotedScalar();
        case "|":
        case ">":
          n += yield* this.parseBlockScalarHeader();
          n += yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - n);
          yield* this.pushNewline();
          return yield* this.parseBlockScalar();
        default:
          return yield* this.parsePlainScalar();
      }
    }
    *parseFlowCollection() {
      let nl, sp;
      let indent = -1;
      do {
        nl = yield* this.pushNewline();
        if (nl > 0) {
          sp = yield* this.pushSpaces(false);
          this.indentValue = indent = sp;
        } else {
          sp = 0;
        }
        sp += yield* this.pushSpaces(true);
      } while (nl + sp > 0);
      const line = this.getLine();
      if (line === null)
        return this.setNext("flow");
      if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
        const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
        if (!atFlowEndMarker) {
          this.flowLevel = 0;
          yield cst.FLOW_END;
          return yield* this.parseLineStart();
        }
      }
      let n = 0;
      while (line[n] === ",") {
        n += yield* this.pushCount(1);
        n += yield* this.pushSpaces(true);
        this.flowKey = false;
      }
      n += yield* this.pushIndicators();
      switch (line[n]) {
        case undefined:
          return "flow";
        case "#":
          yield* this.pushCount(line.length - n);
          return "flow";
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel += 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          this.flowKey = true;
          this.flowLevel -= 1;
          return this.flowLevel ? "flow" : "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "flow";
        case '"':
        case "'":
          this.flowKey = true;
          return yield* this.parseQuotedScalar();
        case ":": {
          const next = this.charAt(1);
          if (this.flowKey || isEmpty(next) || next === ",") {
            this.flowKey = false;
            yield* this.pushCount(1);
            yield* this.pushSpaces(true);
            return "flow";
          }
        }
        default:
          this.flowKey = false;
          return yield* this.parsePlainScalar();
      }
    }
    *parseQuotedScalar() {
      const quote = this.charAt(0);
      let end = this.buffer.indexOf(quote, this.pos + 1);
      if (quote === "'") {
        while (end !== -1 && this.buffer[end + 1] === "'")
          end = this.buffer.indexOf("'", end + 2);
      } else {
        while (end !== -1) {
          let n = 0;
          while (this.buffer[end - 1 - n] === "\\")
            n += 1;
          if (n % 2 === 0)
            break;
          end = this.buffer.indexOf('"', end + 1);
        }
      }
      const qb = this.buffer.substring(0, end);
      let nl = qb.indexOf(`
`, this.pos);
      if (nl !== -1) {
        while (nl !== -1) {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = qb.indexOf(`
`, cs);
        }
        if (nl !== -1) {
          end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
        }
      }
      if (end === -1) {
        if (!this.atEnd)
          return this.setNext("quoted-scalar");
        end = this.buffer.length;
      }
      yield* this.pushToIndex(end + 1, false);
      return this.flowLevel ? "flow" : "doc";
    }
    *parseBlockScalarHeader() {
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      let i = this.pos;
      while (true) {
        const ch = this.buffer[++i];
        if (ch === "+")
          this.blockScalarKeep = true;
        else if (ch > "0" && ch <= "9")
          this.blockScalarIndent = Number(ch) - 1;
        else if (ch !== "-")
          break;
      }
      return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
    }
    *parseBlockScalar() {
      let nl = this.pos - 1;
      let indent = 0;
      let ch;
      loop:
        for (let i2 = this.pos;ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case `
`:
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === `
`)
                break;
            }
            default:
              break loop;
          }
        }
      if (!ch && !this.atEnd)
        return this.setNext("block-scalar");
      if (indent >= this.indentNext) {
        if (this.blockScalarIndent === -1)
          this.indentNext = indent;
        else {
          this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
        }
        do {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = this.buffer.indexOf(`
`, cs);
        } while (nl !== -1);
        if (nl === -1) {
          if (!this.atEnd)
            return this.setNext("block-scalar");
          nl = this.buffer.length;
        }
      }
      let i = nl + 1;
      ch = this.buffer[i];
      while (ch === " ")
        ch = this.buffer[++i];
      if (ch === "\t") {
        while (ch === "\t" || ch === " " || ch === "\r" || ch === `
`)
          ch = this.buffer[++i];
        nl = i - 1;
      } else if (!this.blockScalarKeep) {
        do {
          let i2 = nl - 1;
          let ch2 = this.buffer[i2];
          if (ch2 === "\r")
            ch2 = this.buffer[--i2];
          const lastChar = i2;
          while (ch2 === " ")
            ch2 = this.buffer[--i2];
          if (ch2 === `
` && i2 >= this.pos && i2 + 1 + indent > lastChar)
            nl = i2;
          else
            break;
        } while (true);
      }
      yield cst.SCALAR;
      yield* this.pushToIndex(nl + 1, true);
      return yield* this.parseLineStart();
    }
    *parsePlainScalar() {
      const inFlow = this.flowLevel > 0;
      let end = this.pos - 1;
      let i = this.pos - 1;
      let ch;
      while (ch = this.buffer[++i]) {
        if (ch === ":") {
          const next = this.buffer[i + 1];
          if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
            break;
          end = i;
        } else if (isEmpty(ch)) {
          let next = this.buffer[i + 1];
          if (ch === "\r") {
            if (next === `
`) {
              i += 1;
              ch = `
`;
              next = this.buffer[i + 1];
            } else
              end = i;
          }
          if (next === "#" || inFlow && flowIndicatorChars.has(next))
            break;
          if (ch === `
`) {
            const cs = this.continueScalar(i + 1);
            if (cs === -1)
              break;
            i = Math.max(i, cs - 2);
          }
        } else {
          if (inFlow && flowIndicatorChars.has(ch))
            break;
          end = i;
        }
      }
      if (!ch && !this.atEnd)
        return this.setNext("plain-scalar");
      yield cst.SCALAR;
      yield* this.pushToIndex(end + 1, true);
      return inFlow ? "flow" : "doc";
    }
    *pushCount(n) {
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos += n;
        return n;
      }
      return 0;
    }
    *pushToIndex(i, allowEmpty) {
      const s = this.buffer.slice(this.pos, i);
      if (s) {
        yield s;
        this.pos += s.length;
        return s.length;
      } else if (allowEmpty)
        yield "";
      return 0;
    }
    *pushIndicators() {
      switch (this.charAt(0)) {
        case "!":
          return (yield* this.pushTag()) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        case "&":
          return (yield* this.pushUntil(isNotAnchorChar)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        case "-":
        case "?":
        case ":": {
          const inFlow = this.flowLevel > 0;
          const ch1 = this.charAt(1);
          if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
            if (!inFlow)
              this.indentNext = this.indentValue + 1;
            else if (this.flowKey)
              this.flowKey = false;
            return (yield* this.pushCount(1)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
          }
        }
      }
      return 0;
    }
    *pushTag() {
      if (this.charAt(1) === "<") {
        let i = this.pos + 2;
        let ch = this.buffer[i];
        while (!isEmpty(ch) && ch !== ">")
          ch = this.buffer[++i];
        return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
      } else {
        let i = this.pos + 1;
        let ch = this.buffer[i];
        while (ch) {
          if (tagChars.has(ch))
            ch = this.buffer[++i];
          else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
            ch = this.buffer[i += 3];
          } else
            break;
        }
        return yield* this.pushToIndex(i, false);
      }
    }
    *pushNewline() {
      const ch = this.buffer[this.pos];
      if (ch === `
`)
        return yield* this.pushCount(1);
      else if (ch === "\r" && this.charAt(1) === `
`)
        return yield* this.pushCount(2);
      else
        return 0;
    }
    *pushSpaces(allowTabs) {
      let i = this.pos - 1;
      let ch;
      do {
        ch = this.buffer[++i];
      } while (ch === " " || allowTabs && ch === "\t");
      const n = i - this.pos;
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos = i;
      }
      return n;
    }
    *pushUntil(test) {
      let i = this.pos;
      let ch = this.buffer[i];
      while (!test(ch))
        ch = this.buffer[++i];
      return yield* this.pushToIndex(i, false);
    }
  }
  exports.Lexer = Lexer;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS((exports) => {
  class LineCounter {
    constructor() {
      this.lineStarts = [];
      this.addNewLine = (offset) => this.lineStarts.push(offset);
      this.linePos = (offset) => {
        let low = 0;
        let high = this.lineStarts.length;
        while (low < high) {
          const mid = low + high >> 1;
          if (this.lineStarts[mid] < offset)
            low = mid + 1;
          else
            high = mid;
        }
        if (this.lineStarts[low] === offset)
          return { line: low + 1, col: 1 };
        if (low === 0)
          return { line: 0, col: offset };
        const start = this.lineStarts[low - 1];
        return { line: low, col: offset - start + 1 };
      };
    }
  }
  exports.LineCounter = LineCounter;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS((exports) => {
  var node_process = __require("process");
  var cst = require_cst();
  var lexer = require_lexer();
  function includesToken(list, type) {
    for (let i = 0;i < list.length; ++i)
      if (list[i].type === type)
        return true;
    return false;
  }
  function findNonEmptyIndex(list) {
    for (let i = 0;i < list.length; ++i) {
      switch (list[i].type) {
        case "space":
        case "comment":
        case "newline":
          break;
        default:
          return i;
      }
    }
    return -1;
  }
  function isFlowToken(token) {
    switch (token?.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "flow-collection":
        return true;
      default:
        return false;
    }
  }
  function getPrevProps(parent) {
    switch (parent.type) {
      case "document":
        return parent.start;
      case "block-map": {
        const it = parent.items[parent.items.length - 1];
        return it.sep ?? it.start;
      }
      case "block-seq":
        return parent.items[parent.items.length - 1].start;
      default:
        return [];
    }
  }
  function getFirstKeyStartProps(prev) {
    if (prev.length === 0)
      return [];
    let i = prev.length;
    loop:
      while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
    while (prev[++i]?.type === "space") {}
    return prev.splice(i, prev.length);
  }
  function fixFlowSeqItems(fc) {
    if (fc.start.type === "flow-seq-start") {
      for (const it of fc.items) {
        if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
          if (it.key)
            it.value = it.key;
          delete it.key;
          if (isFlowToken(it.value)) {
            if (it.value.end)
              Array.prototype.push.apply(it.value.end, it.sep);
            else
              it.value.end = it.sep;
          } else
            Array.prototype.push.apply(it.start, it.sep);
          delete it.sep;
        }
      }
    }
  }

  class Parser {
    constructor(onNewLine) {
      this.atNewLine = true;
      this.atScalar = false;
      this.indent = 0;
      this.offset = 0;
      this.onKeyLine = false;
      this.stack = [];
      this.source = "";
      this.type = "";
      this.lexer = new lexer.Lexer;
      this.onNewLine = onNewLine;
    }
    *parse(source, incomplete = false) {
      if (this.onNewLine && this.offset === 0)
        this.onNewLine(0);
      for (const lexeme of this.lexer.lex(source, incomplete))
        yield* this.next(lexeme);
      if (!incomplete)
        yield* this.end();
    }
    *next(source) {
      this.source = source;
      if (node_process.env.LOG_TOKENS)
        console.log("|", cst.prettyToken(source));
      if (this.atScalar) {
        this.atScalar = false;
        yield* this.step();
        this.offset += source.length;
        return;
      }
      const type = cst.tokenType(source);
      if (!type) {
        const message = `Not a YAML token: ${source}`;
        yield* this.pop({ type: "error", offset: this.offset, message, source });
        this.offset += source.length;
      } else if (type === "scalar") {
        this.atNewLine = false;
        this.atScalar = true;
        this.type = "scalar";
      } else {
        this.type = type;
        yield* this.step();
        switch (type) {
          case "newline":
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine)
              this.onNewLine(this.offset + source.length);
            break;
          case "space":
            if (this.atNewLine && source[0] === " ")
              this.indent += source.length;
            break;
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
            if (this.atNewLine)
              this.indent += source.length;
            break;
          case "doc-mode":
          case "flow-error-end":
            return;
          default:
            this.atNewLine = false;
        }
        this.offset += source.length;
      }
    }
    *end() {
      while (this.stack.length > 0)
        yield* this.pop();
    }
    get sourceToken() {
      const st = {
        type: this.type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
      return st;
    }
    *step() {
      const top = this.peek(1);
      if (this.type === "doc-end" && top?.type !== "doc-end") {
        while (this.stack.length > 0)
          yield* this.pop();
        this.stack.push({
          type: "doc-end",
          offset: this.offset,
          source: this.source
        });
        return;
      }
      if (!top)
        return yield* this.stream();
      switch (top.type) {
        case "document":
          return yield* this.document(top);
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return yield* this.scalar(top);
        case "block-scalar":
          return yield* this.blockScalar(top);
        case "block-map":
          return yield* this.blockMap(top);
        case "block-seq":
          return yield* this.blockSequence(top);
        case "flow-collection":
          return yield* this.flowCollection(top);
        case "doc-end":
          return yield* this.documentEnd(top);
      }
      yield* this.pop();
    }
    peek(n) {
      return this.stack[this.stack.length - n];
    }
    *pop(error) {
      const token = error ?? this.stack.pop();
      if (!token) {
        const message = "Tried to pop an empty stack";
        yield { type: "error", offset: this.offset, source: "", message };
      } else if (this.stack.length === 0) {
        yield token;
      } else {
        const top = this.peek(1);
        if (token.type === "block-scalar") {
          token.indent = "indent" in top ? top.indent : 0;
        } else if (token.type === "flow-collection" && top.type === "document") {
          token.indent = 0;
        }
        if (token.type === "flow-collection")
          fixFlowSeqItems(token);
        switch (top.type) {
          case "document":
            top.value = token;
            break;
          case "block-scalar":
            top.props.push(token);
            break;
          case "block-map": {
            const it = top.items[top.items.length - 1];
            if (it.value) {
              top.items.push({ start: [], key: token, sep: [] });
              this.onKeyLine = true;
              return;
            } else if (it.sep) {
              it.value = token;
            } else {
              Object.assign(it, { key: token, sep: [] });
              this.onKeyLine = !it.explicitKey;
              return;
            }
            break;
          }
          case "block-seq": {
            const it = top.items[top.items.length - 1];
            if (it.value)
              top.items.push({ start: [], value: token });
            else
              it.value = token;
            break;
          }
          case "flow-collection": {
            const it = top.items[top.items.length - 1];
            if (!it || it.value)
              top.items.push({ start: [], key: token, sep: [] });
            else if (it.sep)
              it.value = token;
            else
              Object.assign(it, { key: token, sep: [] });
            return;
          }
          default:
            yield* this.pop();
            yield* this.pop(token);
        }
        if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
          const last = token.items[token.items.length - 1];
          if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
            if (top.type === "document")
              top.end = last.start;
            else
              top.items.push({ start: last.start });
            token.items.splice(-1, 1);
          }
        }
      }
    }
    *stream() {
      switch (this.type) {
        case "directive-line":
          yield { type: "directive", offset: this.offset, source: this.source };
          return;
        case "byte-order-mark":
        case "space":
        case "comment":
        case "newline":
          yield this.sourceToken;
          return;
        case "doc-mode":
        case "doc-start": {
          const doc = {
            type: "document",
            offset: this.offset,
            start: []
          };
          if (this.type === "doc-start")
            doc.start.push(this.sourceToken);
          this.stack.push(doc);
          return;
        }
      }
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML stream`,
        source: this.source
      };
    }
    *document(doc) {
      if (doc.value)
        return yield* this.lineEnd(doc);
      switch (this.type) {
        case "doc-start": {
          if (findNonEmptyIndex(doc.start) !== -1) {
            yield* this.pop();
            yield* this.step();
          } else
            doc.start.push(this.sourceToken);
          return;
        }
        case "anchor":
        case "tag":
        case "space":
        case "comment":
        case "newline":
          doc.start.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(doc);
      if (bv)
        this.stack.push(bv);
      else {
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML document`,
          source: this.source
        };
      }
    }
    *scalar(scalar) {
      if (this.type === "map-value-ind") {
        const prev = getPrevProps(this.peek(2));
        const start = getFirstKeyStartProps(prev);
        let sep;
        if (scalar.end) {
          sep = scalar.end;
          sep.push(this.sourceToken);
          delete scalar.end;
        } else
          sep = [this.sourceToken];
        const map = {
          type: "block-map",
          offset: scalar.offset,
          indent: scalar.indent,
          items: [{ start, key: scalar, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map;
      } else
        yield* this.lineEnd(scalar);
    }
    *blockScalar(scalar) {
      switch (this.type) {
        case "space":
        case "comment":
        case "newline":
          scalar.props.push(this.sourceToken);
          return;
        case "scalar":
          scalar.source = this.source;
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine) {
            let nl = this.source.indexOf(`
`) + 1;
            while (nl !== 0) {
              this.onNewLine(this.offset + nl);
              nl = this.source.indexOf(`
`, nl) + 1;
            }
          }
          yield* this.pop();
          break;
        default:
          yield* this.pop();
          yield* this.step();
      }
    }
    *blockMap(map) {
      const it = map.items[map.items.length - 1];
      switch (this.type) {
        case "newline":
          this.onKeyLine = false;
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "space":
        case "comment":
          if (it.value) {
            map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            if (this.atIndentedComment(it.start, map.indent)) {
              const prev = map.items[map.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                map.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
      }
      if (this.indent >= map.indent) {
        const atMapIndent = !this.onKeyLine && this.indent === map.indent;
        const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
        let start = [];
        if (atNextItem && it.sep && !it.value) {
          const nl = [];
          for (let i = 0;i < it.sep.length; ++i) {
            const st = it.sep[i];
            switch (st.type) {
              case "newline":
                nl.push(i);
                break;
              case "space":
                break;
              case "comment":
                if (st.indent > map.indent)
                  nl.length = 0;
                break;
              default:
                nl.length = 0;
            }
          }
          if (nl.length >= 2)
            start = it.sep.splice(nl[1]);
        }
        switch (this.type) {
          case "anchor":
          case "tag":
            if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start });
              this.onKeyLine = true;
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "explicit-key-ind":
            if (!it.sep && !it.explicitKey) {
              it.start.push(this.sourceToken);
              it.explicitKey = true;
            } else if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start, explicitKey: true });
            } else {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [this.sourceToken], explicitKey: true }]
              });
            }
            this.onKeyLine = true;
            return;
          case "map-value-ind":
            if (it.explicitKey) {
              if (!it.sep) {
                if (includesToken(it.start, "newline")) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else {
                  const start2 = getFirstKeyStartProps(it.start);
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                  });
                }
              } else if (it.value) {
                map.items.push({ start: [], key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }]
                });
              } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                const start2 = getFirstKeyStartProps(it.start);
                const key = it.key;
                const sep = it.sep;
                sep.push(this.sourceToken);
                delete it.key;
                delete it.sep;
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key, sep }]
                });
              } else if (start.length > 0) {
                it.sep = it.sep.concat(start, this.sourceToken);
              } else {
                it.sep.push(this.sourceToken);
              }
            } else {
              if (!it.sep) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else if (it.value || atNextItem) {
                map.items.push({ start, key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [], key: null, sep: [this.sourceToken] }]
                });
              } else {
                it.sep.push(this.sourceToken);
              }
            }
            this.onKeyLine = true;
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (atNextItem || it.value) {
              map.items.push({ start, key: fs, sep: [] });
              this.onKeyLine = true;
            } else if (it.sep) {
              this.stack.push(fs);
            } else {
              Object.assign(it, { key: fs, sep: [] });
              this.onKeyLine = true;
            }
            return;
          }
          default: {
            const bv = this.startBlockValue(map);
            if (bv) {
              if (bv.type === "block-seq") {
                if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                  yield* this.pop({
                    type: "error",
                    offset: this.offset,
                    message: "Unexpected block-seq-ind on same line with key",
                    source: this.source
                  });
                  return;
                }
              } else if (atMapIndent) {
                map.items.push({ start });
              }
              this.stack.push(bv);
              return;
            }
          }
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *blockSequence(seq) {
      const it = seq.items[seq.items.length - 1];
      switch (this.type) {
        case "newline":
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              seq.items.push({ start: [this.sourceToken] });
          } else
            it.start.push(this.sourceToken);
          return;
        case "space":
        case "comment":
          if (it.value)
            seq.items.push({ start: [this.sourceToken] });
          else {
            if (this.atIndentedComment(it.start, seq.indent)) {
              const prev = seq.items[seq.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                seq.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
        case "anchor":
        case "tag":
          if (it.value || this.indent <= seq.indent)
            break;
          it.start.push(this.sourceToken);
          return;
        case "seq-item-ind":
          if (this.indent !== seq.indent)
            break;
          if (it.value || includesToken(it.start, "seq-item-ind"))
            seq.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
      }
      if (this.indent > seq.indent) {
        const bv = this.startBlockValue(seq);
        if (bv) {
          this.stack.push(bv);
          return;
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *flowCollection(fc) {
      const it = fc.items[fc.items.length - 1];
      if (this.type === "flow-error-end") {
        let top;
        do {
          yield* this.pop();
          top = this.peek(1);
        } while (top?.type === "flow-collection");
      } else if (fc.end.length === 0) {
        switch (this.type) {
          case "comma":
          case "explicit-key-ind":
            if (!it || it.sep)
              fc.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
          case "map-value-ind":
            if (!it || it.value)
              fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            return;
          case "space":
          case "comment":
          case "newline":
          case "anchor":
          case "tag":
            if (!it || it.value)
              fc.items.push({ start: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              it.start.push(this.sourceToken);
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (!it || it.value)
              fc.items.push({ start: [], key: fs, sep: [] });
            else if (it.sep)
              this.stack.push(fs);
            else
              Object.assign(it, { key: fs, sep: [] });
            return;
          }
          case "flow-map-end":
          case "flow-seq-end":
            fc.end.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(fc);
        if (bv)
          this.stack.push(bv);
        else {
          yield* this.pop();
          yield* this.step();
        }
      } else {
        const parent = this.peek(2);
        if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
          yield* this.pop();
          yield* this.step();
        } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          fixFlowSeqItems(fc);
          const sep = fc.end.splice(1, fc.end.length);
          sep.push(this.sourceToken);
          const map = {
            type: "block-map",
            offset: fc.offset,
            indent: fc.indent,
            items: [{ start, key: fc, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else {
          yield* this.lineEnd(fc);
        }
      }
    }
    flowScalar(type) {
      if (this.onNewLine) {
        let nl = this.source.indexOf(`
`) + 1;
        while (nl !== 0) {
          this.onNewLine(this.offset + nl);
          nl = this.source.indexOf(`
`, nl) + 1;
        }
      }
      return {
        type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
    }
    startBlockValue(parent) {
      switch (this.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return this.flowScalar(this.type);
        case "block-scalar-header":
          return {
            type: "block-scalar",
            offset: this.offset,
            indent: this.indent,
            props: [this.sourceToken],
            source: ""
          };
        case "flow-map-start":
        case "flow-seq-start":
          return {
            type: "flow-collection",
            offset: this.offset,
            indent: this.indent,
            start: this.sourceToken,
            items: [],
            end: []
          };
        case "seq-item-ind":
          return {
            type: "block-seq",
            offset: this.offset,
            indent: this.indent,
            items: [{ start: [this.sourceToken] }]
          };
        case "explicit-key-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          start.push(this.sourceToken);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, explicitKey: true }]
          };
        }
        case "map-value-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, key: null, sep: [this.sourceToken] }]
          };
        }
      }
      return null;
    }
    atIndentedComment(start, indent) {
      if (this.type !== "comment")
        return false;
      if (this.indent <= indent)
        return false;
      return start.every((st) => st.type === "newline" || st.type === "space");
    }
    *documentEnd(docEnd) {
      if (this.type !== "doc-mode") {
        if (docEnd.end)
          docEnd.end.push(this.sourceToken);
        else
          docEnd.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
      }
    }
    *lineEnd(token) {
      switch (this.type) {
        case "comma":
        case "doc-start":
        case "doc-end":
        case "flow-seq-end":
        case "flow-map-end":
        case "map-value-ind":
          yield* this.pop();
          yield* this.step();
          break;
        case "newline":
          this.onKeyLine = false;
        case "space":
        case "comment":
        default:
          if (token.end)
            token.end.push(this.sourceToken);
          else
            token.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
      }
    }
  }
  exports.Parser = Parser;
});

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS((exports) => {
  var composer = require_composer();
  var Document = require_Document();
  var errors = require_errors();
  var log = require_log();
  var identity = require_identity();
  var lineCounter = require_line_counter();
  var parser = require_parser();
  function parseOptions(options) {
    const prettyErrors = options.prettyErrors !== false;
    const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter || null;
    return { lineCounter: lineCounter$1, prettyErrors };
  }
  function parseAllDocuments(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    const docs = Array.from(composer$1.compose(parser$1.parse(source)));
    if (prettyErrors && lineCounter2)
      for (const doc of docs) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
    if (docs.length > 0)
      return docs;
    return Object.assign([], { empty: true }, composer$1.streamInfo());
  }
  function parseDocument(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    let doc = null;
    for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
      if (!doc)
        doc = _doc;
      else if (doc.options.logLevel !== "silent") {
        doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
        break;
      }
    }
    if (prettyErrors && lineCounter2) {
      doc.errors.forEach(errors.prettifyError(source, lineCounter2));
      doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
    }
    return doc;
  }
  function parse(src, reviver, options) {
    let _reviver = undefined;
    if (typeof reviver === "function") {
      _reviver = reviver;
    } else if (options === undefined && reviver && typeof reviver === "object") {
      options = reviver;
    }
    const doc = parseDocument(src, options);
    if (!doc)
      return null;
    doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
    if (doc.errors.length > 0) {
      if (doc.options.logLevel !== "silent")
        throw doc.errors[0];
      else
        doc.errors = [];
    }
    return doc.toJS(Object.assign({ reviver: _reviver }, options));
  }
  function stringify(value, replacer, options) {
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
    }
    if (typeof options === "string")
      options = options.length;
    if (typeof options === "number") {
      const indent = Math.round(options);
      options = indent < 1 ? undefined : indent > 8 ? { indent: 8 } : { indent };
    }
    if (value === undefined) {
      const { keepUndefined } = options ?? replacer ?? {};
      if (!keepUndefined)
        return;
    }
    if (identity.isDocument(value) && !_replacer)
      return value.toString(options);
    return new Document.Document(value, _replacer, options).toString(options);
  }
  exports.parse = parse;
  exports.parseAllDocuments = parseAllDocuments;
  exports.parseDocument = parseDocument;
  exports.stringify = stringify;
});

// src/cli/create.ts
init_repo();

// src/lib/generate.ts
import { existsSync as existsSync3, mkdirSync } from "fs";
import { join as join3 } from "path";

// src/version.ts
var VERSION = "0.1.0";

// src/lib/generate.ts
init_repo();
init_lib();

// src/lib/utils.ts
function resolveByNameOrIndex(input, items, itemType) {
  const trimmed = input.trim();
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1) {
    const item = items.find((i) => i.id === num);
    if (item)
      return item;
    throw new Error(`${itemType} ${num} not found. Available: ${items.map((i) => i.id).join(", ")}`);
  }
  const lowerInput = trimmed.toLowerCase();
  const exactMatch = items.find((i) => i.name.toLowerCase() === lowerInput);
  if (exactMatch)
    return exactMatch;
  const partialMatches = items.filter((i) => i.name.toLowerCase().includes(lowerInput));
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }
  if (partialMatches.length > 1) {
    throw new Error(`Ambiguous ${itemType} name "${trimmed}". Matches: ${partialMatches.map((i) => `"${i.name}"`).join(", ")}`);
  }
  const availableNames = items.map((i) => `${i.id}: "${i.name}"`).join(", ");
  throw new Error(`${itemType} "${trimmed}" not found. Available: ${availableNames}`);
}
function toTitleCase(kebab) {
  return kebab.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function getDateString() {
  return new Date().toISOString().split("T")[0] ?? "";
}
function validateStreamName(name) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}
function setNestedField(obj, path, value) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0;i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part)
      continue;
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  const lastPart = parts[parts.length - 1];
  if (!lastPart)
    return;
  current[lastPart] = value;
}
function getNestedField(obj, path) {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return;
    }
    current = current[part];
  }
  return current;
}
function parseValue(value) {
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  if (/^-?\d+$/.test(value))
    return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value))
    return parseFloat(value);
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}

// src/lib/generate.ts
init_stream_parser();
function getVersionString() {
  return `@agenv/workstreams@${VERSION}`;
}
function generateStageTemplate(stageNum) {
  const paddedNum = stageNum.toString().padStart(2, "0");
  return `### Stage ${paddedNum}: <!-- Stage Name -->

#### Stage Definition

<!-- The "what" - what this stage accomplishes -->

#### Stage Constitution

Describe how this stage operates: what it needs (inputs), how it's organized (structure), and what it produces (outputs).

#### Stage Questions

<!-- Unknowns, research to-dos as [ ] checkboxes -->
- [ ]

#### Stage Batches

##### Batch 01: <!-- Batch Name -->

<!-- What this batch accomplishes -->

###### Thread 01: <!-- Thread Name -->

**Summary:**
<!-- Short description of this parallelizable work unit -->

**Details:**
<!-- Any content - implementation notes, dependencies, goals, code examples, etc. -->`;
}
function generatePlanMd(streamId, streamName, numStages = 1) {
  const titleName = toTitleCase(streamName);
  const now = getDateString();
  const version = getVersionString();
  const stages = [];
  for (let i = 1;i <= numStages; i++) {
    stages.push(generateStageTemplate(i));
  }
  return `# Plan: ${titleName}

> **Stream ID:** ${streamId} | **Created:** ${now} | **Generated by:** ${version}

## Summary

<!-- High-level overview of what this workstream aims to achieve -->

## References

<!-- Source files, reasoning documents, tools used -->

- <!-- Add references here -->

## Stages

${stages.join(`

`)}

---

*Last updated: ${now}*
`;
}
function generateTasksJson(streamId) {
  return {
    version: "1.0.0",
    stream_id: streamId,
    last_updated: new Date().toISOString(),
    tasks: []
  };
}
function generateStream(args) {
  const workDir = getWorkDir(args.repoRoot);
  if (!existsSync3(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }
  const index = getOrCreateIndex(args.repoRoot);
  const existingStream = index.streams.find((s) => s.name === args.name);
  if (existingStream) {
    throw new Error(`Workstream with name "${args.name}" already exists (${existingStream.id})`);
  }
  const order = getNextOrderNumber(index);
  const streamId = `${formatOrderNumber(order)}-${args.name}`;
  const streamPath = `work/${streamId}`;
  const streamDir = join3(workDir, streamId);
  mkdirSync(streamDir, { recursive: true });
  const docsDir = join3(streamDir, "docs");
  mkdirSync(docsDir, { recursive: true });
  const planContent = generatePlanMd(streamId, args.name, args.stages ?? 1);
  atomicWriteFile(join3(streamDir, "PLAN.md"), planContent);
  atomicWriteFile(join3(streamDir, "tasks.json"), JSON.stringify(generateTasksJson(streamId), null, 2));
  const now = new Date().toISOString();
  const generatedBy = {
    workstreams: VERSION
  };
  const streamMetadata = {
    id: streamId,
    name: args.name,
    order,
    size: "medium",
    session_estimated: {
      length: 4,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [4, 8]
    },
    created_at: now,
    updated_at: now,
    path: streamPath,
    generated_by: generatedBy
  };
  index.streams.push(streamMetadata);
  saveIndex(args.repoRoot, index);
  return {
    streamId,
    streamPath
  };
}
function createGenerateArgs(name, repoRoot, stages) {
  return {
    name,
    repoRoot,
    stages
  };
}

// src/cli/create.ts
function printHelp() {
  console.log(`
work create - Create a new workstream

Usage:
  work create --name <name> --stages <n>

Required:
  --name, -n       Workstream name in kebab-case (e.g., "migrate-sql-to-orm")
  --stages         Number of stages to generate in PLAN.md (1-20)

Optional:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Examples:
  # Create a workstream with 3 stages
  work create --name migrate-sql-to-orm --stages 3

  # Create with 5 stages
  work create --name refactor-auth --stages 5

Workstream Structure:
  Creates a new workstream directory with:
  - PLAN.md     Structured markdown for workstream definition
  - tasks.json  Empty task tracker (populate with "work add-task")
  - files/      Directory for task outputs
  - docs/       Optional directory for additional documentation

Workflow:
  1. Create workstream: work create --name my-feature --stages 3
  2. Edit PLAN.md:      Fill in stage names, threads, and details
  3. Validate:          work validate plan
  4. Track progress:    work list --stream "001-my-feature" --tasks
  5. Document results:  work report init && fill in REPORT.md
`);
}
function parseCliArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--name":
      case "-n":
        if (!next) {
          console.error("Error: --name requires a value");
          return null;
        }
        if (!validateStreamName(next)) {
          console.error(`Error: Workstream name must be kebab-case (e.g., "my-stream"). Got: "${next}"`);
          return null;
        }
        parsed.name = next;
        i++;
        break;
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stages":
        if (!next) {
          console.error("Error: --stages requires a number");
          return null;
        }
        const stages = parseInt(next, 10);
        if (isNaN(stages) || stages < 1 || stages > 20) {
          console.error("Error: --stages must be a number between 1 and 20");
          return null;
        }
        parsed.stages = stages;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--size":
      case "-s":
        console.error("Error: --size is no longer supported. All workstreams now use a uniform structure.");
        console.error("Run with --help for usage information.");
        return null;
      case "--supertasks":
      case "--subtasks":
        console.error(`Error: ${arg} is no longer supported. Use --stages to specify the number of stages.`);
        console.error("Run with --help for usage information.");
        return null;
    }
  }
  if (!parsed.name) {
    console.error("Error: --name is required");
    return null;
  }
  if (!parsed.stages) {
    console.error("Error: --stages is required");
    return null;
  }
  return parsed;
}
function main(argv = process.argv) {
  const cliArgs = parseCliArgs(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const generateArgs = createGenerateArgs(cliArgs.name, repoRoot, cliArgs.stages);
  try {
    const result = generateStream(generateArgs);
    console.log(`Created workstream: ${result.streamId}`);
    console.log(`   Path: ${result.streamPath}`);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Edit PLAN.md to define stages, threads, and tasks");
    console.log(`  2. Run: work validate plan`);
    console.log(`  3. View: work list --stream "${result.streamId}" --tasks`);
    console.log("");
    console.log("Created files:");
    console.log("  - PLAN.md     (edit to define workstream structure)");
    console.log("  - tasks.json  (auto-populated by validation)");
    console.log("  - docs/       (optional additional documentation)");
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/status.ts
init_repo();
init_lib();

// src/lib/status.ts
init_tasks();

// src/lib/approval.ts
init_lib();
init_repo();
init_stream_parser();
import { createHash } from "crypto";
import { existsSync as existsSync6, readFileSync as readFileSync5 } from "fs";
import { join as join6 } from "path";
function getPlanMdPath(repoRoot, streamId) {
  const workDir = getWorkDir(repoRoot);
  return join6(workDir, streamId, "PLAN.md");
}
function computePlanHash(repoRoot, streamId) {
  const planPath = getPlanMdPath(repoRoot, streamId);
  if (!existsSync6(planPath)) {
    return null;
  }
  const content = readFileSync5(planPath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}
function getApprovalStatus(stream) {
  return stream.approval?.status ?? "draft";
}
function isApproved(stream) {
  return getApprovalStatus(stream) === "approved";
}
function isPlanModified(repoRoot, stream) {
  if (!stream.approval?.plan_hash) {
    return false;
  }
  const currentHash = computePlanHash(repoRoot, stream.id);
  if (!currentHash) {
    return true;
  }
  return currentHash !== stream.approval.plan_hash;
}
function canCreateTasks(stream) {
  const status = getApprovalStatus(stream);
  switch (status) {
    case "approved":
      return { allowed: true };
    case "draft":
      return {
        allowed: false,
        reason: "Plan has not been approved. Run 'work approve' to approve it."
      };
    case "revoked":
      return {
        allowed: false,
        reason: `Plan approval was revoked${stream.approval?.revoked_reason ? `: ${stream.approval.revoked_reason}` : ""}. Run 'work approve' to re-approve.`
      };
    default:
      return {
        allowed: false,
        reason: `Unknown approval status: ${status}`
      };
  }
}
function approveStream(repoRoot, streamIdOrName, approvedBy) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  const stream = index.streams[streamIndex];
  const planHash = computePlanHash(repoRoot, stream.id);
  if (!planHash) {
    throw new Error(`PLAN.md not found for workstream "${stream.id}"`);
  }
  stream.approval = {
    ...stream.approval,
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: approvedBy,
    plan_hash: planHash
  };
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
  return stream;
}
function revokeApproval(repoRoot, streamIdOrName, reason) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  const stream = index.streams[streamIndex];
  stream.approval = {
    ...stream.approval,
    status: "revoked",
    revoked_at: new Date().toISOString(),
    revoked_reason: reason
  };
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
  return stream;
}
function checkAndRevokeIfModified(repoRoot, stream) {
  if (!isApproved(stream)) {
    return { revoked: false, stream };
  }
  if (!isPlanModified(repoRoot, stream)) {
    return { revoked: false, stream };
  }
  const updatedStream = revokeApproval(repoRoot, stream.id, "PLAN.md was modified after approval");
  return { revoked: true, stream: updatedStream };
}
function formatApprovalStatus(stream) {
  const status = getApprovalStatus(stream);
  switch (status) {
    case "draft":
      return "[D] draft (not approved)";
    case "approved":
      return "[A] approved";
    case "revoked":
      const reason = stream.approval?.revoked_reason;
      return `[R] revoked${reason ? ` (${reason})` : ""}`;
    default:
      return `[?] ${status}`;
  }
}
function checkOpenQuestions(repoRoot, streamId) {
  const planPath = getPlanMdPath(repoRoot, streamId);
  if (!existsSync6(planPath)) {
    return {
      hasOpenQuestions: false,
      openCount: 0,
      resolvedCount: 0,
      questions: []
    };
  }
  const content = readFileSync5(planPath, "utf-8");
  const errors = [];
  const doc = parseStreamDocument(content, errors);
  if (!doc) {
    return {
      hasOpenQuestions: false,
      openCount: 0,
      resolvedCount: 0,
      questions: []
    };
  }
  const openQuestions = [];
  let openCount = 0;
  let resolvedCount = 0;
  for (const stage of doc.stages) {
    for (const q2 of stage.questions) {
      if (q2.resolved) {
        resolvedCount++;
      } else if (q2.question.trim()) {
        openCount++;
        openQuestions.push({
          stage: stage.id,
          stageName: stage.name,
          question: q2.question
        });
      }
    }
  }
  return {
    hasOpenQuestions: openCount > 0,
    openCount,
    resolvedCount,
    questions: openQuestions
  };
}
function getStageApprovalStatus(stream, stageNumber) {
  if (!stream.approval?.stages) {
    return "draft";
  }
  return stream.approval.stages[stageNumber]?.status ?? "draft";
}
function approveStage(repoRoot, streamIdOrName, stageNumber, approvedBy) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  const stream = index.streams[streamIndex];
  if (!stream.approval) {
    stream.approval = {
      status: "draft"
    };
  }
  if (!stream.approval.stages) {
    stream.approval.stages = {};
  }
  stream.approval.stages[stageNumber] = {
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: approvedBy
  };
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
  return stream;
}
function revokeStageApproval(repoRoot, streamIdOrName, stageNumber, reason) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  const stream = index.streams[streamIndex];
  if (!stream.approval?.stages?.[stageNumber]) {
    throw new Error(`Stage ${stageNumber} is not approved, nothing to revoke`);
  }
  stream.approval.stages[stageNumber] = {
    ...stream.approval.stages[stageNumber],
    status: "revoked",
    revoked_at: new Date().toISOString(),
    revoked_reason: reason
  };
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
  return stream;
}
function checkTasksApprovalReady(repoRoot, streamId) {
  const { readFileSync: readFileSync6, existsSync: existsSync7 } = __require("fs");
  const { join: join7 } = __require("path");
  const { getWorkDir: getWorkDir2 } = (init_repo(), __toCommonJS(exports_repo));
  const { parseTasksMd: parseTasksMd2 } = (init_tasks_md(), __toCommonJS(exports_tasks_md));
  const workDir = getWorkDir2(repoRoot);
  const tasksMdPath = join7(workDir, streamId, "TASKS.md");
  if (!existsSync7(tasksMdPath)) {
    return {
      ready: false,
      reason: "TASKS.md not found. Run 'work tasks' or create it manually to generate tasks.",
      taskCount: 0
    };
  }
  const content = readFileSync6(tasksMdPath, "utf-8");
  const { tasks, errors } = parseTasksMd2(content, streamId);
  if (errors.length > 0) {
    return {
      ready: false,
      reason: `TASKS.md has errors: ${errors[0]}`,
      taskCount: 0
    };
  }
  if (tasks.length === 0) {
    return {
      ready: false,
      reason: "TASKS.md exists but contains no valid tasks.",
      taskCount: 0
    };
  }
  return {
    ready: true,
    taskCount: tasks.length
  };
}
function getTasksApprovalStatus(stream) {
  return stream.approval?.tasks?.status ?? "draft";
}
function approveTasks(repoRoot, streamIdOrName) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  const stream = index.streams[streamIndex];
  const readyCheck = checkTasksApprovalReady(repoRoot, stream.id);
  if (!readyCheck.ready) {
    throw new Error(readyCheck.reason);
  }
  if (!stream.approval) {
    stream.approval = { status: "draft" };
  }
  stream.approval.tasks = {
    status: "approved",
    approved_at: new Date().toISOString(),
    task_count: readyCheck.taskCount
  };
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
  return stream;
}
function revokeTasksApproval(repoRoot, streamIdOrName, reason) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamIdOrName || s.name === streamIdOrName);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamIdOrName}" not found`);
  }
  const stream = index.streams[streamIndex];
  if (!stream.approval) {
    stream.approval = { status: "draft" };
  }
  stream.approval.tasks = {
    status: "revoked",
    revoked_at: new Date().toISOString(),
    revoked_reason: reason
  };
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
  return stream;
}
function isFullyApproved(stream) {
  return getApprovalStatus(stream) === "approved" && getTasksApprovalStatus(stream) === "approved";
}
function getFullApprovalStatus(stream) {
  return {
    plan: getApprovalStatus(stream),
    tasks: getTasksApprovalStatus(stream),
    fullyApproved: isFullyApproved(stream)
  };
}

// src/lib/status.ts
function computeStreamStatus(repoRoot, stream) {
  if (stream.status === "on_hold") {
    return "on_hold";
  }
  const counts = getTaskCounts(repoRoot, stream.id);
  if (counts.total === 0) {
    return "pending";
  }
  const doneCount = counts.completed + counts.cancelled;
  if (doneCount === counts.total) {
    return "completed";
  }
  if (counts.in_progress > 0) {
    return "in_progress";
  }
  if (counts.completed > 0) {
    return "in_progress";
  }
  return "pending";
}
function getStreamStatus(repoRoot, stream) {
  return computeStreamStatus(repoRoot, stream);
}
function calculateStageStatus(tasks) {
  if (tasks.length === 0)
    return "pending";
  const done = tasks.filter((t) => t.status === "completed" || t.status === "cancelled").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  if (done === tasks.length)
    return "complete";
  if (blocked > 0 && inProgress === 0 && done === 0)
    return "blocked";
  if (inProgress > 0 || done > 0)
    return "in_progress";
  return "pending";
}
function getStreamProgress(repoRoot, stream) {
  const tasks = getTasks(repoRoot, stream.id);
  const counts = getTaskCounts(repoRoot, stream.id);
  const stages = [];
  const stageNumbers = new Set;
  for (const task of tasks) {
    const stageNum = parseInt(task.id.split(".")[0], 10);
    if (!isNaN(stageNum)) {
      stageNumbers.add(stageNum);
    }
  }
  for (const stageNum of Array.from(stageNumbers).sort((a, b2) => a - b2)) {
    const stagePrefix = `${stageNum.toString().padStart(2, "0")}.`;
    const stageTasks = tasks.filter((t) => t.id.startsWith(stagePrefix));
    const stageName = stageTasks[0]?.stage_name || `Stage ${stageNum}`;
    stages.push({
      number: stageNum,
      title: stageName,
      status: calculateStageStatus(stageTasks),
      taskCount: stageTasks.length,
      completedCount: stageTasks.filter((t) => t.status === "completed" || t.status === "cancelled").length
    });
  }
  const stageTasksMap = new Map;
  for (const task of tasks) {
    const parts = task.id.split(".");
    const stageNum = parseInt(parts[0], 10);
    const threadNum = parseInt(parts[1] || "1", 10);
    const taskNum = parseInt(parts[2] || "1", 10);
    if (!stageTasksMap.has(stageNum)) {
      stageTasksMap.set(stageNum, []);
    }
    stageTasksMap.get(stageNum).push({
      id: task.id,
      description: task.name,
      status: task.status,
      stageNumber: stageNum,
      taskGroupNumber: threadNum,
      subtaskNumber: taskNum,
      lineNumber: 0
    });
  }
  return {
    streamId: stream.id,
    streamName: stream.name,
    size: stream.size,
    stages: stages.map((s) => ({
      number: s.number,
      title: s.title,
      status: s.status,
      tasks: stageTasksMap.get(s.number) || [],
      file: "tasks.json"
    })),
    totalTasks: counts.total,
    completedTasks: counts.completed + counts.cancelled,
    inProgressTasks: counts.in_progress,
    blockedTasks: counts.blocked,
    pendingTasks: counts.pending,
    percentComplete: counts.total > 0 ? Math.round((counts.completed + counts.cancelled) / counts.total * 100) : 0
  };
}
function formatStreamStatusIcon(status) {
  switch (status) {
    case "pending":
      return "[ ] pending";
    case "in_progress":
      return "[~] in progress";
    case "completed":
      return "[x] completed";
    case "on_hold":
      return "[!] on hold";
  }
}
function formatApprovalIcon(status) {
  switch (status) {
    case "approved":
      return "✓";
    case "revoked":
      return "⚠";
    case "draft":
    default:
      return "○";
  }
}
function formatSessionStatusIcon(status) {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "running":
      return "▶";
    case "interrupted":
      return "⏸";
    default:
      return "?";
  }
}
function formatSessionHistory(repoRoot, streamId, progress) {
  const tasks = getTasks(repoRoot, streamId);
  const lines = [];
  const bar = "=".repeat(80);
  lines.push(`
${bar}`);
  lines.push(`SESSION HISTORY: ${streamId}`);
  lines.push(bar);
  for (const stage of progress.stages) {
    const stagePrefix = `${stage.number.toString().padStart(2, "0")}.`;
    const stageTasks = tasks.filter((t) => t.id.startsWith(stagePrefix));
    const threadMap = new Map;
    for (const task of stageTasks) {
      const parts = task.id.split(".");
      if (parts.length < 3)
        continue;
      const threadId = parts.slice(0, 3).join(".");
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, []);
      }
      threadMap.get(threadId).push(task);
    }
    for (const [threadId, threadTasks] of threadMap) {
      const firstTask = threadTasks[0];
      if (!firstTask)
        continue;
      const allSessions = threadTasks.flatMap((t) => t.sessions || []);
      if (allSessions.length === 0)
        continue;
      lines.push(`
${stage.title} - ${firstTask.thread_name} (${threadId})`);
      lines.push("-".repeat(80));
      for (let i = 0;i < allSessions.length; i++) {
        const session = allSessions[i];
        const statusIcon = formatSessionStatusIcon(session.status);
        const duration = session.completedAt ? `${Math.round((new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()) / 60000)}m` : "ongoing";
        const exitInfo = session.exitCode !== undefined ? ` (exit: ${session.exitCode})` : "";
        lines.push(`  ${i + 1}. ${statusIcon} ${session.status.padEnd(12)} | ${session.agentName.padEnd(20)} | ${session.model.padEnd(30)} | ${duration}${exitInfo}`);
        lines.push(`     Started: ${new Date(session.startedAt).toLocaleString()}`);
        if (session.completedAt) {
          lines.push(`     Ended:   ${new Date(session.completedAt).toLocaleString()}`);
        }
      }
    }
  }
  lines.push(`
${bar}
`);
  return lines.join(`
`);
}
function getThreadInfoWithSessions(repoRoot, streamId, stageNumber) {
  const tasks = getTasks(repoRoot, streamId);
  const stagePrefix = `${stageNumber.toString().padStart(2, "0")}.`;
  const stageTasks = tasks.filter((t) => t.id.startsWith(stagePrefix));
  const threadsMap = new Map;
  for (const task of stageTasks) {
    const parts = task.id.split(".");
    if (parts.length < 3)
      continue;
    const threadId = parts.slice(0, 3).join(".");
    if (!threadsMap.has(threadId)) {
      threadsMap.set(threadId, {
        threadId,
        threadName: task.thread_name,
        sessionCount: 0,
        hasRunningSession: false,
        isResumable: false
      });
    }
    const threadInfo = threadsMap.get(threadId);
    if (task.sessions) {
      threadInfo.sessionCount += task.sessions.length;
      const hasRunning = task.sessions.some((s) => s.status === "running");
      if (hasRunning) {
        threadInfo.hasRunningSession = true;
      }
      if (task.sessions.length > 0) {
        const lastSession = task.sessions[task.sessions.length - 1];
        threadInfo.lastSessionStatus = lastSession.status;
        if ((lastSession.status === "interrupted" || lastSession.status === "failed") && task.status !== "completed") {
          threadInfo.isResumable = true;
        }
      }
    }
  }
  return threadsMap;
}
function formatProgress(progress, streamStatus, stream, repoRoot) {
  const lines = [];
  const bar = "-".repeat(50);
  lines.push(`+${bar}+`);
  lines.push(`| ${progress.streamId.padEnd(48)} |`);
  if (streamStatus) {
    lines.push(`| Status: ${formatStreamStatusIcon(streamStatus)}`.padEnd(51) + "|");
  }
  lines.push(`+${bar}+`);
  const barWidth = 30;
  const filled = Math.round(progress.percentComplete / 100 * barWidth);
  const progressBar = "#".repeat(filled) + ".".repeat(barWidth - filled);
  lines.push(`| Progress: [${progressBar}] ${progress.percentComplete}%`.padEnd(51) + "|");
  lines.push(`| Tasks: ${progress.completedTasks}/${progress.totalTasks} complete, ${progress.inProgressTasks} in-progress, ${progress.blockedTasks} blocked`.padEnd(51) + "|");
  lines.push(`+${bar}+`);
  for (const stage of progress.stages) {
    const statusIcon = stage.status === "complete" ? "[x]" : stage.status === "in_progress" ? "[~]" : stage.status === "blocked" ? "[!]" : "[ ]";
    const stageNumPadded = stage.number.toString().padStart(2, "0");
    const stageTitle = stage.title || `Stage ${stageNumPadded}`;
    const taskCount = stage.tasks?.length || 0;
    const completedCount = stage.tasks?.filter((t) => t.status === "completed").length || 0;
    let approvalDisplay = "";
    if (stream) {
      const stageApproval = getStageApprovalStatus(stream, stage.number);
      approvalDisplay = ` ${formatApprovalIcon(stageApproval)}`;
    }
    let sessionSummary = "";
    if (repoRoot && stream) {
      const threadInfoMap = getThreadInfoWithSessions(repoRoot, stream.id, stage.number);
      const threadInfoList = Array.from(threadInfoMap.values());
      const totalSessions = threadInfoList.reduce((sum, t) => sum + t.sessionCount, 0);
      const runningCount = threadInfoList.filter((t) => t.hasRunningSession).length;
      const resumableCount = threadInfoList.filter((t) => t.isResumable).length;
      if (totalSessions > 0) {
        const indicators = [];
        indicators.push(`${totalSessions}s`);
        if (runningCount > 0)
          indicators.push(`${runningCount}▶`);
        if (resumableCount > 0)
          indicators.push(`${resumableCount}⟲`);
        sessionSummary = ` [${indicators.join(" ")}]`;
      }
    }
    lines.push(`| ${statusIcon} Stage ${stageNumPadded}: ${stageTitle} (${completedCount}/${taskCount})${sessionSummary}${approvalDisplay}`.padEnd(51) + "|");
  }
  lines.push(`+${bar}+`);
  return lines.join(`
`);
}

// src/cli/status.ts
function printHelp2() {
  console.log(`
work status - Show workstream progress

Usage:
  work status [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Specific workstream ID or name (shows all if omitted)
  --sessions       Show detailed session history for each thread
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # Show all workstreams
  work status

  # Show specific workstream
  work status --stream "001-my-stream"

  # Show detailed session history
  work status --sessions

  # Get JSON output
  work status --json
`);
}
function parseCliArgs2(argv) {
  const args = argv.slice(2);
  const parsed = { json: false, sessions: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--sessions":
        parsed.sessions = true;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp2();
        process.exit(0);
    }
  }
  return parsed;
}
function main2(argv = process.argv) {
  const cliArgs = parseCliArgs2(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (index.streams.length === 0) {
    console.log("No workstreams found.");
    return;
  }
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId);
  const streamsToShow = resolvedStreamId ? index.streams.filter((s) => s.id === resolvedStreamId || s.name === resolvedStreamId) : index.streams;
  if (streamsToShow.length === 0) {
    console.error(`Error: Workstream "${resolvedStreamId}" not found`);
    process.exit(1);
  }
  const progressList = streamsToShow.map((s) => {
    const progress = getStreamProgress(repoRoot, s);
    const status = getStreamStatus(repoRoot, s);
    return { stream: s, progress, status };
  });
  if (cliArgs.json) {
    const jsonOutput = progressList.map(({ progress, status }) => ({
      ...progress,
      status
    }));
    console.log(JSON.stringify(jsonOutput, null, 2));
  } else {
    for (const { stream, progress, status } of progressList) {
      console.log(formatProgress(progress, status, stream, repoRoot));
      if (cliArgs.sessions) {
        console.log(formatSessionHistory(repoRoot, stream.id, progress));
      } else {
        console.log();
      }
    }
  }
}
if (false) {}

// src/cli/update-task.ts
init_repo();
init_lib();

// src/lib/update.ts
init_tasks();
init_tasks();
async function updateTask(args) {
  try {
    parseTaskId(args.taskId);
  } catch (e) {
    throw new Error(`Invalid task ID: ${args.taskId}. Expected format "stage.batch.thread.task" (e.g., "01.01.02.03")`);
  }
  const existingTask = getTaskById(args.repoRoot, args.stream.id, args.taskId);
  if (!existingTask) {
    throw new Error(`Task "${args.taskId}" not found in workstream "${args.stream.id}". ` + `Run "work add-task" to add tasks, or "work validate plan" to check the plan.`);
  }
  const previousStatus = existingTask.status;
  const updatedTask = updateTaskStatus(args.repoRoot, args.stream.id, args.taskId, {
    status: args.status,
    breadcrumb: args.breadcrumb,
    report: args.report,
    assigned_agent: args.assigned_agent
  });
  if (!updatedTask) {
    throw new Error(`Failed to update task "${args.taskId}"`);
  }
  return {
    updated: true,
    file: "tasks.json",
    taskId: args.taskId,
    status: args.status,
    task: updatedTask
  };
}
async function updateThreadTasks(args) {
  let parsed;
  try {
    parsed = parseThreadId(args.threadId);
  } catch (e) {
    throw new Error(`Invalid thread ID: ${args.threadId}. Expected format "stage.batch.thread" (e.g., "01.01.02")`);
  }
  const updatedTasks = updateTasksByThread(args.repoRoot, args.stream.id, parsed.stage, parsed.batch, parsed.thread, {
    status: args.status,
    breadcrumb: args.breadcrumb,
    report: args.report,
    assigned_agent: args.assigned_agent
  });
  if (updatedTasks.length === 0) {
    throw new Error(`No tasks found in thread "${args.threadId}" in workstream "${args.stream.id}".`);
  }
  return {
    updated: true,
    file: "tasks.json",
    threadId: args.threadId,
    status: args.status,
    tasks: updatedTasks,
    count: updatedTasks.length
  };
}

// src/cli/update-task.ts
var VALID_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "cancelled"
];
function printHelp3() {
  console.log(`
work update - Update a task's status or all tasks in a thread

Usage:
  work update --task <id> --status <status> [options]
  work update --thread <id> --status <status> [options]

Required (one of):
  --task, -t       Task ID (e.g., "01.01.01.01" = Stage 01, Batch 01, Thread 01, Task 01)
  --thread         Thread ID (e.g., "01.01.01" = Stage 01, Batch 01, Thread 01) - updates ALL tasks
  --status         New status: pending, in_progress, completed, blocked, cancelled

Optional:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --note, -n       Add implementation note
  --breadcrumb, -b Add recovery breadcrumb (last action)
  --report         Completion report (brief summary of what was done)
  --agent          Assign agent to task
  --help, -h       Show this help message

ID Formats:
  Task:   "01.01.02.03" = Stage 01, Batch 01, Thread 02, Task 03
  Thread: "01.01.02"    = Stage 01, Batch 01, Thread 02

Examples:
  # Mark single task completed
  work update --task "01.01.01.01" --status completed

  # Mark all tasks in a thread completed
  work update --thread "01.01.01" --status completed

  # Mark task completed with report (recommended)
  work update --task "01.01.01.01" --status completed --report "Added hono dependencies."

  # Mark all tasks in thread cancelled
  work update --thread "01.01.02" --status cancelled

  # Update in a specific workstream
  work update --stream "001-my-stream" --thread "01.01.01" --status completed
`);
}
function parseCliArgs3(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--task":
      case "-t":
        if (!next) {
          console.error("Error: --task requires a value");
          return null;
        }
        parsed.taskId = next;
        i++;
        break;
      case "--thread":
        if (!next) {
          console.error("Error: --thread requires a value");
          return null;
        }
        parsed.threadId = next;
        i++;
        break;
      case "--status":
        if (!next) {
          console.error("Error: --status requires a value");
          return null;
        }
        if (!VALID_STATUSES.includes(next)) {
          console.error(`Error: Invalid status "${next}". Valid: ${VALID_STATUSES.join(", ")}`);
          return null;
        }
        parsed.status = next;
        i++;
        break;
      case "--note":
      case "-n":
        if (!next) {
          console.error("Error: --note requires a value");
          return null;
        }
        parsed.note = next;
        i++;
        break;
      case "--breadcrumb":
      case "-b":
        if (!next) {
          console.error("Error: --breadcrumb requires a value");
          return null;
        }
        parsed.breadcrumb = next;
        i++;
        break;
      case "--report":
        if (!next) {
          console.error("Error: --report requires a value");
          return null;
        }
        parsed.report = next;
        i++;
        break;
      case "--agent":
        if (!next) {
          console.error("Error: --agent requires a value");
          return null;
        }
        parsed.assigned_agent = next;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp3();
        process.exit(0);
    }
  }
  if (!parsed.taskId && !parsed.threadId) {
    console.error("Error: --task or --thread is required");
    return null;
  }
  if (parsed.taskId && parsed.threadId) {
    console.error("Error: --task and --thread are mutually exclusive");
    return null;
  }
  if (!parsed.status) {
    console.error("Error: --status is required");
    return null;
  }
  return parsed;
}
async function main3(argv = process.argv) {
  const cliArgs = parseCliArgs3(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  try {
    if (cliArgs.threadId) {
      const result = await updateThreadTasks({
        repoRoot,
        stream,
        threadId: cliArgs.threadId,
        status: cliArgs.status,
        note: cliArgs.note,
        breadcrumb: cliArgs.breadcrumb,
        report: cliArgs.report,
        assigned_agent: cliArgs.assigned_agent
      });
      console.log(`Updated ${result.count} task(s) in thread ${result.threadId} to ${result.status}`);
    } else {
      const result = await updateTask({
        repoRoot,
        stream,
        taskId: cliArgs.taskId,
        status: cliArgs.status,
        note: cliArgs.note,
        breadcrumb: cliArgs.breadcrumb,
        report: cliArgs.report,
        assigned_agent: cliArgs.assigned_agent
      });
      console.log(`Updated task ${result.taskId} to ${result.status}`);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/complete.ts
init_repo();
init_lib();
import { execSync as execSync3 } from "node:child_process";
import { existsSync as existsSync8 } from "node:fs";
import { join as join11 } from "node:path";

// src/lib/complete.ts
init_lib();
import { join as join7 } from "path";
import { writeFileSync as writeFileSync2 } from "fs";
init_repo();
init_tasks();

// src/lib/metrics.ts
init_tasks();
init_lib();
function evaluateStream(repoRoot, streamId) {
  const index = loadIndex(repoRoot);
  const stream = findStream(index, streamId);
  if (!stream) {
    throw new Error(`Workstream "${streamId}" not found`);
  }
  const tasks = getTasks(repoRoot, stream.id);
  const statusCounts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0
  };
  for (const task of tasks) {
    statusCounts[task.status]++;
  }
  const total = tasks.length;
  const completionRate = total > 0 ? statusCounts.completed / total * 100 : 0;
  const blockedRate = total > 0 ? statusCounts.blocked / total * 100 : 0;
  const cancelledRate = total > 0 ? statusCounts.cancelled / total * 100 : 0;
  return {
    streamId: stream.id,
    streamName: stream.name,
    totalTasks: total,
    statusCounts,
    completionRate,
    blockedRate,
    cancelledRate,
    inProgressCount: statusCounts.in_progress
  };
}
function evaluateAllStreams(repoRoot) {
  const index = loadIndex(repoRoot);
  return index.streams.map((stream) => evaluateStream(repoRoot, stream.id));
}
function filterTasks(tasks, pattern, isRegex = false) {
  let matchingTasks;
  if (isRegex) {
    const regex = new RegExp(pattern, "i");
    matchingTasks = tasks.filter((t) => regex.test(t.name));
  } else {
    const lowerPattern = pattern.toLowerCase();
    matchingTasks = tasks.filter((t) => t.name.toLowerCase().includes(lowerPattern));
  }
  return {
    matchingTasks,
    matchCount: matchingTasks.length,
    totalTasks: tasks.length
  };
}
function filterTasksByStatus(tasks, statuses) {
  return tasks.filter((t) => statuses.includes(t.status));
}
function analyzeBlockers(repoRoot, streamId) {
  const tasks = getTasks(repoRoot, streamId);
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const blockersByStage = {};
  const blockersByBatch = {};
  for (const task of blockedTasks) {
    const { stage, batch } = parseTaskId(task.id);
    if (!blockersByStage[stage]) {
      blockersByStage[stage] = [];
    }
    blockersByStage[stage].push(task);
    const batchKey = `${stage}.${batch.toString().padStart(2, "0")}`;
    if (!blockersByBatch[batchKey]) {
      blockersByBatch[batchKey] = [];
    }
    blockersByBatch[batchKey].push(task);
  }
  const blockedPercentage = tasks.length > 0 ? blockedTasks.length / tasks.length * 100 : 0;
  return {
    blockedTasks,
    blockersByStage,
    blockersByBatch,
    blockedPercentage
  };
}
function formatMetricsOutput(metrics, options = {}) {
  if (options.compact) {
    return `${metrics.streamName}: ${metrics.statusCounts.completed}/${metrics.totalTasks} (${metrics.completionRate.toFixed(0)}%) | ${metrics.statusCounts.blocked} blocked | ${metrics.statusCounts.in_progress} in progress`;
  }
  const lines = [];
  lines.push(`Workstream: ${metrics.streamId} (${metrics.streamName})`);
  lines.push(``);
  lines.push(`Tasks: ${metrics.totalTasks}`);
  lines.push(`  Completed:   ${metrics.statusCounts.completed} (${metrics.completionRate.toFixed(1)}%)`);
  lines.push(`  In Progress: ${metrics.statusCounts.in_progress}`);
  lines.push(`  Pending:     ${metrics.statusCounts.pending}`);
  lines.push(`  Blocked:     ${metrics.statusCounts.blocked} (${metrics.blockedRate.toFixed(1)}%)`);
  lines.push(`  Cancelled:   ${metrics.statusCounts.cancelled}`);
  return lines.join(`
`);
}
function formatBlockerAnalysis(analysis) {
  if (analysis.blockedTasks.length === 0) {
    return "No blocked tasks.";
  }
  const lines = [];
  lines.push(`Blocked Tasks: ${analysis.blockedTasks.length} (${analysis.blockedPercentage.toFixed(1)}%)`);
  lines.push(``);
  const stages = Object.keys(analysis.blockersByStage).map(Number).sort((a, b2) => a - b2);
  for (const stage of stages) {
    const tasks = analysis.blockersByStage[stage];
    lines.push(`Stage ${stage}:`);
    for (const task of tasks) {
      lines.push(`  [${task.id}] ${task.name}`);
    }
  }
  return lines.join(`
`);
}
function aggregateMetrics(metricsList) {
  const aggregate = {
    streamId: "all",
    streamName: "All Workstreams",
    totalTasks: 0,
    statusCounts: {
      pending: 0,
      in_progress: 0,
      completed: 0,
      blocked: 0,
      cancelled: 0
    },
    completionRate: 0,
    blockedRate: 0,
    cancelledRate: 0,
    inProgressCount: 0
  };
  for (const metrics of metricsList) {
    aggregate.totalTasks += metrics.totalTasks;
    aggregate.statusCounts.pending += metrics.statusCounts.pending;
    aggregate.statusCounts.in_progress += metrics.statusCounts.in_progress;
    aggregate.statusCounts.completed += metrics.statusCounts.completed;
    aggregate.statusCounts.blocked += metrics.statusCounts.blocked;
    aggregate.statusCounts.cancelled += metrics.statusCounts.cancelled;
    aggregate.inProgressCount += metrics.inProgressCount;
  }
  if (aggregate.totalTasks > 0) {
    aggregate.completionRate = aggregate.statusCounts.completed / aggregate.totalTasks * 100;
    aggregate.blockedRate = aggregate.statusCounts.blocked / aggregate.totalTasks * 100;
    aggregate.cancelledRate = aggregate.statusCounts.cancelled / aggregate.totalTasks * 100;
  }
  return aggregate;
}

// src/lib/complete.ts
function calculateTaskDuration(task) {
  if (!task.created_at || !task.updated_at) {
    return null;
  }
  const created = new Date(task.created_at).getTime();
  const updated = new Date(task.updated_at).getTime();
  if (isNaN(created) || isNaN(updated)) {
    return null;
  }
  return Math.max(0, updated - created);
}
function formatDuration(ms) {
  if (ms < 1000) {
    return "<1s";
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const remainingSeconds = seconds % 60;
  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (remainingMinutes > 0 || hours > 0) {
    parts.push(`${remainingMinutes}m`);
  }
  if (remainingSeconds > 0 || parts.length === 0) {
    parts.push(`${remainingSeconds}s`);
  }
  return parts.join(" ");
}
function calculateStageMetrics(tasks) {
  const stageMap = new Map;
  for (const task of tasks) {
    if (task.status !== "completed")
      continue;
    const duration = calculateTaskDuration(task);
    if (duration === null)
      continue;
    const stageName = task.stage_name || "Unknown Stage";
    if (!stageMap.has(stageName)) {
      stageMap.set(stageName, { durations: [] });
    }
    stageMap.get(stageName).durations.push(duration);
  }
  const results = [];
  for (const [stageName, data] of stageMap) {
    const totalTimeMs = data.durations.reduce((a, b2) => a + b2, 0);
    const avgTimeMs = data.durations.length > 0 ? totalTimeMs / data.durations.length : 0;
    results.push({
      stageName,
      taskCount: data.durations.length,
      avgTimeMs,
      totalTimeMs
    });
  }
  return results.sort((a, b2) => a.stageName.localeCompare(b2.stageName));
}
function calculateAgentMetrics(tasks) {
  const agentMap = new Map;
  for (const task of tasks) {
    if (task.status !== "completed")
      continue;
    const duration = calculateTaskDuration(task);
    if (duration === null)
      continue;
    const agentName = task.assigned_agent || "default";
    if (!agentMap.has(agentName)) {
      agentMap.set(agentName, { durations: [] });
    }
    agentMap.get(agentName).durations.push(duration);
  }
  const results = [];
  for (const [agentName, data] of agentMap) {
    const totalTimeMs = data.durations.reduce((a, b2) => a + b2, 0);
    const avgTimeMs = data.durations.length > 0 ? totalTimeMs / data.durations.length : 0;
    results.push({
      agentName,
      taskCount: data.durations.length,
      avgTimeMs
    });
  }
  return results.sort((a, b2) => b2.taskCount - a.taskCount || a.agentName.localeCompare(b2.agentName));
}
function calculateOverallTimingMetrics(tasks) {
  const completedTasks = tasks.filter((t) => t.status === "completed");
  const createdTimestamps = [];
  const updatedTimestamps = [];
  const durations = [];
  for (const task of completedTasks) {
    if (task.created_at) {
      const created = new Date(task.created_at).getTime();
      if (!isNaN(created)) {
        createdTimestamps.push(created);
      }
    }
    if (task.updated_at) {
      const updated = new Date(task.updated_at).getTime();
      if (!isNaN(updated)) {
        updatedTimestamps.push(updated);
      }
    }
    const duration = calculateTaskDuration(task);
    if (duration !== null) {
      durations.push(duration);
    }
  }
  let totalDurationMs = null;
  if (createdTimestamps.length > 0 && updatedTimestamps.length > 0) {
    const firstCreated = Math.min(...createdTimestamps);
    const lastUpdated = Math.max(...updatedTimestamps);
    totalDurationMs = lastUpdated - firstCreated;
  }
  let fastestTaskMs = null;
  let slowestTaskMs = null;
  if (durations.length > 0) {
    fastestTaskMs = Math.min(...durations);
    slowestTaskMs = Math.max(...durations);
  }
  return {
    totalDurationMs,
    fastestTaskMs,
    slowestTaskMs
  };
}
function completeStream(args) {
  const index = loadIndex(args.repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === args.streamId || s.name === args.streamId);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${args.streamId}" not found`);
  }
  const stream = index.streams[streamIndex];
  if (!stream) {
    throw new Error(`Workstream at index ${streamIndex} not found`);
  }
  const now = new Date().toISOString();
  stream.status = "completed";
  stream.updated_at = now;
  saveIndex(args.repoRoot, index);
  const completionPath = generateCompletionMd({
    repoRoot: args.repoRoot,
    streamId: stream.id
  });
  return {
    streamId: stream.id,
    completedAt: now,
    completionPath
  };
}
function generateCompletionMd(args) {
  const index = loadIndex(args.repoRoot);
  const stream = findStream(index, args.streamId);
  if (!stream) {
    throw new Error(`Workstream "${args.streamId}" not found`);
  }
  const workDir = getWorkDir(args.repoRoot);
  const streamDir = join7(workDir, stream.id);
  const tasks = getTasks(args.repoRoot, stream.id);
  const metrics = evaluateStream(args.repoRoot, stream.id);
  const grouped = groupTasksByHierarchy(tasks);
  let stageCount = 0;
  let batchCount = 0;
  let threadCount = 0;
  for (const stageMap of grouped.values()) {
    stageCount++;
    for (const batchMap of stageMap.values()) {
      batchCount++;
      threadCount += batchMap.size;
    }
  }
  const overallTiming = calculateOverallTimingMetrics(tasks);
  const stageMetrics = calculateStageMetrics(tasks);
  const agentMetrics = calculateAgentMetrics(tasks);
  const lines = [];
  lines.push(`# Metrics: ${stream.name}`);
  lines.push("");
  lines.push(`**Stream ID:** \`${stream.id}\``);
  lines.push(`**Completed At:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Tasks | ${metrics.statusCounts.completed}/${metrics.totalTasks} |`);
  lines.push(`| Completion Rate | ${metrics.completionRate.toFixed(1)}% |`);
  lines.push(`| Stages | ${stageCount} |`);
  lines.push(`| Batches | ${batchCount} |`);
  lines.push(`| Threads | ${threadCount} |`);
  lines.push(`| Total Duration | ${overallTiming.totalDurationMs !== null ? formatDuration(overallTiming.totalDurationMs) : "-"} |`);
  lines.push(`| Fastest Task | ${overallTiming.fastestTaskMs !== null ? formatDuration(overallTiming.fastestTaskMs) : "-"} |`);
  lines.push(`| Slowest Task | ${overallTiming.slowestTaskMs !== null ? formatDuration(overallTiming.slowestTaskMs) : "-"} |`);
  lines.push("");
  lines.push("## Status Breakdown");
  lines.push("");
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Completed | ${metrics.statusCounts.completed} |`);
  lines.push(`| In Progress | ${metrics.statusCounts.in_progress} |`);
  lines.push(`| Pending | ${metrics.statusCounts.pending} |`);
  lines.push(`| Blocked | ${metrics.statusCounts.blocked} |`);
  lines.push(`| Cancelled | ${metrics.statusCounts.cancelled} |`);
  lines.push("");
  lines.push("## Stage Performance");
  lines.push("");
  if (stageMetrics.length > 0) {
    lines.push(`| Stage | Tasks | Avg Time | Total Time |`);
    lines.push(`|-------|-------|----------|------------|`);
    for (const stage of stageMetrics) {
      lines.push(`| ${stage.stageName} | ${stage.taskCount} | ${formatDuration(stage.avgTimeMs)} | ${formatDuration(stage.totalTimeMs)} |`);
    }
  } else {
    lines.push("No completed tasks with timing data.");
  }
  lines.push("");
  lines.push("## Agent Performance");
  lines.push("");
  if (agentMetrics.length > 0) {
    lines.push(`| Agent | Tasks | Avg Time |`);
    lines.push(`|-------|-------|----------|`);
    for (const agent of agentMetrics) {
      lines.push(`| ${agent.agentName} | ${agent.taskCount} | ${formatDuration(agent.avgTimeMs)} |`);
    }
  } else {
    lines.push("No completed tasks with timing data.");
  }
  lines.push("");
  const content = lines.join(`
`);
  const outputPath = join7(streamDir, "METRICS.md");
  writeFileSync2(outputPath, content);
  return outputPath;
}
function groupTasksByHierarchy(tasks) {
  const grouped = new Map;
  for (const task of tasks) {
    const stageName = task.stage_name || "Stage 01";
    const batchName = task.batch_name || "Batch 01";
    const threadName = task.thread_name || "Thread 01";
    if (!grouped.has(stageName)) {
      grouped.set(stageName, new Map);
    }
    const stageMap = grouped.get(stageName);
    if (!stageMap.has(batchName)) {
      stageMap.set(batchName, new Map);
    }
    const batchMap = stageMap.get(batchName);
    if (!batchMap.has(threadName)) {
      batchMap.set(threadName, []);
    }
    batchMap.get(threadName).push(task);
  }
  return grouped;
}
function updateIndexField(args) {
  const index = loadIndex(args.repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === args.streamId || s.name === args.streamId);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${args.streamId}" not found`);
  }
  const stream = index.streams[streamIndex];
  if (!stream) {
    throw new Error(`Workstream at index ${streamIndex} not found`);
  }
  const currentValue = getNestedField(stream, args.field);
  const parsedValue = parseValue(args.value);
  setNestedField(stream, args.field, parsedValue);
  stream.updated_at = new Date().toISOString();
  saveIndex(args.repoRoot, index);
  return {
    streamId: stream.id,
    field: args.field,
    previousValue: currentValue,
    newValue: parsedValue
  };
}
function formatStreamInfo(stream) {
  const lines = [
    `Workstream: ${stream.id}`,
    `|- name: ${stream.name}`,
    `|- order: ${stream.order}`,
    `|- size: ${stream.size}`,
    `|- path: ${stream.path}`,
    `|- created_at: ${stream.created_at}`,
    `|- updated_at: ${stream.updated_at}`,
    `|- session_estimated:`,
    `|  |- length: ${stream.session_estimated.length}`,
    `|  |- unit: ${stream.session_estimated.unit}`,
    `|  |- session_minutes: [${stream.session_estimated.session_minutes.join(", ")}]`,
    `|  +- session_iterations: [${stream.session_estimated.session_iterations.join(", ")}]`,
    `+- generated_by:`,
    `   +- workstreams: ${stream.generated_by.workstreams}`
  ];
  return lines.join(`
`);
}

// src/lib/consolidate.ts
init_stream_parser();
init_repo();
import { existsSync as existsSync7, readFileSync as readFileSync6 } from "fs";
import { join as join8 } from "path";
function getStreamPlanMdPath(repoRoot, streamId) {
  const workDir = getWorkDir(repoRoot);
  return join8(workDir, streamId, "PLAN.md");
}
function validateStreamDocument(doc, errors, warnings) {
  if (!doc.summary || doc.summary.trim().length === 0) {
    warnings.push("Summary section is empty");
  }
  if (doc.stages.length === 0) {
    errors.push({
      section: "Stages",
      message: "No stages found. At least one stage is required."
    });
    return;
  }
  for (const stage of doc.stages) {
    const stagePrefix = `Stage ${stage.id}`;
    if (!stage.name || stage.name.trim().length === 0 || stage.name.includes("<!--")) {
      warnings.push(`${stagePrefix}: Stage name is empty or contains placeholder`);
    }
    if (!stage.definition || stage.definition.trim().length === 0) {
      warnings.push(`${stagePrefix}: Stage Definition is empty`);
    }
    const totalThreads = stage.batches.reduce((sum, b2) => sum + b2.threads.length, 0);
    if (totalThreads === 0) {
      warnings.push(`${stagePrefix}: No threads defined`);
    }
    for (const batch of stage.batches) {
      for (const thread of batch.threads) {
        const threadPrefix = `Stage ${stage.id}, Batch ${batch.prefix}, Thread ${thread.id}`;
        if (!thread.name || thread.name.trim().length === 0 || thread.name.includes("<!--")) {
          warnings.push(`${threadPrefix}: Thread name is empty or contains placeholder`);
        }
      }
    }
  }
}
function consolidateStream(repoRoot, streamId, _dryRun = false) {
  const errors = [];
  const warnings = [];
  const planMdPath = getStreamPlanMdPath(repoRoot, streamId);
  if (!existsSync7(planMdPath)) {
    errors.push({
      section: "File",
      message: `PLAN.md not found at ${planMdPath}`
    });
    return {
      success: false,
      streamDocument: null,
      tasksGenerated: [],
      errors,
      warnings
    };
  }
  const content = readFileSync6(planMdPath, "utf-8");
  const streamDocument = parseStreamDocument(content, errors);
  if (!streamDocument) {
    return {
      success: false,
      streamDocument: null,
      tasksGenerated: [],
      errors,
      warnings
    };
  }
  validateStreamDocument(streamDocument, errors, warnings);
  return {
    success: errors.length === 0,
    streamDocument,
    tasksGenerated: [],
    errors,
    warnings
  };
}

// src/cli/complete.ts
init_tasks();

// src/lib/github/config.ts
import { join as join9, dirname as dirname2 } from "node:path";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

// src/lib/github/types.ts
var DEFAULT_GITHUB_CONFIG = {
  enabled: false,
  owner: "",
  repo: "",
  branch_prefix: "workstream/",
  auto_create_issues: true,
  auto_commit_on_approval: true,
  label_config: {
    workstream: { prefix: "stream:", color: "5319e7" },
    thread: { prefix: "thread:", color: "0e8a16" },
    batch: { prefix: "batch:", color: "0e8a16" },
    stage: { prefix: "stage:", color: "1d76db" }
  }
};

// src/lib/github/config.ts
var execAsync = promisify(exec);
function getGitHubConfigPath(repoRoot) {
  return join9(repoRoot, "work", "github.json");
}
async function loadGitHubConfig(repoRoot) {
  const configPath = getGitHubConfigPath(repoRoot);
  try {
    const content = await readFile(configPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return DEFAULT_GITHUB_CONFIG;
    }
    throw error;
  }
}
async function saveGitHubConfig(repoRoot, config) {
  const configPath = getGitHubConfigPath(repoRoot);
  const tempPath = `${configPath}.tmp`;
  await mkdir(dirname2(configPath), { recursive: true });
  await writeFile(tempPath, JSON.stringify(config, null, 2), "utf-8");
  await rename(tempPath, configPath);
}
async function isGitHubEnabled(repoRoot) {
  const config = await loadGitHubConfig(repoRoot);
  return config.enabled;
}
async function detectRepository(repoRoot) {
  try {
    const { stdout } = await execAsync("git remote get-url origin", { cwd: repoRoot });
    const url = stdout.trim();
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (match && match[1] && match[2]) {
      return { owner: match[1], repo: match[2] };
    }
    return null;
  } catch {
    return null;
  }
}
async function enableGitHub(repoRoot) {
  const config = await loadGitHubConfig(repoRoot);
  const repoInfo = await detectRepository(repoRoot);
  if (!repoInfo) {
    if (!config.owner || !config.repo) {
      throw new Error("Could not detect GitHub repository from 'origin' remote");
    }
  } else {
    config.owner = repoInfo.owner;
    config.repo = repoInfo.repo;
  }
  config.enabled = true;
  await saveGitHubConfig(repoRoot, config);
}
async function disableGitHub(repoRoot) {
  const config = await loadGitHubConfig(repoRoot);
  config.enabled = false;
  await saveGitHubConfig(repoRoot, config);
}

// src/lib/github/branches.ts
import { execSync as execSync2 } from "node:child_process";

// src/lib/github/auth.ts
import { execSync } from "node:child_process";
function getAuthFromEnv() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (process.env.DEBUG_AUTH) {
    console.log(`[auth] GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? `set (${process.env.GITHUB_TOKEN.substring(0, 15)}...)` : "not set"}`);
    console.log(`[auth] GH_TOKEN: ${process.env.GH_TOKEN ? `set (${process.env.GH_TOKEN.substring(0, 15)}...)` : "not set"}`);
    console.log(`[auth] Using: ${process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "GH_TOKEN"}`);
  }
  return token;
}
function getAuthFromGhCli() {
  try {
    const token = execSync("gh auth token", { encoding: "utf-8" }).trim();
    return token || undefined;
  } catch {
    return;
  }
}
function getGitHubAuth() {
  return getAuthFromEnv() || getAuthFromGhCli();
}

class GitHubAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubAuthError";
  }
}
async function ensureGitHubAuth(owner, repo) {
  const token = getGitHubAuth();
  if (!token) {
    throw new GitHubAuthError("No GitHub authentication found. Please set GITHUB_TOKEN/GH_TOKEN or login via 'gh auth login'.");
  }
  const isValid = await validateAuth(token, owner, repo);
  if (!isValid) {
    throw new GitHubAuthError("Invalid GitHub authentication token.");
  }
  return token;
}
async function validateAuth(token, owner, repo) {
  try {
    const url = owner && repo ? `https://api.github.com/repos/${owner}/${repo}` : "https://api.github.com/rate_limit";
    if (process.env.DEBUG_AUTH) {
      console.log(`[auth] Validating against: ${url}`);
    }
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "opencode-agent"
      }
    });
    if (process.env.DEBUG_AUTH) {
      console.log(`[auth] Response status: ${response.status}`);
    }
    return response.ok;
  } catch (error) {
    if (process.env.DEBUG_AUTH) {
      console.log(`[auth] Fetch error: ${error}`);
    }
    return false;
  }
}

// src/lib/github/client.ts
class GitHubClient {
  token;
  repository;
  baseUrl = "https://api.github.com";
  constructor(token, repository) {
    this.token = token;
    this.repository = repository;
  }
  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github.v3+json"
    };
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        errorBody = "(unable to read error body)";
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorBody}`);
    }
    if (response.status === 204) {
      return {};
    }
    return response.json();
  }
  async createIssue(title, body, labels = []) {
    return this.request(`/repos/${this.repository.owner}/${this.repository.repo}/issues`, {
      method: "POST",
      body: { title, body, labels }
    });
  }
  async updateIssue(issueNumber, updates) {
    return this.request(`/repos/${this.repository.owner}/${this.repository.repo}/issues/${issueNumber}`, {
      method: "PATCH",
      body: updates
    });
  }
  async closeIssue(issueNumber) {
    return this.updateIssue(issueNumber, { state: "closed" });
  }
  async reopenIssue(issueNumber) {
    return this.updateIssue(issueNumber, { state: "open" });
  }
  async getIssue(issueNumber) {
    return this.request(`/repos/${this.repository.owner}/${this.repository.repo}/issues/${issueNumber}`);
  }
  async searchIssues(query) {
    const queryParts = [
      `repo:${this.repository.owner}/${this.repository.repo}`,
      "is:issue"
    ];
    if (query.state && query.state !== "all") {
      queryParts.push(`state:${query.state}`);
    }
    if (query.labels && query.labels.length > 0) {
      for (const label of query.labels) {
        queryParts.push(`label:"${label}"`);
      }
    }
    if (query.title) {
      queryParts.push(`"${query.title.replace(/"/g, "\\\"")}" in:title`);
    }
    const searchQuery = queryParts.join(" ");
    const encodedQuery = encodeURIComponent(searchQuery);
    const response = await this.request(`/search/issues?q=${encodedQuery}&per_page=100`);
    return response.items || [];
  }
  async createLabel(name, color, description) {
    return this.request(`/repos/${this.repository.owner}/${this.repository.repo}/labels`, {
      method: "POST",
      body: { name, color, description }
    });
  }
  async ensureLabels(labels) {
    const existingLabels = await this.request(`/repos/${this.repository.owner}/${this.repository.repo}/labels?per_page=100`);
    const existingNames = new Set(existingLabels.map((l) => l.name));
    for (const label of labels) {
      if (!existingNames.has(label.name)) {
        await this.createLabel(label.name, label.color, label.description);
      }
    }
  }
  async getBranch(branch) {
    return this.request(`/repos/${this.repository.owner}/${this.repository.repo}/branches/${branch}`);
  }
  async createBranch(name, fromBranch) {
    const base = await this.getBranch(fromBranch);
    return this.request(`/repos/${this.repository.owner}/${this.repository.repo}/git/refs`, {
      method: "POST",
      body: {
        ref: `refs/heads/${name}`,
        sha: base.commit.sha
      }
    });
  }
  async createPullRequest(title, body, head, base, draft = false) {
    return this.request(`/repos/${this.repository.owner}/${this.repository.repo}/pulls`, {
      method: "POST",
      body: { title, body, head, base, draft }
    });
  }
}
var createGitHubClient = (token, owner, repo) => {
  return new GitHubClient(token, { owner, repo });
};

// src/lib/github/branches.ts
init_lib();
function formatBranchName(config, streamId) {
  const prefix = config.branch_prefix || "workstream/";
  return `${prefix}${streamId}`;
}
function localBranchExists(repoRoot, branchName) {
  try {
    execSync2(`git rev-parse --verify ${branchName}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return true;
  } catch {
    return false;
  }
}
function deleteLocalBranchIfExists(repoRoot, branchName) {
  if (!localBranchExists(repoRoot, branchName)) {
    return;
  }
  execSync2(`git branch -D ${branchName}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}
function deleteRemoteBranchIfExists(repoRoot, branchName) {
  try {
    execSync2(`git push origin --delete ${branchName}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch {}
}
async function createWorkstreamBranch(repoRoot, streamId, fromRef) {
  const config = await loadGitHubConfig(repoRoot);
  if (!config.enabled) {
    throw new Error("GitHub integration is not enabled. Run 'work github enable' first.");
  }
  if (!config.owner || !config.repo) {
    throw new Error("GitHub repository not configured. Run 'work github enable' first.");
  }
  const branchName = formatBranchName(config, streamId);
  await storeWorkstreamBranchMeta(repoRoot, streamId, branchName);
  commitPendingChanges(repoRoot);
  deleteLocalBranchIfExists(repoRoot, branchName);
  deleteRemoteBranchIfExists(repoRoot, branchName);
  execSync2(`git checkout -b ${branchName}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  execSync2(`git push -u origin ${branchName}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const sha = execSync2("git rev-parse HEAD", {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
  return {
    branchName,
    sha,
    url: `https://github.com/${config.owner}/${config.repo}/tree/${branchName}`
  };
}
function commitPendingChanges(repoRoot) {
  execSync2("git add -A", {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stagedFiles = execSync2("git diff --cached --name-only", {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
  if (!stagedFiles) {
    return false;
  }
  execSync2('git commit -m "workstream start"', {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return true;
}
async function workstreamBranchExists(repoRoot, streamId) {
  const config = await loadGitHubConfig(repoRoot);
  if (!config.enabled || !config.owner || !config.repo) {
    return false;
  }
  const token = await ensureGitHubAuth();
  const client = createGitHubClient(token, config.owner, config.repo);
  const branchName = formatBranchName(config, streamId);
  try {
    await client.getBranch(branchName);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return false;
    }
    throw error;
  }
}
async function storeWorkstreamBranchMeta(repoRoot, streamId, branchName) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamId || s.name === streamId);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamId}" not found`);
  }
  const stream = index.streams[streamIndex];
  stream.github = {
    ...stream.github,
    branch: branchName
  };
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
}
function getWorkstreamBranchName(repoRoot, streamId) {
  const index = loadIndex(repoRoot);
  const stream = getStream(index, streamId);
  return stream.github?.branch;
}

// src/lib/roles.ts
var COMMAND_PERMISSIONS = {
  approve: {
    allowedRoles: ["USER"],
    denialMessage: "Approval requires human oversight. Ask the user to run `work approve <target>`"
  },
  start: {
    allowedRoles: ["USER"],
    denialMessage: "Starting a workstream requires human approval. Ask the user to run `work start`"
  },
  complete: {
    allowedRoles: ["USER"],
    denialMessage: "Completing a workstream requires human approval. Ask the user to run `work complete`"
  },
  status: { allowedRoles: ["USER", "AGENT"] },
  list: { allowedRoles: ["USER", "AGENT"] },
  tree: { allowedRoles: ["USER", "AGENT"] },
  update: { allowedRoles: ["USER", "AGENT"] },
  review: { allowedRoles: ["USER", "AGENT"] },
  current: { allowedRoles: ["USER", "AGENT"] },
  init: { allowedRoles: ["USER", "AGENT"] },
  fix: { allowedRoles: ["USER", "AGENT"] },
  generate: { allowedRoles: ["USER", "AGENT"] },
  delete: { allowedRoles: ["USER", "AGENT"] },
  plan: { allowedRoles: ["USER", "AGENT"] },
  agents: { allowedRoles: ["USER", "AGENT"] },
  prompts: { allowedRoles: ["USER", "AGENT"] }
};
function getCurrentRole() {
  const envRole = process.env.WORKSTREAM_ROLE?.toUpperCase();
  if (envRole === "USER")
    return "USER";
  return "AGENT";
}
function canExecuteCommand(command) {
  const permission = COMMAND_PERMISSIONS[command];
  if (!permission)
    return true;
  return permission.allowedRoles.includes(getCurrentRole());
}
function getRoleDenialMessage(command) {
  const role = getCurrentRole();
  const permission = COMMAND_PERMISSIONS[command];
  if (role === "AGENT") {
    const agentMessage = permission?.denialMessage || `This command requires human approval. Ask the user to run \`work ${command}\``;
    return `Access denied: ${agentMessage}`;
  }
  const baseMessage = permission?.denialMessage || `This command is not available`;
  return `Access denied: ${baseMessage}`;
}

// src/lib/report-template.ts
init_marked_esm();
init_lib();
init_repo();
init_stream_parser();
import { join as join10 } from "path";
import { readFileSync as readFileSync7 } from "fs";
function generateReportTemplate(repoRoot, streamId) {
  const index = loadIndex(repoRoot);
  const stream = findStream(index, streamId);
  if (!stream) {
    throw new Error(`Workstream "${streamId}" not found`);
  }
  const workDir = getWorkDir(repoRoot);
  const planPath = join10(workDir, stream.id, "PLAN.md");
  const planContent = readFileSync7(planPath, "utf-8");
  const errors = [];
  const planDoc = parseStreamDocument(planContent, errors);
  if (!planDoc || errors.length > 0) {
    throw new Error(`Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`);
  }
  const lines = [];
  lines.push(`# Report: ${stream.name}`);
  lines.push("");
  lines.push(`> **Stream ID:** ${stream.id} | **Reported:** ${new Date().toISOString().split("T")[0]}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("<!-- High-level summary of what was achieved -->");
  lines.push("");
  lines.push("## Accomplishments");
  lines.push("");
  for (const stage of planDoc.stages) {
    const stagePrefix = stage.id.toString().padStart(2, "0");
    lines.push(`### Stage ${stagePrefix}: ${stage.name}`);
    lines.push("<!-- What was accomplished in this stage -->");
    lines.push("");
    lines.push("#### Key Changes");
    lines.push("- {description}");
    lines.push("");
  }
  lines.push("## File References");
  lines.push("");
  lines.push("| File | Changes |");
  lines.push("|------|---------|");
  lines.push("| `path/to/file.ts` | Description of changes |");
  lines.push("");
  lines.push("## Issues & Blockers");
  lines.push("<!-- Any issues encountered, bugs found, or blockers hit -->");
  lines.push("");
  lines.push("## Next Steps");
  lines.push("<!-- Recommended follow-up work -->");
  lines.push("");
  return lines.join(`
`);
}
function parseReport(repoRoot, streamId) {
  const index = loadIndex(repoRoot);
  const stream = findStream(index, streamId);
  if (!stream) {
    throw new Error(`Workstream "${streamId}" not found`);
  }
  const workDir = getWorkDir(repoRoot);
  const reportPath = join10(workDir, stream.id, "REPORT.md");
  const content = readFileSync7(reportPath, "utf-8");
  const lexer = new x;
  const tokens = lexer.lex(content);
  const report = {
    streamId: stream.id,
    streamName: stream.name,
    reportedDate: "",
    summary: "",
    accomplishments: [],
    fileReferences: [],
    issues: "",
    nextSteps: ""
  };
  let currentSection = null;
  let currentStage = null;
  let inKeyChanges = false;
  for (let i = 0;i < tokens.length; i++) {
    const token = tokens[i];
    if (!token)
      continue;
    if (token.type === "blockquote") {
      const blockquote = token;
      const text = extractTextFromTokens2(blockquote.tokens);
      const dateMatch = text.match(/\*\*Reported:\*\*\s*(\S+)/);
      if (dateMatch && dateMatch[1]) {
        report.reportedDate = dateMatch[1];
      }
    }
    if (token.type === "heading") {
      const heading = token;
      const text = heading.text;
      if (heading.depth === 2) {
        if (text === "Summary") {
          currentSection = "summary";
          currentStage = null;
          inKeyChanges = false;
        } else if (text === "Accomplishments") {
          currentSection = "accomplishments";
          currentStage = null;
          inKeyChanges = false;
        } else if (text === "File References") {
          currentSection = "fileReferences";
          currentStage = null;
          inKeyChanges = false;
        } else if (text.includes("Issues")) {
          currentSection = "issues";
          currentStage = null;
          inKeyChanges = false;
        } else if (text === "Next Steps") {
          currentSection = "nextSteps";
          currentStage = null;
          inKeyChanges = false;
        }
      } else if (heading.depth === 3 && currentSection === "accomplishments") {
        const stageMatch = text.match(/Stage\s+(\d+):\s*(.+)/);
        if (stageMatch && stageMatch[1] && stageMatch[2]) {
          if (currentStage) {
            report.accomplishments.push({
              stageNumber: currentStage.stageNumber,
              stageName: currentStage.stageName,
              description: currentStage.description.trim(),
              keyChanges: currentStage.keyChanges
            });
          }
          currentStage = {
            stageNumber: parseInt(stageMatch[1], 10),
            stageName: stageMatch[2],
            description: "",
            keyChanges: []
          };
          inKeyChanges = false;
        }
      } else if (heading.depth === 4 && currentStage && text === "Key Changes") {
        inKeyChanges = true;
      }
    }
    if (token.type === "paragraph") {
      const para = token;
      const text = para.text;
      if (text.startsWith("<!--"))
        continue;
      if (currentSection === "summary") {
        report.summary += text + `
`;
      } else if (currentSection === "issues") {
        report.issues += text + `
`;
      } else if (currentSection === "nextSteps") {
        report.nextSteps += text + `
`;
      } else if (currentStage && !inKeyChanges) {
        currentStage.description += text + `
`;
      }
    }
    if (token.type === "list" && currentStage && inKeyChanges) {
      const list = token;
      for (const item of list.items) {
        const text = extractTextFromTokens2(item.tokens);
        if (!text.includes("{description}")) {
          currentStage.keyChanges.push(text.trim());
        }
      }
    }
    if (token.type === "table" && currentSection === "fileReferences") {
      const table = token;
      for (const row of table.rows) {
        const cells = row.map((cell) => extractTextFromTokens2(cell.tokens).trim());
        if (cells.length >= 2 && cells[0] && cells[1]) {
          const path = cells[0].replace(/`/g, "");
          const changes = cells[1];
          if (!path.includes("path/to/file")) {
            report.fileReferences.push({ path, changes });
          }
        }
      }
    }
  }
  if (currentStage) {
    report.accomplishments.push({
      stageNumber: currentStage.stageNumber,
      stageName: currentStage.stageName,
      description: currentStage.description.trim(),
      keyChanges: currentStage.keyChanges
    });
  }
  report.summary = report.summary.trim();
  report.issues = report.issues.trim();
  report.nextSteps = report.nextSteps.trim();
  return report;
}
function validateReport(repoRoot, streamId) {
  const errors = [];
  const warnings = [];
  try {
    const report = parseReport(repoRoot, streamId);
    if (!report.summary || report.summary.length === 0) {
      errors.push("Summary section is empty or missing");
    }
    if (report.accomplishments.length === 0) {
      errors.push("No stage accomplishments found");
    } else {
      for (const accomplishment of report.accomplishments) {
        if (!accomplishment.description || accomplishment.description.length === 0) {
          warnings.push(`Stage ${accomplishment.stageNumber.toString().padStart(2, "0")} (${accomplishment.stageName}) has no description`);
        }
        if (accomplishment.keyChanges.length === 0) {
          warnings.push(`Stage ${accomplishment.stageNumber.toString().padStart(2, "0")} (${accomplishment.stageName}) has no key changes listed`);
        }
      }
    }
    if (report.fileReferences.length === 0) {
      warnings.push("No file references documented");
    }
    if (!report.issues || report.issues.length === 0) {
      warnings.push("Issues & Blockers section is empty");
    }
    if (!report.nextSteps || report.nextSteps.length === 0) {
      warnings.push("Next Steps section is empty");
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  } catch (error) {
    return {
      valid: false,
      errors: [`Failed to parse REPORT.md: ${error instanceof Error ? error.message : String(error)}`],
      warnings
    };
  }
}
function extractTextFromTokens2(tokens) {
  let text = "";
  for (const token of tokens) {
    if (token.type === "paragraph") {
      const para = token;
      text += para.text + " ";
    } else if (token.type === "text") {
      const txt = token;
      text += txt.text + " ";
    } else if (token.type === "strong") {
      const strong = token;
      text += extractTextFromTokens2(strong.tokens) + " ";
    } else if (token.type === "em") {
      const em = token;
      text += extractTextFromTokens2(em.tokens) + " ";
    } else if (token.type === "codespan") {
      const code = token;
      text += code.text + " ";
    }
  }
  return text.trim();
}

// src/cli/complete.ts
function printHelp4() {
  console.log(`
work complete - Mark a workstream as complete

Requires: USER role

Usage:
  work complete [--stream <id>] [--no-commit] [--no-pr] [--target <branch>] [--draft] [--force]

Options:
  --stream, -s      Workstream ID or name (uses current if not specified)
  --repo-root, -r   Repository root (auto-detected if omitted)
  --commit          Commit and push changes (default: true)
  --no-commit       Skip committing and pushing changes
  --pr              Create a pull request (default: true)
  --no-pr           Skip creating a pull request
  --target, -t      Target branch for PR (default from config or "main")
  --draft           Create PR as draft
  --force, -f       Bypass REPORT.md validation (not recommended)
  --json            Output result as JSON
  --help, -h        Show this help message

REPORT.md Requirement:
  A valid REPORT.md file is required before completing a workstream.
  The report must have:
    - Summary section with content
    - At least one stage accomplishment
  
  If missing or invalid, run 'work report init' to create the template.
  Use --force to bypass validation (completion will succeed with warning).

Git Operations (when --commit is enabled):
  1. Stages all changes with 'git add -A'
  2. Creates commit: "Completed workstream: {name}"
  3. Pushes to origin/{branch-name}
  4. Shows commit SHA

PR Creation (when --pr is enabled):
  1. Creates PR with title: [{stream-id}] {stream-name}
  2. Body includes summary, PLAN.md link, task counts
  3. Stores PR number in stream metadata

Examples:
  # Mark current workstream complete (with commit/push and PR)
  work complete

  # Mark complete without committing
  work complete --no-commit

  # Mark complete without PR
  work complete --no-pr

  # Create PR targeting develop branch
  work complete --target develop

  # Create a draft PR
  work complete --draft

  # Mark specific workstream complete
  work complete --stream "001-my-stream"

  # Bypass REPORT.md validation (not recommended)
  work complete --force
`);
}
function parseCliArgs4(argv) {
  const args = argv.slice(2);
  const parsed = {
    commit: true,
    pr: true,
    draft: false,
    json: false,
    force: false
  };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--commit":
        parsed.commit = true;
        break;
      case "--no-commit":
        parsed.commit = false;
        break;
      case "--pr":
        parsed.pr = true;
        break;
      case "--no-pr":
        parsed.pr = false;
        break;
      case "--target":
      case "-t":
        if (!next) {
          console.error("Error: --target requires a value");
          return null;
        }
        parsed.target = next;
        i++;
        break;
      case "--draft":
        parsed.draft = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--force":
      case "-f":
        parsed.force = true;
        break;
      case "--help":
      case "-h":
        printHelp4();
        process.exit(0);
    }
  }
  return parsed;
}
function performGitOperations(repoRoot, streamId, streamName, summary) {
  const result = {
    staged: false,
    committed: false,
    pushed: false,
    alreadyPushed: false
  };
  const branchName = getWorkstreamBranchName(repoRoot, streamId);
  if (!branchName) {
    result.error = "No GitHub branch found for this workstream. Run 'work github create-branch' first.";
    return result;
  }
  try {
    execSync3("git add -A", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    result.staged = true;
    const statusOutput = execSync3("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    if (!statusOutput) {
      const unpushed = checkForUnpushedCommits(repoRoot, branchName);
      if (!unpushed) {
        result.alreadyPushed = true;
        result.commitSha = getCurrentCommitSha(repoRoot);
        return result;
      }
    } else {
      const commitMessage = `Completed workstream: ${streamName}`;
      const commitBody = summary ? `
Stream ID: ${streamId}

${summary}` : `
Stream ID: ${streamId}`;
      execSync3(`git commit -m "${commitMessage}" -m "${commitBody.replace(/"/g, "\\\"")}"`, {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      result.committed = true;
    }
    result.commitSha = getCurrentCommitSha(repoRoot);
    try {
      execSync3(`git push origin ${branchName}`, {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      result.pushed = true;
    } catch (pushError) {
      const errorMessage = pushError.message || String(pushError);
      if (errorMessage.includes("Everything up-to-date")) {
        result.alreadyPushed = true;
        result.pushed = true;
      } else {
        result.error = `Push failed: ${errorMessage}`;
      }
    }
    return result;
  } catch (error) {
    const errorMessage = error.message || String(error);
    result.error = errorMessage;
    return result;
  }
}
function checkForUnpushedCommits(repoRoot, branchName) {
  try {
    const result = execSync3(`git log origin/${branchName}..HEAD --oneline`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return result.length > 0;
  } catch {
    return true;
  }
}
function getCurrentCommitSha(repoRoot) {
  return execSync3("git rev-parse HEAD", {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}
function getCurrentBranch(repoRoot) {
  try {
    const result = execSync3("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return result.trim();
  } catch {
    return null;
  }
}
function checkAllStagesApproved(repoRoot, stream, streamId) {
  if (!isApproved(stream)) {
    return { allApproved: false, unapprovedStages: [] };
  }
  const consolidateResult = consolidateStream(repoRoot, streamId, true);
  if (!consolidateResult.success || !consolidateResult.streamDocument) {
    return { allApproved: false, unapprovedStages: [] };
  }
  const stageNumbers = consolidateResult.streamDocument.stages.map((s) => s.id);
  const unapprovedStages = [];
  for (const stageNum of stageNumbers) {
    const stageStatus = getStageApprovalStatus(stream, stageNum);
    if (stageStatus !== "approved") {
      unapprovedStages.push(stageNum);
    }
  }
  return {
    allApproved: unapprovedStages.length === 0,
    unapprovedStages
  };
}
function getTaskSummary(repoRoot, streamId) {
  const tasks = getTasks(repoRoot, streamId);
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
    pending: tasks.filter((t) => t.status === "pending").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    cancelled: tasks.filter((t) => t.status === "cancelled").length
  };
}
function storeCompletionMetadata(repoRoot, streamId) {
  const index = loadIndex(repoRoot);
  const streamIndex = index.streams.findIndex((s) => s.id === streamId || s.name === streamId);
  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamId}" not found`);
  }
  const stream = index.streams[streamIndex];
  stream.github = {
    ...stream.github,
    completed_at: new Date().toISOString()
  };
  stream.updated_at = new Date().toISOString();
  saveIndex(repoRoot, index);
}
function formatPRTitle(streamId, streamName) {
  return `[${streamId}] ${streamName}`;
}
function formatPRBody(repoRoot, streamId, streamName, owner, repo) {
  const taskSummary = getTaskSummary(repoRoot, streamId);
  const planPath = `work/${streamId}/PLAN.md`;
  const lines = [
    `## Summary`,
    ``,
    `Completes workstream: **${streamName}**`,
    ``,
    `## Details`,
    ``,
    `- **Stream ID:** \`${streamId}\``,
    `- **Plan:** [PLAN.md](${planPath})`,
    ``,
    `## Task Completion`,
    ``,
    `| Status | Count |`,
    `|--------|-------|`,
    `| Completed | ${taskSummary.completed} |`,
    `| In Progress | ${taskSummary.inProgress} |`,
    `| Pending | ${taskSummary.pending} |`,
    `| Blocked | ${taskSummary.blocked} |`,
    `| Cancelled | ${taskSummary.cancelled} |`,
    `| **Total** | **${taskSummary.total}** |`,
    ``,
    `---`,
    `*Generated by \`work complete\`*`
  ];
  return lines.join(`
`);
}
async function createWorkstreamPR(repoRoot, streamId, streamName, branchName, targetBranch, draft) {
  try {
    const config = await loadGitHubConfig(repoRoot);
    const token = getGitHubAuth();
    if (!token) {
      return {
        success: false,
        error: "No GitHub authentication found. Set GITHUB_TOKEN/GH_TOKEN or run 'gh auth login'."
      };
    }
    if (!config.owner || !config.repo) {
      return {
        success: false,
        error: "GitHub repository not configured. Run 'work github enable' first."
      };
    }
    const client = createGitHubClient(token, config.owner, config.repo);
    const title = formatPRTitle(streamId, streamName);
    const body = formatPRBody(repoRoot, streamId, streamName, config.owner, config.repo);
    const pr = await client.createPullRequest(title, body, branchName, targetBranch, draft);
    return {
      success: true,
      prNumber: pr.number,
      prUrl: pr.html_url
    };
  } catch (error) {
    const errorMessage = error.message || String(error);
    return {
      success: false,
      error: errorMessage
    };
  }
}
async function validateCompletion(repoRoot, stream, cliArgs) {
  const errors = [];
  const warnings = [];
  let branchName;
  let targetBranch = cliArgs.target || "main";
  const githubEnabled = await isGitHubEnabled(repoRoot);
  if (!githubEnabled) {
    errors.push("GitHub integration is not enabled. Run 'work github enable' first.");
  }
  let branchExists = false;
  if (githubEnabled) {
    const config = await loadGitHubConfig(repoRoot);
    branchName = getWorkstreamBranchName(repoRoot, stream.id) || formatBranchName(config, stream.id);
    branchExists = await workstreamBranchExists(repoRoot, stream.id);
    if (!branchExists) {
      errors.push(`Workstream branch '${branchName}' does not exist. Run 'work github create-branch' first.`);
    }
    if (!cliArgs.target) {
      targetBranch = config.default_pr_target || "main";
    }
  }
  if (githubEnabled && branchExists && branchName) {
    const currentBranch = getCurrentBranch(repoRoot);
    if (currentBranch !== branchName) {
      errors.push(`Not on workstream branch. Current branch: '${currentBranch}', expected: '${branchName}'`);
    }
  }
  const approvalCheck = checkAllStagesApproved(repoRoot, stream, stream.id);
  if (!isApproved(stream)) {
    errors.push("Workstream plan is not approved. Run 'work approve' first.");
  } else if (!approvalCheck.allApproved) {
    for (const stageNum of approvalCheck.unapprovedStages) {
      errors.push(`Stage ${stageNum} is not approved. Run 'work approve stage ${stageNum}' first.`);
    }
  }
  if (!cliArgs.force) {
    const workDir = getWorkDir(repoRoot);
    const reportPath = join11(workDir, stream.id, "REPORT.md");
    if (!existsSync8(reportPath)) {
      errors.push("REPORT.md is missing. Run 'work report init' to create it, or use --force to bypass.");
    } else {
      const reportValidation = validateReport(repoRoot, stream.id);
      if (!reportValidation.valid) {
        errors.push("REPORT.md validation failed:");
        for (const error of reportValidation.errors) {
          errors.push(`  - ${error}`);
        }
        errors.push("Fix the issues above or use --force to bypass.");
      }
      for (const warning of reportValidation.warnings) {
        warnings.push(`REPORT.md: ${warning}`);
      }
    }
  }
  const taskSummary = getTaskSummary(repoRoot, stream.id);
  if (taskSummary.inProgress > 0) {
    warnings.push(`${taskSummary.inProgress} task(s) still in progress`);
  }
  if (taskSummary.pending > 0) {
    warnings.push(`${taskSummary.pending} task(s) still pending`);
  }
  if (taskSummary.blocked > 0) {
    warnings.push(`${taskSummary.blocked} task(s) blocked`);
  }
  return { errors, warnings, branchName, targetBranch };
}
async function main4(argv = process.argv) {
  const cliArgs = parseCliArgs4(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!canExecuteCommand("complete")) {
    console.error(getRoleDenialMessage("complete"));
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let resolvedStreamId;
  try {
    const index = loadIndex(repoRoot);
    const stream2 = getResolvedStream(index, cliArgs.streamId);
    resolvedStreamId = stream2.id;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const stream = getResolvedStream(loadIndex(repoRoot), resolvedStreamId);
  const validation = await validateCompletion(repoRoot, stream, cliArgs);
  const taskSummary = getTaskSummary(repoRoot, stream.id);
  if (cliArgs.force) {
    const workDir = getWorkDir(repoRoot);
    const reportPath = join11(workDir, stream.id, "REPORT.md");
    if (!existsSync8(reportPath)) {
      validation.warnings.push("WARNING: REPORT.md is missing (bypassed with --force)");
    } else {
      const reportValidation = validateReport(repoRoot, stream.id);
      if (!reportValidation.valid) {
        validation.warnings.push("WARNING: REPORT.md validation failed (bypassed with --force)");
      }
    }
  }
  if (validation.errors.length > 0) {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        success: false,
        errors: validation.errors,
        warnings: validation.warnings,
        stream: stream.id,
        tasks: taskSummary
      }, null, 2));
    } else {
      console.error(`Cannot complete workstream. The following issues must be resolved:
`);
      for (const error of validation.errors) {
        console.error(`  - ${error}`);
      }
      if (validation.warnings.length > 0) {
        console.log(`
Warnings:`);
        for (const warning of validation.warnings) {
          console.log(`  - ${warning}`);
        }
      }
    }
    process.exit(1);
  }
  try {
    storeCompletionMetadata(repoRoot, stream.id);
    const result = completeStream({
      repoRoot,
      streamId: stream.id
    });
    console.log(`Marked workstream "${result.streamId}" as complete`);
    console.log(`   Completed at: ${result.completedAt}`);
    console.log(`   Metrics:      ${result.completionPath}`);
    if (cliArgs.commit) {
      console.log("");
      console.log("Git Operations:");
      const gitResult = performGitOperations(repoRoot, resolvedStreamId, stream.name, `Workstream completed.`);
      if (gitResult.error) {
        console.log(`   Error: ${gitResult.error}`);
      } else {
        if (gitResult.staged) {
          console.log("   Staged all changes");
        }
        if (gitResult.committed) {
          console.log(`   Committed: "Completed workstream: ${stream.name}"`);
        }
        if (gitResult.alreadyPushed && !gitResult.committed) {
          console.log("   No new changes to commit (already up-to-date)");
        }
        if (gitResult.pushed) {
          const branchName = getWorkstreamBranchName(repoRoot, resolvedStreamId);
          if (gitResult.alreadyPushed && gitResult.committed) {
            console.log(`   Pushed to origin/${branchName}`);
          } else if (gitResult.alreadyPushed) {
            console.log(`   Already pushed to origin/${branchName}`);
          } else {
            console.log(`   Pushed to origin/${branchName}`);
          }
        }
        if (gitResult.commitSha) {
          console.log(`   Commit SHA: ${gitResult.commitSha}`);
        }
      }
    }
    if (cliArgs.pr) {
      console.log("");
      console.log("Pull Request:");
      const githubEnabled = await isGitHubEnabled(repoRoot);
      if (!githubEnabled) {
        console.log("   Skipped: GitHub integration is not enabled");
      } else {
        const config = await loadGitHubConfig(repoRoot);
        const branchName = getWorkstreamBranchName(repoRoot, resolvedStreamId) || formatBranchName(config, resolvedStreamId);
        const targetBranch = cliArgs.target || config.default_pr_target || "main";
        const prResult = await createWorkstreamPR(repoRoot, resolvedStreamId, stream.name, branchName, targetBranch, cliArgs.draft);
        if (prResult.error) {
          console.log(`   Error: ${prResult.error}`);
        } else {
          console.log(`   Created PR #${prResult.prNumber}`);
          if (cliArgs.draft) {
            console.log("   Status: Draft");
          }
          console.log(`   Target: ${targetBranch}`);
          console.log(`   URL: ${prResult.prUrl}`);
        }
      }
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/update-index.ts
init_repo();
init_lib();
function printHelp5() {
  console.log(`
work index - Update workstream metadata fields

Usage:
  work index [--stream <id>] --field <path> --value <value>
  work index [--stream <id>] --list

Options:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --field, -f      Field path using dot notation (e.g., "status")
  --value, -v      New value (auto-parsed to appropriate type)
  --list, -l       List current workstream fields
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Field Examples:
  name                            Workstream name
  status                          Workstream status (pending/in_progress/completed/on_hold)
  session_estimated.length        Number of estimated sessions

Value Parsing:
  "true"/"false"  -> boolean
  "123"           -> number
  "{...}"/"[...]" -> JSON
  anything else   -> string

Examples:
  # List workstream fields (uses current workstream)
  work index --list

  # Update workstream status
  work index --field "status" --value "on_hold"

  # List fields for a specific workstream
  work index --stream "001-my-stream" --list
`);
}
function parseCliArgs5(argv) {
  const args = argv.slice(2);
  const parsed = { list: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--field":
      case "-f":
        if (!next) {
          console.error("Error: --field requires a value");
          return null;
        }
        parsed.field = next;
        i++;
        break;
      case "--value":
      case "-v":
        if (!next) {
          console.error("Error: --value requires a value");
          return null;
        }
        parsed.value = next;
        i++;
        break;
      case "--list":
      case "-l":
        parsed.list = true;
        break;
      case "--help":
      case "-h":
        printHelp5();
        process.exit(0);
    }
  }
  if (!parsed.list && (!parsed.field || parsed.value === undefined)) {
    console.error("Error: --field and --value are required when not using --list");
    return null;
  }
  return parsed;
}
function main5(argv = process.argv) {
  const cliArgs = parseCliArgs5(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    console.log(`
Available workstreams:`);
    for (const s of index.streams) {
      console.log(`  - ${s.id} (${s.name})`);
    }
    process.exit(1);
  }
  if (cliArgs.list) {
    console.log(formatStreamInfo(stream));
    return;
  }
  try {
    const result = updateIndexField({
      repoRoot,
      streamId: stream.id,
      field: cliArgs.field,
      value: cliArgs.value
    });
    console.log(`Updated ${result.field} in workstream "${result.streamId}"`);
    console.log(`   Previous: ${JSON.stringify(result.previousValue)}`);
    console.log(`   New: ${JSON.stringify(result.newValue)}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/read.ts
init_repo();
init_lib();
init_tasks();
function printHelp6() {
  console.log(`
work read - Read task details

Usage:
  work read --task <task-id> [--stream <stream-id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --task, -t       Task ID in format "stage.batch.thread.task" (e.g., "01.01.02.01") (required)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # Read task 01.01.02.01 (uses current workstream)
  work read --task "01.01.02.01"

  # Read task from specific workstream
  work read --stream "001-my-stream" --task "01.01.02.01"
`);
}
function parseCliArgs6(argv) {
  const args = argv.slice(2);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--task":
      case "-t":
        if (!next) {
          console.error("Error: --task requires a value");
          return null;
        }
        parsed.taskId = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp6();
        process.exit(0);
    }
  }
  return parsed;
}
function formatTask(task) {
  const lines = [];
  lines.push(`Task ${task.id}: ${task.name}`);
  lines.push(`Stage: ${task.stage_name}`);
  lines.push(`Thread: ${task.thread_name}`);
  lines.push(`Status: ${task.status}`);
  lines.push(`Updated: ${task.updated_at.split("T")[0]}`);
  return lines.join(`
`);
}
function main6(argv = process.argv) {
  const cliArgs = parseCliArgs6(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.taskId) {
    console.error("Error: --task is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const task = getTaskById(repoRoot, stream.id, cliArgs.taskId);
  if (!task) {
    console.error(`Error: Task "${cliArgs.taskId}" not found in workstream "${stream.id}"`);
    process.exit(1);
  }
  if (cliArgs.json) {
    console.log(JSON.stringify(task, null, 2));
  } else {
    console.log(formatTask(task));
  }
}
if (false) {}

// src/cli/list.ts
init_repo();
init_lib();
init_tasks();
function printHelp7() {
  console.log(`
work list - List tasks in a workstream

Usage:
  work list [--stream <stream-id>] [--tasks] [--status <status>]
            [--stage <n>] [--batch <id>] [--thread <id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --tasks          Show tasks (default if no other flags)
  --status         Filter by status (pending, in_progress, completed, blocked, cancelled)
  --stage          Filter by stage number (e.g. 1)
  --batch          Filter by batch ID (e.g. "01.02")
  --thread         Filter by thread ID (e.g. "01.02.03")
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # List all tasks (uses current workstream)
  work list --tasks

  # List only in-progress tasks
  work list --tasks --status in_progress

  # List tasks for a specific batch
  work list --tasks --batch "01.02"

  # List tasks for a specific workstream
  work list --stream "001-my-stream" --tasks
`);
}
function parseCliArgs7(argv) {
  const args = argv.slice(2);
  const parsed = { json: false, tasks: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--tasks":
        parsed.tasks = true;
        break;
      case "--status":
        if (!next) {
          console.error("Error: --status requires a value");
          return null;
        }
        const validStatuses = ["pending", "in_progress", "completed", "blocked", "cancelled"];
        if (!validStatuses.includes(next)) {
          console.error(`Error: Invalid status "${next}". Valid values: ${validStatuses.join(", ")}`);
          return null;
        }
        parsed.status = next;
        i++;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        const stageNum = parseInt(next, 10);
        if (isNaN(stageNum)) {
          console.error("Error: --stage must be a number");
          return null;
        }
        parsed.stage = stageNum;
        i++;
        break;
      case "--batch":
        if (!next) {
          console.error("Error: --batch requires a value");
          return null;
        }
        parsed.batch = next;
        i++;
        break;
      case "--thread":
        if (!next) {
          console.error("Error: --thread requires a value");
          return null;
        }
        parsed.thread = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp7();
        process.exit(0);
    }
  }
  if (!parsed.tasks) {
    parsed.tasks = true;
  }
  return parsed;
}
function statusToIcon(status) {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[~]";
    case "blocked":
      return "[!]";
    case "cancelled":
      return "[-]";
    default:
      return "[ ]";
  }
}
function formatTaskList(streamId, tasks) {
  const lines = [];
  const counts = {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    in_progress: tasks.filter((t) => t.status === "in_progress").length,
    pending: tasks.filter((t) => t.status === "pending").length,
    blocked: tasks.filter((t) => t.status === "blocked").length
  };
  lines.push(`Workstream: ${streamId}`);
  lines.push(`Tasks: ${counts.total} total | ${counts.completed} completed | ${counts.in_progress} in progress | ${counts.pending} pending`);
  lines.push("");
  const grouped = groupTasks(tasks, { byBatch: true });
  const stageEntries = Array.from(grouped.entries());
  stageEntries.sort((a, b2) => {
    const aFirstTask = getFirstTaskFromStage(a[1]);
    const bFirstTask = getFirstTaskFromStage(b2[1]);
    if (!aFirstTask || !bFirstTask)
      return 0;
    return parseInt(aFirstTask.id.split(".")[0], 10) - parseInt(bFirstTask.id.split(".")[0], 10);
  });
  for (const [stageName, batchMap] of stageEntries) {
    const firstTask = getFirstTaskFromStage(batchMap);
    const stageNum = firstTask ? firstTask.id.split(".")[0] : "?";
    lines.push(`Stage ${stageNum}: ${stageName}`);
    const batchEntries = Array.from(batchMap.entries());
    batchEntries.sort((a, b2) => {
      const aFirst = getFirstTaskFromBatch(a[1]);
      const bFirst = getFirstTaskFromBatch(b2[1]);
      if (!aFirst || !bFirst)
        return 0;
      return parseInt(aFirst.id.split(".")[1], 10) - parseInt(bFirst.id.split(".")[1], 10);
    });
    for (const [batchName, threadMap] of batchEntries) {
      const firstBatchTask = getFirstTaskFromBatch(threadMap);
      const batchNum = firstBatchTask ? firstBatchTask.id.split(".")[1] : "?";
      lines.push(`  Batch ${batchNum}: ${batchName}`);
      const threadEntries = Array.from(threadMap.entries());
      threadEntries.sort((a, b2) => {
        const aTask = a[1][0];
        const bTask = b2[1][0];
        if (!aTask || !bTask)
          return 0;
        return parseInt(aTask.id.split(".")[2], 10) - parseInt(bTask.id.split(".")[2], 10);
      });
      for (const [threadName, threadTasks] of threadEntries) {
        const threadNum = threadTasks[0]?.id.split(".")[2] ?? "?";
        lines.push(`    Thread ${threadNum}: ${threadName}`);
        for (const task of threadTasks) {
          const icon = statusToIcon(task.status);
          lines.push(`      ${icon} ${task.id} ${task.name}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join(`
`).trimEnd();
}
function getFirstTaskFromStage(batchMap) {
  const firstBatch = batchMap.values().next().value;
  return getFirstTaskFromBatch(firstBatch);
}
function getFirstTaskFromBatch(threadMap) {
  if (!threadMap)
    return;
  const firstThread = threadMap.values().next().value;
  return firstThread?.[0];
}
function main7(argv = process.argv) {
  const cliArgs = parseCliArgs7(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let tasks = getTasks(repoRoot, stream.id, cliArgs.status);
  if (cliArgs.stage !== undefined) {
    const stagePrefix = `${cliArgs.stage.toString().padStart(2, "0")}.`;
    tasks = tasks.filter((t) => t.id.startsWith(stagePrefix));
  }
  if (cliArgs.batch) {
    const batchPrefix = cliArgs.batch.endsWith(".") ? cliArgs.batch : `${cliArgs.batch}.`;
    tasks = tasks.filter((t) => t.id.startsWith(batchPrefix));
  }
  if (cliArgs.thread) {
    const threadPrefix = cliArgs.thread.endsWith(".") ? cliArgs.thread : `${cliArgs.thread}.`;
    tasks = tasks.filter((t) => t.id.startsWith(threadPrefix));
  }
  if (tasks.length === 0) {
    if (cliArgs.status) {
      console.log(`No tasks with status "${cliArgs.status}" found in workstream "${stream.id}"`);
    } else {
      console.log(`No tasks found in workstream "${stream.id}".`);
    }
    return;
  }
  if (cliArgs.json) {
    console.log(JSON.stringify(tasks, null, 2));
  } else {
    console.log(formatTaskList(stream.id, tasks));
  }
}
if (false) {}

// src/cli/add-task.ts
init_repo();
init_lib();
init_tasks();
import { readFileSync as readFileSync8 } from "fs";
init_stream_parser();

// src/lib/interactive.ts
import * as readline from "readline";
function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}
async function selectFromList(rl, prompt, items, displayFn) {
  console.log(`
${prompt}`);
  items.forEach((item, i) => {
    console.log(`  ${i + 1}. ${displayFn(item, i)}`);
  });
  return new Promise((resolve2, reject) => {
    rl.question(`
Enter number or name: `, (answer) => {
      const trimmed = answer.trim();
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= items.length) {
        resolve2({ index: num - 1, value: items[num - 1] });
        return;
      }
      const lowerAnswer = trimmed.toLowerCase();
      const matchIndex = items.findIndex((item) => displayFn(item, 0).toLowerCase().includes(lowerAnswer));
      if (matchIndex >= 0) {
        resolve2({ index: matchIndex, value: items[matchIndex] });
        return;
      }
      reject(new Error(`Invalid selection: "${trimmed}"`));
    });
  });
}
async function promptText(rl, prompt) {
  return new Promise((resolve2) => {
    rl.question(prompt, (answer) => {
      resolve2(answer.trim());
    });
  });
}
async function selectStage(rl, stages) {
  return selectFromList(rl, "Select stage:", stages, (stage) => `Stage ${stage.id.toString().padStart(2, "0")}: ${stage.name || "(unnamed)"}`);
}
async function selectBatch(rl, batches) {
  return selectFromList(rl, "Select batch:", batches, (batch) => `Batch ${batch.prefix}: ${batch.name || "(unnamed)"}`);
}
async function selectThread(rl, threads) {
  return selectFromList(rl, "Select thread:", threads, (thread) => `Thread ${thread.id}: ${thread.name || "(unnamed)"}`);
}
function calculateThreadStatus(tasks) {
  if (tasks.length === 0)
    return "incomplete";
  const allCompleted = tasks.every((t) => t.status === "completed" || t.status === "cancelled");
  if (allCompleted)
    return "completed";
  const hasFailed = tasks.some((t) => t.sessions && t.sessions.length > 0 && t.sessions[t.sessions.length - 1]?.status === "failed");
  if (hasFailed)
    return "failed";
  return "incomplete";
}
function getLastAgent(tasks) {
  for (let i = tasks.length - 1;i >= 0; i--) {
    const task = tasks[i];
    if (task?.sessions && task.sessions.length > 0) {
      const lastSession = task.sessions[task.sessions.length - 1];
      if (lastSession?.agentName) {
        return lastSession.agentName;
      }
    }
  }
  return;
}
function getSessionCount(tasks) {
  return tasks.reduce((sum, task) => {
    return sum + (task.sessions?.length || 0);
  }, 0);
}
function buildThreadStatuses(allTasks, threadIds) {
  return threadIds.map((threadId) => {
    const threadTasks = allTasks.filter((t) => t.id.startsWith(threadId + "."));
    const firstTask = threadTasks[0];
    return {
      threadId,
      threadName: firstTask?.thread_name || "(unknown)",
      status: calculateThreadStatus(threadTasks),
      sessionsCount: getSessionCount(threadTasks),
      lastAgent: getLastAgent(threadTasks)
    };
  });
}
function displayThreadStatusTable(statuses) {
  console.log(`
Thread Status:`);
  console.log("─".repeat(80));
  console.log(`${"Thread".padEnd(12)} ${"Status".padEnd(12)} ${"Sessions".padEnd(10)} ${"Last Agent".padEnd(20)}`);
  console.log("─".repeat(80));
  for (const status of statuses) {
    const statusDisplay = status.status.padEnd(12);
    const sessionsDisplay = status.sessionsCount.toString().padEnd(10);
    const agentDisplay = (status.lastAgent || "-").padEnd(20);
    console.log(`${status.threadId.padEnd(12)} ${statusDisplay} ${sessionsDisplay} ${agentDisplay}`);
  }
  console.log("─".repeat(80));
  console.log();
}
async function selectThreadFromStatuses(rl, statuses) {
  displayThreadStatusTable(statuses);
  return selectFromList(rl, "Select a thread to fix:", statuses, (status) => `${status.threadId} - ${status.threadName} (${status.status})`);
}
async function selectFixAction(rl, threadStatus) {
  const actions = [];
  if (threadStatus.status === "incomplete" && threadStatus.sessionsCount > 0) {
    actions.push({
      action: "resume",
      label: "Resume",
      description: "Continue the existing session"
    });
  }
  if (threadStatus.status === "failed" || threadStatus.status === "incomplete") {
    actions.push({
      action: "retry",
      label: "Retry",
      description: "Start a new session with the same agent"
    });
  }
  if (threadStatus.status !== "completed") {
    actions.push({
      action: "change-agent",
      label: "Change Agent",
      description: "Retry with a different agent"
    });
  }
  actions.push({
    action: "new-stage",
    label: "New Stage",
    description: "Create a new fix stage"
  });
  console.log(`
Available actions:`);
  actions.forEach((a, i) => {
    console.log(`  ${i + 1}. ${a.label} - ${a.description}`);
  });
  const result = await selectFromList(rl, `
Select action:`, actions, (a) => a.label);
  return result.value.action;
}
async function selectAgent(rl, agents) {
  console.log(`
Available agents:`);
  agents.forEach((agent, i) => {
    console.log(`  ${i + 1}. ${agent.name}`);
    console.log(`     ${agent.description}`);
    console.log(`     Best for: ${agent.bestFor}`);
    console.log();
  });
  return selectFromList(rl, "Select an agent:", agents, (agent) => agent.name);
}
async function confirmAction(rl, message) {
  const answer = await promptText(rl, `${message} (y/n): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

// src/cli/add-task.ts
function printHelp8() {
  console.log(`
work add-task - Add a task to a workstream

Usage:
  work add-task [--stage <n|name> --batch <n|name> --thread <n|name> --name "Task description"]

Interactive Mode:
  Run without stage/batch/thread flags to select interactively:
    work add-task

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --stage          Stage number or name (e.g., 1 or "setup")
  --batch, -b      Batch number or name (e.g., 1 or "core-setup")
  --thread, -t     Thread number or name (e.g., 2 or "migrations")
  --name, -n       Task description
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Adds a new task to the workstream's tasks.json file. The task ID is automatically
  generated based on the stage, batch, thread, and the next available task number.

  If stage, batch, or thread are not specified, interactive mode is enabled
  where you can select from the available options in PLAN.md.

  Task ID format: {stage}.{batch}.{thread}.{task} (e.g., 01.01.02.03)
  All numbers are zero-padded for consistent sorting.

Examples:
  # Interactive mode - select stage, batch, thread
  work add-task

  # Add a task using indices
  work add-task --stage 1 --batch 1 --thread 2 --name "Implement login form"

  # Add a task using names (case-insensitive, partial match supported)
  work add-task --stage "setup" --batch "core" --thread "config" --name "Add env vars"

  # Mix indices and names
  work add-task --stage 1 --batch "init" --thread 2 --name "Set up database"

  # Add task to specific workstream
  work add-task --stream "001-my-stream" --stage 1 --batch 1 --thread 2 --name "Implement login form"
`);
}
function parseCliArgs8(argv) {
  const args = argv.slice(2);
  const parsed = { stage: "", batch: "", thread: "", json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        parsed.stage = next;
        i++;
        break;
      case "--batch":
      case "-b":
        if (!next) {
          console.error("Error: --batch requires a value");
          return null;
        }
        parsed.batch = next;
        i++;
        break;
      case "--thread":
      case "-t":
        if (!next) {
          console.error("Error: --thread requires a value");
          return null;
        }
        parsed.thread = next;
        i++;
        break;
      case "--name":
      case "-n":
        if (!next) {
          console.error("Error: --name requires a value");
          return null;
        }
        parsed.name = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp8();
        process.exit(0);
    }
  }
  return parsed;
}
function getNextTaskNumber(tasks, stage, batch, thread) {
  const stageStr = stage.toString().padStart(2, "0");
  const batchStr = batch.toString().padStart(2, "0");
  const threadStr = thread.toString().padStart(2, "0");
  const prefix = `${stageStr}.${batchStr}.${threadStr}.`;
  const existingTasks = tasks.filter((t) => t.id.startsWith(prefix));
  if (existingTasks.length === 0) {
    return 1;
  }
  let maxTaskNum = 0;
  for (const task of existingTasks) {
    const parts = task.id.split(".");
    const taskNum = parseInt(parts[3] || "0", 10);
    if (taskNum > maxTaskNum) {
      maxTaskNum = taskNum;
    }
  }
  return maxTaskNum + 1;
}
async function main8(argv = process.argv) {
  const cliArgs = parseCliArgs8(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const planMdPath = getStreamPlanMdPath(repoRoot, stream.id);
  let content;
  try {
    content = readFileSync8(planMdPath, "utf-8");
  } catch (e) {
    console.error(`Error: Could not read PLAN.md: ${e.message}`);
    process.exit(1);
  }
  const errors = [];
  const doc = parseStreamDocument(content, errors);
  if (!doc || doc.stages.length === 0) {
    console.error("Error: No stages found in PLAN.md");
    process.exit(1);
  }
  const needsInteractive = cliArgs.stage === "" || cliArgs.batch === "" || cliArgs.thread === "" || !cliArgs.name;
  let stageId;
  let batchId;
  let threadId;
  if (needsInteractive) {
    const rl = createReadlineInterface();
    try {
      if (cliArgs.stage === "") {
        const result = await selectStage(rl, doc.stages);
        stageId = result.value.id;
      } else {
        const resolved = resolveByNameOrIndex(cliArgs.stage, doc.stages, "Stage");
        stageId = resolved.id;
      }
      const selectedStage2 = doc.stages.find((s) => s.id === stageId);
      if (!selectedStage2) {
        console.error(`Error: Stage ${stageId} not found`);
        rl.close();
        process.exit(1);
      }
      if (selectedStage2.batches.length === 0) {
        console.error(`Error: No batches found in Stage ${stageId}`);
        rl.close();
        process.exit(1);
      }
      if (cliArgs.batch === "") {
        const result = await selectBatch(rl, selectedStage2.batches);
        batchId = result.value.id;
      } else {
        const resolved = resolveByNameOrIndex(cliArgs.batch, selectedStage2.batches, "Batch");
        batchId = resolved.id;
      }
      const selectedBatch2 = selectedStage2.batches.find((b2) => b2.id === batchId);
      if (!selectedBatch2) {
        console.error(`Error: Batch ${batchId} not found in Stage ${stageId}`);
        rl.close();
        process.exit(1);
      }
      if (selectedBatch2.threads.length === 0) {
        console.error(`Error: No threads found in Batch ${batchId}`);
        rl.close();
        process.exit(1);
      }
      if (cliArgs.thread === "") {
        const result = await selectThread(rl, selectedBatch2.threads);
        threadId = result.value.id;
      } else {
        const resolved = resolveByNameOrIndex(cliArgs.thread, selectedBatch2.threads, "Thread");
        threadId = resolved.id;
      }
      if (!cliArgs.name) {
        cliArgs.name = await promptText(rl, `
Task name: `);
        if (!cliArgs.name.trim()) {
          console.error("Error: Task name cannot be empty");
          rl.close();
          process.exit(1);
        }
      }
      rl.close();
    } catch (e) {
      rl.close();
      console.error(e.message);
      process.exit(1);
    }
  } else {
    try {
      const resolvedStage = resolveByNameOrIndex(cliArgs.stage, doc.stages, "Stage");
      stageId = resolvedStage.id;
      const selectedStage2 = doc.stages.find((s) => s.id === stageId);
      const resolvedBatch = resolveByNameOrIndex(cliArgs.batch, selectedStage2.batches, "Batch");
      batchId = resolvedBatch.id;
      const selectedBatch2 = selectedStage2.batches.find((b2) => b2.id === batchId);
      const resolvedThread = resolveByNameOrIndex(cliArgs.thread, selectedBatch2.threads, "Thread");
      threadId = resolvedThread.id;
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
  if (!cliArgs.name) {
    console.error("Error: --name is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  const { revoked, stream: updatedStream } = checkAndRevokeIfModified(repoRoot, stream);
  if (revoked) {
    console.error("Error: Plan was modified since approval. Re-approval required.");
    console.error("");
    console.error("To re-approve the plan, run:");
    console.error(`  work approve --stream "${stream.id}"`);
    process.exit(1);
  }
  stream = updatedStream;
  const { allowed, reason } = canCreateTasks(stream);
  if (!allowed) {
    console.error(`Error: ${reason}`);
    console.error("");
    console.error("To approve the plan, run:");
    console.error(`  work approve --stream "${stream.id}"`);
    process.exit(1);
  }
  const selectedStage = doc.stages.find((s) => s.id === stageId);
  const selectedBatch = selectedStage.batches.find((b2) => b2.id === batchId);
  const selectedThread = selectedBatch.threads.find((t) => t.id === threadId);
  const existingTasks = getTasks(repoRoot, stream.id);
  const nextTaskNum = getNextTaskNumber(existingTasks, stageId, batchId, threadId);
  const taskId = formatTaskId(stageId, batchId, threadId, nextTaskNum);
  const now = new Date().toISOString();
  const newTask = {
    id: taskId,
    name: cliArgs.name,
    thread_name: selectedThread.name || `Thread ${threadId}`,
    batch_name: selectedBatch.name || `Batch ${batchId.toString().padStart(2, "0")}`,
    stage_name: selectedStage.name || `Stage ${stageId}`,
    created_at: now,
    updated_at: now,
    status: "pending"
  };
  addTasks(repoRoot, stream.id, [newTask]);
  if (cliArgs.json) {
    console.log(JSON.stringify(newTask, null, 2));
  } else {
    console.log(`Added task ${taskId}: ${cliArgs.name}`);
  }
}
if (false) {}

// src/cli/add-batch.ts
init_repo();
init_lib();
import { readFileSync as readFileSync10 } from "fs";

// src/lib/plan-edit.ts
init_lib();
import { readFileSync as readFileSync9 } from "fs";
init_stream_parser();
function generateBatchMarkdown(batchNum, name, summary) {
  const paddedNum = batchNum.toString().padStart(2, "0");
  const summaryText = summary || "<!-- What this batch accomplishes -->";
  return `##### Batch ${paddedNum}: ${name}

${summaryText}

###### Thread 01: <!-- Thread Name -->

**Summary:**
<!-- Short description of this parallelizable work unit -->

**Details:**
<!-- Any content - implementation notes, dependencies, goals, code examples, etc. -->`;
}
function generateThreadMarkdown(threadNum, name, summary) {
  const paddedNum = threadNum.toString().padStart(2, "0");
  const summaryText = summary || "<!-- Short description of this parallelizable work unit -->";
  return `###### Thread ${paddedNum}: ${name}

**Summary:**
${summaryText}

**Details:**
<!-- Any content - implementation notes, dependencies, goals, code examples, etc. -->`;
}
function findStageEnd(lines, stageNumber) {
  const stagePattern = new RegExp(`^###\\s+Stage\\s+0?${stageNumber}:`, "i");
  const nextStagePattern = /^###\s+Stage\s+\d+:/i;
  const hrPattern = /^---/;
  let inStage = false;
  let lastContentLine = -1;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (stagePattern.test(line)) {
      inStage = true;
      lastContentLine = i;
      continue;
    }
    if (inStage) {
      if (nextStagePattern.test(line) || hrPattern.test(line)) {
        return lastContentLine + 1;
      }
      if (line.trim().length > 0) {
        lastContentLine = i;
      }
    }
  }
  if (inStage) {
    return lastContentLine + 1;
  }
  return -1;
}
function findBatchEnd(lines, stageNumber, batchNumber) {
  const stagePattern = new RegExp(`^###\\s+Stage\\s+0?${stageNumber}:`, "i");
  const batchPattern = new RegExp(`^#####\\s+Batch\\s+0?${batchNumber}:`, "i");
  const nextBatchPattern = /^#####\s+Batch\s+\d+:/i;
  const nextStagePattern = /^###\s+Stage\s+\d+:/i;
  const h4Pattern = /^####\s+/;
  const hrPattern = /^---/;
  let inStage = false;
  let inBatch = false;
  let lastContentLine = -1;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (stagePattern.test(line)) {
      inStage = true;
      continue;
    }
    if (!inStage)
      continue;
    if (batchPattern.test(line)) {
      inBatch = true;
      lastContentLine = i;
      continue;
    }
    if (inBatch) {
      if (nextBatchPattern.test(line) || nextStagePattern.test(line) || hrPattern.test(line)) {
        return lastContentLine + 1;
      }
      if (line.trim().length > 0) {
        lastContentLine = i;
      }
    }
  }
  if (inBatch) {
    return lastContentLine + 1;
  }
  return -1;
}
function countBatchesInStage(content, stageNumber) {
  const errors = [];
  const doc = parseStreamDocument(content, errors);
  if (!doc)
    return 0;
  const stage = doc.stages.find((s) => s.id === stageNumber);
  if (!stage)
    return 0;
  return stage.batches.length;
}
function countThreadsInBatch(content, stageNumber, batchNumber) {
  const errors = [];
  const doc = parseStreamDocument(content, errors);
  if (!doc)
    return 0;
  const stage = doc.stages.find((s) => s.id === stageNumber);
  if (!stage)
    return 0;
  const batch = stage.batches.find((b2) => b2.id === batchNumber);
  if (!batch)
    return 0;
  return batch.threads.length;
}
function appendBatchToStage(repoRoot, streamId, options) {
  const planPath = getStreamPlanMdPath(repoRoot, streamId);
  const content = readFileSync9(planPath, "utf-8");
  const lines = content.split(`
`);
  const existingBatches = countBatchesInStage(content, options.stageNumber);
  const newBatchNumber = existingBatches + 1;
  const insertLine = findStageEnd(lines, options.stageNumber);
  if (insertLine === -1) {
    return {
      success: false,
      batchNumber: 0,
      message: `Stage ${options.stageNumber} not found in PLAN.md`
    };
  }
  const batchMarkdown = generateBatchMarkdown(newBatchNumber, options.name, options.summary);
  lines.splice(insertLine, 0, "", batchMarkdown, "");
  atomicWriteFile(planPath, lines.join(`
`));
  return {
    success: true,
    batchNumber: newBatchNumber,
    message: `Added Batch ${newBatchNumber.toString().padStart(2, "0")}: ${options.name}`
  };
}
function appendThreadToBatch(repoRoot, streamId, options) {
  const planPath = getStreamPlanMdPath(repoRoot, streamId);
  const content = readFileSync9(planPath, "utf-8");
  const lines = content.split(`
`);
  const existingThreads = countThreadsInBatch(content, options.stageNumber, options.batchNumber);
  const newThreadNumber = existingThreads + 1;
  const insertLine = findBatchEnd(lines, options.stageNumber, options.batchNumber);
  if (insertLine === -1) {
    return {
      success: false,
      threadNumber: 0,
      message: `Batch ${options.batchNumber} in Stage ${options.stageNumber} not found in PLAN.md`
    };
  }
  const threadMarkdown = generateThreadMarkdown(newThreadNumber, options.name, options.summary);
  lines.splice(insertLine, 0, "", threadMarkdown);
  atomicWriteFile(planPath, lines.join(`
`));
  return {
    success: true,
    threadNumber: newThreadNumber,
    message: `Added Thread ${newThreadNumber.toString().padStart(2, "0")}: ${options.name}`
  };
}

// src/cli/add-batch.ts
init_stream_parser();
function printHelp9() {
  console.log(`
work add-batch - Add a batch to a stage

Usage:
  work add-batch --stage <n> --name <name> [options]

Required:
  --stage          Stage number or name to add batch to (e.g., 1 or "setup")
  --name, -n       Batch name

Optional:
  --summary        Batch description
  --stream, -s     Workstream ID (uses current if not specified)
  --repo-root, -r  Repository root (auto-detected)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Adds a new batch to an existing stage in PLAN.md. The batch number is
  automatically assigned based on existing batches in the stage.

Examples:
  work add-batch --stage 1 --name "testing"
  work add-batch --stage 2 --name "integration" --summary "API integration tests"
`);
}
function parseCliArgs9(argv) {
  const args = argv.slice(2);
  const parsed = { stage: "", json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        parsed.stage = next;
        i++;
        break;
      case "--name":
      case "-n":
        if (!next) {
          console.error("Error: --name requires a value");
          return null;
        }
        parsed.name = next;
        i++;
        break;
      case "--summary":
        if (!next) {
          console.error("Error: --summary requires a value");
          return null;
        }
        parsed.summary = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp9();
        process.exit(0);
    }
  }
  return parsed;
}
function main9(argv = process.argv) {
  const cliArgs = parseCliArgs9(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (cliArgs.stage === "") {
    console.error("Error: --stage is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.name) {
    console.error("Error: --name is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const planMdPath = getStreamPlanMdPath(repoRoot, stream.id);
  let content;
  try {
    content = readFileSync10(planMdPath, "utf-8");
  } catch (e) {
    console.error(`Error: Could not read PLAN.md: ${e.message}`);
    process.exit(1);
  }
  const errors = [];
  const doc = parseStreamDocument(content, errors);
  if (!doc || doc.stages.length === 0) {
    console.error("Error: No stages found in PLAN.md");
    process.exit(1);
  }
  let stageId;
  try {
    const resolvedStage = resolveByNameOrIndex(cliArgs.stage, doc.stages, "Stage");
    stageId = resolvedStage.id;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const result = appendBatchToStage(repoRoot, stream.id, {
    stageNumber: stageId,
    name: cliArgs.name,
    summary: cliArgs.summary
  });
  if (!result.success) {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
  if (cliArgs.json) {
    console.log(JSON.stringify({
      success: true,
      stream: stream.id,
      stage: stageId,
      batch: result.batchNumber,
      name: cliArgs.name
    }, null, 2));
  } else {
    console.log(result.message);
  }
}
if (false) {}

// src/cli/add-thread.ts
init_repo();
init_lib();
import { readFileSync as readFileSync11 } from "fs";
init_stream_parser();
function printHelp10() {
  console.log(`
work add-thread - Add a thread to a batch

Usage:
  work add-thread --stage <n> --batch <n> --name <name> [options]

Required:
  --stage          Stage number or name (e.g., 1 or "setup")
  --batch, -b      Batch number or name (e.g., 1 or "core-setup")
  --name, -n       Thread name

Optional:
  --summary        Thread description
  --stream, -s     Workstream ID (uses current if not specified)
  --repo-root, -r  Repository root (auto-detected)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Adds a new thread to an existing batch in PLAN.md. The thread number is
  automatically assigned based on existing threads in the batch.

Examples:
  work add-thread --stage 1 --batch 1 --name "unit tests"
  work add-thread --stage 2 --batch 1 --name "API client" --summary "REST API integration"
`);
}
function parseCliArgs10(argv) {
  const args = argv.slice(2);
  const parsed = { stage: "", batch: "", json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        parsed.stage = next;
        i++;
        break;
      case "--batch":
      case "-b":
        if (!next) {
          console.error("Error: --batch requires a value");
          return null;
        }
        parsed.batch = next;
        i++;
        break;
      case "--name":
      case "-n":
        if (!next) {
          console.error("Error: --name requires a value");
          return null;
        }
        parsed.name = next;
        i++;
        break;
      case "--summary":
        if (!next) {
          console.error("Error: --summary requires a value");
          return null;
        }
        parsed.summary = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp10();
        process.exit(0);
    }
  }
  return parsed;
}
function main10(argv = process.argv) {
  const cliArgs = parseCliArgs10(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (cliArgs.stage === "") {
    console.error("Error: --stage is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (cliArgs.batch === "") {
    console.error("Error: --batch is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.name) {
    console.error("Error: --name is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const planMdPath = getStreamPlanMdPath(repoRoot, stream.id);
  let content;
  try {
    content = readFileSync11(planMdPath, "utf-8");
  } catch (e) {
    console.error(`Error: Could not read PLAN.md: ${e.message}`);
    process.exit(1);
  }
  const errors = [];
  const doc = parseStreamDocument(content, errors);
  if (!doc || doc.stages.length === 0) {
    console.error("Error: No stages found in PLAN.md");
    process.exit(1);
  }
  let stageId;
  let batchId;
  try {
    const resolvedStage = resolveByNameOrIndex(cliArgs.stage, doc.stages, "Stage");
    stageId = resolvedStage.id;
    const selectedStage = doc.stages.find((s) => s.id === stageId);
    const resolvedBatch = resolveByNameOrIndex(cliArgs.batch, selectedStage.batches, "Batch");
    batchId = resolvedBatch.id;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const result = appendThreadToBatch(repoRoot, stream.id, {
    stageNumber: stageId,
    batchNumber: batchId,
    name: cliArgs.name,
    summary: cliArgs.summary
  });
  if (!result.success) {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
  if (cliArgs.json) {
    console.log(JSON.stringify({
      success: true,
      stream: stream.id,
      stage: stageId,
      batch: batchId,
      thread: result.threadNumber,
      name: cliArgs.name
    }, null, 2));
  } else {
    console.log(result.message);
  }
}
if (false) {}

// src/cli/review.ts
init_repo();
init_lib();
import { existsSync as existsSync9, readFileSync as readFileSync12 } from "fs";
init_stream_parser();
init_tasks();

// src/lib/git/log.ts
import { execSync as execSync4 } from "node:child_process";
var COMMIT_DELIMITER = "---COMMIT_BOUNDARY---";
var FIELD_DELIMITER = "---FIELD---";
function parseGitLog(repoRoot, branchName, baseBranch) {
  const format = [
    "%H",
    "%h",
    "%an",
    "%ae",
    "%aI",
    "%s",
    "%b"
  ].join(FIELD_DELIMITER);
  let range = "";
  if (baseBranch && branchName) {
    range = `${baseBranch}..${branchName}`;
  } else if (branchName) {
    range = branchName;
  }
  try {
    const logOutput = execSync4(`git log ${range} --format="${format}${COMMIT_DELIMITER}" --numstat`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024
    }).trim();
    if (!logOutput) {
      return [];
    }
    const rawBlocks = logOutput.split(COMMIT_DELIMITER).filter((block) => block.trim());
    const commits = [];
    for (let i = 0;i < rawBlocks.length; i++) {
      const block = rawBlocks[i];
      const lines = block.split(`
`);
      let metadataStartIndex = 0;
      for (let j2 = 0;j2 < lines.length; j2++) {
        if (lines[j2].includes(FIELD_DELIMITER)) {
          metadataStartIndex = j2;
          break;
        }
      }
      const numstatLines = [];
      for (let j2 = 0;j2 < metadataStartIndex; j2++) {
        const line = lines[j2];
        if (line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)) {
          numstatLines.push(line);
        }
      }
      if (numstatLines.length > 0 && commits.length > 0) {
        const prevCommit = commits[commits.length - 1];
        parseNumstatLines(numstatLines, prevCommit);
      }
      const metadataLines = lines.slice(metadataStartIndex);
      const metadataBlock = metadataLines.join(`
`);
      if (metadataBlock.includes(FIELD_DELIMITER)) {
        const commit = parseCommitBlock(metadataBlock);
        commits.push(commit);
      }
    }
    return commits;
  } catch (error) {
    const errorMessage = error.message || String(error);
    if (errorMessage.includes("unknown revision") || errorMessage.includes("does not have any commits")) {
      return [];
    }
    throw new Error(`Failed to parse git log: ${errorMessage}`);
  }
}
function parseNumstatLines(numstatLines, commit) {
  for (const line of numstatLines) {
    const numstatMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (numstatMatch) {
      const [, addedStr, deletedStr, filename] = numstatMatch;
      const added = addedStr === "-" ? 0 : parseInt(addedStr, 10);
      const deleted = deletedStr === "-" ? 0 : parseInt(deletedStr, 10);
      commit.files.push(filename);
      if (filename.includes(" => ")) {
        commit.fileStats.renamed++;
      } else if (added > 0 && deleted === 0) {
        commit.fileStats.added++;
      } else if (added === 0 && deleted > 0) {
        commit.fileStats.deleted++;
      } else if (added > 0 || deleted > 0) {
        commit.fileStats.modified++;
      }
    }
  }
}
function parseCommitBlock(block) {
  const lines = block.trim().split(`
`);
  const metaLine = lines[0] || "";
  const parts = metaLine.split(FIELD_DELIMITER);
  const [sha, shortSha, author, authorEmail, date, subject, ...bodyParts] = parts;
  const bodyLines = [];
  if (bodyParts.length > 0) {
    bodyLines.push(bodyParts.join(FIELD_DELIMITER));
  }
  for (let i = 1;i < lines.length; i++) {
    const line = lines[i];
    if (line && line.match(/^(\d+|-)\t(\d+|-)\t/)) {
      break;
    }
    bodyLines.push(line || "");
  }
  const body = bodyLines.join(`
`).trim();
  const files = [];
  const fileStats = { added: 0, modified: 0, deleted: 0, renamed: 0 };
  const trailers = extractWorkstreamTrailers(body);
  return {
    sha: sha || "",
    shortSha: shortSha || "",
    author: author || "",
    authorEmail: authorEmail || "",
    date: date || "",
    subject: subject || "",
    body,
    files,
    fileStats,
    trailers
  };
}
function extractWorkstreamTrailers(commitMessage) {
  const trailers = {};
  if (!commitMessage) {
    return trailers;
  }
  const lines = commitMessage.split(`
`);
  for (const line of lines) {
    const trimmed = line.trim();
    const streamIdMatch = trimmed.match(/^Stream-Id:\s*(.+)$/i);
    if (streamIdMatch) {
      trailers.streamId = streamIdMatch[1].trim();
      continue;
    }
    const streamNameMatch = trimmed.match(/^Stream-Name:\s*(.+)$/i);
    if (streamNameMatch) {
      trailers.streamName = streamNameMatch[1].trim();
      continue;
    }
    const stageMatch = trimmed.match(/^Stage:\s*(\d+)$/i);
    if (stageMatch) {
      trailers.stage = parseInt(stageMatch[1], 10);
      continue;
    }
    const stageNameMatch = trimmed.match(/^Stage-Name:\s*(.+)$/i);
    if (stageNameMatch) {
      trailers.stageName = stageNameMatch[1].trim();
      continue;
    }
    const batchMatch = trimmed.match(/^Batch:\s*(\d+\.\d+)$/i);
    if (batchMatch) {
      trailers.batch = batchMatch[1].trim();
      continue;
    }
    const threadMatch = trimmed.match(/^Thread:\s*(\d+\.\d+\.\d+)$/i);
    if (threadMatch) {
      trailers.thread = threadMatch[1].trim();
      continue;
    }
    const taskMatch = trimmed.match(/^Task:\s*(\d+\.\d+\.\d+\.\d+)$/i);
    if (taskMatch) {
      trailers.task = taskMatch[1].trim();
      continue;
    }
  }
  return trailers;
}
function hasWorkstreamTrailers(trailers) {
  return !!(trailers.streamId || trailers.stage !== undefined || trailers.batch || trailers.thread || trailers.task);
}
function groupCommitsByStage(commits, streamId) {
  const workstreamCommits = commits.filter((commit) => commit.trailers.streamId === streamId);
  const stageMap = new Map;
  for (const commit of workstreamCommits) {
    const stageNum = commit.trailers.stage;
    if (stageNum !== undefined) {
      const existing = stageMap.get(stageNum) || { commits: [], stageName: undefined };
      existing.commits.push(commit);
      if (!existing.stageName && commit.trailers.stageName) {
        existing.stageName = commit.trailers.stageName;
      }
      stageMap.set(stageNum, existing);
    }
  }
  const result = [];
  for (const [stageNumber, stageData] of stageMap.entries()) {
    result.push({
      stageNumber,
      stageName: stageData.stageName,
      commits: stageData.commits
    });
  }
  result.sort((a, b2) => a.stageNumber - b2.stageNumber);
  return result;
}
function identifyHumanCommits(commits) {
  return commits.filter((commit) => !hasWorkstreamTrailers(commit.trailers));
}
function getWorkstreamCommits(commits, streamId) {
  return commits.filter((commit) => commit.trailers.streamId === streamId);
}
function getCurrentBranch2(repoRoot) {
  try {
    return execSync4("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
    throw new Error("Failed to get current branch name");
  }
}
function getDefaultBranch(repoRoot) {
  try {
    const remoteBranch = execSync4("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: "/bin/bash"
    }).trim();
    if (remoteBranch) {
      return remoteBranch;
    }
  } catch {}
  try {
    execSync4("git rev-parse --verify main", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return "main";
  } catch {}
  try {
    execSync4("git rev-parse --verify master", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return "master";
  } catch {}
  return "main";
}

// src/cli/review.ts
function printHelp11() {
  console.log(`
work review - Review workstream artifacts

Usage:
  work review plan [--summary] [--stream <stream-id>]
  work review tasks [--stream <stream-id>]
  work review commits [--stage <num>] [--files] [--stream <stream-id>]

Subcommands:
  plan     Output full PLAN.md content
  tasks    Output tasks from tasks.json (confirms state even if empty)
  commits  Show commits grouped by stage for a workstream

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --summary        For plan: show Stage/Batch structure only (no thread details)
  --stage <num>    For commits: show commits for a specific stage only
  --files          For commits: include detailed file changes
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # Review full PLAN.md
  work review plan

  # Review plan structure only (stages and batches)
  work review plan --summary

  # Review tasks
  work review tasks

  # Review commits for current workstream
  work review commits

  # Review commits for specific stage
  work review commits --stage 1

  # Review commits with file details
  work review commits --files

  # Review as JSON
  work review plan --json
`);
}
function parseCliArgs11(argv) {
  const args = argv.slice(2);
  const parsed = { summary: false, json: false, files: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "plan" && !parsed.subcommand) {
      parsed.subcommand = "plan";
      continue;
    }
    if (arg === "tasks" && !parsed.subcommand) {
      parsed.subcommand = "tasks";
      continue;
    }
    if (arg === "commits" && !parsed.subcommand) {
      parsed.subcommand = "commits";
      continue;
    }
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--summary":
        parsed.summary = true;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        const stageNum = parseInt(next, 10);
        if (isNaN(stageNum) || stageNum <= 0) {
          console.error("Error: --stage must be a positive number");
          return null;
        }
        parsed.stage = stageNum;
        i++;
        break;
      case "--files":
        parsed.files = true;
        break;
      case "--help":
      case "-h":
        printHelp11();
        process.exit(0);
    }
  }
  return parsed;
}
function formatCommitOutput(streamId, branchName, commitsByStage, humanCommits, options) {
  const lines = [];
  lines.push(`Workstream: ${streamId}`);
  lines.push(`Branch: ${branchName}`);
  lines.push("");
  const stagesToShow = options.stageFilter ? commitsByStage.filter((s) => s.stageNumber === options.stageFilter) : commitsByStage;
  if (stagesToShow.length === 0 && options.stageFilter) {
    lines.push(`No commits found for stage ${options.stageFilter}`);
    return lines.join(`
`);
  }
  for (const stage of stagesToShow) {
    lines.push(`## Stage ${String(stage.stageNumber).padStart(2, "0")}${stage.stageName ? `: ${stage.stageName}` : ""}`);
    lines.push("");
    const approvalCommits = stage.commits.filter((c) => c.subject.toLowerCase().includes("approved"));
    const implementationCommits = stage.commits.filter((c) => !c.subject.toLowerCase().includes("approved"));
    if (approvalCommits.length > 0) {
      lines.push("### Stage Approval Commit");
      for (const commit of approvalCommits) {
        lines.push(formatCommit(commit, options.files));
      }
      lines.push("");
    }
    if (implementationCommits.length > 0) {
      lines.push("### Implementation Commits");
      for (const commit of implementationCommits) {
        lines.push(formatCommit(commit, options.files));
      }
      lines.push("");
    }
  }
  const relevantHumanCommits = options.stageFilter ? [] : humanCommits;
  if (relevantHumanCommits.length > 0) {
    lines.push("## Human Commits (manual/external)");
    lines.push("");
    for (const commit of relevantHumanCommits) {
      lines.push(formatCommit(commit, options.files));
    }
    lines.push("");
  }
  return lines.join(`
`);
}
function groupFilesByDirectory(files) {
  const groups = new Map;
  for (const file of files) {
    const lastSlash = file.lastIndexOf("/");
    const dir = lastSlash >= 0 ? file.substring(0, lastSlash) : ".";
    const basename = lastSlash >= 0 ? file.substring(lastSlash + 1) : file;
    const existing = groups.get(dir) || [];
    existing.push(basename);
    groups.set(dir, existing);
  }
  return groups;
}
function formatCommit(commit, showFiles) {
  let dateStr = "unknown";
  if (commit.date) {
    try {
      const parsed = new Date(commit.date);
      if (!isNaN(parsed.getTime())) {
        const isoDate = parsed.toISOString().split("T")[0];
        dateStr = isoDate ?? "unknown";
      }
    } catch {
      dateStr = "unknown";
    }
  }
  const stats = commit.fileStats;
  const statsParts = [];
  if (stats.added > 0)
    statsParts.push(`+${stats.added}`);
  if (stats.modified > 0)
    statsParts.push(`~${stats.modified}`);
  if (stats.deleted > 0)
    statsParts.push(`-${stats.deleted}`);
  if (stats.renamed > 0)
    statsParts.push(`→${stats.renamed}`);
  const statsStr = statsParts.length > 0 ? ` (${statsParts.join(" ")})` : "";
  let line = `- ${commit.shortSha} [${dateStr}] ${commit.subject}${statsStr}`;
  if (showFiles && commit.files.length > 0) {
    const grouped = groupFilesByDirectory(commit.files);
    const sortedDirs = Array.from(grouped.keys()).sort();
    if (sortedDirs.length === 1 && commit.files.length <= 3) {
      line += `
  Files: ${commit.files.join(", ")}`;
    } else {
      line += `
  Files:`;
      for (const dir of sortedDirs) {
        const files = grouped.get(dir);
        if (dir === ".") {
          line += `
    ${files.join(", ")}`;
        } else {
          line += `
    ${dir}/: ${files.join(", ")}`;
        }
      }
    }
  }
  return line;
}
function formatCommitsJsonOutput(streamId, branchName, commitsByStage, humanCommits, options) {
  const stagesToShow = options.stageFilter ? commitsByStage.filter((s) => s.stageNumber === options.stageFilter) : commitsByStage;
  const output = {
    workstream: streamId,
    branch: branchName,
    stages: stagesToShow.map((stage) => ({
      stageNumber: stage.stageNumber,
      stageName: stage.stageName,
      commits: stage.commits.map((c) => ({
        sha: c.sha,
        shortSha: c.shortSha,
        author: c.author,
        authorEmail: c.authorEmail,
        date: c.date,
        subject: c.subject,
        files: c.files,
        trailers: c.trailers
      }))
    })),
    humanCommits: options.stageFilter ? [] : humanCommits.map((c) => ({
      sha: c.sha,
      shortSha: c.shortSha,
      author: c.author,
      authorEmail: c.authorEmail,
      date: c.date,
      subject: c.subject,
      files: c.files
    }))
  };
  return JSON.stringify(output, null, 2);
}
function formatSummary(preview) {
  const lines = [];
  if (!preview.streamName) {
    return "Could not parse PLAN.md - invalid format";
  }
  lines.push(`# ${preview.streamName}`);
  lines.push("");
  for (const stage of preview.stages) {
    lines.push(`## Stage ${stage.number}: ${stage.name}`);
    for (const batch of stage.batches) {
      lines.push(`   - Batch ${batch.prefix}: ${batch.name} (${batch.threadCount} threads)`);
    }
    lines.push("");
  }
  const { open, resolved } = preview.questionCounts;
  if (open > 0 || resolved > 0) {
    lines.push(`Open Questions: ${open} | Resolved: ${resolved}`);
  }
  return lines.join(`
`);
}
function main11(argv = process.argv) {
  const cliArgs = parseCliArgs11(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.subcommand) {
    console.error("Error: subcommand required (plan, tasks, or commits)");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (cliArgs.subcommand === "plan") {
    const planMdPath = getStreamPlanMdPath(repoRoot, stream.id);
    if (!existsSync9(planMdPath)) {
      console.error(`Error: PLAN.md not found at ${planMdPath}`);
      process.exit(1);
    }
    const content = readFileSync12(planMdPath, "utf-8");
    if (cliArgs.summary) {
      const preview = getStreamPreview(content);
      if (cliArgs.json) {
        console.log(JSON.stringify({
          streamName: preview.streamName,
          stageCount: preview.stageCount,
          stages: preview.stages.map((s) => ({
            number: s.number,
            name: s.name,
            batches: s.batches.map((b2) => ({
              prefix: b2.prefix,
              name: b2.name,
              threadCount: b2.threadCount
            }))
          })),
          questionCounts: preview.questionCounts
        }, null, 2));
      } else {
        console.log(formatSummary(preview));
      }
    } else {
      if (cliArgs.json) {
        console.log(JSON.stringify({ content }, null, 2));
      } else {
        console.log(content);
      }
    }
  } else if (cliArgs.subcommand === "tasks") {
    const tasks = getTasks(repoRoot, stream.id);
    if (cliArgs.json) {
      console.log(JSON.stringify({ tasks, count: tasks.length }, null, 2));
    } else {
      if (tasks.length === 0) {
        console.log("No tasks found.");
        console.log(`
Use 'work add-task' to add tasks to this workstream.`);
      } else {
        console.log(`Tasks (${tasks.length} total):
`);
        for (const task of tasks) {
          const statusIcon = {
            pending: "○",
            in_progress: "◐",
            completed: "●",
            blocked: "⊘",
            cancelled: "✗"
          }[task.status] || "○";
          console.log(`  ${statusIcon} ${task.id}: ${task.name}`);
        }
      }
    }
  } else if (cliArgs.subcommand === "commits") {
    let branchName;
    if (stream.github?.branch) {
      branchName = stream.github.branch;
    } else {
      branchName = `workstream/${stream.id}`;
    }
    try {
      const currentBranch = getCurrentBranch2(repoRoot);
      if (currentBranch !== branchName) {
        console.warn(`Warning: Currently on branch "${currentBranch}", but workstream branch is "${branchName}"`);
        console.warn("Commits will be shown for the workstream branch.");
        console.warn("");
      }
    } catch (e) {}
    let commits;
    try {
      const baseBranch = getDefaultBranch(repoRoot);
      commits = parseGitLog(repoRoot, branchName, baseBranch);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    if (commits.length === 0) {
      console.log(`No commits found for workstream "${stream.id}" on branch "${branchName}"`);
      return;
    }
    const workstreamCommits = getWorkstreamCommits(commits, stream.id);
    const commitsByStage = groupCommitsByStage(workstreamCommits, stream.id);
    const humanCommits = identifyHumanCommits(commits);
    if (cliArgs.json) {
      const output = formatCommitsJsonOutput(stream.id, branchName, commitsByStage, humanCommits, { stageFilter: cliArgs.stage });
      console.log(output);
    } else {
      const output = formatCommitOutput(stream.id, branchName, commitsByStage, humanCommits, { files: cliArgs.files, stageFilter: cliArgs.stage });
      console.log(output);
    }
  }
}
if (false) {}

// src/cli/validate.ts
init_repo();
init_lib();
import { existsSync as existsSync10 } from "fs";
function printHelp12() {
  console.log(`
work validate - Validate workstream plan structure

Usage:
  work validate plan [--stream <stream-id>]

Subcommands:
  plan     Validate PLAN.md structure and content

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Validates PLAN.md schema structure (stages, batches, threads).
  Note: Use 'work check plan' to check for open questions and missing input files.

Examples:
  # Validate current workstream plan
  work validate plan

  # Validate specific workstream
  work validate plan --stream "001-my-stream"

  # Output as JSON
  work validate plan --json
`);
}
function parseCliArgs12(argv) {
  const args = argv.slice(2);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "plan" && !parsed.subcommand) {
      parsed.subcommand = "plan";
      continue;
    }
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp12();
        process.exit(0);
    }
  }
  return parsed;
}
function formatValidationResult(result) {
  const lines = [];
  if (result.valid) {
    lines.push("✓ PLAN.md validation passed");
  } else {
    lines.push("✗ PLAN.md validation failed");
  }
  if (result.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  - ${error}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return lines.join(`
`);
}
function main12(argv = process.argv) {
  const cliArgs = parseCliArgs12(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.subcommand) {
    console.error("Error: subcommand required (e.g., 'plan')");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (cliArgs.subcommand === "plan") {
    const planMdPath = getStreamPlanMdPath(repoRoot, stream.id);
    if (!existsSync10(planMdPath)) {
      console.error(`Error: PLAN.md not found at ${planMdPath}`);
      process.exit(1);
    }
    const consolidateResult = consolidateStream(repoRoot, stream.id, true);
    const result = {
      valid: consolidateResult.success,
      errors: consolidateResult.errors.map((e) => `[${e.section || "?"}] ${e.message}`),
      warnings: consolidateResult.warnings
    };
    if (cliArgs.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatValidationResult(result));
    }
    if (!result.valid) {
      process.exit(1);
    }
  }
}
if (false) {}

// src/cli/check.ts
init_repo();
init_lib();
import { existsSync as existsSync12, readFileSync as readFileSync14 } from "fs";

// src/lib/analysis.ts
import { existsSync as existsSync11 } from "fs";
import { join as join12, dirname as dirname3 } from "path";
function findOpenQuestions(content) {
  const lines = content.split(`
`);
  const questions = [];
  let currentStage;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const stageMatch = line.match(/^###\s+Stage\s+(\d+):/i);
    if (stageMatch) {
      currentStage = parseInt(stageMatch[1], 10);
    }
    const checkboxMatch = line.match(/\[\s\]\s*(.*)$/);
    if (checkboxMatch) {
      questions.push({
        line: i + 1,
        question: checkboxMatch[1].trim(),
        stage: currentStage
      });
    }
  }
  return questions;
}
function extractInputFileReferences(content) {
  const files = [];
  const lines = content.split(`
`);
  let inInputsSection = false;
  for (const line of lines) {
    if (/\*\*Inputs:\*\*/i.test(line) || /^Inputs:/i.test(line.trim())) {
      inInputsSection = true;
      continue;
    }
    if (inInputsSection && (/^\*\*[^*]+\*\*/.test(line.trim()) || /^#{4,5}\s/.test(line))) {
      inInputsSection = false;
    }
    if (inInputsSection && line.trim().startsWith("-")) {
      const filePatterns = [
        /`([^`]+\.[a-z]+)`/gi,
        /\[([^\]]+)\]\(file:\/\/([^)]+)\)/gi,
        /(?:^|\s)([\w./-]+\.[a-z]{1,4})(?:\s|$)/gi
      ];
      for (const pattern of filePatterns) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const file = match[2] || match[1];
          if (file && !file.includes("*")) {
            files.push(file);
          }
        }
      }
    }
  }
  return [...new Set(files)];
}
function findMissingInputFiles(repoRoot, planMdPath, files) {
  const planDir = dirname3(planMdPath);
  const missing = [];
  for (const file of files) {
    const candidates = [
      join12(planDir, file),
      join12(repoRoot, file),
      file
    ];
    const exists = candidates.some((p) => existsSync11(p));
    if (!exists) {
      missing.push(file);
    }
  }
  return missing;
}

// src/cli/check.ts
function printHelp13() {
  console.log(`
work check - comprehensive check of workstream files

Usage:
  work check plan [--stream <stream-id>]

Subcommands:
  plan     Check PLAN.md for schema errors, open questions, and missing inputs

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Comprehensive check for PLAN.md including:
  - Schema structure
  - Open questions [ ] (reports with line numbers)
  - Referenced input files (checks if they exist)

Examples:
  # Check current workstream plan
  work check plan

  # Check specific workstream
  work check plan --stream "001-my-stream"

  # Output as JSON
  work check plan --json
`);
}
function parseCliArgs13(argv) {
  const args = argv.slice(2);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "plan" && !parsed.subcommand) {
      parsed.subcommand = "plan";
      continue;
    }
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp13();
        process.exit(0);
    }
  }
  return parsed;
}
function formatCheckResult(result) {
  const lines = [];
  const issuesCount = result.schemaErrors.length + result.openQuestions.length + result.missingInputFiles.length;
  if (issuesCount === 0) {
    lines.push("✓ PLAN.md checks passed. No issues found.");
  } else {
    lines.push(`⚠ Found ${issuesCount} issue${issuesCount !== 1 ? "s" : ""} in PLAN.md`);
  }
  if (result.schemaErrors.length > 0) {
    lines.push("");
    lines.push("Schema Errors:");
    for (const error of result.schemaErrors) {
      lines.push(`  - ${error}`);
    }
  }
  if (result.openQuestions.length > 0) {
    lines.push("");
    lines.push(`Open Questions (${result.openQuestions.length}):`);
    for (const q2 of result.openQuestions) {
      const stageInfo = q2.stage ? ` (Stage ${q2.stage})` : "";
      lines.push(`  Line ${q2.line}${stageInfo}: [ ] ${q2.question}`);
    }
  }
  if (result.missingInputFiles.length > 0) {
    lines.push("");
    lines.push(`Missing Input Files (${result.missingInputFiles.length}):`);
    for (const file of result.missingInputFiles) {
      lines.push(`  - ${file}`);
    }
  }
  return lines.join(`
`);
}
function main13(argv = process.argv) {
  const cliArgs = parseCliArgs13(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.subcommand) {
    console.error("Error: subcommand required (e.g., 'plan')");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (cliArgs.subcommand === "plan") {
    const planMdPath = getStreamPlanMdPath(repoRoot, stream.id);
    if (!existsSync12(planMdPath)) {
      console.error(`Error: PLAN.md not found at ${planMdPath}`);
      process.exit(1);
    }
    const content = readFileSync14(planMdPath, "utf-8");
    const consolidateResult = consolidateStream(repoRoot, stream.id, true);
    const schemaErrors = consolidateResult.errors.map((e) => `[${e.section || "?"}] ${e.message}`);
    const openQuestions = findOpenQuestions(content);
    const inputFiles = extractInputFileReferences(content);
    const missingInputFiles = findMissingInputFiles(repoRoot, planMdPath, inputFiles);
    const result = {
      schemaValid: consolidateResult.success,
      schemaErrors,
      openQuestions,
      missingInputFiles
    };
    if (cliArgs.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatCheckResult(result));
    }
  }
}
if (false) {}

// src/cli/preview.ts
init_repo();
init_lib();
init_stream_parser();
import { existsSync as existsSync13, readFileSync as readFileSync15 } from "fs";
init_tasks();
function printHelp14() {
  console.log(`
work preview - Show PLAN.md structure

Usage:
  work preview [--stream <stream-id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --verbose, -v    Show more details
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Preview shows the structure of PLAN.md including:
  - Workstream name and summary
  - Stages with their threads
  - Question counts (open vs resolved)

Examples:
  # Preview workstream structure (uses current)
  work preview

  # Verbose output
  work preview --verbose

  # Preview specific workstream
  work preview --stream "001-my-stream"
`);
}
function parseCliArgs14(argv) {
  const args = argv.slice(2);
  const parsed = { verbose: false, json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--verbose":
      case "-v":
        parsed.verbose = true;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp14();
        process.exit(0);
    }
  }
  return parsed;
}
function computeTaskProgress(tasks, stageNum, batchNum, threadNum) {
  const filtered = tasks.filter((t) => {
    const parsed = parseTaskId(t.id);
    if (stageNum !== undefined && parsed.stage !== stageNum)
      return false;
    if (batchNum !== undefined && parsed.batch !== batchNum)
      return false;
    if (threadNum !== undefined && parsed.thread !== threadNum)
      return false;
    return true;
  });
  return {
    total: filtered.length,
    completed: filtered.filter((t) => t.status === "completed").length,
    inProgress: filtered.filter((t) => t.status === "in_progress").length,
    blocked: filtered.filter((t) => t.status === "blocked").length
  };
}
function progressBar(completed, total, width = 10) {
  if (total === 0)
    return "░".repeat(width);
  const filled = Math.round(completed / total * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
function progressPercent(completed, total) {
  if (total === 0)
    return "0%";
  return `${Math.round(completed / total * 100)}%`;
}
function formatPreview(preview, verbose, tasks) {
  const lines = [];
  if (!preview.streamName) {
    return "Could not parse PLAN.md - invalid format";
  }
  lines.push(`Workstream: ${preview.streamName}`);
  if (preview.summary) {
    lines.push(`Summary: ${preview.summary}`);
  }
  const overallProgress = computeTaskProgress(tasks);
  if (overallProgress.total > 0) {
    lines.push("");
    lines.push(`Overall Progress: [${progressBar(overallProgress.completed, overallProgress.total)}] ` + `${progressPercent(overallProgress.completed, overallProgress.total)} ` + `(${overallProgress.completed}/${overallProgress.total} tasks)`);
  }
  lines.push("");
  lines.push("Stages:");
  for (let stageIdx = 0;stageIdx < preview.stages.length; stageIdx++) {
    const stage = preview.stages[stageIdx];
    const stageProgress = computeTaskProgress(tasks, stage.number);
    const batchInfo = stage.batchCount > 1 ? `, ${stage.batchCount} batches` : "";
    let stageLine = `  ${stage.number}. ${stage.name} (${stage.threadCount} thread${stage.threadCount !== 1 ? "s" : ""}${batchInfo})`;
    if (stageProgress.total > 0) {
      const pct = progressPercent(stageProgress.completed, stageProgress.total);
      const bar = progressBar(stageProgress.completed, stageProgress.total, 8);
      stageLine += ` [${bar}] ${pct}`;
      if (stageProgress.completed === stageProgress.total) {
        stageLine += " ✓";
      } else if (stageProgress.blocked > 0) {
        stageLine += " ⚠";
      }
    }
    if (stageIdx > 0) {
      const prevStage = preview.stages[stageIdx - 1];
      const prevProgress = computeTaskProgress(tasks, prevStage.number);
      if (prevProgress.total > 0 && prevProgress.completed < prevProgress.total) {
        stageLine += " (blocked by Stage " + prevStage.number + ")";
      }
    }
    lines.push(stageLine);
    for (const batch of stage.batches) {
      const batchProgress = computeTaskProgress(tasks, stage.number, batch.number);
      if (stage.batchCount > 1 || verbose) {
        let batchLine = `     Batch ${batch.prefix}: ${batch.name}`;
        if (batchProgress.total > 0) {
          batchLine += ` [${batchProgress.completed}/${batchProgress.total}]`;
          if (batchProgress.completed === batchProgress.total) {
            batchLine += " ✓";
          }
        }
        lines.push(batchLine);
      }
      if (verbose || batch.threads.length <= 5) {
        for (const thread of batch.threads) {
          const indent = stage.batchCount > 1 || verbose ? "        " : "     ";
          const threadProgress = computeTaskProgress(tasks, stage.number, batch.number, thread.number);
          let threadLine = `${indent}- Thread ${thread.number}: ${thread.name}`;
          if (threadProgress.total > 0) {
            threadLine += ` [${threadProgress.completed}/${threadProgress.total}]`;
            if (threadProgress.completed === threadProgress.total) {
              threadLine += " ✓";
            }
          }
          lines.push(threadLine);
        }
      } else {
        for (const thread of batch.threads.slice(0, 3)) {
          const indent2 = stage.batchCount > 1 || verbose ? "        " : "     ";
          const threadProgress = computeTaskProgress(tasks, stage.number, batch.number, thread.number);
          let threadLine = `${indent2}- Thread ${thread.number}: ${thread.name}`;
          if (threadProgress.total > 0) {
            threadLine += ` [${threadProgress.completed}/${threadProgress.total}]`;
            if (threadProgress.completed === threadProgress.total) {
              threadLine += " ✓";
            }
          }
          lines.push(threadLine);
        }
        const indent = stage.batchCount > 1 || verbose ? "        " : "     ";
        lines.push(`${indent}... and ${batch.threads.length - 3} more threads`);
      }
    }
    if (stageIdx < preview.stages.length - 1) {
      lines.push("  ↓");
    }
  }
  lines.push("");
  const { open, resolved } = preview.questionCounts;
  const total = open + resolved;
  if (total > 0) {
    lines.push(`Questions: ${open} open, ${resolved} resolved`);
  } else {
    lines.push("Questions: none");
  }
  return lines.join(`
`);
}
function main14(argv = process.argv) {
  const cliArgs = parseCliArgs14(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const planMdPath = getStreamPlanMdPath(repoRoot, stream.id);
  if (!existsSync13(planMdPath)) {
    console.error(`Error: PLAN.md not found at ${planMdPath}`);
    process.exit(1);
  }
  const content = readFileSync15(planMdPath, "utf-8");
  const preview = getStreamPreview(content);
  const tasks = getTasks(repoRoot, stream.id);
  if (cliArgs.json) {
    const progressData = {
      ...preview,
      taskProgress: {
        total: tasks.length,
        completed: tasks.filter((t) => t.status === "completed").length,
        inProgress: tasks.filter((t) => t.status === "in_progress").length,
        blocked: tasks.filter((t) => t.status === "blocked").length,
        pending: tasks.filter((t) => t.status === "pending").length
      }
    };
    console.log(JSON.stringify(progressData, null, 2));
  } else {
    console.log(formatPreview(preview, cliArgs.verbose, tasks));
  }
}
if (false) {}

// src/cli/delete.ts
init_repo();
init_lib();
init_tasks();
function printHelp15() {
  console.log(`
work delete - Delete workstreams, stages, threads, or tasks

Usage:
  work delete [--stream <id>] [target] [options]

Targets (mutually exclusive):
  --task, -t <id>     Delete a single task (e.g., "01.01.02.03")
  --stage <num>       Delete all tasks in a stage (e.g., 01)
  --batch <id>        Delete all tasks in a batch (e.g., "01.00")
  --thread <id>       Delete all tasks in a thread (e.g., "01.01.02")
  (no target)         Delete the entire workstream

Options:
  --stream, -s <id>   Workstream ID or name (uses current if not specified)
  --force, -f         Skip confirmation prompts
  --repo-root <path>  Repository root (auto-detected)
  --help, -h          Show this help message

Examples:
  # Delete a single task (uses current workstream)
  work delete --task "01.01.02.03"

  # Delete all tasks in stage 02
  work delete --stage 02

  # Delete all tasks in batch 01.00
  work delete --batch "01.00"

  # Delete all tasks in thread 01.01.02
  work delete --thread "01.01.02"

  # Delete specific workstream (with confirmation)
  work delete --stream "001-my-stream"

  # Delete workstream without confirmation
  work delete --stream "001-my-stream" --force
`);
}
function parseCliArgs15(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--task":
      case "-t":
        if (!next) {
          console.error("Error: --task requires a value");
          return null;
        }
        parsed.task = next;
        i++;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        const stageNum = parseInt(next, 10);
        if (isNaN(stageNum) || stageNum < 1) {
          console.error("Error: --stage must be a positive number");
          return null;
        }
        parsed.stage = stageNum;
        i++;
        break;
      case "--batch":
      case "-b":
        if (!next) {
          console.error("Error: --batch requires a value");
          return null;
        }
        const batchParts = next.split(".");
        if (batchParts.length !== 2 || batchParts.some((p) => isNaN(parseInt(p, 10)))) {
          console.error('Error: --batch must be in format "stage.batch" (e.g., "1.00")');
          return null;
        }
        parsed.batch = next;
        i++;
        break;
      case "--thread":
        if (!next) {
          console.error("Error: --thread requires a value");
          return null;
        }
        const threadParts = next.split(".");
        if (threadParts.length !== 3 || threadParts.some((p) => isNaN(parseInt(p, 10)))) {
          console.error('Error: --thread must be in format "stage.batch.thread" (e.g., "01.01.02")');
          return null;
        }
        parsed.thread = next;
        i++;
        break;
      case "--force":
      case "-f":
        parsed.force = true;
        break;
      case "--help":
      case "-h":
        printHelp15();
        process.exit(0);
    }
  }
  const targets = [
    parsed.task,
    parsed.stage,
    parsed.batch,
    parsed.thread
  ].filter((t) => t !== undefined);
  if (targets.length > 1) {
    console.error("Error: --task, --stage, --batch, and --thread are mutually exclusive");
    return null;
  }
  if (targets.length === 0) {
    parsed.stream = true;
  }
  return parsed;
}
async function main15(argv = process.argv) {
  const cliArgs = parseCliArgs15(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  try {
    if (cliArgs.task) {
      try {
        parseTaskId(cliArgs.task);
      } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      const deleted = deleteTask(repoRoot, stream.id, cliArgs.task);
      if (deleted) {
        console.log(`Deleted task ${cliArgs.task}: ${deleted.name}`);
      } else {
        console.error(`Task "${cliArgs.task}" not found in workstream "${stream.id}"`);
        process.exit(1);
      }
      return;
    }
    if (cliArgs.stage !== undefined) {
      const deleted = deleteTasksByStage(repoRoot, stream.id, cliArgs.stage);
      if (deleted.length > 0) {
        console.log(`Deleted ${deleted.length} task(s) from stage ${cliArgs.stage}`);
        for (const task of deleted) {
          console.log(`  - ${task.id}: ${task.name}`);
        }
      } else {
        console.log(`No tasks found in stage ${cliArgs.stage}`);
      }
      return;
    }
    if (cliArgs.batch) {
      const [stage, batch] = cliArgs.batch.split(".").map(Number);
      const deleted = deleteTasksByBatch(repoRoot, stream.id, stage, batch);
      if (deleted.length > 0) {
        console.log(`Deleted ${deleted.length} task(s) from batch ${cliArgs.batch}`);
        for (const task of deleted) {
          console.log(`  - ${task.id}: ${task.name}`);
        }
      } else {
        console.log(`No tasks found in batch ${cliArgs.batch}`);
      }
      return;
    }
    if (cliArgs.thread) {
      const [stage, batch, thread] = cliArgs.thread.split(".").map(Number);
      const deleted = deleteTasksByThread(repoRoot, stream.id, stage, batch, thread);
      if (deleted.length > 0) {
        console.log(`Deleted ${deleted.length} task(s) from thread ${cliArgs.thread}`);
        for (const task of deleted) {
          console.log(`  - ${task.id}: ${task.name}`);
        }
      } else {
        console.log(`No tasks found in thread ${cliArgs.thread}`);
      }
      return;
    }
    if (cliArgs.stream) {
      if (!cliArgs.force) {
        console.log(`This will delete workstream "${stream.id}" and all its files.`);
        console.log("Run with --force to confirm.");
        process.exit(1);
      }
      const result = await deleteStream(repoRoot, stream.id, {
        deleteFiles: true
      });
      console.log(`Deleted workstream: ${result.streamId}`);
      console.log(`   Path: ${result.streamPath}`);
      return;
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/files.ts
init_repo();
init_lib();
import { existsSync as existsSync15 } from "fs";
import { join as join14 } from "path";

// src/lib/files.ts
import { existsSync as existsSync14, readdirSync, statSync } from "fs";
import { join as join13, relative } from "path";
function getFilesRecursively(dir, baseDir, files = []) {
  if (!existsSync14(dir)) {
    return files;
  }
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith("."))
      continue;
    const fullPath = join13(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      getFilesRecursively(fullPath, baseDir, files);
    } else {
      files.push({
        name: entry,
        path: relative(baseDir, fullPath),
        size: stat.size
      });
    }
  }
  return files;
}

// src/cli/files.ts
function printHelp16() {
  console.log(`
work files - List and index files in a workstream's files/ directory

Usage:
  work files [--stream <id>] [options]

Options:
  --stream, -s <id>   Workstream ID or name (uses current if not specified)
  --save              Save file list to workstream metadata in index.json
  --repo-root <path>  Repository root (auto-detected)
  --help, -h          Show this help message

Output:
  Lists all files in the workstream's files/ directory with their sizes.
  Use --save to update the workstream's 'files' field in index.json.

File Naming Convention:
  Use descriptive names that explain the file's purpose:
  - architecture-diagram.png
  - api-endpoints-poc.ts
  - performance-benchmarks.md
  - database-schema-notes.md

Examples:
  work files                  # List files (uses current workstream)
  work files --save           # Save file list to index.json
  work files --stream "001-my-feature" --save
`);
}
function parseCliArgs16(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--save":
        parsed.save = true;
        break;
      case "--help":
      case "-h":
        printHelp16();
        process.exit(0);
    }
  }
  return parsed;
}
function formatSize(bytes) {
  if (bytes < 1024)
    return `${bytes}B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function main16(argv = process.argv) {
  const cliArgs = parseCliArgs16(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const filesDir = join14(getWorkDir(repoRoot), stream.id, "files");
  if (!existsSync15(filesDir)) {
    console.log(`No files/ directory found for workstream "${stream.id}"`);
    process.exit(0);
  }
  const files = getFilesRecursively(filesDir, filesDir);
  if (files.length === 0) {
    console.log(`Workstream: ${stream.id}`);
    console.log(`Files: 0`);
    console.log(`
No files in files/ directory.`);
  } else {
    console.log(`Workstream: ${stream.id}`);
    console.log(`Files: ${files.length}`);
    console.log("");
    files.sort((a, b2) => a.path.localeCompare(b2.path));
    for (const file of files) {
      console.log(`  ${file.path} (${formatSize(file.size)})`);
    }
  }
  if (cliArgs.save) {
    const fileNames = files.map((f) => f.path).sort();
    stream.files = fileNames;
    stream.updated_at = new Date().toISOString();
    saveIndex(repoRoot, index);
    console.log(`
Saved ${fileNames.length} file(s) to workstream metadata in index.json`);
  }
}
if (false) {}

// src/cli/current.ts
init_repo();
init_lib();
function printHelp17() {
  console.log(`
work current - Get or set the current workstream

Usage:
  work current [options]

Options:
  --set, -s <id>      Set the current workstream by ID or name
  --clear, -c         Clear the current workstream
  --repo-root <path>  Repository root (auto-detected)
  --help, -h          Show this help message

When no options are provided, shows the current workstream.

Once a current workstream is set, all commands default to it:
  work status              # Uses current workstream
  work list --tasks        # Uses current workstream
  work update --task 1.1.1 --status completed

You can still override with --stream:
  work status --stream "other-stream"

Examples:
  work current                           # Show current workstream
  work current --set "001-my-feature"    # Set current workstream
  work current --clear                   # Clear current workstream
`);
}
function parseCliArgs17(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--set":
      case "-s":
        if (!next) {
          console.error("Error: --set requires a workstream ID or name");
          return null;
        }
        parsed.set = next;
        i++;
        break;
      case "--clear":
      case "-c":
        parsed.clear = true;
        break;
      case "--help":
      case "-h":
        printHelp17();
        process.exit(0);
    }
  }
  return parsed;
}
function main17(argv = process.argv) {
  const cliArgs = parseCliArgs17(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  try {
    if (cliArgs.clear) {
      clearCurrentStream(repoRoot);
      console.log("Cleared current workstream");
      return;
    }
    if (cliArgs.set) {
      const stream2 = setCurrentStream(repoRoot, cliArgs.set);
      console.log(`Current workstream set to: ${stream2.id}`);
      return;
    }
    const index = loadIndex(repoRoot);
    const currentId = getCurrentStreamId(index);
    if (!currentId) {
      console.log("No current workstream set");
      console.log(`
Use 'work current --set <id>' to set one.`);
      return;
    }
    const stream = getStream(index, currentId);
    console.log(`Current workstream: ${stream.id}`);
    console.log(`   Name: ${stream.name}`);
    console.log(`   Path: ${stream.path}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/set-status.ts
init_repo();
init_lib();
var VALID_STATUSES2 = ["pending", "in_progress", "completed", "on_hold"];
function printHelp18() {
  console.log(`
work set-status - Set workstream status manually

Usage:
  work set-status <status> [--stream <id>]
  work set-status --clear [--stream <id>]

Arguments:
  <status>         Status to set: pending, in_progress, completed, on_hold

Options:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --clear, -c      Clear manual status (let it be computed from tasks)
  --repo-root      Repository root (auto-detected)
  --help, -h       Show this help message

Workstream Statuses:
  pending       No tasks started (default)
  in_progress   Has tasks in progress or completed
  completed     All tasks completed
  on_hold       Manually paused, won't work on for now

Notes:
  - Most statuses are computed automatically from task states
  - Use 'on_hold' to mark a workstream as paused without deleting it
  - Use --clear to reset to computed status

Examples:
  # Put current workstream on hold
  work set-status on_hold

  # Mark specific workstream as on hold
  work set-status on_hold --stream "001-my-feature"

  # Clear manual status (use computed)
  work set-status --clear
`);
}
function parseCliArgs18(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--clear":
      case "-c":
        parsed.clear = true;
        break;
      case "--help":
      case "-h":
        printHelp18();
        process.exit(0);
      default:
        if (!arg.startsWith("-") && !parsed.status) {
          parsed.status = arg;
        }
    }
  }
  if (!parsed.clear && !parsed.status) {
    console.error("Error: Status is required. Use one of: " + VALID_STATUSES2.join(", "));
    return null;
  }
  if (parsed.status && !VALID_STATUSES2.includes(parsed.status)) {
    console.error(`Error: Invalid status "${parsed.status}". Use one of: ${VALID_STATUSES2.join(", ")}`);
    return null;
  }
  return parsed;
}
function main18(argv = process.argv) {
  const cliArgs = parseCliArgs18(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const previousStatus = getStreamStatus(repoRoot, stream);
  try {
    if (cliArgs.clear) {
      setStreamStatus(repoRoot, stream.id, undefined);
      const updatedIndex = loadIndex(repoRoot);
      const updatedStream = getResolvedStream(updatedIndex, stream.id);
      const newStatus = getStreamStatus(repoRoot, updatedStream);
      console.log(`Cleared manual status for "${stream.id}"`);
      console.log(`  Status: ${formatStreamStatusIcon(previousStatus)} → ${formatStreamStatusIcon(newStatus)} (computed)`);
    } else {
      const newStatus = cliArgs.status;
      setStreamStatus(repoRoot, stream.id, newStatus);
      console.log(`Updated status for "${stream.id}"`);
      console.log(`  Status: ${formatStreamStatusIcon(previousStatus)} → ${formatStreamStatusIcon(newStatus)}`);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/report.ts
init_repo();
init_lib();
import { writeFileSync as writeFileSync4, existsSync as existsSync16 } from "fs";
import { join as join16 } from "path";

// src/lib/document.ts
init_tasks();
init_lib();
function generateReport(repoRoot, streamId) {
  const index = loadIndex(repoRoot);
  const stream = findStream(index, streamId);
  if (!stream) {
    throw new Error(`Workstream "${streamId}" not found`);
  }
  const tasks = getTasks(repoRoot, stream.id);
  const metrics = evaluateStream(repoRoot, stream.id);
  const status = getStreamStatus(repoRoot, stream);
  const tasksByStage = new Map;
  for (const task of tasks) {
    const { stage } = parseTaskId(task.id);
    if (!tasksByStage.has(stage)) {
      tasksByStage.set(stage, []);
    }
    tasksByStage.get(stage).push(task);
  }
  const stageReports = [];
  const stageNumbers = Array.from(tasksByStage.keys()).sort((a, b2) => a - b2);
  for (const stageNum of stageNumbers) {
    const stageTasks = tasksByStage.get(stageNum);
    const firstTask = stageTasks[0];
    const batches = new Set(stageTasks.map((t) => parseTaskId(t.id).batch));
    const threads = new Set(stageTasks.map((t) => {
      const { batch, thread } = parseTaskId(t.id);
      return `${batch}.${thread}`;
    }));
    stageReports.push({
      stageNumber: stageNum,
      stageName: firstTask?.stage_name ?? `Stage ${stageNum}`,
      batchCount: batches.size,
      threadCount: threads.size,
      taskCount: stageTasks.length,
      completedCount: stageTasks.filter((t) => t.status === "completed").length,
      blockedCount: stageTasks.filter((t) => t.status === "blocked").length,
      inProgressCount: stageTasks.filter((t) => t.status === "in_progress").length
    });
  }
  return {
    streamId: stream.id,
    streamName: stream.name,
    generatedAt: new Date().toISOString(),
    status,
    metrics,
    stageReports
  };
}
function formatReportMarkdown(report) {
  const lines = [];
  lines.push(`# Progress Report: ${report.streamName}`);
  lines.push(``);
  lines.push(`**Generated:** ${new Date(report.generatedAt).toLocaleString()}`);
  lines.push(`**Status:** ${report.status}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Tasks | ${report.metrics.totalTasks} |`);
  lines.push(`| Completed | ${report.metrics.statusCounts.completed} (${report.metrics.completionRate.toFixed(1)}%) |`);
  lines.push(`| In Progress | ${report.metrics.statusCounts.in_progress} |`);
  lines.push(`| Pending | ${report.metrics.statusCounts.pending} |`);
  lines.push(`| Blocked | ${report.metrics.statusCounts.blocked} (${report.metrics.blockedRate.toFixed(1)}%) |`);
  lines.push(`| Cancelled | ${report.metrics.statusCounts.cancelled} |`);
  lines.push(``);
  if (report.stageReports.length > 0) {
    lines.push(`## Stages`);
    lines.push(``);
    for (const stage of report.stageReports) {
      const completionPct = stage.taskCount > 0 ? (stage.completedCount / stage.taskCount * 100).toFixed(0) : 0;
      lines.push(`### Stage ${stage.stageNumber}: ${stage.stageName}`);
      lines.push(``);
      lines.push(`- **Batches:** ${stage.batchCount}`);
      lines.push(`- **Threads:** ${stage.threadCount}`);
      lines.push(`- **Tasks:** ${stage.completedCount}/${stage.taskCount} (${completionPct}%)`);
      if (stage.inProgressCount > 0) {
        lines.push(`- **In Progress:** ${stage.inProgressCount}`);
      }
      if (stage.blockedCount > 0) {
        lines.push(`- **Blocked:** ${stage.blockedCount}`);
      }
      lines.push(``);
    }
  }
  return lines.join(`
`);
}
function generateChangelog(repoRoot, streamId, since) {
  const tasks = getTasks(repoRoot, streamId, "completed");
  let filteredTasks = tasks;
  if (since) {
    filteredTasks = tasks.filter((t) => new Date(t.updated_at) >= since);
  }
  filteredTasks.sort((a, b2) => new Date(b2.updated_at).getTime() - new Date(a.updated_at).getTime());
  return filteredTasks.map((task) => ({
    taskId: task.id,
    taskName: task.name,
    stageName: task.stage_name,
    threadName: task.thread_name,
    completedAt: task.updated_at
  }));
}
function formatChangelogMarkdown(entries) {
  if (entries.length === 0) {
    return "No completed tasks found.";
  }
  const lines = [];
  lines.push(`# Changelog`);
  lines.push(``);
  lines.push(`_${entries.length} completed tasks_`);
  lines.push(``);
  const byDate = new Map;
  for (const entry of entries) {
    const date = new Date(entry.completedAt).toLocaleDateString();
    if (!byDate.has(date)) {
      byDate.set(date, []);
    }
    byDate.get(date).push(entry);
  }
  for (const [date, dateEntries] of byDate) {
    lines.push(`## ${date}`);
    lines.push(``);
    for (const entry of dateEntries) {
      lines.push(`- **[${entry.taskId}]** ${entry.taskName}`);
      lines.push(`  - Stage: ${entry.stageName}`);
      lines.push(`  - Thread: ${entry.threadName}`);
    }
    lines.push(``);
  }
  return lines.join(`
`);
}
function exportStreamAsCSV(repoRoot, streamId) {
  const tasks = getTasks(repoRoot, streamId);
  const headers = [
    "task_id",
    "name",
    "stage_name",
    "thread_name",
    "status",
    "created_at",
    "updated_at"
  ];
  const rows = tasks.map((task) => [
    task.id,
    `"${task.name.replace(/"/g, '""')}"`,
    `"${task.stage_name.replace(/"/g, '""')}"`,
    `"${task.thread_name.replace(/"/g, '""')}"`,
    task.status,
    task.created_at,
    task.updated_at
  ]);
  return [headers.join(","), ...rows.map((r) => r.join(","))].join(`
`);
}
function exportStreamAsJSON(repoRoot, streamId) {
  const index = loadIndex(repoRoot);
  const stream = findStream(index, streamId);
  if (!stream) {
    throw new Error(`Workstream "${streamId}" not found`);
  }
  const tasks = getTasks(repoRoot, stream.id);
  const metrics = evaluateStream(repoRoot, stream.id);
  const status = getStreamStatus(repoRoot, stream);
  return JSON.stringify({
    stream: {
      id: stream.id,
      name: stream.name,
      status,
      created_at: stream.created_at,
      updated_at: stream.updated_at
    },
    metrics,
    tasks
  }, null, 2);
}
function exportStreamAsMarkdown(repoRoot, streamId) {
  const report = generateReport(repoRoot, streamId);
  const tasks = getTasks(repoRoot, streamId);
  const grouped = groupTasks(tasks, { byBatch: false });
  const lines = [];
  lines.push(`# ${report.streamName}`);
  lines.push(``);
  lines.push(`**Status:** ${report.status}`);
  lines.push(`**Progress:** ${report.metrics.statusCounts.completed}/${report.metrics.totalTasks} tasks (${report.metrics.completionRate.toFixed(0)}%)`);
  lines.push(``);
  lines.push(`## Tasks`);
  lines.push(``);
  for (const [stageName, threads] of grouped) {
    lines.push(`### ${stageName}`);
    lines.push(``);
    for (const [threadName, threadTasks] of threads) {
      lines.push(`#### ${threadName}`);
      lines.push(``);
      for (const task of threadTasks) {
        const checkbox = task.status === "completed" ? "[x]" : "[ ]";
        const statusNote = task.status === "blocked" ? " (blocked)" : task.status === "in_progress" ? " (in progress)" : task.status === "cancelled" ? " (cancelled)" : "";
        lines.push(`- ${checkbox} **${task.id}**: ${task.name}${statusNote}`);
      }
      lines.push(``);
    }
  }
  return lines.join(`
`);
}
function exportStream(repoRoot, streamId, format) {
  switch (format) {
    case "csv":
      return exportStreamAsCSV(repoRoot, streamId);
    case "json":
      return exportStreamAsJSON(repoRoot, streamId);
    case "md":
      return exportStreamAsMarkdown(repoRoot, streamId);
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

// src/lib/reports.ts
init_lib();
init_tasks();
init_repo();
import { join as join15 } from "path";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync16, writeFileSync as writeFileSync3 } from "fs";
init_stream_parser();
function generateStageReport(repoRoot, streamId, stageRef) {
  const index = loadIndex(repoRoot);
  const stream = findStream(index, streamId);
  if (!stream) {
    throw new Error(`Workstream "${streamId}" not found`);
  }
  const workDir = getWorkDir(repoRoot);
  const planPath = join15(workDir, stream.id, "PLAN.md");
  const planContent = readFileSync16(planPath, "utf-8");
  const errors = [];
  const planDoc = parseStreamDocument(planContent, errors);
  if (!planDoc) {
    throw new Error(`Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`);
  }
  const stageRefStr = typeof stageRef === "number" ? stageRef.toString() : stageRef;
  const stageDef = resolveByNameOrIndex(stageRefStr, planDoc.stages, "stage");
  const stageNumber = stageDef.id;
  const stagePrefix = stageNumber.toString().padStart(2, "0");
  const allTasks = getTasks(repoRoot, stream.id);
  const stageTasks = allTasks.filter((t) => {
    const parsed = parseTaskId(t.id);
    return parsed.stage === stageNumber;
  });
  const metrics = calculateStageMetrics2(stageTasks);
  const status = determineStageStatus(stageTasks, metrics);
  const batches = groupTasksIntoBatches(stageTasks, stageDef.batches);
  return {
    stageNumber,
    stageName: stageDef.name,
    stagePrefix,
    streamId: stream.id,
    streamName: stream.name,
    generatedAt: new Date().toISOString(),
    status,
    batches,
    metrics
  };
}
function calculateStageMetrics2(tasks) {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;
  return {
    totalTasks: total,
    completed,
    inProgress,
    pending,
    blocked,
    cancelled,
    completionRate: total > 0 ? completed / total * 100 : 0
  };
}
function determineStageStatus(tasks, metrics) {
  if (tasks.length === 0)
    return "pending";
  if (metrics.blocked > 0)
    return "blocked";
  if (metrics.completed === metrics.totalTasks)
    return "complete";
  if (metrics.inProgress > 0 || metrics.completed > 0)
    return "in_progress";
  return "pending";
}
function groupTasksIntoBatches(tasks, batchDefs) {
  const batches = [];
  const batchMap = new Map;
  for (const batch of batchDefs) {
    const threadMap = new Map;
    for (const thread of batch.threads) {
      threadMap.set(thread.id, thread.name);
    }
    batchMap.set(batch.id, { name: batch.name, threads: threadMap });
  }
  const grouped = new Map;
  for (const task of tasks) {
    const parsed = parseTaskId(task.id);
    if (!grouped.has(parsed.batch)) {
      grouped.set(parsed.batch, new Map);
    }
    const batchTasks = grouped.get(parsed.batch);
    if (!batchTasks.has(parsed.thread)) {
      batchTasks.set(parsed.thread, []);
    }
    batchTasks.get(parsed.thread).push(task);
  }
  const sortedBatches = Array.from(grouped.keys()).sort((a, b2) => a - b2);
  for (const batchNum of sortedBatches) {
    const batchInfo = batchMap.get(batchNum);
    const batchName = batchInfo?.name ?? `Batch ${batchNum.toString().padStart(2, "0")}`;
    const batchTasks = grouped.get(batchNum);
    const threads = [];
    const sortedThreads = Array.from(batchTasks.keys()).sort((a, b2) => a - b2);
    for (const threadNum of sortedThreads) {
      const threadName = batchInfo?.threads.get(threadNum) ?? `Thread ${threadNum.toString().padStart(2, "0")}`;
      const threadTasks = batchTasks.get(threadNum);
      threadTasks.sort((a, b2) => a.id.localeCompare(b2.id, undefined, { numeric: true }));
      threads.push({
        threadNumber: threadNum,
        threadName,
        tasks: threadTasks.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          report: t.report
        }))
      });
    }
    batches.push({
      batchNumber: batchNum,
      batchName,
      threads
    });
  }
  return batches;
}
function formatStageReportMarkdown(report) {
  const lines = [];
  lines.push(`# Stage Report: ${report.stageName} (Stage ${report.stagePrefix})`);
  lines.push("");
  lines.push(`> **Generated:** ${report.generatedAt}  `);
  lines.push(`> **Status:** ${formatStatus(report.status)} (${report.metrics.completed}/${report.metrics.totalTasks} tasks)`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`Stage ${report.stagePrefix} (${report.stageName}) progress summary.`);
  lines.push("");
  lines.push("## Completed Work");
  lines.push("");
  for (const batch of report.batches) {
    lines.push(`### Batch ${batch.batchNumber.toString().padStart(2, "0")}: ${batch.batchName}`);
    lines.push("");
    for (const thread of batch.threads) {
      const completedCount = thread.tasks.filter((t) => t.status === "completed").length;
      lines.push(`**Thread: ${thread.threadName}** (${completedCount}/${thread.tasks.length} tasks)`);
      for (const task of thread.tasks) {
        const statusIcon = getStatusIcon(task.status);
        lines.push(`- ${statusIcon} ${task.name}`);
        if (task.report) {
          lines.push(`  > ${task.report}`);
        }
      }
      lines.push("");
    }
  }
  const blockedTasks = report.batches.flatMap((b2) => b2.threads).flatMap((t) => t.tasks).filter((t) => t.status === "blocked");
  lines.push("## Issues & Blockers");
  lines.push("");
  if (blockedTasks.length > 0) {
    for (const task of blockedTasks) {
      lines.push(`- **${task.id}:** ${task.name}`);
      if (task.report) {
        lines.push(`  > ${task.report}`);
      }
    }
  } else {
    lines.push("No blocked tasks in this stage.");
  }
  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Tasks | ${report.metrics.completed}/${report.metrics.totalTasks} complete |`);
  lines.push(`| Completion Rate | ${report.metrics.completionRate.toFixed(1)}% |`);
  lines.push(`| Batches | ${report.batches.length} |`);
  lines.push(`| Threads | ${report.batches.reduce((acc, b2) => acc + b2.threads.length, 0)} |`);
  lines.push(`| Blocked | ${report.metrics.blocked} |`);
  lines.push("");
  return lines.join(`
`);
}
function formatStatus(status) {
  switch (status) {
    case "complete":
      return "Complete";
    case "in_progress":
      return "In Progress";
    case "pending":
      return "Pending";
    case "blocked":
      return "Blocked";
    default:
      return status;
  }
}
function getStatusIcon(status) {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "pending":
      return "○";
    case "blocked":
      return "✗";
    case "cancelled":
      return "−";
    default:
      return "?";
  }
}
function saveStageReport(repoRoot, streamId, report) {
  const workDir = getWorkDir(repoRoot);
  const reportsDir = join15(workDir, streamId, "reports");
  mkdirSync2(reportsDir, { recursive: true });
  const slug = report.stageName.toLowerCase().replace(/\s+/g, "-");
  const filename = `${report.stagePrefix}-${slug}.md`;
  const outputPath = join15(reportsDir, filename);
  const content = formatStageReportMarkdown(report);
  writeFileSync3(outputPath, content);
  return outputPath;
}

// src/cli/report.ts
init_tasks();
function printHelp19() {
  console.log(`
work report - Generate and validate workstream reports

Usage:
  work report [subcommand] [options]

Subcommands:
  init             Generate REPORT.md template for an existing workstream
  validate         Validate REPORT.md has required sections filled
  metrics          Evaluate workstream progress and metrics
  (none)           Generate progress report (default behavior)

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Specific workstream ID or name (uses current if set)
  --stage          Generate stage-specific report (number or name)
  --all            Generate report for all workstreams
  --output, -o     Output file path (prints to stdout if omitted)
  --save           Save stage report to reports/ directory
  --json, -j       Output as JSON
  --help, -h       Show this help message

Metrics Options (for 'work report metrics'):
  --filter <pattern>   Filter tasks by name pattern
  --regex              Treat filter as regex pattern
  --filter-status <s>  Filter by status (comma-separated: pending,blocked)
  --blockers           Show blocked task analysis
  --compact            Single-line summary per workstream

Examples:
  # Generate REPORT.md template for current workstream
  work report init

  # Validate REPORT.md for current workstream
  work report validate

  # Current workstream report
  work report

  # Stage-specific report
  work report --stage 1

  # Metrics and Status
  work report metrics
  work report metrics --blockers
  work report metrics --filter "test"

  # All workstreams
  work report --all
`);
}
function parseCliArgs19(argv) {
  const args = argv.slice(2);
  const parsed = {
    all: false,
    json: false,
    save: false,
    regex: false,
    blockers: false,
    compact: false
  };
  if (args.length > 0 && !args[0]?.startsWith("-")) {
    const subcommand = args[0];
    if (subcommand === "init" || subcommand === "validate" || subcommand === "metrics") {
      parsed.subcommand = subcommand;
      args.shift();
    }
  }
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        parsed.stage = next;
        i++;
        break;
      case "--all":
        parsed.all = true;
        break;
      case "--output":
      case "-o":
        if (!next) {
          console.error("Error: --output requires a value");
          return null;
        }
        parsed.output = next;
        i++;
        break;
      case "--save":
        parsed.save = true;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--filter":
        if (!next) {
          console.error("Error: --filter requires a value");
          return null;
        }
        parsed.filter = next;
        i++;
        break;
      case "--regex":
        parsed.regex = true;
        break;
      case "--filter-status":
        if (!next) {
          console.error("Error: --filter-status requires a value");
          return null;
        }
        parsed.filterStatus = next;
        i++;
        break;
      case "--blockers":
        parsed.blockers = true;
        break;
      case "--compact":
        parsed.compact = true;
        break;
      case "--help":
      case "-h":
        printHelp19();
        process.exit(0);
    }
  }
  return parsed;
}
function handleInit(repoRoot, streamId) {
  const index = loadIndex(repoRoot);
  const stream = findStream(index, streamId);
  if (!stream) {
    console.error(`Error: Workstream "${streamId}" not found`);
    process.exit(1);
  }
  const workDir = getWorkDir(repoRoot);
  const reportPath = join16(workDir, stream.id, "REPORT.md");
  if (existsSync16(reportPath)) {
    console.error(`Error: REPORT.md already exists at ${reportPath}`);
    console.error("Use --force to overwrite (not implemented yet)");
    process.exit(1);
  }
  try {
    const template = generateReportTemplate(repoRoot, streamId);
    atomicWriteFile(reportPath, template);
    console.log(`Created REPORT.md template: ${reportPath}`);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Fill in the Summary section with a high-level overview");
    console.log("  2. Document accomplishments for each stage");
    console.log("  3. Add file references with changes made");
    console.log("  4. Run: work report validate");
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
function handleValidate(repoRoot, streamId) {
  const index = loadIndex(repoRoot);
  const stream = findStream(index, streamId);
  if (!stream) {
    console.error(`Error: Workstream "${streamId}" not found`);
    process.exit(1);
  }
  const workDir = getWorkDir(repoRoot);
  const reportPath = join16(workDir, stream.id, "REPORT.md");
  if (!existsSync16(reportPath)) {
    console.error(`Error: REPORT.md not found at ${reportPath}`);
    console.error("Run 'work report init' to create a template");
    process.exit(1);
  }
  try {
    const validation = validateReport(repoRoot, streamId);
    if (validation.valid) {
      console.log("✓ REPORT.md validation passed");
      if (validation.warnings.length > 0) {
        console.log(`
Warnings:`);
        for (const warning of validation.warnings) {
          console.log(`  ⚠ ${warning}`);
        }
      }
    } else {
      console.log("✗ REPORT.md validation failed");
      console.log(`
Errors:`);
      for (const error of validation.errors) {
        console.log(`  ✗ ${error}`);
      }
      if (validation.warnings.length > 0) {
        console.log(`
Warnings:`);
        for (const warning of validation.warnings) {
          console.log(`  ⚠ ${warning}`);
        }
      }
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
function getStatusIcon2(status) {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[~]";
    case "blocked":
      return "[!]";
    case "cancelled":
      return "[-]";
    default:
      return "[ ]";
  }
}
function handleMetrics(repoRoot, cliArgs) {
  const index = loadIndex(repoRoot);
  if (cliArgs.all) {
    const allMetrics = evaluateAllStreams(repoRoot);
    if (cliArgs.json) {
      const aggregate2 = aggregateMetrics(allMetrics);
      console.log(JSON.stringify({ streams: allMetrics, aggregate: aggregate2 }, null, 2));
      return;
    }
    if (cliArgs.compact) {
      for (const metrics2 of allMetrics) {
        console.log(formatMetricsOutput(metrics2, { compact: true }));
      }
      console.log("");
      const aggregate2 = aggregateMetrics(allMetrics);
      console.log(formatMetricsOutput(aggregate2, { compact: true }));
      return;
    }
    for (const metrics2 of allMetrics) {
      console.log(formatMetricsOutput(metrics2));
      console.log("");
    }
    console.log("─".repeat(40));
    const aggregate = aggregateMetrics(allMetrics);
    console.log(formatMetricsOutput(aggregate));
    return;
  }
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId);
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified. Use --stream or set current with 'work current --set'");
    process.exit(1);
  }
  const stream = findStream(index, resolvedStreamId);
  if (!stream) {
    console.error(`Error: Workstream "${resolvedStreamId}" not found`);
    process.exit(1);
  }
  if (cliArgs.blockers) {
    const analysis = analyzeBlockers(repoRoot, stream.id);
    if (cliArgs.json) {
      console.log(JSON.stringify(analysis, null, 2));
      return;
    }
    console.log(formatBlockerAnalysis(analysis));
    return;
  }
  if (cliArgs.filter || cliArgs.filterStatus) {
    let tasks = getTasks(repoRoot, stream.id);
    if (cliArgs.filterStatus) {
      const statuses = cliArgs.filterStatus.split(",");
      tasks = filterTasksByStatus(tasks, statuses);
    }
    if (cliArgs.filter) {
      const result = filterTasks(tasks, cliArgs.filter, cliArgs.regex);
      tasks = result.matchingTasks;
      if (cliArgs.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Found ${result.matchCount} of ${result.totalTasks} tasks matching "${cliArgs.filter}":`);
      console.log("");
      for (const task of tasks) {
        const statusIcon = getStatusIcon2(task.status);
        console.log(`  ${statusIcon} [${task.id}] ${task.name}`);
      }
      return;
    }
    if (cliArgs.json) {
      console.log(JSON.stringify({ tasks, count: tasks.length }, null, 2));
      return;
    }
    console.log(`Found ${tasks.length} tasks with status: ${cliArgs.filterStatus}`);
    console.log("");
    for (const task of tasks) {
      const statusIcon = getStatusIcon2(task.status);
      console.log(`  ${statusIcon} [${task.id}] ${task.name}`);
    }
    return;
  }
  const metrics = evaluateStream(repoRoot, stream.id);
  if (cliArgs.json) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }
  console.log(formatMetricsOutput(metrics, { compact: cliArgs.compact }));
}
function main19(argv = process.argv) {
  const cliArgs = parseCliArgs19(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (index.streams.length === 0) {
    console.log("No workstreams found.");
    return;
  }
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId);
  if (cliArgs.subcommand === "init") {
    if (!resolvedStreamId) {
      console.error("Error: No workstream specified. Use --stream or set current with 'work current --set'");
      process.exit(1);
    }
    handleInit(repoRoot, resolvedStreamId);
    return;
  }
  if (cliArgs.subcommand === "validate") {
    if (!resolvedStreamId) {
      console.error("Error: No workstream specified. Use --stream or set current with 'work current --set'");
      process.exit(1);
    }
    handleValidate(repoRoot, resolvedStreamId);
    return;
  }
  if (cliArgs.subcommand === "metrics") {
    handleMetrics(repoRoot, cliArgs);
    return;
  }
  if (cliArgs.stage) {
    if (!resolvedStreamId) {
      console.error("Error: No workstream specified. Use --stream or set current with 'work current --set'");
      process.exit(1);
    }
    const stream2 = findStream(index, resolvedStreamId);
    if (!stream2) {
      console.error(`Error: Workstream "${resolvedStreamId}" not found`);
      process.exit(1);
    }
    try {
      const stageRef = /^\d+$/.test(cliArgs.stage) ? parseInt(cliArgs.stage, 10) : cliArgs.stage;
      const report2 = generateStageReport(repoRoot, stream2.id, stageRef);
      if (cliArgs.json) {
        const output3 = JSON.stringify(report2, null, 2);
        if (cliArgs.output) {
          writeFileSync4(cliArgs.output, output3);
          console.log(`Stage report written to ${cliArgs.output}`);
        } else {
          console.log(output3);
        }
        return;
      }
      if (cliArgs.save) {
        const savedPath = saveStageReport(repoRoot, stream2.id, report2);
        console.log(`Stage report saved to ${savedPath}`);
        return;
      }
      const output2 = formatStageReportMarkdown(report2);
      if (cliArgs.output) {
        writeFileSync4(cliArgs.output, output2);
        console.log(`Stage report written to ${cliArgs.output}`);
      } else {
        console.log(output2);
      }
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    return;
  }
  if (cliArgs.all) {
    const reports = index.streams.map((stream2) => generateReport(repoRoot, stream2.id));
    if (cliArgs.json) {
      const output3 = JSON.stringify(reports, null, 2);
      if (cliArgs.output) {
        writeFileSync4(cliArgs.output, output3);
        console.log(`Report written to ${cliArgs.output}`);
      } else {
        console.log(output3);
      }
      return;
    }
    const markdowns = reports.map((r) => formatReportMarkdown(r));
    const output2 = markdowns.join(`

---

`);
    if (cliArgs.output) {
      writeFileSync4(cliArgs.output, output2);
      console.log(`Report written to ${cliArgs.output}`);
    } else {
      console.log(output2);
    }
    return;
  }
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified. Use --stream or set current with 'work current --set'");
    process.exit(1);
  }
  const stream = findStream(index, resolvedStreamId);
  if (!stream) {
    console.error(`Error: Workstream "${resolvedStreamId}" not found`);
    process.exit(1);
  }
  const report = generateReport(repoRoot, stream.id);
  if (cliArgs.json) {
    const output2 = JSON.stringify(report, null, 2);
    if (cliArgs.output) {
      writeFileSync4(cliArgs.output, output2);
      console.log(`Report written to ${cliArgs.output}`);
    } else {
      console.log(output2);
    }
    return;
  }
  const output = formatReportMarkdown(report);
  if (cliArgs.output) {
    writeFileSync4(cliArgs.output, output);
    console.log(`Report written to ${cliArgs.output}`);
  } else {
    console.log(output);
  }
}
if (false) {}

// src/cli/changelog.ts
init_repo();
init_lib();
import { writeFileSync as writeFileSync5 } from "fs";
function printHelp20() {
  console.log(`
work changelog - Generate changelog from completed tasks

Usage:
  work changelog [options]

Options:
  --repo-root, -r   Repository root (auto-detected if omitted)
  --stream, -s      Specific workstream ID or name (uses current if set)
  --all             Generate changelog from all workstreams
  --since <date>    Filter tasks completed since date (YYYY-MM-DD)
  --since-days <n>  Filter tasks completed in last N days
  --output, -o      Output file path (prints to stdout if omitted)
  --json, -j        Output as JSON
  --help, -h        Show this help message

Examples:
  # Current workstream changelog
  work changelog

  # Last 7 days
  work changelog --since-days 7

  # Since specific date
  work changelog --since "2026-01-01"

  # Write to file
  work changelog --output CHANGELOG.md

  # All workstreams
  work changelog --all
`);
}
function parseCliArgs20(argv) {
  const args = argv.slice(2);
  const parsed = {
    all: false,
    json: false
  };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--all":
        parsed.all = true;
        break;
      case "--since":
        if (!next) {
          console.error("Error: --since requires a value");
          return null;
        }
        parsed.since = next;
        i++;
        break;
      case "--since-days":
        if (!next) {
          console.error("Error: --since-days requires a value");
          return null;
        }
        const days = parseInt(next, 10);
        if (isNaN(days) || days <= 0) {
          console.error("Error: --since-days must be a positive number");
          return null;
        }
        parsed.sinceDays = days;
        i++;
        break;
      case "--output":
      case "-o":
        if (!next) {
          console.error("Error: --output requires a value");
          return null;
        }
        parsed.output = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp20();
        process.exit(0);
    }
  }
  return parsed;
}
function main20(argv = process.argv) {
  const cliArgs = parseCliArgs20(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (index.streams.length === 0) {
    console.log("No workstreams found.");
    return;
  }
  let sinceDate;
  if (cliArgs.sinceDays) {
    sinceDate = new Date;
    sinceDate.setDate(sinceDate.getDate() - cliArgs.sinceDays);
  } else if (cliArgs.since) {
    sinceDate = new Date(cliArgs.since);
    if (isNaN(sinceDate.getTime())) {
      console.error(`Error: Invalid date format: ${cliArgs.since}`);
      process.exit(1);
    }
  }
  if (cliArgs.all) {
    const allEntries = index.streams.flatMap((stream2) => generateChangelog(repoRoot, stream2.id, sinceDate).map((e) => ({
      ...e,
      streamId: stream2.id,
      streamName: stream2.name
    })));
    allEntries.sort((a, b2) => new Date(b2.completedAt).getTime() - new Date(a.completedAt).getTime());
    if (cliArgs.json) {
      const output3 = JSON.stringify(allEntries, null, 2);
      if (cliArgs.output) {
        writeFileSync5(cliArgs.output, output3);
        console.log(`Changelog written to ${cliArgs.output}`);
      } else {
        console.log(output3);
      }
      return;
    }
    const output2 = formatChangelogMarkdown(allEntries);
    if (cliArgs.output) {
      writeFileSync5(cliArgs.output, output2);
      console.log(`Changelog written to ${cliArgs.output}`);
    } else {
      console.log(output2);
    }
    return;
  }
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId);
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified. Use --stream or set current with 'work current --set'");
    process.exit(1);
  }
  const stream = findStream(index, resolvedStreamId);
  if (!stream) {
    console.error(`Error: Workstream "${resolvedStreamId}" not found`);
    process.exit(1);
  }
  const entries = generateChangelog(repoRoot, stream.id, sinceDate);
  if (cliArgs.json) {
    const output2 = JSON.stringify(entries, null, 2);
    if (cliArgs.output) {
      writeFileSync5(cliArgs.output, output2);
      console.log(`Changelog written to ${cliArgs.output}`);
    } else {
      console.log(output2);
    }
    return;
  }
  const output = formatChangelogMarkdown(entries);
  if (cliArgs.output) {
    writeFileSync5(cliArgs.output, output);
    console.log(`Changelog written to ${cliArgs.output}`);
  } else {
    console.log(output);
  }
}
if (false) {}

// src/cli/export.ts
init_repo();
init_lib();
import { writeFileSync as writeFileSync6 } from "fs";
function printHelp21() {
  console.log(`
work export - Export workstream data

Usage:
  work export --format <format> [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Specific workstream ID or name (uses current if set)
  --format, -f     Export format: md, csv, json (required)
  --output, -o     Output file path (prints to stdout if omitted)
  --help, -h       Show this help message

Formats:
  md    Markdown summary with task checklist
  csv   CSV spreadsheet format
  json  Full JSON export with metadata

Examples:
  # Export as markdown
  work export --format md

  # Export as CSV
  work export --format csv --output tasks.csv

  # Export as JSON
  work export --format json

  # Specific workstream
  work export --stream "001-my-stream" --format md
`);
}
function parseCliArgs21(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--format":
      case "-f":
        if (!next) {
          console.error("Error: --format requires a value");
          return null;
        }
        if (!["md", "csv", "json"].includes(next)) {
          console.error(`Error: Invalid format "${next}". Use md, csv, or json`);
          return null;
        }
        parsed.format = next;
        i++;
        break;
      case "--output":
      case "-o":
        if (!next) {
          console.error("Error: --output requires a value");
          return null;
        }
        parsed.output = next;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp21();
        process.exit(0);
    }
  }
  return parsed;
}
function main21(argv = process.argv) {
  const cliArgs = parseCliArgs21(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.format) {
    console.error("Error: --format is required");
    console.error("Run with --help for usage information.");
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (index.streams.length === 0) {
    console.log("No workstreams found.");
    return;
  }
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId);
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified. Use --stream or set current with 'work current --set'");
    process.exit(1);
  }
  const stream = findStream(index, resolvedStreamId);
  if (!stream) {
    console.error(`Error: Workstream "${resolvedStreamId}" not found`);
    process.exit(1);
  }
  const output = exportStream(repoRoot, stream.id, cliArgs.format);
  if (cliArgs.output) {
    writeFileSync6(cliArgs.output, output);
    console.log(`Exported to ${cliArgs.output}`);
  } else {
    console.log(output);
  }
}
if (false) {}

// src/cli/approve/index.ts
init_repo();
init_lib();

// src/cli/approve/utils.ts
function formatApprovalIcon2(status) {
  switch (status) {
    case "approved":
      return "APPROVED";
    case "revoked":
      return "REVOKED";
    default:
      return "PENDING";
  }
}

// src/cli/approve/plan.ts
import { existsSync as existsSync17, readFileSync as readFileSync17 } from "fs";
import { join as join18 } from "path";
// src/lib/github/sync.ts
init_tasks();

// src/lib/github/workstream-github.ts
init_repo();
import { join as join17, dirname as dirname4 } from "node:path";
import { readFile as readFile2, writeFile as writeFile2, rename as rename2, mkdir as mkdir2 } from "node:fs/promises";
function getWorkstreamGitHubPath(repoRoot, streamId) {
  return join17(getWorkDir(repoRoot), streamId, "github.json");
}
async function loadWorkstreamGitHub(repoRoot, streamId) {
  const configPath = getWorkstreamGitHubPath(repoRoot, streamId);
  try {
    const content = await readFile2(configPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function saveWorkstreamGitHub(repoRoot, streamId, data) {
  const configPath = getWorkstreamGitHubPath(repoRoot, streamId);
  const tempPath = `${configPath}.tmp`;
  await mkdir2(dirname4(configPath), { recursive: true });
  data.last_updated = new Date().toISOString();
  await writeFile2(tempPath, JSON.stringify(data, null, 2), "utf-8");
  await rename2(tempPath, configPath);
}
async function initWorkstreamGitHub(repoRoot, streamId) {
  const data = {
    version: "1.0.0",
    stream_id: streamId,
    last_updated: new Date().toISOString(),
    stages: {}
  };
  await saveWorkstreamGitHub(repoRoot, streamId, data);
  return data;
}
function getStageIssue(data, stageNumber) {
  return data.stages[stageNumber];
}
function setStageIssue(data, stageNumber, issue) {
  data.stages[stageNumber] = issue;
}
function updateStageIssueState(data, stageNumber, state, closedAt) {
  const issue = data.stages[stageNumber];
  if (issue) {
    issue.state = state;
    if (state === "closed" && closedAt) {
      issue.closed_at = closedAt;
    } else if (state === "open") {
      delete issue.closed_at;
    }
  }
}

// src/lib/github/sync.ts
function isStageComplete(repoRoot, streamId, stageNumber) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return false;
  const stagePrefix = `${stageNumber.toString().padStart(2, "0")}.`;
  const stageTasks = tasksFile.tasks.filter((t) => t.id.startsWith(stagePrefix));
  if (stageTasks.length === 0)
    return false;
  return stageTasks.every((t) => t.status === "completed" || t.status === "cancelled");
}
function getStageName(repoRoot, streamId, stageNumber) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return null;
  const stagePrefix = `${stageNumber.toString().padStart(2, "0")}.`;
  const firstTask = tasksFile.tasks.find((t) => t.id.startsWith(stagePrefix));
  return firstTask?.stage_name || null;
}
async function syncStageIssues(repoRoot, streamId) {
  const result = {
    closed: [],
    unchanged: [],
    errors: []
  };
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) {
    return result;
  }
  const config = await loadGitHubConfig(repoRoot);
  if (!config.owner || !config.repo) {
    return result;
  }
  let githubData = await loadWorkstreamGitHub(repoRoot, streamId);
  if (!githubData) {
    return result;
  }
  const token = getGitHubAuth();
  if (!token) {
    return result;
  }
  const client = createGitHubClient(token, config.owner, config.repo);
  let needsSave = false;
  for (const [stageNumber, stageIssue] of Object.entries(githubData.stages)) {
    const stageName = getStageName(repoRoot, streamId, parseInt(stageNumber, 10)) || `Stage ${stageNumber}`;
    if (stageIssue.state === "closed") {
      result.unchanged.push({
        stageNumber,
        stageName,
        issueNumber: stageIssue.issue_number,
        reason: "Issue already closed"
      });
      continue;
    }
    const stageNum = parseInt(stageNumber, 10);
    const isComplete = isStageComplete(repoRoot, streamId, stageNum);
    if (!isComplete) {
      result.unchanged.push({
        stageNumber,
        stageName,
        issueNumber: stageIssue.issue_number,
        reason: "Stage has incomplete tasks"
      });
      continue;
    }
    try {
      await client.closeIssue(stageIssue.issue_number);
      const closedAt = new Date().toISOString();
      updateStageIssueState(githubData, stageNumber, "closed", closedAt);
      needsSave = true;
      result.closed.push({
        stageNumber,
        stageName,
        issueNumber: stageIssue.issue_number,
        issueUrl: stageIssue.issue_url
      });
    } catch (error) {
      result.errors.push({
        stageNumber,
        stageName,
        issueNumber: stageIssue.issue_number,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (needsSave) {
    await saveWorkstreamGitHub(repoRoot, streamId, githubData);
  }
  return result;
}
// src/lib/github/commits.ts
import { execSync as execSync5 } from "node:child_process";
function formatStageCommitMessage(streamId, streamName, stageNum, stageName) {
  const title = `Stage ${stageNum} approved: ${stageName}`;
  const body = [
    `Approved stage ${stageNum} of workstream ${streamId}.`,
    "",
    `Stream-Id: ${streamId}`,
    `Stream-Name: ${streamName}`,
    `Stage: ${stageNum}`,
    `Stage-Name: ${stageName}`
  ].join(`
`);
  return { title, body };
}
function hasUncommittedChanges(repoRoot) {
  try {
    const statusOutput = execSync5("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return statusOutput.length > 0;
  } catch {
    return false;
  }
}
function createStageApprovalCommit(repoRoot, stream, stageNum, stageName) {
  try {
    execSync5("git add -A", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (!hasUncommittedChanges(repoRoot)) {
      return {
        success: true,
        skipped: true
      };
    }
    const { title, body } = formatStageCommitMessage(stream.id, stream.name, stageNum, stageName);
    const escapedBody = body.replace(/"/g, "\\\"");
    execSync5(`git commit -m "${title}" -m "${escapedBody}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const commitSha = execSync5("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return {
      success: true,
      commitSha
    };
  } catch (error) {
    const errorMessage = error.message || String(error);
    return {
      success: false,
      error: errorMessage
    };
  }
}
// src/lib/github/labels.ts
init_lib();
init_tasks();
function sanitizeLabelName(value) {
  return value.replace(/,/g, "").replace(/\s+/g, " ").trim();
}
function formatLabel(prefix, value) {
  const sanitized = sanitizeLabelName(value);
  const label = `${prefix}${sanitized}`;
  return label.length > 50 ? label.slice(0, 50) : label;
}
async function ensureWorkstreamLabels(repoRoot, streamId) {
  if (!await isGitHubEnabled(repoRoot)) {
    return;
  }
  const config2 = await loadGitHubConfig(repoRoot);
  if (!config2.owner || !config2.repo) {
    throw new Error("GitHub integration enabled but owner/repo not configured");
  }
  const token = await ensureGitHubAuth();
  const client = createGitHubClient(token, config2.owner, config2.repo);
  const index = loadIndex(repoRoot);
  const stream = getStream(index, streamId);
  const labelsToCreate = [];
  const streamLabel = formatLabel(config2.label_config.workstream.prefix, stream.name);
  labelsToCreate.push({
    name: streamLabel,
    color: config2.label_config.workstream.color,
    description: `Workstream: ${stream.name}`
  });
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (tasksFile) {
    const stages = new Map;
    const batches = new Map;
    for (const task of tasksFile.tasks) {
      try {
        const { stage, batch } = parseTaskId(task.id);
        const stageId = stage.toString().padStart(2, "0");
        const batchId = `${stageId}.${batch.toString().padStart(2, "0")}`;
        if (!stages.has(stageId)) {
          stages.set(stageId, { id: stageId, name: task.stage_name });
        }
        if (!batches.has(batchId)) {
          batches.set(batchId, { id: batchId, name: task.batch_name });
        }
      } catch (e) {
        continue;
      }
    }
    for (const { id, name } of stages.values()) {
      const labelName = formatLabel(config2.label_config.stage.prefix, `${id}-${name}`);
      labelsToCreate.push({
        name: labelName,
        color: config2.label_config.stage.color,
        description: `Stage ${id}: ${name}`
      });
    }
    for (const { id, name } of batches.values()) {
      const labelName = formatLabel(config2.label_config.batch.prefix, `${id}-${name}`);
      labelsToCreate.push({
        name: labelName,
        color: config2.label_config.batch.color,
        description: `Batch ${id}: ${name}`
      });
    }
  }
  await client.ensureLabels(labelsToCreate);
}

// src/lib/github/issues.ts
function formatStageIssueTitle(streamId, stageNumber, stageName) {
  const stageId = stageNumber.toString().padStart(2, "0");
  return `[${streamId}] Stage ${stageId}: ${stageName}`;
}
function formatStageIssueBody(input) {
  const stageId = input.stageNumber.toString().padStart(2, "0");
  let body = `**Workstream:** ${input.streamName} (\`${input.streamId}\`)
**Stage:** ${stageId} - ${input.stageName}

## Batches

`;
  for (const batch of input.batches) {
    body += `### Batch ${batch.batchId}: ${batch.batchName}

`;
    for (const thread of batch.threads) {
      body += `#### Thread ${thread.threadId}: ${thread.threadName}

`;
      for (const task of thread.tasks) {
        const checkbox = task.status === "completed" || task.status === "cancelled" ? "[x]" : "[ ]";
        const suffix = task.status === "cancelled" ? " *(cancelled)*" : "";
        body += `- ${checkbox} \`${task.taskId}\` ${task.taskName}${suffix}
`;
      }
      body += `
`;
    }
  }
  return body.trim();
}
function getStageLabels(config2, streamName, stageId, stageName) {
  const { label_config } = config2;
  const streamLabel = formatLabel(label_config.workstream.prefix, streamName);
  const stageLabel = formatLabel(label_config.stage.prefix, `${stageId}-${stageName}`);
  return [streamLabel, stageLabel];
}
async function createStageIssue(repoRoot, input) {
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) {
    return null;
  }
  const config2 = await loadGitHubConfig(repoRoot);
  if (!config2.owner || !config2.repo) {
    return null;
  }
  const token = getGitHubAuth();
  if (!token) {
    throw new Error("GitHub authentication failed. Please check your token.");
  }
  const client = createGitHubClient(token, config2.owner, config2.repo);
  const title = formatStageIssueTitle(input.streamId, input.stageNumber, input.stageName);
  const body = formatStageIssueBody(input);
  const stageId = input.stageNumber.toString().padStart(2, "0");
  const labels = getStageLabels(config2, input.streamName, stageId, input.stageName);
  const issue = await client.createIssue(title, body, labels);
  return {
    issue_number: issue.number,
    issue_url: issue.html_url,
    state: "open",
    created_at: new Date().toISOString()
  };
}
async function findExistingStageIssue(repoRoot, streamId, stageNumber, stageName) {
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) {
    return null;
  }
  const config2 = await loadGitHubConfig(repoRoot);
  if (!config2.owner || !config2.repo) {
    return null;
  }
  const token = getGitHubAuth();
  if (!token) {
    return null;
  }
  const client = createGitHubClient(token, config2.owner, config2.repo);
  const expectedTitle = formatStageIssueTitle(streamId, stageNumber, stageName);
  try {
    const issues = await client.searchIssues({
      title: expectedTitle,
      state: "all"
    });
    const matchingIssue = issues.find((issue) => issue.title === expectedTitle);
    if (matchingIssue) {
      return {
        issueNumber: matchingIssue.number,
        issueUrl: matchingIssue.html_url,
        state: matchingIssue.state === "closed" ? "closed" : "open"
      };
    }
  } catch (error) {
    console.error("Failed to search for existing stage issues:", error);
  }
  return null;
}
async function reopenStageIssue(repoRoot, issueNumber) {
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled)
    return;
  const config2 = await loadGitHubConfig(repoRoot);
  if (!config2.owner || !config2.repo)
    return;
  const token = getGitHubAuth();
  if (!token)
    return;
  const client = createGitHubClient(token, config2.owner, config2.repo);
  await client.reopenIssue(issueNumber);
}
async function closeStageIssue(repoRoot, issueNumber) {
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled)
    return;
  const config2 = await loadGitHubConfig(repoRoot);
  if (!config2.owner || !config2.repo)
    return;
  const token = getGitHubAuth();
  if (!token)
    return;
  const client = createGitHubClient(token, config2.owner, config2.repo);
  await client.closeIssue(issueNumber);
}

// src/cli/approve/plan.ts
init_tasks_md();
init_stream_parser();
init_repo();
init_lib();
init_tasks();
function generateTasksMdAfterApproval(repoRoot, streamId, streamName) {
  try {
    const workDir = getWorkDir(repoRoot);
    const streamDir = join18(workDir, streamId);
    const tasksMdPath = join18(streamDir, "TASKS.md");
    const planMdPath = join18(streamDir, "PLAN.md");
    if (!existsSync17(planMdPath)) {
      return {
        success: false,
        error: `PLAN.md not found at ${planMdPath}`
      };
    }
    const overwritten = existsSync17(tasksMdPath);
    const planContent = readFileSync17(planMdPath, "utf-8");
    const errors = [];
    const doc = parseStreamDocument(planContent, errors);
    if (!doc) {
      return {
        success: false,
        error: `Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`
      };
    }
    const content = generateTasksMdFromPlan(streamName, doc);
    atomicWriteFile(tasksMdPath, content);
    return {
      success: true,
      path: tasksMdPath,
      overwritten
    };
  } catch (e) {
    return {
      success: false,
      error: e.message
    };
  }
}
async function handlePlanApproval(repoRoot, stream, cliArgs) {
  if (cliArgs.stage !== undefined) {
    const stageNum = cliArgs.stage;
    if (cliArgs.revoke) {
      try {
        const stageStatus2 = getStageApprovalStatus(stream, stageNum);
        if (stageStatus2 !== "approved") {
          console.error(`Error: Stage ${stageNum} is not approved, nothing to revoke`);
          process.exit(1);
        }
        const updatedStream = revokeStageApproval(repoRoot, stream.id, stageNum, cliArgs.reason);
        if (cliArgs.json) {
          console.log(JSON.stringify({
            action: "revoked",
            scope: "stage",
            stage: stageNum,
            streamId: updatedStream.id,
            reason: cliArgs.reason,
            approval: updatedStream.approval?.stages?.[stageNum]
          }, null, 2));
        } else {
          console.log(`Revoked approval for Stage ${stageNum} of workstream "${updatedStream.name}"`);
          if (cliArgs.reason) {
            console.log(`  Reason: ${cliArgs.reason}`);
          }
        }
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
      return;
    }
    const stageStatus = getStageApprovalStatus(stream, stageNum);
    if (stageStatus === "approved" && !cliArgs.force) {
      if (cliArgs.json) {
        console.log(JSON.stringify({
          action: "already_approved",
          scope: "stage",
          stage: stageNum,
          streamId: stream.id,
          approval: stream.approval?.stages?.[stageNum]
        }, null, 2));
      } else {
        console.log(`Stage ${stageNum} of workstream "${stream.name}" is already approved`);
      }
      return;
    }
    if (!cliArgs.force) {
      const allTasks = getTasks(repoRoot, stream.id);
      const stageTasks = allTasks.filter((t) => {
        try {
          const parsed = parseTaskId(t.id);
          return parsed.stage === stageNum;
        } catch {
          return false;
        }
      });
      const incompleteTasks = stageTasks.filter((t) => t.status !== "completed" && t.status !== "cancelled");
      const incompleteThreads = new Map;
      incompleteTasks.forEach((t) => {
        try {
          const parsed = parseTaskId(t.id);
          const threadId = `${parsed.stage.toString().padStart(2, "0")}.${parsed.batch.toString().padStart(2, "0")}.${parsed.thread.toString().padStart(2, "0")}`;
          if (!incompleteThreads.has(threadId)) {
            incompleteThreads.set(threadId, {
              count: 0,
              name: t.thread_name || `Thread ${parsed.thread}`
            });
          }
          const threadInfo = incompleteThreads.get(threadId);
          threadInfo.count++;
        } catch {}
      });
      if (incompleteThreads.size > 0) {
        if (cliArgs.json) {
          console.log(JSON.stringify({
            action: "blocked",
            scope: "stage",
            stage: stageNum,
            streamId: stream.id,
            reason: "incomplete_tasks",
            incompleteThreadCount: incompleteThreads.size,
            incompleteTaskCount: incompleteTasks.length,
            incompleteThreads: Array.from(incompleteThreads.entries()).map(([id, info]) => ({
              id,
              name: info.name,
              incompleteTasks: info.count
            }))
          }, null, 2));
        } else {
          console.error(`Error: Cannot approve Stage ${stageNum} because ${incompleteThreads.size} thread(s) are not approved.`);
          console.log(`
Incomplete threads:`);
          const sortedThreads = Array.from(incompleteThreads.entries()).sort((a, b2) => a[0].localeCompare(b2[0]));
          for (const [threadId, info] of sortedThreads) {
            console.log(`  - ${threadId} (${info.name}): ${info.count} task(s) remaining`);
          }
          console.log(`
Use --force to approve anyway.`);
        }
        process.exit(1);
      }
    }
    try {
      const updatedStream = approveStage(repoRoot, stream.id, stageNum, "user");
      let commitResult;
      const githubConfig = await loadGitHubConfig(repoRoot);
      if (githubConfig.enabled && githubConfig.auto_commit_on_approval) {
        const stageName = `Stage ${stageNum}`;
        commitResult = createStageApprovalCommit(repoRoot, updatedStream, stageNum, stageName);
      }
      let issueCloseResult;
      if (cliArgs.closeIssue) {
        const workstreamGitHub = await loadWorkstreamGitHub(repoRoot, updatedStream.id);
        if (workstreamGitHub) {
          const stageId = stageNum.toString().padStart(2, "0");
          const stageIssue = workstreamGitHub.stages[stageId];
          if (stageIssue && stageIssue.state === "open") {
            try {
              await closeStageIssue(repoRoot, stageIssue.issue_number);
              updateStageIssueState(workstreamGitHub, stageId, "closed", new Date().toISOString());
              await saveWorkstreamGitHub(repoRoot, updatedStream.id, workstreamGitHub);
              issueCloseResult = {
                closed: true,
                issueNumber: stageIssue.issue_number,
                issueUrl: stageIssue.issue_url
              };
            } catch (error) {
              issueCloseResult = {
                closed: false,
                error: error.message
              };
            }
          } else if (stageIssue && stageIssue.state === "closed") {
            issueCloseResult = {
              closed: false,
              error: "Issue already closed"
            };
          } else {
            issueCloseResult = {
              closed: false,
              error: "No GitHub issue found for this stage"
            };
          }
        } else {
          issueCloseResult = {
            closed: false,
            error: "No GitHub tracking file found for this workstream"
          };
        }
      }
      if (cliArgs.json) {
        console.log(JSON.stringify({
          action: "approved",
          scope: "stage",
          stage: stageNum,
          streamId: updatedStream.id,
          approval: updatedStream.approval?.stages?.[stageNum],
          commit: commitResult ? {
            created: commitResult.success && !commitResult.skipped,
            sha: commitResult.commitSha,
            skipped: commitResult.skipped,
            error: commitResult.error
          } : undefined,
          issue: issueCloseResult ? {
            closed: issueCloseResult.closed,
            issueNumber: issueCloseResult.issueNumber,
            issueUrl: issueCloseResult.issueUrl,
            error: issueCloseResult.error
          } : undefined
        }, null, 2));
      } else {
        console.log(`Approved Stage ${stageNum} of workstream "${updatedStream.name}"`);
        if (commitResult?.success && commitResult.commitSha) {
          console.log(`  Committed: ${commitResult.commitSha.substring(0, 7)}`);
        } else if (commitResult?.skipped) {
          console.log(`  No changes to commit`);
        } else if (commitResult?.error) {
          console.log(`  Commit skipped: ${commitResult.error}`);
        }
        if (issueCloseResult) {
          if (issueCloseResult.closed) {
            console.log(`  Issue closed: #${issueCloseResult.issueNumber} (${issueCloseResult.issueUrl})`);
          } else if (issueCloseResult.error) {
            console.log(`  Issue not closed: ${issueCloseResult.error}`);
          }
        }
      }
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }
  if (cliArgs.revoke) {
    const currentStatus2 = getApprovalStatus(stream);
    if (currentStatus2 === "draft") {
      console.error("Error: Plan is not approved, nothing to revoke");
      process.exit(1);
    }
    try {
      const updatedStream = revokeApproval(repoRoot, stream.id, cliArgs.reason);
      if (cliArgs.json) {
        console.log(JSON.stringify({
          action: "revoked",
          target: "plan",
          streamId: updatedStream.id,
          streamName: updatedStream.name,
          reason: cliArgs.reason,
          approval: updatedStream.approval
        }, null, 2));
      } else {
        console.log(`Revoked plan approval for workstream "${updatedStream.name}" (${updatedStream.id})`);
        if (cliArgs.reason) {
          console.log(`  Reason: ${cliArgs.reason}`);
        }
      }
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }
  const currentStatus = getApprovalStatus(stream);
  if (currentStatus === "approved") {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "already_approved",
        target: "plan",
        streamId: stream.id,
        streamName: stream.name,
        approval: stream.approval
      }, null, 2));
    } else {
      console.log(`Plan for workstream "${stream.name}" is already approved`);
      console.log(`  Status: ${formatApprovalStatus(stream)}`);
    }
    return;
  }
  const questionsResult = checkOpenQuestions(repoRoot, stream.id);
  if (questionsResult.hasOpenQuestions && !cliArgs.force) {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "blocked",
        target: "plan",
        reason: "open_questions",
        streamId: stream.id,
        streamName: stream.name,
        openQuestions: questionsResult.questions,
        openCount: questionsResult.openCount,
        resolvedCount: questionsResult.resolvedCount
      }, null, 2));
    } else {
      console.error("Error: Cannot approve plan with open questions");
      console.error("");
      console.error(`Found ${questionsResult.openCount} open question(s):`);
      for (const q2 of questionsResult.questions) {
        console.error(`  Stage ${q2.stage} (${q2.stageName}): ${q2.question}`);
      }
      console.error("");
      console.error("Options:");
      console.error("  1. Resolve questions in PLAN.md (mark with [x])");
      console.error("  2. Use --force to approve anyway");
    }
    process.exit(1);
  }
  if (questionsResult.hasOpenQuestions && cliArgs.force) {
    console.log(`Warning: Approving with ${questionsResult.openCount} open question(s)`);
  }
  try {
    const updatedStream = approveStream(repoRoot, stream.id, "user");
    const tasksMdResult = generateTasksMdAfterApproval(repoRoot, updatedStream.id, updatedStream.name);
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "approved",
        target: "plan",
        streamId: updatedStream.id,
        streamName: updatedStream.name,
        approval: updatedStream.approval,
        openQuestions: questionsResult.hasOpenQuestions ? questionsResult.openCount : 0,
        forcedApproval: questionsResult.hasOpenQuestions && cliArgs.force,
        tasksMd: {
          generated: tasksMdResult.success,
          path: tasksMdResult.path,
          overwritten: tasksMdResult.overwritten,
          error: tasksMdResult.error
        }
      }, null, 2));
    } else {
      console.log(`Approved plan for workstream "${updatedStream.name}" (${updatedStream.id})`);
      console.log(`  Status: ${formatApprovalStatus(updatedStream)}`);
      if (tasksMdResult.success) {
        if (tasksMdResult.overwritten) {
          console.log(`  Warning: Overwrote existing TASKS.md`);
        }
        console.log(`  TASKS.md generated at ${tasksMdResult.path}`);
      } else {
        console.log(`  Warning: Failed to generate TASKS.md: ${tasksMdResult.error}`);
      }
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

// src/cli/approve/tasks.ts
import { existsSync as existsSync19, readFileSync as readFileSync19, unlinkSync } from "fs";
import { join as join20 } from "path";
init_tasks_md();
init_repo();
init_tasks();

// src/lib/prompts.ts
init_repo();
init_stream_parser();
init_tasks();
import { existsSync as existsSync18, readFileSync as readFileSync18, mkdirSync as mkdirSync3, writeFileSync as writeFileSync7 } from "fs";
import { join as join19, dirname as dirname5 } from "path";
function parseThreadId2(threadIdStr) {
  const parts = threadIdStr.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const parsed = parts.map((p) => parseInt(p, 10));
  if (parsed.some(isNaN)) {
    return null;
  }
  return {
    stage: parsed[0],
    batch: parsed[1],
    thread: parsed[2]
  };
}
function formatThreadId2(stage, batch, thread) {
  const stageStr = stage.toString().padStart(2, "0");
  const batchStr = batch.toString().padStart(2, "0");
  const threadStr = thread.toString().padStart(2, "0");
  return `${stageStr}.${batchStr}.${threadStr}`;
}
function getPromptContext(repoRoot, streamId, threadIdStr) {
  const threadId = parseThreadId2(threadIdStr);
  if (!threadId) {
    throw new Error(`Invalid thread ID format: "${threadIdStr}". Expected "stage.batch.thread" (e.g., "01.01.02")`);
  }
  const workDir = getWorkDir(repoRoot);
  const planPath = join19(workDir, streamId, "PLAN.md");
  if (!existsSync18(planPath)) {
    throw new Error(`PLAN.md not found at ${planPath}`);
  }
  const planContent = readFileSync18(planPath, "utf-8");
  const errors = [];
  const doc = parseStreamDocument(planContent, errors);
  if (!doc) {
    throw new Error(`Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`);
  }
  const stage = doc.stages.find((s) => s.id === threadId.stage);
  if (!stage) {
    const availableStages = doc.stages.map((s) => s.id).join(", ");
    throw new Error(`Stage ${threadId.stage} not found. Available stages: ${availableStages || "none"}`);
  }
  const batch = stage.batches.find((b2) => b2.id === threadId.batch);
  if (!batch) {
    const availableBatches = stage.batches.map((b2) => `${b2.prefix} (${b2.name})`).join(", ");
    throw new Error(`Batch ${threadId.batch} not found in stage ${threadId.stage}. Available batches: ${availableBatches || "none"}`);
  }
  const thread = batch.threads.find((t) => t.id === threadId.thread);
  if (!thread) {
    const availableThreads = batch.threads.map((t) => `${t.id} (${t.name})`).join(", ");
    throw new Error(`Thread ${threadId.thread} not found in batch ${batch.prefix}. Available threads: ${availableThreads || "none"}`);
  }
  const parallelThreads = batch.threads.filter((t) => t.id !== threadId.thread);
  const allTasks = getTasks(repoRoot, streamId);
  const threadPrefix = `${threadId.stage.toString().padStart(2, "0")}.${threadId.batch.toString().padStart(2, "0")}.${threadId.thread.toString().padStart(2, "0")}.`;
  const tasks = allTasks.filter((t) => t.id.startsWith(threadPrefix));
  const assignedAgent = tasks.find((t) => t.assigned_agent)?.assigned_agent;
  const agentName = assignedAgent;
  return {
    threadId,
    threadIdString: threadIdStr,
    streamId,
    streamName: doc.streamName,
    thread,
    stage,
    batch,
    tasks,
    parallelThreads,
    agentName
  };
}
function generateThreadPrompt(context, options) {
  const opts = {
    includeTests: true,
    includeParallel: true,
    ...options
  };
  const lines = [];
  lines.push(`Hello Agent!`);
  lines.push("");
  lines.push(`You are working on the "${context.batch.name}" batch at the "${context.stage.name}" stage of the "${context.streamName}" workstream.`);
  lines.push("");
  lines.push("This is your thread:");
  lines.push("");
  lines.push(`"${context.thread.name}" (${context.thread.id})`);
  lines.push("");
  lines.push("## Thread Summary");
  lines.push(context.thread.summary || "(No summary provided)");
  lines.push("");
  lines.push("## Thread Details");
  lines.push(context.thread.details || "(No details provided)");
  lines.push("");
  lines.push("Your tasks are:");
  if (context.tasks.length > 0) {
    for (const task of context.tasks) {
      lines.push(`- [ ] ${task.id} ${task.name}`);
    }
  } else {
    lines.push("(No tasks found for this thread)");
  }
  lines.push("");
  const batchId = `${context.stage.id.toString().padStart(2, "0")}.${context.batch.id.toString().padStart(2, "0")}`;
  lines.push(`When listing tasks, use \`work list --tasks --batch "${batchId}"\` to see tasks for this batch only.`);
  lines.push("");
  lines.push("Use the `implementing-workstreams` skill.");
  lines.push("");
  return lines.join(`
`);
}
function generateThreadPromptJson(context) {
  return {
    threadId: context.threadIdString,
    agentName: context.agentName,
    stream: {
      id: context.streamId,
      name: context.streamName
    },
    location: {
      stage: {
        id: context.stage.id,
        name: context.stage.name
      },
      batch: {
        id: context.batch.id,
        prefix: context.batch.prefix,
        name: context.batch.name
      },
      thread: {
        id: context.thread.id,
        name: context.thread.name
      }
    },
    thread: {
      summary: context.thread.summary,
      details: context.thread.details
    },
    tasks: context.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      breadcrumb: t.breadcrumb
    })),
    stageContext: {
      definition: context.stage.definition,
      constitution: context.stage.constitution
    },
    parallelThreads: context.parallelThreads.map((t) => ({
      id: t.id,
      name: t.name,
      summary: t.summary
    }))
  };
}
function getPromptRelativePath(context) {
  const safeStageName = context.stage.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const safeBatchName = context.batch.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const safeThreadName = context.thread.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const stagePrefix = context.stage.id.toString().padStart(2, "0");
  return join19(context.streamId, "prompts", `${stagePrefix}-${safeStageName}`, `${context.batch.prefix}-${safeBatchName}`, `${safeThreadName}.md`);
}
function savePromptToFile(repoRoot, context, content) {
  const workDir = getWorkDir(repoRoot);
  const relPath = getPromptRelativePath(context);
  const fullPath = join19(workDir, relPath);
  try {
    mkdirSync3(dirname5(fullPath), { recursive: true });
    writeFileSync7(fullPath, content);
    return relPath;
  } catch (e) {
    return null;
  }
}
function generateAllPrompts(repoRoot, streamId) {
  const result = {
    success: true,
    generatedFiles: [],
    errors: [],
    totalThreads: 0
  };
  const workDir = getWorkDir(repoRoot);
  const planPath = join19(workDir, streamId, "PLAN.md");
  if (!existsSync18(planPath)) {
    result.success = false;
    result.errors.push(`PLAN.md not found at ${planPath}`);
    return result;
  }
  const planContent = readFileSync18(planPath, "utf-8");
  const parseErrors = [];
  const doc = parseStreamDocument(planContent, parseErrors);
  if (!doc) {
    result.success = false;
    result.errors.push(`Failed to parse PLAN.md: ${parseErrors.map((e) => e.message).join(", ")}`);
    return result;
  }
  for (const stage of doc.stages) {
    for (const batch of stage.batches) {
      for (const thread of batch.threads) {
        result.totalThreads++;
        const threadIdStr = formatThreadId2(stage.id, batch.id, thread.id);
        try {
          const context = getPromptContext(repoRoot, streamId, threadIdStr);
          const prompt = generateThreadPrompt(context);
          const savedPath = savePromptToFile(repoRoot, context, prompt);
          if (savedPath) {
            result.generatedFiles.push(savedPath);
          } else {
            result.errors.push(`Failed to save prompt for thread ${threadIdStr}`);
          }
        } catch (e) {
          result.errors.push(`Error generating prompt for thread ${threadIdStr}: ${e.message}`);
        }
      }
    }
  }
  if (result.errors.length > 0) {
    result.success = false;
  }
  return result;
}

// src/cli/approve/tasks.ts
function serializeTasksMdToJson(repoRoot, streamId) {
  try {
    const workDir = getWorkDir(repoRoot);
    const tasksMdPath = join20(workDir, streamId, "TASKS.md");
    const tasksJsonPath = join20(workDir, streamId, "tasks.json");
    if (!existsSync19(tasksMdPath)) {
      return {
        success: false,
        taskCount: 0,
        error: `TASKS.md not found at ${tasksMdPath}`
      };
    }
    const content = readFileSync19(tasksMdPath, "utf-8");
    const { tasks, errors } = parseTasksMd(content, streamId);
    if (errors.length > 0) {
      return {
        success: false,
        taskCount: 0,
        error: `TASKS.md parsing errors: ${errors.join(", ")}`
      };
    }
    if (tasks.length === 0) {
      return {
        success: false,
        taskCount: 0,
        error: "TASKS.md contains no valid tasks"
      };
    }
    addTasks(repoRoot, streamId, tasks);
    return {
      success: true,
      taskCount: tasks.length,
      tasksJsonPath
    };
  } catch (e) {
    return {
      success: false,
      taskCount: 0,
      error: e.message
    };
  }
}
function deleteTasksMd(repoRoot, streamId) {
  try {
    const workDir = getWorkDir(repoRoot);
    const tasksMdPath = join20(workDir, streamId, "TASKS.md");
    if (existsSync19(tasksMdPath)) {
      unlinkSync(tasksMdPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
function handleTasksApproval(repoRoot, stream, cliArgs) {
  const currentStatus = getTasksApprovalStatus(stream);
  if (cliArgs.revoke) {
    if (currentStatus !== "approved") {
      console.error("Error: Tasks are not approved, nothing to revoke");
      process.exit(1);
    }
    try {
      const updatedStream = revokeTasksApproval(repoRoot, stream.id, cliArgs.reason);
      if (cliArgs.json) {
        console.log(JSON.stringify({
          action: "revoked",
          target: "tasks",
          streamId: updatedStream.id,
          streamName: updatedStream.name,
          reason: cliArgs.reason,
          approval: updatedStream.approval?.tasks
        }, null, 2));
      } else {
        console.log(`Revoked tasks approval for workstream "${updatedStream.name}" (${updatedStream.id})`);
        if (cliArgs.reason) {
          console.log(`  Reason: ${cliArgs.reason}`);
        }
      }
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }
  if (currentStatus === "approved") {
    const tasksMdDeleted = deleteTasksMd(repoRoot, stream.id);
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "already_approved",
        target: "tasks",
        streamId: stream.id,
        streamName: stream.name,
        approval: stream.approval?.tasks,
        artifacts: {
          tasksMdDeleted
        }
      }, null, 2));
    } else {
      console.log(`Tasks for workstream "${stream.name}" are already approved`);
      if (tasksMdDeleted) {
        console.log(`  Cleaned up leftover TASKS.md`);
      }
    }
    return;
  }
  const readyCheck = checkTasksApprovalReady(repoRoot, stream.id);
  if (!readyCheck.ready) {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "blocked",
        target: "tasks",
        reason: readyCheck.reason,
        streamId: stream.id,
        streamName: stream.name
      }, null, 2));
    } else {
      console.error(`Error: ${readyCheck.reason}`);
    }
    process.exit(1);
  }
  const serializeResult = serializeTasksMdToJson(repoRoot, stream.id);
  if (!serializeResult.success) {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "blocked",
        target: "tasks",
        reason: "serialization_failed",
        error: serializeResult.error,
        streamId: stream.id,
        streamName: stream.name
      }, null, 2));
    } else {
      console.error(`Error: Failed to serialize TASKS.md to tasks.json`);
      console.error(`  ${serializeResult.error}`);
    }
    process.exit(1);
  }
  const promptsResult = generateAllPrompts(repoRoot, stream.id);
  const promptsWarning = !promptsResult.success;
  try {
    const updatedStream = approveTasks(repoRoot, stream.id);
    const tasksMdDeleted = deleteTasksMd(repoRoot, stream.id);
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "approved",
        target: "tasks",
        streamId: updatedStream.id,
        streamName: updatedStream.name,
        taskCount: serializeResult.taskCount,
        approval: updatedStream.approval?.tasks,
        artifacts: {
          tasksJson: {
            generated: true,
            path: serializeResult.tasksJsonPath,
            taskCount: serializeResult.taskCount
          },
          tasksMdDeleted
        }
      }, null, 2));
    } else {
      console.log(`Tasks approved. tasks.json and prompts generated.`);
      console.log(`  Task count: ${serializeResult.taskCount}`);
      console.log(`  tasks.json: ${serializeResult.tasksJsonPath}`);
      console.log(`  Prompts: ${promptsResult.generatedFiles.length}/${promptsResult.totalThreads} generated`);
      if (tasksMdDeleted) {
        console.log(`  TASKS.md deleted`);
      }
      if (promptsWarning) {
        console.log(`  Warning: Some prompts failed to generate:`);
        for (const err of promptsResult.errors.slice(0, 3)) {
          console.log(`    - ${err}`);
        }
        if (promptsResult.errors.length > 3) {
          console.log(`    ... and ${promptsResult.errors.length - 3} more errors`);
        }
      }
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

// src/cli/approve/revision.ts
import { existsSync as existsSync20, readFileSync as readFileSync20 } from "fs";
import { join as join21 } from "path";
init_tasks_md();
init_stream_parser();
init_repo();
init_lib();
init_tasks();
function handleRevisionApproval(repoRoot, stream, cliArgs) {
  const workDir = getWorkDir(repoRoot);
  const streamDir = join21(workDir, stream.id);
  const planMdPath = join21(streamDir, "PLAN.md");
  const tasksMdPath = join21(streamDir, "TASKS.md");
  if (!existsSync20(planMdPath)) {
    console.error(`Error: PLAN.md not found at ${planMdPath}`);
    process.exit(1);
  }
  const planContent = readFileSync20(planMdPath, "utf-8");
  const errors = [];
  const doc = parseStreamDocument(planContent, errors);
  if (!doc) {
    console.error(`Error: Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`);
    process.exit(1);
  }
  const existingTasks = getTasks(repoRoot, stream.id);
  const newStageNumbers = detectNewStages(doc, existingTasks);
  if (newStageNumbers.length === 0) {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "blocked",
        target: "revision",
        reason: "no_new_stages",
        streamId: stream.id,
        streamName: stream.name
      }, null, 2));
    } else {
      console.error("Error: No new stages to approve");
    }
    process.exit(1);
  }
  const questionsResult = checkOpenQuestions(repoRoot, stream.id);
  if (questionsResult.hasOpenQuestions && !cliArgs.force) {
    const newStageSet2 = new Set(newStageNumbers);
    const newStageQuestions = questionsResult.questions.filter((q2) => newStageSet2.has(q2.stage));
    if (newStageQuestions.length > 0) {
      if (cliArgs.json) {
        console.log(JSON.stringify({
          action: "blocked",
          target: "revision",
          reason: "open_questions_in_new_stages",
          streamId: stream.id,
          streamName: stream.name,
          openQuestions: newStageQuestions,
          openCount: newStageQuestions.length
        }, null, 2));
      } else {
        console.error("Error: Cannot approve revision with open questions in new stages");
        console.error("");
        console.error(`Found ${newStageQuestions.length} open question(s) in new stages:`);
        for (const q2 of newStageQuestions) {
          console.error(`  Stage ${q2.stage} (${q2.stageName}): ${q2.question}`);
        }
        console.error("");
        console.error("Options:");
        console.error("  1. Resolve questions in PLAN.md (mark with [x])");
        console.error("  2. Use --force to approve anyway");
      }
      process.exit(1);
    }
  }
  const tasksMdContent = generateTasksMdForRevision(stream.name, existingTasks, doc, newStageNumbers);
  atomicWriteFile(tasksMdPath, tasksMdContent);
  let newPlaceholderCount = 0;
  const newStageSet = new Set(newStageNumbers);
  for (const stage of doc.stages) {
    if (newStageSet.has(stage.id)) {
      for (const batch of stage.batches) {
        newPlaceholderCount += batch.threads.length;
      }
    }
  }
  if (cliArgs.json) {
    console.log(JSON.stringify({
      action: "generated",
      target: "revision",
      streamId: stream.id,
      streamName: stream.name,
      existingTaskCount: existingTasks.length,
      newStageCount: newStageNumbers.length,
      newPlaceholderCount,
      newStages: newStageNumbers,
      tasksMdPath
    }, null, 2));
  } else {
    console.log(`Generated TASKS.md with ${existingTasks.length} existing tasks and ${newPlaceholderCount} new task placeholders`);
    console.log("");
    console.log(`New stages: ${newStageNumbers.map((n) => `Stage ${n}`).join(", ")}`);
    console.log("");
    console.log("Edit TASKS.md to add task details and assign agents, then run 'work approve tasks'");
  }
}

// src/cli/approve/index.ts
function printHelp22() {
  console.log(`
work approve - Human-in-the-loop approval gates for workstreams

Requires: USER role

Usage:
  work approve plan [--stream <id>] [--force]
  work approve tasks [--stream <id>]
  work approve revision [--stream <id>]
  work approve [--stream <id>]  # Show status of all approvals

Targets:
  plan      Approve the PLAN.md structure (blocks if open questions exist)
  tasks     Approve tasks (requires TASKS.md with tasks)
  revision  Approve revised PLAN.md with new stages (generates TASKS.md)

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --stage, -st     Stage number to approve/revoke (only for plan approval)
  --revoke         Revoke existing approval
  --reason         Reason for revoking approval
  --force, -f      Approve even with validation warnings
  --close-issue    Close GitHub issue for stage on approval (stage approval only)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Workstreams require 3 approvals before starting:
  1. Plan approval - validates PLAN.md structure, no open questions
  2. Tasks approval - ensures tasks.json exists with tasks

  Run 'work start' after all 3 approvals to create the GitHub branch and issues.

  Note: This command requires USER role to maintain human-in-the-loop control.
  Set WORKSTREAM_ROLE=USER environment variable to enable approval commands.

Examples:
  # Show approval status
  work approve

  # Approve plan
  work approve plan

  # Approve tasks
  work approve tasks


  # Revoke plan approval
  work approve plan --revoke --reason "Need to revise stage 2"

  # Approve specific stage
  work approve stage 1
`);
}
function parseCliArgs22(argv) {
  const args = argv.slice(2);
  const parsed = { revoke: false, force: false, json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "plan" || arg === "tasks" || arg === "revision") {
      parsed.target = arg;
      continue;
    }
    if (arg === "stage") {
      parsed.target = "plan";
      if (!next) {
        console.error("Error: stage requires a stage number");
        return null;
      }
      parsed.stage = parseInt(next, 10);
      if (isNaN(parsed.stage)) {
        console.error("Error: stage must be a number");
        return null;
      }
      i++;
      continue;
    }
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--revoke":
        parsed.revoke = true;
        break;
      case "--reason":
        if (!next) {
          console.error("Error: --reason requires a value");
          return null;
        }
        parsed.reason = next;
        i++;
        break;
      case "--force":
      case "-f":
        parsed.force = true;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--stage":
      case "-st":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        parsed.stage = parseInt(next, 10);
        if (isNaN(parsed.stage)) {
          console.error("Error: --stage must be a number");
          return null;
        }
        i++;
        break;
      case "--close-issue":
        parsed.closeIssue = true;
        break;
      case "--help":
      case "-h":
        printHelp22();
        process.exit(0);
    }
  }
  return parsed;
}
async function main22(argv = process.argv) {
  const cliArgs = parseCliArgs22(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!canExecuteCommand("approve")) {
    console.error(getRoleDenialMessage("approve"));
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!cliArgs.target) {
    if (cliArgs.revoke) {
      cliArgs.target = "plan";
    } else {
      const fullStatus = getFullApprovalStatus(stream);
      if (cliArgs.json) {
        console.log(JSON.stringify({
          streamId: stream.id,
          streamName: stream.name,
          ...fullStatus
        }, null, 2));
      } else {
        console.log(`Approval Status for "${stream.name}" (${stream.id})
`);
        console.log(`  ${formatApprovalIcon2(fullStatus.plan)} Plan:    ${fullStatus.plan}`);
        console.log(`  ${formatApprovalIcon2(fullStatus.tasks)} Tasks:   ${fullStatus.tasks}`);
        console.log("");
        if (fullStatus.fullyApproved) {
          console.log("All approvals complete. Run 'work start' to begin.");
        } else {
          console.log("Pending approvals. Run 'work approve <target>' to approve.");
        }
      }
      return;
    }
  }
  switch (cliArgs.target) {
    case "plan":
      await handlePlanApproval(repoRoot, stream, cliArgs);
      break;
    case "tasks":
      handleTasksApproval(repoRoot, stream, cliArgs);
      break;
    case "revision":
      handleRevisionApproval(repoRoot, stream, cliArgs);
      break;
  }
}
if (false) {}

// src/cli/multi.ts
init_repo();
init_lib();
import { existsSync as existsSync29, readFileSync as readFileSync27 } from "fs";

// src/lib/agents-yaml.ts
import { existsSync as existsSync21, readFileSync as readFileSync21, writeFileSync as writeFileSync8, mkdirSync as mkdirSync4 } from "fs";
import { join as join22, dirname as dirname6 } from "path";

// ../../node_modules/.bun/yaml@2.8.2/node_modules/yaml/dist/index.js
var composer = require_composer();
var Document = require_Document();
var Schema = require_Schema();
var errors = require_errors();
var Alias = require_Alias();
var identity = require_identity();
var Pair = require_Pair();
var Scalar = require_Scalar();
var YAMLMap = require_YAMLMap();
var YAMLSeq = require_YAMLSeq();
var cst = require_cst();
var lexer = require_lexer();
var lineCounter = require_line_counter();
var parser = require_parser();
var publicApi = require_public_api();
var visit = require_visit();
var $Composer = composer.Composer;
var $Document = Document.Document;
var $Schema = Schema.Schema;
var $YAMLError = errors.YAMLError;
var $YAMLParseError = errors.YAMLParseError;
var $YAMLWarning = errors.YAMLWarning;
var $Alias = Alias.Alias;
var $isAlias = identity.isAlias;
var $isCollection = identity.isCollection;
var $isDocument = identity.isDocument;
var $isMap = identity.isMap;
var $isNode = identity.isNode;
var $isPair = identity.isPair;
var $isScalar = identity.isScalar;
var $isSeq = identity.isSeq;
var $Pair = Pair.Pair;
var $Scalar = Scalar.Scalar;
var $YAMLMap = YAMLMap.YAMLMap;
var $YAMLSeq = YAMLSeq.YAMLSeq;
var $Lexer = lexer.Lexer;
var $LineCounter = lineCounter.LineCounter;
var $Parser = parser.Parser;
var $parse = publicApi.parse;
var $parseAllDocuments = publicApi.parseAllDocuments;
var $parseDocument = publicApi.parseDocument;
var $stringify = publicApi.stringify;
var $visit = visit.visit;
var $visitAsync = visit.visitAsync;

// src/lib/agents-yaml.ts
init_repo();

// src/lib/agents.ts
function isValidModelFormat(model) {
  return model.includes("/");
}

// src/lib/agents-yaml.ts
function getAgentsYamlPath(repoRoot) {
  return join22(getWorkDir(repoRoot), "agents.yaml");
}
function normalizeModelSpec(spec) {
  if (typeof spec === "string") {
    return { model: spec };
  }
  return { model: spec.model, variant: spec.variant };
}
function parseAgentsYaml(content) {
  const errors2 = [];
  try {
    const parsed = $parse(content);
    if (!parsed || typeof parsed !== "object") {
      errors2.push("Invalid YAML: expected object at root");
      return { config: null, errors: errors2 };
    }
    if (!Array.isArray(parsed.agents)) {
      errors2.push("Invalid YAML: expected 'agents' array at root");
      return { config: null, errors: errors2 };
    }
    const agents = [];
    for (let i = 0;i < parsed.agents.length; i++) {
      const agent = parsed.agents[i];
      const prefix = `Agent ${i + 1}`;
      if (!agent || typeof agent !== "object") {
        errors2.push(`${prefix}: expected object`);
        continue;
      }
      if (!agent.name || typeof agent.name !== "string") {
        errors2.push(`${prefix}: missing or invalid 'name'`);
        continue;
      }
      if (!agent.description || typeof agent.description !== "string") {
        errors2.push(`Agent "${agent.name}": missing or invalid 'description'`);
        continue;
      }
      if (!agent.best_for || typeof agent.best_for !== "string") {
        errors2.push(`Agent "${agent.name}": missing or invalid 'best_for'`);
        continue;
      }
      if (!Array.isArray(agent.models) || agent.models.length === 0) {
        errors2.push(`Agent "${agent.name}": 'models' must be a non-empty array`);
        continue;
      }
      const validModels = [];
      for (let j2 = 0;j2 < agent.models.length; j2++) {
        const model = agent.models[j2];
        let modelStr;
        if (typeof model === "string") {
          modelStr = model;
          validModels.push(model);
        } else if (model && typeof model === "object" && model.model) {
          modelStr = model.model;
          validModels.push({ model: model.model, variant: model.variant });
        } else {
          errors2.push(`Agent "${agent.name}": model ${j2 + 1} must be a string or object with 'model' field`);
          continue;
        }
        if (!isValidModelFormat(modelStr)) {
          errors2.push(`Agent "${agent.name}": model "${modelStr}" is not in provider/model format`);
        }
      }
      if (validModels.length === 0) {
        errors2.push(`Agent "${agent.name}": no valid models found`);
        continue;
      }
      agents.push({
        name: agent.name,
        description: agent.description,
        best_for: agent.best_for,
        models: validModels
      });
    }
    const synthesisAgents = [];
    if (parsed.synthesis_agents !== undefined) {
      if (!Array.isArray(parsed.synthesis_agents)) {
        errors2.push("Invalid YAML: 'synthesis_agents' must be an array if present");
      } else {
        for (let i = 0;i < parsed.synthesis_agents.length; i++) {
          const agent = parsed.synthesis_agents[i];
          const prefix = `Synthesis agent ${i + 1}`;
          if (!agent || typeof agent !== "object") {
            errors2.push(`${prefix}: expected object`);
            continue;
          }
          if (!agent.name || typeof agent.name !== "string") {
            errors2.push(`${prefix}: missing or invalid 'name'`);
            continue;
          }
          if (!agent.description || typeof agent.description !== "string") {
            errors2.push(`Synthesis agent "${agent.name}": missing or invalid 'description'`);
            continue;
          }
          if (!agent.best_for || typeof agent.best_for !== "string") {
            errors2.push(`Synthesis agent "${agent.name}": missing or invalid 'best_for'`);
            continue;
          }
          if (!Array.isArray(agent.models) || agent.models.length === 0) {
            errors2.push(`Synthesis agent "${agent.name}": 'models' must be a non-empty array`);
            continue;
          }
          const validModels = [];
          for (let j2 = 0;j2 < agent.models.length; j2++) {
            const model = agent.models[j2];
            let modelStr;
            if (typeof model === "string") {
              modelStr = model;
              validModels.push(model);
            } else if (model && typeof model === "object" && model.model) {
              modelStr = model.model;
              validModels.push({ model: model.model, variant: model.variant });
            } else {
              errors2.push(`Synthesis agent "${agent.name}": model ${j2 + 1} must be a string or object with 'model' field`);
              continue;
            }
            if (!isValidModelFormat(modelStr)) {
              errors2.push(`Synthesis agent "${agent.name}": model "${modelStr}" is not in provider/model format`);
            }
          }
          if (validModels.length === 0) {
            errors2.push(`Synthesis agent "${agent.name}": no valid models found`);
            continue;
          }
          synthesisAgents.push({
            name: agent.name,
            description: agent.description,
            best_for: agent.best_for,
            models: validModels
          });
        }
      }
    }
    const config2 = { agents };
    if (synthesisAgents.length > 0) {
      config2.synthesis_agents = synthesisAgents;
    }
    return { config: config2, errors: errors2 };
  } catch (e) {
    errors2.push(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
    return { config: null, errors: errors2 };
  }
}
function loadAgentsConfig(repoRoot) {
  const path = getAgentsYamlPath(repoRoot);
  if (!existsSync21(path)) {
    return null;
  }
  const content = readFileSync21(path, "utf-8");
  const { config: config2, errors: errors2 } = parseAgentsYaml(content);
  if (errors2.length > 0) {
    console.warn("Warnings parsing agents.yaml:", errors2.join(", "));
  }
  return config2;
}
function getAgentYaml(config2, name) {
  return config2.agents.find((a) => a.name === name) || null;
}
function getAgentModels(config2, agentName) {
  const agent = getAgentYaml(config2, agentName);
  if (!agent) {
    return [];
  }
  return agent.models.map(normalizeModelSpec);
}
function getSynthesisAgent(config2, name) {
  if (!config2.synthesis_agents) {
    return null;
  }
  return config2.synthesis_agents.find((a) => a.name === name) || null;
}
function getDefaultSynthesisAgent(config2) {
  if (!config2.synthesis_agents || config2.synthesis_agents.length === 0) {
    return null;
  }
  return config2.synthesis_agents[0];
}
function getSynthesisAgentModels(config2, agentName) {
  const agent = getSynthesisAgent(config2, agentName);
  if (!agent) {
    return [];
  }
  return agent.models.map(normalizeModelSpec);
}

// src/cli/multi.ts
init_tasks();

// src/lib/types.ts
var MAX_THREADS_PER_BATCH = 8;

// src/lib/tmux.ts
import { execSync as execSync6, spawn } from "child_process";
var THREAD_START_DELAY_MS = 3000;
function sleepWithCountdown(ms, label = "Waiting") {
  const seconds = Math.ceil(ms / 1000);
  for (let i = seconds;i > 0; i--) {
    process.stdout.write(`\r  ${label} ${i}s...`);
    Bun.sleepSync(1000);
  }
  process.stdout.write(`\r  ${label} done.   
`);
}
function sessionExists(name) {
  try {
    execSync6(`tmux has-session -t "${name}" 2>/dev/null`, {
      stdio: "pipe"
    });
    return true;
  } catch {
    return false;
  }
}
function createSession(sessionName, windowName, command) {
  const result = Bun.spawnSync([
    "tmux",
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-n",
    windowName,
    command
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create tmux session: ${result.stderr.toString()}`);
  }
}
function addWindow(sessionName, windowName, command) {
  const result = Bun.spawnSync([
    "tmux",
    "new-window",
    "-t",
    sessionName,
    "-n",
    windowName,
    command
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to add tmux window: ${result.stderr.toString()}`);
  }
}
function attachSession(sessionName) {
  const child = spawn("tmux", ["attach", "-t", sessionName], {
    stdio: "inherit"
  });
  return child;
}
function getWorkSessionName(streamId) {
  const maxLen = 20;
  const truncated = streamId.length > maxLen ? streamId.slice(0, maxLen) : streamId;
  return `work-${truncated}`;
}
function buildCreateSessionCommand(sessionName, windowName, command) {
  return `tmux new-session -d -s "${sessionName}" -n "${windowName}" "${command}"`;
}
function buildAddWindowCommand(sessionName, windowName, command) {
  return `tmux new-window -t "${sessionName}" -n "${windowName}" "${command}"`;
}
function buildAttachCommand(sessionName) {
  return `tmux attach -t "${sessionName}"`;
}
function setGlobalOption(sessionName, option, value) {
  const result = Bun.spawnSync([
    "tmux",
    "set-option",
    "-t",
    sessionName,
    option,
    value
  ]);
  if (result.exitCode !== 0) {
    console.warn(`Warning: Failed to set tmux option ${option}: ${result.stderr.toString()}`);
  }
}
function createGridLayout(sessionWindow, commands) {
  if (commands.length === 0) {
    throw new Error("createGridLayout requires at least 1 command");
  }
  if (commands.length === 1) {
    const paneIds = listPaneIds(sessionWindow);
    return paneIds.length > 0 ? [paneIds[0]] : [];
  }
  if (commands.length === 2) {
    const splitResult = Bun.spawnSync([
      "tmux",
      "split-window",
      "-t",
      sessionWindow,
      "-h",
      commands[1]
    ]);
    if (splitResult.exitCode !== 0) {
      throw new Error(`Failed to create 2-pane layout: ${splitResult.stderr.toString()}`);
    }
    sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger");
    return listPaneIds(sessionWindow);
  }
  Bun.spawnSync([
    "tmux",
    "split-window",
    "-t",
    `${sessionWindow}.0`,
    "-h",
    commands[1]
  ]);
  sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger");
  const panesAfterHSplit = listPaneIds(sessionWindow);
  const rightPaneId = panesAfterHSplit[1];
  Bun.spawnSync([
    "tmux",
    "split-window",
    "-t",
    `${sessionWindow}.0`,
    "-v",
    commands[2]
  ]);
  sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger");
  if (commands.length >= 4 && rightPaneId) {
    Bun.spawnSync([
      "tmux",
      "split-window",
      "-t",
      rightPaneId,
      "-v",
      commands[3]
    ]);
    sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger");
  }
  return listPaneIds(sessionWindow);
}
function respawnPane(paneId, command) {
  Bun.spawnSync(["tmux", "respawn-pane", "-t", paneId, "-k", command]);
}
function listPaneIds(sessionWindow) {
  try {
    const output = execSync6(`tmux list-panes -t "${sessionWindow}" -F "#{pane_id}"`, { stdio: "pipe", encoding: "utf-8" });
    return output.trim().split(`
`).filter(Boolean);
  } catch {
    return [];
  }
}
function selectPane(target) {
  Bun.spawnSync(["tmux", "select-pane", "-t", target]);
}
function getSessionPaneStatuses(sessionName) {
  try {
    const output = execSync6(`tmux list-panes -s -t "${sessionName}" -F "#{window_index}|#{pane_index}|#{pane_id}|#{pane_pid}|#{pane_title}|#{pane_dead}|#{pane_dead_status}"`, { stdio: "pipe", encoding: "utf-8" });
    return output.trim().split(`
`).filter(Boolean).map((line) => {
      const [windowIndex, paneIndex, paneId, panePid, paneTitle, paneDead, exitStatus] = line.split("|");
      return {
        paneId: paneId || "",
        windowIndex: parseInt(windowIndex || "0", 10),
        paneIndex: parseInt(paneIndex || "0", 10),
        panePid: panePid ? parseInt(panePid, 10) : null,
        paneTitle: paneTitle || "",
        paneDead: paneDead === "1",
        exitStatus: exitStatus ? parseInt(exitStatus, 10) : null
      };
    });
  } catch {
    return [];
  }
}

// src/lib/opencode.ts
import { spawn as spawn2 } from "child_process";
var DEFAULT_PORT = 4096;
var HEALTH_CHECK_INTERVAL_MS = 200;
var DEFAULT_TIMEOUT_MS = 30000;
async function isServerRunning(port = DEFAULT_PORT) {
  try {
    const response = await fetch(`http://localhost:${port}/`, {
      method: "GET",
      signal: AbortSignal.timeout(2000)
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}
function startServer(port = DEFAULT_PORT, cwd) {
  const child = spawn2("opencode", ["serve", "--port", String(port)], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.unref();
  return child;
}
async function waitForServer(port = DEFAULT_PORT, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const running = await isServerRunning(port);
    if (running) {
      return true;
    }
    await new Promise((resolve2) => setTimeout(resolve2, HEALTH_CHECK_INTERVAL_MS));
  }
  return false;
}
function truncateTitle(title, maxLen = 32) {
  if (title.length <= maxLen)
    return title;
  return title.slice(0, maxLen - 1) + "…";
}
function getCompletionMarkerPath(threadId) {
  return `/tmp/workstream-${threadId}-complete.txt`;
}
function getSessionFilePath(threadId) {
  return `/tmp/workstream-${threadId}-session.txt`;
}
function getSynthesisOutputPath(streamId, threadId) {
  return `/tmp/workstream-${streamId}-${threadId}-synthesis.txt`;
}
function getWorkingAgentSessionPath(streamId, threadId) {
  return `/tmp/workstream-${streamId}-${threadId}-working-session.txt`;
}
function getSynthesisLogPath(streamId, threadId) {
  return `/tmp/workstream-${streamId}-${threadId}-synthesis.log`;
}
function escapeForShell(str) {
  return str.replace(/'/g, "'\\''").replace(/"/g, "\\\"").replace(/\$/g, "\\$").replace(/`/g, "\\`");
}
function buildRunCommand(port, model, promptPath, threadTitle, variant, threadId) {
  const escapedPath = promptPath.replace(/'/g, "'\\''");
  const truncated = truncateTitle(threadTitle, 32);
  const escapedTitle = escapeForShell(truncated);
  const variantFlag = variant ? ` --variant "${variant}"` : "";
  const completionMarkerCmd = threadId ? `
echo "done" > "${getCompletionMarkerPath(threadId)}"` : "";
  const sessionFilePath = threadId ? getSessionFilePath(threadId) : "";
  const writeSessionCmd = threadId ? `
    echo "$SESSION_ID" > "${sessionFilePath}"` : "";
  return `sh -c '
TRACK_ID=$(date +%s%N | head -c 16)
TITLE="${escapedTitle}__id=$TRACK_ID"
echo "════════════════════════════════════════"
echo "Thread: ${escapedTitle}"
echo "Model: ${model}${variant ? ` (${variant})` : ""}"
echo "════════════════════════════════════════"
echo ""
cat "${escapedPath}" | opencode run --port ${port} --model "${model}"${variantFlag} --title "$TITLE"${completionMarkerCmd}
echo ""
echo "Thread finished. Looking for session to resume..."
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(opencode session list --max-count 20 --format json 2>/dev/null | jq -r ".[] | select(.title | contains(\\"__id=$TRACK_ID\\")) | .id" | head -1)
  if [ -n "$SESSION_ID" ]; then${writeSessionCmd}
    echo "Resuming session $SESSION_ID..."
    opencode --session "$SESSION_ID"
  else
    echo "Session not found. Press Enter to close."
    read
  fi
else
  echo "jq not found - install jq to enable session resume"
  echo "Press Enter to close."
  read
fi
'`;
}
var EARLY_FAILURE_THRESHOLD_SECONDS = 10;
function buildRetryRunCommand(port, models, promptPath, threadTitle, threadId) {
  if (models.length === 0) {
    throw new Error("At least one model must be provided");
  }
  if (models.length === 1) {
    const m2 = models[0];
    return buildRunCommand(port, m2.model, promptPath, threadTitle, m2.variant, threadId);
  }
  const escapedPath = promptPath.replace(/'/g, "'\\''");
  const truncated = truncateTitle(threadTitle, 32);
  const escapedTitle = escapeForShell(truncated);
  const modelAttempts = models.map((m2, i) => {
    const variantFlag = m2.variant ? ` --variant "${m2.variant}"` : "";
    const isLast = i === models.length - 1;
    if (i === 0) {
      return `
  START_TIME=$(date +%s)
  echo "Trying model ${i + 1}/${models.length}: ${m2.model}${m2.variant ? ` (variant: ${m2.variant})` : ""}"
  cat "${escapedPath}" | opencode run --port ${port} --model "${m2.model}"${variantFlag} --title "$TITLE"
  EXIT_CODE=$?
  ELAPSED=$(($(date +%s) - START_TIME))
  
  if [ $EXIT_CODE -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
    FINAL_EXIT=$EXIT_CODE
  else
    echo ""
    echo "Model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit code: $EXIT_CODE, elapsed: \${ELAPSED}s). Trying next model..."
  fi`;
    } else if (isLast) {
      return `
  if [ -z "$FINAL_EXIT" ]; then
    START_TIME=$(date +%s)
    echo "Trying model ${i + 1}/${models.length}: ${m2.model}${m2.variant ? ` (variant: ${m2.variant})` : ""}"
    cat "${escapedPath}" | opencode run --port ${port} --model "${m2.model}"${variantFlag} --title "$TITLE"
    FINAL_EXIT=$?
  fi`;
    } else {
      return `
  if [ -z "$FINAL_EXIT" ]; then
    START_TIME=$(date +%s)
    echo "Trying model ${i + 1}/${models.length}: ${m2.model}${m2.variant ? ` (variant: ${m2.variant})` : ""}"
    cat "${escapedPath}" | opencode run --port ${port} --model "${m2.model}"${variantFlag} --title "$TITLE"
    EXIT_CODE=$?
    ELAPSED=$(($(date +%s) - START_TIME))
    
    if [ $EXIT_CODE -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
      FINAL_EXIT=$EXIT_CODE
    else
      echo ""
      echo "Model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit code: $EXIT_CODE, elapsed: \${ELAPSED}s). Trying next model..."
    fi
  fi`;
    }
  }).join(`
`);
  const modelList = models.map((m2) => m2.variant ? `${m2.model} (${m2.variant})` : m2.model).join(" -> ");
  const completionMarkerCmd = threadId ? `echo "done" > "${getCompletionMarkerPath(threadId)}"` : "";
  const sessionFilePath = threadId ? getSessionFilePath(threadId) : "";
  const writeSessionCmd = threadId ? `
    echo "$SESSION_ID" > "${sessionFilePath}"` : "";
  return `sh -c '
TRACK_ID=$(date +%s%N | head -c 16)
TITLE="${escapedTitle}__id=$TRACK_ID"
FINAL_EXIT=""
echo "════════════════════════════════════════"
echo "Thread: ${escapedTitle}"
echo "Models: ${modelList}"
echo "════════════════════════════════════════"
echo ""
${modelAttempts}
${completionMarkerCmd}
echo ""
echo "Thread finished. Looking for session to resume..."
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(opencode session list --max-count 20 --format json 2>/dev/null | jq -r ".[] | select(.title | contains(\\"__id=$TRACK_ID\\")) | .id" | head -1)
  if [ -n "$SESSION_ID" ]; then${writeSessionCmd}
    echo "Resuming session $SESSION_ID..."
    opencode --session "$SESSION_ID"
  else
    echo "Session not found. Press Enter to close."
    read
  fi
else
  echo "jq not found - install jq to enable session resume"
  echo "Press Enter to close."
  read
fi
'`;
}
function buildPostSynthesisCommand(options) {
  const {
    port,
    workingModels,
    synthesisModels,
    promptPath,
    threadTitle,
    streamId,
    threadId
  } = options;
  if (workingModels.length === 0) {
    throw new Error("At least one working model must be provided");
  }
  if (synthesisModels.length === 0) {
    throw new Error("At least one synthesis model must be provided");
  }
  const escapedPath = promptPath.replace(/'/g, "'\\''");
  const truncated = truncateTitle(threadTitle, 32);
  const escapedTitle = escapeForShell(truncated);
  const completionMarkerPath = getCompletionMarkerPath(threadId);
  const sessionFilePath = getSessionFilePath(threadId);
  const exportedSessionPath = `/tmp/workstream-${streamId}-${threadId}-exported-session.json`;
  const extractedContextPath = `/tmp/workstream-${streamId}-${threadId}-context.txt`;
  const synthesisJsonPath = `/tmp/workstream-${streamId}-${threadId}-synthesis.json`;
  const synthesisLogPath = getSynthesisLogPath(streamId, threadId);
  const workingModelList = workingModels.map((m2) => m2.variant ? `${m2.model} (${m2.variant})` : m2.model).join(" -> ");
  const synthesisModelList = synthesisModels.map((m2) => m2.variant ? `${m2.model} (${m2.variant})` : m2.model).join(" -> ");
  const workingModelAttempts = buildPostSynthesisWorkingAgentAttempts(port, workingModels, escapedPath);
  const synthesisModelAttempts = buildPostSynthesisSynthesisAgentAttempts(port, synthesisModels, extractedContextPath, synthesisJsonPath);
  const jqExtractCommand = `jq -r ".messages[] | select(.info.role==\\"assistant\\") | .parts[] | select(.type==\\"text\\") | .text"`;
  return `sh -c '
WORK_TRACK_ID=$(date +%s%N | head -c 16)
WORK_TITLE="${escapedTitle}__work_id=$WORK_TRACK_ID"
WORK_FINAL_EXIT=""
SYNTH_FINAL_EXIT=""
echo "════════════════════════════════════════"
echo "Thread: ${escapedTitle}"
echo "Mode: Post-Session Synthesis"
echo "Working Models: ${workingModelList}"
echo "Synthesis Models: ${synthesisModelList}"
echo "════════════════════════════════════════"
echo ""

# Phase 1: Run working agent with full TUI
echo "▶ Phase 1: Running working agent..."
echo ""
${workingModelAttempts}

echo ""
echo "Working agent finished (exit: $WORK_FINAL_EXIT)."
echo ""

# Find working agent session ID by tracking ID
WORK_SESSION_ID=""
if command -v jq >/dev/null 2>&1; then
  WORK_SESSION_ID=$(opencode session list --max-count 20 --format json 2>/dev/null | jq -r ".[] | select(.title | contains(\\"__work_id=$WORK_TRACK_ID\\")) | .id" | head -1)
fi

if [ -z "$WORK_SESSION_ID" ]; then
  echo "Warning: Could not find working agent session ID."
  echo "Synthesis will run without session context."
else
  echo "Found working session: $WORK_SESSION_ID"
  
  # Export session to JSON
  echo "Exporting session..."
  opencode export "$WORK_SESSION_ID" > "${exportedSessionPath}" 2>/dev/null
  
  # Extract assistant text messages using jq
  echo "Extracting context..."
  ${jqExtractCommand} "${exportedSessionPath}" > "${extractedContextPath}" 2>/dev/null
fi

# Phase 2: Run synthesis agent headless
echo ""
echo "▶ Phase 2: Running synthesis agent (headless)..."
echo ""
${synthesisModelAttempts}

echo ""
echo "Synthesis complete."

# Log synthesis metadata
echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") Synthesis finished" >> "${synthesisLogPath}"
if [ -f "${synthesisJsonPath}" ]; then
  FILE_SIZE=$(wc -c < "${synthesisJsonPath}" 2>/dev/null || echo "0")
  echo "Synthesis output size: $FILE_SIZE bytes" >> "${synthesisLogPath}"
fi

# Write completion marker AFTER synthesis completes
# This ensures synthesis output is available when notification fires
echo "done" > "${completionMarkerPath}"

# Save working session ID for workstream tracking
if [ -n "$WORK_SESSION_ID" ]; then
  echo "$WORK_SESSION_ID" > "${sessionFilePath}"
fi

# Resume WORKING agent session (not synthesis)
echo ""
echo "Opening working session for review..."
if [ -n "$WORK_SESSION_ID" ]; then
  opencode --session "$WORK_SESSION_ID"
else
  echo "No working session available. Press Enter to close."
  read
fi
'`;
}
function buildPostSynthesisWorkingAgentAttempts(port, models, escapedPath) {
  return models.map((m2, i) => {
    const variantFlag = m2.variant ? ` --variant "${m2.variant}"` : "";
    const isLast = i === models.length - 1;
    if (i === 0) {
      return `
START_TIME=$(date +%s)
echo "Trying working model ${i + 1}/${models.length}: ${m2.model}${m2.variant ? ` (variant: ${m2.variant})` : ""}"
cat "${escapedPath}" | opencode run --port ${port} --model "${m2.model}"${variantFlag} --title "$WORK_TITLE"
WORK_EXIT=$?
ELAPSED=$(($(date +%s) - START_TIME))
if [ $WORK_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
  WORK_FINAL_EXIT=$WORK_EXIT
else
  echo ""
  echo "Working model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit: $WORK_EXIT). Trying next..."
fi`;
    } else if (isLast) {
      return `
if [ -z "$WORK_FINAL_EXIT" ]; then
  echo "Trying working model ${i + 1}/${models.length}: ${m2.model}${m2.variant ? ` (variant: ${m2.variant})` : ""}"
  cat "${escapedPath}" | opencode run --port ${port} --model "${m2.model}"${variantFlag} --title "$WORK_TITLE"
  WORK_FINAL_EXIT=$?
fi`;
    } else {
      return `
if [ -z "$WORK_FINAL_EXIT" ]; then
  START_TIME=$(date +%s)
  echo "Trying working model ${i + 1}/${models.length}: ${m2.model}${m2.variant ? ` (variant: ${m2.variant})` : ""}"
  cat "${escapedPath}" | opencode run --port ${port} --model "${m2.model}"${variantFlag} --title "$WORK_TITLE"
  WORK_EXIT=$?
  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $WORK_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
    WORK_FINAL_EXIT=$WORK_EXIT
  else
    echo ""
    echo "Working model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit: $WORK_EXIT). Trying next..."
  fi
fi`;
    }
  }).join(`
`);
}
function buildPostSynthesisSynthesisAgentAttempts(port, models, contextPath, outputJsonPath) {
  return models.map((m2, i) => {
    const variantFlag = m2.variant ? ` --variant "${m2.variant}"` : "";
    const isLast = i === models.length - 1;
    const synthCommand = `(echo "You are a synthesis agent reviewing a completed working agent session. Use the synthesizing-workstreams skill to continue"; echo ""; echo "## Working Agent Session Context"; echo ""; echo "The working agent session context follows below. Analyze it and provide your summary."; echo ""; cat "${contextPath}" 2>/dev/null || echo "(no context available)") | opencode run --port ${port} --model "${m2.model}"${variantFlag} --format json > "${outputJsonPath}" 2>&1`;
    if (i === 0) {
      return `
START_TIME=$(date +%s)
echo "Trying synthesis model ${i + 1}/${models.length}: ${m2.model}${m2.variant ? ` (variant: ${m2.variant})` : ""}"
${synthCommand}
SYNTH_EXIT=$?
ELAPSED=$(($(date +%s) - START_TIME))
if [ $SYNTH_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
  SYNTH_FINAL_EXIT=$SYNTH_EXIT
else
  echo ""
  echo "Synthesis model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit: $SYNTH_EXIT). Trying next..."
fi`;
    } else if (isLast) {
      return `
if [ -z "$SYNTH_FINAL_EXIT" ]; then
  echo "Trying synthesis model ${i + 1}/${models.length}: ${m2.model}${m2.variant ? ` (variant: ${m2.variant})` : ""}"
  ${synthCommand}
  SYNTH_FINAL_EXIT=$?
fi`;
    } else {
      return `
if [ -z "$SYNTH_FINAL_EXIT" ]; then
  START_TIME=$(date +%s)
  echo "Trying synthesis model ${i + 1}/${models.length}: ${m2.model}${m2.variant ? ` (variant: ${m2.variant})` : ""}"
  ${synthCommand}
  SYNTH_EXIT=$?
  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $SYNTH_EXIT -eq 0 ] || [ $ELAPSED -ge ${EARLY_FAILURE_THRESHOLD_SECONDS} ]; then
    SYNTH_FINAL_EXIT=$SYNTH_EXIT
  else
    echo ""
    echo "Synthesis model failed within ${EARLY_FAILURE_THRESHOLD_SECONDS}s (exit: $SYNTH_EXIT). Trying next..."
  fi
fi`;
    }
  }).join(`
`);
}
function buildServeCommand(port = DEFAULT_PORT) {
  return `opencode serve --port ${port}`;
}

// src/lib/notifications/types.ts
import { existsSync as existsSync22, readFileSync as readFileSync22 } from "fs";
import { join as join23 } from "path";
import { homedir } from "os";
var CONFIG_PATH = join23(homedir(), ".config", "agenv", "notifications.json");
function loadConfig(configPath = CONFIG_PATH) {
  if (!existsSync22(configPath)) {
    return {};
  }
  try {
    const content = readFileSync22(configPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}
var DEFAULT_SOUNDS = {
  thread_complete: "/System/Library/Sounds/Glass.aiff",
  batch_complete: "/System/Library/Sounds/Hero.aiff",
  error: "/System/Library/Sounds/Basso.aiff",
  thread_synthesis_complete: "/System/Library/Sounds/Purr.aiff"
};
// src/lib/notifications/config.ts
import { existsSync as existsSync23, readFileSync as readFileSync23 } from "fs";
import { join as join24 } from "path";
function getNotificationsConfigPath(repoRoot) {
  return join24(repoRoot, "work", "notifications.json");
}
function getDefaultNotificationsConfig() {
  return {
    enabled: true,
    providers: {
      sound: {
        enabled: true,
        volume: 1
      },
      notification_center: {
        enabled: true
      },
      terminal_notifier: {
        enabled: false,
        click_action: "none"
      },
      tts: {
        enabled: false
      }
    },
    events: {
      thread_complete: true,
      batch_complete: true,
      error: true,
      synthesis_complete: true
    }
  };
}
function loadNotificationsConfig(repoRoot) {
  const configPath = getNotificationsConfigPath(repoRoot);
  const defaults = getDefaultNotificationsConfig();
  if (!existsSync23(configPath)) {
    return defaults;
  }
  try {
    const content = readFileSync23(configPath, "utf-8");
    const loaded = JSON.parse(content);
    return {
      enabled: loaded.enabled ?? defaults.enabled,
      providers: {
        sound: {
          enabled: loaded.providers?.sound?.enabled ?? defaults.providers.sound.enabled,
          volume: loaded.providers?.sound?.volume ?? defaults.providers.sound.volume
        },
        notification_center: {
          enabled: loaded.providers?.notification_center?.enabled ?? defaults.providers.notification_center.enabled
        },
        terminal_notifier: {
          enabled: loaded.providers?.terminal_notifier?.enabled ?? defaults.providers.terminal_notifier.enabled,
          click_action: loaded.providers?.terminal_notifier?.click_action ?? defaults.providers.terminal_notifier.click_action
        },
        tts: {
          enabled: loaded.providers?.tts?.enabled ?? defaults.providers.tts.enabled,
          voice: loaded.providers?.tts?.voice ?? defaults.providers.tts.voice
        }
      },
      events: {
        thread_complete: loaded.events?.thread_complete ?? defaults.events.thread_complete,
        batch_complete: loaded.events?.batch_complete ?? defaults.events.batch_complete,
        error: loaded.events?.error ?? defaults.events.error,
        synthesis_complete: loaded.events?.synthesis_complete ?? defaults.events.synthesis_complete
      }
    };
  } catch {
    return defaults;
  }
}
// src/lib/notifications/providers/macos-sound.ts
import { spawn as spawn3 } from "child_process";
import { existsSync as existsSync24 } from "fs";
class MacOSSoundProvider {
  name = "macos-sound";
  soundMappings;
  enabled;
  queue = [];
  isPlaying = false;
  constructor(config2) {
    this.soundMappings = config2?.sounds ?? {};
    this.enabled = config2?.enabled !== false;
  }
  isAvailable() {
    return process.platform === "darwin";
  }
  playNotification(event, _metadata) {
    if (!this.enabled || !this.isAvailable()) {
      return;
    }
    const soundPath = this.getSoundPath(event);
    if (!existsSync24(soundPath)) {
      return;
    }
    this.queue.push(soundPath);
    if (!this.isPlaying) {
      this.playNext();
    }
  }
  playNext() {
    const soundPath = this.queue.shift();
    if (!soundPath) {
      this.isPlaying = false;
      return;
    }
    this.isPlaying = true;
    const child = spawn3("afplay", [soundPath], {
      stdio: "ignore"
    });
    child.on("exit", () => {
      this.playNext();
    });
    child.on("error", () => {
      this.playNext();
    });
  }
  getSoundPath(event) {
    const customPath = this.soundMappings[event];
    if (customPath && existsSync24(customPath)) {
      return customPath;
    }
    return DEFAULT_SOUNDS[event];
  }
  getQueueLength() {
    return this.queue.length;
  }
  getIsPlaying() {
    return this.isPlaying;
  }
  clearQueue() {
    this.queue = [];
    this.isPlaying = false;
  }
}
// src/lib/notifications/providers/external-api.ts
class ExternalApiProvider {
  name = "external-api";
  config;
  constructor(config2) {
    this.config = config2 ?? { enabled: false };
  }
  isAvailable() {
    return this.config.enabled && !!this.config.webhook_url;
  }
  playNotification(event, metadata) {
    if (!this.isAvailable()) {
      return;
    }
    if (this.config.events && !this.config.events.includes(event)) {
      return;
    }
  }
  buildPayload(event, metadata) {
    return {
      event,
      timestamp: new Date().toISOString(),
      metadata,
      synthesisOutput: metadata?.synthesisOutput,
      threadId: metadata?.threadId
    };
  }
}
// src/lib/notifications/providers/terminal-notifier.ts
import { spawn as spawn4, execSync as execSync7 } from "child_process";
var EVENT_TITLES = {
  thread_complete: "Thread Complete",
  batch_complete: "Batch Complete",
  error: "Error",
  thread_synthesis_complete: "Synthesis Complete"
};
var EVENT_MESSAGES = {
  thread_complete: "A thread has completed successfully",
  batch_complete: "Batch processing complete",
  error: "An error occurred during processing",
  thread_synthesis_complete: "Thread synthesis has completed"
};

class TerminalNotifierProvider {
  name = "terminal-notifier";
  config;
  availabilityChecked = false;
  isAvailableCache = false;
  installMessageLogged = false;
  constructor(config2) {
    this.config = config2 ?? { enabled: true };
  }
  isAvailable() {
    if (this.availabilityChecked) {
      return this.isAvailableCache;
    }
    this.availabilityChecked = true;
    if (process.platform !== "darwin") {
      this.isAvailableCache = false;
      return false;
    }
    try {
      execSync7("which terminal-notifier", { stdio: "ignore" });
      this.isAvailableCache = true;
      return true;
    } catch {
      this.isAvailableCache = false;
      return false;
    }
  }
  playNotification(event, metadata) {
    if (!this.config.enabled) {
      return;
    }
    if (!this.isAvailable()) {
      this.logInstallationMessage();
      return;
    }
    const title = EVENT_TITLES[event];
    let message = EVENT_MESSAGES[event];
    if (metadata?.threadId) {
      message = `Thread ${metadata.threadId}: ${message}`;
    }
    if (metadata?.synthesisOutput) {
      const synthesis = metadata.synthesisOutput;
      if (synthesis.length <= 200) {
        message = synthesis;
      } else {
        message = synthesis.substring(0, 197) + "...";
      }
    }
    const args = ["-title", title, "-message", message, "-sound", "default", "-group", "workstreams"];
    const clickAction = this.config.click_action ?? "activate_vscode";
    if (clickAction === "activate_vscode") {
      args.push("-activate", "com.microsoft.VSCode");
    } else if (clickAction === "open_url" && metadata?.threadId) {
      args.push("-activate", "com.microsoft.VSCode");
    }
    spawn4("terminal-notifier", args, {
      stdio: "ignore",
      detached: true
    }).unref();
  }
  logInstallationMessage() {
    if (this.installMessageLogged) {
      return;
    }
    this.installMessageLogged = true;
    console.log(`
[notifications] terminal-notifier is enabled but not installed.
` + `Install it with: brew install terminal-notifier
` + `For more info: https://github.com/julienXX/terminal-notifier
`);
  }
}
// src/lib/notifications/providers/macos-notification-center.ts
import { spawn as spawn5 } from "child_process";
var EVENT_TITLES2 = {
  thread_complete: "Thread Complete",
  batch_complete: "Batch Complete",
  error: "Error",
  thread_synthesis_complete: "Synthesis Complete"
};
var EVENT_MESSAGES2 = {
  thread_complete: "A thread has completed successfully",
  batch_complete: "Batch processing complete",
  error: "An error occurred during processing",
  thread_synthesis_complete: "Thread synthesis has completed"
};

class MacOSNotificationCenterProvider {
  name = "macos-notification-center";
  config;
  constructor(config2) {
    this.config = config2 ?? { enabled: true };
  }
  isAvailable() {
    return process.platform === "darwin";
  }
  playNotification(event, metadata) {
    if (!this.config.enabled) {
      return;
    }
    if (!this.isAvailable()) {
      return;
    }
    const title = EVENT_TITLES2[event];
    let message = EVENT_MESSAGES2[event];
    if (metadata?.threadId) {
      message = `Thread ${metadata.threadId}: ${message}`;
    }
    if (metadata?.synthesisOutput) {
      const synthesis = metadata.synthesisOutput;
      if (synthesis.length <= 200) {
        message = synthesis;
      } else {
        message = synthesis.substring(0, 197) + "...";
      }
    }
    const escapedTitle = this.escapeAppleScript(title);
    const escapedMessage = this.escapeAppleScript(message);
    const script = `display notification "${escapedMessage}" with title "${escapedTitle}" sound name "default"`;
    spawn5("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true
    }).unref();
  }
  escapeAppleScript(str) {
    return str.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  }
}
// src/lib/notifications/manager.ts
class NotificationManager {
  providers = [];
  legacyConfig;
  workstreamConfig = null;
  repoRoot;
  constructor(options) {
    if (options && "repoRoot" in options) {
      const opts = options;
      this.repoRoot = opts.repoRoot;
      this.legacyConfig = opts.config ?? loadConfig();
      if (this.repoRoot) {
        this.workstreamConfig = loadNotificationsConfig(this.repoRoot);
      }
    } else {
      this.legacyConfig = options ?? loadConfig();
    }
    this.initializeProviders();
  }
  initializeProviders() {
    if (this.workstreamConfig) {
      this.initializeFromWorkstreamConfig();
    } else {
      this.initializeFromLegacyConfig();
    }
  }
  initializeFromWorkstreamConfig() {
    const config2 = this.workstreamConfig;
    const providers = config2.providers;
    if (providers.sound?.enabled) {
      this.providers.push(new MacOSSoundProvider({
        enabled: true,
        sounds: this.legacyConfig.sounds
      }));
    }
    if (providers.notification_center?.enabled) {
      this.providers.push(new MacOSNotificationCenterProvider({
        enabled: true
      }));
    }
    if (providers.terminal_notifier?.enabled) {
      this.providers.push(new TerminalNotifierProvider({
        enabled: true,
        click_action: providers.terminal_notifier.click_action
      }));
    }
    if (this.legacyConfig.external_api?.enabled) {
      this.providers.push(new ExternalApiProvider(this.legacyConfig.external_api));
    }
  }
  initializeFromLegacyConfig() {
    this.providers.push(new MacOSSoundProvider(this.legacyConfig));
    if (this.legacyConfig.external_api) {
      this.providers.push(new ExternalApiProvider(this.legacyConfig.external_api));
    }
  }
  addProvider(provider) {
    this.providers.push(provider);
  }
  removeProvider(name) {
    this.providers = this.providers.filter((p) => p.name !== name);
  }
  getProviders() {
    return [...this.providers];
  }
  playNotification(event, metadata) {
    if (this.workstreamConfig) {
      if (this.workstreamConfig.enabled === false) {
        return;
      }
    } else {
      if (this.legacyConfig.enabled === false) {
        return;
      }
    }
    if (this.workstreamConfig && !this.isEventEnabled(event)) {
      return;
    }
    for (const provider of this.providers) {
      if (provider.isAvailable()) {
        provider.playNotification(event, metadata);
      }
    }
  }
  isEventEnabled(event) {
    if (!this.workstreamConfig) {
      return true;
    }
    const events = this.workstreamConfig.events;
    switch (event) {
      case "thread_complete":
        return events.thread_complete !== false;
      case "batch_complete":
        return events.batch_complete !== false;
      case "error":
        return events.error !== false;
      case "thread_synthesis_complete":
        return events.synthesis_complete !== false;
      default:
        return true;
    }
  }
  playSynthesisComplete(threadId, synthesisOutput) {
    this.playNotification("thread_synthesis_complete", {
      threadId,
      synthesisOutput
    });
  }
}
var defaultManager = null;
function getNotificationManager() {
  if (!defaultManager) {
    defaultManager = new NotificationManager;
  }
  return defaultManager;
}
function playNotification(event, metadata) {
  getNotificationManager().playNotification(event, metadata);
}
// src/lib/notifications/tracker.ts
class NotificationTracker {
  notifiedThreadIds = new Set;
  errorNotifiedThreadIds = new Set;
  synthesisNotifiedThreadIds = new Set;
  batchCompleteNotified = false;
  manager = null;
  constructor(options) {
    if (options?.repoRoot) {
      this.manager = new NotificationManager({ repoRoot: options.repoRoot });
    }
  }
  play(event, metadata) {
    if (this.manager) {
      this.manager.playNotification(event, metadata);
    } else {
      playNotification(event, metadata);
    }
  }
  hasThreadCompleteNotified(threadId) {
    return this.notifiedThreadIds.has(threadId);
  }
  markThreadCompleteNotified(threadId) {
    this.notifiedThreadIds.add(threadId);
  }
  hasErrorNotified(threadId) {
    return this.errorNotifiedThreadIds.has(threadId);
  }
  markErrorNotified(threadId) {
    this.errorNotifiedThreadIds.add(threadId);
  }
  hasSynthesisCompleteNotified(threadId) {
    return this.synthesisNotifiedThreadIds.has(threadId);
  }
  markSynthesisCompleteNotified(threadId) {
    this.synthesisNotifiedThreadIds.add(threadId);
  }
  hasBatchCompleteNotified() {
    return this.batchCompleteNotified;
  }
  markBatchCompleteNotified() {
    this.batchCompleteNotified = true;
  }
  playThreadComplete(threadId) {
    if (this.hasThreadCompleteNotified(threadId)) {
      return false;
    }
    this.markThreadCompleteNotified(threadId);
    this.play("thread_complete");
    return true;
  }
  playError(threadId) {
    if (this.hasErrorNotified(threadId)) {
      return false;
    }
    this.markErrorNotified(threadId);
    this.play("error");
    return true;
  }
  playBatchComplete() {
    if (this.hasBatchCompleteNotified()) {
      return false;
    }
    this.markBatchCompleteNotified();
    this.play("batch_complete");
    return true;
  }
  playSynthesisComplete(threadId, synthesisOutput) {
    if (this.hasSynthesisCompleteNotified(threadId)) {
      return false;
    }
    this.markSynthesisCompleteNotified(threadId);
    this.play("thread_synthesis_complete", {
      threadId,
      synthesisOutput
    });
    return true;
  }
  reset() {
    this.notifiedThreadIds.clear();
    this.errorNotifiedThreadIds.clear();
    this.synthesisNotifiedThreadIds.clear();
    this.batchCompleteNotified = false;
  }
  getNotifiedThreadCount() {
    return this.notifiedThreadIds.size;
  }
  getErrorNotifiedThreadCount() {
    return this.errorNotifiedThreadIds.size;
  }
  getSynthesisNotifiedThreadCount() {
    return this.synthesisNotifiedThreadIds.size;
  }
}
// src/lib/synthesis/config.ts
import { existsSync as existsSync25, readFileSync as readFileSync24 } from "fs";
import { join as join25 } from "path";
function getSynthesisConfigPath(repoRoot) {
  return join25(repoRoot, "work", "synthesis.json");
}
function getDefaultSynthesisConfig() {
  return {
    enabled: false
  };
}
function loadSynthesisConfig(repoRoot) {
  const configPath = getSynthesisConfigPath(repoRoot);
  const defaults = getDefaultSynthesisConfig();
  if (!existsSync25(configPath)) {
    return defaults;
  }
  try {
    const content = readFileSync24(configPath, "utf-8");
    const loaded = JSON.parse(content);
    return {
      enabled: loaded.enabled ?? defaults.enabled,
      agent: loaded.agent,
      output: loaded.output ? {
        store_in_threads: loaded.output.store_in_threads
      } : undefined
    };
  } catch (error) {
    console.warn(`[synthesis] Warning: Failed to parse ${configPath}, using defaults. Error: ${error instanceof Error ? error.message : String(error)}`);
    return defaults;
  }
}
function isSynthesisEnabled(repoRoot) {
  const config2 = loadSynthesisConfig(repoRoot);
  return config2.enabled;
}
function getSynthesisAgentOverride(repoRoot) {
  const config2 = loadSynthesisConfig(repoRoot);
  return config2.agent;
}

// src/cli/multi.ts
init_threads();

// src/lib/synthesis/output.ts
import { readFileSync as readFileSync25, appendFileSync, existsSync as existsSync26 } from "node:fs";
function parseSynthesisJsonl(content) {
  const logs = [];
  const textParts = [];
  let success = true;
  logs.push(`Starting JSONL parse (${content.length} bytes)`);
  const lines = content.split(`
`).filter((line) => line.trim() !== "");
  logs.push(`Found ${lines.length} non-empty lines`);
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (!line)
      continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "text") {
        const textEvent = event;
        if (textEvent.part?.text) {
          textParts.push(textEvent.part.text);
          logs.push(`Line ${i + 1}: Extracted text (${textEvent.part.text.length} chars)`);
        } else {
          logs.push(`Line ${i + 1}: Text event missing part.text field`);
        }
      } else {
        logs.push(`Line ${i + 1}: Skipped event type "${event.type}"`);
      }
    } catch (error) {
      logs.push(`Line ${i + 1}: JSON parse error - ${error instanceof Error ? error.message : String(error)}`);
      success = false;
    }
  }
  const text = textParts.join("");
  logs.push(`Parsing complete: ${textParts.length} text parts, ${text.length} total chars`);
  return {
    text,
    logs,
    success
  };
}
function parseSynthesisOutputFile(filePath, logPath) {
  const logs = [];
  try {
    if (!existsSync26(filePath)) {
      logs.push(`ERROR: File not found: ${filePath}`);
      return {
        text: "",
        logs,
        success: false
      };
    }
    logs.push(`Reading file: ${filePath}`);
    const content = readFileSync25(filePath, "utf-8");
    logs.push(`Read ${content.length} bytes`);
    const result = parseSynthesisJsonl(content);
    const allLogs = [...logs, ...result.logs];
    if (logPath) {
      try {
        const logContent = allLogs.join(`
`) + `
`;
        appendFileSync(logPath, logContent);
        allLogs.push(`Debug logs written to: ${logPath}`);
      } catch (error) {
        allLogs.push(`WARNING: Failed to write logs to ${logPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      text: result.text,
      logs: allLogs,
      success: result.success
    };
  } catch (error) {
    logs.push(`ERROR: Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
    return {
      text: "",
      logs,
      success: false
    };
  }
}

// src/lib/cli-utils.ts
function parseBatchId(batchId) {
  const parts = batchId.split(".");
  if (parts.length !== 2)
    return null;
  const stage = parseInt(parts[0], 10);
  const batch = parseInt(parts[1], 10);
  if (isNaN(stage) || isNaN(batch))
    return null;
  if (stage < 1 || batch < 1)
    return null;
  return { stage, batch };
}

// src/lib/multi-orchestrator.ts
init_repo();
import { join as join26 } from "path";
import { existsSync as existsSync27 } from "fs";
init_tasks();
function getPromptFilePathFromMetadata(repoRoot, streamId, stageNum, stageName, batchNum, batchName, threadName) {
  const workDir = getWorkDir(repoRoot);
  const safeStageName = stageName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const safeBatchName = batchName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const safeThreadName = threadName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const stagePrefix = stageNum.toString().padStart(2, "0");
  const batchPrefix = batchNum.toString().padStart(2, "0");
  return join26(workDir, streamId, "prompts", `${stagePrefix}-${safeStageName}`, `${batchPrefix}-${safeBatchName}`, `${safeThreadName}.md`);
}
function buildPaneTitle(threadInfo) {
  return threadInfo.threadName;
}
function collectThreadInfoFromTasks(repoRoot, streamId, stageNum, batchNum, agentsConfig, synthesisAgent) {
  const discoveredThreads = discoverThreadsInBatch(repoRoot, streamId, stageNum, batchNum);
  if (!discoveredThreads || discoveredThreads.length === 0) {
    return [];
  }
  const threads = [];
  const synthesisModels = synthesisAgent ? getSynthesisAgentModels(agentsConfig, synthesisAgent.name) : undefined;
  for (const discovered of discoveredThreads) {
    const promptPath = getPromptFilePathFromMetadata(repoRoot, streamId, discovered.stageNum, discovered.stageName, discovered.batchNum, discovered.batchName, discovered.threadName);
    const agentName = discovered.assignedAgent || "default";
    const models = getAgentModels(agentsConfig, agentName);
    if (models.length === 0) {
      console.error(`Error: Agent "${agentName}" not found in agents.yaml (referenced in thread ${discovered.threadId})`);
      process.exit(1);
    }
    const threadInfo = {
      threadId: discovered.threadId,
      threadName: discovered.threadName,
      stageName: discovered.stageName,
      batchName: discovered.batchName,
      promptPath,
      models,
      agentName,
      firstTaskId: discovered.firstTaskId
    };
    if (synthesisAgent && synthesisModels && synthesisModels.length > 0) {
      threadInfo.synthesisAgentName = synthesisAgent.name;
      threadInfo.synthesisModels = synthesisModels;
    }
    threads.push(threadInfo);
  }
  return threads;
}
function buildThreadRunCommand(thread, port, streamId) {
  const paneTitle = buildPaneTitle(thread);
  if (thread.synthesisModels && thread.synthesisModels.length > 0) {
    return buildPostSynthesisCommand({
      port,
      workingModels: thread.models,
      synthesisModels: thread.synthesisModels,
      promptPath: thread.promptPath,
      threadTitle: paneTitle,
      streamId,
      threadId: thread.threadId
    });
  }
  return buildRetryRunCommand(port, thread.models, thread.promptPath, paneTitle, thread.threadId);
}
function setupTmuxSession(sessionName, threads, port, repoRoot, streamId, batchId) {
  const threadSessionMap = [];
  const firstThread = threads[0];
  const firstCmd = buildThreadRunCommand(firstThread, port, streamId);
  const synthIndicator = firstThread.synthesisModels ? " [synthesis]" : "";
  console.log(`  Grid: Thread 1 - ${firstThread.threadName}${synthIndicator}`);
  createSession(sessionName, "Grid", firstCmd);
  sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger");
  setGlobalOption(sessionName, "remain-on-exit", "on");
  setGlobalOption(sessionName, "mouse", "on");
  const gridCommands = [firstCmd];
  for (let i = 1;i < Math.min(4, threads.length); i++) {
    const thread = threads[i];
    const cmd = buildThreadRunCommand(thread, port, streamId);
    gridCommands.push(cmd);
    const synthInd = thread.synthesisModels ? " [synthesis]" : "";
    console.log(`  Grid: Thread ${i + 1} - ${thread.threadName}${synthInd}`);
  }
  if (gridCommands.length > 1) {
    console.log("  Setting up 2x2 grid layout...");
    createGridLayout(`${sessionName}:0`, gridCommands);
  }
  const gridPaneIds = listPaneIds(`${sessionName}:0`);
  for (let i = 0;i < Math.min(4, threads.length); i++) {
    const thread = threads[i];
    if (thread.sessionId && thread.firstTaskId && gridPaneIds[i]) {
      threadSessionMap.push({
        threadId: thread.threadId,
        sessionId: thread.sessionId,
        taskId: thread.firstTaskId,
        paneId: gridPaneIds[i],
        windowIndex: 0
      });
    }
  }
  if (threads.length > 4) {
    console.log("  Creating hidden windows for pagination...");
    for (let i = 4;i < threads.length; i++) {
      const thread = threads[i];
      const cmd = buildThreadRunCommand(thread, port, streamId);
      const windowName = `T${i + 1}`;
      console.log(`  Hidden: ${windowName} - ${thread.threadName}`);
      addWindow(sessionName, windowName, cmd);
      sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger");
      const windowPaneIds = listPaneIds(`${sessionName}:${windowName}`);
      if (thread.sessionId && thread.firstTaskId && windowPaneIds[0]) {
        threadSessionMap.push({
          threadId: thread.threadId,
          sessionId: thread.sessionId,
          taskId: thread.firstTaskId,
          paneId: windowPaneIds[0],
          windowIndex: i - 3
        });
      }
    }
  }
  return { sessionName, threadSessionMap };
}
async function setupGridController(sessionName, threads, port, batchId, repoRoot, streamId) {
  if (threads.length <= 4)
    return;
  console.log("  Setting up grid controller for pagination...");
  const bunPath = process.execPath;
  const { resolve: resolve2 } = await import("path");
  const binPath = resolve2(import.meta.dir, "../../bin/work.ts");
  const threadCmdEnv = threads.map((t, i) => {
    const cmd = buildThreadRunCommand(t, port, streamId);
    return `THREAD_CMD_${i + 1}="${cmd}"`;
  }).join(" ");
  const loopCmd = `while true; do ${threadCmdEnv} "${bunPath}" "${binPath}" multi-grid --session "${sessionName}" --batch "${batchId}" --repo-root "${repoRoot}" --stream "${streamId}"; exitCode=$?; if [ $exitCode -eq 42 ]; then exit 0; fi; echo "Controller crashed. Restarting in 1s..."; sleep 1; done`;
  const splitArgs = [
    "tmux",
    "split-window",
    "-t",
    `${sessionName}:0`,
    "-v",
    "-l",
    "3",
    loopCmd
  ];
  Bun.spawnSync(splitArgs);
}
function setupKillSessionKeybind() {
  Bun.spawnSync(["tmux", "bind-key", "X", "kill-session"]);
}
function validateThreadPrompts(threads) {
  const missingPrompts = [];
  for (const thread of threads) {
    if (!existsSync27(thread.promptPath)) {
      missingPrompts.push(`  ${thread.threadId}: ${thread.promptPath}`);
    }
  }
  return missingPrompts;
}

// src/lib/marker-polling.ts
import { existsSync as existsSync28, unlinkSync as unlinkSync2 } from "fs";
function cleanupCompletionMarkers(threadIds) {
  for (const threadId of threadIds) {
    const markerPath = getCompletionMarkerPath(threadId);
    try {
      if (existsSync28(markerPath)) {
        unlinkSync2(markerPath);
      }
    } catch {}
  }
}
function cleanupSessionFiles(threadIds) {
  for (const threadId of threadIds) {
    const sessionPath = getSessionFilePath(threadId);
    try {
      if (existsSync28(sessionPath)) {
        unlinkSync2(sessionPath);
      }
    } catch {}
  }
}
function cleanupSynthesisFiles(streamId, threadIds) {
  for (const threadId of threadIds) {
    const synthesisPath = getSynthesisOutputPath(streamId, threadId);
    try {
      if (existsSync28(synthesisPath)) {
        unlinkSync2(synthesisPath);
      }
    } catch {}
    const synthesisJsonPath = `/tmp/workstream-${streamId}-${threadId}-synthesis.json`;
    try {
      if (existsSync28(synthesisJsonPath)) {
        unlinkSync2(synthesisJsonPath);
      }
    } catch {}
    const synthesisLogPath = getSynthesisLogPath(streamId, threadId);
    try {
      if (existsSync28(synthesisLogPath)) {
        unlinkSync2(synthesisLogPath);
      }
    } catch {}
    const exportedSessionPath = `/tmp/workstream-${streamId}-${threadId}-exported-session.json`;
    try {
      if (existsSync28(exportedSessionPath)) {
        unlinkSync2(exportedSessionPath);
      }
    } catch {}
    const extractedContextPath = `/tmp/workstream-${streamId}-${threadId}-context.txt`;
    try {
      if (existsSync28(extractedContextPath)) {
        unlinkSync2(extractedContextPath);
      }
    } catch {}
    const workingSessionPath = getWorkingAgentSessionPath(streamId, threadId);
    try {
      if (existsSync28(workingSessionPath)) {
        unlinkSync2(workingSessionPath);
      }
    } catch {}
  }
}
function createPollingState() {
  return {
    active: true,
    completedThreadIds: new Set
  };
}
async function pollMarkerFiles(config2, state) {
  const { threadIds, notificationTracker, pollIntervalMs = 500, streamId } = config2;
  while (state.active) {
    for (const threadId of threadIds) {
      if (state.completedThreadIds.has(threadId))
        continue;
      const markerPath = getCompletionMarkerPath(threadId);
      if (existsSync28(markerPath)) {
        state.completedThreadIds.add(threadId);
        let synthesisOutput;
        if (streamId) {
          const synthesisJsonPath = `/tmp/workstream-${streamId}-${threadId}-synthesis.json`;
          const synthesisLogPath = getSynthesisLogPath(streamId, threadId);
          if (existsSync28(synthesisJsonPath)) {
            try {
              const result = parseSynthesisOutputFile(synthesisJsonPath, synthesisLogPath);
              if (result.success && result.text) {
                synthesisOutput = result.text.trim();
              }
            } catch {}
          }
        }
        if (synthesisOutput) {
          notificationTracker?.playSynthesisComplete(threadId, synthesisOutput);
        } else {
          notificationTracker?.playThreadComplete(threadId);
        }
      }
    }
    if (state.completedThreadIds.size === threadIds.length && threadIds.length > 0) {
      await Bun.sleep(100);
      notificationTracker?.playBatchComplete();
      state.active = false;
      break;
    }
    await Bun.sleep(pollIntervalMs);
  }
}
function startMarkerPolling(config2) {
  const state = createPollingState();
  const promise = pollMarkerFiles(config2, state);
  return { promise, state };
}

// src/cli/multi.ts
var DEFAULT_PORT2 = 4096;
function printHelp23() {
  console.log(`
work multi - Execute all threads in a batch in parallel

Usage:
  work multi --batch "01.01" [options]
  work multi --continue [options]

Required:
  --batch, -b      Batch ID to execute (format: "SS.BB", e.g., "01.02")
                   OR uses next incomplete batch if --continue is set

Optional:
  --continue, -c   Continue with the next incomplete batch
  --stream, -s     Workstream ID or name (uses current if not specified)
  --port, -p       OpenCode server port (default: 4096)
  --dry-run        Show commands without executing
  --no-server      Skip starting opencode serve (assume already running)
  --silent         Disable notification sounds (audio only)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Executes all threads in a batch simultaneously in parallel using tmux.
  Each thread runs in its own tmux window with a full opencode TUI.

  A shared opencode serve backend is started (unless --no-server) to
  eliminate MCP cold boot times and share model cache across threads.

Examples:
  work multi --batch "01.01"
  work multi --continue
  work multi --batch "01.01" --dry-run
  work multi --continue --dry-run
`);
}
function parseCliArgs23(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--batch":
      case "-b":
        if (!next) {
          console.error("Error: --batch requires a value");
          return null;
        }
        parsed.batch = next;
        i++;
        break;
      case "--continue":
      case "-c":
        parsed.continue = true;
        break;
      case "--port":
      case "-p":
        if (!next) {
          console.error("Error: --port requires a value");
          return null;
        }
        parsed.port = parseInt(next, 10);
        if (isNaN(parsed.port)) {
          console.error("Error: --port must be a number");
          return null;
        }
        i++;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--no-server":
        parsed.noServer = true;
        break;
      case "--silent":
        parsed.silent = true;
        break;
      case "--help":
      case "-h":
        printHelp23();
        process.exit(0);
    }
  }
  return parsed;
}
function findNextIncompleteBatch(tasks) {
  const batches = new Map;
  for (const task of tasks) {
    try {
      const parsed = parseTaskId(task.id);
      if (!parsed)
        continue;
      const batchId = `${parsed.stage.toString().padStart(2, "0")}.${parsed.batch.toString().padStart(2, "0")}`;
      if (!batches.has(batchId)) {
        batches.set(batchId, []);
      }
      batches.get(batchId).push(task);
    } catch {}
  }
  const sortedBatchIds = Array.from(batches.keys()).sort();
  for (const batchId of sortedBatchIds) {
    const batchTasks = batches.get(batchId);
    const allDone = batchTasks.every((t) => t.status === "completed" || t.status === "cancelled");
    if (!allDone) {
      return batchId;
    }
  }
  return null;
}
function printDryRunOutput(stream, batchId, stageName, batchName, threads, sessionName, port, noServer, repoRoot, synthesisConfigEnabled, synthesisAgentName) {
  const synthesisEnabled = synthesisConfigEnabled && threads.some((t) => t.synthesisModels && t.synthesisModels.length > 0);
  console.log(`=== DRY RUN ===
`);
  console.log(`Stream: ${stream.id}`);
  console.log(`Batch: ${batchId} (${stageName} -> ${batchName})`);
  console.log(`Threads: ${threads.length}`);
  console.log(`Session: ${sessionName}`);
  console.log(`Port: ${port}`);
  console.log(`Synthesis config: work/synthesis.json`);
  if (synthesisConfigEnabled) {
    if (synthesisAgentName) {
      console.log(`Synthesis: enabled (${synthesisAgentName})`);
      if (synthesisEnabled) {
        console.log(`Mode: Post-Session Synthesis (working agent runs first with TUI, synthesis runs after)`);
      }
    } else {
      console.log(`Synthesis: enabled but no agent configured`);
    }
  } else {
    console.log(`Synthesis: disabled`);
  }
  console.log("");
  if (!noServer) {
    console.log("# Start opencode serve");
    console.log(buildServeCommand(port));
    console.log("");
  }
  console.log("# Create tmux session (Window 0: Dashboard)");
  const firstThread = threads[0];
  const firstCmd = buildThreadRunCommand(firstThread, port, stream.id);
  console.log(buildCreateSessionCommand(sessionName, "Dashboard", firstCmd));
  console.log("");
  console.log("# Add thread windows (Background)");
  if (threads.length > 1) {
    for (let i = 1;i < threads.length; i++) {
      const thread = threads[i];
      const cmd = buildThreadRunCommand(thread, port, stream.id);
      console.log(buildAddWindowCommand(sessionName, thread.threadId, cmd));
    }
    console.log("");
  }
  console.log("# Setup Dashboard Layout");
  const navigatorCmd = `bun work multi-navigator --session "${sessionName}" --batch "${batchId}" --repo-root "${repoRoot}" --stream "${stream.id}"`;
  console.log(`tmux split-window -t "${sessionName}:0" -h -b -l 25% "${navigatorCmd}"`);
  console.log("");
  console.log("# Attach to session");
  console.log(buildAttachCommand(sessionName));
  console.log("");
  console.log("=== Thread Details ===");
  for (const thread of threads) {
    const synthIndicator = thread.synthesisModels ? " [synthesis]" : "";
    console.log(`
${thread.threadId}: ${thread.threadName}${synthIndicator}`);
    console.log(`  Agent: ${thread.agentName}`);
    console.log(`  Working Models: ${thread.models.map((m2) => m2.model).join(" → ")}`);
    if (thread.synthesisModels) {
      console.log(`  Synthesis Models: ${thread.synthesisModels.map((m2) => m2.model).join(" → ")}`);
    }
    console.log(`  Prompt: ${thread.promptPath}`);
  }
}
async function handleSessionClose(code, sessionName, threadSessionMap, threadIds, notificationTracker, repoRoot, streamId, pollingState, pollingPromise) {
  pollingState.active = false;
  try {
    await pollingPromise;
  } catch {}
  console.log(`
Session detached. Checking thread statuses...`);
  const completions = [];
  if (threadSessionMap.length > 0) {
    if (sessionExists(sessionName)) {
      const paneStatuses = getSessionPaneStatuses(sessionName);
      for (const mapping of threadSessionMap) {
        const paneStatus = paneStatuses.find((p) => p.paneId === mapping.paneId);
        if (paneStatus && paneStatus.paneDead) {
          const exitCode = paneStatus.exitStatus ?? undefined;
          const status = exitCode === 0 ? "completed" : "failed";
          completions.push({
            taskId: mapping.taskId,
            sessionId: mapping.sessionId,
            status,
            exitCode
          });
          console.log(`  Thread ${mapping.threadId}: ${status}${exitCode !== undefined ? ` (exit ${exitCode})` : ""}`);
          if (status === "failed") {
            notificationTracker?.playError(mapping.threadId);
          }
        } else if (paneStatus && !paneStatus.paneDead) {
          console.log(`  Thread ${mapping.threadId}: still running`);
        } else {
          completions.push({
            taskId: mapping.taskId,
            sessionId: mapping.sessionId,
            status: "interrupted"
          });
          console.log(`  Thread ${mapping.threadId}: interrupted (pane not found)`);
        }
      }
      console.log(`
Windows remain in tmux session "${sessionName}".`);
      console.log(`To reattach: tmux attach -t "${sessionName}"`);
      console.log(`To kill: tmux kill-session -t "${sessionName}"`);
    } else {
      console.log("Session closed. Marking all threads as completed...");
      for (const mapping of threadSessionMap) {
        completions.push({
          taskId: mapping.taskId,
          sessionId: mapping.sessionId,
          status: "completed"
        });
        console.log(`  Thread ${mapping.threadId}: completed`);
      }
      notificationTracker?.playBatchComplete();
    }
    if (completions.length > 0) {
      console.log(`
Updating ${completions.length} session statuses in tasks.json...`);
      await completeMultipleSessionsLocked(repoRoot, streamId, completions);
    }
    console.log(`
Capturing opencode session IDs and synthesis output...`);
    for (const mapping of threadSessionMap) {
      const sessionFilePath = getSessionFilePath(mapping.threadId);
      const workingAgentSessionPath = getWorkingAgentSessionPath(streamId, mapping.threadId);
      const synthesisOutputPath = getSynthesisOutputPath(streamId, mapping.threadId);
      const sessionUpdates = {};
      if (existsSync29(sessionFilePath)) {
        try {
          const opencodeSessionId = readFileSync27(sessionFilePath, "utf-8").trim();
          if (opencodeSessionId) {
            sessionUpdates.opencodeSessionId = opencodeSessionId;
          }
        } catch (e) {
          console.log(`  Thread ${mapping.threadId}: failed to read session file (${e.message})`);
        }
      }
      if (existsSync29(workingAgentSessionPath)) {
        try {
          const workingAgentSessionId = readFileSync27(workingAgentSessionPath, "utf-8").trim();
          if (workingAgentSessionId) {
            sessionUpdates.workingAgentSessionId = workingAgentSessionId;
          }
        } catch (e) {
          console.log(`  Thread ${mapping.threadId}: failed to read working agent session file (${e.message})`);
        }
      }
      let synthesisOutputText = null;
      const synthesisJsonPath = `/tmp/workstream-${streamId}-${mapping.threadId}-synthesis.json`;
      if (existsSync29(synthesisJsonPath)) {
        try {
          const logPath = getSynthesisLogPath(streamId, mapping.threadId);
          const parseResult = parseSynthesisOutputFile(synthesisJsonPath, logPath);
          if (!parseResult.success) {
            console.log(`  Thread ${mapping.threadId}: synthesis output parsing failed (see ${logPath})`);
          }
          synthesisOutputText = parseResult.text.trim();
          if (!synthesisOutputText) {
            console.log(`  Thread ${mapping.threadId}: synthesis output is empty`);
            synthesisOutputText = "";
          }
        } catch (e) {
          console.log(`  Thread ${mapping.threadId}: failed to parse synthesis output file (${e.message})`);
          synthesisOutputText = null;
        }
      }
      if (sessionUpdates.opencodeSessionId || sessionUpdates.workingAgentSessionId) {
        const updateData = {};
        if (sessionUpdates.opencodeSessionId)
          updateData.opencodeSessionId = sessionUpdates.opencodeSessionId;
        if (sessionUpdates.workingAgentSessionId)
          updateData.workingAgentSessionId = sessionUpdates.workingAgentSessionId;
        await updateThreadMetadataLocked(repoRoot, streamId, mapping.threadId, updateData);
      }
      if (synthesisOutputText !== null) {
        const completedAt = new Date().toISOString();
        const synthesisSessionId = `synthesis-${mapping.threadId}-${Date.now()}`;
        await setSynthesisOutput(repoRoot, streamId, mapping.threadId, {
          sessionId: synthesisSessionId,
          output: synthesisOutputText,
          completedAt
        });
      }
      const hasSynthOutput = synthesisOutputText !== null;
      if (sessionUpdates.opencodeSessionId) {
        console.log(`  Thread ${mapping.threadId}: captured working session ${sessionUpdates.opencodeSessionId}${hasSynthOutput ? ", synthesis output" : ""}`);
      } else if (hasSynthOutput) {
        console.log(`  Thread ${mapping.threadId}: captured synthesis output`);
      } else if (!sessionUpdates.opencodeSessionId && !sessionUpdates.workingAgentSessionId) {
        console.log(`  Thread ${mapping.threadId}: no session file found`);
      }
    }
    cleanupCompletionMarkers(threadIds);
    cleanupSessionFiles(threadIds);
    cleanupSynthesisFiles(streamId, threadIds);
  }
  process.exit(code ?? 0);
}
async function main23(argv = process.argv) {
  const cliArgs = parseCliArgs23(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.batch && !cliArgs.continue) {
    console.error("Error: Either --batch or --continue is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let batchId = cliArgs.batch;
  if (cliArgs.continue) {
    const tasksFile = readTasksFile(repoRoot, stream.id);
    if (!tasksFile) {
      console.error(`Error: No tasks found for stream ${stream.id}`);
      process.exit(1);
    }
    const nextBatch = findNextIncompleteBatch(tasksFile.tasks);
    if (!nextBatch) {
      console.log("All batches are complete! Nothing to continue.");
      process.exit(0);
    }
    batchId = nextBatch;
    console.log(`Continuing with next incomplete batch: ${batchId}`);
  }
  if (!batchId) {
    console.error("Error: No batch specified and could not determine next batch");
    process.exit(1);
  }
  const batchParsed = parseBatchId(batchId);
  if (!batchParsed) {
    console.error(`Error: Invalid batch ID "${batchId}". Expected format: "SS.BB" (e.g., "01.02")`);
    process.exit(1);
  }
  if (batchParsed.stage > 1) {
    const prevStageNum = batchParsed.stage - 1;
    const approvalStatus = getStageApprovalStatus(stream, prevStageNum);
    if (approvalStatus !== "approved") {
      console.error(`Error: Previous stage (Stage ${prevStageNum}) is not approved.`);
      console.error(`
You must approve the outputs of Stage ${prevStageNum} before proceeding to Stage ${batchParsed.stage}.`);
      console.error(`Run: work approve stage ${prevStageNum}`);
      process.exit(1);
    }
  }
  const agentsConfig = loadAgentsConfig(repoRoot);
  if (!agentsConfig) {
    console.error("Error: No agents.yaml found. Run 'work init' to create one.");
    process.exit(1);
  }
  const synthesisConfigEnabled = isSynthesisEnabled(repoRoot);
  let synthesisAgent = null;
  if (synthesisConfigEnabled) {
    const agentOverride = getSynthesisAgentOverride(repoRoot);
    if (agentOverride) {
      synthesisAgent = getSynthesisAgent(agentsConfig, agentOverride);
      if (!synthesisAgent) {
        console.log(`Synthesis agent override "${agentOverride}" not found in agents.yaml, using default`);
        synthesisAgent = getDefaultSynthesisAgent(agentsConfig);
      }
    } else {
      synthesisAgent = getDefaultSynthesisAgent(agentsConfig);
    }
    if (synthesisAgent) {
      const synthModels = getSynthesisAgentModels(agentsConfig, synthesisAgent.name);
      console.log(`Synthesis enabled: ${synthesisAgent.name} (${synthModels.length} model(s))`);
    } else {
      console.log(`Synthesis enabled but no synthesis agent configured in agents.yaml`);
    }
  } else {
    console.log(`Synthesis: disabled (work/synthesis.json)`);
  }
  const threads = collectThreadInfoFromTasks(repoRoot, stream.id, batchParsed.stage, batchParsed.batch, agentsConfig, synthesisAgent);
  if (threads.length === 0) {
    console.error(`Error: No tasks found for batch ${batchId} in stream ${stream.id}`);
    console.error(`
Hint: Make sure tasks.json has tasks for this batch.`);
    process.exit(1);
  }
  if (threads.length > MAX_THREADS_PER_BATCH) {
    console.error(`Error: Batch has ${threads.length} threads, but max is ${MAX_THREADS_PER_BATCH}`);
    console.error(`
Hint: Split this batch into smaller batches or increase MAX_THREADS_PER_BATCH.`);
    process.exit(1);
  }
  const batchMeta = getBatchMetadata(repoRoot, stream.id, batchParsed.stage, batchParsed.batch);
  const stageName = batchMeta?.stageName || `Stage ${batchParsed.stage}`;
  const batchName = batchMeta?.batchName || `Batch ${batchParsed.batch}`;
  const missingPrompts = validateThreadPrompts(threads);
  if (missingPrompts.length > 0) {
    console.error("Error: Missing prompt files:");
    for (const msg of missingPrompts) {
      console.error(msg);
    }
    console.error(`
Hint: Run 'work prompt --stage ${batchParsed.stage} --batch ${batchParsed.batch}' to generate them.`);
    process.exit(1);
  }
  const port = cliArgs.port ?? DEFAULT_PORT2;
  const sessionName = getWorkSessionName(stream.id);
  if (cliArgs.dryRun) {
    printDryRunOutput(stream, batchId, stageName, batchName, threads, sessionName, port, cliArgs.noServer ?? false, repoRoot, synthesisConfigEnabled, synthesisAgent?.name ?? null);
    return;
  }
  if (sessionExists(sessionName)) {
    console.error(`Error: tmux session "${sessionName}" already exists.`);
    console.error(`
Options:`);
    console.error(`  1. Attach to it: tmux attach -t "${sessionName}"`);
    console.error(`  2. Kill it: tmux kill-session -t "${sessionName}"`);
    process.exit(1);
  }
  console.log("Generating session IDs for thread tracking...");
  for (const thread of threads) {
    thread.sessionId = generateSessionId();
  }
  const sessionsToStart = threads.filter((t) => t.firstTaskId && t.sessionId).map((t) => ({
    taskId: t.firstTaskId,
    agentName: t.agentName,
    model: t.models[0]?.model || "unknown",
    sessionId: t.sessionId
  }));
  if (sessionsToStart.length > 0) {
    console.log(`Starting ${sessionsToStart.length} sessions in tasks.json...`);
    await startMultipleSessionsLocked(repoRoot, stream.id, sessionsToStart);
  }
  if (!cliArgs.noServer) {
    const serverRunning = await isServerRunning(port);
    if (!serverRunning) {
      console.log(`Starting opencode serve on port ${port}...`);
      startServer(port, repoRoot);
      console.log("Waiting for server to be ready...");
      const ready = await waitForServer(port, 30000);
      if (!ready) {
        console.error(`Error: opencode serve did not start within 30 seconds`);
        process.exit(1);
      }
      console.log(`Server ready.
`);
    } else {
      console.log(`opencode serve already running on port ${port}
`);
    }
  }
  console.log(`Creating tmux session "${sessionName}"...`);
  const { threadSessionMap } = setupTmuxSession(sessionName, threads, port, repoRoot, stream.id, batchId);
  console.log(`  Tracking ${threadSessionMap.length} thread sessions`);
  await setupGridController(sessionName, threads, port, batchId, repoRoot, stream.id);
  setupKillSessionKeybind();
  console.log(`
Layout: ${threads.length <= 4 ? "2x2 Grid (all visible)" : `2x2 Grid with pagination (${threads.length} threads, use n/p to page)`}
Press Ctrl+b X to kill the session when done.
`);
  console.log(`Attaching to session "${sessionName}"...`);
  const child = attachSession(sessionName);
  const notificationTracker = cliArgs.silent ? null : new NotificationTracker({ repoRoot });
  const threadIds = threads.map((t) => t.threadId);
  const { promise: pollingPromise, state: pollingState } = startMarkerPolling({
    threadIds,
    notificationTracker,
    streamId: stream.id
  });
  child.on("close", async (code) => {
    await handleSessionClose(code, sessionName, threadSessionMap, threadIds, notificationTracker, repoRoot, stream.id, pollingState, pollingPromise);
  });
  child.on("error", (err) => {
    console.error(`Error attaching to tmux session: ${err.message}`);
    notificationTracker?.playError("__session_error__");
    process.exit(1);
  });
}
if (false) {}

// src/cli/fix.ts
init_repo();
init_lib();
init_tasks();
import { spawn as spawn6 } from "child_process";
import { existsSync as existsSync31 } from "fs";

// src/lib/prompt-paths.ts
init_repo();
init_stream_parser();
import { join as join27 } from "path";
import { existsSync as existsSync30, readFileSync as readFileSync28 } from "fs";
function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}
function resolvePromptPathFromMetadata(repoRoot, streamId, metadata) {
  const workDir = getWorkDir(repoRoot);
  const safeStageName = sanitizeName(metadata.stageName);
  const safeBatchName = sanitizeName(metadata.batchName);
  const safeThreadName = sanitizeName(metadata.threadName);
  const stagePrefix = metadata.stageNum.toString().padStart(2, "0");
  const batchPrefix = metadata.batchNum.toString().padStart(2, "0");
  return join27(workDir, streamId, "prompts", `${stagePrefix}-${safeStageName}`, `${batchPrefix}-${safeBatchName}`, `${safeThreadName}.md`);
}
function resolvePromptPath(repoRoot, streamId, threadId) {
  const workDir = getWorkDir(repoRoot);
  const planPath = join27(workDir, streamId, "PLAN.md");
  if (!existsSync30(planPath)) {
    return null;
  }
  const planContent = readFileSync28(planPath, "utf-8");
  const errors2 = [];
  const doc = parseStreamDocument(planContent, errors2);
  if (!doc) {
    return null;
  }
  const parts = threadId.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    return null;
  }
  const [stageNum, batchNum, threadNum] = parts;
  const stage = doc.stages.find((s) => s.id === stageNum);
  if (!stage)
    return null;
  const batch = stage.batches.find((b2) => b2.id === batchNum);
  if (!batch)
    return null;
  const thread = batch.threads.find((t) => t.id === threadNum);
  if (!thread)
    return null;
  return resolvePromptPathFromMetadata(repoRoot, streamId, {
    stageNum,
    stageName: stage.name,
    batchNum,
    batchName: batch.name,
    threadName: thread.name
  });
}

// src/cli/fix.ts
init_threads();

// src/cli/add-stage.ts
init_repo();
init_lib();

// src/lib/fix.ts
import { readFileSync as readFileSync29, writeFileSync as writeFileSync9 } from "fs";
init_stream_parser();
function appendFixBatch(repoRoot, streamId, options) {
  const planPath = getStreamPlanMdPath(repoRoot, streamId);
  const content = readFileSync29(planPath, "utf-8");
  const errors2 = [];
  const doc = parseStreamDocument(content, errors2);
  if (!doc) {
    return {
      success: false,
      newBatchNumber: 0,
      message: "Failed to parse PLAN.md"
    };
  }
  const stage = doc.stages.find((s) => s.id === options.targetStage);
  if (!stage) {
    return {
      success: false,
      newBatchNumber: 0,
      message: `Stage ${options.targetStage} not found`
    };
  }
  const lastBatch = stage.batches[stage.batches.length - 1];
  const newBatchNumber = (lastBatch ? lastBatch.id : -1) + 1;
  const newBatchPrefix = newBatchNumber.toString().padStart(2, "0");
  const stageIdPadded = options.targetStage.toString().padStart(2, "0");
  const template = `
##### Batch ${newBatchPrefix}: Fix - ${options.name}
###### Thread 01: Fix Implementation
**Summary:**
Addressing issues in Stage ${stageIdPadded}.
${options.description || "Fixes and improvements."}

**Details:**
- [ ] Analyze root cause
- [ ] Implement fix
- [ ] Verify fix
`;
  const lines = content.split(`
`);
  let targetStageLineIndex = -1;
  let nextStageLineIndex = -1;
  const stageRegex = /^### Stage\s+(\d+):/;
  for (let i = 0;i < lines.length; i++) {
    const match = lines[i]?.match(stageRegex);
    if (match && match[1]) {
      const stageNum = parseInt(match[1], 10);
      if (stageNum === options.targetStage) {
        targetStageLineIndex = i;
      } else if (targetStageLineIndex !== -1 && stageNum > options.targetStage) {
        nextStageLineIndex = i;
        break;
      }
    }
  }
  if (targetStageLineIndex === -1) {
    return {
      success: false,
      newBatchNumber: 0,
      message: `Could not locate Stage ${options.targetStage} header in file`
    };
  }
  if (nextStageLineIndex !== -1) {
    lines.splice(nextStageLineIndex, 0, template);
    writeFileSync9(planPath, lines.join(`
`));
  } else {
    let insertIndex = lines.length;
    for (let i = lines.length - 1;i >= targetStageLineIndex; i--) {
      if (lines[i]?.trim() !== "") {
        insertIndex = i + 1;
        break;
      }
    }
    lines.splice(insertIndex, 0, template);
    writeFileSync9(planPath, lines.join(`
`));
  }
  return {
    success: true,
    newBatchNumber,
    message: `Appended Batch ${newBatchPrefix} to Stage ${options.targetStage}`
  };
}
function appendFixStage(repoRoot, streamId, options) {
  const planPath = getStreamPlanMdPath(repoRoot, streamId);
  const content = readFileSync29(planPath, "utf-8");
  const errors2 = [];
  const doc = parseStreamDocument(content, errors2);
  if (!doc) {
    return {
      success: false,
      newStageNumber: 0,
      message: "Failed to parse PLAN.md"
    };
  }
  const lastStage = doc.stages[doc.stages.length - 1];
  const newStageNumber = (lastStage ? lastStage.id : 0) + 1;
  const newStagePadded = newStageNumber.toString().padStart(2, "0");
  const targetStagePadded = options.targetStage.toString().padStart(2, "0");
  const template = `

### Stage ${newStagePadded}: Fix - ${options.name}

#### Definition
Addressing issues found in Stage ${targetStagePadded}.
${options.description || "Fixes and improvements based on evaluation."}

#### Batches
##### Batch 01: Fixes
###### Thread 01: Implementation
**Summary:**
Apply fixes.

**Details:**
- [ ] Analyze root cause
- [ ] Implement fix
- [ ] Verify fix
`;
  const trimmedContent = content.trimEnd();
  writeFileSync9(planPath, trimmedContent + template);
  return {
    success: true,
    newStageNumber,
    message: `Appended Stage ${newStageNumber} to PLAN.md`
  };
}
function appendRevisionStage(repoRoot, streamId, options) {
  const planPath = getStreamPlanMdPath(repoRoot, streamId);
  const content = readFileSync29(planPath, "utf-8");
  const errors2 = [];
  const doc = parseStreamDocument(content, errors2);
  if (!doc) {
    return {
      success: false,
      newStageNumber: 0,
      message: "Failed to parse PLAN.md"
    };
  }
  const lastStage = doc.stages[doc.stages.length - 1];
  const newStageNumber = (lastStage ? lastStage.id : 0) + 1;
  const newStagePadded = newStageNumber.toString().padStart(2, "0");
  const template = `

### Stage ${newStagePadded}: Revision - ${options.name}

#### Definition
${options.description || "Additional revision stage for further improvements and refinements."}

#### Constitution
This revision stage adds new functionality or improvements to the workstream.

#### Questions
- What are the key changes being introduced?
- How does this revision integrate with existing stages?

#### Batches
##### Batch 01: ${options.name}
###### Thread 01: Implementation
**Summary:**
Implement ${options.name}.

**Details:**
- [ ] Analyze requirements
- [ ] Implement changes
- [ ] Verify implementation
`;
  const trimmedContent = content.trimEnd();
  writeFileSync9(planPath, trimmedContent + template);
  return {
    success: true,
    newStageNumber,
    message: `Appended Stage ${newStageNumber} to PLAN.md`
  };
}

// src/cli/add-stage.ts
function printHelp24() {
  console.log(`
work add stage - Append a fix stage or batch to a workstream

Usage:
  work add stage --stage <n> --name <name> [options]

Required:
  --stage          The stage number being fixed (for reference)
  --name           Name of the fix (e.g., "auth-race-condition")

Optional:
  --batch          Create a fix batch within the stage instead of a new stage
  --stream, -s     Workstream ID or name (uses current if not specified)
  --description    Description of the fix
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Examples:
  work add stage --stage 01 --name "api-error-handling"
  work add stage --batch --stage 02 --name "validation-logic"
`);
}
function parseCliArgs24(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        parsed.targetStage = parseInt(next, 10);
        i++;
        break;
      case "--name":
        if (!next) {
          console.error("Error: --name requires a value");
          return null;
        }
        parsed.name = next;
        i++;
        break;
      case "--description":
        if (!next) {
          console.error("Error: --description requires a value");
          return null;
        }
        parsed.description = next;
        i++;
        break;
      case "--batch":
        parsed.isBatch = true;
        break;
      case "--help":
      case "-h":
        printHelp24();
        process.exit(0);
    }
  }
  if (!parsed.targetStage || isNaN(parsed.targetStage)) {
    console.error("Error: --stage is required and must be a number");
    return null;
  }
  if (!parsed.name) {
    console.error("Error: --name is required");
    return null;
  }
  return parsed;
}
function main24(argv = process.argv) {
  const cliArgs = parseCliArgs24(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  try {
    let result;
    if (cliArgs.isBatch) {
      result = appendFixBatch(repoRoot, stream.id, {
        targetStage: cliArgs.targetStage,
        name: cliArgs.name,
        description: cliArgs.description
      });
    } else {
      result = appendFixStage(repoRoot, stream.id, {
        targetStage: cliArgs.targetStage,
        name: cliArgs.name,
        description: cliArgs.description
      });
    }
    if (result.success) {
      console.log(result.message);
      console.log(`
Run 'work validate plan' to validate the new stage.`);
    } else {
      console.error(`Error: ${result.message}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/fix.ts
function printHelp25() {
  console.log(`
work fix - Resume, retry, or fix incomplete/failed threads

Usage:
  work fix [options]
  work fix --thread <id> [--resume|--retry|--agent <name>|--new-stage]

Options:
  --thread <id>        Thread to fix (e.g., "01.01.02"). Interactive if omitted.
  --resume             Resume the existing session
  --retry              Retry with the same agent
  --agent <name>       Retry with a different agent
  --new-stage          Create a new fix stage (alias to add-stage)
  --no-tmux            Run in foreground (no tmux session, useful for debugging)
  --stream, -s         Workstream ID or name (uses current if not specified)
  --dry-run            Show what would be done without executing
  --json, -j           Output as JSON
  --repo-root, -r      Repository root (auto-detected if omitted)
  --help, -h           Show this help message

Interactive Mode:
  If --thread is not provided, displays a table of incomplete/failed threads
  and prompts for thread selection and action.

Tmux Sessions:
  By default, fix commands run in a tmux session (work-fix-{threadId}).
  - Detach with Ctrl-B D to let the process continue in background.
  - Reattach later with: tmux attach -t work-fix-{threadId}
  - Use --no-tmux to run in foreground (old behavior).

Examples:
  work fix                                    # Interactive mode
  work fix --thread 01.01.02 --resume         # Resume specific thread
  work fix --thread 01.01.02 --retry          # Retry with same agent
  work fix --thread 01.01.02 --agent backend  # Retry with different agent
  work fix --thread 01.01.02 --retry --no-tmux # Retry in foreground
`);
}
function parseCliArgs25(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--thread":
      case "-t":
        if (!next) {
          console.error("Error: --thread requires a value");
          return null;
        }
        parsed.threadId = next;
        i++;
        break;
      case "--resume":
        parsed.resume = true;
        break;
      case "--retry":
        parsed.retry = true;
        break;
      case "--agent":
      case "-a":
        if (!next) {
          console.error("Error: --agent requires a value");
          return null;
        }
        parsed.agent = next;
        i++;
        break;
      case "--new-stage":
        parsed.newStage = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--no-tmux":
        parsed.noTmux = true;
        break;
      case "--help":
      case "-h":
        printHelp25();
        process.exit(0);
    }
  }
  return parsed;
}
function getFixSessionName(threadId) {
  const safeThreadId = threadId.replace(/\./g, "-");
  return `work-fix-${safeThreadId}`;
}
async function executeResume(repoRoot, streamId, threadStatus, dryRun, noTmux) {
  const lastSession = getLastSessionForThread(repoRoot, streamId, threadStatus.threadId);
  if (!lastSession) {
    console.error(`Error: No session found for thread ${threadStatus.threadId}`);
    console.error("Use --retry to start a new session instead.");
    process.exit(1);
  }
  const workingSessionId = getWorkingAgentSessionId(repoRoot, streamId, threadStatus.threadId);
  const opencodeSessionId = getOpencodeSessionId(repoRoot, streamId, threadStatus.threadId);
  const resumeSessionId = workingSessionId || opencodeSessionId || lastSession.sessionId;
  const sessionSource = workingSessionId ? "working agent" : opencodeSessionId ? "opencode" : "session record";
  const tmuxSessionName = getFixSessionName(threadStatus.threadId);
  const command = `opencode --session "${resumeSessionId}"`;
  const existingSession = !noTmux && sessionExists(tmuxSessionName);
  if (dryRun) {
    console.log(`
Dry run - would execute:`);
    if (existingSession) {
      console.log(`  tmux attach -t "${tmuxSessionName}"`);
      console.log(`
(Reattaching to existing tmux session)`);
    } else if (noTmux) {
      console.log(`  ${command}`);
    } else {
      console.log(`  tmux new-session -s "${tmuxSessionName}" "${command}"`);
    }
    console.log(`
Thread: ${threadStatus.threadName} (${threadStatus.threadId})`);
    console.log(`Session ID: ${resumeSessionId} (${sessionSource})`);
    console.log(`Agent: ${lastSession.agentName}`);
    console.log(`Model: ${lastSession.model}`);
    return;
  }
  console.log(`
Resuming session for thread ${threadStatus.threadName} (${threadStatus.threadId})...`);
  console.log(`Session ID: ${resumeSessionId} (${sessionSource})`);
  console.log(`Agent: ${lastSession.agentName}`);
  console.log(`Model: ${lastSession.model}`);
  if (existingSession) {
    console.log(`
Reattaching to existing tmux session "${tmuxSessionName}"...`);
    console.log("  Detach: Ctrl-B D");
    console.log(`  Reattach: tmux attach -t ${tmuxSessionName}`);
    console.log("");
    const child2 = attachSession(tmuxSessionName);
    await new Promise((resolve2, reject) => {
      child2.on("close", (code) => {
        console.log(`
Detached from session "${tmuxSessionName}".`);
        console.log(`Process continues in background.`);
        console.log(`Reattach: tmux attach -t ${tmuxSessionName}`);
        resolve2();
      });
      child2.on("error", (err) => {
        console.error(`Error attaching to tmux session: ${err.message}`);
        reject(err);
      });
    });
    return;
  }
  if (noTmux) {
    console.log("");
    const child2 = spawn6("opencode", ["--session", resumeSessionId], {
      stdio: "inherit",
      cwd: repoRoot
    });
    await new Promise((resolve2, reject) => {
      child2.on("close", (code) => {
        if (code === 0) {
          resolve2();
        } else {
          process.exit(code ?? 1);
        }
      });
      child2.on("error", (err) => {
        console.error(`Error executing command: ${err.message}`);
        reject(err);
      });
    });
    return;
  }
  console.log(`
Creating tmux session "${tmuxSessionName}"...`);
  console.log("  Detach: Ctrl-B D");
  console.log(`  Reattach: tmux attach -t ${tmuxSessionName}`);
  console.log("");
  createSession(tmuxSessionName, threadStatus.threadName, command);
  setGlobalOption(tmuxSessionName, "remain-on-exit", "on");
  const child = attachSession(tmuxSessionName);
  await new Promise((resolve2, reject) => {
    child.on("close", (code) => {
      console.log(`
Detached from session "${tmuxSessionName}".`);
      console.log(`Process continues in background.`);
      console.log(`Reattach: tmux attach -t ${tmuxSessionName}`);
      resolve2();
    });
    child.on("error", (err) => {
      console.error(`Error attaching to tmux session: ${err.message}`);
      reject(err);
    });
  });
}
async function executeRetry(repoRoot, streamId, threadStatus, agentName, models, dryRun, noTmux) {
  const promptPath = resolvePromptPath(repoRoot, streamId, threadStatus.threadId);
  if (!promptPath || !existsSync31(promptPath)) {
    console.error(`Error: Prompt file not found for thread ${threadStatus.threadId}`);
    console.error(`Expected: ${promptPath}`);
    console.error(`
Hint: Run 'work prompt --thread "${threadStatus.threadId}"' to generate it first.`);
    process.exit(1);
  }
  const primaryModel = models[0];
  const variantFlag = primaryModel.variant ? ` --variant "${primaryModel.variant}"` : "";
  const command = `cat "${promptPath}" | opencode run --model "${primaryModel.model}"${variantFlag}`;
  const tmuxSessionName = getFixSessionName(threadStatus.threadId);
  if (dryRun) {
    console.log(`
Dry run - would execute:`);
    if (noTmux) {
      console.log(`  ${command}`);
    } else {
      console.log(`  tmux new-session -s "${tmuxSessionName}" "${command}"`);
    }
    console.log(`
Thread: ${threadStatus.threadName} (${threadStatus.threadId})`);
    console.log(`Agent: ${agentName}`);
    console.log(`Model: ${primaryModel.model}${primaryModel.variant ? ` (variant: ${primaryModel.variant})` : ""}`);
    console.log(`Prompt: ${promptPath}`);
    if (!noTmux) {
      console.log(`
Tmux session: ${tmuxSessionName}`);
      console.log(`  Detach: Ctrl-B D`);
      console.log(`  Reattach: tmux attach -t ${tmuxSessionName}`);
    }
    return;
  }
  if (!noTmux && sessionExists(tmuxSessionName)) {
    console.error(`Error: tmux session "${tmuxSessionName}" already exists.`);
    console.error(`
Options:`);
    console.error(`  1. Reattach: tmux attach -t "${tmuxSessionName}"`);
    console.error(`  2. Kill it: tmux kill-session -t "${tmuxSessionName}"`);
    console.error(`  3. Use --no-tmux to run in foreground`);
    process.exit(1);
  }
  const threadParsed = parseThreadId(threadStatus.threadId);
  const threadTasks = getTasksByThread(repoRoot, streamId, threadParsed.stage, threadParsed.batch, threadParsed.thread);
  const modelString = primaryModel.variant ? `${primaryModel.model}:${primaryModel.variant}` : primaryModel.model;
  const sessionIds = new Map;
  for (const task of threadTasks) {
    const session = startTaskSession(repoRoot, streamId, task.id, agentName, modelString);
    if (session) {
      sessionIds.set(task.id, session.sessionId);
    }
  }
  console.log(`
Retrying thread ${threadStatus.threadName} (${threadStatus.threadId}) with agent "${agentName}"...`);
  console.log(`Model: ${primaryModel.model}${primaryModel.variant ? ` (variant: ${primaryModel.variant})` : ""}`);
  console.log(`Session tracking: ${sessionIds.size} task(s)`);
  console.log(`Prompt: ${promptPath}`);
  if (noTmux) {
    console.log("");
    const child2 = spawn6("sh", ["-c", command], {
      stdio: "inherit",
      cwd: repoRoot
    });
    await new Promise((resolve2, reject) => {
      child2.on("close", (code) => {
        const sessionStatus = code === 0 ? "completed" : "failed";
        for (const [taskId, sessionId] of sessionIds) {
          completeTaskSession(repoRoot, streamId, taskId, sessionId, sessionStatus, code ?? undefined);
        }
        if (code === 0) {
          resolve2();
        } else {
          process.exit(code ?? 1);
        }
      });
      child2.on("error", (err) => {
        for (const [taskId, sessionId] of sessionIds) {
          completeTaskSession(repoRoot, streamId, taskId, sessionId, "failed");
        }
        console.error(`Error executing command: ${err.message}`);
        reject(err);
      });
    });
    return;
  }
  console.log(`
Creating tmux session "${tmuxSessionName}"...`);
  console.log("  Detach: Ctrl-B D");
  console.log(`  Reattach: tmux attach -t ${tmuxSessionName}`);
  console.log("");
  createSession(tmuxSessionName, threadStatus.threadName, command);
  setGlobalOption(tmuxSessionName, "remain-on-exit", "on");
  const child = attachSession(tmuxSessionName);
  await new Promise((resolve2, reject) => {
    child.on("close", (code) => {
      console.log(`
Detached from session "${tmuxSessionName}".`);
      if (sessionExists(tmuxSessionName)) {
        console.log(`Process continues in background.`);
        console.log(`Reattach: tmux attach -t ${tmuxSessionName}`);
        console.log(`
Note: Session status will be updated when the process completes.`);
      } else {
        console.log(`Session closed.`);
        for (const [taskId, sessionId] of sessionIds) {
          completeTaskSession(repoRoot, streamId, taskId, sessionId, "completed");
        }
      }
      resolve2();
    });
    child.on("error", (err) => {
      for (const [taskId, sessionId] of sessionIds) {
        completeTaskSession(repoRoot, streamId, taskId, sessionId, "failed");
      }
      console.error(`Error attaching to tmux session: ${err.message}`);
      reject(err);
    });
  });
}
function executeNewStage(argv) {
  main24(argv);
}
function findIncompleteThreads(tasks) {
  const threadMap = new Map;
  for (const task of tasks) {
    const parts = task.id.split(".");
    if (parts.length >= 3) {
      const threadId = `${parts[0]}.${parts[1]}.${parts[2]}`;
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, []);
      }
      threadMap.get(threadId).push(task);
    }
  }
  const incompleteThreads = [];
  for (const [threadId, threadTasks] of threadMap.entries()) {
    const allCompleted = threadTasks.every((t) => t.status === "completed" || t.status === "cancelled");
    if (!allCompleted) {
      incompleteThreads.push(threadId);
    }
  }
  return incompleteThreads.sort();
}
async function main25(argv = process.argv) {
  const cliArgs = parseCliArgs25(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (cliArgs.newStage && !cliArgs.threadId) {
    executeNewStage(argv);
    return;
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const tasks = getTasks(repoRoot, stream.id);
  const incompleteThreads = findIncompleteThreads(tasks);
  if (incompleteThreads.length === 0 && !cliArgs.threadId) {
    console.log("No incomplete or failed threads found.");
    return;
  }
  if (cliArgs.threadId && (cliArgs.resume || cliArgs.retry || cliArgs.agent)) {
    const threadStatuses = buildThreadStatuses(tasks, [cliArgs.threadId]);
    if (threadStatuses.length === 0) {
      console.error(`Error: Thread ${cliArgs.threadId} not found`);
      const allThreadIds = [...new Set(tasks.map((t) => {
        const parts = t.id.split(".");
        return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}` : null;
      }).filter(Boolean))];
      if (allThreadIds.length > 0) {
        console.error(`
Available threads:`);
        for (const id of allThreadIds.slice(0, 10)) {
          console.error(`  ${id}`);
        }
        if (allThreadIds.length > 10) {
          console.error(`  ... and ${allThreadIds.length - 10} more`);
        }
      }
      process.exit(1);
    }
    const selectedStatus = threadStatuses[0];
    if (cliArgs.resume) {
      await executeResume(repoRoot, stream.id, selectedStatus, cliArgs.dryRun, cliArgs.noTmux);
      return;
    }
    if (cliArgs.retry) {
      const agentName = selectedStatus.lastAgent || "default";
      const agentsConfig = loadAgentsConfig(repoRoot);
      if (!agentsConfig) {
        console.error("Error: No agents.yaml found. Run 'work init' to create one.");
        process.exit(1);
      }
      const models = getAgentModels(agentsConfig, agentName);
      if (models.length === 0) {
        console.error(`Error: Agent "${agentName}" not found in agents.yaml`);
        console.error(`
Available agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`);
        process.exit(1);
      }
      await executeRetry(repoRoot, stream.id, selectedStatus, agentName, models, cliArgs.dryRun, cliArgs.noTmux);
      return;
    }
    if (cliArgs.agent) {
      const agentsConfig = loadAgentsConfig(repoRoot);
      if (!agentsConfig) {
        console.error("Error: No agents.yaml found. Run 'work init' to create one.");
        process.exit(1);
      }
      const models = getAgentModels(agentsConfig, cliArgs.agent);
      if (models.length === 0) {
        console.error(`Error: Agent "${cliArgs.agent}" not found in agents.yaml`);
        console.error(`
Available agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`);
        process.exit(1);
      }
      await executeRetry(repoRoot, stream.id, selectedStatus, cliArgs.agent, models, cliArgs.dryRun, cliArgs.noTmux);
      return;
    }
  }
  const rl = createReadlineInterface();
  try {
    let selectedThreadId;
    let selectedStatus;
    if (cliArgs.threadId) {
      selectedThreadId = cliArgs.threadId;
      const threadStatuses = buildThreadStatuses(tasks, [selectedThreadId]);
      if (threadStatuses.length === 0) {
        console.error(`Error: Thread ${selectedThreadId} not found`);
        process.exit(1);
      }
      selectedStatus = threadStatuses[0];
    } else {
      const threadStatuses = buildThreadStatuses(tasks, incompleteThreads);
      const selection = await selectThreadFromStatuses(rl, threadStatuses);
      selectedStatus = selection.value;
      selectedThreadId = selectedStatus.threadId;
    }
    let action;
    let selectedAgent;
    if (cliArgs.resume) {
      action = "resume";
    } else if (cliArgs.retry) {
      action = "retry";
    } else if (cliArgs.agent) {
      action = "change-agent";
      selectedAgent = cliArgs.agent;
    } else if (cliArgs.newStage) {
      action = "new-stage";
    } else {
      const selectedAction = await selectFixAction(rl, selectedStatus);
      action = selectedAction;
      if (action === "change-agent") {
        const agentsConfig = loadAgentsConfig(repoRoot);
        if (!agentsConfig || agentsConfig.agents.length === 0) {
          console.error("Error: No agents found in agents.yaml");
          process.exit(1);
        }
        const agentOptions = agentsConfig.agents.map((a) => ({
          name: a.name,
          description: a.description,
          bestFor: a.best_for
        }));
        const agentSelection = await selectAgent(rl, agentOptions);
        selectedAgent = agentSelection.value.name;
      }
    }
    if (!cliArgs.dryRun) {
      let confirmMessage = "";
      switch (action) {
        case "resume":
          confirmMessage = `Resume thread ${selectedThreadId} (${selectedStatus.threadName})?`;
          break;
        case "retry":
          confirmMessage = `Retry thread ${selectedThreadId} (${selectedStatus.threadName}) with agent ${selectedStatus.lastAgent || "default"}?`;
          break;
        case "change-agent":
          confirmMessage = `Retry thread ${selectedThreadId} (${selectedStatus.threadName}) with agent ${selectedAgent}?`;
          break;
        case "new-stage":
          confirmMessage = `Create a new fix stage for thread ${selectedThreadId}?`;
          break;
      }
      const confirmed = await confirmAction(rl, confirmMessage);
      if (!confirmed) {
        console.log("Action cancelled.");
        rl.close();
        return;
      }
    }
    rl.close();
    switch (action) {
      case "resume":
        await executeResume(repoRoot, stream.id, selectedStatus, cliArgs.dryRun, cliArgs.noTmux);
        break;
      case "retry": {
        const agentName = selectedStatus.lastAgent || "default";
        const agentsConfig = loadAgentsConfig(repoRoot);
        if (!agentsConfig) {
          console.error("Error: No agents.yaml found. Run 'work init' to create one.");
          process.exit(1);
        }
        const models = getAgentModels(agentsConfig, agentName);
        if (models.length === 0) {
          console.error(`Error: Agent "${agentName}" not found in agents.yaml`);
          console.error(`
Available agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`);
          process.exit(1);
        }
        await executeRetry(repoRoot, stream.id, selectedStatus, agentName, models, cliArgs.dryRun, cliArgs.noTmux);
        break;
      }
      case "change-agent": {
        if (!selectedAgent) {
          console.error("Error: No agent selected");
          process.exit(1);
        }
        const agentsConfig = loadAgentsConfig(repoRoot);
        if (!agentsConfig) {
          console.error("Error: No agents.yaml found. Run 'work init' to create one.");
          process.exit(1);
        }
        const models = getAgentModels(agentsConfig, selectedAgent);
        if (models.length === 0) {
          console.error(`Error: Agent "${selectedAgent}" not found in agents.yaml`);
          console.error(`
Available agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`);
          process.exit(1);
        }
        await executeRetry(repoRoot, stream.id, selectedStatus, selectedAgent, models, cliArgs.dryRun, cliArgs.noTmux);
        break;
      }
      case "new-stage":
        console.log(`
To create a fix stage, run:`);
        console.log(`  work add-stage --stage <target-stage> --name "fix-description"`);
        console.log(`
Example:`);
        const stageNum = selectedThreadId.split(".")[0];
        console.log(`  work add-stage --stage ${stageNum} --name "thread-${selectedThreadId}-fix"`);
        break;
    }
  } catch (err) {
    rl.close();
    throw err;
  }
}
if (false) {}

// src/cli/continue.ts
init_repo();
init_lib();
init_tasks();
function printHelp26() {
  console.log(`
work continue - Continue execution with session awareness

Usage:
  work continue [options]

Description:
  Finds the next incomplete batch and checks for any incomplete/failed threads
  with session history. Offers options to:
  - Continue (skip failed threads)
  - Fix first (interactive fix mode)
  - Abort

  If no issues are found, proceeds directly to execute the next batch.

Options:
  --port, -p       OpenCode server port (default: 4096)
  --dry-run        Show commands without executing
  --no-server      Skip starting opencode serve
  --repo-root, -r  Repository root
  --stream, -s     Workstream ID or name (uses current if not specified)
  --help, -h       Show this help message

Examples:
  work continue
  work continue --dry-run
`);
}
function findIncompleteThreadsInBatch(tasks, batchId) {
  const threadMap = new Map;
  for (const task of tasks) {
    const parts = task.id.split(".");
    if (parts.length >= 3) {
      const taskBatchId = `${parts[0]}.${parts[1]}`;
      if (taskBatchId !== batchId)
        continue;
      const threadId = `${parts[0]}.${parts[1]}.${parts[2]}`;
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, []);
      }
      threadMap.get(threadId).push(task);
    }
  }
  const incompleteThreads = [];
  for (const [threadId, threadTasks] of threadMap.entries()) {
    const allCompleted = threadTasks.every((t) => t.status === "completed" || t.status === "cancelled");
    const hasSessionHistory = threadTasks.some((t) => t.sessions && t.sessions.length > 0);
    if (!allCompleted && hasSessionHistory) {
      incompleteThreads.push(threadId);
    }
  }
  return incompleteThreads.sort();
}
async function main26(argv = process.argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp26();
    process.exit(0);
  }
  let repoRoot;
  try {
    repoRoot = getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const streamIdArg = argv.find((arg, i) => (arg === "--stream" || arg === "-s") && argv[i + 1]);
  const streamId = streamIdArg ? argv[argv.indexOf(streamIdArg) + 1] : undefined;
  let stream;
  try {
    stream = getResolvedStream(index, streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const tasksFile = readTasksFile(repoRoot, stream.id);
  if (!tasksFile) {
    console.error(`Error: No tasks found for stream ${stream.id}`);
    process.exit(1);
  }
  const nextBatch = findNextIncompleteBatch(tasksFile.tasks);
  if (!nextBatch) {
    console.log("All batches are complete! Nothing to continue.");
    process.exit(0);
  }
  const incompleteThreads = findIncompleteThreadsInBatch(tasksFile.tasks, nextBatch);
  if (incompleteThreads.length > 0) {
    console.log(`
Found ${incompleteThreads.length} incomplete/failed thread(s) with session history in batch ${nextBatch}:
`);
    const threadStatuses = buildThreadStatuses(tasksFile.tasks, incompleteThreads);
    displayThreadStatusTable(threadStatuses);
    const rl = createReadlineInterface();
    try {
      console.log("Options:");
      console.log("  1. Continue (skip failed threads)");
      console.log("  2. Fix first (interactive fix mode)");
      console.log("  3. Abort");
      const answer = await new Promise((resolve2) => {
        rl.question(`
Select option (1-3): `, resolve2);
      });
      rl.close();
      const choice = answer.trim();
      if (choice === "1") {
        console.log(`
Continuing with next batch (skipping failed threads)...
`);
      } else if (choice === "2") {
        console.log(`
Launching interactive fix mode...
`);
        await main25(argv);
        return;
      } else if (choice === "3") {
        console.log(`
Aborted.`);
        process.exit(0);
      } else {
        console.error(`
Invalid option: "${choice}"`);
        process.exit(1);
      }
    } catch (err) {
      rl.close();
      throw err;
    }
  } else {
    console.log(`
Continuing with next incomplete batch: ${nextBatch}`);
  }
  const originalArgs = argv.slice(2);
  const newArgs = [
    argv[0],
    argv[1],
    "--continue",
    ...originalArgs
  ];
  await main23(newArgs);
}
if (false) {}

// src/cli/context.ts
init_repo();
init_lib();

// src/lib/continue.ts
init_tasks();
function getContinueContext(repoRoot, streamId, streamName) {
  const tasks = getTasks(repoRoot, streamId);
  const activeTask = tasks.find((t) => t.status === "in_progress");
  const nextTask = tasks.find((t) => t.status === "pending");
  const targetTask = activeTask || nextTask;
  const assignedAgent = targetTask?.assigned_agent || undefined;
  return {
    activeTask,
    nextTask,
    lastCompletedTask: [...tasks].reverse().find((t) => t.status === "completed"),
    streamId,
    streamName,
    assignedAgent
  };
}

// src/cli/context.ts
function printHelp27() {
  console.log(`
work continue - Show workstream resume information

Usage:
  work continue [options]

Optional:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  This command helps an agent (or user) orient themselves when resuming work.
  It displays:
  1. The current active task (or next pending task)
  2. The last breadcrumb (if any)
  3. Context about the workstream status

  Note: Use the public 'work continue' command to resume execution.

Examples:
  work continue
  work continue --stream "001-my-feature"
`);
}
function parseCliArgs26(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp27();
        process.exit(0);
    }
  }
  return parsed;
}
function main27(argv = process.argv) {
  const cliArgs = parseCliArgs26(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const ctx = getContinueContext(repoRoot, stream.id, stream.name);
  console.log(`
# Context: ${ctx.streamId} (${ctx.streamName})
`);
  if (ctx.activeTask) {
    const t = ctx.activeTask;
    console.log(`## Status: Active Task in Progress`);
    console.log(`Task ID: ${t.id}`);
    console.log(`Description: ${t.name}`);
    console.log(`Location: Stage ${t.stage_name} > Batch ${t.batch_name} > Thread ${t.thread_name}`);
    if (ctx.assignedAgent) {
      console.log(`Assigned Agent: ${ctx.assignedAgent}`);
    }
    if (t.breadcrumb) {
      console.log(`
## Last Breadcrumb`);
      console.log(`> ${t.breadcrumb}`);
    } else {
      console.log(`
## Last Breadcrumb`);
      console.log(`(No breadcrumb logged)`);
    }
    console.log(`
## Action Required`);
    console.log(`Resume execution of this task. Check the last breadcrumb for context.`);
  } else {
    if (ctx.lastCompletedTask) {
      const t = ctx.lastCompletedTask;
      console.log(`## Previous Context`);
      console.log(`Last Completed Task: ${t.id} - ${t.name}`);
      if (t.breadcrumb) {
        console.log(`Last Breadcrumb: ${t.breadcrumb}`);
      }
    }
    if (ctx.nextTask) {
      const t = ctx.nextTask;
      console.log(`
## Status: Ready to Start New Task`);
      console.log(`Next Task ID: ${t.id}`);
      console.log(`Description: ${t.name}`);
      console.log(`Location: Stage ${t.stage_name} > Batch ${t.batch_name} > Thread ${t.thread_name}`);
      if (ctx.assignedAgent) {
        console.log(`Assigned Agent: ${ctx.assignedAgent}`);
      }
      console.log(`
## Action Required`);
      console.log(`Start this task using: work update --task "${t.id}" --status in_progress`);
    } else {
      console.log(`
## Status: All Tasks Completed`);
      console.log(`No pending tasks found. The workstream appears to be complete.`);
    }
  }
}
if (false) {}

// src/cli/fix.ts
init_repo();
init_lib();
init_tasks();
import { spawn as spawn7 } from "child_process";
import { existsSync as existsSync32 } from "fs";
init_threads();
function printHelp28() {
  console.log(`
work fix - Resume, retry, or fix incomplete/failed threads

Usage:
  work fix [options]
  work fix --thread <id> [--resume|--retry|--agent <name>|--new-stage]

Options:
  --thread <id>        Thread to fix (e.g., "01.01.02"). Interactive if omitted.
  --resume             Resume the existing session
  --retry              Retry with the same agent
  --agent <name>       Retry with a different agent
  --new-stage          Create a new fix stage (alias to add-stage)
  --no-tmux            Run in foreground (no tmux session, useful for debugging)
  --stream, -s         Workstream ID or name (uses current if not specified)
  --dry-run            Show what would be done without executing
  --json, -j           Output as JSON
  --repo-root, -r      Repository root (auto-detected if omitted)
  --help, -h           Show this help message

Interactive Mode:
  If --thread is not provided, displays a table of incomplete/failed threads
  and prompts for thread selection and action.

Tmux Sessions:
  By default, fix commands run in a tmux session (work-fix-{threadId}).
  - Detach with Ctrl-B D to let the process continue in background.
  - Reattach later with: tmux attach -t work-fix-{threadId}
  - Use --no-tmux to run in foreground (old behavior).

Examples:
  work fix                                    # Interactive mode
  work fix --thread 01.01.02 --resume         # Resume specific thread
  work fix --thread 01.01.02 --retry          # Retry with same agent
  work fix --thread 01.01.02 --agent backend  # Retry with different agent
  work fix --thread 01.01.02 --retry --no-tmux # Retry in foreground
`);
}
function parseCliArgs27(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--thread":
      case "-t":
        if (!next) {
          console.error("Error: --thread requires a value");
          return null;
        }
        parsed.threadId = next;
        i++;
        break;
      case "--resume":
        parsed.resume = true;
        break;
      case "--retry":
        parsed.retry = true;
        break;
      case "--agent":
      case "-a":
        if (!next) {
          console.error("Error: --agent requires a value");
          return null;
        }
        parsed.agent = next;
        i++;
        break;
      case "--new-stage":
        parsed.newStage = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--no-tmux":
        parsed.noTmux = true;
        break;
      case "--help":
      case "-h":
        printHelp28();
        process.exit(0);
    }
  }
  return parsed;
}
function getFixSessionName2(threadId) {
  const safeThreadId = threadId.replace(/\./g, "-");
  return `work-fix-${safeThreadId}`;
}
async function executeResume2(repoRoot, streamId, threadStatus, dryRun, noTmux) {
  const lastSession = getLastSessionForThread(repoRoot, streamId, threadStatus.threadId);
  if (!lastSession) {
    console.error(`Error: No session found for thread ${threadStatus.threadId}`);
    console.error("Use --retry to start a new session instead.");
    process.exit(1);
  }
  const workingSessionId = getWorkingAgentSessionId(repoRoot, streamId, threadStatus.threadId);
  const opencodeSessionId = getOpencodeSessionId(repoRoot, streamId, threadStatus.threadId);
  const resumeSessionId = workingSessionId || opencodeSessionId || lastSession.sessionId;
  const sessionSource = workingSessionId ? "working agent" : opencodeSessionId ? "opencode" : "session record";
  const tmuxSessionName = getFixSessionName2(threadStatus.threadId);
  const command = `opencode --session "${resumeSessionId}"`;
  const existingSession = !noTmux && sessionExists(tmuxSessionName);
  if (dryRun) {
    console.log(`
Dry run - would execute:`);
    if (existingSession) {
      console.log(`  tmux attach -t "${tmuxSessionName}"`);
      console.log(`
(Reattaching to existing tmux session)`);
    } else if (noTmux) {
      console.log(`  ${command}`);
    } else {
      console.log(`  tmux new-session -s "${tmuxSessionName}" "${command}"`);
    }
    console.log(`
Thread: ${threadStatus.threadName} (${threadStatus.threadId})`);
    console.log(`Session ID: ${resumeSessionId} (${sessionSource})`);
    console.log(`Agent: ${lastSession.agentName}`);
    console.log(`Model: ${lastSession.model}`);
    return;
  }
  console.log(`
Resuming session for thread ${threadStatus.threadName} (${threadStatus.threadId})...`);
  console.log(`Session ID: ${resumeSessionId} (${sessionSource})`);
  console.log(`Agent: ${lastSession.agentName}`);
  console.log(`Model: ${lastSession.model}`);
  if (existingSession) {
    console.log(`
Reattaching to existing tmux session "${tmuxSessionName}"...`);
    console.log("  Detach: Ctrl-B D");
    console.log(`  Reattach: tmux attach -t ${tmuxSessionName}`);
    console.log("");
    const child2 = attachSession(tmuxSessionName);
    await new Promise((resolve2, reject) => {
      child2.on("close", (code) => {
        console.log(`
Detached from session "${tmuxSessionName}".`);
        console.log(`Process continues in background.`);
        console.log(`Reattach: tmux attach -t ${tmuxSessionName}`);
        resolve2();
      });
      child2.on("error", (err) => {
        console.error(`Error attaching to tmux session: ${err.message}`);
        reject(err);
      });
    });
    return;
  }
  if (noTmux) {
    console.log("");
    const child2 = spawn7("opencode", ["--session", resumeSessionId], {
      stdio: "inherit",
      cwd: repoRoot
    });
    await new Promise((resolve2, reject) => {
      child2.on("close", (code) => {
        if (code === 0) {
          resolve2();
        } else {
          process.exit(code ?? 1);
        }
      });
      child2.on("error", (err) => {
        console.error(`Error executing command: ${err.message}`);
        reject(err);
      });
    });
    return;
  }
  console.log(`
Creating tmux session "${tmuxSessionName}"...`);
  console.log("  Detach: Ctrl-B D");
  console.log(`  Reattach: tmux attach -t ${tmuxSessionName}`);
  console.log("");
  createSession(tmuxSessionName, threadStatus.threadName, command);
  setGlobalOption(tmuxSessionName, "remain-on-exit", "on");
  const child = attachSession(tmuxSessionName);
  await new Promise((resolve2, reject) => {
    child.on("close", (code) => {
      console.log(`
Detached from session "${tmuxSessionName}".`);
      console.log(`Process continues in background.`);
      console.log(`Reattach: tmux attach -t ${tmuxSessionName}`);
      resolve2();
    });
    child.on("error", (err) => {
      console.error(`Error attaching to tmux session: ${err.message}`);
      reject(err);
    });
  });
}
async function executeRetry2(repoRoot, streamId, threadStatus, agentName, models, dryRun, noTmux) {
  const promptPath = resolvePromptPath(repoRoot, streamId, threadStatus.threadId);
  if (!promptPath || !existsSync32(promptPath)) {
    console.error(`Error: Prompt file not found for thread ${threadStatus.threadId}`);
    console.error(`Expected: ${promptPath}`);
    console.error(`
Hint: Run 'work prompt --thread "${threadStatus.threadId}"' to generate it first.`);
    process.exit(1);
  }
  const primaryModel = models[0];
  const variantFlag = primaryModel.variant ? ` --variant "${primaryModel.variant}"` : "";
  const command = `cat "${promptPath}" | opencode run --model "${primaryModel.model}"${variantFlag}`;
  const tmuxSessionName = getFixSessionName2(threadStatus.threadId);
  if (dryRun) {
    console.log(`
Dry run - would execute:`);
    if (noTmux) {
      console.log(`  ${command}`);
    } else {
      console.log(`  tmux new-session -s "${tmuxSessionName}" "${command}"`);
    }
    console.log(`
Thread: ${threadStatus.threadName} (${threadStatus.threadId})`);
    console.log(`Agent: ${agentName}`);
    console.log(`Model: ${primaryModel.model}${primaryModel.variant ? ` (variant: ${primaryModel.variant})` : ""}`);
    console.log(`Prompt: ${promptPath}`);
    if (!noTmux) {
      console.log(`
Tmux session: ${tmuxSessionName}`);
      console.log(`  Detach: Ctrl-B D`);
      console.log(`  Reattach: tmux attach -t ${tmuxSessionName}`);
    }
    return;
  }
  if (!noTmux && sessionExists(tmuxSessionName)) {
    console.error(`Error: tmux session "${tmuxSessionName}" already exists.`);
    console.error(`
Options:`);
    console.error(`  1. Reattach: tmux attach -t "${tmuxSessionName}"`);
    console.error(`  2. Kill it: tmux kill-session -t "${tmuxSessionName}"`);
    console.error(`  3. Use --no-tmux to run in foreground`);
    process.exit(1);
  }
  const threadParsed = parseThreadId(threadStatus.threadId);
  const threadTasks = getTasksByThread(repoRoot, streamId, threadParsed.stage, threadParsed.batch, threadParsed.thread);
  const modelString = primaryModel.variant ? `${primaryModel.model}:${primaryModel.variant}` : primaryModel.model;
  const sessionIds = new Map;
  for (const task of threadTasks) {
    const session = startTaskSession(repoRoot, streamId, task.id, agentName, modelString);
    if (session) {
      sessionIds.set(task.id, session.sessionId);
    }
  }
  console.log(`
Retrying thread ${threadStatus.threadName} (${threadStatus.threadId}) with agent "${agentName}"...`);
  console.log(`Model: ${primaryModel.model}${primaryModel.variant ? ` (variant: ${primaryModel.variant})` : ""}`);
  console.log(`Session tracking: ${sessionIds.size} task(s)`);
  console.log(`Prompt: ${promptPath}`);
  if (noTmux) {
    console.log("");
    const child2 = spawn7("sh", ["-c", command], {
      stdio: "inherit",
      cwd: repoRoot
    });
    await new Promise((resolve2, reject) => {
      child2.on("close", (code) => {
        const sessionStatus = code === 0 ? "completed" : "failed";
        for (const [taskId, sessionId] of sessionIds) {
          completeTaskSession(repoRoot, streamId, taskId, sessionId, sessionStatus, code ?? undefined);
        }
        if (code === 0) {
          resolve2();
        } else {
          process.exit(code ?? 1);
        }
      });
      child2.on("error", (err) => {
        for (const [taskId, sessionId] of sessionIds) {
          completeTaskSession(repoRoot, streamId, taskId, sessionId, "failed");
        }
        console.error(`Error executing command: ${err.message}`);
        reject(err);
      });
    });
    return;
  }
  console.log(`
Creating tmux session "${tmuxSessionName}"...`);
  console.log("  Detach: Ctrl-B D");
  console.log(`  Reattach: tmux attach -t ${tmuxSessionName}`);
  console.log("");
  createSession(tmuxSessionName, threadStatus.threadName, command);
  setGlobalOption(tmuxSessionName, "remain-on-exit", "on");
  const child = attachSession(tmuxSessionName);
  await new Promise((resolve2, reject) => {
    child.on("close", (code) => {
      console.log(`
Detached from session "${tmuxSessionName}".`);
      if (sessionExists(tmuxSessionName)) {
        console.log(`Process continues in background.`);
        console.log(`Reattach: tmux attach -t ${tmuxSessionName}`);
        console.log(`
Note: Session status will be updated when the process completes.`);
      } else {
        console.log(`Session closed.`);
        for (const [taskId, sessionId] of sessionIds) {
          completeTaskSession(repoRoot, streamId, taskId, sessionId, "completed");
        }
      }
      resolve2();
    });
    child.on("error", (err) => {
      for (const [taskId, sessionId] of sessionIds) {
        completeTaskSession(repoRoot, streamId, taskId, sessionId, "failed");
      }
      console.error(`Error attaching to tmux session: ${err.message}`);
      reject(err);
    });
  });
}
function executeNewStage2(argv) {
  main24(argv);
}
function findIncompleteThreads2(tasks) {
  const threadMap = new Map;
  for (const task of tasks) {
    const parts = task.id.split(".");
    if (parts.length >= 3) {
      const threadId = `${parts[0]}.${parts[1]}.${parts[2]}`;
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, []);
      }
      threadMap.get(threadId).push(task);
    }
  }
  const incompleteThreads = [];
  for (const [threadId, threadTasks] of threadMap.entries()) {
    const allCompleted = threadTasks.every((t) => t.status === "completed" || t.status === "cancelled");
    if (!allCompleted) {
      incompleteThreads.push(threadId);
    }
  }
  return incompleteThreads.sort();
}
async function main28(argv = process.argv) {
  const cliArgs = parseCliArgs27(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (cliArgs.newStage && !cliArgs.threadId) {
    executeNewStage2(argv);
    return;
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const tasks = getTasks(repoRoot, stream.id);
  const incompleteThreads = findIncompleteThreads2(tasks);
  if (incompleteThreads.length === 0 && !cliArgs.threadId) {
    console.log("No incomplete or failed threads found.");
    return;
  }
  if (cliArgs.threadId && (cliArgs.resume || cliArgs.retry || cliArgs.agent)) {
    const threadStatuses = buildThreadStatuses(tasks, [cliArgs.threadId]);
    if (threadStatuses.length === 0) {
      console.error(`Error: Thread ${cliArgs.threadId} not found`);
      const allThreadIds = [...new Set(tasks.map((t) => {
        const parts = t.id.split(".");
        return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}` : null;
      }).filter(Boolean))];
      if (allThreadIds.length > 0) {
        console.error(`
Available threads:`);
        for (const id of allThreadIds.slice(0, 10)) {
          console.error(`  ${id}`);
        }
        if (allThreadIds.length > 10) {
          console.error(`  ... and ${allThreadIds.length - 10} more`);
        }
      }
      process.exit(1);
    }
    const selectedStatus = threadStatuses[0];
    if (cliArgs.resume) {
      await executeResume2(repoRoot, stream.id, selectedStatus, cliArgs.dryRun, cliArgs.noTmux);
      return;
    }
    if (cliArgs.retry) {
      const agentName = selectedStatus.lastAgent || "default";
      const agentsConfig = loadAgentsConfig(repoRoot);
      if (!agentsConfig) {
        console.error("Error: No agents.yaml found. Run 'work init' to create one.");
        process.exit(1);
      }
      const models = getAgentModels(agentsConfig, agentName);
      if (models.length === 0) {
        console.error(`Error: Agent "${agentName}" not found in agents.yaml`);
        console.error(`
Available agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`);
        process.exit(1);
      }
      await executeRetry2(repoRoot, stream.id, selectedStatus, agentName, models, cliArgs.dryRun, cliArgs.noTmux);
      return;
    }
    if (cliArgs.agent) {
      const agentsConfig = loadAgentsConfig(repoRoot);
      if (!agentsConfig) {
        console.error("Error: No agents.yaml found. Run 'work init' to create one.");
        process.exit(1);
      }
      const models = getAgentModels(agentsConfig, cliArgs.agent);
      if (models.length === 0) {
        console.error(`Error: Agent "${cliArgs.agent}" not found in agents.yaml`);
        console.error(`
Available agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`);
        process.exit(1);
      }
      await executeRetry2(repoRoot, stream.id, selectedStatus, cliArgs.agent, models, cliArgs.dryRun, cliArgs.noTmux);
      return;
    }
  }
  const rl = createReadlineInterface();
  try {
    let selectedThreadId;
    let selectedStatus;
    if (cliArgs.threadId) {
      selectedThreadId = cliArgs.threadId;
      const threadStatuses = buildThreadStatuses(tasks, [selectedThreadId]);
      if (threadStatuses.length === 0) {
        console.error(`Error: Thread ${selectedThreadId} not found`);
        process.exit(1);
      }
      selectedStatus = threadStatuses[0];
    } else {
      const threadStatuses = buildThreadStatuses(tasks, incompleteThreads);
      const selection = await selectThreadFromStatuses(rl, threadStatuses);
      selectedStatus = selection.value;
      selectedThreadId = selectedStatus.threadId;
    }
    let action;
    let selectedAgent;
    if (cliArgs.resume) {
      action = "resume";
    } else if (cliArgs.retry) {
      action = "retry";
    } else if (cliArgs.agent) {
      action = "change-agent";
      selectedAgent = cliArgs.agent;
    } else if (cliArgs.newStage) {
      action = "new-stage";
    } else {
      const selectedAction = await selectFixAction(rl, selectedStatus);
      action = selectedAction;
      if (action === "change-agent") {
        const agentsConfig = loadAgentsConfig(repoRoot);
        if (!agentsConfig || agentsConfig.agents.length === 0) {
          console.error("Error: No agents found in agents.yaml");
          process.exit(1);
        }
        const agentOptions = agentsConfig.agents.map((a) => ({
          name: a.name,
          description: a.description,
          bestFor: a.best_for
        }));
        const agentSelection = await selectAgent(rl, agentOptions);
        selectedAgent = agentSelection.value.name;
      }
    }
    if (!cliArgs.dryRun) {
      let confirmMessage = "";
      switch (action) {
        case "resume":
          confirmMessage = `Resume thread ${selectedThreadId} (${selectedStatus.threadName})?`;
          break;
        case "retry":
          confirmMessage = `Retry thread ${selectedThreadId} (${selectedStatus.threadName}) with agent ${selectedStatus.lastAgent || "default"}?`;
          break;
        case "change-agent":
          confirmMessage = `Retry thread ${selectedThreadId} (${selectedStatus.threadName}) with agent ${selectedAgent}?`;
          break;
        case "new-stage":
          confirmMessage = `Create a new fix stage for thread ${selectedThreadId}?`;
          break;
      }
      const confirmed = await confirmAction(rl, confirmMessage);
      if (!confirmed) {
        console.log("Action cancelled.");
        rl.close();
        return;
      }
    }
    rl.close();
    switch (action) {
      case "resume":
        await executeResume2(repoRoot, stream.id, selectedStatus, cliArgs.dryRun, cliArgs.noTmux);
        break;
      case "retry": {
        const agentName = selectedStatus.lastAgent || "default";
        const agentsConfig = loadAgentsConfig(repoRoot);
        if (!agentsConfig) {
          console.error("Error: No agents.yaml found. Run 'work init' to create one.");
          process.exit(1);
        }
        const models = getAgentModels(agentsConfig, agentName);
        if (models.length === 0) {
          console.error(`Error: Agent "${agentName}" not found in agents.yaml`);
          console.error(`
Available agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`);
          process.exit(1);
        }
        await executeRetry2(repoRoot, stream.id, selectedStatus, agentName, models, cliArgs.dryRun, cliArgs.noTmux);
        break;
      }
      case "change-agent": {
        if (!selectedAgent) {
          console.error("Error: No agent selected");
          process.exit(1);
        }
        const agentsConfig = loadAgentsConfig(repoRoot);
        if (!agentsConfig) {
          console.error("Error: No agents.yaml found. Run 'work init' to create one.");
          process.exit(1);
        }
        const models = getAgentModels(agentsConfig, selectedAgent);
        if (models.length === 0) {
          console.error(`Error: Agent "${selectedAgent}" not found in agents.yaml`);
          console.error(`
Available agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`);
          process.exit(1);
        }
        await executeRetry2(repoRoot, stream.id, selectedStatus, selectedAgent, models, cliArgs.dryRun, cliArgs.noTmux);
        break;
      }
      case "new-stage":
        console.log(`
To create a fix stage, run:`);
        console.log(`  work add-stage --stage <target-stage> --name "fix-description"`);
        console.log(`
Example:`);
        const stageNum = selectedThreadId.split(".")[0];
        console.log(`  work add-stage --stage ${stageNum} --name "thread-${selectedThreadId}-fix"`);
        break;
    }
  } catch (err) {
    rl.close();
    throw err;
  }
}
if (false) {}

// src/cli/add-stage.ts
init_repo();
init_lib();
function printHelp29() {
  console.log(`
work add stage - Append a fix stage or batch to a workstream

Usage:
  work add stage --stage <n> --name <name> [options]

Required:
  --stage          The stage number being fixed (for reference)
  --name           Name of the fix (e.g., "auth-race-condition")

Optional:
  --batch          Create a fix batch within the stage instead of a new stage
  --stream, -s     Workstream ID or name (uses current if not specified)
  --description    Description of the fix
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Examples:
  work add stage --stage 01 --name "api-error-handling"
  work add stage --batch --stage 02 --name "validation-logic"
`);
}
function parseCliArgs28(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        parsed.targetStage = parseInt(next, 10);
        i++;
        break;
      case "--name":
        if (!next) {
          console.error("Error: --name requires a value");
          return null;
        }
        parsed.name = next;
        i++;
        break;
      case "--description":
        if (!next) {
          console.error("Error: --description requires a value");
          return null;
        }
        parsed.description = next;
        i++;
        break;
      case "--batch":
        parsed.isBatch = true;
        break;
      case "--help":
      case "-h":
        printHelp29();
        process.exit(0);
    }
  }
  if (!parsed.targetStage || isNaN(parsed.targetStage)) {
    console.error("Error: --stage is required and must be a number");
    return null;
  }
  if (!parsed.name) {
    console.error("Error: --name is required");
    return null;
  }
  return parsed;
}
function main29(argv = process.argv) {
  const cliArgs = parseCliArgs28(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  try {
    let result;
    if (cliArgs.isBatch) {
      result = appendFixBatch(repoRoot, stream.id, {
        targetStage: cliArgs.targetStage,
        name: cliArgs.name,
        description: cliArgs.description
      });
    } else {
      result = appendFixStage(repoRoot, stream.id, {
        targetStage: cliArgs.targetStage,
        name: cliArgs.name,
        description: cliArgs.description
      });
    }
    if (result.success) {
      console.log(result.message);
      console.log(`
Run 'work validate plan' to validate the new stage.`);
    } else {
      console.error(`Error: ${result.message}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/tasks.ts
init_repo();
init_lib();
import { readFileSync as readFileSync30, existsSync as existsSync33, unlinkSync as unlinkSync3 } from "fs";
import { join as join28 } from "path";
init_stream_parser();
init_tasks_md();
init_tasks();
function printHelp30() {
  console.log(`
work tasks - Manage TASKS.md intermediate file

Usage:
  work tasks <command> [options]

Commands:
  generate    Create TASKS.md from PLAN.md (or existing tasks.json)
  serialize   Convert TASKS.md to tasks.json (updates/adds tasks)

Options:
  --stream, -s <id>   Workstream ID or name (defaults to current)
  --repo-root <path>  Repository root (auto-detected)
  --help, -h          Show this help message

Workflow:
  1. work tasks generate    -> Creates TASKS.md
  2. (Edit TASKS.md)        -> Add/Edit tasks in Markdown
  3. work tasks serialize   -> Updates tasks.json, deletes TASKS.md
`);
}
function parseCliArgs29(argv) {
  const args = argv.slice(2);
  if (args.length === 0)
    return null;
  const command = args[0];
  if (command !== "generate" && command !== "serialize") {
    if (command === "--help" || command === "-h") {
      printHelp30();
      process.exit(0);
    }
    console.error(`Error: Unknown command "${command}". Expected "generate" or "serialize".`);
    return null;
  }
  const parsed = { command };
  for (let i = 1;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--repo-root":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp30();
        process.exit(0);
    }
  }
  return parsed;
}
function main30(argv = process.argv) {
  const cliArgs = parseCliArgs29(argv);
  if (!cliArgs) {
    printHelp30();
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  try {
    const index = loadIndex(repoRoot);
    const streamIdRaw = cliArgs.streamId || getCurrentStreamId(index);
    if (!streamIdRaw) {
      console.error("Error: No workstream specified and no current workstream set.");
      console.error("Use --stream <id> or set a current workstream.");
      process.exit(1);
    }
    const stream = getStream(index, streamIdRaw);
    const workDir = getWorkDir(repoRoot);
    const streamDir = join28(workDir, stream.id);
    const tasksMdPath = join28(streamDir, "TASKS.md");
    const tasksJsonPath = join28(streamDir, "tasks.json");
    if (cliArgs.command === "generate") {
      if (existsSync33(tasksMdPath)) {
        console.error(`Error: TASKS.md already exists at ${tasksMdPath}`);
        console.error("Please serialize or delete it before generating a new one.");
        process.exit(1);
      }
      const existingTasks = getTasks(repoRoot, stream.id);
      let content;
      if (existingTasks.length > 0) {
        console.log(`Generating TASKS.md from ${existingTasks.length} existing tasks...`);
        content = generateTasksMdFromTasks(stream.name, existingTasks);
      } else {
        console.log("Generating TASKS.md from PLAN.md structure...");
        const planPath = getStreamPlanMdPath(repoRoot, stream.id);
        if (!existsSync33(planPath)) {
          console.error(`Error: PLAN.md not found at ${planPath}`);
          process.exit(1);
        }
        const planContent = readFileSync30(planPath, "utf-8");
        const errors2 = [];
        const doc = parseStreamDocument(planContent, errors2);
        if (!doc) {
          console.error("Error parsing PLAN.md:");
          errors2.forEach((e) => console.error(`- ${e.message}`));
          process.exit(1);
        }
        content = generateTasksMdFromPlan(stream.name, doc);
      }
      atomicWriteFile(tasksMdPath, content);
      console.log(`Created: ${tasksMdPath}`);
      console.log("Edit this file to define your tasks, then run 'work tasks serialize'.");
    } else if (cliArgs.command === "serialize") {
      if (!existsSync33(tasksMdPath)) {
        console.error(`Error: TASKS.md not found at ${tasksMdPath}`);
        console.error("Run 'work tasks generate' first.");
        process.exit(1);
      }
      const content = readFileSync30(tasksMdPath, "utf-8");
      const result = parseTasksMd(content, stream.id);
      if (result.errors.length > 0) {
        console.error("Error parsing TASKS.md:");
        result.errors.forEach((e) => console.error(`- ${e}`));
        console.error("Please fix the errors in TASKS.md and try again.");
        process.exit(1);
      }
      const newTasks = result.tasks;
      console.log(`Parsed ${newTasks.length} tasks from TASKS.md`);
      const existingTasks = getTasks(repoRoot, stream.id);
      const existingMap = new Map(existingTasks.map((t) => [t.id, t]));
      const mergedTasks = newTasks.map((newTask) => {
        const existing = existingMap.get(newTask.id);
        if (existing) {
          return {
            ...newTask,
            created_at: existing.created_at,
            assigned_agent: existing.assigned_agent,
            breadcrumb: existing.breadcrumb,
            report: newTask.report ?? existing.report
          };
        }
        return newTask;
      });
      const tasksFile = {
        version: "1.0.0",
        stream_id: stream.id,
        last_updated: new Date().toISOString(),
        tasks: mergedTasks
      };
      atomicWriteFile(tasksJsonPath, JSON.stringify(tasksFile, null, 2));
      console.log(`Updated: ${tasksJsonPath}`);
      unlinkSync3(tasksMdPath);
      console.log("Deleted TASKS.md");
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/agents.ts
init_repo();
function printHelp31() {
  console.log(`
work agents - List agent definitions

Usage:
  work agents                           # List all agents
  work agents --json                    # Output as JSON

Options:
  --repo-root, -r    Repository root (auto-detected if omitted)
  --json, -j         Output as JSON for machine-readable format
  --help, -h         Show this help message

Description:
  Agents are defined in work/agents.yaml and can be assigned to tasks
  for workstream execution. Each agent has a name, description of its
  specialization, use cases it's best for, and a list of models to use.

  The output format is designed for planner agents to understand
  what agents are available and their capabilities.

Examples:
  # List all defined agents
  work agents

  # Get JSON output for programmatic use
  work agents --json
`);
}
function parseCliArgs30(argv) {
  const args = argv.slice(2);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp31();
        process.exit(0);
    }
  }
  return parsed;
}
function formatAgentOutput(agents) {
  console.log("Available Agents:");
  console.log("");
  for (const agent of agents) {
    console.log(`- ${agent.name}`);
    console.log(`  Description: ${agent.description}`);
    console.log(`  Best for: ${agent.best_for}`);
    console.log("");
  }
}
function formatAgentJson(agents) {
  const output = {
    agents: agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      best_for: agent.best_for
    }))
  };
  console.log(JSON.stringify(output, null, 2));
}
function main31(argv = process.argv) {
  const cliArgs = parseCliArgs30(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const config2 = loadAgentsConfig(repoRoot);
  if (!config2 || config2.agents.length === 0) {
    if (cliArgs.json) {
      console.log(JSON.stringify({ agents: [] }, null, 2));
    } else {
      const agentsPath = getAgentsYamlPath(repoRoot);
      console.log("No agents defined.");
      console.log("");
      console.log("To define agents, create or edit the agents.yaml file:");
      console.log(`  ${agentsPath}`);
      console.log("");
      console.log("Example agents.yaml:");
      console.log(`
agents:
  - name: backend-expert
    description: Specializes in database schema design and API development
    best_for: Database setup, migration scripts, API endpoints
    models:
      - anthropic/claude-sonnet-4
      - anthropic/claude-opus
`);
      console.log("Or run 'work init' to create a default configuration.");
    }
    return;
  }
  if (cliArgs.json) {
    formatAgentJson(config2.agents);
  } else {
    formatAgentOutput(config2.agents);
    console.log(`Config file: ${getAgentsYamlPath(repoRoot)}`);
  }
}
if (false) {}

// src/cli/assign.ts
init_repo();
init_lib();
init_tasks();
function printHelp32() {
  console.log(`
work assign - Assign agents to tasks

Usage:
  work assign --task <taskId> --agent <agent>
  work assign --task <taskId> --clear
  work assign --list

Options:
  --repo-root, -r    Repository root (auto-detected if omitted)
  --stream, -s       Workstream ID or name (uses current if not specified)
  --thread, -th      Thread ID (e.g., "01.01.01")
  --task, -t         Task ID (e.g., "01.01.02.03")
  --agent, -a        Agent name to assign
  --list             List all tasks with agent assignments
  --clear            Remove agent assignment from task
  --json, -j         Output as JSON
  --help, -h         Show this help message

Description:
  Assigns agents to tasks for execution. Agents must be defined first
  in agents.yaml. Assignments are stored in tasks.json.

Examples:
  # Assign an agent to a thread
  work assign --thread "01.01.01" --agent "backend-expert"

  # Assign an agent to a specific task
  work assign --task "01.01.02.03" --agent "backend-orm-expert"

  # List all tasks with assignments
  work assign --list

  # Remove an assignment
  work assign --task "01.01.02.03" --clear
`);
}
function parseCliArgs31(argv) {
  const args = argv.slice(2);
  const parsed = { list: false, clear: false, json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--task":
      case "-t":
        if (!next) {
          console.error("Error: --task requires a value (e.g., '01.01.02.03')");
          return null;
        }
        parsed.task = next;
        i++;
        break;
      case "--thread":
      case "-th":
        if (!next) {
          console.error("Error: --thread requires a value (e.g., '01.01.01')");
          return null;
        }
        parsed.thread = next;
        i++;
        break;
      case "--agent":
      case "-a":
        if (!next) {
          console.error("Error: --agent requires a value");
          return null;
        }
        parsed.agent = next;
        i++;
        break;
      case "--list":
        parsed.list = true;
        break;
      case "--clear":
        parsed.clear = true;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp32();
        process.exit(0);
    }
  }
  return parsed;
}
function main32(argv = process.argv) {
  const cliArgs = parseCliArgs31(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (cliArgs.list) {
    const tasks = getTasks(repoRoot, stream.id);
    const assignedTasks = tasks.filter((t) => t.assigned_agent);
    if (cliArgs.json) {
      console.log(JSON.stringify({ streamId: stream.id, tasks: assignedTasks }, null, 2));
    } else {
      if (assignedTasks.length === 0) {
        console.log(`No tasks have agent assignments in workstream "${stream.name}"`);
        return;
      }
      console.log(`Tasks with agent assignments in "${stream.name}":`);
      console.log("");
      for (const t of assignedTasks) {
        console.log(`  ${t.id} -> ${t.assigned_agent}`);
        console.log(`    ${t.name}`);
        console.log("");
      }
    }
    return;
  }
  if (cliArgs.clear) {
    let targetTasks2 = [];
    if (cliArgs.task) {
      targetTasks2.push(cliArgs.task);
    } else if (cliArgs.thread) {
      const tasks = getTasks(repoRoot, stream.id);
      const threadPrefix = cliArgs.thread + ".";
      targetTasks2 = tasks.filter((t) => t.id.startsWith(threadPrefix)).map((t) => t.id);
      if (targetTasks2.length === 0) {
        console.error(`Error: No tasks found for thread "${cliArgs.thread}"`);
        process.exit(1);
      }
    } else {
      console.error("Error: --clear requires --task or --thread");
      console.error(`
Run with --help for usage information.`);
      process.exit(1);
    }
    let successCount2 = 0;
    const errors3 = [];
    for (const taskId of targetTasks2) {
      const existingTask = getTaskById(repoRoot, stream.id, taskId);
      if (!existingTask) {
        errors3.push(`Task "${taskId}" not found`);
        continue;
      }
      const updated = updateTaskStatus(repoRoot, stream.id, taskId, {
        assigned_agent: ""
      });
      if (!updated) {
        errors3.push(`Failed to update task "${taskId}"`);
      } else {
        successCount2++;
      }
    }
    if (errors3.length > 0) {
      console.error("Errors clearing assignments:");
      errors3.forEach((e) => console.error(`  - ${e}`));
    }
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "cleared",
        streamId: stream.id,
        clearedCount: successCount2,
        errors: errors3
      }, null, 2));
    } else {
      console.log(`Cleared agent assignment from ${successCount2} tasks`);
    }
    if (errors3.length > 0)
      process.exit(1);
    return;
  }
  if (!cliArgs.task && !cliArgs.thread || !cliArgs.agent) {
    console.error("Error: --agent and either --task or --thread are required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  const agentsConfig = loadAgentsConfig(repoRoot);
  if (agentsConfig) {
    const agentDef = getAgentYaml(agentsConfig, cliArgs.agent);
    if (!agentDef) {
      console.error(`Error: Agent "${cliArgs.agent}" is not defined`);
      console.error("Define it in agents.yaml first.");
      process.exit(1);
    }
  }
  let targetTasks = [];
  if (cliArgs.task) {
    const existingTask = getTaskById(repoRoot, stream.id, cliArgs.task);
    if (!existingTask) {
      console.error(`Error: Task "${cliArgs.task}" not found`);
      process.exit(1);
    }
    targetTasks.push(existingTask);
  } else if (cliArgs.thread) {
    const tasks = getTasks(repoRoot, stream.id);
    const threadPrefix = cliArgs.thread + ".";
    targetTasks = tasks.filter((t) => t.id.startsWith(threadPrefix));
    if (targetTasks.length === 0) {
      console.error(`Error: No tasks found for thread "${cliArgs.thread}"`);
      process.exit(1);
    }
  }
  let successCount = 0;
  const errors2 = [];
  for (const task of targetTasks) {
    const updated = updateTaskStatus(repoRoot, stream.id, task.id, {
      assigned_agent: cliArgs.agent
    });
    if (!updated) {
      errors2.push(`Failed to update task "${task.id}"`);
    } else {
      successCount++;
    }
  }
  if (cliArgs.json) {
    console.log(JSON.stringify({
      action: "assigned",
      streamId: stream.id,
      agent: cliArgs.agent,
      assignedCount: successCount,
      errors: errors2
    }, null, 2));
  } else {
    console.log(`Assigned "${cliArgs.agent}" to ${successCount} tasks`);
    if (cliArgs.thread) {
      console.log(`Thread: ${cliArgs.thread}`);
    } else {
      console.log(`Task: ${targetTasks[0]?.name}`);
    }
  }
  if (errors2.length > 0) {
    console.error("Errors assigning agent:");
    errors2.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
}
if (false) {}

// src/cli/prompt.ts
init_repo();
init_lib();
import { join as join29, dirname as dirname7 } from "path";
import { mkdirSync as mkdirSync5, writeFileSync as writeFileSync10 } from "fs";
function printHelp33() {
  console.log(`
work prompt - Generate thread execution prompt for agents

Usage:
  work prompt --thread "01.01.01" [options]

Required:
  --thread, -t     Thread ID in "stage.batch.thread" format (e.g., "01.01.02")
  OR
  --stage, --batch Generate prompts for all threads in a batch
  OR
  --stage          Generate prompts for all threads in a stage
  (No args)        Generate prompts for ENTIRE workstream

Required (only if targeting specific thread):
  --thread         Thread ID

Optional Scope:
  --stage          Stage number
  --batch          Batch number

Optional:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --json, -j       Output as JSON instead of markdown
  --no-tests       Exclude test requirements section
  --no-parallel    Exclude parallel threads section
  --help, -h       Show this help message

Description:
  Generates a comprehensive execution prompt for an agent to work on a specific
  thread. The prompt includes:
  - Thread summary and details from PLAN.md
  - Tasks assigned to the thread
  - Stage definition and constitution
  - Parallel threads for awareness

Examples:
  work prompt --thread "01.01.01"
  work prompt --thread "01.01.02" --stream "001-my-feature"
  work prompt --thread "01.01.01" --json
  work prompt --stage 1 --batch 1
  work prompt --stage 1 --batch 1
`);
}
function savePromptToFile2(repoRoot, context, content) {
  const workDir = getWorkDir(repoRoot);
  const safeStageName = context.stage.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const safeBatchName = context.batch.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const safeThreadName = context.thread.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const stagePrefix = context.stage.id.toString().padStart(2, "0");
  const relPath = join29(context.streamId, "prompts", `${stagePrefix}-${safeStageName}`, `${context.batch.prefix}-${safeBatchName}`, `${safeThreadName}.md`);
  const fullPath = join29(workDir, relPath);
  try {
    mkdirSync5(dirname7(fullPath), { recursive: true });
    writeFileSync10(fullPath, content);
  } catch (e) {
    console.warn(`Warning: Failed to save prompt to ${relPath}: ${e.message}`);
  }
}
function parseCliArgs32(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--thread":
      case "-t":
        if (!next) {
          console.error("Error: --thread requires a value");
          return null;
        }
        parsed.threadId = next;
        i++;
        break;
      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        parsed.stage = next;
        i++;
        break;
      case "--batch":
        if (!next) {
          console.error("Error: --batch requires a value");
          return null;
        }
        parsed.batch = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--no-tests":
        parsed.noTests = true;
        break;
      case "--no-parallel":
        parsed.noParallel = true;
        break;
      case "--help":
      case "-h":
        printHelp33();
        process.exit(0);
    }
  }
  return parsed;
}
async function main33(argv = process.argv) {
  const cliArgs = parseCliArgs32(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (cliArgs.threadId && (cliArgs.stage || cliArgs.batch)) {
    console.warn("Warning: --thread provided, ignoring --stage/--batch");
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (cliArgs.threadId) {
    let context;
    try {
      context = getPromptContext(repoRoot, stream.id, cliArgs.threadId);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    if (cliArgs.json) {
      const json = generateThreadPromptJson(context);
      console.log(JSON.stringify(json, null, 2));
    } else {
      const prompt = generateThreadPrompt(context, {
        includeTests: !cliArgs.noTests,
        includeParallel: !cliArgs.noParallel
      });
      savePromptToFile2(repoRoot, context, prompt);
    }
    return;
  }
  if (!cliArgs.threadId) {
    const { join: join30 } = await import("path");
    const { readFileSync: readFileSync31, existsSync: existsSync34 } = await import("fs");
    const { getWorkDir: getWorkDir3 } = await Promise.resolve().then(() => (init_repo(), exports_repo));
    const { parseStreamDocument: parseStreamDocument2 } = await Promise.resolve().then(() => (init_stream_parser(), exports_stream_parser));
    const stageNum = cliArgs.stage ? parseInt(cliArgs.stage, 10) : undefined;
    const batchNum = cliArgs.batch ? parseInt(cliArgs.batch, 10) : undefined;
    if (stageNum !== undefined && isNaN(stageNum)) {
      console.error("Error: stage must be a number");
      process.exit(1);
    }
    if (batchNum !== undefined && isNaN(batchNum)) {
      console.error("Error: batch must be a number");
      process.exit(1);
    }
    const workDir = getWorkDir3(repoRoot);
    const planPath = join30(workDir, stream.id, "PLAN.md");
    if (!existsSync34(planPath)) {
      console.error(`Error: PLAN.md not found at ${planPath}`);
      process.exit(1);
    }
    const planContent = readFileSync31(planPath, "utf-8");
    const errors2 = [];
    const doc = parseStreamDocument2(planContent, errors2);
    if (!doc) {
      console.error("Error parsing PLAN.md");
      process.exit(1);
    }
    let stages = doc.stages;
    if (stageNum !== undefined) {
      const stage = doc.stages.find((s) => s.id === stageNum);
      if (!stage) {
        console.error(`Error: Stage ${stageNum} not found`);
        process.exit(1);
      }
      stages = [stage];
    }
    const results = [];
    let promptCount = 0;
    for (const stage of stages) {
      let batches = stage.batches;
      if (batchNum !== undefined) {
        const batch = stage.batches.find((b2) => b2.id === batchNum);
        if (batch) {
          batches = [batch];
        } else if (stageNum !== undefined) {
          console.error(`Error: Batch ${batchNum} not found in stage ${stage.id}`);
          process.exit(1);
        } else {
          batches = [];
        }
      }
      for (const batch of batches) {
        for (const thread of batch.threads) {
          const threadIdStr = `${stage.id.toString().padStart(2, "0")}.${batch.id.toString().padStart(2, "0")}.${thread.id.toString().padStart(2, "0")}`;
          try {
            const context = getPromptContext(repoRoot, stream.id, threadIdStr);
            if (cliArgs.json) {
              results.push(generateThreadPromptJson(context));
            } else {
              const prompt = generateThreadPrompt(context, {
                includeTests: !cliArgs.noTests,
                includeParallel: !cliArgs.noParallel
              });
              savePromptToFile2(repoRoot, context, prompt);
            }
            promptCount++;
          } catch (e) {
            console.error(`Error generating prompt for ${threadIdStr}: ${e.message}`);
          }
        }
      }
    }
    if (cliArgs.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(`Generated ${promptCount} prompts.`);
    }
  }
}
if (false) {}

// src/cli/edit.ts
init_repo();
init_lib();
import { spawn as spawn8 } from "child_process";
function printHelp34() {
  console.log(`
work edit - Open PLAN.md in editor

Usage:
  work edit [--stream <id>] [--editor <editor>]

Options:
  --stream, -s     Workstream ID (uses current if not specified)
  --editor, -e     Editor command (default: $EDITOR or 'vim')
  --repo-root, -r  Repository root (auto-detected)
  --help, -h       Show this help message

Description:
  Opens the PLAN.md file for the current or specified workstream in your
  preferred editor. Uses $EDITOR environment variable, falling back to vim.

Examples:
  work edit
  work edit --stream "001-my-feature"
  work edit --editor code
  work edit --editor "code --wait"
`);
}
function parseCliArgs33(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--editor":
      case "-e":
        if (!next) {
          console.error("Error: --editor requires a value");
          return null;
        }
        parsed.editor = next;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp34();
        process.exit(0);
    }
  }
  return parsed;
}
function main34(argv = process.argv) {
  const cliArgs = parseCliArgs33(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const planPath = getStreamPlanMdPath(repoRoot, stream.id);
  const editor = cliArgs.editor || process.env.EDITOR || "vim";
  const editorParts = editor.split(" ");
  const editorCmd = editorParts[0];
  const editorArgs = [...editorParts.slice(1), planPath];
  console.log(`Opening ${stream.id}/PLAN.md in ${editorCmd}...`);
  const child = spawn8(editorCmd, editorArgs, {
    stdio: "inherit",
    shell: false
  });
  child.on("error", (err) => {
    console.error(`Error: Failed to open editor "${editorCmd}": ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
if (false) {}

// src/cli/init.ts
init_repo();
init_lib();
import { existsSync as existsSync34, mkdirSync as mkdirSync6, writeFileSync as writeFileSync11 } from "fs";
var DEFAULT_AGENTS_YAML = `agents:
  - name: default
    description: General-purpose implementation agent.
    best_for: Standard development tasks.
    models:
      - anthropic/claude-sonnet-4-5
      - openrouter/anthropic/claude-sonnet-4.5

  - name: frontend-speedster
    description: Very efficient and effective frontend coder.
    best_for: Straight-forward frontend tasks.
    models:
      - openrouter/google/gemini-3-flash-preview

  - name: systems-engineer
    description: Good for complex multi-faceted work.
    best_for: Architecture, complex systems, solving engineering problems.
    models:
      - anthropic/claude-opus-4-5
      - openrouter/anthropic/claude-opus-4.5

  - name: code-reviewer
    description: Specialized on code analysis.
    best_for: Debugging, testing, code reviews.
    models:
      - openrouter/openai/gpt-5.2-codex

  - name: documentation-minimalist
    description: Model that creates short and sweet docs.
    best_for: Documentation, reviews.
    models:
      - openrouter/google/gemini-3-pro-preview
`;
function printHelp35() {
  console.log(`
Usage: work init [options]

Initialize work/ directory with default configuration files.

Options:
  --force       Overwrite existing configuration files
  --help, -h    Show this help message
`);
}
async function main35(argv) {
  const args = argv.slice(2);
  const force = args.includes("--force");
  const repoRootIdx = args.indexOf("--repo-root");
  let repoRootArg;
  if (repoRootIdx !== -1 && repoRootIdx + 1 < args.length) {
    repoRootArg = args[repoRootIdx + 1];
  }
  if (args.includes("--help") || args.includes("-h")) {
    printHelp35();
    return;
  }
  try {
    const repoRoot = getRepoRoot(repoRootArg);
    const workDir = getWorkDir(repoRoot);
    if (!existsSync34(workDir)) {
      console.log(`Creating ${workDir}/...`);
      mkdirSync6(workDir, { recursive: true });
    }
    const githubConfigPath = getGitHubConfigPath(repoRoot);
    if (!existsSync34(githubConfigPath) || force) {
      console.log(`${force && existsSync34(githubConfigPath) ? "Overwriting" : "Creating"} github.json (disabled by default)...`);
      await saveGitHubConfig(repoRoot, DEFAULT_GITHUB_CONFIG);
    } else {
      console.log("github.json already exists, skipping.");
    }
    const indexPath = getIndexPath(repoRoot);
    if (!existsSync34(indexPath) || force) {
      console.log(`${force && existsSync34(indexPath) ? "Overwriting" : "Initializing"} index.json...`);
      const index = getOrCreateIndex(repoRoot);
      saveIndex(repoRoot, index);
    } else {
      console.log("index.json already exists, skipping.");
    }
    const agentsPath = getAgentsYamlPath(repoRoot);
    if (!existsSync34(agentsPath) || force) {
      console.log(`${force && existsSync34(agentsPath) ? "Overwriting" : "Initializing"} agents.yaml...`);
      writeFileSync11(agentsPath, DEFAULT_AGENTS_YAML, "utf-8");
    } else {
      console.log("agents.yaml already exists, skipping.");
    }
    const notificationsPath = getNotificationsConfigPath(repoRoot);
    if (!existsSync34(notificationsPath) || force) {
      console.log(`${force && existsSync34(notificationsPath) ? "Overwriting" : "Initializing"} notifications.json...`);
      const defaultConfig = getDefaultNotificationsConfig();
      writeFileSync11(notificationsPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
    } else {
      console.log("notifications.json already exists, skipping.");
    }
    const synthesisPath = getSynthesisConfigPath(repoRoot);
    if (!existsSync34(synthesisPath) || force) {
      console.log(`${force && existsSync34(synthesisPath) ? "Overwriting" : "Initializing"} synthesis.json...`);
      const defaultSynthesisConfig = {
        ...getDefaultSynthesisConfig(),
        output: {
          store_in_threads: true
        }
      };
      writeFileSync11(synthesisPath, JSON.stringify(defaultSynthesisConfig, null, 2), "utf-8");
    } else {
      console.log("synthesis.json already exists, skipping.");
    }
    console.log(`
Initialization complete.`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// src/cli/execute.ts
init_repo();
init_lib();
import { join as join30 } from "path";
import { existsSync as existsSync35, readFileSync as readFileSync31 } from "fs";
import { spawn as spawn9 } from "child_process";
init_tasks();
init_stream_parser();
function printHelp36() {
  console.log(`
work execute - Execute a thread prompt via opencode

Usage:
  work execute --thread "01.01.01" [options]
  work execute --thread "Dependencies & Config" [options]

Required:
  --thread, -t     Thread ID ("01.01.02") or thread name ("My Thread Name")

Optional:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --agent, -a      Override agent (uses thread's assigned agent if not specified)
  --dry-run        Show the command that would be run without executing
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Executes a thread by piping its prompt to opencode with the correct model.
  The model is determined from the assigned agent's definition in AGENTS.md.

  Threads can be specified by:
  - Numeric ID: "01.01.01" (stage.batch.thread)
  - Thread name: "Dependencies & Config" (case-insensitive, partial match)

  The agent's model field must be in "provider/model" format, e.g.:
  - google/gemini-3-flash-preview
  - anthropic/claude-sonnet-4

Examples:
  work execute --thread "01.01.01"
  work execute --thread "dependencies"
  work execute --thread "Server Module" --agent "backend-expert"
  work execute --thread "01.01.01" --dry-run
`);
}
function parseCliArgs34(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--thread":
      case "-t":
        if (!next) {
          console.error("Error: --thread requires a value");
          return null;
        }
        parsed.threadId = next;
        i++;
        break;
      case "--agent":
      case "-a":
        if (!next) {
          console.error("Error: --agent requires a value");
          return null;
        }
        parsed.agent = next;
        i++;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp36();
        process.exit(0);
    }
  }
  return parsed;
}
function isNumericThreadId(threadId) {
  const parts = threadId.split(".");
  if (parts.length !== 3)
    return false;
  return parts.every((p) => /^\d+$/.test(p));
}
function resolveThreadByName(doc, threadName) {
  const searchName = threadName.toLowerCase();
  for (const stage of doc.stages) {
    for (const batch of stage.batches) {
      for (const thread of batch.threads) {
        if (thread.name.toLowerCase().includes(searchName)) {
          const stageNum = stage.id.toString().padStart(2, "0");
          const batchNum = batch.id.toString().padStart(2, "0");
          const threadNum = thread.id.toString().padStart(2, "0");
          return {
            threadId: `${stageNum}.${batchNum}.${threadNum}`,
            threadName: thread.name,
            stageName: stage.name,
            batchName: batch.name
          };
        }
      }
    }
  }
  return null;
}
function getPromptFilePath(repoRoot, streamId, threadId) {
  const workDir = getWorkDir(repoRoot);
  const planPath = join30(workDir, streamId, "PLAN.md");
  if (!existsSync35(planPath)) {
    return null;
  }
  const planContent = readFileSync31(planPath, "utf-8");
  const errors2 = [];
  const doc = parseStreamDocument(planContent, errors2);
  if (!doc) {
    return null;
  }
  const parts = threadId.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    return null;
  }
  const [stageNum, batchNum, threadNum] = parts;
  const stage = doc.stages.find((s) => s.id === stageNum);
  if (!stage)
    return null;
  const batch = stage.batches.find((b2) => b2.id === batchNum);
  if (!batch)
    return null;
  const thread = batch.threads.find((t) => t.id === threadNum);
  if (!thread)
    return null;
  const safeStageName = stage.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const safeBatchName = batch.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const safeThreadName = thread.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const stagePrefix = stageNum.toString().padStart(2, "0");
  return join30(workDir, streamId, "prompts", `${stagePrefix}-${safeStageName}`, `${batch.prefix}-${safeBatchName}`, `${safeThreadName}.md`);
}
function getThreadAssignedAgent(repoRoot, streamId, threadId) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile)
    return;
  const parts = threadId.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 3)
    return;
  const [stageNum, batchNum, threadNum] = parts;
  for (const task of tasksFile.tasks) {
    try {
      const parsed = parseTaskId(task.id);
      if (parsed.stage === stageNum && parsed.batch === batchNum && parsed.thread === threadNum) {
        if (task.assigned_agent) {
          return task.assigned_agent;
        }
      }
    } catch {}
  }
  return;
}
async function main36(argv = process.argv) {
  const cliArgs = parseCliArgs34(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.threadId) {
    console.error("Error: --thread is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let resolvedThreadId = cliArgs.threadId;
  let threadDisplayName = cliArgs.threadId;
  if (!isNumericThreadId(cliArgs.threadId)) {
    const workDir = getWorkDir(repoRoot);
    const planPath = join30(workDir, stream.id, "PLAN.md");
    if (!existsSync35(planPath)) {
      console.error(`Error: PLAN.md not found for stream ${stream.id}`);
      process.exit(1);
    }
    const planContent = readFileSync31(planPath, "utf-8");
    const errors2 = [];
    const doc = parseStreamDocument(planContent, errors2);
    if (!doc) {
      console.error("Error: Could not parse PLAN.md");
      process.exit(1);
    }
    const resolved = resolveThreadByName(doc, cliArgs.threadId);
    if (!resolved) {
      console.error(`Error: Could not find thread matching "${cliArgs.threadId}"`);
      console.error(`
Available threads:`);
      for (const stage of doc.stages) {
        for (const batch of stage.batches) {
          for (const thread of batch.threads) {
            const id = `${stage.id.toString().padStart(2, "0")}.${batch.id.toString().padStart(2, "0")}.${thread.id.toString().padStart(2, "0")}`;
            console.error(`  ${id}: ${thread.name}`);
          }
        }
      }
      process.exit(1);
    }
    resolvedThreadId = resolved.threadId;
    threadDisplayName = `${resolved.threadName} (${resolved.threadId})`;
    console.log(`Resolved thread: "${cliArgs.threadId}" → ${threadDisplayName}`);
  }
  const promptPath = getPromptFilePath(repoRoot, stream.id, resolvedThreadId);
  if (!promptPath) {
    console.error(`Error: Could not find thread ${resolvedThreadId} in stream ${stream.id}`);
    process.exit(1);
  }
  if (!existsSync35(promptPath)) {
    console.error(`Error: Prompt file not found: ${promptPath}`);
    console.error(`
Hint: Run 'work prompt --thread "${resolvedThreadId}"' to generate it first.`);
    process.exit(1);
  }
  let agentName = cliArgs.agent;
  if (!agentName) {
    agentName = getThreadAssignedAgent(repoRoot, stream.id, resolvedThreadId);
  }
  if (!agentName) {
    agentName = "default";
  }
  const agentsConfig = loadAgentsConfig(repoRoot);
  if (!agentsConfig) {
    console.error("Error: No agents.yaml found. Run 'work init' to create one.");
    process.exit(1);
  }
  const models = getAgentModels(agentsConfig, agentName);
  if (models.length === 0) {
    console.error(`Error: Agent "${agentName}" not found in agents.yaml`);
    console.error(`
Available agents: ${agentsConfig.agents.map((a) => a.name).join(", ")}`);
    process.exit(1);
  }
  const primaryModel = models[0];
  const variantFlag = primaryModel.variant ? ` --variant "${primaryModel.variant}"` : "";
  const command = `cat "${promptPath}" | opencode run --model "${primaryModel.model}"${variantFlag}`;
  if (cliArgs.dryRun) {
    console.log("Would execute:");
    console.log(command);
    console.log(`
Thread: ${threadDisplayName}`);
    console.log(`Agent: ${agentName}`);
    console.log(`Model: ${primaryModel.model}${primaryModel.variant ? ` (variant: ${primaryModel.variant})` : ""}`);
    console.log(`Prompt: ${promptPath}`);
    return;
  }
  const threadParsed = parseThreadId(resolvedThreadId);
  const threadTasks = getTasksByThread(repoRoot, stream.id, threadParsed.stage, threadParsed.batch, threadParsed.thread);
  const modelString = primaryModel.variant ? `${primaryModel.model}:${primaryModel.variant}` : primaryModel.model;
  const sessionIds = new Map;
  for (const task of threadTasks) {
    const session = startTaskSession(repoRoot, stream.id, task.id, agentName, modelString);
    if (session) {
      sessionIds.set(task.id, session.sessionId);
    }
  }
  console.log(`Executing thread ${threadDisplayName} with agent "${agentName}" (${primaryModel.model})...`);
  console.log(`Session tracking: ${sessionIds.size} task(s)`);
  console.log(`Prompt: ${promptPath}
`);
  const child = spawn9("sh", ["-c", command], {
    stdio: "inherit",
    cwd: repoRoot
  });
  child.on("close", (code) => {
    const sessionStatus = code === 0 ? "completed" : "failed";
    for (const [taskId, sessionId] of sessionIds) {
      completeTaskSession(repoRoot, stream.id, taskId, sessionId, sessionStatus, code ?? undefined);
    }
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    for (const [taskId, sessionId] of sessionIds) {
      completeTaskSession(repoRoot, stream.id, taskId, sessionId, "failed");
    }
    console.error(`Error executing command: ${err.message}`);
    process.exit(1);
  });
}
if (false) {}

// src/cli/multi.ts
init_repo();
init_lib();
import { existsSync as existsSync36, readFileSync as readFileSync32 } from "fs";
init_tasks();
init_threads();
var DEFAULT_PORT3 = 4096;
function printHelp37() {
  console.log(`
work multi - Execute all threads in a batch in parallel

Usage:
  work multi --batch "01.01" [options]
  work multi --continue [options]

Required:
  --batch, -b      Batch ID to execute (format: "SS.BB", e.g., "01.02")
                   OR uses next incomplete batch if --continue is set

Optional:
  --continue, -c   Continue with the next incomplete batch
  --stream, -s     Workstream ID or name (uses current if not specified)
  --port, -p       OpenCode server port (default: 4096)
  --dry-run        Show commands without executing
  --no-server      Skip starting opencode serve (assume already running)
  --silent         Disable notification sounds (audio only)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Executes all threads in a batch simultaneously in parallel using tmux.
  Each thread runs in its own tmux window with a full opencode TUI.

  A shared opencode serve backend is started (unless --no-server) to
  eliminate MCP cold boot times and share model cache across threads.

Examples:
  work multi --batch "01.01"
  work multi --continue
  work multi --batch "01.01" --dry-run
  work multi --continue --dry-run
`);
}
function parseCliArgs35(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--batch":
      case "-b":
        if (!next) {
          console.error("Error: --batch requires a value");
          return null;
        }
        parsed.batch = next;
        i++;
        break;
      case "--continue":
      case "-c":
        parsed.continue = true;
        break;
      case "--port":
      case "-p":
        if (!next) {
          console.error("Error: --port requires a value");
          return null;
        }
        parsed.port = parseInt(next, 10);
        if (isNaN(parsed.port)) {
          console.error("Error: --port must be a number");
          return null;
        }
        i++;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--no-server":
        parsed.noServer = true;
        break;
      case "--silent":
        parsed.silent = true;
        break;
      case "--help":
      case "-h":
        printHelp37();
        process.exit(0);
    }
  }
  return parsed;
}
function findNextIncompleteBatch2(tasks) {
  const batches = new Map;
  for (const task of tasks) {
    try {
      const parsed = parseTaskId(task.id);
      if (!parsed)
        continue;
      const batchId = `${parsed.stage.toString().padStart(2, "0")}.${parsed.batch.toString().padStart(2, "0")}`;
      if (!batches.has(batchId)) {
        batches.set(batchId, []);
      }
      batches.get(batchId).push(task);
    } catch {}
  }
  const sortedBatchIds = Array.from(batches.keys()).sort();
  for (const batchId of sortedBatchIds) {
    const batchTasks = batches.get(batchId);
    const allDone = batchTasks.every((t) => t.status === "completed" || t.status === "cancelled");
    if (!allDone) {
      return batchId;
    }
  }
  return null;
}
function printDryRunOutput2(stream, batchId, stageName, batchName, threads, sessionName, port, noServer, repoRoot, synthesisConfigEnabled, synthesisAgentName) {
  const synthesisEnabled = synthesisConfigEnabled && threads.some((t) => t.synthesisModels && t.synthesisModels.length > 0);
  console.log(`=== DRY RUN ===
`);
  console.log(`Stream: ${stream.id}`);
  console.log(`Batch: ${batchId} (${stageName} -> ${batchName})`);
  console.log(`Threads: ${threads.length}`);
  console.log(`Session: ${sessionName}`);
  console.log(`Port: ${port}`);
  console.log(`Synthesis config: work/synthesis.json`);
  if (synthesisConfigEnabled) {
    if (synthesisAgentName) {
      console.log(`Synthesis: enabled (${synthesisAgentName})`);
      if (synthesisEnabled) {
        console.log(`Mode: Post-Session Synthesis (working agent runs first with TUI, synthesis runs after)`);
      }
    } else {
      console.log(`Synthesis: enabled but no agent configured`);
    }
  } else {
    console.log(`Synthesis: disabled`);
  }
  console.log("");
  if (!noServer) {
    console.log("# Start opencode serve");
    console.log(buildServeCommand(port));
    console.log("");
  }
  console.log("# Create tmux session (Window 0: Dashboard)");
  const firstThread = threads[0];
  const firstCmd = buildThreadRunCommand(firstThread, port, stream.id);
  console.log(buildCreateSessionCommand(sessionName, "Dashboard", firstCmd));
  console.log("");
  console.log("# Add thread windows (Background)");
  if (threads.length > 1) {
    for (let i = 1;i < threads.length; i++) {
      const thread = threads[i];
      const cmd = buildThreadRunCommand(thread, port, stream.id);
      console.log(buildAddWindowCommand(sessionName, thread.threadId, cmd));
    }
    console.log("");
  }
  console.log("# Setup Dashboard Layout");
  const navigatorCmd = `bun work multi-navigator --session "${sessionName}" --batch "${batchId}" --repo-root "${repoRoot}" --stream "${stream.id}"`;
  console.log(`tmux split-window -t "${sessionName}:0" -h -b -l 25% "${navigatorCmd}"`);
  console.log("");
  console.log("# Attach to session");
  console.log(buildAttachCommand(sessionName));
  console.log("");
  console.log("=== Thread Details ===");
  for (const thread of threads) {
    const synthIndicator = thread.synthesisModels ? " [synthesis]" : "";
    console.log(`
${thread.threadId}: ${thread.threadName}${synthIndicator}`);
    console.log(`  Agent: ${thread.agentName}`);
    console.log(`  Working Models: ${thread.models.map((m2) => m2.model).join(" → ")}`);
    if (thread.synthesisModels) {
      console.log(`  Synthesis Models: ${thread.synthesisModels.map((m2) => m2.model).join(" → ")}`);
    }
    console.log(`  Prompt: ${thread.promptPath}`);
  }
}
async function handleSessionClose2(code, sessionName, threadSessionMap, threadIds, notificationTracker, repoRoot, streamId, pollingState, pollingPromise) {
  pollingState.active = false;
  try {
    await pollingPromise;
  } catch {}
  console.log(`
Session detached. Checking thread statuses...`);
  const completions = [];
  if (threadSessionMap.length > 0) {
    if (sessionExists(sessionName)) {
      const paneStatuses = getSessionPaneStatuses(sessionName);
      for (const mapping of threadSessionMap) {
        const paneStatus = paneStatuses.find((p) => p.paneId === mapping.paneId);
        if (paneStatus && paneStatus.paneDead) {
          const exitCode = paneStatus.exitStatus ?? undefined;
          const status = exitCode === 0 ? "completed" : "failed";
          completions.push({
            taskId: mapping.taskId,
            sessionId: mapping.sessionId,
            status,
            exitCode
          });
          console.log(`  Thread ${mapping.threadId}: ${status}${exitCode !== undefined ? ` (exit ${exitCode})` : ""}`);
          if (status === "failed") {
            notificationTracker?.playError(mapping.threadId);
          }
        } else if (paneStatus && !paneStatus.paneDead) {
          console.log(`  Thread ${mapping.threadId}: still running`);
        } else {
          completions.push({
            taskId: mapping.taskId,
            sessionId: mapping.sessionId,
            status: "interrupted"
          });
          console.log(`  Thread ${mapping.threadId}: interrupted (pane not found)`);
        }
      }
      console.log(`
Windows remain in tmux session "${sessionName}".`);
      console.log(`To reattach: tmux attach -t "${sessionName}"`);
      console.log(`To kill: tmux kill-session -t "${sessionName}"`);
    } else {
      console.log("Session closed. Marking all threads as completed...");
      for (const mapping of threadSessionMap) {
        completions.push({
          taskId: mapping.taskId,
          sessionId: mapping.sessionId,
          status: "completed"
        });
        console.log(`  Thread ${mapping.threadId}: completed`);
      }
      notificationTracker?.playBatchComplete();
    }
    if (completions.length > 0) {
      console.log(`
Updating ${completions.length} session statuses in tasks.json...`);
      await completeMultipleSessionsLocked(repoRoot, streamId, completions);
    }
    console.log(`
Capturing opencode session IDs and synthesis output...`);
    for (const mapping of threadSessionMap) {
      const sessionFilePath = getSessionFilePath(mapping.threadId);
      const workingAgentSessionPath = getWorkingAgentSessionPath(streamId, mapping.threadId);
      const synthesisOutputPath = getSynthesisOutputPath(streamId, mapping.threadId);
      const sessionUpdates = {};
      if (existsSync36(sessionFilePath)) {
        try {
          const opencodeSessionId = readFileSync32(sessionFilePath, "utf-8").trim();
          if (opencodeSessionId) {
            sessionUpdates.opencodeSessionId = opencodeSessionId;
          }
        } catch (e) {
          console.log(`  Thread ${mapping.threadId}: failed to read session file (${e.message})`);
        }
      }
      if (existsSync36(workingAgentSessionPath)) {
        try {
          const workingAgentSessionId = readFileSync32(workingAgentSessionPath, "utf-8").trim();
          if (workingAgentSessionId) {
            sessionUpdates.workingAgentSessionId = workingAgentSessionId;
          }
        } catch (e) {
          console.log(`  Thread ${mapping.threadId}: failed to read working agent session file (${e.message})`);
        }
      }
      let synthesisOutputText = null;
      const synthesisJsonPath = `/tmp/workstream-${streamId}-${mapping.threadId}-synthesis.json`;
      if (existsSync36(synthesisJsonPath)) {
        try {
          const logPath = getSynthesisLogPath(streamId, mapping.threadId);
          const parseResult = parseSynthesisOutputFile(synthesisJsonPath, logPath);
          if (!parseResult.success) {
            console.log(`  Thread ${mapping.threadId}: synthesis output parsing failed (see ${logPath})`);
          }
          synthesisOutputText = parseResult.text.trim();
          if (!synthesisOutputText) {
            console.log(`  Thread ${mapping.threadId}: synthesis output is empty`);
            synthesisOutputText = "";
          }
        } catch (e) {
          console.log(`  Thread ${mapping.threadId}: failed to parse synthesis output file (${e.message})`);
          synthesisOutputText = null;
        }
      }
      if (sessionUpdates.opencodeSessionId || sessionUpdates.workingAgentSessionId) {
        const updateData = {};
        if (sessionUpdates.opencodeSessionId)
          updateData.opencodeSessionId = sessionUpdates.opencodeSessionId;
        if (sessionUpdates.workingAgentSessionId)
          updateData.workingAgentSessionId = sessionUpdates.workingAgentSessionId;
        await updateThreadMetadataLocked(repoRoot, streamId, mapping.threadId, updateData);
      }
      if (synthesisOutputText !== null) {
        const completedAt = new Date().toISOString();
        const synthesisSessionId = `synthesis-${mapping.threadId}-${Date.now()}`;
        await setSynthesisOutput(repoRoot, streamId, mapping.threadId, {
          sessionId: synthesisSessionId,
          output: synthesisOutputText,
          completedAt
        });
      }
      const hasSynthOutput = synthesisOutputText !== null;
      if (sessionUpdates.opencodeSessionId) {
        console.log(`  Thread ${mapping.threadId}: captured working session ${sessionUpdates.opencodeSessionId}${hasSynthOutput ? ", synthesis output" : ""}`);
      } else if (hasSynthOutput) {
        console.log(`  Thread ${mapping.threadId}: captured synthesis output`);
      } else if (!sessionUpdates.opencodeSessionId && !sessionUpdates.workingAgentSessionId) {
        console.log(`  Thread ${mapping.threadId}: no session file found`);
      }
    }
    cleanupCompletionMarkers(threadIds);
    cleanupSessionFiles(threadIds);
    cleanupSynthesisFiles(streamId, threadIds);
  }
  process.exit(code ?? 0);
}
async function main37(argv = process.argv) {
  const cliArgs = parseCliArgs35(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!cliArgs.batch && !cliArgs.continue) {
    console.error("Error: Either --batch or --continue is required");
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let batchId = cliArgs.batch;
  if (cliArgs.continue) {
    const tasksFile = readTasksFile(repoRoot, stream.id);
    if (!tasksFile) {
      console.error(`Error: No tasks found for stream ${stream.id}`);
      process.exit(1);
    }
    const nextBatch = findNextIncompleteBatch2(tasksFile.tasks);
    if (!nextBatch) {
      console.log("All batches are complete! Nothing to continue.");
      process.exit(0);
    }
    batchId = nextBatch;
    console.log(`Continuing with next incomplete batch: ${batchId}`);
  }
  if (!batchId) {
    console.error("Error: No batch specified and could not determine next batch");
    process.exit(1);
  }
  const batchParsed = parseBatchId(batchId);
  if (!batchParsed) {
    console.error(`Error: Invalid batch ID "${batchId}". Expected format: "SS.BB" (e.g., "01.02")`);
    process.exit(1);
  }
  if (batchParsed.stage > 1) {
    const prevStageNum = batchParsed.stage - 1;
    const approvalStatus = getStageApprovalStatus(stream, prevStageNum);
    if (approvalStatus !== "approved") {
      console.error(`Error: Previous stage (Stage ${prevStageNum}) is not approved.`);
      console.error(`
You must approve the outputs of Stage ${prevStageNum} before proceeding to Stage ${batchParsed.stage}.`);
      console.error(`Run: work approve stage ${prevStageNum}`);
      process.exit(1);
    }
  }
  const agentsConfig = loadAgentsConfig(repoRoot);
  if (!agentsConfig) {
    console.error("Error: No agents.yaml found. Run 'work init' to create one.");
    process.exit(1);
  }
  const synthesisConfigEnabled = isSynthesisEnabled(repoRoot);
  let synthesisAgent = null;
  if (synthesisConfigEnabled) {
    const agentOverride = getSynthesisAgentOverride(repoRoot);
    if (agentOverride) {
      synthesisAgent = getSynthesisAgent(agentsConfig, agentOverride);
      if (!synthesisAgent) {
        console.log(`Synthesis agent override "${agentOverride}" not found in agents.yaml, using default`);
        synthesisAgent = getDefaultSynthesisAgent(agentsConfig);
      }
    } else {
      synthesisAgent = getDefaultSynthesisAgent(agentsConfig);
    }
    if (synthesisAgent) {
      const synthModels = getSynthesisAgentModels(agentsConfig, synthesisAgent.name);
      console.log(`Synthesis enabled: ${synthesisAgent.name} (${synthModels.length} model(s))`);
    } else {
      console.log(`Synthesis enabled but no synthesis agent configured in agents.yaml`);
    }
  } else {
    console.log(`Synthesis: disabled (work/synthesis.json)`);
  }
  const threads = collectThreadInfoFromTasks(repoRoot, stream.id, batchParsed.stage, batchParsed.batch, agentsConfig, synthesisAgent);
  if (threads.length === 0) {
    console.error(`Error: No tasks found for batch ${batchId} in stream ${stream.id}`);
    console.error(`
Hint: Make sure tasks.json has tasks for this batch.`);
    process.exit(1);
  }
  if (threads.length > MAX_THREADS_PER_BATCH) {
    console.error(`Error: Batch has ${threads.length} threads, but max is ${MAX_THREADS_PER_BATCH}`);
    console.error(`
Hint: Split this batch into smaller batches or increase MAX_THREADS_PER_BATCH.`);
    process.exit(1);
  }
  const batchMeta = getBatchMetadata(repoRoot, stream.id, batchParsed.stage, batchParsed.batch);
  const stageName = batchMeta?.stageName || `Stage ${batchParsed.stage}`;
  const batchName = batchMeta?.batchName || `Batch ${batchParsed.batch}`;
  const missingPrompts = validateThreadPrompts(threads);
  if (missingPrompts.length > 0) {
    console.error("Error: Missing prompt files:");
    for (const msg of missingPrompts) {
      console.error(msg);
    }
    console.error(`
Hint: Run 'work prompt --stage ${batchParsed.stage} --batch ${batchParsed.batch}' to generate them.`);
    process.exit(1);
  }
  const port = cliArgs.port ?? DEFAULT_PORT3;
  const sessionName = getWorkSessionName(stream.id);
  if (cliArgs.dryRun) {
    printDryRunOutput2(stream, batchId, stageName, batchName, threads, sessionName, port, cliArgs.noServer ?? false, repoRoot, synthesisConfigEnabled, synthesisAgent?.name ?? null);
    return;
  }
  if (sessionExists(sessionName)) {
    console.error(`Error: tmux session "${sessionName}" already exists.`);
    console.error(`
Options:`);
    console.error(`  1. Attach to it: tmux attach -t "${sessionName}"`);
    console.error(`  2. Kill it: tmux kill-session -t "${sessionName}"`);
    process.exit(1);
  }
  console.log("Generating session IDs for thread tracking...");
  for (const thread of threads) {
    thread.sessionId = generateSessionId();
  }
  const sessionsToStart = threads.filter((t) => t.firstTaskId && t.sessionId).map((t) => ({
    taskId: t.firstTaskId,
    agentName: t.agentName,
    model: t.models[0]?.model || "unknown",
    sessionId: t.sessionId
  }));
  if (sessionsToStart.length > 0) {
    console.log(`Starting ${sessionsToStart.length} sessions in tasks.json...`);
    await startMultipleSessionsLocked(repoRoot, stream.id, sessionsToStart);
  }
  if (!cliArgs.noServer) {
    const serverRunning = await isServerRunning(port);
    if (!serverRunning) {
      console.log(`Starting opencode serve on port ${port}...`);
      startServer(port, repoRoot);
      console.log("Waiting for server to be ready...");
      const ready = await waitForServer(port, 30000);
      if (!ready) {
        console.error(`Error: opencode serve did not start within 30 seconds`);
        process.exit(1);
      }
      console.log(`Server ready.
`);
    } else {
      console.log(`opencode serve already running on port ${port}
`);
    }
  }
  console.log(`Creating tmux session "${sessionName}"...`);
  const { threadSessionMap } = setupTmuxSession(sessionName, threads, port, repoRoot, stream.id, batchId);
  console.log(`  Tracking ${threadSessionMap.length} thread sessions`);
  await setupGridController(sessionName, threads, port, batchId, repoRoot, stream.id);
  setupKillSessionKeybind();
  console.log(`
Layout: ${threads.length <= 4 ? "2x2 Grid (all visible)" : `2x2 Grid with pagination (${threads.length} threads, use n/p to page)`}
Press Ctrl+b X to kill the session when done.
`);
  console.log(`Attaching to session "${sessionName}"...`);
  const child = attachSession(sessionName);
  const notificationTracker = cliArgs.silent ? null : new NotificationTracker({ repoRoot });
  const threadIds = threads.map((t) => t.threadId);
  const { promise: pollingPromise, state: pollingState } = startMarkerPolling({
    threadIds,
    notificationTracker,
    streamId: stream.id
  });
  child.on("close", async (code) => {
    await handleSessionClose2(code, sessionName, threadSessionMap, threadIds, notificationTracker, repoRoot, stream.id, pollingState, pollingPromise);
  });
  child.on("error", (err) => {
    console.error(`Error attaching to tmux session: ${err.message}`);
    notificationTracker?.playError("__session_error__");
    process.exit(1);
  });
}
if (false) {}

// src/cli/multi-navigator.ts
init_repo();
init_tasks();
init_stream_parser();
import { join as join31 } from "path";
import { readFileSync as readFileSync33 } from "fs";
import readline2 from "readline";
function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
        parsed.streamId = next;
        i++;
        break;
      case "--batch":
        parsed.batch = next;
        i++;
        break;
      case "--session":
        parsed.session = next;
        i++;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
    }
  }
  return parsed;
}
function getThreadStatus(tasks, threadId) {
  const threadTasks = tasks.filter((t) => t.id.startsWith(threadId));
  if (threadTasks.length === 0)
    return "pending";
  if (threadTasks.some((t) => t.status === "blocked"))
    return "failed";
  if (threadTasks.some((t) => t.status === "in_progress"))
    return "running";
  if (threadTasks.every((t) => t.status === "completed"))
    return "completed";
  return "pending";
}

class Navigator {
  threads = [];
  selectedIndex = 0;
  sessionName;
  currentContentPaneId = null;
  repoRoot;
  streamId;
  constructor(repoRoot, streamId, threads, sessionName) {
    this.repoRoot = repoRoot;
    this.streamId = streamId;
    this.threads = threads;
    this.sessionName = sessionName;
  }
  start() {
    readline2.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.on("keypress", (str, key) => {
      if (key.ctrl && key.name === "c") {
        this.exit();
      } else if (key.name === "q") {
        this.exit();
      } else if (key.name === "up" || key.name === "k") {
        this.moveSelection(-1);
      } else if (key.name === "down" || key.name === "j") {
        this.moveSelection(1);
      } else if (key.name === "return" || key.name === "enter") {
        this.activateThread(this.selectedIndex);
      } else if (key.name === "i") {
        this.enterInteractiveMode();
      } else if (key.name === "x") {
        this.killSessionIfDone();
      }
    });
    this.render();
    setInterval(() => this.updateStatus(), 1000);
  }
  exit() {
    console.clear();
    process.exit(42);
  }
  moveSelection(delta) {
    const newIndex = this.selectedIndex + delta;
    if (newIndex >= 0 && newIndex < this.threads.length) {
      this.selectedIndex = newIndex;
      this.render();
    }
  }
  updateStatus() {
    try {
      const tasksFile = readTasksFile(this.repoRoot, this.streamId);
      if (!tasksFile)
        return;
      let changed = false;
      for (const thread of this.threads) {
        const newStatus = getThreadStatus(tasksFile.tasks, thread.id);
        if (newStatus !== thread.status) {
          thread.status = newStatus;
          changed = true;
        }
      }
      if (changed)
        this.render();
    } catch (e) {}
  }
  enterInteractiveMode() {
    const myPaneId = process.env.TMUX_PANE;
    if (!myPaneId)
      return;
    try {
      Bun.spawnSync(["tmux", "select-pane", "-t", `${this.sessionName}:0.+`]);
    } catch (e) {}
  }
  killSessionIfDone() {
    const allDone = this.threads.every((t) => t.status === "completed" || t.status === "failed");
    if (allDone) {
      Bun.spawnSync(["tmux", "kill-session", "-t", this.sessionName]);
      process.exit(0);
    }
  }
  log(msg) {
    const fs = __require("fs");
    if (fs) {
      fs.appendFileSync("/tmp/work-navigator.log", `[${new Date().toISOString()}] ${msg}
`);
    }
  }
  async activateThread(index) {
    const targetThread = this.threads[index];
    const myPaneId = process.env.TMUX_PANE;
    this.log(`activateThread(${index}): myPaneId=${myPaneId}`);
    if (!myPaneId)
      return;
    if (this.activeThreadIndex === index) {
      this.log(`Already active index ${index}`);
      return;
    }
    const newThread = this.threads[index];
    this.log(`Switching to ${newThread.id} (Window: ${newThread.windowName})`);
    try {
      const selectCmd = ["tmux", "select-window", "-t", `${this.sessionName}:${newThread.windowName}`];
      this.log(`Running: ${selectCmd.join(" ")}`);
      const res = Bun.spawnSync(selectCmd);
      if (res.exitCode !== 0) {
        this.log(`select-window failed: ${await new Response(res.stderr).text()}`);
      }
      this.activeThreadIndex = index;
      this.render();
      this.log(`Switch complete`);
    } catch (e) {
      this.log(`Exception during switch: ${e}`);
    }
  }
  activeThreadIndex = 0;
  render() {
    console.clear();
    console.log(`
  \x1B[1m\x1B[36mWORK SESSIONS\x1B[0m
`);
    this.threads.forEach((thread, idx) => {
      const isSelected = idx === this.selectedIndex;
      const isActive = idx === this.activeThreadIndex;
      let icon = "○";
      let color = "\x1B[37m";
      if (thread.status === "running") {
        icon = "◐";
        color = "\x1B[36m";
      } else if (thread.status === "completed") {
        icon = "●";
        color = "\x1B[32m";
      } else if (thread.status === "failed") {
        icon = "x";
        color = "\x1B[31m";
      }
      const prefix = isSelected ? " \x1B[36m>\x1B[0m " : "   ";
      const nameColor = isSelected ? "\x1B[1m\x1B[37m" : "\x1B[37m";
      const activeMarker = isActive ? "\x1B[33m*\x1B[0m" : " ";
      console.log(`${prefix}${color}${icon}\x1B[0m ${nameColor}${thread.name}\x1B[0m ${activeMarker}`);
    });
    const allDone = this.threads.every((t) => t.status === "completed" || t.status === "failed");
    console.log(`
  \x1B[90mUse j/k to navigate\x1B[0m`);
    console.log(`  \x1B[90mi: interact / q: quit\x1B[0m`);
    if (allDone) {
      console.log(`  \x1B[32mx: kill session (all done)\x1B[0m`);
    }
  }
}
async function main38(argv = process.argv) {
  const args = parseArgs(argv);
  if (!args || !args.batch || !args.session) {
    console.error("Missing required arguments. Need --batch and --session");
    process.exit(1);
  }
  const repoRoot = args.repoRoot || getRepoRoot();
  const streamId = args.streamId || "default";
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile) {
    console.error("No tasks found");
    process.exit(1);
  }
  const batchPrefix = args.batch;
  const threadMap = new Map;
  tasksFile.tasks.forEach((t) => {
    const parsed = parseTaskId(t.id);
    if (!parsed)
      return;
    const tId = `${parsed.stage.toString().padStart(2, "0")}.${parsed.batch.toString().padStart(2, "0")}.${parsed.thread.toString().padStart(2, "0")}`;
    if (tId.startsWith(batchPrefix)) {
      threadMap.set(tId, "Thread " + parsed.thread);
    }
  });
  const { loadIndex: loadIndex2, getResolvedStream: getResolvedStream4 } = await Promise.resolve().then(() => (init_lib(), exports_lib));
  const idx = loadIndex2(repoRoot);
  const stream = getResolvedStream4(idx, streamId);
  const planPath = join31(repoRoot, "agenv", "work", stream.id, "PLAN.md");
  const { getWorkDir: getWorkDir3 } = await Promise.resolve().then(() => (init_repo(), exports_repo));
  const wDir = getWorkDir3(repoRoot);
  const pPath = join31(wDir, stream.id, "PLAN.md");
  const content = readFileSync33(pPath, "utf-8");
  const doc = parseStreamDocument(content, []);
  if (!doc)
    process.exit(1);
  const [sStr, bStr] = args.batch.split(".");
  const sNum = parseInt(sStr);
  const bNum = parseInt(bStr);
  const stage = doc.stages.find((s) => s.id === sNum);
  const batch = stage?.batches.find((b2) => b2.id === bNum);
  if (!batch)
    process.exit(1);
  const threads = batch.threads.map((t, idx2) => {
    const tId = `${sStr}.${bStr}.${t.id.toString().padStart(2, "0")}`;
    return {
      id: tId,
      name: t.name,
      windowName: `T${idx2 + 1}`,
      status: "pending"
    };
  });
  const app = new Navigator(repoRoot, streamId, threads, args.session);
  app.start();
}
if (false) {}

// src/cli/multi-grid.ts
init_repo();
init_tasks();
init_lib();
init_stream_parser();
import { join as join32 } from "path";
import { readFileSync as readFileSync34 } from "fs";
import readline3 from "readline";
function parseArgs2(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
        parsed.streamId = next;
        i++;
        break;
      case "--batch":
        parsed.batch = next;
        i++;
        break;
      case "--session":
        parsed.session = next;
        i++;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
    }
  }
  return parsed;
}
function getThreadStatus2(tasks, threadId) {
  const threadTasks = tasks.filter((t) => t.id.startsWith(threadId));
  if (threadTasks.length === 0)
    return "pending";
  if (threadTasks.some((t) => t.status === "blocked"))
    return "failed";
  if (threadTasks.some((t) => t.status === "in_progress"))
    return "running";
  if (threadTasks.every((t) => t.status === "completed"))
    return "completed";
  return "pending";
}

class GridController {
  threads = [];
  sessionName;
  repoRoot;
  streamId;
  paneIds = [];
  offset = 0;
  gridSize = 4;
  constructor(repoRoot, streamId, threads, sessionName, paneIds) {
    this.repoRoot = repoRoot;
    this.streamId = streamId;
    this.threads = threads;
    this.sessionName = sessionName;
    this.paneIds = paneIds;
  }
  start() {
    readline3.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.on("keypress", (str, key) => {
      if (key.ctrl && key.name === "c") {
        this.exit();
      } else if (key.name === "q") {
        this.exit();
      } else if (key.name === "n" || key.name === "right") {
        this.nextPage();
      } else if (key.name === "p" || key.name === "left") {
        this.prevPage();
      } else if (key.name === "x") {
        this.killSessionIfDone();
      } else if (key.name === "1") {
        this.focusPane(0);
      } else if (key.name === "2") {
        this.focusPane(1);
      } else if (key.name === "3") {
        this.focusPane(2);
      } else if (key.name === "4") {
        this.focusPane(3);
      }
    });
    this.render();
    setInterval(() => this.updateStatus(), 2000);
  }
  exit() {
    console.clear();
    process.exit(42);
  }
  nextPage() {
    const maxOffset = Math.max(0, this.threads.length - this.gridSize);
    if (this.offset >= maxOffset) {
      return;
    }
    this.offset++;
    this.updatePaneContents();
    this.render();
  }
  prevPage() {
    if (this.offset <= 0) {
      return;
    }
    this.offset--;
    this.updatePaneContents();
    this.render();
  }
  updatePaneContents() {
    const positions = [0, 1, 2, 3];
    for (const pos of positions) {
      const threadIdx = this.offset + pos;
      if (threadIdx < this.threads.length && this.paneIds[pos]) {
        const thread = this.threads[threadIdx];
        respawnPane(this.paneIds[pos], thread.command);
      }
    }
  }
  focusPane(position) {
    if (this.paneIds[position]) {
      selectPane(this.paneIds[position]);
    }
  }
  updateStatus() {
    try {
      const tasksFile = readTasksFile(this.repoRoot, this.streamId);
      if (!tasksFile)
        return;
      let changed = false;
      for (const thread of this.threads) {
        const newStatus = getThreadStatus2(tasksFile.tasks, thread.id);
        if (newStatus !== thread.status) {
          thread.status = newStatus;
          changed = true;
        }
      }
      if (changed)
        this.render();
    } catch {}
  }
  killSessionIfDone() {
    const allDone = this.threads.every((t) => t.status === "completed" || t.status === "failed");
    if (allDone) {
      Bun.spawnSync(["tmux", "kill-session", "-t", this.sessionName]);
      process.exit(0);
    }
  }
  render() {
    console.clear();
    const currentPage = Math.floor(this.offset / 1) + 1;
    const totalPages = Math.max(1, this.threads.length - this.gridSize + 1);
    const visibleThreads = this.threads.slice(this.offset, this.offset + this.gridSize);
    const statusLine = visibleThreads.map((t, i) => {
      const pos = i + 1;
      let icon = "○";
      let color = "\x1B[37m";
      if (t.status === "running") {
        icon = "◐";
        color = "\x1B[36m";
      } else if (t.status === "completed") {
        icon = "●";
        color = "\x1B[32m";
      } else if (t.status === "failed") {
        icon = "✗";
        color = "\x1B[31m";
      }
      return `${color}${pos}:${icon}\x1B[0m`;
    }).join("  ");
    const allDone = this.threads.every((t) => t.status === "completed" || t.status === "failed");
    let bar = ` ${statusLine}`;
    if (this.threads.length > this.gridSize) {
      bar += `  \x1B[90m[${this.offset + 1}-${Math.min(this.offset + this.gridSize, this.threads.length)}/${this.threads.length}]\x1B[0m`;
      bar += `  \x1B[90mn/p:page\x1B[0m`;
    }
    bar += `  \x1B[90m1-4:focus  q:quit\x1B[0m`;
    if (allDone) {
      bar += `  \x1B[32mx:kill\x1B[0m`;
    }
    console.log(bar);
  }
}
async function main39(argv = process.argv) {
  const args = parseArgs2(argv);
  if (!args || !args.batch || !args.session) {
    console.error("Missing required arguments. Need --batch and --session");
    process.exit(1);
  }
  const repoRoot = args.repoRoot || getRepoRoot();
  const streamId = args.streamId || "default";
  const idx = loadIndex(repoRoot);
  const stream = getResolvedStream(idx, streamId);
  const wDir = getWorkDir(repoRoot);
  const pPath = join32(wDir, stream.id, "PLAN.md");
  const content = readFileSync34(pPath, "utf-8");
  const doc = parseStreamDocument(content, []);
  if (!doc)
    process.exit(1);
  const [sStr, bStr] = args.batch.split(".");
  const sNum = parseInt(sStr);
  const bNum = parseInt(bStr);
  const stage = doc.stages.find((s) => s.id === sNum);
  const batch = stage?.batches.find((b2) => b2.id === bNum);
  if (!batch)
    process.exit(1);
  const threads = batch.threads.map((t) => {
    const tId = `${sStr}.${bStr}.${t.id.toString().padStart(2, "0")}`;
    return {
      id: tId,
      name: t.name,
      command: process.env[`THREAD_CMD_${t.id}`] || `echo "Thread ${t.id}: ${t.name}"`,
      status: "pending"
    };
  });
  const paneIds = listPaneIds(`${args.session}:0`);
  const controller = new GridController(repoRoot, streamId, threads, args.session, paneIds);
  controller.start();
}
if (false) {}

// src/cli/tree.ts
init_repo();
init_lib();
init_tasks();
function printHelp38() {
  console.log(`
work tree - Show workstream structure tree

Usage:
  work tree [--stream <stream-id>] [--batch <batch-id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --batch, -b      Filter to a specific batch (e.g., "01.01")
  --help, -h       Show this help message

Examples:
  work tree
  work tree --stream "001-migration"
  work tree --batch "01.01"
`);
}
function parseCliArgs36(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--batch":
      case "-b":
        if (!next) {
          console.error("Error: --batch requires a value");
          return null;
        }
        parsed.batchId = next;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp38();
        process.exit(0);
    }
  }
  return parsed;
}
function aggregateStatus(tasks) {
  if (tasks.length === 0)
    return "pending";
  if (tasks.some((t) => t.status === "blocked"))
    return "blocked";
  if (tasks.some((t) => t.status === "in_progress"))
    return "in_progress";
  if (tasks.some((t) => t.status === "pending"))
    return "pending";
  return "completed";
}
function statusToIcon2(status) {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[~]";
    case "blocked":
      return "[!]";
    case "pending":
      return "[ ]";
    case "cancelled":
      return "[-]";
    default:
      return "[ ]";
  }
}
function main40(argv = process.argv) {
  const cliArgs = parseCliArgs36(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let tasks = getTasks(repoRoot, stream.id);
  if (tasks.length === 0) {
    console.log(`Workstream: ${stream.id} (Empty)`);
    return;
  }
  if (cliArgs.batchId) {
    const [stageNum, batchNum] = cliArgs.batchId.split(".");
    if (!stageNum || !batchNum) {
      console.error(`Error: Invalid batch ID format "${cliArgs.batchId}". Expected format: "01.01"`);
      process.exit(1);
    }
    const stagePrefix = stageNum.padStart(2, "0");
    const batchPrefix = `${stagePrefix}.${batchNum.padStart(2, "0")}`;
    tasks = tasks.filter((t) => t.id.startsWith(batchPrefix + "."));
    if (tasks.length === 0) {
      console.log(`Batch ${cliArgs.batchId}: No tasks found`);
      return;
    }
  }
  const grouped = groupTasks(tasks, { byBatch: true });
  const streamStatus = aggregateStatus(tasks);
  console.log(`${statusToIcon2(streamStatus)} Workstream: ${stream.id} (${tasks.length})`);
  const sortedStages = Array.from(grouped.entries()).sort((a, b2) => {
    const taskA = a[1].values().next().value?.values().next().value?.[0];
    const taskB = b2[1].values().next().value?.values().next().value?.[0];
    if (taskA && taskB) {
      return taskA.id.localeCompare(taskB.id);
    }
    return a[0].localeCompare(b2[0]);
  });
  for (const [stageIndex, [stageName, batchMap]] of sortedStages.entries()) {
    const isLastStage = stageIndex === sortedStages.length - 1;
    const stagePrefix = isLastStage ? "└── " : "├── ";
    const stageChildPrefix = isLastStage ? "    " : "│   ";
    const stageTasks = [];
    for (const batch of batchMap.values()) {
      for (const thread of batch.values()) {
        stageTasks.push(...thread);
      }
    }
    const stageStatus = aggregateStatus(stageTasks);
    const firstTask = stageTasks[0];
    const stageNum = firstTask ? firstTask.id.split(".")[0] : "?";
    console.log(`${stagePrefix}${statusToIcon2(stageStatus)} Stage ${stageNum}: ${stageName} (${stageTasks.length})`);
    const sortedBatches = Array.from(batchMap.entries()).sort((a, b2) => {
      const taskA = a[1].values().next().value?.[0];
      const taskB = b2[1].values().next().value?.[0];
      if (taskA && taskB) {
        return taskA.id.localeCompare(taskB.id);
      }
      return a[0].localeCompare(b2[0]);
    });
    for (const [batchIndex, [batchName, threadMap]] of sortedBatches.entries()) {
      const isLastBatch = batchIndex === sortedBatches.length - 1;
      const batchPrefix = isLastBatch ? "└── " : "├── ";
      const batchChildPrefix = isLastBatch ? "    " : "│   ";
      const batchTasks = [];
      for (const thread of threadMap.values()) {
        batchTasks.push(...thread);
      }
      const batchStatus = aggregateStatus(batchTasks);
      const firstBatchTask = batchTasks[0];
      const batchNum = firstBatchTask ? firstBatchTask.id.split(".")[1] : "?";
      console.log(`${stageChildPrefix}${batchPrefix}${statusToIcon2(batchStatus)} Batch ${batchNum}: ${batchName} (${batchTasks.length})`);
      const sortedThreads = Array.from(threadMap.entries()).sort((a, b2) => {
        const taskA = a[1][0];
        const taskB = b2[1][0];
        if (taskA && taskB)
          return taskA.id.localeCompare(taskB.id);
        return a[0].localeCompare(b2[0]);
      });
      for (const [threadIndex, [threadName, tasks2]] of sortedThreads.entries()) {
        const isLastThread = threadIndex === sortedThreads.length - 1;
        const threadPrefix = isLastThread ? "└── " : "├── ";
        const threadStatus = aggregateStatus(tasks2);
        const threadNum = tasks2[0] ? tasks2[0].id.split(".")[2] : "?";
        const assignedAgent = tasks2.find((t) => t.assigned_agent)?.assigned_agent;
        const agentDisplay = assignedAgent ? ` @${assignedAgent}` : "";
        console.log(`${stageChildPrefix}${batchChildPrefix}${threadPrefix}${statusToIcon2(threadStatus)} Thread ${threadNum}: ${threadName} (${tasks2.length})${agentDisplay}`);
      }
    }
  }
}
if (false) {}

// src/cli/github.ts
init_repo();
init_lib();
init_tasks();
var SUBCOMMANDS = ["enable", "disable", "status", "create-branch", "create-issues", "sync"];
function printHelp39() {
  console.log(`
work github - GitHub integration management

Usage:
  work github <subcommand> [options]

Subcommands:
  enable        Enable GitHub integration (auto-detects repo)
  disable       Disable GitHub integration
  status        Show config and auth status
  create-branch Create workstream branch on GitHub
  create-issues Create issues for stages
  sync          Sync issue states with local task status

Run 'work github <subcommand> --help' for more information on a subcommand.
`);
}
function printEnableHelp() {
  console.log(`
work github enable - Enable GitHub integration

Usage:
  work github enable [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Enables GitHub integration by auto-detecting the repository from the
  git remote 'origin'. Saves configuration to work/github.json.

Examples:
  # Enable GitHub integration
  work github enable
`);
}
function printDisableHelp() {
  console.log(`
work github disable - Disable GitHub integration

Usage:
  work github disable [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Disables GitHub integration. Configuration is preserved but integration
  is marked as disabled.

Examples:
  # Disable GitHub integration
  work github disable
`);
}
function printStatusHelp() {
  console.log(`
work github status - Show GitHub integration status

Usage:
  work github status [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Shows the current GitHub integration configuration, authentication
  status, and repository information.

Examples:
  # Show GitHub integration status
  work github status
`);
}
function printCreateIssuesHelp() {
  console.log(`
work github create-issues - Create GitHub issues for stages

Usage:
  work github create-issues [options]

Options:
  --stream, -s   Workstream ID or name (uses current if omitted)
  --stage, -st   Create issue for a specific stage (e.g., 1)
  --json, -j     Output as JSON
  --help, -h     Show this help message

Description:
  Creates GitHub issues for workstream stages. Each stage gets one issue
  that tracks all batches, threads, and tasks within that stage.

  Issue title format: [{stream-id}] Stage {N}: {Stage Name}

  When no stage filter is specified, creates issues for all stages that
  don't already have an issue.

Examples:
  # Create issue for stage 1
  work github create-issues --stage 1

  # Create issues for all stages without issues
  work github create-issues

  # Create issues for specific workstream
  work github create-issues --stream "002-github-integration" --stage 1
`);
}
function printCreateBranchHelp() {
  console.log(`
work github create-branch - Create workstream branch on GitHub

Usage:
  work github create-branch [options]

Options:
  --stream, -s   Workstream ID or name (uses current if omitted)
  --from, -f     Base branch to create from (default: main)
  --help, -h     Show this help message

Examples:
  # Create branch for current workstream
  work github create-branch

  # Create branch for specific workstream
  work github create-branch --stream "002-github-integration"

  # Create branch from specific base
  work github create-branch --from develop
`);
}
function printSyncHelp() {
  console.log(`
work github sync - Sync stage issue states with local task status

Usage:
  work github sync [options]

Options:
  --stream, -s   Workstream ID or name (uses current if omitted)
  --json, -j     Output as JSON
  --help, -h     Show this help message

Description:
  Synchronizes GitHub stage issue states with local task status. For stages
  where all tasks are completed/cancelled, this command closes the stage
  issue and updates the state in github.json.

  Reports: "Closed N stage issues, M unchanged"

Examples:
  # Sync all issue states for current workstream
  work github sync

  # Sync for specific workstream
  work github sync --stream "002-github-integration"

  # Output as JSON
  work github sync --json
`);
}
function groupTasksByStage(tasks) {
  const stages = new Map;
  for (const task of tasks) {
    const { stage, batch, thread } = parseTaskId(task.id);
    const stageId = stage.toString().padStart(2, "0");
    const batchId = batch.toString().padStart(2, "0");
    const threadId = thread.toString().padStart(2, "0");
    if (!stages.has(stage)) {
      stages.set(stage, {
        stageNumber: stage,
        stageId,
        stageName: task.stage_name,
        batches: new Map
      });
    }
    const stageInfo = stages.get(stage);
    const batchKey = `${stageId}.${batchId}`;
    if (!stageInfo.batches.has(batchKey)) {
      stageInfo.batches.set(batchKey, {
        batchId: batchKey,
        batchName: task.batch_name,
        threads: new Map
      });
    }
    const batchInfo = stageInfo.batches.get(batchKey);
    const threadKey = `${stageId}.${batchId}.${threadId}`;
    if (!batchInfo.threads.has(threadKey)) {
      batchInfo.threads.set(threadKey, {
        threadId: threadKey,
        threadName: task.thread_name,
        tasks: []
      });
    }
    batchInfo.threads.get(threadKey).tasks.push(task);
  }
  return stages;
}
function stageInfoToInput(stageInfo, streamId, streamName) {
  const batches = [];
  const sortedBatches = Array.from(stageInfo.batches.entries()).sort(([a], [b2]) => a.localeCompare(b2));
  for (const [, batchInfo] of sortedBatches) {
    const threads = [];
    const sortedThreads = Array.from(batchInfo.threads.entries()).sort(([a], [b2]) => a.localeCompare(b2));
    for (const [, threadInfo] of sortedThreads) {
      const sortedTasks = threadInfo.tasks.sort((a, b2) => a.id.localeCompare(b2.id, undefined, { numeric: true }));
      const tasks = sortedTasks.map((t) => ({
        taskId: t.id,
        taskName: t.name,
        status: t.status
      }));
      threads.push({
        threadId: threadInfo.threadId,
        threadName: threadInfo.threadName,
        tasks
      });
    }
    batches.push({
      batchId: batchInfo.batchId,
      batchName: batchInfo.batchName,
      threads
    });
  }
  return {
    streamId,
    streamName,
    stageNumber: stageInfo.stageNumber,
    stageName: stageInfo.stageName,
    batches
  };
}
function isStageComplete2(stageInfo) {
  for (const batch of stageInfo.batches.values()) {
    for (const thread of batch.threads.values()) {
      for (const task of thread.tasks) {
        if (task.status !== "completed" && task.status !== "cancelled") {
          return false;
        }
      }
    }
  }
  return true;
}
async function createIssuesForStages(repoRoot, streamId, streamName, stages, stageFilter) {
  const result = {
    created: [],
    skipped: [],
    reopened: [],
    failed: []
  };
  await ensureWorkstreamLabels(repoRoot, streamId);
  let githubData = await loadWorkstreamGitHub(repoRoot, streamId);
  if (!githubData) {
    githubData = await initWorkstreamGitHub(repoRoot, streamId);
  }
  let stagesToProcess;
  if (stageFilter !== undefined) {
    const stageInfo = stages.get(stageFilter);
    stagesToProcess = stageInfo ? new Map([[stageFilter, stageInfo]]) : new Map;
  } else {
    stagesToProcess = stages;
  }
  const sortedStages = Array.from(stagesToProcess.entries()).sort(([a], [b2]) => a - b2);
  for (const [stageNumber, stageInfo] of sortedStages) {
    const stageId = stageNumber.toString().padStart(2, "0");
    try {
      const existingLocal = getStageIssue(githubData, stageId);
      const isComplete = isStageComplete2(stageInfo);
      const existingRemote = await findExistingStageIssue(repoRoot, streamId, stageNumber, stageInfo.stageName);
      if (existingLocal) {
        if (existingLocal.state === "closed" && !isComplete) {
          try {
            await reopenStageIssue(repoRoot, existingLocal.issue_number);
            existingLocal.state = "open";
            delete existingLocal.closed_at;
            await saveWorkstreamGitHub(repoRoot, streamId, githubData);
            result.reopened.push({
              stageNumber,
              stageName: stageInfo.stageName,
              issueUrl: existingLocal.issue_url,
              issueNumber: existingLocal.issue_number
            });
          } catch (error) {
            result.failed.push({
              stageNumber,
              stageName: stageInfo.stageName,
              error: `Failed to reopen issue: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        } else {
          result.skipped.push({
            stageNumber,
            stageName: stageInfo.stageName,
            reason: `Issue #${existingLocal.issue_number} already exists (${existingLocal.state})`
          });
        }
        continue;
      }
      if (existingRemote) {
        const stageIssue2 = {
          issue_number: existingRemote.issueNumber,
          issue_url: existingRemote.issueUrl,
          state: existingRemote.state,
          created_at: new Date().toISOString()
        };
        if (existingRemote.state === "closed") {
          stageIssue2.closed_at = new Date().toISOString();
        }
        setStageIssue(githubData, stageId, stageIssue2);
        await saveWorkstreamGitHub(repoRoot, streamId, githubData);
        if (existingRemote.state === "closed" && !isComplete) {
          try {
            await reopenStageIssue(repoRoot, existingRemote.issueNumber);
            stageIssue2.state = "open";
            delete stageIssue2.closed_at;
            await saveWorkstreamGitHub(repoRoot, streamId, githubData);
            result.reopened.push({
              stageNumber,
              stageName: stageInfo.stageName,
              issueUrl: existingRemote.issueUrl,
              issueNumber: existingRemote.issueNumber
            });
          } catch (error) {
            result.failed.push({
              stageNumber,
              stageName: stageInfo.stageName,
              error: `Failed to reopen issue: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        } else {
          result.skipped.push({
            stageNumber,
            stageName: stageInfo.stageName,
            reason: `Existing issue #${existingRemote.issueNumber} found on GitHub (${existingRemote.state})`
          });
        }
        continue;
      }
      if (isComplete) {
        result.skipped.push({
          stageNumber,
          stageName: stageInfo.stageName,
          reason: "Stage already complete, no issue needed"
        });
        continue;
      }
      const input = stageInfoToInput(stageInfo, streamId, streamName);
      const stageIssue = await createStageIssue(repoRoot, input);
      if (stageIssue) {
        setStageIssue(githubData, stageId, stageIssue);
        await saveWorkstreamGitHub(repoRoot, streamId, githubData);
        result.created.push({
          stageNumber,
          stageName: stageInfo.stageName,
          issueUrl: stageIssue.issue_url,
          issueNumber: stageIssue.issue_number
        });
      } else {
        result.skipped.push({
          stageNumber,
          stageName: stageInfo.stageName,
          reason: "GitHub integration not enabled or configured"
        });
      }
    } catch (error) {
      result.failed.push({
        stageNumber,
        stageName: stageInfo.stageName,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return result;
}
function parseCreateBranchArgs(argv) {
  const args = argv.slice(3);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--from":
      case "-f":
        if (!next) {
          console.error("Error: --from requires a value");
          return null;
        }
        parsed.fromRef = next;
        i++;
        break;
      case "--help":
      case "-h":
        printCreateBranchHelp();
        process.exit(0);
    }
  }
  return parsed;
}
async function createBranchCommand(argv) {
  const cliArgs = parseCreateBranchArgs(argv);
  if (!cliArgs) {
    console.error(`
Run 'work github create-branch --help' for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) {
    console.error("Error: GitHub integration is not enabled.");
    console.error("Run 'work github enable' first.");
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId);
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified and no current workstream set.");
    console.error("Use --stream to specify a workstream, or run 'work current --set <stream>'");
    process.exit(1);
  }
  const stream = index.streams.find((s) => s.id === resolvedStreamId || s.name === resolvedStreamId);
  if (!stream) {
    console.error(`Error: Workstream "${resolvedStreamId}" not found`);
    process.exit(1);
  }
  if (stream.github?.branch) {
    console.log(`Branch already exists: ${stream.github.branch}`);
    console.log("To checkout, run:");
    console.log(`  git checkout ${stream.github.branch}`);
    return;
  }
  console.log(`Creating branch for workstream: ${stream.id}`);
  if (cliArgs.fromRef) {
    console.log(`Base branch: ${cliArgs.fromRef}`);
  }
  try {
    const result = await createWorkstreamBranch(repoRoot, stream.id, cliArgs.fromRef);
    console.log("");
    console.log("Branch created and checked out successfully!");
    console.log("");
    console.log(`  Branch: ${result.branchName}`);
    console.log(`  SHA:    ${result.sha.substring(0, 7)}`);
    console.log(`  URL:    ${result.url}`);
    console.log("");
    console.log("You are now on the workstream branch.");
  } catch (e) {
    const error = e;
    console.error(`Error creating branch: ${error.message}`);
    process.exit(1);
  }
}
function parseCreateIssuesArgs(argv) {
  const args = argv.slice(3);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--stage":
      case "-st":
        if (!next) {
          console.error("Error: --stage requires a value");
          return null;
        }
        parsed.stage = parseInt(next, 10);
        if (isNaN(parsed.stage)) {
          console.error("Error: --stage must be a number");
          return null;
        }
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printCreateIssuesHelp();
        process.exit(0);
    }
  }
  return parsed;
}
async function createIssuesCommand(argv) {
  const cliArgs = parseCreateIssuesArgs(argv);
  if (!cliArgs) {
    console.error(`
Run 'work github create-issues --help' for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) {
    console.error("Error: GitHub integration is not enabled");
    console.error("Run 'work github enable' to enable it");
    process.exit(1);
  }
  try {
    await ensureGitHubAuth();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId);
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified and no current workstream set.");
    console.error("Use --stream to specify a workstream, or run 'work current --set <stream>'");
    process.exit(1);
  }
  const stream = getStream(index, resolvedStreamId);
  const tasksFile = readTasksFile(repoRoot, stream.id);
  if (!tasksFile || tasksFile.tasks.length === 0) {
    console.error("Error: No tasks found for workstream");
    process.exit(1);
  }
  const stages = groupTasksByStage(tasksFile.tasks);
  if (cliArgs.stage !== undefined && !stages.has(cliArgs.stage)) {
    console.error(`Error: No tasks found for stage ${cliArgs.stage}`);
    process.exit(1);
  }
  const result = await createIssuesForStages(repoRoot, stream.id, stream.name, stages, cliArgs.stage);
  if (cliArgs.json) {
    console.log(JSON.stringify({
      streamId: stream.id,
      streamName: stream.name,
      ...result
    }, null, 2));
  } else {
    if (result.created.length > 0) {
      console.log(`Created ${result.created.length} stage issue(s):`);
      for (const item of result.created) {
        console.log(`  Stage ${item.stageNumber.toString().padStart(2, "0")}: ${item.stageName}`);
        console.log(`    ${item.issueUrl}`);
      }
    }
    if (result.reopened.length > 0) {
      console.log(`
Reopened ${result.reopened.length} stage issue(s):`);
      for (const item of result.reopened) {
        console.log(`  Stage ${item.stageNumber.toString().padStart(2, "0")}: ${item.stageName}`);
        console.log(`    ${item.issueUrl}`);
      }
    }
    if (result.skipped.length > 0) {
      console.log(`
Skipped ${result.skipped.length} stage(s):`);
      for (const item of result.skipped) {
        console.log(`  Stage ${item.stageNumber.toString().padStart(2, "0")}: ${item.stageName} - ${item.reason}`);
      }
    }
    if (result.failed.length > 0) {
      console.log(`
Failed ${result.failed.length} stage(s):`);
      for (const item of result.failed) {
        console.log(`  Stage ${item.stageNumber.toString().padStart(2, "0")}: ${item.stageName} - ${item.error}`);
      }
    }
    if (result.created.length === 0 && result.reopened.length === 0 && result.skipped.length === 0 && result.failed.length === 0) {
      console.log("No stages to process");
    }
  }
}
function parseSimpleArgs(argv, commandIndex) {
  const args = argv.slice(commandIndex + 1);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--help":
      case "-h":
        return null;
    }
  }
  return parsed;
}
async function enableCommand(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printEnableHelp();
    process.exit(0);
  }
  const cliArgs = parseSimpleArgs(argv, 2);
  let repoRoot;
  try {
    repoRoot = cliArgs?.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log("Enabling GitHub integration...");
  try {
    await enableGitHub(repoRoot);
    const config2 = await loadGitHubConfig(repoRoot);
    console.log(`GitHub integration enabled for ${config2.owner}/${config2.repo}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
async function disableCommand(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printDisableHelp();
    process.exit(0);
  }
  const cliArgs = parseSimpleArgs(argv, 2);
  let repoRoot;
  try {
    repoRoot = cliArgs?.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log("Disabling GitHub integration...");
  try {
    await disableGitHub(repoRoot);
    console.log("GitHub integration disabled");
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
async function statusCommand(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printStatusHelp();
    process.exit(0);
  }
  const cliArgs = parseSimpleArgs(argv, 2);
  let repoRoot;
  try {
    repoRoot = cliArgs?.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const config2 = await loadGitHubConfig(repoRoot);
  console.log("GitHub Integration Status");
  console.log("=".repeat(40));
  console.log();
  console.log(`Enabled:       ${config2.enabled ? "Yes" : "No"}`);
  if (config2.owner && config2.repo) {
    console.log(`Repository:    ${config2.owner}/${config2.repo}`);
  } else {
    console.log("Repository:    Not configured");
  }
  console.log(`Branch Prefix: ${config2.branch_prefix}`);
  console.log();
  console.log("Authentication:");
  const token = getGitHubAuth();
  if (token) {
    const isValid = await validateAuth(token);
    const source = process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : process.env.GH_TOKEN ? "GH_TOKEN" : "gh CLI";
    console.log(`  Source:      ${source}`);
    console.log(`  Valid:       ${isValid ? "Yes" : "No"}`);
  } else {
    console.log("  Status:      Not authenticated");
    console.log("  Hint:        Set GITHUB_TOKEN, GH_TOKEN, or run 'gh auth login'");
  }
  console.log();
  console.log("Label Configuration:");
  console.log(`  Workstream:  ${config2.label_config.workstream.prefix} (color: #${config2.label_config.workstream.color})`);
  console.log(`  Stage:       ${config2.label_config.stage.prefix} (color: #${config2.label_config.stage.color})`);
  console.log(`  Batch:       ${config2.label_config.batch.prefix} (color: #${config2.label_config.batch.color})`);
  console.log(`  Thread:      ${config2.label_config.thread.prefix} (color: #${config2.label_config.thread.color})`);
}
function parseSyncArgs(argv) {
  const args = argv.slice(3);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printSyncHelp();
        process.exit(0);
    }
  }
  return parsed;
}
async function syncCommand(argv) {
  const cliArgs = parseSyncArgs(argv);
  if (!cliArgs) {
    console.error(`
Run 'work github sync --help' for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const enabled = await isGitHubEnabled(repoRoot);
  if (!enabled) {
    console.error("Error: GitHub integration is not enabled");
    console.error("Run 'work github enable' to enable it");
    process.exit(1);
  }
  try {
    await ensureGitHubAuth();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId);
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified and no current workstream set.");
    console.error("Use --stream to specify a workstream, or run 'work current --set <stream>'");
    process.exit(1);
  }
  const stream = getStream(index, resolvedStreamId);
  if (!cliArgs.json) {
    console.log(`Syncing stage issue states for workstream: ${stream.id}`);
    console.log("");
  }
  let result;
  try {
    result = await syncStageIssues(repoRoot, stream.id);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  if (cliArgs.json) {
    console.log(JSON.stringify({
      streamId: stream.id,
      streamName: stream.name,
      ...result
    }, null, 2));
  } else {
    if (result.closed.length > 0) {
      console.log(`Closed ${result.closed.length} stage issue(s):`);
      for (const item of result.closed) {
        console.log(`  Stage ${item.stageNumber}: ${item.stageName}`);
        console.log(`    #${item.issueNumber}: ${item.issueUrl}`);
      }
      console.log("");
    }
    if (result.unchanged.length > 0) {
      console.log(`Unchanged ${result.unchanged.length} stage issue(s):`);
      for (const item of result.unchanged) {
        console.log(`  Stage ${item.stageNumber}: ${item.stageName} - ${item.reason}`);
      }
      console.log("");
    }
    if (result.errors.length > 0) {
      console.log(`Errors ${result.errors.length}:`);
      for (const item of result.errors) {
        console.log(`  Stage ${item.stageNumber}: ${item.stageName} - ${item.error}`);
      }
      console.log("");
    }
    const closedCount = result.closed.length;
    const unchangedCount = result.unchanged.length;
    const errorCount = result.errors.length;
    if (closedCount === 0 && unchangedCount === 0 && errorCount === 0) {
      console.log("No stage issues to sync (no stages have associated GitHub issues)");
    } else {
      console.log(`Summary: Closed ${closedCount} stage issues, ${unchangedCount} unchanged`);
      if (errorCount > 0) {
        console.log(`  ${errorCount} error(s) occurred`);
      }
    }
  }
}
function main41(argv = process.argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    printHelp39();
    process.exit(0);
  }
  const firstArg = args[0];
  if (firstArg === "--help" || firstArg === "-h") {
    printHelp39();
    process.exit(0);
  }
  if (!SUBCOMMANDS.includes(firstArg)) {
    console.error(`Error: Unknown subcommand "${firstArg}"`);
    console.error(`
Available subcommands: ` + SUBCOMMANDS.join(", "));
    console.error(`
Run 'work github --help' for usage information.`);
    process.exit(1);
  }
  const subcommand = firstArg;
  switch (subcommand) {
    case "enable":
      enableCommand(argv);
      break;
    case "disable":
      disableCommand(argv);
      break;
    case "status":
      statusCommand(argv);
      break;
    case "create-branch":
      createBranchCommand(argv);
      break;
    case "create-issues":
      createIssuesCommand(argv);
      break;
    case "sync":
      syncCommand(argv);
      break;
  }
}
if (false) {}

// src/cli/start.ts
init_repo();
init_lib();

// src/cli/github.ts
init_repo();
init_lib();
init_tasks();
function groupTasksByStage2(tasks) {
  const stages = new Map;
  for (const task of tasks) {
    const { stage, batch, thread } = parseTaskId(task.id);
    const stageId = stage.toString().padStart(2, "0");
    const batchId = batch.toString().padStart(2, "0");
    const threadId = thread.toString().padStart(2, "0");
    if (!stages.has(stage)) {
      stages.set(stage, {
        stageNumber: stage,
        stageId,
        stageName: task.stage_name,
        batches: new Map
      });
    }
    const stageInfo = stages.get(stage);
    const batchKey = `${stageId}.${batchId}`;
    if (!stageInfo.batches.has(batchKey)) {
      stageInfo.batches.set(batchKey, {
        batchId: batchKey,
        batchName: task.batch_name,
        threads: new Map
      });
    }
    const batchInfo = stageInfo.batches.get(batchKey);
    const threadKey = `${stageId}.${batchId}.${threadId}`;
    if (!batchInfo.threads.has(threadKey)) {
      batchInfo.threads.set(threadKey, {
        threadId: threadKey,
        threadName: task.thread_name,
        tasks: []
      });
    }
    batchInfo.threads.get(threadKey).tasks.push(task);
  }
  return stages;
}
function stageInfoToInput2(stageInfo, streamId, streamName) {
  const batches = [];
  const sortedBatches = Array.from(stageInfo.batches.entries()).sort(([a], [b2]) => a.localeCompare(b2));
  for (const [, batchInfo] of sortedBatches) {
    const threads = [];
    const sortedThreads = Array.from(batchInfo.threads.entries()).sort(([a], [b2]) => a.localeCompare(b2));
    for (const [, threadInfo] of sortedThreads) {
      const sortedTasks = threadInfo.tasks.sort((a, b2) => a.id.localeCompare(b2.id, undefined, { numeric: true }));
      const tasks = sortedTasks.map((t) => ({
        taskId: t.id,
        taskName: t.name,
        status: t.status
      }));
      threads.push({
        threadId: threadInfo.threadId,
        threadName: threadInfo.threadName,
        tasks
      });
    }
    batches.push({
      batchId: batchInfo.batchId,
      batchName: batchInfo.batchName,
      threads
    });
  }
  return {
    streamId,
    streamName,
    stageNumber: stageInfo.stageNumber,
    stageName: stageInfo.stageName,
    batches
  };
}
function isStageComplete3(stageInfo) {
  for (const batch of stageInfo.batches.values()) {
    for (const thread of batch.threads.values()) {
      for (const task of thread.tasks) {
        if (task.status !== "completed" && task.status !== "cancelled") {
          return false;
        }
      }
    }
  }
  return true;
}
async function createIssuesForStages2(repoRoot, streamId, streamName, stages, stageFilter) {
  const result = {
    created: [],
    skipped: [],
    reopened: [],
    failed: []
  };
  await ensureWorkstreamLabels(repoRoot, streamId);
  let githubData = await loadWorkstreamGitHub(repoRoot, streamId);
  if (!githubData) {
    githubData = await initWorkstreamGitHub(repoRoot, streamId);
  }
  let stagesToProcess;
  if (stageFilter !== undefined) {
    const stageInfo = stages.get(stageFilter);
    stagesToProcess = stageInfo ? new Map([[stageFilter, stageInfo]]) : new Map;
  } else {
    stagesToProcess = stages;
  }
  const sortedStages = Array.from(stagesToProcess.entries()).sort(([a], [b2]) => a - b2);
  for (const [stageNumber, stageInfo] of sortedStages) {
    const stageId = stageNumber.toString().padStart(2, "0");
    try {
      const existingLocal = getStageIssue(githubData, stageId);
      const isComplete = isStageComplete3(stageInfo);
      const existingRemote = await findExistingStageIssue(repoRoot, streamId, stageNumber, stageInfo.stageName);
      if (existingLocal) {
        if (existingLocal.state === "closed" && !isComplete) {
          try {
            await reopenStageIssue(repoRoot, existingLocal.issue_number);
            existingLocal.state = "open";
            delete existingLocal.closed_at;
            await saveWorkstreamGitHub(repoRoot, streamId, githubData);
            result.reopened.push({
              stageNumber,
              stageName: stageInfo.stageName,
              issueUrl: existingLocal.issue_url,
              issueNumber: existingLocal.issue_number
            });
          } catch (error) {
            result.failed.push({
              stageNumber,
              stageName: stageInfo.stageName,
              error: `Failed to reopen issue: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        } else {
          result.skipped.push({
            stageNumber,
            stageName: stageInfo.stageName,
            reason: `Issue #${existingLocal.issue_number} already exists (${existingLocal.state})`
          });
        }
        continue;
      }
      if (existingRemote) {
        const stageIssue2 = {
          issue_number: existingRemote.issueNumber,
          issue_url: existingRemote.issueUrl,
          state: existingRemote.state,
          created_at: new Date().toISOString()
        };
        if (existingRemote.state === "closed") {
          stageIssue2.closed_at = new Date().toISOString();
        }
        setStageIssue(githubData, stageId, stageIssue2);
        await saveWorkstreamGitHub(repoRoot, streamId, githubData);
        if (existingRemote.state === "closed" && !isComplete) {
          try {
            await reopenStageIssue(repoRoot, existingRemote.issueNumber);
            stageIssue2.state = "open";
            delete stageIssue2.closed_at;
            await saveWorkstreamGitHub(repoRoot, streamId, githubData);
            result.reopened.push({
              stageNumber,
              stageName: stageInfo.stageName,
              issueUrl: existingRemote.issueUrl,
              issueNumber: existingRemote.issueNumber
            });
          } catch (error) {
            result.failed.push({
              stageNumber,
              stageName: stageInfo.stageName,
              error: `Failed to reopen issue: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        } else {
          result.skipped.push({
            stageNumber,
            stageName: stageInfo.stageName,
            reason: `Existing issue #${existingRemote.issueNumber} found on GitHub (${existingRemote.state})`
          });
        }
        continue;
      }
      if (isComplete) {
        result.skipped.push({
          stageNumber,
          stageName: stageInfo.stageName,
          reason: "Stage already complete, no issue needed"
        });
        continue;
      }
      const input = stageInfoToInput2(stageInfo, streamId, streamName);
      const stageIssue = await createStageIssue(repoRoot, input);
      if (stageIssue) {
        setStageIssue(githubData, stageId, stageIssue);
        await saveWorkstreamGitHub(repoRoot, streamId, githubData);
        result.created.push({
          stageNumber,
          stageName: stageInfo.stageName,
          issueUrl: stageIssue.issue_url,
          issueNumber: stageIssue.issue_number
        });
      } else {
        result.skipped.push({
          stageNumber,
          stageName: stageInfo.stageName,
          reason: "GitHub integration not enabled or configured"
        });
      }
    } catch (error) {
      result.failed.push({
        stageNumber,
        stageName: stageInfo.stageName,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return result;
}
if (false) {}
async function createStageIssuesForWorkstream(repoRoot, streamId, streamName) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile || tasksFile.tasks.length === 0) {
    return { created: [], skipped: [], reopened: [], failed: [] };
  }
  const stages = groupTasksByStage2(tasksFile.tasks);
  return createIssuesForStages2(repoRoot, streamId, streamName, stages);
}

// src/cli/start.ts
function printHelp40() {
  console.log(`
work start - Start a workstream after approvals are complete

Requires: USER role

Usage:
  work start [--stream <id>] [--json]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Start a workstream after plan and tasks approvals are complete.
  
   This command:
   1. Creates the workstream branch on GitHub (workstream/{streamId})
   2. Checks out the branch locally
   3. Creates GitHub issues for all stages in the workstream

Prerequisites:
  - Run 'work approve plan' to approve the PLAN.md
  - Run 'work approve tasks' to approve tasks.json
  - Run 'work approve' to check approval status

Examples:
  # Start current workstream
  work start

  # Start specific workstream
  work start --stream "001-my-feature"

  # Output as JSON
  work start --json
`);
}
function parseCliArgs37(argv) {
  const args = argv.slice(2);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp40();
        process.exit(0);
    }
  }
  return parsed;
}
async function main42(argv = process.argv) {
  const cliArgs = parseCliArgs37(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (!canExecuteCommand("start")) {
    console.error(getRoleDenialMessage("start"));
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const fullStatus = getFullApprovalStatus(stream);
  if (!fullStatus.fullyApproved) {
    const missing = [];
    if (fullStatus.plan !== "approved")
      missing.push("plan");
    if (fullStatus.tasks !== "approved")
      missing.push("tasks");
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "blocked",
        reason: "missing_approvals",
        streamId: stream.id,
        streamName: stream.name,
        missingApprovals: missing,
        approvalStatus: fullStatus
      }, null, 2));
    } else {
      console.error("Error: Cannot start workstream - missing approvals");
      console.error("");
      console.error(`  Plan:    ${fullStatus.plan}`);
      console.error(`  Tasks:   ${fullStatus.tasks}`);
      console.error("");
      console.error("Run 'work approve <target>' to approve missing items:");
      for (const item of missing) {
        console.error(`  work approve ${item}`);
      }
    }
    process.exit(1);
  }
  const githubEnabled = await isGitHubEnabled(repoRoot);
  if (!githubEnabled) {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "blocked",
        reason: "github_not_enabled",
        streamId: stream.id,
        streamName: stream.name
      }, null, 2));
    } else {
      console.error("Error: GitHub integration is not enabled");
      console.error("Run 'work github enable' to enable it");
    }
    process.exit(1);
  }
  const githubConfig = await loadGitHubConfig(repoRoot);
  try {
    await ensureGitHubAuth(githubConfig.owner, githubConfig.repo);
  } catch (error) {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "blocked",
        reason: "github_auth_failed",
        streamId: stream.id,
        streamName: stream.name,
        error: error.message
      }, null, 2));
    } else {
      console.error(`Error: ${error.message}`);
      console.error("Set GITHUB_TOKEN, GH_TOKEN, or run 'gh auth login'");
    }
    process.exit(1);
  }
  if (!cliArgs.json) {
    console.log(`Starting workstream "${stream.name}" (${stream.id})...`);
    console.log("");
  }
  let branchResult = null;
  try {
    if (!cliArgs.json) {
      console.log("Creating branch...");
    }
    branchResult = await createWorkstreamBranch(repoRoot, stream.id);
    if (!cliArgs.json) {
      console.log(`  ✅ Branch: ${branchResult.branchName}`);
      console.log(`  SHA: ${branchResult.sha.substring(0, 7)}`);
    }
  } catch (e) {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "error",
        step: "create_branch",
        error: e.message,
        streamId: stream.id
      }, null, 2));
    } else {
      console.error(`Error creating branch: ${e.message}`);
    }
    process.exit(1);
  }
  let issuesResult;
  try {
    if (!cliArgs.json) {
      console.log("");
      console.log("Creating issues for stages...");
    }
    issuesResult = await createStageIssuesForWorkstream(repoRoot, stream.id, stream.name);
    if (!cliArgs.json) {
      if (issuesResult.created.length > 0) {
        console.log(`  ✅ Created ${issuesResult.created.length} stage issue(s)`);
        for (const item of issuesResult.created) {
          console.log(`     Stage ${item.stageNumber.toString().padStart(2, "0")}: ${item.stageName}`);
          console.log(`       ${item.issueUrl}`);
        }
      }
      if (issuesResult.skipped.length > 0) {
        console.log(`  ⏭️  Skipped ${issuesResult.skipped.length} (already exist)`);
      }
      if (issuesResult.failed.length > 0) {
        console.log(`  ⚠️  Errors: ${issuesResult.failed.length}`);
        for (const item of issuesResult.failed) {
          console.log(`     Stage ${item.stageNumber}: ${item.error}`);
        }
      }
    }
  } catch (e) {
    if (cliArgs.json) {
      console.log(JSON.stringify({
        action: "error",
        step: "create_issues",
        error: e.message,
        streamId: stream.id,
        branchCreated: !!branchResult
      }, null, 2));
    } else {
      console.error(`Error creating issues: ${e.message}`);
    }
    process.exit(1);
  }
  if (cliArgs.json) {
    console.log(JSON.stringify({
      action: "started",
      streamId: stream.id,
      streamName: stream.name,
      branch: branchResult ? {
        name: branchResult.branchName,
        sha: branchResult.sha,
        url: branchResult.url
      } : null,
      issues: {
        created: issuesResult.created.length,
        skipped: issuesResult.skipped.length,
        failed: issuesResult.failed.length,
        details: issuesResult.created
      }
    }, null, 2));
  } else {
    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`Workstream "${stream.name}" started successfully!`);
    console.log("");
    console.log(`Branch: ${branchResult?.branchName}`);
    console.log(`Issues: ${issuesResult.created.length} created, ${issuesResult.skipped.length} skipped`);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Run 'work continue' to start working on threads (shortcuts to 'work multi --continue')");
    console.log("  2. Or run 'work execute --thread <id>' for single thread");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }
}
if (false) {}

// src/cli/session.ts
init_repo();
init_lib();
init_tasks();
function printHelp41() {
  console.log(`
work session - Manage agent sessions

Usage:
  work session <subcommand> [options]

Subcommands:
  complete    Mark sessions as completed

Complete Options:
  --thread, -t <id>   Complete sessions for specific thread (e.g., "01.01.01")
  --batch, -b <id>    Complete all sessions in batch (e.g., "01.01")
  --all               Complete all running/interrupted sessions

Global Options:
  --repo-root, -r     Repository root (auto-detected if omitted)
  --json              Output as JSON
  --help, -h          Show this help message

Description:
  Sessions track agent execution on tasks. When tmux exits unexpectedly
  or an agent crashes, sessions may be left in 'running' or 'interrupted'
  state. Use this command to manually mark them as 'completed'.

Examples:
  # Complete sessions for a specific thread
  work session complete --thread "01.01.01"

  # Complete all sessions in a batch
  work session complete --batch "01.01"

  # Complete all running/interrupted sessions in the workstream
  work session complete --all
`);
}
function parseCliArgs38(argv) {
  const args = argv.slice(2);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "complete":
        parsed.subcommand = "complete";
        break;
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--thread":
      case "-t":
        if (!next) {
          console.error("Error: --thread requires a value");
          return null;
        }
        parsed.thread = next;
        i++;
        break;
      case "--batch":
      case "-b":
        if (!next) {
          console.error("Error: --batch requires a value");
          return null;
        }
        parsed.batch = next;
        i++;
        break;
      case "--all":
        parsed.all = true;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp41();
        process.exit(0);
    }
  }
  return parsed;
}
function findIncompleteSessionTasks(tasks, filter) {
  const results = [];
  for (const task of tasks) {
    if (!task.sessions)
      continue;
    if (filter?.threadPrefix && !task.id.startsWith(filter.threadPrefix + ".")) {
      continue;
    }
    if (filter?.batchPrefix && !task.id.startsWith(filter.batchPrefix + ".")) {
      continue;
    }
    for (const session of task.sessions) {
      if (session.status === "running" || session.status === "interrupted") {
        results.push({ task, session });
      }
    }
  }
  return results;
}
function completeSessions(repoRoot, streamId, filter) {
  const tasksFile = readTasksFile(repoRoot, streamId);
  if (!tasksFile) {
    return { completed: [], errors: ["Tasks file not found"] };
  }
  const incompleteSessions = findIncompleteSessionTasks(tasksFile.tasks, filter);
  const completed = [];
  const errors2 = [];
  const now = new Date().toISOString();
  for (const { task, session } of incompleteSessions) {
    const previousStatus = session.status;
    session.status = "completed";
    session.completedAt = now;
    if (task.currentSessionId === session.sessionId) {
      task.currentSessionId = undefined;
    }
    task.updated_at = now;
    completed.push({
      taskId: task.id,
      sessionId: session.sessionId,
      previousStatus
    });
  }
  if (completed.length > 0) {
    writeTasksFile(repoRoot, streamId, tasksFile);
  }
  return { completed, errors: errors2 };
}
function handleComplete(repoRoot, streamId, cliArgs) {
  if (!cliArgs.thread && !cliArgs.batch && !cliArgs.all) {
    console.error("Error: Must specify --thread, --batch, or --all");
    console.error(`
Run 'work session complete --help' for usage information.`);
    process.exit(1);
  }
  let filter;
  if (cliArgs.thread) {
    try {
      parseThreadId(cliArgs.thread);
      filter = { threadPrefix: cliArgs.thread };
    } catch (e) {
      console.error(`Error: Invalid thread ID format "${cliArgs.thread}"`);
      console.error("Expected format: SS.BB.TT (e.g., 01.01.01)");
      process.exit(1);
    }
  } else if (cliArgs.batch) {
    const parts = cliArgs.batch.split(".");
    if (parts.length !== 2 || parts.some((p) => isNaN(parseInt(p, 10)))) {
      console.error(`Error: Invalid batch ID format "${cliArgs.batch}"`);
      console.error("Expected format: SS.BB (e.g., 01.01)");
      process.exit(1);
    }
    filter = { batchPrefix: cliArgs.batch };
  }
  const result = completeSessions(repoRoot, streamId, filter);
  if (cliArgs.json) {
    console.log(JSON.stringify({
      streamId,
      completed: result.completed,
      errors: result.errors,
      count: result.completed.length
    }, null, 2));
  } else {
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        console.error(`Error: ${error}`);
      }
    }
    if (result.completed.length === 0) {
      const scope = cliArgs.thread ? `thread "${cliArgs.thread}"` : cliArgs.batch ? `batch "${cliArgs.batch}"` : "workstream";
      console.log(`No running or interrupted sessions found in ${scope}.`);
    } else {
      console.log(`Completed ${result.completed.length} session(s):`);
      console.log("");
      for (const item of result.completed) {
        console.log(`  Task ${item.taskId}`);
        console.log(`    Session: ${item.sessionId}`);
        console.log(`    Previous status: ${item.previousStatus}`);
        console.log("");
      }
    }
  }
}
function main43(argv = process.argv) {
  const cliArgs = parseCliArgs38(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const resolvedStreamId = resolveStreamId(index, undefined);
  if (!resolvedStreamId) {
    console.error("Error: No current workstream set.");
    console.error("Run 'work current --set <stream-id>' to set one.");
    process.exit(1);
  }
  if (!cliArgs.subcommand) {
    console.error("Error: No subcommand specified");
    printHelp41();
    process.exit(1);
  }
  switch (cliArgs.subcommand) {
    case "complete":
      handleComplete(repoRoot, resolvedStreamId, cliArgs);
      break;
    default:
      console.error(`Error: Unknown subcommand "${cliArgs.subcommand}"`);
      printHelp41();
      process.exit(1);
  }
}
if (false) {}

// src/cli/revision.ts
init_repo();
init_lib();
function printHelp42() {
  console.log(`
work revision - Add a revision stage to a workstream

Usage:
  work revision --name <name> [options]

Required:
  --name           Name of the revision (e.g., "documentation-updates")

Optional:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --description    Description of the revision changes
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Examples:
  work revision --name "documentation-updates"
  work revision --name "code-review-feedback" --description "Address reviewer comments"
`);
}
function parseCliArgs39(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.streamId = next;
        i++;
        break;
      case "--name":
        if (!next) {
          console.error("Error: --name requires a value");
          return null;
        }
        parsed.name = next;
        i++;
        break;
      case "--description":
        if (!next) {
          console.error("Error: --description requires a value");
          return null;
        }
        parsed.description = next;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp42();
        process.exit(0);
    }
  }
  if (!parsed.name) {
    console.error("Error: --name is required");
    return null;
  }
  return parsed;
}
function main44(argv = process.argv) {
  const cliArgs = parseCliArgs39(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let stream;
  try {
    stream = getResolvedStream(index, cliArgs.streamId);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  try {
    const result = appendRevisionStage(repoRoot, stream.id, {
      name: cliArgs.name,
      description: cliArgs.description
    });
    if (result.success) {
      const tasksStatus = getTasksApprovalStatus(stream);
      let revokedTasks = false;
      if (tasksStatus === "approved") {
        revokeTasksApproval(repoRoot, stream.id, `revision: ${cliArgs.name}`);
        revokedTasks = true;
      }
      console.log(`Added Stage ${result.newStageNumber}: Revision - ${cliArgs.name} to PLAN.md`);
      if (revokedTasks) {
        console.log(`  Tasks approval revoked for revision`);
      }
      console.log(`
Edit PLAN.md to fill in details, then run 'work approve revision'`);
    } else {
      console.error(`Error: ${result.message}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (false) {}

// src/cli/notifications.ts
init_repo();
function printHelp43() {
  console.log(`
work notifications - Show notification configuration

Usage:
  work notifications                    # Show configuration
  work notifications --json             # Output as JSON

Options:
  --repo-root, -r    Repository root (auto-detected if omitted)
  --json, -j         Output as JSON for machine-readable format
  --help, -h         Show this help message
  `);
}
function parseCliArgs40(argv) {
  const args = argv.slice(2);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp43();
        process.exit(0);
    }
  }
  return parsed;
}
function formatOutput(config2, path) {
  console.log("Notification Configuration");
  console.log("==========================");
  console.log(`Global Status: ${config2.enabled ? "Enabled" : "Disabled"}`);
  console.log(`Config File:   ${path}`);
  console.log("");
  console.log("Providers:");
  const providers = config2.providers;
  if (providers.sound) {
    console.log(`- Sound:             ${providers.sound.enabled ? "Enabled" : "Disabled"}`);
  }
  if (providers.notification_center) {
    console.log(`- Notification Center: ${providers.notification_center.enabled ? "Enabled" : "Disabled"}`);
  }
  if (providers.terminal_notifier) {
    console.log(`- Terminal Notifier: ${providers.terminal_notifier.enabled ? "Enabled" : "Disabled"}`);
  }
  if (providers.tts) {
    console.log(`- Text-to-Speech:    ${providers.tts.enabled ? "Enabled" : "Disabled"}`);
  }
  console.log("");
  console.log("Events:");
  const events = config2.events;
  console.log(`- Thread Complete:    ${events.thread_complete ? "On" : "Off"}`);
  console.log(`- Batch Complete:     ${events.batch_complete ? "On" : "Off"}`);
  console.log(`- Synthesis Complete: ${events.synthesis_complete ? "On" : "Off"}`);
  console.log(`- Error:              ${events.error ? "On" : "Off"}`);
}
function main45(argv = process.argv) {
  const cliArgs = parseCliArgs40(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const config2 = loadNotificationsConfig(repoRoot);
  const configPath = getNotificationsConfigPath(repoRoot);
  if (cliArgs.json) {
    console.log(JSON.stringify(config2, null, 2));
  } else {
    formatOutput(config2, configPath);
  }
}
if (false) {}

// src/cli/synthesis.ts
init_repo();
function printHelp44() {
  console.log(`
work synthesis - Show synthesis configuration

Usage:
  work synthesis                    # Show configuration
  work synthesis --json             # Output as JSON

Options:
  --repo-root, -r    Repository root (auto-detected if omitted)
  --json, -j         Output as JSON for machine-readable format
  --help, -h         Show this help message
  `);
}
function parseCliArgs41(argv) {
  const args = argv.slice(2);
  const parsed = { json: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--json":
      case "-j":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        printHelp44();
        process.exit(0);
    }
  }
  return parsed;
}
function formatOutput2(config2, path) {
  console.log("Synthesis Configuration");
  console.log("=======================");
  console.log(`Status:      ${config2.enabled ? "Enabled" : "Disabled"}`);
  console.log(`Config File: ${path}`);
  console.log("");
  if (config2.agent) {
    console.log(`Agent Override: ${config2.agent}`);
  } else {
    console.log("Agent Override: (none - using default)");
  }
  console.log("");
  console.log("Output Settings:");
  if (config2.output) {
    console.log(`- Store in threads: ${config2.output.store_in_threads ? "Yes" : "No"}`);
  } else {
    console.log("- Store in threads: Yes (default)");
  }
}
function main46(argv = process.argv) {
  const cliArgs = parseCliArgs41(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const config2 = loadSynthesisConfig(repoRoot);
  const configPath = getSynthesisConfigPath(repoRoot);
  if (cliArgs.json) {
    console.log(JSON.stringify(config2, null, 2));
  } else {
    formatOutput2(config2, configPath);
  }
}
if (false) {}

// src/cli/plan.ts
init_repo();
init_lib();
import { spawn as spawn10 } from "child_process";
function printHelp45() {
  console.log(`
work plan - Manage planning sessions for workstreams

Usage:
  work plan [options]

Description:
  Resumes the planning session for a workstream. A planning session links an
  opencode conversation to a workstream, allowing you to resume later.

  To link a session from within opencode, use the workstream_link_planning_session
  tool after creating a workstream.

Options:
  --stream, -s <id>    Workstream ID or name (uses current if not specified)
  --set <sessionId>    Link a session ID to the workstream (used by tools)
  --repo-root, -r      Repository root (auto-detected if omitted)
  --help, -h           Show this help message

Workflow:
  1. Open opencode and discuss the problem
  2. Ask agent to create workstream with planning skill
  3. Use the workstream_link_planning_session tool to link session
  4. Later, resume with: work plan

Examples:
  work plan                        # Resume planning session
  work plan --stream "001-feature" # Resume specific workstream
`);
}
function parseCliArgs42(argv) {
  const args = argv.slice(2);
  const parsed = { help: false };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value");
          return null;
        }
        parsed.repoRoot = next;
        i++;
        break;
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value");
          return null;
        }
        parsed.stream = next;
        i++;
        break;
      case "--set":
        if (!next) {
          console.error("Error: --set requires a value");
          return null;
        }
        parsed.set = next;
        i++;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        if (arg && arg.startsWith("-")) {
          console.error(`Error: Unknown option "${arg}"`);
          return null;
        }
    }
  }
  return parsed;
}
function handleSetSession(repoRoot, streamId, sessionId) {
  try {
    const stream = setStreamPlanningSession(repoRoot, streamId, sessionId);
    console.log(`Set planning session for workstream "${stream.id}":`);
    console.log(`  Session ID: ${sessionId}`);
    console.log(`
You can now resume this session with:`);
    console.log(`  work plan`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
function handleResumeSession(repoRoot, streamId) {
  try {
    const sessionId = getPlanningSessionId(repoRoot, streamId);
    if (!sessionId) {
      console.error(`No planning session found for workstream "${streamId}".`);
      console.error("");
      console.error("Options:");
      console.error("  1. If you created a planning session manually, use:");
      console.error("     work plan --set <sessionId>");
      console.error("");
      console.error("  2. Create a new workstream with planning session:");
      console.error("     work create --name my-feature");
      process.exit(1);
    }
    console.log(`Resuming planning session for workstream "${streamId}"...`);
    console.log(`Session ID: ${sessionId}`);
    console.log("");
    const child = spawn10("opencode", ["--session", sessionId], {
      stdio: "inherit",
      cwd: repoRoot
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`
opencode exited with code ${code}`);
        process.exit(code);
      }
    });
    child.on("error", (err) => {
      console.error(`
Failed to launch opencode: ${err.message}`);
      process.exit(1);
    });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
function main47(argv = process.argv) {
  const cliArgs = parseCliArgs42(argv);
  if (!cliArgs) {
    console.error(`
Run with --help for usage information.`);
    process.exit(1);
  }
  if (cliArgs.help) {
    printHelp45();
    process.exit(0);
  }
  let repoRoot;
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let index;
  try {
    index = loadIndex(repoRoot);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const resolvedStreamId = resolveStreamId(index, cliArgs.stream);
  if (!resolvedStreamId) {
    if (cliArgs.stream) {
      console.error(`Error: Workstream "${cliArgs.stream}" not found.`);
    } else {
      console.error("Error: No current workstream set.");
      console.error("Run 'work current --set <stream-id>' to set one.");
    }
    process.exit(1);
  }
  if (cliArgs.set) {
    handleSetSession(repoRoot, resolvedStreamId, cliArgs.set);
  } else {
    handleResumeSession(repoRoot, resolvedStreamId);
  }
}
if (false) {}

// src/lib/roles.ts
var COMMAND_PERMISSIONS2 = {
  approve: {
    allowedRoles: ["USER"],
    denialMessage: "Approval requires human oversight. Ask the user to run `work approve <target>`"
  },
  start: {
    allowedRoles: ["USER"],
    denialMessage: "Starting a workstream requires human approval. Ask the user to run `work start`"
  },
  complete: {
    allowedRoles: ["USER"],
    denialMessage: "Completing a workstream requires human approval. Ask the user to run `work complete`"
  },
  status: { allowedRoles: ["USER", "AGENT"] },
  list: { allowedRoles: ["USER", "AGENT"] },
  tree: { allowedRoles: ["USER", "AGENT"] },
  update: { allowedRoles: ["USER", "AGENT"] },
  review: { allowedRoles: ["USER", "AGENT"] },
  current: { allowedRoles: ["USER", "AGENT"] },
  init: { allowedRoles: ["USER", "AGENT"] },
  fix: { allowedRoles: ["USER", "AGENT"] },
  generate: { allowedRoles: ["USER", "AGENT"] },
  delete: { allowedRoles: ["USER", "AGENT"] },
  plan: { allowedRoles: ["USER", "AGENT"] },
  agents: { allowedRoles: ["USER", "AGENT"] },
  prompts: { allowedRoles: ["USER", "AGENT"] }
};
function getCurrentRole2() {
  const envRole = process.env.WORKSTREAM_ROLE?.toUpperCase();
  if (envRole === "USER")
    return "USER";
  return "AGENT";
}
function canExecuteCommand2(command) {
  const permission = COMMAND_PERMISSIONS2[command];
  if (!permission)
    return true;
  return permission.allowedRoles.includes(getCurrentRole2());
}
function getRoleDenialMessage2(command) {
  const role = getCurrentRole2();
  const permission = COMMAND_PERMISSIONS2[command];
  if (role === "AGENT") {
    const agentMessage = permission?.denialMessage || `This command requires human approval. Ask the user to run \`work ${command}\``;
    return `Access denied: ${agentMessage}`;
  }
  const baseMessage = permission?.denialMessage || `This command is not available`;
  return `Access denied: ${baseMessage}`;
}

// src/lib/help.ts
function filterCommandsForRole(commands) {
  return commands.filter((cmd) => canExecuteCommand(cmd));
}
function getRoleFooter() {
  const role = getCurrentRole();
  return `Current role: ${role}`;
}
function isUserOnlyCommand(command) {
  const permission = COMMAND_PERMISSIONS[command];
  return permission?.allowedRoles.length === 1 && permission.allowedRoles[0] === "USER";
}

// bin/work.ts
var SUBCOMMANDS2 = {
  init: main35,
  create: main,
  current: main17,
  continue: main26,
  context: main27,
  fix: main28,
  "add-stage": main29,
  revision: main44,
  approve: main22,
  start: main42,
  plan: main47,
  status: main2,
  "set-status": main18,
  update: main3,
  complete: main4,
  index: main5,
  read: main6,
  list: main7,
  "add-task": main8,
  "add-batch": main9,
  "add-thread": main10,
  edit: main34,
  review: main11,
  validate: main12,
  check: main13,
  preview: main14,
  delete: main15,
  files: main16,
  report: main19,
  changelog: main20,
  export: main21,
  tasks: main30,
  agents: main31,
  assign: main32,
  prompt: main33,
  execute: main36,
  multi: main37,
  "multi-navigator": main38,
  "multi-grid": main39,
  tree: main40,
  github: main41,
  session: main43,
  notifications: main45,
  synthesis: main46
};
var COMMAND_DESCRIPTIONS = {
  init: "Initialize work/ directory with default config files",
  create: "Create a new workstream",
  current: "Get or set the current workstream",
  continue: "Continue execution (alias for 'work multi --continue')",
  context: "Show workstream context and resume information",
  "add-stage": "Append a fix stage to a workstream",
  fix: "(DEPRECATED) Use 'add stage' instead",
  approve: "Approve workstream plan/tasks/prompts (subcommands: plan, tasks, prompts)",
  start: "Start execution (requires all approvals, creates GitHub branch/issues)",
  plan: "Open planning session for workstream (resume or set session ID)",
  agents: "Manage agent definitions (list, add, remove)",
  assign: "Assign agents to threads for batch execution",
  prompt: "Generate thread execution prompt for agents",
  execute: "Execute a thread prompt via opencode",
  multi: "Execute all threads in a batch in parallel via tmux",
  status: "Show workstream progress",
  "set-status": "Set workstream status (pending, in_progress, completed, on_hold)",
  update: "Update a task's status",
  complete: "Mark a workstream as complete",
  index: "Update workstream metadata fields",
  read: "Read task details",
  list: "List tasks in a workstream",
  "add-task": "Add a task to a workstream (interactive if no flags)",
  "add-batch": "Add a batch to a stage",
  "add-thread": "Add a thread to a batch",
  edit: "Open PLAN.md in editor",
  delete: "Delete workstreams, stages, threads, or tasks",
  files: "List and index files in files/ directory",
  tasks: "Manage TASKS.md intermediate file (generate/serialize)",
  review: "Review plan, tasks, or commits (plan, tasks, commits)",
  validate: "Validate plan structure and content",
  check: "Find unchecked items in plan",
  preview: "Show PLAN.md structure",
  report: "Generate progress report (includes metrics)",
  changelog: "Generate changelog from completed tasks",
  export: "Export workstream data (md, csv, json)",
  tree: "Show workstream structure tree",
  github: "Manage GitHub integration (enable, create-branch, etc.)",
  session: "Manage agent sessions (complete stale sessions)",
  revision: "Manage workstream revisions",
  "multi-navigator": "Multi-session navigator mode",
  "multi-grid": "Multi-session grid layout",
  notifications: "Show notification configuration",
  synthesis: "Show synthesis configuration"
};
function printHelp46(showAllCommands = false) {
  const allCommands = Object.keys(SUBCOMMANDS2);
  const availableCommands = showAllCommands ? allCommands : filterCommandsForRole(allCommands);
  const commandLines = availableCommands.map((cmd) => {
    const description = COMMAND_DESCRIPTIONS[cmd] || "";
    const roleIndicator = isUserOnlyCommand(cmd) ? " [USER]" : "";
    const paddedCmd = cmd.padEnd(16);
    return `  ${paddedCmd}${description}${roleIndicator}`;
  });
  console.log(`
work - Workstream management CLI

Usage:
  work <command> [options]

Commands:
${commandLines.join(`
`)}

Options:
  --help, -h           Show this help message
  --version, -v        Show version
  --show-all-commands  Show all commands regardless of role restrictions

Current Workstream:
  Set a current workstream to use as default for all commands:
    work current --set "001-my-feature"

  Then run commands without --stream:
    work status
    work list --tasks
    work update --task "01.01.01.01" --status completed

Examples:
  work create --name my-feature
  work current --set "001-my-feature"
  work status
  work list --tasks
  work update --task "01.01.01.01" --status completed
  work add-task --stage 01 --Batch 01 --thread 01 --name "Task description"
  work files --save
  work report metrics --blockers
  work report --output report.md
  work export --format csv

Run 'work <command> --help' for more information on a command.

${getRoleFooter()}${showAllCommands ? " (showing all commands)" : ""}
`);
}
function printVersion() {
  console.log("work v0.1.0");
}
function main48(argv) {
  const args = argv ? argv.slice(2) : process.argv.slice(2);
  const showAllCommands = args.includes("--show-all-commands");
  const filteredArgs = args.filter((arg) => arg !== "--show-all-commands");
  if (filteredArgs.length === 0) {
    printHelp46(showAllCommands);
    process.exit(0);
  }
  const firstArg = filteredArgs[0];
  if (firstArg === "--help" || firstArg === "-h") {
    printHelp46(showAllCommands);
    process.exit(0);
  }
  if (firstArg === "--version" || firstArg === "-v") {
    printVersion();
    process.exit(0);
  }
  let subcommand = firstArg;
  let remainingArgs = filteredArgs.slice(1);
  if (firstArg === "add" && filteredArgs[1] === "stage") {
    subcommand = "add-stage";
    remainingArgs = filteredArgs.slice(2);
  }
  if (!(subcommand in SUBCOMMANDS2)) {
    console.error(`Error: Unknown command "${firstArg}"`);
    console.error(`
Available commands: ` + Object.keys(SUBCOMMANDS2).join(", "));
    console.error(`
Run 'work --help' for usage information.`);
    process.exit(1);
  }
  if (!canExecuteCommand2(subcommand)) {
    console.error(getRoleDenialMessage2(subcommand));
    process.exit(1);
  }
  const subcommandTyped = subcommand;
  const subcommandArgs = ["bun", `work-${subcommand}`, ...remainingArgs];
  SUBCOMMANDS2[subcommandTyped](subcommandArgs);
}
if (__require.main == __require.module) {
  main48();
}
export {
  main48 as main
};
