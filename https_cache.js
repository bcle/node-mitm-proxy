
var request = require('request');
var https = require('https');
var util  = require('util');
var fs = require('fs');
var cg = require('certgen');

var srvCache = {};

/*
 * Lookup and return an https server for the given hostname.
 * options: global options, including external proxy
 * remoteHostName: fully qualified remote host name
 * cb: a callback of the form cb(err, https_srv), where the second paramter is an https instance
 */
exports.lookup = function (options, remoteHostName, cb) {
  var srv = srvCache[remoteHostName];
  if (srv) {
    return process.nextTick(function () { cb(null, srv); });
  }
  
  var pingOptions = { url: 'https://'+remoteHostName,
                      proxy: options.externalProxy,
                      method: 'HEAD' };
  
  console.log("Pinging remote with options: " + util.inspect(pingOptions));  
  var ping = request(pingOptions, onPingResponse);
  
  function onPingResponse(err, resp, body) {
    if (err)
      return cb(err);
    console.log ("Ping response code: " + resp.statusCode);    
    if (resp.statusCode != 200) {
      return cb("Ping responded with an http error: " + resp.statusCode);
    }
    //console.log("Ping object: " + util.inspect(ping));
    
    var srvCert = ping.req.socket.getPeerCertificate();
    console.log("Server cert: " + util.inspect(srvCert));
    
    // Generate a new certificate with the same subject as the remote server's certificate
    cg.generate_cert_buf(remoteHostName, true, srvCert.subject, '/devel/tmp/leb-key.pem',
                         '/devel/tmp/leb-cert.pem', genCertCb);
    
    function genCertCb(err, keyBuf, certBuf) {
      if (err)
        return cb(err);
      
      // Return a new https server
      var opts = { key: keyBuf,  cert: certBuf };
      var https_srv = https.createServer(opts);
      srvCache[remoteHostName] = https_srv;
      cb(null, https_srv);
    }    
  }    
}