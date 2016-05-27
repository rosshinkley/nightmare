/**
 * DEBUG=nightmare*
 */

var log = require('debug')('nightmare:log');
var debug = require('debug')('nightmare');
var electronLog = {
    stdout: require('debug')('electron:stdout'),
    stderr: require('debug')('electron:stderr')
};
var xvfbLog = {
    stdout: require('debug')('xvfb:stdout'),
    stderr: require('debug')('xvfb:stderr')
};
var dbusLog = {
    stdout: require('debug')('dbus:stdout'),
    stderr: require('debug')('dbus:stderr')
};
var proclog = require('debug')('nightmare:process');

/**
 * Module dependencies
 */

var default_electron_path = require('electron-prebuilt');
var source = require('function-source');
var proc = require('child_process');
var actions = require('./actions');
var path = require('path');
var sliced = require('sliced');
var child = require('./ipc');
var once = require('once');
var split2 = require('split2');
var noop = function() { };
var keys = Object.keys;

var util = require('util');
var fs = require('fs');

/**
 * Export `Nightmare`
 */

module.exports = Nightmare;

/**
 * runner script
 */

var runner = path.join(__dirname, 'runner.js');

/**
 * Template
 */

var template = require('./javascript');

/**
 * Initialize `Nightmare`
 *
 * @param {Object} options
 */

function Nightmare(options) {
    if (!(this instanceof Nightmare)) return new Nightmare(options);
    options = options || {};
    var electronArgs = {};
    var self = this;
    self.optionWaitTimeout = options.waitTimeout || 30000;

    var electron_path = options.electronPath || default_electron_path

    if (options.paths) {
        electronArgs.paths = options.paths;
    }

    if (options.switches) {
        electronArgs.switches = options.switches;
    }

    electronArgs.dock = options.dock || false;

    attachToProcess(this);

    // initial state
    this.state = 'initial';
    this.running = false;
    this.ending = false;
    this.ended = false;
    this._queue = [];
    this._headers = {};
    this.options = options;

    //stand up processes in the queue
    debug('queueing process start');
    this.queue(function(done) {
        if (process.env.NIGHTMARE_USE_XVFB) {
            fs.readdir('/tmp', function(err, files) {
                Nightmare.displayNumber = Nightmare.displayNumber || (files.map((file) => (file.match(/\.X(\d+)\-lock/) || [])[1])
                    .filter((fileNumber) => !!fileNumber)
                    .map((fileNumber) => parseInt(fileNumber))
                    .reduce((accumulator, fileNumber) => fileNumber > accumulator ? fileNumber : accumulator, 0)) + 1;

                options.virtualFramebufferArguments = options.virtualFramebufferArguments || ['-ac', '-screen', 'scrn', '1280x2000x24+32', `:${Nightmare.displayNumber}.0`];
                //if xvfb is not started, 
                if (!Nightmare.xvfbHandles) {
                    proclog('starting xvfb');
                    Nightmare.xvfbProcess = proc.spawn('Xvfb', options.virtualFramebufferArguments, {
                        stdio: [null, null, null]
                    });

                    Nightmare.xvfbProcess.stdout.pipe(split2()).on('data', (data) => {
                        xvfbLog.stdout(data);
                    });

                    Nightmare.xvfbProcess.stderr.pipe(split2()).on('data', (data) => {
                        xvfbLog.stderr(data);
                    });

                    proclog('xvfb started');
                    setTimeout(done, 350);
                }
                else {
                    done();
                }
            });
        } else {
            done();
        }
    });

    this.queue(function(done) {
        if (process.env.NIGHTMARE_USE_XVFB) {
            if (!Nightmare.xvfbHandles) {

                proclog('starting dbus-daemon');
                Nightmare.dbusProcess = proc.spawn('dbus-daemon', ['--nofork', '--session', '--print-address'], {
                    stdio: [null, null, null],
                    env: {
                        DISPLAY: `:${Nightmare.displayNumber}.0`
                    }
                });

                Nightmare.dbusProcess.stdout.pipe(split2()).on('data', (data) => {
                    dbusLog.stdout(data);
                });

                Nightmare.dbusProcess.stderr.pipe(split2()).on('data', (data) => {
                    dbusLog.stderr(data);
                });

                proclog('dbus-daemon started');

                Nightmare.xvfbHandles = (Nightmare.xvfbHandles || 0) + 1
                setTimeout(done, 350);
            }
            else {
                Nightmare.xvfbHandles = (Nightmare.xvfbHandles || 0) + 1
                done();
            }
        } else {
            done();
        }
    });
    this.queue(function(done) {
        proclog('starting electron');

        if (process.env.NIGHTMARE_USE_XVFB) {
            electronArgs.display = `:${Nightmare.displayNumber}`;
            self.electronProcess = proc.spawn(electron_path, [runner, JSON.stringify(electronArgs)], {
                stdio: [null, null, null, 'ipc'],
                env: {
                    DISPLAY: `:${Nightmare.displayNumber}.0`
                }
            });
        } else {
            self.electronProcess = proc.spawn(electron_path, [runner, JSON.stringify(electronArgs)], {
                stdio: [null, null, null, 'ipc'],
            });
        }

        self.electronProcess.stdout.pipe(split2()).on('data', (data) => {
            electronLog.stdout(data);
        });

        self.electronProcess.stderr.pipe(split2()).on('data', (data) => {
            electronLog.stderr(data);
        });

        self.electronProcess.on('close', function(code) {
            if (!self.ended) {
                handleExit(code, self, noop);
            }
        })

        proclog('electron started.');

        self.child = child(self.electronProcess);
        debug('initializing child');
        self.child.once('ready', function(versions) {
            self.engineVersions = versions;
            debug('initializing browser');

            // propagate console.log(...) through
            self.child.on('log', function() {
                log.apply(log, arguments);
            });

            self.child.on('uncaughtException', function(stack) {
                console.error('Nightmare runner error:\n\n%s\n', '\t' + stack.replace(/\n/g, '\n\t'));
                endInstance(self, noop);
                process.exit(1);
            });

            self.child.on('page', function(type) {
                log.apply(null, ['page-' + type].concat(sliced(arguments, 1)));
            });

            // proporate events through to debugging
            self.child.on('did-finish-load', function() { log('did-finish-load', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('did-fail-load', function() { log('did-fail-load', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('did-fail-provisional-load', function() { log('did-fail-provisional-load', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('did-frame-finish-load', function() { log('did-frame-finish-load', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('did-start-loading', function() { log('did-start-loading', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('did-stop-loading', function() { log('did-stop-loading', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('did-get-response-details', function() { log('did-get-response-details', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('did-get-redirect-request', function() { log('did-get-redirect-request', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('dom-ready', function() { log('dom-ready', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('page-favicon-updated', function() { log('page-favicon-updated', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('new-window', function() { log('new-window', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('will-navigate', function() { log('will-navigate', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('crashed', function() { log('crashed', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('plugin-crashed', function() { log('plugin-crashed', JSON.stringify(Array.prototype.slice.call(arguments))); });
            self.child.on('destroyed', function() { log('destroyed', JSON.stringify(Array.prototype.slice.call(arguments))); });

            self.child.call('browser-initialize', self.options, function() {
                debug('after browser init: ready');
                self.state = 'ready';
                done();
            });
        });
    });

    // initialize namespaces
    Nightmare.namespaces.forEach(function(name) {
        if ('function' === typeof this[name]) {
            this[name] = this[name]()
        }
    }, this)

    //prepend adding child actions to the queue
    Object.keys(Nightmare.childActions).forEach(function(key) {
        debug('queueing child action addition for "%s"', key);
        this.queue(function(done) {
            this.child.call('action', key, String(Nightmare.childActions[key]), done);
        });
    }, this);
}

function handleExit(code, instance, cb) {
    var help = {
        127: 'command not found - you may not have electron installed correctly',
        126: 'permission problem or command is not an executable - you may not have all the necessary dependencies for electron',
        1: 'general error - you may need xvfb',
        0: 'success!'
    };
    proclog('electron child process exited with code ' + code + ': ' + help[code]);
    instance.electronProcess.removeAllListeners();
    if (Nightmare.xvfbProcess && Nightmare.dbusProcess) {
        //decrement the process handles
        Nightmare.xvfbHandles--;
        proclog(`handles: ${Nightmare.xvfbHandles} xvfb`);
        //if the handles are zero, kill xvfb and dbus
        if (!Nightmare.xvfbHandles) {
            var dbusKilled = false; xvfbKilled = false;
            proclog('killing xvfb');
            Nightmare.xvfbProcess.on('close', function() {
                proclog('killing dbus');
                Nightmare.dbusProcess.on('close', function() {
                    Nightmare.dbusProcess.removeAllListeners();
                    Nightmare.xvfbProcess.removeAllListeners();
                    delete Nightmare.displayNumber;
                    proclog('electron ended successfully.');
                    //cooldown time from killing x and dbus
                    cb();
                });
                Nightmare.dbusProcess.kill();
            });
            Nightmare.xvfbProcess.kill();
        } else {
            cb();
        }
    } else {
        cb();
    }
};

function endInstance(instance, cb) {
    instance.ended = true;
    if (instance.electronProcess.connected) {
        instance.electronProcess.on('exit', function(code) {
            handleExit(code, instance, cb);
        });
        proclog('killing electron');
        instance.child.removeAllListeners();
        instance.electronProcess.kill();
    }
    detachFromProcess(instance);
}

/**
 * Attach any instance-specific process-level events.
 */
function attachToProcess(instance) {
    instance._endNow = endInstance.bind(null, instance, noop);
    process.setMaxListeners(Infinity);
    process.on('exit', instance._endNow);
    process.on('SIGINT', instance._endNow);
    process.on('SIGTERM', instance._endNow);
    process.on('SIGQUIT', instance._endNow);
    process.on('SIGHUP', instance._endNow);
    process.on('SIGBREAK', instance._endNow);
}

function detachFromProcess(instance) {
    process.removeListener('exit', instance._endNow);
    process.removeListener('SIGINT', instance._endNow);
    process.removeListener('SIGTERM', instance._endNow);
    process.removeListener('SIGQUIT', instance._endNow);
    process.removeListener('SIGHUP', instance._endNow);
    process.removeListener('SIGBREAK', instance._endNow);
}

/**
 * Namespaces to initialize
 */

Nightmare.namespaces = [];

/**
 * Child actions to create
 */

Nightmare.childActions = {};

/**
 * Version
 */
Nightmare.version = require(path.resolve(__dirname, '..', 'package.json')).version;

/**
 * Override headers for all HTTP requests
 */

Nightmare.prototype.header = function(header, value) {
    if (header && typeof value !== 'undefined') {
        this._headers[header] = value;
    } else {
        this._headers = header || {};
    }

    return this;
};

/**
 * Go to a `url`
 */

Nightmare.prototype.goto = function(url, headers) {
    debug('queueing action "goto" for %s', url);
    var self = this;

    headers = headers || {};
    for (var key in this._headers) {
        headers[key] = headers[key] || this._headers[key];
    }

    this.queue(function(fn) {
        debug('.goto()');
        self.child.call('goto', url, headers, fn);
    });
    return this;
};

/**
 * run
 */

Nightmare.prototype.run = function(fn) {
    debug('running')
    var steps = this.queue();
    this.running = true;
    this._queue = [];
    var self = this;

    // kick us off
    next();

    // next function
    function next(err, res) {
        var item = steps.shift();
        // Immediately halt execution if an error has been thrown, or we have no more queued up steps.
        if (err || !item) return done.apply(self, arguments);
        var args = item[1] || [];
        var method = item[0];
        args.push(once(after));
        method.apply(self, args);
    }

    function after(err, res) {
        var args = sliced(arguments);
        if (self.child) {
            self.child.call('continue', function() {
                next.apply(self, args);
            });
        } else {
            next.apply(self, args);
        }
    }

    function done() {
        self.running = false;
        var doneargs = arguments;
        if (self.ending) {
            endInstance(self, function() {
                return fn.apply(self, doneargs);
            });
        } else {
            return fn.apply(self, doneargs);
        }
    }

    return this;
};

/**
 * run the code now (do not queue it)
 *
 * you should not use this, unless you know what you're doing
 * it should be used for plugins and custom actions, not for
 * normal API usage
 */

Nightmare.prototype.evaluate_now = function(js_fn, done) {
    var args = Array.prototype.slice.call(arguments).slice(2);
    var argsList = JSON.stringify(args).slice(1, -1);
    var source = template.execute({ src: String(js_fn), args: argsList });

    this.child.call('javascript', source, done);
    return this;
};

/**
 * inject javascript
 */

Nightmare.prototype._inject = function(js, done) {
    this.child.call('javascript', template.inject({ src: js }), done);
    return this;
};

/**
 * end
 */

Nightmare.prototype.end = function(done) {
    this.ending = true;

    if (done && !this.running && !this.ended) {
        this.run(done);
    }

    return this;
};

/**
 * on
 */

Nightmare.prototype.on = function(event, handler) {
    this.queue(function(done) {
        this.child.on(event, handler);
        done();
    });
    return this;
};

/**
 * Queue
 */

Nightmare.prototype.queue = function(done) {
    if (!arguments.length) return this._queue;
    var args = sliced(arguments);
    var fn = args.pop();
    this._queue.push([fn, args]);
};


/**
 * then
 */

Nightmare.prototype.then = function(fulfill, reject) {
    var self = this;

    return new Promise(function(success, failure) {
        self.run(function(err, result) {
            if (err) failure(err);
            else success(result);
        })
    })
        .then(fulfill, reject);
};

/**
 * use
 */

Nightmare.prototype.use = function(fn) {
    fn(this)
    return this
};

// wrap all the functions in the queueing function
function queued(name, fn) {
    return function action() {
        debug('queueing action "' + name + '"');
        var args = [].slice.call(arguments);
        this._queue.push([fn, args]);
        return this;
    }
}

/**
 * Static: Support attaching custom actions
 *
 * @param {String} name - method name
 * @param {Function|Object} [childfn] - Electron implementation
 * @param {Function|Object} parentfn - Nightmare implementation
 * @return {Nightmare}
 */

Nightmare.action = function() {
    var name = arguments[0], childfn, parentfn;
    if (arguments.length === 2) {
        parentfn = arguments[1];
    } else {
        parentfn = arguments[2];
        childfn = arguments[1];
    }

    // support functions and objects
    // if it's an object, wrap it's
    // properties in the queue function

    if (parentfn) {
        if (typeof parentfn === 'function') {
            Nightmare.prototype[name] = queued(name, parentfn);
        } else {
            if (!~Nightmare.namespaces.indexOf(name)) {
                Nightmare.namespaces.push(name);
            }
            Nightmare.prototype[name] = function() {
                var self = this;
                return keys(parentfn).reduce(function(obj, key) {
                    obj[key] = queued(name, parentfn[key]).bind(self)
                    return obj;
                }, {});
            }
        }
    }

    if (childfn) {
        if (typeof childfn === 'function') {
            Nightmare.childActions[name] = childfn;
        } else {
            for (var key in childfn) {
                Nightmare.childActions[name + '.' + key] = childfn;
            }
        }
    }
}

/**
 * Attach all the actions.
 */

Object.keys(actions).forEach(function(name) {
    var fn = actions[name];
    Nightmare.action(name, fn);
});
