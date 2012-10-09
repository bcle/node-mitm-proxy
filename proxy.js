var https = require('https')
  , http  = require('http')
  , path  = require('path')
  , fs    = require('fs')
  , net   = require('net')
  , sys   = require('sys')
  , url   = require('url')
  , clrs  = require('colors')
  , EE    = require('events').EventEmitter
  , pw    = require(path.join(__dirname, 'lib', 'proxy_writter.js'))
  , util  = require('util')
  , request = require('request')
  , https_cache = require('./https_cache.js')

// ------------------------------------------------------------------------------------------------

var process_options = function(proxy_options) {
  var options = proxy_options || {}

  if(!options.proxy_port)            options.proxy_port       = 8080;
  if(!options.verbose === false)     options.verbose          = true;
  if(!options.key_path)              options.key_path         = path.join(__dirname, 'certs', 'agent2-key.pem')
  if(!options.cert_path)             options.cert_path        = path.join(__dirname, 'certs', 'agent2-cert.pem')
  return options;
}

//------------------------------------------------------------------------------------------------

var Processor = function(proc) {
  this.processor = function() {
    this.methods = new proc(this);
    EE.call(this.methods);
  }
  sys.inherits(this.processor, EE);
}

//------------------------------------------------------------------------------------------------

function handle_request(that, reqFromApp, respToApp) {

  var info = { method: reqFromApp.method, url: reqFromApp.url, headers: reqFromApp.headers };
  // console.log('Received request from app: ' + util.inspect(info));
  console.log('\nReceived request from app. Url: ' + info.url + '  Method: ' + info.method);

  reqFromApp.on('data', onReqFromAppData);
  reqFromApp.on('end', onReqFromAppEnd);
  var chunks = [];

  // Buffer app request data
  function onReqFromAppData(chunk) {
    console.log('Received chunk from app: ' + chunk);
    chunks.push(chunk);
  }
  
  // When full app request is received, forward to remote server
  function onReqFromAppEnd() {
    var body = chunks.length? Buffer.concat(chunks) : null; 
    console.log('\nReceived body from app: ' + body);
    console.log('Request URL: ' + reqFromApp.url);
    var remoteOpts = { url: reqFromApp.url,
                       method: reqFromApp.method,
                       headers: reqFromApp.headers,
                       proxy: that.options.externalProxy,
                       followRedirect: false,
                       encoding: null, // we want binary
                       body: body };

    console.log('Forwarding to remote server with options: ' + util.inspect(remoteOpts));
    request(remoteOpts, onRespFromRemote);

    function onRespFromRemote(err, respFromRemote, bodyFromRemote) {
      if (err) {
        console.log("\nError sending request to remote: " + err);
        respToApp.writeHead(500, 'Internal error');
        return;
      }
      console.log('\nReceived response from ' + reqFromApp.url + ' with status code: ' + respFromRemote.statusCode +
                  '\n Headers: ' + util.inspect(respFromRemote.headers));
      respToApp.writeHead(respFromRemote.statusCode, respFromRemote.headers);
      if (bodyFromRemote) {
        console.log('Body length: ', bodyFromRemote.length);
        var ret = respToApp.write(bodyFromRemote);
        console.log('write(body) returned: ', ret);
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
      console.error('Ping error: ' + err);
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

  console.log('----------------------------------');
  if (port != 443) {
    console.log("Error: CONNECT to non-https server. Aborting.");
    socket.write( "HTTP/1.0 503 Service Unavailable\r\nProxy-agent: Netscape-Proxy/1.1\r\n\r\n");
    return;
  }
  handle_connect_https(that, socket, req);
}

//------------------------------------------------------------------------------------------------

module.exports = function(proxy_options, processor_class) {
  this.options = process_options(proxy_options);
  this.processor_class = processor_class ? new Processor(processor_class) : null;

  var that = this;
  var server = http.createServer(function(req, response) {
    //console.log('----------------------------------');
    handle_request(that, req, response);
  });

  server.on('connect', function(req, socket, head) {
    handle_connect(that, req, socket, head);
  });
  
  server.on('error', function() {
    sys.log("error on server?")
  })

  server.listen(this.options.proxy_port);
  if(this.options.verbose) console.log('http proxy server '.blue + 'started '.green.bold + 'on port '.blue + (""+this.options.proxy_port).yellow);
}
