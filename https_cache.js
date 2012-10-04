
var request = require('request');
var https = require('https');
var util  = require('util');
var fs = require('fs');
var cg = require('certgen');
var events = require('events');

var certCache = {};

function CertOpts(keyBuf, certBuf) {
  this.key = keyBuf;
  this.cert = certBuf;
}

function create_server(certOpts, appRequestCb) {
  var https_srv = https.createServer(certOpts);
  https_srv.on('error', function() {
    sys.log("error on https server?")
  });
  https_srv.on('request', appRequestCb);
  return https_srv;
}

function queue_callback(emitter, remoteHostName, cb, appRequestCb) {
  console.log('Queuing cert lookup for ' + remoteHostName);
  emitter.on('certDone', function onCertDone(err, certOpts) {
    if (err) {
      console.log('Dequeuing lookup error for ' + remoteHostName);
      return cb(err);
    }
    console.log('Dequeuing cert lookup for ' + remoteHostName);
    cb(null, create_server(certOpts, appRequestCb));
  });  
}

/*
 * Return an https server with the correct certificate for the given hostname.
 * options: global options, including external proxy
 * remoteHostName: remote host name of the form 'host[:port]'
 * cb: a callback of the form cb(err, https_srv), where the second parameter is an https instance
 */
exports.lookup = function (options, remoteHostName, cb, appRequestCb) {
  var entry = certCache[remoteHostName];
  if (entry) {
    if (entry instanceof events.EventEmitter) {
      return queue_callback(entry, remoteHostName, cb, appRequestCb);
    }
    // The entry is a CertOpts object already in the cache
    console.log('Cache hit for ' + remoteHostName);    
    return process.nextTick(function () { cb(null, create_server(entry, appRequestCb)); });
  }
  // Use an event emitter to queue future requests while we're still waiting for the cert options
  var emitter = new events.EventEmitter();
  queue_callback(emitter, remoteHostName, cb, appRequestCb); // insert ourselves as first listener
  certCache[remoteHostName] = emitter;
  
  var url = 'https://' + remoteHostName;
  var pingOptions = { url: url,
                      proxy: options.externalProxy,
                      method: 'HEAD' };
  
  console.log("Pinging remote with options: " + util.inspect(pingOptions));  
  var ping = request(pingOptions, onPingResponse);
  
  function onPingResponse(err, resp, body) {
    if (err)
      return emitter.emit('certDone', err);
    
    console.log ("\nPing response code for " + url + " is " + resp.statusCode);    
    //console.log("Ping object: " + util.inspect(ping));
    
    if (!ping.req.socket.getPeerCertificate) {
      return emitter.emit('certDone', "Remote server " + url + " did not present a certificate");    
    }
    
    var srvCert = ping.req.socket.getPeerCertificate();
    console.log("Server cert for " + url + " :" );
    console.log("Subject: " + util.inspect(srvCert.subject));
    console.log("Issuer: " + util.inspect(srvCert.issuer));
        
    // Generate a new certificate with the same subject as the remote server's certificate
    cg.generate_cert_buf(remoteHostName, true, srvCert.subject, '/devel/tmp/leb-key.pem',
                         '/devel/tmp/leb-cert.pem', genCertCb);
    
    function genCertCb(err, keyBuf, certBuf) {
      var emitter = certCache[remoteHostName];
      if (err) {
        delete certCache[remoteHostName];
        return  emitter.emit('certDone', err);
      }
      // Replace the cache entry with the certificate info, then emit event to finish
      opts = new CertOpts(keyBuf, certBuf);
      certCache[remoteHostName] = opts;
      emitter.emit('certDone', null, opts);
    }    
  }    
}