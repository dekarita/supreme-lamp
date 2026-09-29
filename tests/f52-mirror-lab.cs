// F52 hermetic loopback receiver. Counts/drains; NEVER retains a file body.
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Ghrdp.MirrorLab {
    public sealed class DiscardReceiver : IDisposable {
        private readonly HttpListener listener = new HttpListener();
        private readonly ManualResetEventSlim release = new ManualResetEventSlim(false);
        private readonly long size;
        private readonly bool freeze;
        private readonly Task serving;
        private HttpListenerContext context;
        private long payloadBytes;
        private long bodyBytes;
        public readonly int Port;
        public string Error = "";
        public string PartHeader = "";
        public string PartType = "";
        public bool IdentityHeaders;
        public long PayloadBytes { get { return Interlocked.Read(ref payloadBytes); } }
        public long BodyBytes { get { return Interlocked.Read(ref bodyBytes); } }
        public bool Complete { get { return serving.IsCompleted; } }
        public DiscardReceiver(long size, bool freeze) {
            this.size = size; this.freeze = freeze;
            var portProbe = new TcpListener(IPAddress.Loopback, 0);
            portProbe.Start(); Port = ((IPEndPoint)portProbe.LocalEndpoint).Port; portProbe.Stop();
            listener.Prefixes.Add("http://127.0.0.1:" + Port + "/uploadfile/");
            listener.Start(); serving = Task.Run((Action)Serve);
        }
        private int ReadByte(Stream input) {
            int b = input.ReadByte();
            if (b >= 0) Interlocked.Increment(ref bodyBytes);
            return b;
        }
        private void Serve() {
            try {
                context = listener.GetContext();
                IdentityHeaders = !String.IsNullOrEmpty(context.Request.Headers["Authorization"])
                    || !String.IsNullOrEmpty(context.Request.Headers["X-Gofile-Token"])
                    || !String.IsNullOrEmpty(context.Request.Headers["Cookie"]);
                Stream input = context.Request.InputStream;
                // Only the multipart header is retained (bounded at 4096 B).
                var head = new StringBuilder();
                int b;
                while (head.Length < 4096 && (b = ReadByte(input)) >= 0) {
                    head.Append((char)b);
                    if (head.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal)) break;
                }
                PartHeader = head.ToString();
                if (!PartHeader.EndsWith("\r\n\r\n", StringComparison.Ordinal)) throw new IOException("multipart header missing");
                PartType = PartHeader.Contains("application/x-ghrdp-mirror") ? "encrypted" : "plain";
                byte[] buffer = new byte[1048576];
                while (PayloadBytes < size) {
                    int count = (int)Math.Min((long)buffer.Length, size - PayloadBytes);
                    int n = input.Read(buffer, 0, count);
                    if (n <= 0) throw new IOException("payload ended before expected Int64 length");
                    Interlocked.Add(ref bodyBytes, (long)n);
                    Interlocked.Add(ref payloadBytes, (long)n);
                    if (freeze) release.Wait(); // socket eventually backpressures; no fake counter clock
                }
                while ((b = input.Read(buffer, 0, buffer.Length)) > 0) Interlocked.Add(ref bodyBytes, (long)b);
                byte[] response = Encoding.UTF8.GetBytes("{\"status\":\"ok\",\"data\":{\"id\":\"f52-loopback\",\"downloadPage\":\"https://gofile.test/d/f52\"}}");
                context.Response.StatusCode = 200; context.Response.ContentType = "application/json";
                context.Response.ContentLength64 = response.LongLength;
                context.Response.OutputStream.Write(response, 0, response.Length);
                context.Response.Close(); input.Dispose();
            } catch (Exception e) { Error = e.GetBaseException().Message; }
        }
        public void Dispose() {
            release.Set(); listener.Close();
            try { if (context != null) context.Request.InputStream.Close(); } catch { }
            try { serving.Wait(2000); } catch { }
            release.Dispose();
        }
    }

    // A failed Flush must not count a successful Read or an attempted Write.
    public sealed class FlushFault : Stream {
        public override bool CanRead { get { return false; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { return 0; } }
        public override long Position { get { return 0; } set { throw new NotSupportedException(); } }
        public override void Write(byte[] b, int o, int c) { }
        public override void Flush() { throw new IOException("lab socket flush fault"); }
        public override Task FlushAsync(CancellationToken t) { Flush(); return Task.FromResult(0); }
        public override int Read(byte[] b, int o, int c) { throw new NotSupportedException(); }
        public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
        public override void SetLength(long n) { throw new NotSupportedException(); }
    }
}
