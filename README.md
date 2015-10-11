Description
===========

benchd is a tool for benchmarking JavaScript code across different node.js/io.js versions from the browser.


Requirements
============

* Backend: [node.js](http://nodejs.org/) -- v0.10.0 or newer

* Frontend: Any modern browser with WebSocket support


Install
=======

    npm install -g benchd


Config
======

Configuration is achieved by a JSON formatted config file. If the `BENCHD_CONF` environment variable is set and points to a valid file, that will be used. Otherwise the server will look in the current working directory for `benchd.conf`. If that also fails, then defaults will be used. Any command-line arguments of the same names will override any other config source.

Available config options:

* **address** - _string_ - This is the address the server listens on. **Default: 0.0.0.0**

* **jobAbandonTimeout** - _integer_ - This is the amount of time in milliseconds to allow a job's owner to be disconnected before removing (and stopping, if currently executing) the job. **Default: 30 * 1000**

* **maxConcurrency** - _integer_ - This is the maximum number of target processes that are allowed to run at any given time. Set to `-1` as an alias for the number of available CPUs. **Default: 1**

* **maxJobSize** - _integer_ - This is the maximum size (in bytes) for a job (the JSON stringified version, including all benchmarks). **Default: 512 * 1024**

* **maxQueued** - _integer_ - This is the maximum number of queued jobs. **Default: 1000**

* **port** - _integer_ - This is the port the server listens on. **Default: 80**

* **targetsPath** - _string_ - This is the directory containing the target executables to make available for benchmarking against. **Default: (current working directory)**

* **timeout** - _integer_ - This is the target process timeout in milliseconds. **Default: 5 * 60 * 1000**

* **vanilla** - _boolean_ - Restrict benchmark code to a "pure"/vanilla JavaScript environment (e.g. no `require()`, `process`, etc.). **If you disable this and are making the server public, _PLEASE_ start the server in an appropriately protected environment.** **Default: true**


Todo
====

* Add support for async ("deferred") option for benchmarks

* Better WebSocket error handling

* Add per-benchmark timeout configuration option

* Ability to easily share benchmark results

* Add support for remote targets (e.g. via ssh) for multi-platform benchmarking

* Tests
