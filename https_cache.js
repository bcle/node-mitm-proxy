
var request = require('request');
var https = require('https');
var util  = require('util');
var fs = require('fs');
var cg = require('certgen');
var events = require('events');

var srvCache = {};
var log = null;

function create_server(certOpts, appRequestCb) {
  var https_srv = https.createServer(certOpts);
  https_srv.on('error', function() {
    log.error("error on https server?")
  });
  https_srv.on('request', appRequestCb);
  return https_srv;
}

function queue_callback(emitter, remoteHostName, cb, appRequestCb) {
  log.info('Queuing cert lookup for ' + remoteHostName);
  emitter.on('certDone', function onCertDone(err, server) {
    if (err) {
      log.info('Dequeuing lookup error for ' + remoteHostName);
      return cb(err);
    }
    log.info('Dequeuing cert lookup for ' + remoteHostName);
    cb(null, server);
  });  
}

exports.init = function(logger) {
  log = logger;
}

/*
 * Return an https server with the correct certificate for the given hostname.
 * options: global options, including external proxy
 * remoteHostName: remote host name of the form 'host[:port]'
 * cb: a callback of the form cb(err, https_srv), where the second parameter is an https instance
 */
exports.lookup = function (options, remoteHostName, cb, appRequestCb) {
  var entry = srvCache[remoteHostName];
  if (entry) {       
    if (entry instanceof https.Server) {
      // The entry is an https server already in the cache
      log.info('Cache hit for ' + remoteHostName);    
      return process.nextTick(function () { cb(null, entry); });      
    }
    // Ping in progress. The entry is a plain emitter.
    return queue_callback(entry, remoteHostName, cb, appRequestCb);
  }
  // Use an event emitter to queue future requests while we're still waiting for the cert options
  var emitter = new events.EventEmitter();
  queue_callback(emitter, remoteHostName, cb, appRequestCb); // insert ourselves as first listener
  srvCache[remoteHostName] = emitter;
  
  var url = 'https://' + remoteHostName;
  var pingOptions = { url: url,
                      proxy: options.external_proxy,
                      followRedirect: false,
                      method: 'HEAD' };
  
  log.info("Pinging remote with options: %j", pingOptions);  
  var ping = request(pingOptions, onPingResponse);
  
  function onPingResponse(err, resp, body) {
    if (err) {
      delete srvCache[remoteHostName];      
      return emitter.emit('certDone', err);
    }
    log.info ("Ping response code for %s is %d", url, resp.statusCode);    
    
    if (!ping.req.socket.getPeerCertificate) {
      log.error('No certificate for ' + url);
      log.error('Ping request: %j', ping);
      delete srvCache[remoteHostName];      
      return emitter.emit('certDone', "Remote server " + url + " did not present a certificate");    
    }
    
    var srvCert = ping.req.socket.getPeerCertificate();
    log.debug("Server cert for %s:", url );
    log.debug("Subject: %j", srvCert.subject);
    log.debug("Issuer: %j", srvCert.issuer);
        
    // Generate a new certificate with the same subject as the remote server's certificate
    cg.generate_cert_buf(remoteHostName, true, srvCert.subject, options.key_path,
                         options.cert_path, genCertCb);
    
    function genCertCb(err, keyBuf, certBuf) {
      var emitter = srvCache[remoteHostName];
      if (err) {
        delete srvCache[remoteHostName];
        return  emitter.emit('certDone', err);
      }
      // Replace the cache entry with the server, then emit event to finish
      var opts = { key: keyBuf, cert: certBuf };
      var server = create_server(opts, appRequestCb);
      srvCache[remoteHostName] = server;
      emitter.emit('certDone', null, server);
    }    
  }    
}