#!/usr/bin/env python3
"""F25 §3.2/§3.3 - config.json writer audit.

Fails when a workflow step WRITES config.json without ever READING it inside
the same step region. That is the "overwrite-style writer" pattern: it
rebuilds the file from a partial object and silently drops properties - the
exact failure class that let `rdpIp` go missing while the job stayed green
until the webdesk step threw and killed the whole run.

Usage:  python3 tests/config-writer-audit.py .github/workflows/main.yml [...]
Exit:   0 = every writer is read-modify-write of the full object
        1 = at least one overwrite-style writer, listed on stderr
"""
import re
import sys

# A step region starts at a top-level workflow step ('      - name: ' at the
# same indent GitHub Actions uses for job steps).
STEP = re.compile(r'^      - name: ')
WRITE = re.compile(r'WriteAllText|Set-Content|Out-File|Add-Content')
READ = re.compile(r'ReadAllText|Get-Content|Read-MirrorCfg|ConvertFrom-Json')


def regions(lines):
    out, cur = [], None
    for ln in lines:
        if STEP.match(ln):
            if cur:
                out.append(cur)
            cur = [ln]
        elif cur is not None:
            cur.append(ln)
    if cur:
        out.append(cur)
    return out


def audit(path):
    with open(path, encoding='utf-8') as fh:
        lines = fh.read().split('\n')
    bad = []
    for reg in regions(lines):
        body = '\n'.join(reg)
        if 'config.json' not in body:
            continue
        # Variables bound to a config.json path, e.g.
        #   $cfgPathW = 'C:\ghrdp\config.json'
        #   $cfgPath  = Join-Path $root 'config.json'
        paths = set(re.findall(r'(\$[A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^\n]*config\.json', body))

        def touches(line):
            return 'config.json' in line or any(v in line for v in paths)

        writes = [ln for ln in reg if WRITE.search(ln) and touches(ln)]
        if not writes:
            continue
        reads = [ln for ln in reg if READ.search(ln) and touches(ln)]
        if not reads:
            bad.append((path, reg[0].strip(), writes[0].strip()))
    return bad, len(regions(lines))


def main(argv):
    if len(argv) < 2:
        print('usage: config-writer-audit.py <workflow.yml> [...]', file=sys.stderr)
        return 2
    total_bad, total_regions = [], 0
    for path in argv[1:]:
        bad, n = audit(path)
        total_regions += n
        total_bad += bad
    if total_bad:
        for path, step, line in total_bad:
            print('OVERWRITE-STYLE config.json writer: %s :: %s' % (path, step),
                  file=sys.stderr)
            print('    first write: %s' % line, file=sys.stderr)
        return 1
    print('config.json writer audit: %d step regions scanned, '
          '0 overwrite-style writers' % total_regions)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
