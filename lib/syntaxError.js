var vm = require('vm');

var buffer = '';
process.stdin.on('data', function(chunk) {
  buffer += chunk;
}).on('end', function() {
  try {
    new vm.Script(buffer, '__benchd_bench', true);
  } catch (ex) {}
}).resume();