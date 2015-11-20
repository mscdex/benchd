var http = require('http');
var cp = require('child_process');
var fs = require('fs');
var path = require('path');
var os = require('os');
var urlParse = require('url').parse;

var serveStatic = require('serve-static');
var uuid = require('uuid');
var ejs = require('ejs');
var semver = require('semver');
var WebSocket = require('faye-websocket');

var gist = require('./gist');

var DEBUG = false;

var RE_GIST_ID = /^[a-f0-9]+$/;

var config = {
  // `child_process.spawn()` options:
  encoding: 'utf8',
  env: null,
  timeout: 5 * 60 * 1000,

  address: '0.0.0.0',
  jobAbandonTimeout: 30 * 1000,
  maxConcurrency: 1,
  maxJobSize: 512 * 1024,
  maxQueued: 1000,
  port: 80,
  targetsPath: process.cwd(),
  vanilla: true
};
var serve = serveStatic(path.join(__dirname, '..', 'public'), {
  index: false
});
var tplPath = path.join(__dirname, '..', 'templates');
var jobTpl = fs.readFileSync(path.join(tplPath, 'job.ejs'), 'utf8');
jobTpl = ejs.compile(jobTpl);
var benchmarkModulePath = JSON.stringify(require.resolve('benchmark'));
var syntaxErrArgs = [ path.join(__dirname, 'syntaxError.js') ];
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

function parseSyntaxError(str) {
  if (DEBUG)
    console.log('parseSyntaxError: %j', str);
  var m = /^__benchd_(setup|teardown|bench):(\d+)\r?\n[\s\S]+(SyntaxError[\s\S]+)$/.exec(str);
  if (!m)
    return false;
  var line = +m[2];
  if (!isNaN(line))
    return { source: m[1], stack: m[3], line: line };
  else
    return { source: m[1], stack: m[3] };
}

function gatherSyntaxErrors(errors, idx) {
  idx || (idx = 0);
  if (DEBUG) {
    console.log('gatherSyntaxErrors[%d]: current=%s',
                idx, errors && require('util').inspect(errors[idx]));
  }
  var current = errors[idx];
  var proc = cp.execFile(current.targetPath, syntaxErrArgs, config, callback);
  var jscode = current.job.codes.benchMap[current.benchName];
  if (DEBUG) {
    console.log('gatherSyntaxErrors[%d]: sending: %j',
                idx, jscode);
  }
  proc.stdin.end(jscode);
  function callback(err, stdout, stderr) {
    if (DEBUG) {
      console.log('gatherSyntaxErrors[%d]: err=%j; stdout=%j; stderr=%j',
                  idx, err, stdout, stderr);
    }
    var val = false;
    if (!err && stderr.length)
      val = parseSyntaxError(stderr.trim() + '\n' + current.stack);
    current.result.benchmarks[current.benchName] = val;
    if (current.job.ws)
      current.job.ws.send(JSON.stringify(current.job.targets));
    if (++idx === errors.length)
      return finishWork(current.job);
    gatherSyntaxErrors(errors, ++idx);
  }
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
    var errbuffer = '';
    var syntaxErrors = [];
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
    child.stdout.on('data', processOutcome);
    child.stderr.on('data', processSyntaxError);
    child.on('close', function(code, signal) {
      clearTimeout(timer);
      if (DEBUG) {
        console.log('processQueue(): target %s ended for job %s with code %j;' +
                    ' signal %j; failed %j',
                    v, job.id, code, signal, failed);
      }
      var idx = job.pids.indexOf(pid);
      if (~idx)
        job.pids.splice(idx, 1);
      if (code === 25 && !failed) {
        // We got a syntax error in setup or teardown code in vanilla mode

        // We need to append the stdout buffer because that is where the actual
        // syntax error message is
        errbuffer = errbuffer.trim() + '\n' + buffer + '\n';

        var errinfo = parseSyntaxError(errbuffer);
        if (!errinfo)
          fail();
        else {
          var changed = false;
          Object.keys(job.codes.benchMap).forEach(function(name) {
            if (result.benchmarks[name] === undefined) {
              changed = true;
              result.benchmarks[name] = errinfo;
            }
          });
          // Only node versions v0.8-v0.10 will have changed results here
          if (changed && job.ws)
            job.ws.send(JSON.stringify(job.targets));
        }
      } else if (code !== 0 && !failed)
        fail();
      if (code === 0 && syntaxErrors.length) {
        var first = syntaxErrors.shift();
        errbuffer = errbuffer.trim() + '\n' + first.stack;
        var errinfo = parseSyntaxError(errbuffer);
        result.benchmarks[first.benchName] = errinfo;
        if (job.ws)
          job.ws.send(JSON.stringify(job.targets));
        if (syntaxErrors.length)
          return gatherSyntaxErrors(syntaxErrors);
      }
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

    function processOutcome(chunk) {
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
            if (typeof ret.result === 'object' &&
                ret.result !== null &&
                ret.result.source === undefined &&
                ret.result.line === undefined) {
              // node versions v0.8-v0.10 suppress multiple syntax errors on
              // stderr, so we will have to queue up failed benchmarks for
              // independent checking/parsing
              if (DEBUG) {
                console.log('enqueueing benchmark %j for syntax check',
                            ret.name);
              }
              syntaxErrors.push({
                targetPath: targetPaths[v],
                job: job,
                result: result,
                stack: ret.result.stack,
                benchName: ret.name
              });
              continue;
            }
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

    function processSyntaxError(chunk) {
      errbuffer += chunk;
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
      child.stdout.removeListener('data', processOutcome);
      child.stderr.removeListener('data', processSyntaxError);
    }
  });
}



server = http.createServer(function(req, res) {
  if (req.method === 'GET') {
    var parsedUrl = urlParse(req.url, true);
    switch (parsedUrl.pathname) {
      case '/':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(mainHTML);
        return;
      case '/gist':
        var query = parsedUrl.query;
        if (query.id) {
          if (RE_GIST_ID.test(query.id)) {
            // TODO: change url depending on "secret" config value when that is
            // supported
            var url = 'https://gist.github.com/anonymous/' + query.id;
            gist.loadFromGist(url, function(err, obj) {
              if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                return res.end(err.message);
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(obj));
            });
          } else {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid gist id');
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing gist id');
        }
        return;
    }
  } else if (req.method === 'POST' && req.url === '/gist') {
    var buf = '';
    req.on('data', function(data) {
      buf += data;
    }).on('end', function() {
      var obj;

      try {
        obj = JSON.parse(buf);
      } catch (ex) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Invalid JSON');
      }

      try {
        gist.saveToGist(obj, function(err, url) {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end(err.message);
          }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(url);
        });
      } catch (ex) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end(ex.message);
      }
    });
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
        var benchMap = {};
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
          if (config.vanilla)
            bench.jscode = '"use strict";' + bench.jscode;
          benchMap[bench.name] = bench.jscode;
          bench.jscode = JSON.stringify(bench.jscode);
          bench.name = JSON.stringify(bench.name);
        }

        if (msg.setupCode) {
          if (typeof msg.setupCode !== 'string')
            return denyWS(ws, 4003, 'Wrong type for setup code');
          if (config.vanilla)
            msg.setupCode = '"use strict";' + msg.setupCode;
          msg.setupCode = JSON.stringify(msg.setupCode);
        }

        if (msg.teardownCode) {
          if (typeof msg.teardownCode !== 'string')
            return denyWS(ws, 4003, 'Wrong type for teardown code');
          if (config.vanilla)
            msg.teardownCode = '"use strict";' + msg.teardownCode;
          msg.teardownCode = JSON.stringify(msg.teardownCode);
        }

        job = {
          id: uuid.v4(),
          codes: {
            benchMap: benchMap,
            setupCode: msg.setupCode,
            teardownCode: msg.teardownCode
          },
          jobCode: jobTpl({
            benchmarks: benchmarks,
            benchmarkModulePath: benchmarkModulePath,
            vanilla: config.vanilla,
            setupCode: msg.setupCode,
            teardownCode: msg.teardownCode
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
          clearTimeout(job.timeout);
          job.timeout = null;
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
      if (DEBUG) {
        console.log('ws.onclose for %s:%d; code=%d; reason=%j',
                    remoteAddress, remotePort, event.code, event.reason);
      }
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

function printHelp() {
  console.log([
    'Usage: benchd [options] [--] [config_file]',
    '  Valid options:',
    '    --address <string>            Web interface address [default: 0.0.0.0]',
    '    --jobAbandonTimeout <number>  Time to wait for client reconnection before',
    '                                  automatically removing queued/running job',
    '                                  [default: 30 * 1000ms]',
    '    --maxConcurrency <number>     Max concurrent processes [default: 1]',
    '    --maxJobSize <number>         Max raw JSON size for a job [default: 512KB]',
    '    --maxQueued <number>          Max global queue size [default: 1000]',
    '    --port <number>               Web interface port [default: 80]',
    '    --targetsPath <string>        The path containing node binaries to test with',
    '                                  [default: current working directory]',
    '    --timeout <number>            Max execution time allowed for a node binary',
    '                                  [default: 5 * 60 * 1000ms]',
    '    --vanilla <true|false>        Executes all code in a more restricted',
    '                                  environment with no access to node modules',
    '                                  [default: true]',
    '',
    '  Config files are JSON documents that contain the same parameters'
  ].join('\r\n'));
}

(function() {
  // Process command line args
  var argv = process.argv;
  var configFiles = [];
  var cmdLnArgs = {};
  var foundFileArg = false;
  var cmdLnArgsKeys;
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h')
      return printHelp();
    else if (argv[i].slice(0, 2) === '--' && argv[i].length > 2) {
      var key = argv[i].slice(2);
      if ((i + 1) < argv.length) {
        if (argv[i + 1].slice(0, 2) === '--' && argv[i + 1].length > 2)
          cmdLnArgs[key] = true;
        else {
          cmdLnArgs[key] = argv[i + 1];
          ++i;
        }
      } else
        cmdLnArgs[key] = true;
    } else if (!foundFileArg) {
      foundFileArg = true;
      configFiles.push(argv[i]);
    }
  }

  cmdLnArgsKeys = Object.keys(cmdLnArgs);

  if (process.env.BENCHD_CONF)
    configFiles.push(process.env.BENCHD_CONF);

  var localConfigPath = path.join(process.cwd(), 'benchd.conf');
  configFiles.push(localConfigPath);

  var config_ = null;
  console.log('Checking for config ...');
  for (var i = 0; i < configFiles.length; ++i) {
    try {
      config_ = fs.readFileSync(configFiles[i], 'utf8');
      config_ = JSON.parse(config_);
      console.log('Using config from %s', configFiles[i]);
      break;
    } catch (ex) {
      config_ = null;
    }
  }

  if (typeof config_ === 'object' && config_ !== null) {
    if (cmdLnArgsKeys.length) {
      // Merge command line arguments with config file settings, with the former
      // taking precedence
      for (var i = 0; i < cmdLnArgsKeys.length; ++i)
        config_[cmdLnArgsKeys[i]] = cmdLnArgs[cmdLnArgsKeys[i]];
    }
  } else if (cmdLnArgsKeys.length)
    config_ = cmdLnArgs;

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
    if (config_.vanilla === false || config_.vanilla === 'false')
      config.vanilla = false;
    if (typeof config_.address === 'string')
      config.address = config_.address;
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
          server.listen(config.port, config.address);
        } catch (ex) {
          exit(5, 'Cannot listen on port for HTTP: %s', ex);
        }
      } else {
        exit(1, 'No usable executables found in %s', config.targetsPath);
      }
      return;
    }
    // Skip dot files
    if (files[i][0] === '.')
      return checkExecutable(i + 1);
    var stdout = '';
    var filePath = path.join(config.targetsPath, files[i]);
    try {
      var stats = fs.statSync(filePath);
      // Naive executability check (any executable bit set and regular file)
      if (stats.mode & 0x49 && stats.mode & 0x8000)
        var proc = cp.spawn(filePath, ['-pe', 'process.version']);
      else
       return checkExecutable(i + 1);
    } catch (ex) {
      // Skip files that resulted in error during stat()/spawn()
      return checkExecutable(i + 1);
    }
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
