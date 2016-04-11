/**
 * Module Dependencies
 */

var parent = require('./ipc')(process);
var BrowserWindow = require('electron').BrowserWindow;
var defaults = require('deep-defaults');
var assign = require('object-assign');
var join = require('path').join;
var sliced = require('sliced');
var renderer = require('electron').ipcMain;
var app = require('electron').app;
var fs = require('fs');

/**
 * Handle uncaught exceptions in the main electron process
 */

process.on('uncaughtException', function(e) {
  parent.emit('uncaughtException', e.stack)
})

/**
 * Update the app paths
 */

if (process.argv.length > 2) {
  var processArgs = JSON.parse(process.argv[3]);
  var paths = processArgs.paths;
  if (paths) {
    for (var i in paths) {
      app.setPath(i, paths[i]);
    }
  }
  var switches = processArgs.switches;
  if (switches) {
    for (var i in switches) {
      app.commandLine.appendSwitch(i, switches[i]);
    }
  }
}

//app.commandLine.appendSwitch('debug');
//app.commandLine.appendSwitch('remote-debug-port', 5858);

/**
 * Hide the dock
 */

// app.dock is not defined when running
// electron in a platform other than OS X
if (!processArgs.dock && app.dock) {
  app.dock.hide();
}

/**
 * Listen for the app being "ready"
 */

app.on('ready', function() {
  var win, options;

  parent.emit('log', 'ready');
  /**
   * create a browser window
   */

  parent.on('browser-initialize', function(opts) {
    parent.emit('log', 'browser init');
    options = defaults(opts || {}, {
      show: false,
      //alwaysOnTop: true,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        nodeIntegration: false
      }
    })

    /**
     * Create a new Browser Window
     */

    parent.emit('log', 'making a new browserwindow');
    win = new BrowserWindow(options);
    console.log('browserwindow made');

    renderer.on('page', function(sender/*, arguments, ... */) {
      parent.emit.apply(parent, ['page'].concat(sliced(arguments, 1)));
    });

    renderer.on('console', function(sender, type, args) {
      parent.emit.apply(parent, ['console', type].concat(args));
    });

    win.webContents.on('did-finish-load', forward('did-finish-load'));
    win.webContents.on('did-fail-load', forward('did-fail-load'));
    win.webContents.on('did-frame-finish-load', forward('did-frame-finish-load'));
    win.webContents.on('did-start-loading', forward('did-start-loading'));
    win.webContents.on('did-stop-loading', forward('did-stop-loading'));
    win.webContents.on('did-get-response-details', forward('did-get-response-details'));
    win.webContents.on('did-get-redirect-request', forward('did-get-redirect-request'));
    win.webContents.on('dom-ready', forward('dom-ready'));
    win.webContents.on('page-favicon-updated', forward('page-favicon-updated'));
    win.webContents.on('new-window', forward('new-window'));
    win.webContents.on('will-navigate', forward('will-navigate'));
    win.webContents.on('crashed', forward('crashed'));
    win.webContents.on('plugin-crashed', forward('plugin-crashed'));
    win.webContents.on('destroyed', forward('destroyed'));

    parent.emit('browser-initialize');
  });

  /**
   * Parent actions
   */

  /**
   * goto
   */

  parent.on('goto', function(url, headers) {
    var extraHeaders = '';
    for (var key in headers) {
      extraHeaders += key + ': ' + headers[key] + '\n';
    }

    if (win.webContents.getURL() == url) {
      parent.emit('goto');
    } else {
      win.webContents.loadURL(url, {
        extraHeaders: extraHeaders
      });
      win.webContents.once('did-finish-load', function() {
        parent.emit('goto');
      });
    }
  });

  /**
   * javascript
   */

  parent.on('javascript', function(src) {
    renderer.once('response', function(event, response) {
      parent.emit('javascript', null, response);
    });

    renderer.once('error', function(event, error) {
      parent.emit('javascript', error);
    });

    renderer.once('log', function(event, args) {
      parent.emit.apply(parent, ['log'].concat(args));
    });

    win.webContents.executeJavaScript(src);
  });

  parent.on('continue', function() {
    if (!win.webContents.isLoading()) {
      ready();
    } else {
      parent.emit('log', 'navigating...');
      win.webContents.once('did-stop-loading', function() {
        parent.emit('log', 'navigated to: ' + win.webContents.getURL());
        ready();
      });
    }

    function ready () {
      parent.emit('continue');
    }
  });

  parent.emit('ready');
});

/**
 * Forward events
 */

function forward(event) {
  return function () {
    try{
      if(!arguments[0].sender.isDestroyed()){
        console.log(arguments[0].sender.isDestroyed());
        parent.emit.apply(parent, [event].concat(sliced(arguments)));
      }
    }catch(e){
      console.log('error in forward: ' + e.message);
    }
  };
}
