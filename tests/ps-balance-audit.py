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


def main():
    repo = Path(__file__).resolve().parent.parent
    targets = [
        'payloads/ghrdp-fx.ps1',
        'tests/f45-fx-server.ps1',
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
    print('ps-balance-audit: %d surface(s) failed' % failed)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
