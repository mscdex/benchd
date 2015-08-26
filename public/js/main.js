var DEBUG = false;

var resultsTableInfo;
var $benchTpl;
var $setupCode;
var $teardownCode;
var $benchmarks;
var $submitButton;
var $targets;
var $concurrency;
var $status;
var $results;
var $resultsTable;
var $benchAdd;
var $gistDesc;
var resultBusyHtml = '<img src="/img/working.gif" aria-hidden="true" />';
var resultTargetErrHtml = '<span class="glyphicon glyphicon-exclamation-sign"' +
                          ' aria-hidden="true"></span> Target Process Error';
var resultBenchPErrHtml = '<span class="glyphicon glyphicon-exclamation-sign"' +
                          ' aria-hidden="true"></span> ' +
                          'JS Error (no stacktrace)';
var resultErrAttrs = { 'data-state': 'error', 'class': 'danger' };
var resultErrStyle = { 'color': 'red', 'font-weight': 'bold' };
var entityMap = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': '&quot;',
  "'": '&#39;',
  "/": '&#x2F;'
};

function escapeHtml(string) {
  return String(string).replace(/[&<>"'\/]/g, function (s) {
    return entityMap[s];
  });
}

function makeResultErrorHTML(err) {
  if (typeof err === 'object') {
    // We were able to extract a stack trace and possibly a line
    // number
    var source;
    switch (err.source) {
      case 'setup':
        source = 'Setup code';
        break;
      case 'teardown':
        source = 'Teardown code';
        break;
      case 'bench':
        source = 'Benchmark code';
        break;
      default:
        source = 'Unknown';
    }
    var content = '<strong>Source:</strong> ' + source + '<br />';
    if (err.line !== undefined) {
      content += '<strong>Line #: <span class=&quot;text-danger&quot;>' +
                 err.line + '</span></strong><br />';
    }
    content += '<strong>Stack Trace:</strong><br />' +
               escapeHtml(err.stack).replace(/\r?\n/g, '<br />');
    return '<button class="btn btn-danger has-popover" data-content="' +
           content + '"><span class="glyphicon glyphicon-exclamation-sign"' +
           ' aria-hidden="true"></span> JS Error</button>';
  } else {
    // Something went wrong when parsing the stack trace
    return resultBenchPErrHtml;
  }
}

function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (ex) {}
}

function generateJobJSON(saveOnly) {
  var job;
  if (!saveOnly) {
    job = {
      concurrency: 1,
      targets: [],
      benchmarks: []
    };
  } else {
    job = {
      benchmarks: []
    };
  }
  var benchNames = [];
  var benchmarks = job.benchmarks;

  if (!saveOnly) {
    job.concurrency = Math.floor($concurrency.val());
    if (!isFinite(job.concurrency) || job.concurrency <= 0) {
      alert('Invalid concurrency');
      return false;
    }
    job.targets = $targets.val();
    if (job.targets === null || !job.targets.length) {
      alert('You must select at least one target');
      return false;
    }
  }
  var $entries = $benchmarks.children();
  for (var i = 0; i < $entries.length; ++i) {
    var name = $($entries[i]).find('input.benchName').val();
    var jscode = $($entries[i]).find('textarea.benchCode').val();
    if (!name.length && jscode.length) {
      alert('Benchmark #' + (i+1) + ' is missing a name');
      return false;
    } else if (name.length && jscode.length) {
      for (var b = 0; b < benchmarks.length; ++b) {
        if (benchmarks[b].name === name) {
          alert('Benchmark #' + (i+1) + '\'s name is already used');
          return false;
        }
      }
      benchNames.push(escapeHtml(name));
      benchmarks.push({ name: name, jscode: jscode });
      continue;
    }
    $entries[i].remove();
  }
  if (!benchmarks.length) {
    alert('No benchmarks to ' + (saveOnly ? 'save' : 'submit'));
    return false;
  }
  var setupCode = $setupCode.find('textarea.setupCode').val();
  var teardownCode = $teardownCode.find('textarea.teardownCode').val();
  if (setupCode.trim().length) {
    if (!saveOnly)
      job.setupCode = setupCode;
    else
      benchmarks.unshift({ setup: true, jscode: setupCode });
  }
  if (teardownCode.trim().length) {
    if (!saveOnly)
      job.teardownCode = teardownCode;
    else
      benchmarks.push({ teardown: true, jscode: teardownCode });
  }
  if (!saveOnly)
    resultsTableInfo = [job.targets, benchNames];
  else {
    var desc = $gistDesc.val().trim();
    if (desc.length)
      job.description = desc;
  }
  return JSON.stringify(job);
}

function submitJob(jobId, fullTries) {
  var socket;
  var socketTimer;
  var pingTimer;
  var jobJSON;

  if (!jobId) {
    $submitButton.attr('disabled', 'disabled');
    jobJSON = generateJobJSON(false);
    if (jobJSON === false) {
      $submitButton.removeAttr('disabled');
      return;
    }
  }

  fullTries || (fullTries = 1);
  $status.text('Status: Connecting ...');

  socket = new WS('ws://' + window.location.host + '/ws');

  function resetSocketTimeout() {
    clearTimeout(socketTimer);
    if (socket)
      socketTimer = setTimeout(closeSocket, 30 * 1000);
  }
  function pingInterval() {
    if (socket) {
      resetSocketTimeout();
      socket.send('ping');
    } else
      clearInterval(pingTimer);
  }
  function closeSocket() {
    if (socket)
      socket.close();
  }
  function resetPingTimer() {
    clearTimeout(socketTimer);
    clearInterval(pingTimer);
    if (socket)
      pingTimer = setInterval(pingInterval, 20 * 1000);
  }

  socket.onopen = function(event) {
    if (DEBUG)
      console.log('onopen');
    if (jobId) {
      $status.text('Status: Connected. Checking current job status ...');
      socket.send(jobId);
    } else {
      $status.text('Status: Connected. Submitting job ...');
      socket.send(jobJSON);
    }
    resetPingTimer();
  };
  socket.onmessage = function(event) {
    clearTimeout(socketTimer);
    if (DEBUG) {
      console.log('onmessage:');
      console.dir(event.data);
    }
    var ret = tryParseJSON(event.data);
    if (typeof ret === 'object') {
      if (ret.id) {
        // Job queued
        jobId = ret.id;
        $status.text('Status: Your job is now #' + ret.pos + ' in the queue');

        // Prepare results table
        var targets = resultsTableInfo[0];
        var benchmarks = resultsTableInfo[1];
        var targetsLen = targets.length;
        var html = '<tr><th>&nbsp;</th>';
        var filler = '';
        for (var i = 0; i < targetsLen; ++i) {
          html += '<th>' + targets[i] + '</th>';
          filler += '<td data-state="waiting"></td>';
        }
        html += '</tr>';
        for (var i = 0; i < benchmarks.length; ++i)
          html += '<tr><td>' + benchmarks[i] + '</td>' + filler + '</tr>';
        $resultsTable.html(html);
        $results.removeClass('hidden');
      } else {
        // Job progress update notification
        var targets = resultsTableInfo[0];
        var benchmarks = resultsTableInfo[1];
        var targetsLen = targets.length;
        var results = ret.results;
        var $tds = $resultsTable.find('tr td:not(:first-child)');
        for (var i = 0; i < $tds.length; ++i) {
          var target = targets[i % targetsLen];
          var result = results[target];
          if (!result) {
            // The benchmarks for this target haven't started executing yet
            continue;
          }
          var $td = $($tds[i]);
          var state = $td.attr('data-state');
          if (result.fastest === false) {
            // The target process unexpectedly failed for some reason

            if (state === 'error')
              continue;

            $td.attr(resultErrAttrs)
               .css(resultErrStyle)
               .html(resultTargetErrHtml);
          } else {
            var benchIdx = Math.floor(i / targetsLen);
            var benchName = benchmarks[benchIdx];
            var benchResult = result.benchmarks[benchName];
            if (benchResult !== undefined) {
              // This benchmark finished

              if (state === 'done') {
                if (result.fastest &&
                    ~result.fastest.indexOf(benchName))
                  $td.addClass('success');
                continue;
              }

              if (typeof benchResult === 'string') {
                // Successful benchmark completion
                $td.attr('data-state', 'done')
                   .html(benchResult.replace('(', '<br />('));
              } else {
                // Benchmark ended in error
                $td.attr(resultErrAttrs)
                   .html(makeResultErrorHTML(benchResult));
              }
            } else if (state === 'waiting') {
              // We're transitioning from waiting to working
              $td.attr('data-state', 'working')
                 .html(resultBusyHtml);
            }
          }
        }
      }
    } else if (typeof ret === 'number') {
      // Job position update
      if (ret === 0)
        $status.text('Status: Your job is currently running ...');
      else
        $status.text('Status: Your job is now #' + ret + ' in the queue');
    }
  };
  socket.onclose = function(event) {
    socket = null;
    resetPingTimer();
    if (DEBUG)
      console.log('onclose: code=' + event.code + '; reason=' + event.reason);
    switch (event.code) {
      case 4000:
        // Ping timeout, typically we shouldn't see this unless traffic is being
        // blocked or greatly slowed in one direction only...
        setTimeout(submitJob, 3000, jobId);
        break;
      case 4001:
        // Job finished
        $status.text('Status: Job complete!');
        $submitButton.removeAttr('disabled');
        break;
      case 4002:
        // Job queue full right now, try again later
        $status.text('Status: Job queue full, retrying in a bit (' +
                     fullTries + ' tr' + (fullTries > 1 ? 'ies' : 'y') +
                     ' so far) ...');
        setTimeout(submitJob, 20 * 1000, jobId, fullTries + 1);
        break;
      case 4004:
        // Job with supplied job ID does not exist
      case 1009:
        // Job size too large
      case 4003:
        // Input validation error
        $status.text('Status: Error: ' + event.reason);
        $submitButton.removeAttr('disabled');
        break;
      default:
        if (event.code < 4000) {
          $status.text('Status: Unknown error (' + event.code + '): ' +
                       event.reason);
        }
        $submitButton.removeAttr('disabled');
    }
  };
}

function setupEditor(dest) {
  var $dest = $(dest);
  if ($dest.attr('data-editor') !== 'true') {
    var $textarea = $dest.find('textarea');
    var editDiv = $('<div>', {
      width: $textarea.width(),
      height: $textarea.height(),
      'class': $textarea.attr('class')
    }).insertBefore($textarea);

    $textarea.addClass('hidden');

    var editor = ace.edit(editDiv[0]);
    var session = editor.getSession();

    editor.setTheme('ace/theme/chrome');
    editor.setAnimatedScroll(false);
    editor.setHighlightActiveLine(true);
    editor.renderer.setShowGutter(true);
    editor.renderer.setPrintMarginColumn(false);
    editor.renderer.setShowInvisibles(false);
    session.setValue($textarea.val(), -1);
    session.setMode('ace/mode/javascript');
    session.on('change', function() {
      $textarea.val(editor.getValue());
    });
    session.setTabSize(2);
    session.setUseSoftTabs(true);
    session.setNewLineMode('auto');
    session.setUseWrapMode(true);
    session.setUseWorker(false);

    $dest.attr('data-editor', 'true');
  }
}

function setBenchmarks(data) {
  var benchmarks = data.benchmarks;
  var $el;
  $benchmarks.find('button.delete').click();
  for (var i = 0; i < benchmarks.length; ++i) {
    $el = appendNewBenchmark();
    $el.find('input.benchName').val(benchmarks[i].name);
    ace.edit($el.find('div.ace_editor')[0])
       .getSession()
       .setValue(benchmarks[i].jscode, -1);
  }

  if (data.setupCode) {
    ace.edit($setupCode.find('div.ace_editor')[0])
       .getSession()
       .setValue(data.setupCode, -1);
    $setupCode.collapse('show');
  } else {
    $setupCode.collapse('hide');
    ace.edit($setupCode.find('div.ace_editor')[0])
       .getSession()
       .setValue('', -1);
  }

  if (data.teardownCode) {
    ace.edit($teardownCode.find('div.ace_editor')[0])
       .getSession()
       .setValue(data.teardownCode, -1);
    $teardownCode.collapse('show');
  } else {
    $teardownCode.collapse('hide');
    ace.edit($teardownCode.find('div.ace_editor')[0])
       .getSession()
       .setValue('', -1);
  }
}

function appendNewBenchmark() {
  var $el = $benchTpl.clone()
                     .removeClass('hidden')
                     .appendTo($benchmarks);
  setupEditor($el[0]);
  return $el;
}

function startup() {
  var $loadGistModal = $('#loadGistModal');
  var $gistUrl = $('#gistUrl');
  var $saveGistModal = $('#saveGistModal');
  var $gistPrgModal = $('#gistPrgModal');
  var $gistPrgMsg = $('#gistPrgMsg');

  $benchTpl = $('#benchTpl');
  $benchmarks = $('#benchmarks');
  $submitButton = $('#submit');
  $targets = $('#targets');
  $concurrency = $('#concurrency');
  $status = $('#status');
  $results = $('#results');
  $resultsTable = $results.find('table');
  $setupCode = $('#setupCode');
  $teardownCode = $('#teardownCode');
  $benchAdd = $('#benchAdd');
  $gistDesc = $('#gistDesc');

  $benchTpl.removeProp('id').removeAttr('id');
  $benchmarks.on('click', 'button.insert', function() {
    var parentBlock = $(this).parent().parent().parent();
    setupEditor($benchTpl.clone()
                         .removeClass('hidden')
                         .insertBefore(parentBlock)[0]);
  });
  $benchmarks.on('click', 'button.delete', function() {
    $(this).parent().parent().parent().remove();
  });
  $benchAdd.click(appendNewBenchmark);
  $submitButton.click(function() {
    resultsTableInfo = null;
    if (!$results.hasClass('hidden'))
      $results.addClass('hidden');
    submitJob();
    window.scrollTo(0, 0);
  });
  $benchmarks.children().each(function(i, el) {
    setupEditor(el);
  });
  setupEditor($setupCode[0]);
  $setupCode.removeClass('in');
  setupEditor($teardownCode[0]);
  $teardownCode.removeClass('in');
  $resultsTable.popover({
    selector: '.has-popover',
    placement: 'auto bottom',
    html: true,
    trigger: 'focus'
  });

  $loadGistModal.on('shown.bs.modal', function() {
    $gistUrl.focus();
  }).on('show.bs.modal', function() {
    $gistUrl.val('');
  });
  $('#loadFromGist').click(function() {
    var url = $gistUrl.val().trim();
    if (!url.length)
      return alert('Missing Gist URL');
    var id = /\/([a-f0-9]+)$/.exec(url);
    if (!id)
      return alert('Malformed Gist URL');
    id = id[1];
    $loadGistModal.modal('hide');
    $gistPrgMsg.text('Loading From Gist ...');
    $gistPrgModal.find('div.modal-footer').addClass('hidden');
    $gistPrgModal.modal('show');
    $.get('/gist', { id: id })
     .done(function(data) {
       if (typeof data === 'object' && data !== null) {
         setBenchmarks(data);
         $gistPrgMsg.text('Loaded: ' + data.description);
       } else {
         $gistPrgMsg.text('Malformed response from server: ' + data);
       }
     })
     .fail(function(xhr) {
       $gistPrgMsg.text('Error loading from gist: ' + xhr.responseText);
     })
     .always(function() {
       $gistPrgModal.find('div.modal-footer').removeClass('hidden');
     });
  });

  $saveGistModal.on('shown.bs.modal', function() {
    $gistDesc.focus();
  }).on('show.bs.modal', function() {
    $gistDesc.val('');
  });
  $('#saveToGist').click(function() {
    var json = generateJobJSON(true);
    if (json !== false) {
      $saveGistModal.modal('hide');
      $gistPrgMsg.text('Saving To Gist ...');
      $gistPrgModal.find('div.modal-footer').addClass('hidden');
      $gistPrgModal.modal('show');
      $.post('/gist', json)
       .done(function(data) {
         $gistPrgMsg.html('Saved to: <a href="' + data + '" target="_blank">' +
                          data + '</a>');
       })
       .fail(function(xhr) {
         $gistPrgMsg.text('Error saving to gist: ' + xhr.responseText);
       })
       .always(function() {
         $gistPrgModal.find('div.modal-footer').removeClass('hidden');
       });
    }
  });
}
