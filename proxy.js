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
  if(!options.mitm_port)             options.mitm_port        = 8000;
  if(!options.verbose === false)     options.verbose          = true;
  if(!options.proxy_write === true)  options.proxy_write      = false;
  if(!options.proxy_write_path)      options.proxy_write_path = '/tmp/proxy';
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

var process_url = function(req, type, processor) {
  var req_url = url.parse(req.url, true);
  if(!req_url.protocol) req_url.protocol = type + ":";
  if(!req_url.hostname) req_url.hostname = req.headers.host;

  if(processor && processor.methods.url_rewrite) {
    req_url = processor.methods.url_rewrite(req_url) || req_url;
  }

  return req_url;
}

//------------------------------------------------------------------------------------------------

var handle_request = function(that, reqFromApp, respToApp) {

  var info = { method: reqFromApp.method, url: reqFromApp.url, headers: reqFromApp.headers };
  console.log('Received request from app: ' + util.inspect(info));

  reqFromApp.setEncoding('utf8');      
  reqFromApp.on('data', onReqFromAppData);
  reqFromApp.on('end', onReqFromAppEnd);
  var body = null;

  // Buffer app request data
  function onReqFromAppData(chunk) {
    console.log('Received chunk from app: ' + chunk);
    body = body? body + chunk : chunk;
  }
  
  // When full app request is received, forward to remote server
  function onReqFromAppEnd() {
    console.log('Received body from app: ' + body);
    console.log('Request URL: ' + reqFromApp.url);        
    var remoteOpts = { url: reqFromApp.url,
                       method: reqFromApp.method,
                       headers: reqFromApp.headers,
                       proxy: that.options.externalProxy,
                       encoding: null, // we want binary
                       body: body };

    console.log('Forwarding to remote server with options: ' + util.inspect(remoteOpts));
    request(remoteOpts, onRespFromRemote);

    function onRespFromRemote(err, respFromRemote, bodyFromRemote) {
      if (err) {
        console.log("Error sending request to remote: " + err);
        respToApp.writeHead(500, 'Internal error');
        return;
      }
      console.log('Received response from remote server. Status code: ' + respFromRemote.statusCode +
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
  
}      // handle_connect_https

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
    console.log('----------------------------------');
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
