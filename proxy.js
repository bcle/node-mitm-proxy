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

var Processor = function(proc) {
  this.processor = function() {
    this.methods = new proc(this);
    EE.call(this.methods);
  }
  sys.inherits(this.processor, EE);
}

var process_url = function(req, type, processor) {
  var req_url = url.parse(req.url, true);
  if(!req_url.protocol) req_url.protocol = type + ":";
  if(!req_url.hostname) req_url.hostname = req.headers.host;

  if(processor && processor.methods.url_rewrite) {
    req_url = processor.methods.url_rewrite(req_url) || req_url;
  }

  return req_url;
}

var handle_request = function(that, req, response, type) {
  var processor = that.processor_class ? new that.processor_class.processor() : null;
  var req_url   = process_url(req, type, processor);
  var hostname  = req_url.hostname;
  var pathname  = req_url.pathname + ( req_url.search || "");
  var proxy_writter;

  if(processor) processor.emit('request', req, req_url);

  if(that.options.verbose) console.log(type.blue + " proxying to " +  url.format(req_url).green);
  if(that.options.proxy_write) proxy_writter = new pw(hostname, pathname)

  var request_options = {
      host: hostname
    , port: req_url.port || (type == "http" ? 80 : 443)
    , path: pathname
    , headers: req.headers
    , method: req.method
  }

  var proxy_request = (req_url.protocol == "https:" ? https : http).request(request_options, function(proxy_response) {
    if(processor) processor.emit("response", proxy_response);

    proxy_response.on("data", function(d) {
      response.write(d);
      if(that.options.proxy_write) proxy_writter.write(d);
      if(processor) processor.emit("response_data", d);
    });

    proxy_response.on("end", function() {
      response.end();
      if(that.options.proxy_write) proxy_writter.end();
      if(processor) processor.emit("response_end");
    })

    proxy_response.on('close', function() {
      if(processor) processor.emit("response_close");
      proxy_response.connection.end();
    })

    proxy_response.on("error", function(err) {})
    response.writeHead(proxy_response.statusCode, proxy_response.headers);
  })

  proxy_request.on('error', function(err) {
    response.end(); 
  })

  req.on('data', function(d) {
    proxy_request.write(d, 'binary');
    if(processor) processor.emit("request_data", d);
  });

  req.on('end', function() {
    proxy_request.end();
    if(processor) processor.emit("request_end");
  });

  req.on('close', function() {
    if(processor) processor.emit("request_close");
    proxy_request.connection.end();
  })

  req.on('error', function(exception) { 
    response.end(); 
  });
}

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

function handle_connect_https(that, socket, req) {
  
  // Ping the remote server with a HEAD request to obtain its certificate
  var remoteHostName = req.url;
  var pingOptions = { url: 'https://'+remoteHostName,
                      proxy: that.options.externalProxy,
                      method: 'HEAD' };
  console.log("Pinging remote with options: " + util.inspect(pingOptions));  
  var ping = request(pingOptions, onPingResponse);
  
  function onPingResponse(err, resp, body) {
    if (err) {
      console.error('Ping error: ' + err);
      socket.write( "HTTP/1.0 503 Service Unavailable\r\nProxy-agent: Netscape-Proxy/1.1\r\n\r\n");
      return;
    }
    var msg;
    console.log ("Ping response code: " + resp.statusCode);    
    if (resp.statusCode != 200) {
      msg = "HTTP/1.0 " + resp.statusCode + " Error\r\nProxy-agent: Netscape-Proxy/1.1\r\n\r\n";
      socket.write(msg); 
      return;
    }
    //console.log("Ping object: " + util.inspect(ping));
    
    var srvCert = ping.req.socket.getPeerCertificate();
    console.log("Server cert: " + util.inspect(srvCert));
    var opts = {
        key: fs.readFileSync('/devel/tmp/eng-key.pem', 'utf8'),
        cert: fs.readFileSync('/devel/tmp/eng-cert.pem', 'utf8')
    };

    var https_srv = https.createServer(opts);
    https_srv.on('error', function() {
      sys.log("error on https server?")
    });

    https_srv.on('request', onReqFromApp);
    https_srv.emit('connection', socket);
    socket.write( "HTTP/1.0 200 Connection established\r\nproxy-agent: Netscape-proxy/1.1\r\n\r\n");
    
    /*
     * Handle application requests
     */
    function onReqFromApp(reqFromApp, respToApp) {
      console.log('Received initial request from app: ' + util.inspect(reqFromApp));
      console.log('Beginning to buffer data');
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
        var remoteOpts = { url: 'https://' + remoteHostName + reqFromApp.url,
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
                      ' Headers: ' + util.inspect(respFromRemote.headers));
          respToApp.writeHead(respFromRemote.statusCode, respFromRemote.headers);
          if (bodyFromRemote) {
            console.log('Body length: ', bodyFromRemote.length);
            var ret = respToApp.write(bodyFromRemote);
            console.log('write(body) returned: ', ret);
          }
          respToApp.end();
        }      // onRespFromRemote
      }      // onReqFromAppEnd
    }      // onReqFromApp
  }      // onPingResponse
}

function handle_connect(that, req, socket, head) {
  var components = req.url.split(':');
  var hostname = components[0];
  var port = components[1] || 80;
  var proxy;
    
  if (port == 443) {
    return handle_connect_https(that, socket, req);
  }
  proxy = net.createConnection(port, hostname);
  
  console.log("created new proxy socket");  

  proxy.on('connect', function() {
    socket.write( "HTTP/1.0 200 Connection established\r\nProxy-agent: Netscape-Proxy/1.1\r\n\r\n"); 
  });

  // connect pipes
  proxy.on( 'data', function(d) {
    console.log("proxy sending " + d.length + " bytes");
    socket.write(d);
  });
  
  socket.on('data', function(d) {
    console.log("socket sending " + d.length + " bytes");
    console.log(binary_to_ascii_dump(d));
    try { proxy.write(d) }
      catch(err) {
        console.log("Error on tunnel socket: " + err);
      }
  });

  proxy.on( 'end',  function() {
    socket.end();
  });
  
  socket.on('end',  function() {
    proxy.end();
  });

  proxy.on( 'close',function(had_error) {
    console.log("proxy close event, had_error: " + had_error)
    socket.end();
  });
  
  socket.on('close',function(had_error) {
    console.log("socket close event, had_error: " + had_error)    
    proxy.end();
  });

  proxy.on( 'error',function(err) {
    console.log("proxy error event: " + err)
    socket.end();
  });
  
  socket.on('error',function(err) {
    console.log("socket error event: " + err)
    proxy.end();
  });
}

module.exports = function(proxy_options, processor_class) {
  this.options = process_options(proxy_options);
  this.processor_class = processor_class ? new Processor(processor_class) : null;

  var that = this;
  var https_opts = {
    key: fs.readFileSync(this.options.key_path, 'utf8'),
    cert: fs.readFileSync(this.options.cert_path, 'utf8')
  };

  var mitm_server = https.createServer(https_opts, function (req, response) {
    handle_request(that, req, response, "https");
  });

  mitm_server.on('error', function() {
    sys.log("error on server?")
  })

  mitm_server.listen(this.options.mitm_port);
  if(this.options.verbose) console.log('https man-in-the-middle proxy server'.blue + ' started '.green.bold + 'on port '.blue + (""+this.options.mitm_port).yellow);

  var server = http.createServer(function(req, response) {
    handle_request(that, req, response, "http");
  });

  server.on('connect', function(req, socket, head) {
    handle_connect(that, req, socket, head);
  });

  // Handle connect request (for https)
  server.on('upgrade', function(req, socket, upgradeHead) {
    var proxy = net.createConnection(that.options.mitm_port, 'localhost');

    proxy.on('connect', function() {
      socket.write( "HTTP/1.0 200 Connection established\r\nProxy-agent: Netscape-Proxy/1.1\r\n\r\n"); 
    });

    // connect pipes
    proxy.on( 'data', function(d) { socket.write(d)   });
    socket.on('data', function(d) { try { proxy.write(d) } catch(err) {}});

    proxy.on( 'end',  function()  { socket.end()      });
    socket.on('end',  function()  { proxy.end()       });

    proxy.on( 'close',function()  { socket.end()      });
    socket.on('close',function()  { proxy.end()       });

    proxy.on( 'error',function()  { socket.end()      });
    socket.on('error',function()  { proxy.end()       });
  });

  server.on('error', function() {
    sys.log("error on server?")
  })

  server.listen(this.options.proxy_port);
  if(this.options.verbose) console.log('http proxy server '.blue + 'started '.green.bold + 'on port '.blue + (""+this.options.proxy_port).yellow);
}
