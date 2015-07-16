var http = require('http');
var cp = require('child_process');
var fs = require('fs');
var path = require('path');
var os = require('os');

var serveStatic = require('serve-static');
var uuid = require('uuid');
var ejs = require('ejs');
var semver = require('semver');
var WebSocket = require('faye-websocket');

var DEBUG = false;

var config = {
  // `child_process.spawn()` options:
  timeout: 5 * 60 * 1000,
  encoding: 'utf8',
  env: null,

  port: 80,
  maxConcurrency: 1,
  targetsPath: process.cwd(),
  maxQueued: 1000,
  maxJobSize: 512 * 1000,
  jobAbandonTimeout: 30 * 1000,
  vanilla: false
};
var serve = serveStatic(path.join(__dirname, '..', 'public'), {
  index: false
});
var tplPath = path.join(__dirname, '..', 'templates');
var jobTpl = fs.readFileSync(path.join(tplPath, 'job.ejs'), 'utf8');
jobTpl = ejs.compile(jobTpl);
var benchmarkModulePath = JSON.stringify(require.resolve('benchmark'));
var queue = [];
var targets = [];
var targetPaths = {};
var noArgs = [];
var mainHTML;
var current;
var server;
var wsOpts;

function noopErrorHandler(err) {}

function exit(code) {
  if (arguments.length > 1)
    console.error.apply(console, Array.prototype.slice.call(arguments, 1));
  process.exit(code);
}

function notifyJobOwners() {
  if (DEBUG)
    console.log('notifyJobOwners()');
  for (var i = 0; i < queue.length; ++i) {
    var job = queue[i];
    if (!job.stopped && job.ws)
      job.ws.send(''+i);
  }
}

function isPosNum(val) {
  val = Math.floor(val);
  return (isFinite(val) && val >= 0);
}

function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (ex) {}
}

function denyWS(ws, code, err) {
  if (typeof code === 'string')
    ws.close(code);
  else
    ws.close(code, err);
}

function finishWork(job) {
  // Notify client of new result(s)
  if (DEBUG)
    console.log('finishWork() for %s', job.id);
  if (job.ws)
    job.ws.send(JSON.stringify(job.targets));

  if (job.stopped ||
      (job.pids.length === 0 &&
       job.targets.waiting.length === 0)) {
    if (job.ws)
      job.ws.close(4001);
    clearTimeout(job.timeout);
    job.stopped = true;
    current = null;
    processQueue(false);
  } else
    processQueue(true);
}

function processQueue(skipCheck) {
  if (DEBUG) {
    console.log('processQueue(%j): current? %j; queue.length=%d',
                skipCheck, !!current, queue.length);
  }
  if ((current && !skipCheck) || (!current && !queue.length))
    return;

  if (!current) {
    notifyJobOwners();
    current = queue.shift();
  }
  var job = current;
  var nprocs = Math.min(job.concurrency, job.targets.waiting.length);
  var versions = job.targets.waiting.splice(0, nprocs);
  if (DEBUG) {
    console.log('processQueue(): starting %d target(s) for job %s: %j',
                nprocs, job.id, versions);
  }
  versions.forEach(function(v) {
    var timer = setTimeout(function() {
      if (DEBUG) {
        console.log('processQueue(): killing target %s for job %s (timeout)',
                    v, job.id);
      }
      child.kill('SIGKILL');
    }, config.timeout);
    var failed = false;
    var result = { fastest: null, benchmarks: {} };
    var buffer = '';
    var child = cp.spawn(targetPaths[v], noArgs, config);
    var pid = child.pid;

    job.pids.push(pid);
    job.targets.results[v] = result;

    if (job.ws)
      job.ws.send(JSON.stringify(job.targets));

    if (DEBUG) {
      console.log('processQueue(): spawning target %s for job %s; pid=%d',
                  v, job.id, pid);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', processChunk);
    child.on('close', function(code, signal) {
      clearTimeout(timer);
      if (DEBUG) {
        console.log('processQueue(): target %s ended for job %s',
                    v, job.id);
      }
      var idx = job.pids.indexOf(pid);
      if (~idx)
        job.pids.splice(idx, 1);
      if (code !== 0 && !failed)
        fail();
      finishWork(job);
    });
    if (DEBUG) {
      var stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', function(data) {
        stderr += data;
      });
      child.on('close', function(code, signal) {
        if (stderr.length) {
          console.log('target %s for job %s had stderr:', v, job.id);
          console.log('================================');
          console.log(stderr);
          console.log('================================');
        }
      });
    }
    child.stdin.end(job.jobCode);

    function processChunk(chunk) {
      if (failed)
        return;
      buffer += chunk;
      if (~buffer.indexOf('\n')) {
        var lines = buffer.split('\n');
        buffer = lines.splice(-1, 1).join('');
        for (var i = 0; i < lines.length; ++i) {
          if (DEBUG) {
            console.log('target %s for job %s had line: %j',
                        v, job.id, lines[i]);
          }
          var ret = tryParseJSON(lines[i]);
          if (Array.isArray(ret)) {
            // Fastest benchmark(s)
            result.fastest = ret;
          } else if (typeof ret === 'object' && ret !== null) {
            // Benchmark result
            result.benchmarks[ret.name] = ret.result;
          } else {
            fail();
            child.kill('SIGKILL');
            return;
          }
        }
        // Notify client of new result(s)
        if (job.ws)
          job.ws.send(JSON.stringify(job.targets));
      }
    }

    function fail() {
      if (failed)
        return;
      failed = true;
      result.fastest = false;
      for (var j = 0; j < job.benchNames.length; ++j) {
        if (result.benchmarks[job.benchNames[j]] === undefined)
          result.benchmarks[job.benchNames[j]] = null;
      }
      child.stdout.removeListener('data', processChunk);
    }
  });
}

server = http.createServer(function(req, res) {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(mainHTML);
    return;
  }
  serve(req, res, function() {
    res.statusCode = 404;
    res.end();
  });
});
server.on('upgrade', function(req, socket, body) {
  if (req.url === '/ws' && WebSocket.isWebSocket(req)) {
    var remoteAddress = socket.remoteAddress;
    var remotePort = socket.remotePort;
    if (DEBUG)
      console.log('websocket request from %s:%d', remoteAddress, remotePort);
    var ws = new WebSocket(req, socket, body, null, wsOpts);

    function resetPingTimeout() {
      clearTimeout(pingTmr);
      if (ws)
        pingTmr = setTimeout(closeSocket, 30 * 1000);
    }
    function closeSocket() {
      if (ws)
        ws.close(4000);
    }
    function resetIdTimeout() {
      if (ws)
        idTmr = setTimeout(closeSocket, 10 * 1000);
    }
    var pingTmr;
    var idTmr;
    var job;

    ws.on('open', function (event) {
      if (DEBUG)
        console.log('ws.onopen for %s:%d', remoteAddress, remotePort);
      resetIdTimeout();
    });

    ws.on('error', noopErrorHandler);

    ws.on('message', function(event) {
      if (DEBUG) {
        console.log('ws.onmessage for %s:%d: %j',
                    remoteAddress, remotePort, event.data);
      }
      if (typeof event.data !== 'string')
        return denyWS(ws, 1003, 'Binary data not supported');
      if (event.data.length > config.maxJobSize)
        return denyWS(ws, 1009, 'Job size too large');

      if (job)
        resetPingTimeout();

      if (!event.data.length)
        return;

      if (event.data === 'ping') {
        if (job)
          ws.send('ping');
        return;
      } else if (job)
        return;

      var msg = tryParseJSON(event.data);

      if (typeof msg === 'object' && msg !== null) {
        // New job
        clearTimeout(idTmr);

        var concurrency;
        var reqTargets;
        var jobTargets;

        if (queue.length === config.maxQueued) {
          denyWS(ws,
                 4002,
                 'Cannot accept new benchmark requests at this time.' +
                 ' Please try again later.');
          return;
        }

        if (!Array.isArray(msg.benchmarks) || !msg.benchmarks.length)
          return denyWS(ws, 4003, 'Missing JS code');

        if (!Array.isArray(msg.targets) || !msg.targets.length)
          return denyWS(ws, 4003, 'Missing target(s)');

        concurrency = Math.floor(msg.concurrency);
        if (!isFinite(concurrency) ||
            concurrency < 1 ||
            concurrency > config.maxConcurrency)
          return denyWS(ws, 4003, 'Missing/Invalid concurrency');

        reqTargets = msg.targets;
        jobTargets = [];
        for (var i = 0; i < reqTargets.length; ++i) {
          var reqTarget = reqTargets[i];
          for (var j = 0; j < targets.length; ++j) {
            var t = targets[j];
            if (t === reqTarget && jobTargets.indexOf(t) === -1) {
              jobTargets.push(t);
              break;
            }
          }
        }
        if (!jobTargets.length)
          return denyWS(ws, 4003, 'No valid target(s) selected');

        var benchmarks = msg.benchmarks;
        var benchNames = [];
        for (var i = 0; i < benchmarks.length; ++i) {
          var bench = benchmarks[i];
          if (typeof bench !== 'object')
            return denyWS(ws, 4003, 'Malformed benchmark #' + (i+1) + ']');
          if (typeof bench.name !== 'string' || !bench.name.length) {
            return denyWS(ws,
                          4003,
                          'Missing name for benchmark #' + (i+1) + ']');
          }
          if (~benchNames.indexOf(bench.name)) {
            return denyWS(ws,
                          4003,
                          'Duplicate name for benchmark #' + (i+1) + ']: ' +
                          bench.name);
          }
          benchNames.push(bench.name);
          bench.name = JSON.stringify(bench.name);
          if (config.vanilla) {
            bench.jscode = 'new Function(' +
                           JSON.stringify('"use strict";' + bench.jscode) +
                           ')';
          }
          bench.jscode = JSON.stringify(bench.jscode);
        }

        job = {
          id: uuid.v4(),
          jobCode: jobTpl({
            benchmarks: benchmarks,
            benchmarkModulePath: benchmarkModulePath,
            vanilla: config.vanilla
          }),
          benchNames: benchNames,
          targets: {
            waiting: jobTargets,
            results: {}
          },
          concurrency: concurrency,
          pids: [],
          ws: ws,
          stopped: false,
          timeout: null,
          remove: function() {
            if (DEBUG)
              console.log('Job %s abandoned', job.id);
            var idx;
            if (current !== job && (idx = queue.indexOf(job)) === -1)
              return;

            // We're still in the queue or currently running

            if (DEBUG)
              console.log('... killing');

            if (idx !== undefined)
              queue.splice(idx, 1);

            job.stopped = true;

            var pids = job.pids;
            for (var i = 0; i < pids.length; ++i)
              process.kill(pids[i], 'SIGKILL');
            job.pids = [];
          }
        };
        queue.push(job);
        ws.send('{"id":"' + job.id + '","pos":' + queue.length + '}');
        processQueue(false);
        return resetPingTimeout();
      } else if (msg === undefined) {
        // User reconnected

        clearTimeout(idTmr);

        var id = event.data;

        if (current && current.id === id) {
          job = current;
          ws.send('0');
        } else {
          for (var i = 0; i < queue.length; ++i) {
            if (queue[i].id === id) {
              job = queue[i];
              clearTimeout(job.timeout);
              job.timeout = null;
              ws.send(''+(i+1));
              break;
            }
          }
        }

        if (job) {
          job.ws = ws;
          ws.send(JSON.stringify(job.targets));
          resetPingTimeout();
        } else
          denyWS(ws, 4004, 'Invalid job id');

        return;
      }

      denyWS(ws, 4005, 'Malformed message');
    });

    ws.on('close', function(event) {
      ws = null;
      clearTimeout(idTmr);
      clearTimeout(pingTmr);
      if (DEBUG)
        console.log('ws.onclose for %s:%d', remoteAddress, remotePort);
      if (job) {
        job.ws = null;
        if (!job.stopped)
          job.timeout = setTimeout(job.remove, config.jobAbandonTimeout);
      }
    });
  }
});
server.on('error', function(err) {
  exit(5, 'HTTP server error: %s', err);
});
server.on('listening', function() {
  wsOpts = { maxLength: config.maxJobSize };
  mainHTML = fs.readFileSync(path.join(tplPath, 'main.ejs'), 'utf8');
  mainHTML = ejs.render(mainHTML, {config: config, targets: targets});
  var addrport = server.address();
  console.log('Targets found:');
  targets.forEach(function(t) {
    console.log(' * %s @ %s', t, targetPaths[t]);
  });
  console.log('benchd server listening on %s port %d',
              addrport.address, addrport.port);
});



// Initialization ....

(function() {
  var config_ = null;
  console.log('Checking for config ...');
  if (process.env.BENCHD_CONF) {
    try {
      config_ = fs.readFileSync(process.env.BENCHD_CONF, 'utf8');
      config_ = JSON.parse(config_);
      console.log('Using config from %s', process.env.BENCHD_CONF);
    } catch (ex) {
      config_ = null;
    }
  }
  if (typeof config_ !== 'object') {
    try {
      var localConfig = path.join(process.cwd(), 'benchd.conf');
      config_ = fs.readFileSync(localConfig, 'utf8');
      config_ = JSON.parse(config_);
      console.log('Using config from %s', localConfig);
    } catch (ex) {
      config_ = null;
    }
  }
  if (typeof config_ === 'object' && config_ !== null) {
    if (isPosNum(config_.port))
      config.port = Math.floor(config_.port);
    if (isPosNum(config_.timeout))
      config.timeout = Math.floor(config_.timeout);
    if (config_.maxConcurrency === '-1')
      config.maxConcurrency = os.cpus().length;
    else if (isPosNum(config_.maxConcurrency))
      config.maxConcurrency = Math.floor(config_.maxConcurrency);
    if (isPosNum(config_.maxQueued))
      config.maxQueued = Math.floor(config_.maxQueued);
    if (isPosNum(config_.maxJobSize))
      config.maxJobSize = Math.floor(config_.maxJobSize);
    if (typeof config_.targetsPath === 'string')
      config.targetsPath = config_.targetsPath;
    if (isPosNum(config_.jobAbandonTimeout))
      config.jobAbandonTimeout = config_.jobAbandonTimeout;
    if (config_.vanilla === false)
      config.vanilla = false;
  } else {
    console.log('Using default config');
  }

  var files;
  try {
    files = fs.readdirSync(config.targetsPath);
  } catch (ex) {
    exit(1, 'Cannot access path to executables: %s', ex);
  }

  (function checkExecutable(i) {
    if (i === files.length) {
      if (targets.length) {
        targets.sort(semver.rcompare);
        try {
          server.listen(config.port);
        } catch (ex) {
          exit(5, 'Cannot listen on port for HTTP: %s', ex);
        }
      } else {
        exit(1, 'No usable executables found in %s', config.targetsPath);
      }
      return;
    }
    var stdout = '';
    var filePath = path.join(config.targetsPath, files[i]);
    var proc = cp.spawn(filePath, ['-pe', 'process.version']);
    var timeout = setTimeout(function() {
      proc.kill();
    }, 10 * 1000);
    // Just swallow errors
    proc.on('error', noopErrorHandler);
    proc.stdout.setEncoding('ascii');
    proc.stdout.on('data', function(chunk) {
      stdout += chunk;
      if (stdout.length > 50)
        proc.kill();
    });
    proc.on('close', function(code) {
      clearTimeout(timeout);
      if (code === 0 &&
          /^v\d+\.\d+\.\d+/.test(stdout) &&
          stdout.slice(-1) === '\n') {
        var version = stdout.trim();
        targets.push(version);
        targetPaths[version] = filePath;
      }
      checkExecutable(i + 1);
    });
  })(0);
})();

