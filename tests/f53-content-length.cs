// F53 hermetic listeners. A strict Content-Length rejector (raw TCP, not
// HttpListener) and a TLS twin. Neither retains a file body.
using System;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Ghrdp.MirrorLab {
    public sealed class ContentLengthGate : Stream {
        private long written;
        private readonly long limit;
        public long Written { get { return written; } }
        public ContentLengthGate(long limit) { this.limit = limit; }
        public override void Write(byte[] buffer, int offset, int count) {
            if (count < 0) throw new ArgumentOutOfRangeException("count");
            if (written + count > limit) {
                throw new IOException("Unable to write content to request stream; content would exceed Content-Length.");
            }
            written += count;
        }
        public override bool CanRead { get { return false; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { return written; } }
        public override long Position { get { return written; } set { throw new NotSupportedException(); } }
        public override void Flush() { }
        public override int Read(byte[] b, int o, int c) { throw new NotSupportedException(); }
        public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
        public override void SetLength(long n) { throw new NotSupportedException(); }
    }

    public sealed class StrictReceiver : IDisposable {
        private readonly TcpListener listener;
        private readonly Task serving;
        private readonly ManualResetEvent done = new ManualResetEvent(false);
        private readonly X509Certificate2 cert;
        public readonly int Port;
        public long Declared;
        public long Drained;
        public bool Overshoot;
        public bool SawContentLength;
        public bool SawChunked;
        public bool ExpectContinue;
        public string Error = "";
        public int StatusWritten;
        public StrictReceiver() : this(null) { }
        public StrictReceiver(X509Certificate2 cert) {
            this.cert = cert;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            serving = Task.Run((Action)Serve);
        }
        public void Wait(int ms) { done.WaitOne(ms); }
        public void Dispose() {
            try { listener.Stop(); } catch { }
            done.Set();
        }
        private void Serve() {
            TcpClient client = null;
            try {
                client = listener.AcceptTcpClient();
                client.ReceiveTimeout = 0;
                client.SendTimeout = 120000;
                Stream stream = client.GetStream();
                if (cert != null) {
                    SslStream ssl = new SslStream(stream, false);
                    ssl.AuthenticateAsServer(cert, false, SslProtocols.Tls12, false);
                    stream = ssl;
                }
                ByteBuf buf = new ByteBuf(stream);
                string headers = buf.ReadHeaders();
                Parse(headers);
                if (ExpectContinue) {
                    byte[] cont = Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n");
                    stream.Write(cont, 0, cont.Length);
                    stream.Flush();
                }
                if (SawChunked && !SawContentLength) {
                    Error = "framing=chunked";
                    WriteResponse(stream, 411, "{\"status\":\"error\",\"data\":{}}");
                    return;
                }
                byte[] scratch = new byte[65536];
                while (Drained < Declared) {
                    int want = scratch.Length;
                    long left = Declared - Drained;
                    if (left < want) want = (int)left;
                    int n = buf.Read(scratch, 0, want);
                    if (n <= 0) break;
                    Drained += n;
                }
                try { client.ReceiveTimeout = 250; } catch { }
                try { stream.ReadTimeout = 250; } catch { }
                try {
                    int extra = buf.Read(scratch, 0, 1);
                    if (extra > 0) { Overshoot = true; Drained += extra; }
                } catch (IOException) { } catch (ObjectDisposedException) { }
                if (Overshoot || Drained != Declared) {
                    StatusWritten = 400;
                    WriteResponse(stream, 400, "{\"status\":\"error\",\"data\":{\"message\":\"content would exceed Content-Length\"}}");
                } else {
                    StatusWritten = 200;
                    WriteResponse(stream, 200, "{\"status\":\"ok\",\"data\":{\"id\":\"f53\",\"downloadPage\":\"https://gofile.test/d/f53\"}}");
                }
            } catch (Exception ex) {
                Error = ex.GetType().Name + ": " + ex.Message;
            } finally {
                try { if (client != null) client.Close(); } catch { }
                done.Set();
            }
        }
        private void Parse(string headers) {
            string[] lines = headers.Split(new char[] { '\n' });
            for (int i = 0; i < lines.Length; i++) {
                string line = lines[i].Trim();
                int colon = line.IndexOf(':');
                if (colon <= 0) continue;
                string name = line.Substring(0, colon).Trim();
                string value = line.Substring(colon + 1).Trim();
                if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) {
                    SawContentLength = true;
                    Declared = long.Parse(value);
                } else if (name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase) && value.IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0) {
                    SawChunked = true;
                } else if (name.Equals("Expect", StringComparison.OrdinalIgnoreCase) && value.IndexOf("100-continue", StringComparison.OrdinalIgnoreCase) >= 0) {
                    ExpectContinue = true;
                }
            }
        }
        private static void WriteResponse(Stream stream, int code, string body) {
            byte[] b = Encoding.UTF8.GetBytes(body);
            string reason = code == 200 ? "OK" : "Error";
            string head = "HTTP/1.1 " + code + " " + reason + "\r\nContent-Type: application/json\r\nContent-Length: " + b.Length.ToString() + "\r\nConnection: close\r\n\r\n";
            byte[] h = Encoding.ASCII.GetBytes(head);
            stream.Write(h, 0, h.Length);
            stream.Write(b, 0, b.Length);
            stream.Flush();
        }
    }

    sealed class ByteBuf {
        private readonly Stream stream;
        private readonly byte[] buf = new byte[8192];
        private int pos;
        private int len;
        public ByteBuf(Stream stream) { this.stream = stream; }
        public int ReadByte() {
            if (pos >= len) {
                len = stream.Read(buf, 0, buf.Length);
                pos = 0;
                if (len <= 0) return -1;
            }
            return buf[pos++];
        }
        public int Read(byte[] dest, int offset, int count) {
            int n = 0;
            while (n < count && pos < len) { dest[offset + n] = buf[pos++]; n++; }
            if (n < count) {
                int m = stream.Read(dest, offset + n, count - n);
                if (m > 0) n += m;
            }
            return n;
        }
        public string ReadHeaders() {
            StringBuilder sb = new StringBuilder();
            int prev = 0;
            while (sb.Length < 65536) {
                int b = ReadByte();
                if (b < 0) break;
                sb.Append((char)b);
                if (prev == '\n' && b == '\r') {
                    int n = ReadByte();
                    if (n == '\n') { sb.Append('\n'); break; }
                }
                prev = b;
            }
            return sb.ToString();
        }
    }

    // Length witness only. Not an authenticated ciphertext and not an upload
    // source for the worker. Header is the decrypt layout: 8+1+1+1+12+1+16.
    public sealed class GcmLengthSource : Stream {
        private readonly Stream inner;
        private readonly byte[] header = new byte[40];
        private int headerAt;
        private long position;
        public readonly long WireLength;
        public GcmLengthSource(string path) {
            FileStream file = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            long plain = file.Length;
            WireLength = checked(40L + plain);
            inner = new Bounded(file, plain);
        }
        public override int Read(byte[] buffer, int offset, int count) {
            if (count == 0 || position >= WireLength) return 0;
            long left = WireLength - position;
            if ((long)count > left) count = (int)left;
            if (headerAt < header.Length) {
                int n = Math.Min(count, header.Length - headerAt);
                Array.Copy(header, headerAt, buffer, offset, n);
                headerAt += n; position += n; return n;
            }
            int got = inner.Read(buffer, offset, count);
            position += got;
            return got;
        }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return WireLength; } }
        public override long Position { get { return position; } set { throw new NotSupportedException(); } }
        public override void Flush() { }
        public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
        public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
        public override void SetLength(long n) { throw new NotSupportedException(); }
        protected override void Dispose(bool disposing) {
            if (disposing) inner.Dispose();
            base.Dispose(disposing);
        }
        sealed class Bounded : Stream {
            private readonly Stream inner;
            private long remaining;
            public Bounded(Stream inner, long max) { this.inner = inner; remaining = max; }
            public override int Read(byte[] buffer, int offset, int count) {
                if (count <= 0 || remaining <= 0) return 0;
                if ((long)count > remaining) count = (int)remaining;
                int n = inner.Read(buffer, offset, count);
                if (n > 0) remaining -= n;
                return n;
            }
            public override bool CanRead { get { return true; } }
            public override bool CanSeek { get { return false; } }
            public override bool CanWrite { get { return false; } }
            public override long Length { get { throw new NotSupportedException(); } }
            public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
            public override void Flush() { }
            public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
            public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
            public override void SetLength(long n) { throw new NotSupportedException(); }
            protected override void Dispose(bool disposing) {
                if (disposing) inner.Dispose();
                base.Dispose(disposing);
            }
        }
    }
}
