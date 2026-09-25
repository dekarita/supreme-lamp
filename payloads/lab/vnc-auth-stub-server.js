/* ghrdp lab asset [F13-6 §3]: minimal RFB server with VNC Authentication.
 *
 * Purpose: give the REAL noVNC client (v1.7.0, the version main.yml pins and
 * deploys) a REAL VNC-auth handshake to complete in the lab proof, so the
 * cred-shim can be proven end-to-end: credentialsrequired -> shim fills
 * #noVNC_password_input from the opener postMessage -> click submit ->
 * RFB.sendCredentials -> DES response lands on THIS socket -> SecurityResult
 * OK -> ServerInit -> noVNC reports connected. ZERO manual typing.
 *
 * The challenge response is NOT validated (this is a lab stub, not an auth
 * oracle): any 16 bytes are accepted - the thing under test is the CLIENT
 * path, not VNC-auth cryptography. Everything the server receives is buffered
 * so the test can prove the cleartext password never appears on the wire.
 *
 * Endpoints:
 *   TCP 127.0.0.1:5901  - the RFB server (websockify bridges WS to it)
 *   TCP 127.0.0.1:5902  - HTTP state endpoint: GET /state -> JSON progress
 *
 * Usage: node vnc-auth-stub-server.js <rfbPort=5901> <httpPort=5902>
 */
'use strict';
const net = require('net');
const http = require('http');

const RFB_PORT = parseInt(process.argv[2] || '5901', 10);
const HTTP_PORT = parseInt(process.argv[3] || '5902', 10);

const state = {
    helloReceived: false,
    typeChosen: null,
    challengeSent: false,
    responseBytes: null,
    okSent: false,
    clientInitSeen: false,
    serverInitSent: false,
    connected: false,
    received: [],        // every inbound chunk as latin1 text (JSON-safe; for the no-cleartext-password proof)
    sockets: 0
};

const rfb = net.createServer((sock) => {
    state.sockets++;
    let phase = 'version';
    sock.on('data', (d) => {
        state.received.push(d.toString('latin1'));   // byte-faithful, JSON-serializable
        if (phase === 'version') {
            // client -> "RFB 003.008\n"
            state.helloReceived = true;
            sock.write(Buffer.from('RFB 003.008\n'));
            phase = 'types';
            return;
        }
        if (phase === 'types') {
            // client -> chosen security type (1 byte). We offered only [2].
            state.typeChosen = d[0];
            sock.write(Buffer.alloc(16, 0x5a));       // 16-byte VNC-auth challenge
            state.challengeSent = true;
            phase = 'challenge';
            return;
        }
        if (phase === 'challenge') {
            // client -> 16-byte DES challenge response (only produced after
            // RFB.sendCredentials - i.e. after the shim filled the dialog).
            state.responseBytes = d.slice(0, 16);
            sock.write(Buffer.from([0, 0, 0, 0]));    // SecurityResult: OK
            state.okSent = true;
            phase = 'clientinit';
            return;
        }
        if (phase === 'clientinit') {
            // client -> ClientInitialisation (shared flag byte)
            state.clientInitSeen = true;
            const name = Buffer.from('ghrdp-lab');
            const head = Buffer.alloc(24);
            head.writeUInt16BE(800, 0);               // framebuffer width
            head.writeUInt16BE(600, 2);               // framebuffer height
            head[4] = 32;                             // bits per pixel
            head[5] = 24;                             // depth
            head[6] = 1;                              // big-endian
            head[7] = 1;                              // true colour
            head.writeUInt16BE(255, 8);               // red max
            head.writeUInt16BE(255, 10);              // green max
            head.writeUInt16BE(255, 12);              // blue max
            head[14] = 16;                            // red shift
            head[15] = 8;                             // green shift
            head[16] = 0;                             // blue shift
            head.writeUInt32BE(name.length, 20);
            sock.write(Buffer.concat([head, name]));  // ServerInit
            state.serverInitSent = true;
            state.connected = true;
            phase = 'session';
            return;
        }
        // session: SetPixelFormat / SetEncodings / FramebufferUpdateRequest -
        // ignore and keep the socket open so noVNC stays connected.
    });
    sock.on('error', () => { });
});
rfb.listen(RFB_PORT, '127.0.0.1');

const httpSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
});
httpSrv.listen(HTTP_PORT, '127.0.0.1');

setTimeout(() => { process.exit(0); }, 15 * 60 * 1000);   // hard lab cap: 15 min
console.log('vnc-auth-stub-server: rfb=' + RFB_PORT + ' state=' + HTTP_PORT);
