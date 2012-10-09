var https = require('https')
  , http  = require('http')
  , path  = require('path')
  , fs    = require('fs')
  , net   = require('net')
  , EE    = require('events').EventEmitter
  , util  = require('util')
  , request = require('request')
  , log4js = require('log4js')
  , optionsParser = require('nomnom')
  , https_cache = require('./https_cache.js')

var log = null;

//------------------------------------------------------------------------------------------------

function handle_request(that, reqFromApp, respToApp) {

  var info = { method: reqFromApp.method, url: reqFromApp.url, headers: reqFromApp.headers };
  log.debug('Received initial request from app. Method: %s  URL: %s', info.method, info.url);
  log.debug('Request headers: %j', info.headers);

  reqFromApp.on('data', onReqFromAppData);
  reqFromApp.on('end', onReqFromAppEnd);
  var chunks = [];

  // Buffer app request data
  function onReqFromAppData(chunk) {
    log.debug('Received chunk from app of size %d', chunk.length);
    chunks.push(chunk);
  }
  
  // When full app request is received, forward to remote server
  function onReqFromAppEnd() {
    var body = chunks.length? Buffer.concat(chunks) : null; 
    log.info('Received request from app with body length %d for URL: %s',
        body? body.length : 0, reqFromApp.url);
    var remoteOpts = { url: reqFromApp.url,
                       method: reqFromApp.method,
                       headers: reqFromApp.headers,
                       proxy: that.options.external_proxy,
                       followRedirect: false,
                       encoding: null // we want binary
                     };

    log.debug('Forwarding to remote server with body length %d and options: %j',
              body? body.length : 0, remoteOpts);
    remoteOpts.body = body;
    request(remoteOpts, onRespFromRemote);

    function onRespFromRemote(err, respFromRemote, bodyFromRemote) {
      if (err) {
        log.error("Error sending request to remote: " + err);
        respToApp.writeHead(500, 'Internal error');
        return;
      }
      log.info('Response: status code %d body length %d URL %s',
          respFromRemote.statusCode,
          bodyFromRemote? bodyFromRemote.length : 0,
          reqFromApp.url);
      log.debug('Response headers: %j', respFromRemote.headers);
      respToApp.writeHead(respFromRemote.statusCode, respFromRemote.headers);
      if (bodyFromRemote) {
        var ret = respToApp.write(bodyFromRemote);
        if (!ret) 
          log.warn('write(response body) returned: ' + ret);
      }
      respToApp.end();
    }
  }  
}

//------------------------------------------------------------------------------------------------

function handle_connect_https(that, socket, req) {
  
  var remoteHostName = req.url;
  https_cache.lookup(that.options, remoteHostName, cacheLookupCb, onReqFromApp);
  
  function cacheLookupCb(err, https_srv) {
    if (err) {
      log.error('Ping error: ' + err);
      socket.write( "HTTP/1.0 503 Service Unavailable\r\nProxy-agent: Netscape-Proxy/1.1\r\n\r\n");
      return;
    } 
    https_srv.emit('connection', socket);
    socket.write( "HTTP/1.0 200 Connection established\r\nproxy-agent: Netscape-proxy/1.1\r\n\r\n");    
  }
  
  /*
   * Handle application requests
   */
  function onReqFromApp(reqFromApp, respToApp) {
    reqFromApp.url = 'https://' + remoteHostName + reqFromApp.url;
    handle_request(that, reqFromApp, respToApp);      
  }      
}

// ------------------------------------------------------------------------------------------------

function handle_connect(that, req, socket, head) {
  var components = req.url.split(':');
  var hostname = components[0];
  var port = components[1] || 80;
  var proxy;

  if (port != 443) {
    log.info("Error: CONNECT to non-https server. Aborting.");
    socket.write( "HTTP/1.0 503 Service Unavailable\r\nProxy-agent: Netscape-Proxy/1.1\r\n\r\n");
    return;
  }
  handle_connect_https(that, socket, req);
}

//------------------------------------------------------------------------------------------------

var Proxy = function(options, processor_class) {
  if (options.log_file) {
    log4js.clearAppenders();
    log4js.loadAppender('file');
    log4js.addAppender(log4js.appenders.file(options.log_file), 'proxy');
  }
  log = log4js.getLogger('proxy');
  log.setLevel(options.log_level);
  https_cache.init(log);
  this.options = options;
  var that = this;
  var server = http.createServer(function(req, response) {
    handle_request(that, req, response);
  });

  server.on('connect', function(req, socket, head) {
    handle_connect(that, req, socket, head);
  });
  
  server.on('error', function() {
    log.info("error on server?")
  })

  server.listen(this.options.proxy_port);
  log.info('http proxy server '.blue + 'started '.green.bold + 'on port '.blue + (""+this.options.proxy_port).yellow);
}

//------------------------------------------------------------------------------------------------

Proxy.getOptionsParser = function () {
  return optionsParser.options({
    proxy_port: { abbr: 'p', full: 'proxy-port', help: 'Default: 8888', default: 8888 },
    key_path: { abbr: 'k', full: 'key-path', help: 'Path to server private key file (REQUIRED)', default: '/devel/tmp/leb-key.pem'},
    cert_path: { abbr: 'c', full: 'cert-path', help: 'Path to server certificate file (REQUIRED)', default: '/devel/tmp/leb-cert.pem'},
    external_proxy: { abbr: 'e', full: 'external-proxy', help: 'External proxy of the form http://hostname:port (Optional)' },
    log_level: { abbr: 'l', full: 'log-level', help: "Default: 'info'", default: 'INFO' },
    log_file: { help: 'Log file. (Optional)', full: 'log-file' }
  });
}

//------------------------------------------------------------------------------------------------

module.exports = Proxy;
