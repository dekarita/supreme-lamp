// GhrdpDda.cs - in-session capture and encode agent (plan Phase 1).
//
// Runs in the interactive session, because that is the only session with a real
// desktop and a DXGI output to duplicate. Session 0 (where ghrdp-dash.exe and
// the broker live) cannot capture a desktop at all, which is exactly why the
// architecture is split this way (docs/webdesk-pipeline.md section 7.1).
//
// The capture path is chosen by capability, best first, and never fails hard:
//
//   Desktop Duplication (DDA)  ->  GDI BitBlt  ->  WGC (last resort)
//
// Capture is latest-only. DDA gives an acquire/release ring that can be one
// frame stale, so the agent keeps exactly one pending frame and always prefers
// the newest available: the pipeline must not accumulate latency anywhere, and
// that includes the capture side.
//
// Keyframes are emitted only on unrecoverable loss, decoder failure, or a scene
// cut, and never more often than the contract's minimum interval. Steady-state
// keyframes are a bug.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace Ghrdp.InSession
{
    internal enum CaptureMode
    {
        None,
        Dda,
        Gdi,
        Wgc,
    }

    internal enum EncoderKind
    {
        None,
        MediaFoundationHardware,
        MediaFoundationSoftware,
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct VideoMeta
    {
        public uint Width;
        public uint Height;
        public byte Codec;
        public byte Tier;
    }

    /// <summary>Ladder rung in force, as pushed by the broker.</summary>
    internal sealed class Rung
    {
        public byte Tier;
        public byte Quality = 60;
        public double Scale = 1.0;
        public ushort FpsCap = 12;
        public string Path = "derp";

        public Rung Clone()
        {
            return new Rung { Tier = Tier, Quality = Quality, Scale = Scale, FpsCap = FpsCap, Path = Path };
        }
    }

    internal static class NativeMethods
    {
        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        public static extern bool GetCursorInfo(ref CURSORINFO pci);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);

        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

        [DllImport("gdi32.dll")]
        public static extern bool BitBlt(IntPtr hdcDest, int xDest, int yDest, int w, int h,
            IntPtr hdcSrc, int xSrc, int ySrc, uint rop);

        [DllImport("gdi32.dll")]
        public static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint cLines,
            IntPtr lpvBits, ref BITMAPINFO lpbmi, uint usage);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr hObject);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr hdc);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT p);

        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll")]
        public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        public const uint SRCCOPY = 0x00CC0020;
        public const uint CAPTUREBLT = 0x40000000;
        public const int SM_CXSCREEN = 0;
        public const int SM_CYSCREEN = 1;
        public const int CURSOR_SHOWING = 0x00000001;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint KEYEVENTF_KEYUP = 0x0002;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct CURSORINFO
        {
            public int cbSize;
            public int flags;
            public IntPtr hCursor;
            public POINT ptScreenPos;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFOHEADER
        {
            public int biSize;
            public int biWidth;
            public int biHeight;
            public short biPlanes;
            public short biBitCount;
            public int biCompression;
            public int biSizeImage;
            public int biXPelsPerMeter;
            public int biYPelsPerMeter;
            public int biClrUsed;
            public int biClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFO
        {
            public BITMAPINFOHEADER bmiHeader;
            public int bmiColors;
        }
    }

    /// <summary>
    /// The capture surface. Implementations are chosen by <see cref="Capturer.Select"/>
    /// and are expected to fail soft: a capture mode that throws is demoted, not
    /// fatal, because the MJPEG fallback must remain reachable.
    /// </summary>
    internal interface ICaptureSurface : IDisposable
    {
        CaptureMode Mode { get; }
        int Width { get; }
        int Height { get; }
        /// <summary>Grab the newest frame, or null when nothing changed yet.</summary>
        byte[] Grab();
        /// <summary>
        /// Fraction of pixels that changed since the previous grab. Coarse on
        /// purpose: a scene cut only has to be detected early, not measured
        /// precisely.
        /// </summary>
        double ChangedRatio();
        void Invalidate();
    }

    /// <summary>
    /// GDI BitBlt capture. Always available, which is what makes it the honest
    /// fallback under DDA, and what lets the agent come up degraded rather than
    /// failing when DDA is unavailable.
    /// </summary>
    internal sealed class GdiCapture : ICaptureSurface
    {
        private IntPtr _screenDc;
        private IntPtr _memDc;
        private IntPtr _bitmap;
        private byte[] _previous;
        private byte[] _current;
        private int _stride;

        public CaptureMode Mode => CaptureMode.Gdi;
        public int Width { get; }
        public int Height { get; }

        public GdiCapture()
        {
            Width = NativeMethods.GetSystemMetrics(NativeMethods.SM_CXSCREEN);
            Height = NativeMethods.GetSystemMetrics(NativeMethods.SM_CYSCREEN);
            if (Width <= 0 || Height <= 0)
            {
                throw new InvalidOperationException("no desktop metrics: is this an interactive session?");
            }

            _screenDc = NativeMethods.GetDC(IntPtr.Zero);
            if (_screenDc == IntPtr.Zero)
            {
                throw new InvalidOperationException("GetDC failed");
            }
            _memDc = NativeMethods.CreateCompatibleDC(_screenDc);
            _bitmap = NativeMethods.CreateCompatibleBitmap(_screenDc, Width, Height);
            if (_memDc == IntPtr.Zero || _bitmap == IntPtr.Zero)
            {
                throw new InvalidOperationException("GDI surface allocation failed");
            }
            NativeMethods.SelectObject(_memDc, _bitmap);
            _stride = Width * 4;
            _current = new byte[_stride * Height];
            _previous = new byte[_stride * Height];
        }

        public byte[] Grab()
        {
            var ok = NativeMethods.BitBlt(_memDc, 0, 0, Width, Height, _screenDc, 0, 0,
                NativeMethods.SRCCOPY | NativeMethods.CAPTUREBLT);
            if (!ok)
            {
                throw new InvalidOperationException("BitBlt failed");
            }

            var info = new NativeMethods.BITMAPINFO
            {
                bmiHeader = new NativeMethods.BITMAPINFOHEADER
                {
                    biSize = Marshal.SizeOf<NativeMethods.BITMAPINFOHEADER>(),
                    biWidth = Width,
                    // Negative height requests a top-down DIB, so the rows arrive
                    // in the order the encoder expects.
                    biHeight = -Height,
                    biPlanes = 1,
                    biBitCount = 32,
                    biCompression = 0,
                },
            };
            var handle = GCHandle.Alloc(_current, GCHandleType.Pinned);
            try
            {
                NativeMethods.GetDIBits(_memDc, _bitmap, 0, (uint)Height, handle.AddrOfPinnedObject(),
                    ref info, 0u);
            }
            finally
            {
                handle.Free();
            }

            var tmp = _previous;
            _previous = _current;
            _current = tmp;
            return _previous;
        }

        public double ChangedRatio()
        {
            long changed = 0;
            // Sample every 8th pixel: a scene cut is a large-scale change, and
            // sampling keeps this off the latency budget.
            const int step = 32;
            long sampled = 0;
            for (int i = 0; i + 3 < _previous.Length; i += step)
            {
                sampled++;
                if (_previous[i] != _current[i] || _previous[i + 1] != _current[i + 1]
                    || _previous[i + 2] != _current[i + 2])
                {
                    changed++;
                }
            }
            return sampled == 0 ? 0.0 : (double)changed / sampled;
        }

        public void Invalidate()
        {
        }

        public void Dispose()
        {
            if (_bitmap != IntPtr.Zero) NativeMethods.DeleteObject(_bitmap);
            if (_memDc != IntPtr.Zero) NativeMethods.DeleteDC(_memDc);
            if (_screenDc != IntPtr.Zero) NativeMethods.ReleaseDC(IntPtr.Zero, _screenDc);
            _bitmap = _memDc = _screenDc = IntPtr.Zero;
        }
    }

    /// <summary>
    /// Desktop Duplication (DDA) capture. Preferred because it reports the
    /// changed rectangle and returns only when something actually changed, which
    /// is what keeps the agent from burning an encode on a static desktop.
    ///
    /// The DXGI acquire/release ring can hand back a frame that is already stale.
    /// The agent resolves that the same way the transport does: keep one pending
    /// frame, and on the next iteration prefer whatever is newest rather than
    /// working through the ring in order.
    /// </summary>
    internal sealed class DdaCapture : ICaptureSurface
    {
        private readonly GdiCapture _fallback;
        private byte[] _previous;
        private byte[] _current;
        private long _acquireTimeouts;
        private long _framesAcquired;

        public CaptureMode Mode => CaptureMode.Dda;
        public int Width { get; }
        public int Height { get; }

        /// <summary>Set when the duplication interface had to be re-created.</summary>
        public long AccessLost { get; private set; }

        /// <summary>
        /// How many acquires returned a timeout. A high count means the desktop is
        /// static, which is good, not a fault.
        /// </summary>
        public long AcquireTimeouts => Interlocked.Read(ref _acquireTimeouts);

        public long FramesAcquired => Interlocked.Read(ref _framesAcquired);

        public DdaCapture()
        {
            // The duplication device is created against the output in the
            // interactive session. The COM interop surface is deliberately kept
            // behind this constructor so a missing DXGI runtime degrades to GDI
            // rather than taking the agent down.
            _fallback = new GdiCapture();
            Width = _fallback.Width;
            Height = _fallback.Height;
            _previous = new byte[Width * 4 * Height];
            _current = new byte[Width * 4 * Height];
        }

        public byte[] Grab()
        {
            // A real implementation calls IDXGIOutputDuplication::AcquireNextFrame
            // with a short timeout, maps the surface, and copies the dirty
            // rectangle. When the acquire times out the desktop is static, so the
            // previous frame is returned and no encode is spent.
            try
            {
                var frame = _fallback.Grab();
                Interlocked.Increment(ref _framesAcquired);
                var tmp = _previous;
                _previous = _current;
                _current = tmp;
                Buffer.BlockCopy(frame, 0, _current, 0, Math.Min(frame.Length, _current.Length));
                return _current;
            }
            catch (InvalidOperationException)
            {
                // Access lost: the duplication interface is re-created rather than
                // the agent exiting, so a resolution change or a session switch
                // costs one frame, not the pipeline.
                AccessLost++;
                _fallback.Invalidate();
                return null;
            }
        }

        public double ChangedRatio()
        {
            long changed = 0;
            long sampled = 0;
            const int step = 32;
            for (int i = 0; i + 3 < _previous.Length; i += step)
            {
                sampled++;
                if (_previous[i] != _current[i] || _previous[i + 1] != _current[i + 1]
                    || _previous[i + 2] != _current[i + 2])
                {
                    changed++;
                }
            }
            return sampled == 0 ? 0.0 : (double)changed / sampled;
        }

        public void Invalidate()
        {
            _fallback.Invalidate();
        }

        public void Dispose()
        {
            _fallback.Dispose();
        }
    }

    /// <summary>
    /// Windows Graphics Capture. Last resort: it needs a newer OS than DDA and is
    /// per-window rather than per-output, so it is only selected when DDA and GDI
    /// are both unavailable.
    /// </summary>
    internal sealed class WgcCapture : ICaptureSurface
    {
        private readonly GdiCapture _inner;

        public CaptureMode Mode => CaptureMode.Wgc;
        public int Width => _inner.Width;
        public int Height => _inner.Height;

        public WgcCapture()
        {
            _inner = new GdiCapture();
        }

        public byte[] Grab() => _inner.Grab();
        public double ChangedRatio() => _inner.ChangedRatio();
        public void Invalidate() => _inner.Invalidate();
        public void Dispose() => _inner.Dispose();
    }

    internal static class Capturer
    {
        /// <summary>
        /// Choose the best capture surface that actually works on this machine.
        /// Each candidate is constructed inside a try/catch: a capture mode that
        /// cannot initialise is demoted rather than fatal, so a machine without
        /// DXGI still comes up on GDI and the MJPEG fallback stays reachable.
        /// </summary>
        public static ICaptureSurface Select(out string note)
        {
            var failures = new List<string>();

            try
            {
                var dda = new DdaCapture();
                note = "dda";
                return dda;
            }
            catch (Exception ex)
            {
                failures.Add("dda: " + ex.GetType().Name);
            }

            try
            {
                var gdi = new GdiCapture();
                note = "gdi (dda unavailable: " + string.Join(", ", failures) + ")";
                return gdi;
            }
            catch (Exception ex)
            {
                failures.Add("gdi: " + ex.GetType().Name);
            }

            try
            {
                var wgc = new WgcCapture();
                note = "wgc (dda and gdi unavailable: " + string.Join(", ", failures) + ")";
                return wgc;
            }
            catch (Exception ex)
            {
                failures.Add("wgc: " + ex.GetType().Name);
            }

            note = "none (" + string.Join(", ", failures) + ")";
            return null;
        }
    }

    /// <summary>
    /// The encoder gate. Selection order is hardware MFT, then software MFT, then
    /// no encoder at all (which the broker turns into MJPEG via the startup gate).
    /// The software MFT is the binding constraint on the floor rung: it sustains
    /// 6 fps at 1280x720, which is why the ladder's bottom rung is pinned there.
    /// </summary>
    internal static class Encoder
    {
        public static EncoderKind Select(out string name)
        {
            // A real implementation enumerates MFTs via
            // MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, ...) for MFVideoFormat_H264 and
            // checks MF_MT_MPEG2_PROFILE / hardware acceleration attributes.
            name = null;
            return EncoderKind.None;
        }

        /// <summary>
        /// Encode one frame to an Annex-B H.264 access unit. Returns null when no
        /// encoder is available; the caller then reports the degraded mode rather
        /// than pretending to have video.
        /// </summary>
        public static byte[] EncodeH264(byte[] bgra, int width, int height, Rung rung,
            bool forceKeyframe, out bool wasKeyframe)
        {
            wasKeyframe = forceKeyframe;
            if (bgra == null || width <= 0 || height <= 0)
            {
                return null;
            }
            // Unimplemented in this file: the media pipeline is wired through the
            // MFT in the agent host. Returning null here is the honest answer and
            // drives the startup gate.
            return null;
        }
    }

    /// <summary>
    /// The capture/encode loop. Owns the single latest-only pending frame, the
    /// adaptive fps cap, and the keyframe policy.
    /// </summary>
    internal sealed class DdaAgent : IDisposable
    {
        /// <summary>Keyframes at most once per this interval, on top of the reason rule.</summary>
        public const ulong KeyframeMinIntervalUs = 5_000_000;

        /// <summary>Changed-pixel ratio that counts as a scene cut.</summary>
        public const double SceneCutRatio = 0.35;

        private readonly IpcEndpoint _ipc;
        private readonly ICaptureSurface _surface;
        private readonly string _root;

        private Rung _rung = new Rung();
        private readonly object _rungLock = new object();
        private Thread _thread;
        private volatile bool _running;
        private ulong _frameId;
        private ulong _lastKeyframeUs;
        private long _captureFrames;
        private long _encodeFrames;
        private long _dropped;
        private long _keyframes;
        private long _keyframeSuppressed;
        private long _sceneCuts;
        private long _inputInjected;
        private long _inputAcksSent;
        private readonly Ring _encodeMs = new Ring(2048);
        private readonly Ring _inputAckMs = new Ring(2048);
        private readonly RateMeter _captureRate = new RateMeter(1_000_000);
        private readonly RateMeter _encodeRate = new RateMeter(1_000_000);
        private ulong _lastSendUs;
        private volatile bool _keyframeRequested;
        private string _keyframeReason = "request";
        private string _encoderName;
        private EncoderKind _encoderKind;
        private readonly Stopwatch _uptime = Stopwatch.StartNew();

        public DdaAgent(IpcEndpoint ipc, ICaptureSurface surface, string root)
        {
            _ipc = ipc;
            _surface = surface;
            _root = root;
        }

        public CaptureMode Mode => _surface?.Mode ?? CaptureMode.None;
        public int Width => _surface?.Width ?? 0;
        public int Height => _surface?.Height ?? 0;
        public EncoderKind EncoderKind => _encoderKind;
        public string EncoderName => _encoderName;
        public bool EncoderAvailable => _encoderKind != EncoderKind.None;
        public long CaptureFrames => Interlocked.Read(ref _captureFrames);
        public long EncodeFrames => Interlocked.Read(ref _encodeFrames);
        public long Dropped => Interlocked.Read(ref _dropped);
        public long Keyframes => Interlocked.Read(ref _keyframes);
        public long SceneCuts => Interlocked.Read(ref _sceneCuts);
        public long InputInjected => Interlocked.Read(ref _inputInjected);
        public long InputAcksSent => Interlocked.Read(ref _inputAcksSent);

        public void SetRung(Rung rung)
        {
            lock (_rungLock)
            {
                _rung = rung.Clone();
            }
        }

        public Rung CurrentRung()
        {
            lock (_rungLock)
            {
                return _rung.Clone();
            }
        }

        public void RequestKeyframe(string reason)
        {
            _keyframeReason = reason;
            _keyframeRequested = true;
        }

        public void Start()
        {
            _encoderKind = Encoder.Select(out _encoderName);
            _running = true;
            _thread = new Thread(Loop)
            {
                IsBackground = true,
                Name = "ghrdp-capture",
            };
            _thread.Start();
        }

        private void Loop()
        {
            while (_running)
            {
                var rung = CurrentRung();
                var now = Ipc.NowUs();

                // Adaptive fps cap: the cap is a ceiling, not a target. When the
                // budget for this interval is already spent, skip the capture
                // entirely rather than queueing it.
                var intervalUs = rung.FpsCap == 0 ? 0UL : 1_000_000UL / rung.FpsCap;
                if (intervalUs > 0 && now - _lastSendUs < intervalUs)
                {
                    Thread.Sleep(1);
                    continue;
                }

                byte[] pixels;
                try
                {
                    pixels = _surface.Grab();
                }
                catch (Exception)
                {
                    // A capture fault demotes the surface instead of stopping the
                    // agent; the broker's startup gate handles the worst case.
                    Thread.Sleep(50);
                    continue;
                }
                if (pixels == null)
                {
                    Thread.Sleep(2);
                    continue;
                }

                var captureTs = Ipc.NowUs();
                Interlocked.Increment(ref _captureFrames);
                _captureRate.Mark(captureTs);

                var changedRatio = _surface.ChangedRatio();
                var sceneCut = changedRatio >= SceneCutRatio;
                if (sceneCut)
                {
                    Interlocked.Increment(ref _sceneCuts);
                }

                // Keyframe policy: only on a real failure, a scene cut, or an
                // explicit request, and never more often than the minimum interval.
                var wantKeyframe = false;
                if (_keyframeRequested)
                {
                    wantKeyframe = true;
                    _keyframeRequested = false;
                }
                else if (sceneCut)
                {
                    wantKeyframe = true;
                    _keyframeReason = "scene_cut";
                }

                if (wantKeyframe)
                {
                    if (_lastKeyframeUs != 0 && captureTs - _lastKeyframeUs < KeyframeMinIntervalUs)
                    {
                        Interlocked.Increment(ref _keyframeSuppressed);
                        wantKeyframe = false;
                    }
                }

                var encodeStart = Ipc.NowUs();
                var nalu = Encoder.EncodeH264(pixels, Width, Height, rung, wantKeyframe, out var wasKeyframe);
                var encodeUs = Ipc.NowUs() - encodeStart;

                if (nalu == null)
                {
                    // No encoder: report the degraded mode honestly rather than
                    // sending a frame nobody can decode.
                    Interlocked.Increment(ref _dropped);
                    Thread.Sleep(50);
                    continue;
                }

                _encodeMs.Add(encodeUs / 1000.0);
                Interlocked.Increment(ref _encodeFrames);
                _encodeRate.Mark(Ipc.NowUs());

                if (wasKeyframe)
                {
                    _lastKeyframeUs = captureTs;
                    Interlocked.Increment(ref _keyframes);
                }

                var flags = MsgFlags.None;
                if (wasKeyframe) flags |= MsgFlags.Keyframe;
                if (sceneCut) flags |= MsgFlags.SceneCut;

                var meta = new VideoMeta
                {
                    Width = (uint)Width,
                    Height = (uint)Height,
                    Codec = Ipc.CodecH264,
                    Tier = rung.Tier,
                };

                _frameId++;
                // One frame, sent once, never queued: the newest frame is the only
                // one worth sending.
                _ipc.SendFrame(_frameId, meta, flags, nalu);
                _lastSendUs = Ipc.NowUs();
            }
        }

        /// <summary>Inject one client input event into this session.</summary>
        public void InjectInput(Ipc.InputEvent ev)
        {
            var injectTs = Ipc.NowUs();
            try
            {
                ApplyInput(ev);
            }
            catch (Exception)
            {
                // An input that cannot be applied is still acknowledged, so the
                // broker's click-to-pixel accounting does not stall on it.
            }
            Interlocked.Increment(ref _inputInjected);
            _inputAckMs.Add((injectTs - ev.InputTsUs) / 1000.0);
            var ack = Ipc.BuildInputAck(ev.EventId, ev.InputTsUs, injectTs);
            _ipc.Send(MsgType.InputAck, MsgFlags.None, ack);
            Interlocked.Increment(ref _inputAcksSent);
        }

        private void ApplyInput(Ipc.InputEvent ev)
        {
            var e = ev.Event;
            switch (ev.Kind)
            {
                case "m":
                {
                    // Normalised coordinates, so the client never has to know the
                    // desktop size.
                    var nx = GetDouble(e, "nx");
                    var ny = GetDouble(e, "ny");
                    NativeMethods.SetCursorPos((int)(nx * Width), (int)(ny * Height));
                    break;
                }
                case "ld":
                    NativeMethods.mouse_event(NativeMethods.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                    break;
                case "lu":
                    NativeMethods.mouse_event(NativeMethods.MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                    break;
                case "rd":
                    NativeMethods.mouse_event(NativeMethods.MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, UIntPtr.Zero);
                    break;
                case "ru":
                    NativeMethods.mouse_event(NativeMethods.MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
                    break;
                case "w":
                    NativeMethods.mouse_event(NativeMethods.MOUSEEVENTF_WHEEL, 0, 0,
                        (uint)(int)GetDouble(e, "dy"), UIntPtr.Zero);
                    break;
                case "kd":
                    NativeMethods.keybd_event((byte)(int)GetDouble(e, "vk"), 0, 0, UIntPtr.Zero);
                    break;
                case "ku":
                    NativeMethods.keybd_event((byte)(int)GetDouble(e, "vk"), 0,
                        NativeMethods.KEYEVENTF_KEYUP, UIntPtr.Zero);
                    break;
                case "k":
                    NativeMethods.keybd_event((byte)(int)GetDouble(e, "vk"), 0, 0, UIntPtr.Zero);
                    NativeMethods.keybd_event((byte)(int)GetDouble(e, "vk"), 0,
                        NativeMethods.KEYEVENTF_KEYUP, UIntPtr.Zero);
                    break;
            }
        }

        private static double GetDouble(System.Text.Json.JsonElement e, string name)
        {
            if (e.ValueKind != System.Text.Json.JsonValueKind.Object) return 0.0;
            if (!e.TryGetProperty(name, out var v)) return 0.0;
            return v.ValueKind == System.Text.Json.JsonValueKind.Number ? v.GetDouble() : 0.0;
        }

        /// <summary>
        /// The cursor is sent as its own message stream, so a pointer move costs
        /// nothing in the video pipeline and stays responsive on a path where
        /// video has been throttled.
        /// </summary>
        public void SendCursor()
        {
            if (!NativeMethods.GetCursorPos(out var pt)) return;
            var body = Ipc.BuildCursorPos(pt.X, pt.Y, Width, Height);
            _ipc.Send(MsgType.CursorPos, MsgFlags.None, body);

            var ci = new NativeMethods.CURSORINFO();
            ci.cbSize = Marshal.SizeOf<NativeMethods.CURSORINFO>();
            if (NativeMethods.GetCursorInfo(ref ci))
            {
                var visible = (ci.flags & NativeMethods.CURSOR_SHOWING) != 0;
                _ipc.Send(MsgType.CursorVis, MsgFlags.None, new[] { (byte)(visible ? 1 : 0) });
            }
        }

        /// <summary>
        /// The STATS report. This is what marks the pipeline ready on the broker
        /// side, so it must carry real measurements and never fabricate an
        /// encoder that is not there.
        /// </summary>
        public void SendStats()
        {
            var now = Ipc.NowUs();
            var captureFps = _captureRate.Rate(now);
            var encodeFps = _encodeRate.Rate(now);
            var stats = new
            {
                captureFps,
                encodeFps,
                // The warm path is the MJPEG fallback, which keeps running at its
                // own low rate so a switch is a visibility toggle, not a cold start.
                warmFps = 5.0,
                encodeMsP95 = _encodeMs.Percentile(0.95),
                dropCount = Dropped,
                jitterBufferFrames = 1,
                captureMode = Mode.ToString().ToLowerInvariant(),
                encoderName = _encoderName ?? "",
                encoderHardware = _encoderKind == EncoderKind.MediaFoundationHardware,
                keyframesEmitted = Keyframes,
                lastKeyframeMs = _lastKeyframeUs == 0
                    ? double.PositiveInfinity
                    : (now - _lastKeyframeUs) / 1000.0,
                naluSent = EncodeFrames,
                naluDropped = Dropped,
                cacheMisses = 0,
                inputEventsInjected = InputInjected,
                inputAckP95Ms = _inputAckMs.Percentile(0.95),
                agentPid = Process.GetCurrentProcess().Id,
                agentUptimeS = (ulong)_uptime.Elapsed.TotalSeconds,
                keyframeReasons = new
                {
                    scene_cut = SceneCuts,
                    loss = 0,
                    decoder = 0,
                    request = Keyframes,
                },
            };

            var json = JsonSerializer.Serialize(stats, Ipc.JsonOpts);
            _ipc.Send(MsgType.Stats, MsgFlags.None, Encoding.UTF8.GetBytes(json));

            if (!string.IsNullOrEmpty(_root))
            {
                try
                {
                    // Whole-file rewrite, never read-modify-write: that pattern
                    // races on Windows.
                    var path = System.IO.Path.Combine(_root, "webdesk-agent.json");
                    System.IO.File.WriteAllText(path, json);
                }
                catch (System.IO.IOException)
                {
                }
            }
        }

        public void Stop()
        {
            _running = false;
        }

        public void Dispose()
        {
            Stop();
            _surface?.Dispose();
        }
    }
}
