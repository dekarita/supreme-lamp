# F31 — private-key persistence and listener proof

Evidence supplied by the operator: two System/Schannel 36870 events at the
2026-09-26 19:43Z mstsc attempts, 0x8009030D/state 10001, TermService.
These establish credential private-key access failure, not its unique cause.
The starting workflow ALREADY used PersistKeySet,MachineKeySet,Exportable.
Its ACL implementation only tried RSA, looked in the CSP directory for a CNG
UniqueName, and silently skipped failures. This change fails closed instead.

.NET has no `Persistable` flag: the actual member is `PersistKeySet`.
RDP requires TPKT/X.224 negotiation before TLS. The loopback probe offers
SSL/HYBRID/HYBRID_EX, validates the negotiation response, and checks the remote
thumbprint after TLS. Its permissive validation callback is loopback-only;
it neither changes client trust nor proves CredSSP/logon/fullscreen success.
No credentials are submitted. NLA remains enabled.

The autologin-lab F31 job uses real TermService with RSA and ECDSA certificates.
Import and probe run in separate processes. It requires default-import failure
with observed 36870, persistent-machine import success, and ACL-denied failure
with observed 36870 and an SDDL dump. Default flags are provider-dependent;
if the presumed reproduction does not occur, the matrix FAILS rather than
manufacturing the requested evidence. This is a hypothesis test, not a claim
that every default import loses its key. No private material is uploaded.

Landing is blocked until that matrix is green. Local static gates are not
Windows proof. After merge: dispatch main.yml, require listener-handshake-ok,
then ask the user to click WINDOWS AUTO-LOGIN. Check 4624 type 10, usage, and
request fullscreen confirmation within 60 seconds. At most two mapped loops;
36870 -> container/ACL inspection, 36871 -> cipher investigation (mapping is a
triage hint, not unique causal proof), 12018 -> credential investigation.
Do not report PRIVATE-KEY LIVE without user confirmation.
