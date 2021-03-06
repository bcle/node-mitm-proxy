/*
 * json_inspector.js
 *
 * Copyright (C) 2012, Bich C. Le, all rights reserved.
 *
 */

var Proxy = require('../proxy.js')
  , tmp = require('tmp')
  , fs = require('fs');

var optionsParser = Proxy.getOptionsParser();

// Add your options here. See documentation at https://npmjs.org/package/nomnom

// Determine options from command line
var options = optionsParser.parse();

// Register filters
options.request_filter = request_filter;
options.response_filter = response_filter;

var proxy = new Proxy(options);

// Get log4js logger. 
var log = proxy.getLogger();

var zlib = require('zlib');

//------------------------------------------------------------------------------------------------

/*
 * reqFromApp: The http request from the client application.
 *             In addition to usual properties, 'body' contains the body buffer.
 *             You may modify this object.
 * respToApp: An optional response to the app. If you choose not to forward to the remote server,
 *            use this object to complete the request, and no not call next()
 * next: Call this function to continue processing of the request.
 *       This forwards the (potentially modified) request to the remote server.
 */
function request_filter(reqFromApp, respToApp, next) {

  var ctype = reqFromApp.headers['content-type']; 
  if (!ctype) 
    return next();

  var body = reqFromApp.body;
  var obj = null; // JSON body

  log.info('Request filter: %s %s enc [%s] body length %d body:\n%s',
    reqFromApp.method,
    reqFromApp.url,
    ctype,
    body? body.length : 0,
    body? body.toString():'');

  if (ctype.indexOf('application/json') >= 0) {
    obj = JSON.parse(body.toString());

    log.info('Request filter: %s with json body of length %d on URL %s : \n%s',
      reqFromApp.method,
      body? body.length : 0,
      reqFromApp.url,
      body? JSON.stringify(obj, null, 2) : ''
    );
  }
  next();
}

//------------------------------------------------------------------------------------------------

/*
 * reqFromApp: The http request from the client application.
 *             In addition to usual properties, 'body' contains the body buffer.
 *             You may modify this object.
 * respFromRemote: The response from the remote server. You may modify it.
 *             If you change the body length, make sure you update the content-length
 *             header accordingly.
 * next: Call this function to continue processing of the request.
 *       This forwards the (potentially modified) request to the remote server.
 */
function response_filter(reqFromApp, respFromRemote, next) {
  var body = respFromRemote.body;

  if (!body || !body.length)
    return next();

  var ctype = respFromRemote.headers['content-type'];
  if (!ctype || ctype.indexOf('application/json') < 0)
    return next();

  var encoding = respFromRemote.headers['content-encoding'];
  if (!encoding) {
    decode_json(null, body);
  } else if (encoding === 'gzip') {
    log.info('Response filter: decompressing gzip buffer of size: %d', body.length);
    zlib.gunzip(body, decode_json); 
  } else {
    log.info('Response filter: ignoring JSON body with unknown content encoding: %s', encoding);
    next();
  }

  function decode_json(err, buf) {
    if (err) {
      log.error('Response filter: gzip decoding failed: %s', err);
    } else try {
      var str = buf.toString();
      if (encoding === 'gzip')
        log.info('Response filter: decompressed from %d to %d bytes', body.length, buf.length);
      try {
        var obj = JSON.parse(str);
        log.info('Response filter: status %d with json body of length %d: \n%s',
          respFromRemote.statusCode,
          buf? buf.length : 0,
          buf? JSON.stringify(obj, null, 2) : ''
        );  
      } catch (err) {
        log.error('Caught exception %s while parsing JSON from string: %s', err, str);
        var opts = { prefix: 'bad-json-' + (encoding? (encoding + '-'):''), keep: true };
        tmp.file(opts, function tmpFileCb(err, path) {
          if (err) return next();
          fs.writeFile(path, body, function writeFileCb(err) {
            if (!err)
	      log.info('Body containing bad JSON written to: %s', path);
          });
        });
      }
    } catch (err) {
      log.error('Caught exception during response body processing: %s', err);
    }
    next();
  }
}

//------------------------------------------------------------------------------------------------

function binary_to_ascii_dump(buf, bytesPerLine) {
  var bpl = bytesPerLine || 64;
  var len = buf.length;
  var offset = 0;
  var str = '';
  while (offset < len) {
    for (i = 0; i < bpl && offset < len; i++) {
      byte = buf[offset];
      if (byte >= 0x20 && byte <= 0x7e) {
        str = str + String.fromCharCode(byte);
      } else {
        str = str + '.';
      }
      offset++;
    }    
    str = str + "\n";
  }
  return str;
}

