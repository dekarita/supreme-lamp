// GhrdpIpc.cs - in-session agent end of IPC contract v1.
//
// Mirrors payloads/broker/ipc.rs exactly. Both sides must agree byte for byte;
// docs/webdesk-pipeline.md sections 2-3 is the frozen definition and this file
// is the C# reading of it. Any layout change is a contract version bump.
//
// The agent runs in the interactive session (the one with a desktop), while the
// broker runs in session 0. They talk over 127.0.0.1 UDP only: the IPC surface
// must never be reachable from the tailnet.

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace Ghrdp.InSession
{
    internal enum MsgType : byte
    {
        Hello = 0x01,
        HelloAck = 0x02,
        InputEvent = 0x10,
        InputAck = 0x11,
        CursorPos = 0x21,
        CursorShape = 0x22,
        CursorVis = 0x23,
        VideoNalu = 0x30,
        Stats = 0x40,
        KeyframeReq = 0x50,
        Ladder = 0x52,
    }

    [Flags]
    internal enum MsgFlags : byte
    {
        None = 0,
        Keyframe = 0x01,
        SceneCut = 0x02,
        FecParity = 0x04,
        Retransmit = 0x08,
    }

    internal static class Ipc
    {
        public const ushort Magic = 0x4748;
        public const ushort Version = 1;
        public const int HeaderLen = 18;
        public const int VideoHeaderLen = 12;
        // 4B w + 4B h + 1B codec + 1B tier + 8B frameId + 2B index + 2B count + 1B flags
        public const int FragmentHeaderLen = 23;
        public const int MaxDatagram = 1400;

        public const byte CodecH264 = 1;
        public const byte CodecJpeg = 2;
        public const byte TierNone = 255;

        // Input kind tags. Named because `0x80 | (byte)'l'` in a switch arm is a
        // bitwise or that is easy to get wrong when transliterating.
        public const byte KindMove = (byte)'m';
        public const byte KindWheel = (byte)'w';
        public const byte KindKey = (byte)'k';
        public const byte KindKeyDown = (byte)'d';
        public const byte KindKeyUp = (byte)'u';
        public const byte KindLeftDown = 0x80 | (byte)'l';
        public const byte KindLeftUp = 0x40 | (byte)'l';
        public const byte KindRightDown = 0x80 | (byte)'r';
        public const byte KindRightUp = 0x40 | (byte)'r';

        /// <summary>Microseconds since the UNIX epoch.</summary>
        public static ulong NowUs()
        {
            return (ulong)(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L
                + (Stopwatch.GetTimestamp() % (Stopwatch.Frequency / 1000)) * 1000 / (Stopwatch.Frequency / 1000 + 1));
        }

        /// <summary>Microseconds since the UNIX epoch, from the high-resolution clock.</summary>
        public static ulong NowUsPrecise()
        {
            return (ulong)((DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 10000L)
                + (Stopwatch.GetTimestamp() % (Stopwatch.Frequency / 1000)) / (Stopwatch.Frequency / 1000000));
        }

        public static byte[] Build(MsgType type, MsgFlags flags, uint seq, ulong tsUs, byte[] body)
        {
            var bodyLen = body?.Length ?? 0;
            var buf = new byte[HeaderLen + bodyLen];
            BinaryPrimitives.WriteUInt16BigEndian(buf.AsSpan(0, 2), Magic);
            BinaryPrimitives.WriteUInt16BigEndian(buf.AsSpan(2, 2), Version);
            buf[4] = (byte)type;
            buf[5] = (byte)flags;
            BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(6, 4), seq);
            BinaryPrimitives.WriteUInt64BigEndian(buf.AsSpan(10, 8), tsUs);
            if (bodyLen > 0)
            {
                Buffer.BlockCopy(body, 0, buf, HeaderLen, bodyLen);
            }
            return buf;
        }

        /// <summary>
        /// Parse a datagram header. Returns false for anything malformed; the
        /// caller counts it as ipcMalformed rather than logging per datagram, so a
        /// malformed flood cannot become a logging flood.
        /// </summary>
        public static bool TryParse(byte[] data, int length, out MsgType type, out MsgFlags flags,
            out uint seq, out ulong tsUs, out int bodyOffset)
        {
            type = 0;
            flags = MsgFlags.None;
            seq = 0;
            tsUs = 0;
            bodyOffset = 0;
            if (length < HeaderLen) return false;
            if (BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(0, 2)) != Magic) return false;
            if (BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(2, 2)) != Version) return false;

            type = (MsgType)data[4];
            if (!Enum.IsDefined(typeof(MsgType), type)) return false;

            flags = (MsgFlags)data[5];
            seq = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(6, 4));
            tsUs = BinaryPrimitives.ReadUInt64BigEndian(data.AsSpan(10, 8));
            bodyOffset = HeaderLen;
            return true;
        }

        /// <summary>
        /// Split an Annex-B frame into fragments that each fit in one datagram.
        /// Splitting is unavoidable for a keyframe at native resolution; the
        /// receiver keeps exactly one in-progress frame, so this cannot
        /// reintroduce buffering.
        /// </summary>
        public static List<byte[]> FragmentFrame(ulong frameId, VideoMeta meta, MsgFlags flags, byte[] nalu)
        {
            var payloadCap = MaxDatagram - HeaderLen - FragmentHeaderLen;
            int count = (nalu == null || nalu.Length == 0)
                ? 1
                : (nalu.Length + payloadCap - 1) / payloadCap;
            if (count > ushort.MaxValue) count = ushort.MaxValue;

            var fragments = new List<byte[]>(count);
            for (int i = 0; i < count; i++)
            {
                int offset = i * payloadCap;
                int len = (nalu == null) ? 0 : Math.Min(payloadCap, Math.Max(0, nalu.Length - offset));
                var body = new byte[FragmentHeaderLen + len];
                BinaryPrimitives.WriteUInt32BigEndian(body.AsSpan(0, 4), meta.Width);
                BinaryPrimitives.WriteUInt32BigEndian(body.AsSpan(4, 4), meta.Height);
                body[8] = meta.Codec;
                body[9] = meta.Tier;
                BinaryPrimitives.WriteUInt64BigEndian(body.AsSpan(10, 8), frameId);
                BinaryPrimitives.WriteUInt16BigEndian(body.AsSpan(18, 2), (ushort)i);
                BinaryPrimitives.WriteUInt16BigEndian(body.AsSpan(20, 2), (ushort)count);
                body[22] = (byte)flags;
                if (len > 0)
                {
                    Buffer.BlockCopy(nalu, offset, body, FragmentHeaderLen, len);
                }
                fragments.Add(body);
            }
            return fragments;
        }

        /// <summary>
        /// Body of an INPUT_ACK: 8B eventId | 8B inputTs | 8B injectTs.
        /// The broker computes click-to-pixel from the input timestamp and the
        /// capture timestamp of the first frame that could show the effect.
        /// </summary>
        public static byte[] BuildInputAck(ulong eventId, ulong inputTsUs, ulong injectTsUs)
        {
            var body = new byte[24];
            BinaryPrimitives.WriteUInt64BigEndian(body.AsSpan(0, 8), eventId);
            BinaryPrimitives.WriteUInt64BigEndian(body.AsSpan(8, 8), inputTsUs);
            BinaryPrimitives.WriteUInt64BigEndian(body.AsSpan(16, 8), injectTsUs);
            return body;
        }

        /// <summary>Body of a CURSOR_POS: 4B x | 4B y | 4B screenW | 4B screenH, signed.</summary>
        public static byte[] BuildCursorPos(int x, int y, int screenW, int screenH)
        {
            var body = new byte[16];
            BinaryPrimitives.WriteInt32BigEndian(body.AsSpan(0, 4), x);
            BinaryPrimitives.WriteInt32BigEndian(body.AsSpan(4, 4), y);
            BinaryPrimitives.WriteInt32BigEndian(body.AsSpan(8, 4), screenW);
            BinaryPrimitives.WriteInt32BigEndian(body.AsSpan(12, 4), screenH);
            return body;
        }

        public static bool TryParseCursorPos(byte[] data, int length, int bodyOffset, out int x, out int y, out int screenW, out int screenH)
        {
            x = y = screenW = screenH = 0;
            if (length - bodyOffset < 16) return false;
            x = BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(bodyOffset, 4));
            y = BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(bodyOffset + 4, 4));
            screenW = BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(bodyOffset + 8, 4));
            screenH = BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(bodyOffset + 12, 4));
            return true;
        }

        /// <summary>Body of a LADDER message, JSON as encoded by the broker.</summary>
        public sealed class LadderMsg
        {
            public byte Tier { get; set; }
            public byte Quality { get; set; }
            public double Scale { get; set; } = 1.0;
            public ushort FpsCap { get; set; }
            public string Path { get; set; } = "derp";
            public double RttMs { get; set; }
        }

        public static bool TryParseLadder(byte[] data, int length, int bodyOffset, out LadderMsg msg)
        {
            msg = null;
            try
            {
                var json = Encoding.UTF8.GetString(data, bodyOffset, length - bodyOffset);
                msg = JsonSerializer.Deserialize<LadderMsg>(json, JsonOpts);
                return msg != null;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        public sealed class KeyframeReqMsg
        {
            public string Reason { get; set; } = "";
            public ulong FrameId { get; set; }
        }

        public static bool TryParseKeyframeReq(byte[] data, int length, int bodyOffset, out KeyframeReqMsg msg)
        {
            msg = null;
            try
            {
                var json = Encoding.UTF8.GetString(data, bodyOffset, length - bodyOffset);
                msg = JsonSerializer.Deserialize<KeyframeReqMsg>(json, JsonOpts);
                return msg != null;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        /// <summary>
        /// Body of an INPUT_EVENT: 1B kind tag | 8B eventId | 8B inputTs | JSON
        /// event. The kind tag maps back to the legacy NDJSON `t` value so the
        /// primary and fallback input paths stay interchangeable.
        /// </summary>
        public sealed class InputEvent
        {
            public string Kind { get; set; } = "";
            public ulong EventId { get; set; }
            public ulong InputTsUs { get; set; }
            public JsonElement Event { get; set; }
        }

        public static bool TryParseInputEvent(byte[] data, int length, int bodyOffset, out InputEvent ev)
        {
            ev = null;
            if (length - bodyOffset < 17) return false;
            var kind = KindFromTag(data[bodyOffset]);
            if (kind == null) return false;
            var eventId = BinaryPrimitives.ReadUInt64BigEndian(data.AsSpan(bodyOffset + 1, 8));
            var inputTs = BinaryPrimitives.ReadUInt64BigEndian(data.AsSpan(bodyOffset + 9, 8));
            try
            {
                var json = Encoding.UTF8.GetString(data, bodyOffset + 17, length - bodyOffset - 17);
                using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
                ev = new InputEvent
                {
                    Kind = kind,
                    EventId = eventId,
                    InputTsUs = inputTs,
                    Event = doc.RootElement.Clone(),
                };
                return true;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        public static string KindFromTag(byte tag)
        {
            switch (tag)
            {
                case KindMove: return "m";
                case KindWheel: return "w";
                case KindKey: return "k";
                case KindKeyDown: return "kd";
                case KindKeyUp: return "ku";
                case KindLeftDown: return "ld";
                case KindLeftUp: return "lu";
                case KindRightDown: return "rd";
                case KindRightUp: return "ru";
                default: return null;
            }
        }

        internal static readonly JsonSerializerOptions JsonOpts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };
    }

    internal enum ReceivedKind
    {
        HelloAck,
        Ladder,
        KeyframeReq,
        Input,
    }

    /// <summary>One message pulled off the IPC inbox.</summary>
    internal sealed class ReceivedMsg
    {
        public ReceivedKind Kind;
        public Ipc.LadderMsg Ladder;
        public Ipc.KeyframeReqMsg Keyframe;
        public Ipc.InputEvent Input;
    }

    /// <summary>
    /// Nearest-rank percentile ring. Identical semantics to <c>Ring</c> in
    /// ipc.rs, so the two sides cannot disagree about what p95 means.
    /// </summary>
    internal sealed class Ring
    {
        private readonly double[] _values;
        private int _next;
        private int _len;

        public Ring(int capacity)
        {
            _values = new double[Math.Max(1, capacity)];
        }

        public int Count => _len;
        public bool IsEmpty => _len == 0;

        public void Add(double x)
        {
            _values[_next] = x;
            _next = (_next + 1) % _values.Length;
            if (_len < _values.Length) _len++;
        }

        public double Percentile(double p)
        {
            if (_len == 0) return 0.0;
            var copy = new double[_len];
            Array.Copy(_values, copy, _len);
            Array.Sort(copy);
            var idx = (int)Math.Max(0, Math.Ceiling(p * copy.Length) - 1);
            return copy[Math.Min(idx, copy.Length - 1)];
        }
    }

    /// <summary>
    /// Sliding-window rate meter (events per second), matching <c>RateMeter</c> in
    /// ipc.rs.
    /// </summary>
    internal sealed class RateMeter
    {
        private readonly Queue<ulong> _window = new Queue<ulong>();
        private readonly ulong _spanUs;

        public RateMeter(ulong spanUs)
        {
            _spanUs = spanUs;
        }

        public void Mark(ulong tsUs)
        {
            _window.Enqueue(tsUs);
            var cutoff = tsUs > _spanUs ? tsUs - _spanUs : 0;
            while (_window.Count > 0 && _window.Peek() < cutoff) _window.Dequeue();
        }

        public double Rate(ulong tsUs)
        {
            if (_spanUs == 0) return 0.0;
            var cutoff = tsUs > _spanUs ? tsUs - _spanUs : 0;
            int n = 0;
            foreach (var t in _window)
            {
                if (t >= cutoff) n++;
            }
            return n * 1_000_000.0 / _spanUs;
        }
    }

    /// <summary>
    /// The agent end of the IPC socket. One receive loop, one send call on the
    /// caller's thread. Never queues: the single latest frame is the only thing
    /// worth sending, so a send that would block is simply skipped.
    /// </summary>
    internal sealed class IpcEndpoint : IDisposable
    {
        private readonly UdpClient _socket;
        private readonly IPEndPoint _broker;
        private uint _seq;
        private Thread _rxThread;
        private volatile bool _running;

        public IpcEndpoint(int agentRxPort, int brokerRxPort)
        {
            _socket = new UdpClient(new IPEndPoint(IPAddress.Loopback, agentRxPort));
            _broker = new IPEndPoint(IPAddress.Loopback, brokerRxPort);
            AgentRxPort = agentRxPort;
            BrokerRxPort = brokerRxPort;
        }

        public int AgentRxPort { get; }
        public int BrokerRxPort { get; }
        public long MalformedDatagrams { get; private set; }
        public long MessagesSent { get; private set; }

        private readonly System.Collections.Concurrent.ConcurrentQueue<ReceivedMsg> _inbox
            = new System.Collections.Concurrent.ConcurrentQueue<ReceivedMsg>();

        public event Action<Ipc.LadderMsg> LadderReceived;
        public event Action<Ipc.KeyframeReqMsg> KeyframeRequested;
        public event Action<Ipc.InputEvent> InputReceived;
        public event Action HelloAcked;

        /// <summary>
        /// Pull one received control message. The PowerShell host drains this from
        /// its main loop, because a C# event firing on the receive thread is not
        /// something a PS host can safely handle inline.
        /// </summary>
        public bool TryDequeue(out ReceivedMsg msg)
        {
            return _inbox.TryDequeue(out msg);
        }

        public int InboxDepth => _inbox.Count;

        /// <summary>Monotonic, never 0: 0 is reserved for "unset" in the gap heuristics.</summary>
        private uint NextSeq()
        {
            _seq++;
            if (_seq == 0) _seq = 1;
            return _seq;
        }

        public void Start()
        {
            if (_running) return;
            _running = true;
            _rxThread = new Thread(ReceiveLoop)
            {
                IsBackground = true,
                Name = "ghrdp-ipc-rx",
            };
            _rxThread.Start();
        }

        public void Send(MsgType type, MsgFlags flags, byte[] body)
        {
            var dgram = Ipc.Build(type, flags, NextSeq(), Ipc.NowUs(), body);
            try
            {
                _socket.Send(dgram, dgram.Length, _broker);
                MessagesSent++;
            }
            catch (SocketException)
            {
                // A dropped control datagram is superseded by the next one; there
                // is no retry and no queue.
            }
            catch (ObjectDisposedException)
            {
            }
        }

        /// <summary>
        /// Send one video frame, split across as many datagrams as it needs. Called
        /// only with the newest frame, so this never represents a backlog.
        /// </summary>
        public void SendFrame(ulong frameId, VideoMeta meta, MsgFlags flags, byte[] nalu)
        {
            var fragments = Ipc.FragmentFrame(frameId, meta, flags, nalu);
            var ts = Ipc.NowUs();
            foreach (var frag in fragments)
            {
                var dgram = Ipc.Build(MsgType.VideoNalu, flags, NextSeq(), ts, frag);
                try
                {
                    _socket.Send(dgram, dgram.Length, _broker);
                    MessagesSent++;
                }
                catch (SocketException)
                {
                    // Stop mid-frame: a half-delivered frame is discarded by the
                    // receiver when the next frame starts, and the next frame is
                    // the one that matters.
                    return;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
            }
        }

        private void ReceiveLoop()
        {
            var remote = new IPEndPoint(IPAddress.Any, 0);
            while (_running)
            {
                try
                {
                    var data = _socket.Receive(ref remote);
                    Dispatch(data);
                }
                catch (SocketException)
                {
                    if (_running) Thread.Sleep(50);
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
            }
        }

        private void Dispatch(byte[] data)
        {
            if (!Ipc.TryParse(data, data.Length, out var type, out var flags, out var seq, out var tsUs, out var bodyOffset))
            {
                MalformedDatagrams++;
                return;
            }

            switch (type)
            {
                case MsgType.HelloAck:
                    _inbox.Enqueue(new ReceivedMsg { Kind = ReceivedKind.HelloAck });
                    HelloAcked?.Invoke();
                    break;
                case MsgType.Ladder:
                    if (Ipc.TryParseLadder(data, data.Length, bodyOffset, out var ladder))
                    {
                        _inbox.Enqueue(new ReceivedMsg { Kind = ReceivedKind.Ladder, Ladder = ladder });
                        LadderReceived?.Invoke(ladder);
                    }
                    break;
                case MsgType.KeyframeReq:
                    if (Ipc.TryParseKeyframeReq(data, data.Length, bodyOffset, out var req))
                    {
                        _inbox.Enqueue(new ReceivedMsg { Kind = ReceivedKind.KeyframeReq, Keyframe = req });
                        KeyframeRequested?.Invoke(req);
                    }
                    break;
                case MsgType.InputEvent:
                    if (Ipc.TryParseInputEvent(data, data.Length, bodyOffset, out var ev))
                    {
                        _inbox.Enqueue(new ReceivedMsg { Kind = ReceivedKind.Input, Input = ev });
                        InputReceived?.Invoke(ev);
                    }
                    break;
                default:
                    // Cursor messages are broker -> transport, not agent -> broker;
                    // anything else here is unexpected but not fatal.
                    break;
            }
        }

        public void Stop()
        {
            _running = false;
            try
            {
                _socket.Close();
            }
            catch (SocketException)
            {
            }
        }

        public void Dispose()
        {
            Stop();
            _socket.Dispose();
        }
    }
}
