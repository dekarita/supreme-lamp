// F52: payload-only progress at the outgoing stream, never at file reads.
// C# callbacks stay on .NET threads; PowerShell polls snapshots on its own
// runspace. All byte arithmetic is Int64, and storage is bounded by time.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Ghrdp.Mirror {
    public static class GuestClient {
        public static HttpClient Create() {
            return new HttpClient(new HttpClientHandler {
                UseProxy = false, UseCookies = false, AllowAutoRedirect = false
            });
        }
    }

    public sealed class ProgressSnapshot {
        public long BytesSent;
        public long WindowBytes;
        public double WindowSeconds;
        public double SpeedBps;
        public double ElapsedSeconds;
        public int NoBytesSeconds;
        public int StallWindows;
        public bool Stalled;
        public bool Failed;
        public string LastMessage;
    }

    public sealed class ProgressState {
        private sealed class Point {
            public double At;
            public long Bytes;
            public Point(double at, long bytes) { At = at; Bytes = bytes; }
        }
        private readonly object gate = new object();
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly List<Point> points = new List<Point>();
        private readonly int stallSeconds;
        private long sent;
        private double lastByteAt;
        private string lastMessage = "no socket/host text reported";
        private bool cancelling;

        public ProgressState(int stallSeconds) {
            if (stallSeconds < 1) throw new ArgumentOutOfRangeException("stallSeconds");
            this.stallSeconds = stallSeconds;
            points.Add(new Point(0, 0));
        }
        // Called ONLY after a successful destination Write + Flush pair.
        public void Written(int count) {
            if (count <= 0) return;
            lock (gate) {
                sent = checked(sent + (long)count);
                lastByteAt = clock.Elapsed.TotalSeconds;
                SavePoint(lastByteAt);
            }
        }
        private void SavePoint(double now) {
            // Keep one point before the cutoff; no sample-per-byte allocation.
            if (points.Count == 1 || Math.Floor(now) > Math.Floor(points[points.Count - 1].At)) {
                points.Add(new Point(now, sent));
            } else {
                points[points.Count - 1].At = now;
                points[points.Count - 1].Bytes = sent;
            }
            while (points.Count > 1 && points[1].At <= now - 60)
                points.RemoveAt(0);
        }
        public void SocketMessage(string text) {
            lock (gate) { if (!cancelling && !String.IsNullOrEmpty(text)) lastMessage = text; }
        }
        public void CancelForStall() { lock (gate) { cancelling = true; } }
        public ProgressSnapshot Snapshot() { return SnapshotAt(clock.Elapsed.TotalSeconds); }
        // Explicit clock seam for deterministic window cells; production uses Snapshot().
        public ProgressSnapshot SnapshotAt(double seconds) {
            lock (gate) {
                double now = Math.Max(seconds, lastByteAt);
                SavePoint(now);
                Point baseline = points[0];
                long delta = sent - baseline.Bytes;
                double elapsed = Math.Max(0, now - baseline.At);
                int gap = (int)Math.Min(Int32.MaxValue, Math.Floor(Math.Max(0, now - lastByteAt)));
                int windows = gap / stallSeconds;
                return new ProgressSnapshot {
                    BytesSent = sent, WindowBytes = delta, WindowSeconds = elapsed,
                    SpeedBps = delta > 0 && elapsed > 0 ? delta / elapsed : 0,
                    ElapsedSeconds = now, NoBytesSeconds = gap, StallWindows = windows,
                    Stalled = windows >= 1, Failed = windows >= 3, LastMessage = lastMessage
                };
            }
        }
    }

    internal sealed class ProgressWriteStream : Stream {
        private readonly Stream destination;
        private readonly ProgressState state;
        public ProgressWriteStream(Stream destination, ProgressState state) {
            this.destination = destination; this.state = state;
        }
        public override void Write(byte[] buffer, int offset, int count) {
            try {
                destination.Write(buffer, offset, count);
                destination.Flush();
                state.Written(count);
            } catch (Exception e) { state.SocketMessage(e.GetBaseException().Message); throw; }
        }
        public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token) {
            try {
                await destination.WriteAsync(buffer, offset, count, token).ConfigureAwait(false);
                await destination.FlushAsync(token).ConfigureAwait(false);
                state.Written(count);
            } catch (Exception e) { state.SocketMessage(e.GetBaseException().Message); throw; }
        }
        public override void Flush() { destination.Flush(); }
        public override Task FlushAsync(CancellationToken token) { return destination.FlushAsync(token); }
        public override bool CanRead { get { return false; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override int Read(byte[] b, int o, int c) { throw new NotSupportedException(); }
        public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
        public override void SetLength(long n) { throw new NotSupportedException(); }
        // The socket belongs to HttpClient, not to this counting adapter.
    }

    public sealed class ProgressContent : HttpContent {
        private readonly HttpContent content;
        private readonly ProgressState state;
        private readonly long length;
        public ProgressContent(HttpContent content, long length, ProgressState state) {
            this.content = content; this.length = length; this.state = state;
            foreach (var h in content.Headers) Headers.TryAddWithoutValidation(h.Key, h.Value);
            Headers.ContentLength = length;
        }
        protected override bool TryComputeLength(out long n) { n = length; return true; }
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext context) {
            using (var progress = new ProgressWriteStream(stream, state)) {
                await content.CopyToAsync(progress).ConfigureAwait(false);
            }
        }
        protected override void Dispose(bool disposing) {
            if (disposing) content.Dispose();
            base.Dispose(disposing);
        }
    }

    // The EXISTING salt(16)|iv(16)|AES-256-CBC/PBKDF2-SHA256 .ghenc wire form.
    // Encrypt as the socket consumes it: no whole-file array, no ciphertext
    // staging file, no 2GB array limit and no disk-size client cap. GCM legacy
    // files remain readable by Invoke-F46DecryptFile; this mode is named CBC,
    // never mislabeled as authenticated GCM.
    public sealed class EncryptedSource : Stream {
        private readonly FileStream file;
        private readonly Aes aes;
        private readonly ICryptoTransform transform;
        private readonly CryptoStream crypto;
        private readonly byte[] prefix;
        private int prefixAt;
        private long position;
        public readonly long WireLength;
        public static long GetWireLength(long plainLength) {
            if (plainLength < 0) throw new ArgumentOutOfRangeException("plainLength");
            return checked(32L + checked((plainLength / 16L + 1L) * 16L));
        }
        public EncryptedSource(string path, byte[] key) {
            if (key == null || key.Length != 32) throw new ArgumentException("mirror key must be 32 bytes");
            try {
                file = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                WireLength = GetWireLength(file.Length);
                byte[] salt = new byte[16], iv = new byte[16], derived = null;
                using (var rng = RandomNumberGenerator.Create()) { rng.GetBytes(salt); rng.GetBytes(iv); }
                prefix = new byte[32];
                Array.Copy(salt, 0, prefix, 0, 16); Array.Copy(iv, 0, prefix, 16, 16);
                using (var kdf = new Rfc2898DeriveBytes(Encoding.UTF8.GetString(key), salt, 100000, HashAlgorithmName.SHA256)) {
                    derived = kdf.GetBytes(32);
                }
                try {
                    aes = Aes.Create(); aes.KeySize = 256; aes.Key = derived; aes.IV = iv;
                    aes.Mode = CipherMode.CBC; aes.Padding = PaddingMode.PKCS7;
                    transform = aes.CreateEncryptor();
                    crypto = new CryptoStream(file, transform, CryptoStreamMode.Read);
                } finally { if (derived != null) Array.Clear(derived, 0, derived.Length); }
            } catch { Dispose(); throw; }
        }
        public override int Read(byte[] buffer, int offset, int count) {
            if (count == 0) return 0;
            if (prefixAt < prefix.Length) {
                int n = Math.Min(count, prefix.Length - prefixAt);
                Array.Copy(prefix, prefixAt, buffer, offset, n);
                prefixAt += n; position += n; return n;
            }
            int got = crypto.Read(buffer, offset, count); position += got; return got;
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
            if (disposing) {
                if (crypto != null) crypto.Dispose();
                if (transform != null) transform.Dispose();
                if (aes != null) aes.Dispose();
                if (file != null) file.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
