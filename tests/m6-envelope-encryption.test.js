// [M6] Per-run key leak fix — envelope encryption (Option C).
// Verifies the RSA-OAEP envelope flow: server publishes public key, client wraps
// ephemeral AES key with it, server unwraps with private key. The raw AES key
// NEVER travels in the request body — only the RSA-wrapped envelope does.
//
// Mutation targets:
//   M6-1  remove RSA key generation from server        → server test
//   M6-2  remove envelopePublicKey from /api/config    → server test
//   M6-3  remove RSA-OAEP unwrap in /api/fetch         → server test
//   M6-4  make envelope unwrap AFTER keyB64 fallback   → server test (order pin)
//   M6-5  remove RSA-OAEP from client wrap             → client test
//   M6-6  remove credEnvelope from FetchStartRequest    → client test
//   M6-7  remove envelopePublicKey fetch from f46.ts   → client test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SERVER = readFileSync(new URL("../payloads/ghrdp-server.ps1", import.meta.url), "utf8");
const F46 = readFileSync(new URL("../src/lib/f46.ts", import.meta.url), "utf8");
const FETCH_TYPES = readFileSync(new URL("../src/api/fetch/index.ts", import.meta.url), "utf8");
const MODAL = readFileSync(new URL("../src/pages/search/v2/OwnCredentialModal.tsx", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// M6-1: server generates RSA-2048 keypair at startup
// ---------------------------------------------------------------------------
test("M6-1: the server generates an RSA-2048 keypair at startup", () => {
  assert.ok(
    SERVER.includes("[System.Security.Cryptography.RSA]::Create(2048)"),
    "RSA-2048 key generation not found in ghrdp-server.ps1"
  );
  assert.ok(
    SERVER.includes("ExportSubjectPublicKeyInfo"),
    "server does not export the public key (SPKI)"
  );
  assert.ok(
    SERVER.includes("$script:EnvelopeRsa"),
    "server does not store the RSA object in script scope"
  );
  assert.ok(
    SERVER.includes("$script:EnvelopePublicKeyB64"),
    "server does not store the public key base64"
  );
});

// ---------------------------------------------------------------------------
// M6-2: /api/config publishes the public key as envelopePublicKey
// ---------------------------------------------------------------------------
test("M6-2: /api/config attaches envelopePublicKey to the response", () => {
  // Find the /api/config handler block
  const configIdx = SERVER.indexOf("if ($path -eq '/api/config')");
  assert.ok(configIdx > -1, "/api/config handler not found");
  const configBlock = SERVER.slice(configIdx, configIdx + 4000);
  assert.ok(
    configBlock.includes("'envelopePublicKey'"),
    "envelopePublicKey field not attached to /api/config response"
  );
  assert.ok(
    configBlock.includes("$script:EnvelopePublicKeyB64"),
    "envelopePublicKey does not use the script-scoped public key"
  );
});

// ---------------------------------------------------------------------------
// M6-3: /api/fetch unwraps credEnvelope with RSA-OAEP before fallback
// ---------------------------------------------------------------------------
test("M6-3: /api/fetch unwraps credEnvelope with RSA-OAEP SHA-256", () => {
  const fetchIdx = SERVER.indexOf("if ($path -eq '/api/fetch'");
  assert.ok(fetchIdx > -1, "/api/fetch handler not found");
  // The /api/fetch handler is large (~27k chars to the cred section); search the full server.
  assert.ok(
    SERVER.includes("$bodyJson.credEnvelope"),
    "server does not read credEnvelope from the request body"
  );
  assert.ok(
    SERVER.includes("RSAEncryptionPadding]::OaepSHA256"),
    "server does not use RSA-OAEP with SHA-256 for unwrapping"
  );
  assert.ok(
    SERVER.includes("$script:EnvelopeRsa.Decrypt"),
    "server does not decrypt the envelope with the RSA private key"
  );
});

// ---------------------------------------------------------------------------
// M6-4: envelope unwrap happens BEFORE the keyB64 fallback (order pin)
// ---------------------------------------------------------------------------
test("M6-4: envelope unwrap is attempted BEFORE credKeyB64 fallback", () => {
  // The envelope unwrap and keyB64 fallback are in the /api/fetch handler.
  // Search the full server for the order relationship.
  const envBlock = SERVER.indexOf("$credEnvelope -and $script:EnvelopeRsa");
  const keyB64Comment = SERVER.indexOf("If keyB64 supplied");
  assert.ok(envBlock > -1, "envelope unwrap block not found");
  assert.ok(keyB64Comment > -1, "keyB64 fallback comment not found");
  assert.ok(envBlock < keyB64Comment, "envelope unwrap must happen BEFORE keyB64 fallback (order pin)");
});

// ---------------------------------------------------------------------------
// M6-5: client uses RSA-OAEP to wrap the ephemeral key
// ---------------------------------------------------------------------------
test("M6-5: client wraps the ephemeral AES key with RSA-OAEP", () => {
  assert.ok(
    F46.includes("RSA-OAEP"),
    "client does not use RSA-OAEP for key wrapping"
  );
  assert.ok(
    F46.includes("'SHA-256'"),
    "client does not specify SHA-256 hash for RSA-OAEP"
  );
  assert.ok(
    F46.includes("wrapKeyWithRsaOaep"),
    "wrapKeyWithRsaOaep function not found in f46.ts"
  );
  assert.ok(
    F46.includes("crypto.subtle.importKey") && F46.includes("'spki'"),
    "client does not import the server's public key in SPKI format"
  );
});

// ---------------------------------------------------------------------------
// M6-6: FetchStartRequest includes credEnvelope field
// ---------------------------------------------------------------------------
test("M6-6: FetchStartRequest type includes credEnvelope", () => {
  assert.ok(
    FETCH_TYPES.includes("credEnvelope"),
    "credEnvelope field not found in FetchStartRequest"
  );
  assert.match(
    FETCH_TYPES,
    /credEnvelope\?.*string/,
    "credEnvelope must be an optional string field"
  );
});

// ---------------------------------------------------------------------------
// M6-7: client fetches envelopePublicKey from /api/config
// ---------------------------------------------------------------------------
test("M6-7: client fetches envelopePublicKey from /api/config", () => {
  assert.ok(
    F46.includes("fetchEnvelopePublicKey"),
    "fetchEnvelopePublicKey function not found in f46.ts"
  );
  assert.ok(
    F46.includes("envelopePublicKey"),
    "client does not look for envelopePublicKey in /api/config response"
  );
});

// ---------------------------------------------------------------------------
// M6-8: OwnCredentialModal sends credEnvelope in the POST body
// ---------------------------------------------------------------------------
test("M6-8: OwnCredentialModal sends credEnvelope in the POST body", () => {
  assert.ok(
    MODAL.includes("credEnvelope"),
    "credEnvelope not sent by OwnCredentialModal"
  );
  assert.ok(
    MODAL.includes("enc.envelope"),
    "modal does not read envelope from encryptOwnCreds result"
  );
});

// ---------------------------------------------------------------------------
// M6-9: when envelope is available, keyB64 is empty (the leak is fixed)
// ---------------------------------------------------------------------------
test("M6-9: when envelope path is taken, keyB64 is empty string", () => {
  // The envelope path returns { userEnc, passEnc, keyB64: '', envelope }
  assert.ok(
    F46.includes("keyB64: ''"),
    "envelope path does not set keyB64 to empty string"
  );
  // Verify the comment documents this
  assert.ok(
    F46.includes("the leak is fixed"),
    "envelope path does not document that the leak is fixed"
  );
});

// ---------------------------------------------------------------------------
// M6-10: fallback path exists for servers without envelopePublicKey
// ---------------------------------------------------------------------------
test("M6-10: legacy fallback path exists when server has no envelopePublicKey", () => {
  assert.ok(
    F46.includes("Legacy fallback"),
    "legacy fallback comment not found"
  );
  assert.ok(
    F46.includes("return null"),
    "fetchEnvelopePublicKey does not return null when key is absent"
  );
});
