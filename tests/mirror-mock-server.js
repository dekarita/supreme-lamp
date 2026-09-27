// [F44 §2] Mock upload server for the autologin-lab mirror cell. Implements
// every failure scenario the F44 classifier must map EXACTLY, plus request
// counting so the lab can assert ZERO network tries for preflight rejections.
// Zero-dependency (node:http); lab-only; never used by production payloads.
'use strict';
const http = require('http');

const PORT = Number(process.env.MIRROR_MOCK_PORT || 8787);
const counts = Object.create(null);
const bytesIn = Object.create(null);
let e429hits = 0;
let e500hits = 0;

function drain(req, done) {
  let n = 0;
  req.on('data', (c) => { n += c.length; });
  req.on('end', () => done(n));
  req.on('error', () => done(n));
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method === 'GET' && url === '/counts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ counts, bytesIn }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('method');
    return;
  }
  counts[url] = (counts[url] || 0) + 1;
  drain(req, (n) => {
    bytesIn[url] = (bytesIn[url] || 0) + n;
    switch (url) {
      case '/success-plain':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('https://mock.local/f/abc123xyz');
        break;
      case '/success-json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { url: 'https://mock.tmpfiles.local/42/sample.bin' } }));
        break;
      case '/e413':
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('Request Entity Too Large: max 100 MB per upload');
        break;
      case '/e403':
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Rejected by content policy: file type not allowed on this host');
        break;
      case '/e401':
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"missing or invalid account token=sekrit12345"}');
        break;
      case '/e451':
        res.writeHead(451, { 'content-type': 'text/plain' });
        res.end('Unavailable For Legal Reasons');
        break;
      case '/e429x2':
        e429hits += 1;
        if (e429hits <= 2) {
          res.writeHead(429, { 'content-type': 'text/plain' });
          res.end('slow down');
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('https://mock.local/f/after429');
        }
        break;
      case '/e500x1':
        e500hits += 1;
        if (e500hits <= 1) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('internal error');
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('https://mock.local/f/after500');
        }
        break;
      case '/malformed-json':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>### not json ### gateway splash</body></html>');
        break;
      case '/ok-nolink':
        // §4(e) direction 1: a 200 that LOOKS ok but carries no link must
        // classify as phase=parse - never as success.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok","data":{}}');
        break;
      case '/err-json':
        // §4(e) direction 2: an explicit JSON error must classify as failure.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"success":false,"error":"daily upload limit reached"}');
        break;
      case '/tls-reset':
        // Abrupt socket destroy mid-response: curl sees a transport-class
        // reset (exit 52/56) which the classifier maps to tcp/tls => retried.
        req.socket.destroy();
        break;
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such mock route');
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('mirror-mock-server listening on 127.0.0.1:' + PORT + '\n');
});
