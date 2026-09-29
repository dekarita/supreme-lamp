// [F50] MIRROR LARGE-FILE STREAMING gates (offline) - operator directive §0-§4.
//
// Ground truth (the reported symptom): the watcher logged
//   phase=http status=- msg=upload failed: Exception calling "Write" with "3"
//   argument(s): "Stream was too long."
// on a multi-GB mirror file. ROOT CAUSE: `Send-F46GofileUpload` copied the file
// through a 64 KiB FileStream loop into `HttpWebRequest.GetRequestStream()`
// with the .NET default `AllowWriteStreamBuffering = true`, so the WHOLE
// multipart body was assembled in a MemoryStream before the first byte reached
// the socket - and a MemoryStream cannot pass Int32.MaxValue (2 GiB). The
// second 2 GiB wall was `Invoke-F46EncryptFile` (ReadAllBytes + a whole-file
// byte[] + a List[byte] container).
//
// FIX PINNED HERE (the executable proof is tests/f50-mirror-largefile.ps1 in the
// windows-native lane): HttpClient + MultipartFormDataContent +
// StreamContent(FileStream) for the upload, chunked FileStream -> CryptoStream
// -> FileStream for AES-256, a size-aware timeout floor (HttpClient.Timeout
// covers the whole request, so 120s would kill every multi-GB upload), and the
// F44 attempt policy preserved byte-for-byte: fail-fast 401/403/413/415 = ONE
// attempt, only dns/tcp/tls/http retried (5), jittered backoff, Retry-After as
// a FLOOR capped at 120s, preflight size/type refusing with ZERO network tries.
// [F48/F49] the mirror stays token-less guest and default-OFF: no credential
// anywhere in this file's targets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const region = (text, startMarker, endMarker) => {
  const a = text.indexOf(startMarker);
  assert.ok(a >= 0, `marker not found: ${startMarker}`);
  const b = endMarker ? text.indexOf(endMarker, a) : text.length;
  assert.ok(b > a, `marker not found after start: ${endMarker}`);
  return text.slice(a, b);
};
// A PowerShell function body, from `function Name {` to the next top-level `}`.
const psFunction = (text, name) => {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(`function ${name} {`)) { start = i; break; }
  }
  assert.ok(start >= 0, `function ${name} is missing`);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`function ${name} is never closed at column 0`);
};
const num = (text, name) => {
  const m = code(text).match(new RegExp(`\\$script:${name}\\s*=\\s*(-?\\d+)`));
  assert.ok(m, `$script:${name} must be a literal number`);
  return Number(m[1]);
};

const mirrorPath = "payloads/ghrdp-mirror.ps1";
const labPath = "tests/f50-mirror-largefile.ps1";
const gatesPath = ".github/workflows/launch-gates.yml";
const docsPath = "docs/MIRROR-HOSTS.md";
assert.ok(existsSync(mirrorPath), "the mirror module must exist");
assert.ok(existsSync(labPath), "the F50 lab must exist");

const modulePs = read(mirrorPath);
const moduleCode = code(modulePs);
const watcher = read("payloads/ghrdp-watcher.ps1");
const fx = read("payloads/ghrdp-fx.ps1");
const gates = read(gatesPath);
const lab = read(labPath);
const docs = read(docsPath);

const uploadFn = psFunction(modulePs, "Send-F46GofileUpload");
const clientFn = psFunction(modulePs, "New-F50HttpClient");
const assemblyFn = psFunction(modulePs, "Add-F50HttpAssembly");
const uploadCode = code(uploadFn);
const encryptFn = psFunction(modulePs, "Invoke-F46EncryptFile");
const decryptFn = psFunction(modulePs, "Invoke-F46DecryptFile");
const specFn = psFunction(modulePs, "New-F46UploadRequestSpec");
const timeoutFn = psFunction(modulePs, "Get-F50UploadTimeoutSec");
const phaseFn = psFunction(modulePs, "Get-F50TransportPhase");

// --- policy constants, read from the file so the arithmetic below is real ----
const STREAM_BUF = num(modulePs, "F50StreamBufferBytes");
const GCM_ONE_SHOT_MAX = num(modulePs, "F50GcmOneShotMaxBytes");
const GCM_DECRYPT_MAX = num(modulePs, "F50GcmDecryptMaxBytes");
const BYTES_PER_SEC_FLOOR = num(modulePs, "F50UploadBytesPerSecFloor");
const TIMEOUT_CAP = num(modulePs, "F50UploadTimeoutCapSec");

test("F50-1 the buffering transport is retired from the mirror module", () => {
  assert.ok(!/\[System\.Net\.WebRequest\]::Create/.test(moduleCode), "no HttpWebRequest may be constructed in code lines");
  assert.ok(!/AllowWriteStreamBuffering/.test(moduleCode), "AllowWriteStreamBuffering (the 2 GiB MemoryStream buffer) must not appear in code lines");
  assert.ok(!/GetRequestStream/.test(moduleCode), "the retired request-stream API must be gone from code lines");
  assert.ok(!/Invoke-WebRequest|Invoke-RestMethod/.test(moduleCode), "the upload must not fall back to a cmdlet that buffers");
  assert.match(modulePs, /HttpWebRequest\.GetRequestStream\(\)/, "the root cause must be documented in the header so it cannot be re-introduced silently");
  assert.match(modulePs, /Stream was too long/, "the reported symptom must be documented verbatim");
});

test("F50-2 the upload is HttpClient + MultipartFormDataContent + StreamContent(FileStream)", () => {
  assert.match(clientFn, /New-Object System\.Net\.Http\.HttpClient\(\$handler\)/, "the shared client factory must construct an HttpClient");
  assert.match(uploadCode, /New-F50HttpClient -TimeoutSec/, "the uploader must use the shared HttpClient factory");
  assert.match(uploadCode, /System\.Net\.Http\.MultipartFormDataContent/, "the body must be MultipartFormDataContent");
  assert.match(uploadCode, /New-Object System\.Net\.Http\.StreamContent\(\$fs, \[int\]\$script:F50StreamBufferBytes\)/, "the file part must be a StreamContent over the FileStream with the shared buffer size");
  assert.match(uploadCode, /\[System\.IO\.File\]::Open\(\$Path, \[System\.IO\.FileMode\]::Open, \[System\.IO\.FileAccess\]::Read, \[System\.IO\.FileShare\]::ReadWrite\)/, "the source must be opened as a read FileStream (share-read/write, as the watcher needs)");
  assert.match(uploadCode, /System\.Net\.Http\.HttpRequestMessage\(\[System\.Net\.Http\.HttpMethod\]::Post/, "the POST must be an HttpRequestMessage");
  assert.match(uploadCode, /SendAsync\(\$reqMsg\)\.GetAwaiter\(\)\.GetResult\(\)/, "the send must be awaited synchronously (the watcher is a synchronous worker)");
  assert.ok(!/ReadAllBytes/.test(uploadCode), "the uploader must never read the whole file");
  assert.ok(!/MemoryStream/.test(uploadCode), "the uploader must never build a MemoryStream");
  assert.ok(!/List\[byte\]/.test(uploadCode), "the uploader must never build a byte list");
  assert.ok(!/Get-Content/.test(uploadCode), "the uploader must never slurp the file through the pipeline");
  assert.match(uploadCode, /Add-F50HttpAssembly/, "the transport must fail visible when System.Net.Http cannot be bound");
  assert.match(assemblyFn, /never a silent downgrade/, "the no-downgrade rule must be stated where the assembly is bound");
  assert.match(uploadCode, /F50 streaming uploader cannot run/, "a runner that cannot bind System.Net.Http gets a labeled terminal reason");
});

test("F50-3 the multipart part headers are pinned, not left to the runtime", () => {
  // .NET Framework quotes name=, .NET Core does not: the contract is assembled
  // once and written verbatim, so the lab (pwsh) and the runner (5.1) put the
  // SAME bytes on the wire.
  assert.match(specFn, /name="' \+ \$fieldName \+ '"; filename="' \+ \$safeName \+ '"/, "the spec must keep the quoted name=/filename= form");
  assert.match(specFn, /partDisposition = \('form-data; name="' \+ \$fieldName \+ '"; filename="' \+ \$safeName \+ '"'\)/, "the spec must expose the exact Content-Disposition value");
  assert.match(uploadCode, /TryAddWithoutValidation\('Content-Disposition', \[string\]\$spec\.partDisposition\)/, "the part disposition must come from the spec verbatim");
  assert.match(uploadCode, /TryAddWithoutValidation\('Content-Type', \[string\]\$spec\.partContentType\)/, "the part Content-Type must come from the spec verbatim");
  assert.match(uploadCode, /New-Object System\.Net\.Http\.MultipartFormDataContent\(\[string\]\$spec\.boundary\)/, "the boundary must come from the same spec the lab asserts");
  assert.match(specFn, /multipartField/, "the field name must stay the contract constant");
  assert.match(modulePs, /multipartField = 'file'/, "the guest field name stays `file`");
});

test("F50-4 [F48/F49] the streaming transport carries no credential and no evasion", () => {
  assert.ok(!moduleCode.includes("Authorization"), "no auth header may exist toward the host (code lines)");
  assert.ok(!moduleCode.includes("X-Gofile-Token"), "no host-token header may exist (code lines)");
  assert.ok(!moduleCode.includes("Cookie"), "no session header may be set toward the host (code lines)");
  assert.ok(!/UseCookies|CookieContainer/.test(moduleCode), "no cookie container may be configured");
  assert.ok(!/\?token=|[&]token=/.test(moduleCode), "no credential may travel in a URL");
  assert.ok(!/Mozilla\/[0-9]|X-Forwarded-For|WebProxy|rotat/i.test(moduleCode), "no user-agent spoof, no forwarding header, no proxy or rotation evasion");
  assert.match(clientFn, /DefaultRequestHeaders\.Accept\.Add/, "the only default request header is Accept");
  assert.match(clientFn, /ExpectContinue = \$true/, "Expect: 100-continue lets a host refuse BEFORE a multi-GB body is pushed");
  assert.ok(!/DefaultRequestHeaders\.(Add|TryAddWithoutValidation)/.test(code(clientFn).replace(/DefaultRequestHeaders\.Accept\.Add/, "").replace(/DefaultRequestHeaders\.ExpectContinue/, "")), "no other default header may be attached");
  assert.match(modulePs, /Format-F48AuthReason/, "the labeled token-less auth refusal must stay");
  assert.match(modulePs, /authMode = 'guest'/, "the guest default must stay");
  assert.match(lab, /Headers\['Authorization'\]/, "the lab must assert the wire carries no auth header");
  assert.match(lab, /Headers\['X-Gofile-Token'\]/, "the lab must assert the wire carries no host-token header");
  assert.match(lab, /Headers\['Cookie'\]/, "the lab must assert the wire carries no session header");
});

test("F50-5 the size-aware timeout floor: a multi-GB upload is not killed by a 120s whole-request timeout", () => {
  assert.equal(BYTES_PER_SEC_FLOOR, 2097152, "the sustained-rate assumption is 2 MiB/s");
  assert.equal(TIMEOUT_CAP, 21600, "the ceiling is 6h");
  assert.match(timeoutFn, /\[Math\]::Max\(\$cfg, \$floor\)/, "the configured timeout is a FLOOR, never a cap");
  assert.match(timeoutFn, /\[Math\]::Ceiling/, "the floor must round up");
  assert.match(uploadFn, /Get-F50UploadTimeoutSec -Size \$fileLen -ConfiguredSec \$TimeoutSec/, "the uploader must apply the floor");
  // Arithmetic cross-check, computed here from the constants in the file.
  const expect = (size, configured) => {
    const floor = Math.min(TIMEOUT_CAP, Math.ceil(size / BYTES_PER_SEC_FLOOR));
    return Math.max(configured, floor);
  };
  assert.equal(expect(6442450944, 120), 3072, "6 GiB => 3072s");
  assert.equal(expect(3221225472, 120), 1536, "3 GiB => 1536s");
  assert.equal(expect(1073741824, 120), 512, "1 GiB => 512s");
  assert.equal(expect(104857600, 120), 120, "100 MiB keeps the configured 120s");
  assert.equal(expect(1099511627776, 120), 21600, "1 TiB is capped at 6h");
  assert.match(lab, /A5-timeout-floor-6gib/, "the lab must assert the 6 GiB floor");
  assert.match(lab, /A7-timeout-cap/, "the lab must assert the ceiling");
});

test("F50-6 the transport phase vocabulary is unchanged (dns/tcp/tls/http)", () => {
  assert.match(phaseFn, /phase = 'dns'/, "a name-resolution failure stays phase=dns");
  assert.match(phaseFn, /phase = 'tcp'/, "a connect failure or timeout stays phase=tcp");
  assert.match(phaseFn, /phase = 'tls'/, "a handshake failure stays phase=tls");
  assert.match(phaseFn, /phase = 'http'/, "an unclassified transport failure stays phase=http");
  assert.match(phaseFn, /TaskCanceledException/, "an HttpClient timeout surfaces as a canceled task and must be classified");
  assert.match(phaseFn, /AuthenticationException/, "a TLS failure is an AuthenticationException inside the chain");
  assert.match(phaseFn, /System\.IO\.IOException/, "an IOException handshake failure (a plain-text answer to a ClientHello) must also classify as tls");
  assert.match(phaseFn, /handshake\|sspi\|ssl\|tls/, "the tls message heuristic is pinned: it never widens the phase vocabulary");
  assert.match(phaseFn, /SocketErrorCode/, "socket errors must be classified by their code");
  assert.match(phaseFn, /InnerException/, "the inner chain must be walked (HttpClient wraps the real cause)");
  assert.match(uploadCode, /Get-F50TransportPhase -Err \$_\.Exception/, "the uploader must classify through the shared mapper");
});

test("F50-7 the F44 attempt policy is preserved byte-for-byte", () => {
  assert.match(modulePs, /\$script:F46FailFastStatuses = @\(401, 403, 413, 415\)/, "fail-fast statuses unchanged");
  assert.match(modulePs, /\$script:F46TransientPhases = @\('dns', 'tcp', 'tls', 'http'\)/, "transient phases unchanged");
  assert.match(modulePs, /\$script:F46MaxAttempts = 5/, "max attempts unchanged");
  assert.match(modulePs, /\$script:F46BackoffBaseMs = 500/, "backoff base unchanged");
  assert.match(modulePs, /\$script:F46BackoffCapMs = 8000/, "backoff cap unchanged");
  assert.match(modulePs, /\$script:F46BackoffFloorMs = 100/, "backoff floor unchanged");
  assert.match(modulePs, /\$script:F46RetryAfterCapMs = 120000/, "the Retry-After cap stays 120s");
  assert.match(modulePs, /function Get-F46BackoffMs/, "the jittered backoff function must stay");
  assert.match(modulePs, /\[Math\]::Max\(\$jittered, \$floor\)/, "Retry-After stays a FLOOR over the jittered delay");
  assert.match(modulePs, /function Test-F46UploadPreflight/, "preflight must stay");
  assert.match(modulePs, /preflight \(0 network tries\)/, "preflight refusals must still say they made zero network tries");
  assert.match(modulePs, /function Invoke-F46MirrorUploadWithPolicy/, "the policy loop must stay");
  assert.ok(!/hard\s*=\s*\$true/.test(moduleCode), "no hard-delete style escape hatch may appear");
});

test("F50-8 the AES-256 encryptor streams above the GCM one-shot cap", () => {
  assert.equal(GCM_ONE_SHOT_MAX, 1073741824, "the one-shot GCM cap is 1 GiB");
  assert.equal(STREAM_BUF, 65536, "the streaming buffer is 64 KiB");
  assert.match(encryptFn, /\$fileLen -le \[long\]\$script:F50GcmOneShotMaxBytes/, "GCM is selected by size");
  assert.match(encryptFn, /CryptoStream\(\$outFs2, \$enc, \[System\.Security\.Cryptography\.CryptoStreamMode\]::Write\)/, "the CBC path must be a CryptoStream over the output FileStream");
  assert.match(encryptFn, /while \(\(\$read = \$inFs\.Read\(\$buf, 0, \$buf\.Length\)\) -gt 0\) \{ \$cs\.Write\(\$buf, 0, \$read\) \}/, "the CBC path must copy in chunks");
  assert.match(encryptFn, /FlushFinalBlock/, "PKCS7 padding must be finalized");
  assert.match(encryptFn, /mode = 'streamed'/, "the streamed path must report its mode");
  assert.match(encryptFn, /mode = 'one-shot'/, "the one-shot path must report its mode");
  assert.match(encryptFn, /alg = 'AES-256-GCM'/, "the GCM label must stay");
  assert.match(encryptFn, /alg = 'AES-256-CBC-PBKDF2'/, "the CBC label must stay (the browser-decryptable container)");
  // The whole-file arrays may only exist inside the bounded GCM branch.
  const cbcBranch = region(encryptFn, "# [F50 §2] Streamed legacy AES-256-CBC");
  assert.ok(!/ReadAllBytes/.test(code(cbcBranch)), "the streamed branch must not read the whole file");
  assert.ok(!/List\[byte\]/.test(code(cbcBranch)), "the streamed branch must not build a byte list");
  assert.ok(!/TransformFinalBlock/.test(code(cbcBranch)), "the streamed branch must not transform one whole block");
  const gcmBranch = region(encryptFn, "$aes = New-F46AesGcm -Key $key", "# [F50 §2] Streamed legacy AES-256-CBC");
  assert.match(gcmBranch, /ReadAllBytes/, "the one-shot GCM branch is the only whole-file read left");
  assert.match(encryptFn, /bounded by the cap above/, "the bound must be stated where the array is built");
  assert.match(encryptFn, /refusing to encrypt with a weak key/, "the 32-byte key rule must stay");
  assert.match(watcher, /Invoke-F46EncryptFile -Path \(\[string\]\$f\.FullName\) -OutPath \$encPath -KeyBase64 \$mirrorKeyText/, "the watcher call site must be unchanged");
  assert.match(watcher, /\$uploadLen = \[long\]\$encRes\.bytes/, "the watcher still uploads the ciphertext length the encryptor reports");
});

test("F50-9 the AES-256 decryptor streams, and its GCM cap refuses honestly", () => {
  assert.equal(GCM_DECRYPT_MAX, 2147483646, "the decrypt cap is the array limit");
  assert.match(decryptFn, /CryptoStream\(\$inFs, \$dec, \[System\.Security\.Cryptography\.CryptoStreamMode\]::Read\)/, "the CBC path must be a CryptoStream over the input FileStream");
  assert.match(decryptFn, /CopyTo\(\$outFs, \[int\]\$script:F50StreamBufferBytes\)/, "the CBC path must copy in chunks");
  assert.match(decryptFn, /mode = 'streamed'/, "the streamed path must report its mode");
  assert.match(decryptFn, /mode = 'refused-too-large'/, "an over-cap GCM container must be refused with a labeled mode");
  assert.match(decryptFn, /\$fileLen -gt \[long\]\$script:F50GcmDecryptMaxBytes/, "the cap must be checked before any array is allocated");
  assert.match(decryptFn, /F50 one-shot decrypt cap/, "the refusal must name the cap");
  assert.match(decryptFn, /never leave a half-decrypted file behind/, "a wrong key must not leave partial plaintext");
  assert.match(decryptFn, /Remove-Item -LiteralPath \$OutPath -Force/, "the partial output must be removed on failure");
  const cbcBranch = region(decryptFn, "# [F50 §2] streamed legacy container");
  assert.ok(!/ReadAllBytes/.test(code(cbcBranch)), "the streamed decrypt must not read the whole file");
});

test("F50-10 the read-only probe and the fleet lookup ride the same streaming client", () => {
  const target = psFunction(modulePs, "Get-F46UploadTarget");
  assert.match(code(target), /Invoke-F50HttpGetString -Uri \$uri -TimeoutSec \$TimeoutSec/, "the fleet /servers lookup must use the shared client");
  const probe = psFunction(modulePs, "Invoke-F46HostProbe");
  assert.match(code(probe), /Invoke-F50HttpGetString -Uri \$serversUri -TimeoutSec \$TimeoutSec/, "the probe must use the shared client");
  assert.match(probe, /token-less guest probe refused \(authMode=requires-account\)/, "the 403/401 operator-option note must stay verbatim");
  assert.match(probe, /rate limited \(429\) at the API root - back off; the probe never changes identity/, "the 429 note must stay verbatim");
  assert.match(probe, /no content is uploaded/i, "the read-only claim must stay");
  assert.match(modulePs, /serversPath = '\/servers'/, "the probe path must stay pinned");
});

test("F50-11 the lab reproduces the root cause and proves the fix at 100 MB / 1 GB / 3 GB / 6 GB", () => {
  assert.match(lab, /A1-repro-stream-too-long/, "the reported symptom must be reproduced from first principles");
  assert.match(lab, /\$ms\.SetLength\(2147483648\)/, "the reproduction must push a MemoryStream past Int32.MaxValue (zero allocation)");
  for (const [id, size] of [["D1-upload-100mb", 104857600], ["D2-upload-1gb", 1073741824], ["D3-upload-3gb", 3221225472], ["D4-upload-6gb", 6442450944]]) {
    assert.ok(lab.includes(id), `the lab must have a cell for ${id}`);
    assert.ok(lab.includes(String(size)), `the lab must use the exact size ${size} for ${id}`);
  }
  assert.match(lab, /fsutil/, "the lab must create sparse files with fsutil");
  assert.match(lab, /sparse/, "the lab must mark the sources sparse so a 6 GiB cell fits a hosted runner");
  assert.match(lab, /C1-sparse-mechanism/, "the sparse mechanism must be proven before any cell depends on it");
  assert.match(lab, /CopyTo\(\[System\.IO\.Stream\]::Null\)|\$total = \$total \+ \$read/, "the listener must DISCARD the body while counting it");
  assert.match(lab, /PeakWorkingSet64/, "the lab must bound the uploader's peak working set");
  assert.match(lab, /C2-baseline-peak-measured/, "the memory ceiling must be measured against a baseline, not guessed");
  assert.match(lab, /127\.0\.0\.1/, "every byte must go to loopback");
  assert.ok(!/api\.gofile\.io|upload\.gofile\.io/.test(code(lab)), "the lab must never contact the real host");
});

test("F50-12 the lab covers retries, fail-fast, preflight and the streamed crypto", () => {
  for (const id of ["D5-host-413-real-socket", "D6-retry-429-real-socket", "D7-retry-500-real-socket", "D8-retry-502-then-success", "D9-auth-403-real-socket", "D10-host-415-real-socket", "E1-tls-reset", "E2-tcp-refused"]) {
    assert.ok(lab.includes(id), `the lab must have a cell for ${id}`);
  }
  assert.match(lab, /'1000,1000,1050,2050'/, "the Retry-After floor over the deterministic jitter must be asserted exactly");
  assert.match(lab, /'300,550,1050,2050'/, "the jittered backoff sequence must be asserted exactly");
  assert.match(lab, /-Rand01 0\.5/, "the jitter must be made deterministic");
  assert.match(lab, /B1-preflight-size-6gib-network0/, "a 6 GiB preflight size refusal must be a cell");
  assert.match(lab, /B2-preflight-type-3gib-network0/, "a 3 GiB preflight type refusal must be a cell");
  assert.match(lab, /networkCalls -eq 0/, "preflight refusals must prove zero network tries");
  assert.match(lab, /B3-no-hidden-2gib-cap/, "the lab must prove the fix invents no 2 GiB cap of its own");
  assert.match(lab, /F2-streamed-encrypt-above-cap/, "the streamed encryptor above the cap must be a cell");
  assert.match(lab, /F4-streamed-roundtrip-above-cap/, "the streamed round trip must be a cell");
  assert.match(lab, /SHA256/, "the round trip must be proven by a streamed hash, not by reading the files");
  assert.match(lab, /F6-wrong-key-no-plaintext/, "a wrong-key decrypt must be a cell");
  assert.match(lab, /-not \$wkRecovered/, "a wrong key must never recover the original plaintext (streamed-hash comparison, not a bare ok flag)");
  assert.match(lab, /unauthenticated CBC container/, "the lab must say why CBC can report success on a wrong key (no MAC): honest expectations, not a lucky assertion");
  assert.match(lab, /F7-gcm-cap-honest-refusal/, "the GCM decrypt cap refusal must be a cell");
  assert.match(lab, /END-OF-UNTRUNCATED-413/, "the F44 no-truncation rule must be proven on the real socket");
});

test("F50-13 every lab cell is self-describing and a failure is an annotation", () => {
  assert.match(lab, /CELL=' \+ \$Id \+ ' EXPECT=' \+ \$Expect \+ ' OBSERVED=' \+ \$obs \+ ' RESULT=' \+ \$res/, "cells must print CELL=/EXPECT=/OBSERVED=/RESULT=");
  assert.match(lab, /::error title=F50 cell /, "a failed cell must emit a named annotation (the log blob host is unreachable from the sandbox)");
  assert.match(lab, /exit 1/, "the lab must exit non-zero on any failure");
  assert.match(lab, /ALL CELLS PASS/, "the lab must print an explicit all-pass line");
  assert.match(lab, /GetContextAsync/, "listener waits must be bounded so a cell can never hang the job");
  assert.ok(!/Start-Sleep/.test(code(lab)), "the lab must not sleep on wall-clock backoff (the Sleeper is injected)");
});

test("F50-14 the lab and the module are wired into both lanes and both audits", () => {
  assert.match(gates, /tests\/f50-mirror-largefile\.ps1/, "launch-gates must reference the F50 lab");
  assert.match(gates, /tests\\f50-mirror-largefile\.ps1/, "the windows-native lane must execute the F50 lab");
  assert.match(gates, /tests\/f50-mirror-largefile\.test\.js/, "the gates job must run this suite");
  assert.match(gates, /F50/, "the F50 gate step must be named");
  const mjs = read("scripts/ps-balance-audit.mjs");
  const py = read("tests/ps-balance-audit.py");
  assert.match(mjs, /tests\/f50-mirror-largefile\.ps1/, "the node structural audit must tokenize the lab");
  assert.match(py, /tests\/f50-mirror-largefile\.ps1/, "the python structural audit must tokenize the lab");
  assert.match(gates, /scripts\/ps-balance-audit\.mjs/, "the structural audit must stay wired");
});

test("F50-15 the shipped consumers keep their exact call sites", () => {
  assert.match(watcher, /Invoke-F46MirrorAttempt -HostCfg \$mirrorHost -Path \$uploadPath -Name \$dispName -Size \$uploadLen -AttemptNo \$attemptNo/, "the watcher attempt call must be unchanged");
  assert.match(fx, /Send-F46GofileUpload -HostCfg \$hostCfg -Path \$Path -Name \$name -TimeoutSec 120/, "the Explorer uploader must keep delegating to the shared guest uploader");
  assert.match(modulePs, /function Send-F46GofileUpload \{/, "the uploader name must stay (two shipped callers depend on it)");
  assert.match(modulePs, /param\(\$HostCfg, \[string\]\$Path, \[string\]\$Name, \[int\]\$TimeoutSec = 120, \$Target = \$null, \[string\]\$ContentType = ''\)/, "the uploader signature must stay compatible");
  assert.match(modulePs, /function New-F46UploadRequestSpec \{/, "the contract assembler must stay");
  assert.match(modulePs, /function Invoke-F46EncryptFile \{/, "the encryptor must stay");
  assert.match(modulePs, /function Invoke-F46DecryptFile \{/, "the decryptor must stay");
});

test("F50-16 docs/MIRROR-HOSTS.md carries the F50 contract", () => {
  assert.match(docs, /F50/, "the docs must name the phase");
  assert.match(docs, /Stream was too long/, "the docs must record the reported symptom");
  assert.match(docs, /AllowWriteStreamBuffering/, "the docs must record the actual root cause");
  assert.match(docs, /StreamContent/, "the docs must record the streaming transport");
  assert.match(docs, /MultipartFormDataContent/, "the docs must record the multipart type");
  assert.match(docs, /3072/, "the docs must show the 6 GiB timeout-floor worked example");
  assert.match(docs, /AES-256-CBC-PBKDF2/, "the docs must record the streamed container");
  assert.match(docs, /AES-256-GCM/, "the docs must record the one-shot container and its cap");
  assert.match(docs, /1 GiB/, "the docs must state the one-shot cap");
  assert.match(docs, /sparse/i, "the docs must state how the lab proves multi-GB sizes");
  assert.match(docs, /no Authorization|token-less|guest/i, "the docs must keep the guest contract statement");
});

test("F50-17 the mirror stays default-OFF and token-less (locked gates untouched)", () => {
  assert.match(modulePs, /enabled = \$false/, "the shipped default host stays disabled");
  assert.match(modulePs, /authMode = 'guest'/, "the shipped authMode stays guest");
  assert.ok(!/mirror_enable.*true.*default|default.*mirror_enable.*true/.test(gates), "the dispatch input default must stay false");
  assert.match(watcher, /refusing to upload plaintext/, "the encrypt lock must stay");
  assert.ok(!/GOFILE[_]TOKEN/.test(read("tests/f50-mirror-largefile.ps1")), "the banished secret name must not appear in the lab");
});
