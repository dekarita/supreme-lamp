"""Structural sanity audit for PowerShell surfaces this repo ships.

There is no PowerShell interpreter in the agent environment (the Windows lane is
CI-only), so a brace/paren/here-string imbalance in an edited .ps1 - or in a
workflow-embedded PowerShell block - would only surface as a red lab run. This
audit tokenizes the script the way the PowerShell parser roughly does (single and
double quoted strings, @' '@ / @" "@ here-strings, # comments, backtick escapes)
and fails closed on:

  * unbalanced {} () [] at end of file
  * a here-string that is never terminated
  * 'catch' / 'finally' not preceded by a closed block (the exact shape a
    mis-nested try/foreach produces)

Run: python3 tests/ps-balance-audit.py

[F45 S4 §1.8] The same run also audits the Explorer server region for the two
things that are invisible without PowerShell: a credential that reaches a log,
a body or a stored file, and a response that leaves the region without the
security headers it promises. The executed proof is tests/f45-s4-fx-server.ps1
(Windows lane, CI-only); this is the check that runs on EVERY push.
"""
from pathlib import Path
import re
import sys


def strip_and_count(text):
    """Return (braces, parens, brackets, keywords) after removing string/comment
    content. Keywords are collected with their preceding non-space character so
    a 'catch' that does not follow '}' can be named."""
    depth = {'{': 0, '(': 0, '[': 0}
    pairs = {'}': '{', ')': '(', ']': '['}
    events = []          # (kind, line)
    i = 0
    line = 1
    n = len(text)
    last_sig = ''        # last significant character emitted
    while i < n:
        c = text[i]
        if c == '\n':
            line += 1
            i += 1
            continue
        # here-strings
        if c == '@' and i + 1 < n and text[i + 1] in ('"', "'") and (i + 2 >= n or text[i + 2] == '\n'):
            quote = text[i + 1]
            end = text.find("\n" + quote + '@', i)
            if end < 0:
                events.append(('unterminated-here-string', line))
                break
            line += text.count('\n', i, end + len(quote) + 2)
            i = end + len(quote) + 2
            last_sig = '@'
            continue
        if c == "'":
            j = i + 1
            while j < n:
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        j += 2
                        continue
                    break
                if text[j] == '\n':
                    line += 1
                j += 1
            if j >= n:
                events.append(('unterminated-single-quote', line))
                break
            i = j + 1
            last_sig = "'"
            continue
        if c == '"':
            j = i + 1
            while j < n:
                if text[j] == '`':
                    j += 2
                    continue
                if text[j] == '"':
                    break
                if text[j] == '\n':
                    line += 1
                j += 1
            if j >= n:
                events.append(('unterminated-double-quote', line))
                break
            i = j + 1
            last_sig = '"'
            continue
        if c == '#':
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        if c == '`':
            i += 2
            continue
        if c in depth:
            depth[c] += 1
            events.append(('open' + c, line))
            last_sig = c
            i += 1
            continue
        if c in pairs:
            depth[pairs[c]] -= 1
            events.append(('close' + c, line))
            if depth[pairs[c]] < 0:
                events.append(('negative-depth:' + c, line))
            last_sig = c
            i += 1
            continue
        if c.isspace():
            i += 1
            continue
        # keyword tracking (catch/finally must follow a closed block)
        m = re.match(r'(catch|finally|elseif|else)\b', text[i:])
        if m:
            kw = m.group(1)
            if kw in ('catch', 'finally') and last_sig not in ('}',):
                events.append(('dangling-' + kw, line))
            if kw in ('else', 'elseif') and last_sig not in ('}',):
                events.append(('dangling-' + kw, line))
            last_sig = kw
            i += len(kw)
            continue
        last_sig = c
        i += 1
    return depth, events


def audit(name, text):
    depth, events = strip_and_count(text)
    problems = []
    for k, v in depth.items():
        if v != 0:
            problems.append('%s imbalance %+d' % (k, v))
    for kind, line in events:
        if kind.startswith('open') or kind.startswith('close'):
            continue
        problems.append('%s @ line %d' % (kind, line))
    return problems


def workflow_blocks(path, shells=('pwsh', 'powershell')):
    """Yield (label, text) for every PowerShell run block in a workflow."""
    text = Path(path).read_text()
    lines = text.split('\n')
    out = []
    i = 0
    while i < len(lines):
        m = re.match(r'^(\s*)-\s+name:\s+(.*)$', lines[i])
        if m:
            name = m.group(2).strip().strip('"')
            indent = len(m.group(1))
            j = i + 1
            shell = None
            run_start = None
            while j < len(lines):
                cur = lines[j]
                if cur.strip() and (len(cur) - len(cur.lstrip())) <= indent and cur.lstrip().startswith('- '):
                    break
                sm = re.match(r'^\s*shell:\s*(\S+)', cur)
                if sm:
                    shell = sm.group(1)
                rm = re.match(r'^(\s*)run:\s*\|\s*$', cur)
                if rm:
                    run_start = j + 1
                    run_indent = len(rm.group(1)) + 2
                    break
                j += 1
            if run_start is not None and shell in shells:
                body = []
                k = run_start
                while k < len(lines):
                    cur = lines[k]
                    if cur.strip() and (len(cur) - len(cur.lstrip())) < run_indent:
                        break
                    body.append(cur[run_indent:] if len(cur) >= run_indent else cur.lstrip())
                    k += 1
                out.append(('%s :: %s' % (Path(path).name, name), '\n'.join(body)))
                i = k
                continue
        i += 1
    return out


# --- [F45 S4 §1.8] credential redaction + Explorer route discipline ----------

FX_BEGIN = '# [F45 S4 fx-core-begin]'
FX_END = '# [F45 S4 fx-core-end]'
FX_ROUTES = ['/api/fx/list', '/api/fx/meta', '/api/fx/gofile/status',
             '/api/fx/preview', '/api/fx/op', '/api/fx/upload']
# A sink that is not the redacting log writer or the atomic JSON writer.
FX_SINKS = re.compile(r'\b(Write-Host|Add-Content|AppendAllText|WriteAllText|Write-Output)\b')
# Variables whose VALUE may never be interpolated into a log line or a body.
FX_SECRET_VAR = re.compile(r'\$(?:script:)?[A-Za-z_]*(?:Token|Secret|Password|Credential)[A-Za-z_]*')


def fx_core(repo):
    text = (repo / 'payloads/ghrdp-server.ps1').read_text()
    at = text.find(FX_BEGIN)
    end = text.find(FX_END, at)
    if at < 0 or end < 0:
        return None, text
    return text[at:end], text


def fx_region_checks(core):
    """Return a list of failed check labels for the Explorer core region."""
    fails = []
    for route in FX_ROUTES:
        if "'%s'" % route not in core:
            fails.append('route %s is not declared' % route)
    if 'Access-Control-Allow-Origin' in core:
        fails.append('an Explorer answer could carry wildcard CORS')
    code_lines = [l for l in core.split('\n') if not l.lstrip().startswith('#')]
    if any('Send-ClientResponse' in l for l in code_lines):
        fails.append('the Explorer region calls the parent response writer')
    # [§1.8] every sink inside the region must be one of the two sanctioned
    # writers, and every log line must pass through the redactor
    lines = core.split('\n')
    in_legal = 0
    for i, line in enumerate(lines):
        if line.startswith('function '):
            in_legal = 1 if fn_name(line) in ('Write-FxLog', 'Save-FxJsonAtomic') else 0
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if FX_SINKS.search(line) and not in_legal:
            fails.append('unfiltered sink at core line %d' % (i + 1))
    if len(re.findall(r'Write-FxLog\s*\(', core)) < 5:
        fails.append('the region does not log through Write-FxLog')
    if '***REDACTED***' not in core:
        fails.append('the redaction marker is missing')
    log_fn = function_body(core, 'Write-FxLog')
    if 'Protect-FxText' not in log_fn:
        fails.append('Write-FxLog does not redact')
    red_fn = function_body(core, 'Protect-FxText')
    if '[regex]::Replace' not in red_fn:
        fails.append('Protect-FxText only redacts known values, not credential shapes')
    if 'FxGofileToken' not in red_fn:
        fails.append('Protect-FxText does not always know the configured host token')
    # a credential variable may never be interpolated into a response body
    for call in re.finditer(r'ConvertTo-FxJsonBytes\s*\(([^)]*)\)', core):
        if FX_SECRET_VAR.search(call.group(1)):
            fails.append('a response body interpolates a credential: %s' % call.group(1).strip()[:60])
    # ... nor may a tokenised URL be logged
    for i, line in enumerate(lines):
        if line.lstrip().startswith('#'):
            continue
        if 'Write-FxLog' in line and re.search(r'\$url\b', line, re.I):
            fails.append('a request URL is logged at core line %d' % (i + 1))
    # no credential may be stored in a file the Explorer serves back
    for fn in ('Save-FxJsonAtomic', 'Set-FxIndexDoc', 'Set-FxUploadQueue'):
        body = function_body(core, fn)
        if FX_SECRET_VAR.search(body) and 'Protect-FxText' not in body:
            fails.append('%s writes a credential without redaction' % fn)
    # §1.9 / §5.1(5): atomic write + schema v2 + gofileHosts on every index write
    set_index = function_body(core, 'Set-FxIndexDoc')
    if not re.search(r"Set-FxMember[^\n]*'gofileHosts'", set_index):
        fails.append('Set-FxIndexDoc does not force gofileHosts')
    if not re.search(r"Set-FxMember[^\n]*'schemaVersion'", set_index):
        fails.append('Set-FxIndexDoc does not force schemaVersion')
    atomic = function_body(core, 'Save-FxJsonAtomic')
    if '.tmp' not in atomic or ('::Replace' not in atomic and '::Move' not in atomic):
        fails.append('Save-FxJsonAtomic is not a temp file + rename')
    # §1.4: Range plumbing
    for needle in ('Accept-Ranges: bytes', 'Content-Range', 'bytes */'):
        if needle not in core:
            fails.append('preview Range plumbing is missing %s' % needle)
    # §1.7: sandbox isolation headers
    for needle in ('Origin-Agent-Cluster: ?1', 'Cross-Origin-Resource-Policy: same-site',
                   'SameSite=Strict', 'Path=/preview-sandbox'):
        if needle not in core:
            fails.append('sandbox isolation header is missing %s' % needle)
    if "default-src 'none'" not in core or "sandbox allow-scripts" not in core:
        fails.append('the sandbox CSP is not deny-by-default')
    # §1.6: the queue lives under %TEMP% and is written atomically
    if 'fx-upload-queue.json' not in core or 'GetTempPath()' not in core:
        fails.append('the upload queue path is not %TEMP%\ghrdp')
    # no dispatch, no destructive delete, no mirror-index write
    if 'gh workflow run' in core or 'workflow_dispatch' in core:
        fails.append('the server region dispatches workflows')
    if re.search(r'Remove-Item[^\n]*fx-index\.json', core):
        fails.append('the region can delete its own index')
    return fails


def fn_name(line):
    return line[len('function '):].split('(')[0].strip().rstrip('{').strip()


def function_body(core, name):
    """The body of one function with EVERY comment line removed: a check must
    never be satisfied by prose (the region documents what it does)."""
    at = core.find('function %s' % name)
    if at < 0:
        return ''
    rest = core[at + 1:]
    nxt = re.search(r'\nfunction ', rest)
    body = core[at:] if not nxt else core[at:at + 1 + nxt.start()]
    return '\n'.join(l for l in body.split('\n') if not l.lstrip().startswith('#'))


def credential_literals(repo):
    """No shipped surface may contain a gofile-shaped token literal."""
    pattern = re.compile(r'\bgo_[A-Za-z0-9_-]{20,}\b')
    hits = []
    for path in list((repo / 'payloads').glob('*.ps1')) + list((repo / 'payloads').glob('*.html')):
        hits += ['%s: %s' % (path.name, m.group(0)[:12]) for m in pattern.finditer(path.read_text())]
    for wf in (repo / '.github' / 'workflows').glob('*.yml'):
        hits += ['%s: %s' % (wf.name, m.group(0)[:12]) for m in pattern.finditer(wf.read_text())]
    return hits


def main():
    repo = Path(__file__).resolve().parent.parent
    targets = [
        'payloads/rdp-telescope.ps1',
        'payloads/ghrdp-server.ps1',
        'payloads/Grant-RdpKeyAccess.ps1',
        'payloads/Test-RdpListenerHandshake.ps1',
        'payloads/Enable-RdpTlsCertificate.ps1',
        'payloads/ghrdp-lib.ps1',
    ]
    failed = 0
    for t in targets:
        p = repo / t
        if not p.exists():
            continue
        problems = audit(t, p.read_text())
        print(('FAIL ' if problems else 'PASS ') + t + ((' :: ' + '; '.join(problems[:6])) if problems else ''))
        failed += bool(problems)
    for wf in ['.github/workflows/autologin-lab.yml', '.github/workflows/main.yml',
               '.github/workflows/launch-gates.yml']:
        for label, body in workflow_blocks(repo / wf):
            problems = audit(label, body)
            if problems:
                print('FAIL ' + label + ' :: ' + '; '.join(problems[:6]))
                failed += 1
    # [F45 S4 §1.8] Explorer region: routes, redaction, atomic writes, headers
    core, _ = fx_core(repo)
    if core is None:
        print('FAIL payloads/ghrdp-server.ps1 :: the F45 S4 fx-core markers are missing')
        failed += 1
    else:
        problems = fx_region_checks(core)
        print(('FAIL ' if problems else 'PASS ') + 'Explorer server region (F45 S4)'
              + ((' :: ' + '; '.join(problems[:8])) if problems else ''))
        failed += bool(problems)
    hits = credential_literals(repo)
    print(('FAIL ' if hits else 'PASS ') + 'no gofile-token literal in a shipped surface'
          + ((' :: ' + '; '.join(hits[:4])) if hits else ''))
    failed += bool(hits)
    print('ps-balance-audit: %d surface(s) failed' % failed)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
