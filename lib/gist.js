var crypto = require('crypto');
var qs = require('querystring');
var cheerio = require('cheerio');
var https = require('https');

var AUTH_TOKEN_PATH = 'form.js-blob-form input[name="authenticity_token"]';
var OID = '&' + qs.escape('gist[contents][][oid]') + '=';
var NAME_FIELD = '&' + qs.escape('gist[contents][][name]') + '=';
var VALUE_FIELD = qs.escape('gist[contents][][value]') + '=';
var PUBLIC = '&' + qs.escape('gist[public]') + '=1';
var PRIVATE = '&' + qs.escape('gist[public]') + '=0';
var VERSION = 1;

function lpad(n, padLen) {
  n = n.toString();
  while (n.length < padLen)
    n = '0' + n;
  return n;
}

exports.saveToGist = function(config, cb) {
  if (typeof config !== 'object' || config === null)
    throw new Error('Missing config object for new gist');

  var codeBlocks = config.benchmarks;
  var description = config.description;
  // TODO: allow public gists when there is a reliable way of searching for them
  var secret = true; //config.secret;

  if (!Array.isArray(codeBlocks))
    throw new Error('Missing array of code block(s)');
  else {
    codeBlocks.forEach(function(block) {
      if (typeof block !== 'string' &&
          (typeof block !== 'object' ||
           block === null ||
           typeof block.jscode !== 'string')) {
        throw new Error('Invalid benchmark(s)');
      }
    });
  }
  if (typeof cb !== 'function')
    throw new Error('Missing callback');

  if (typeof description !== 'string' || !description.length)
    description = 'Unnamed';

  https.get({
    host: 'gist.github.com'
  }, function(res) {
    if (res.statusCode !== 200) {
      return cb(new Error('Expected 200, got ' +
                          res.statusCode +
                          ' from GitHub'));
    }

    var buf = '';
    res.on('error', function(err) {
      cb(new Error('Error while submitting code: ' + err));
    }).on('data', function(data) {
      buf += data;
    }).on('end', function() {
      var $ = cheerio.load(buf);
      var authToken = $(AUTH_TOKEN_PATH).val();
      if (typeof authToken !== 'string' || !authToken.length)
        return cb(new Error('Unable to prepare code submission'));

      var form = qs.stringify({
        utf8: '\u2713',
        authenticity_token: authToken,
        'gist[description]': '[benchd benchmark] ' + description
      });
      var filenames = [];
      var padLen = codeBlocks.length.toString().length;
      codeBlocks.forEach(function(block, i) {
        var text;
        var name;
        var isSetup = false;
        var isTeardown = false;

        if (typeof block === 'string')
          text = block;
        else {
          text = block.jscode;
          if (typeof block.name === 'string' && block.name.length)
            name = block.name;
          if (block.setup === true)
            isSetup = true;
          else if (block.teardown === true)
            isTeardown = true;
        }

        var filename = crypto.createHash('sha1').update(text).digest('hex');

        if (!name)
          name = filename;

        // Suppress duplicate code blocks
        if (~filenames.indexOf(filename))
          return;
        filenames.push(filename);

        // Add header
        var desc = { name: name };
        if (isSetup === true)
          desc.setup = true;
        else if (isTeardown === true)
          desc.teardown = true;
        text = '//' + JSON.stringify([VERSION, desc]) + '\n' + text;

        form += OID +
                NAME_FIELD + lpad(i, padLen) + '-' + filename + '.js' +
                '&new_filename=&content_changed=true&' +
                VALUE_FIELD + qs.escape(text);
      });
      form += (secret ? PRIVATE : PUBLIC);

      var headers = {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,' +
                '*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        Origin: 'https://gist.github.com',
        Referer: 'https://gist.github.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) ' +
                      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                      'Chrome/44.0.2403.157 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded'
      };
      if (res.headers['set-cookie']) {
        var cookie = res.headers['set-cookie'][0];
        var cookieEnd = cookie.indexOf(';');
        headers.Cookie = (~cookieEnd ? cookie.slice(0, cookieEnd) : cookie);
      }

      https.request({
        host: 'gist.github.com',
        method: 'POST',
        headers: headers
      }, function(res) {
        res.on('error', function() {});
        res.resume();
        if (res.statusCode === 302 && res.headers.location)
          cb(null, res.headers.location);
        else if (res.statusCode !== 302) {
          cb(new Error('Expected 302, got ' +
                       res.statusCode +
                       ' from GitHub'));
        } else
          cb(new Error('Got redirect without location from GitHub'));
      }).on('error', function(err) {
        cb(new Error('Error while submitting code: ' + err));
      }).end(form);
    });
  }).on('error', function(err) {
    cb(new Error('Error while submitting code: ' + err));
  });
};

exports.loadFromGist = function(url, cb) {
  if (typeof cb !== 'function')
    throw new Error('Missing callback');
  https.get(url, function(res) {
    if (res.statusCode !== 200) {
      return cb(new Error('Expected 200, got ' +
                          res.statusCode +
                          ' from GitHub'));
    }
    var buf = '';
    res.on('error', function(err) {
      cb(new Error('Error while retrieving code: ' + err));
    }).on('data', function(data) {
      buf += data;
    }).on('end', function() {
      var $ = cheerio.load(buf);
      var desc = $('div.repository-description').text().trim();
      desc = desc.replace(/^\[benchd benchmark\] /, '').trim();
      if (!desc.length)
        desc = 'Unnamed';
      var when = new Date($('div.gist-timestamp time').attr('datetime'));
      var result = {
        description: desc,
        when: when,
        setupCode: undefined,
        benchmarks: [],
        teardownCode: undefined
      };
      $('div.file').each(function() {
        var $this = $(this);
        var filename = $this.find('.gist-blob-name').text().trim();
        if (!/^[0-9]+\-[A-Fa-f0-9]+\.js$/i.test(filename))
          return;
        var $body = $this.find('td.blob-code');
        var body = '';
        var name = false;
        var isSetup = false;
        var isTeardown = false;
        for (var i = 0; i < $body.length; ++i) {
          var line = $($body[i]).text();
          if (i === 0) {
            var header = line;
            if (header.slice(0, 2) === '//') {
              try {
                header = JSON.parse(header.slice(2));
              } catch (ex) {}

              if (header[0] === 1 &&
                  typeof header[1] === 'object' &&
                  header[1] !== null &&
                  typeof header[1].name === 'string') {
                if (header[1].setup === true) {
                  if (result.setupCode !== undefined)
                    break;
                  isSetup = true;
                } else if (header[1].teardown === true) {
                  if (result.teardownCode !== undefined)
                    break;
                  isTeardown = true;
                } else
                  name = header[1].name;
                continue;
              }
            }
            break;
          }
          body += line;
          if (i + 1 < $body.length)
            body += '\n';
        }
        if (name !== false && body.length)
          result.benchmarks.push({ name: name, jscode: body });
        else if (isSetup)
          result.setupCode = body;
        else if (isTeardown)
          result.teardownCode = body;
      });
      cb(null, result);
    });
  }).on('error', function(err) {
    cb(new Error('Error while retrieving code: ' + err));
  });
};
