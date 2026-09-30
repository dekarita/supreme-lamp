"""Run every Ubuntu bash gate verbatim; requires PyYAML. Windows lane stays CI-only.

[F56-d] Two additive switches, no change to the default invocation (the 44 explicit
`shell: bash` gates stay the counted set):

  --default-shell   ALSO run the ubuntu steps that omit `shell:`. GitHub's default
                    shell on ubuntu-latest IS bash, so CI runs them while this script
                    used to skip them. That blind spot is exactly how a red
                    `pnpm run build` (tsc) reached main in F56-d: the F41 step carries
                    the only build+typecheck in the job and it has no `shell:` key.
  --skip SUBSTR     skip steps whose name contains SUBSTR (repeatable), e.g.
                    `--skip playwright` when the sandbox has no browser binaries.
"""
from pathlib import Path
import subprocess
import sys
import yaml

argv = sys.argv[1:]
include_default_shell = '--default-shell' in argv
skips = [argv[i + 1] for i, a in enumerate(argv) if a == '--skip' and i + 1 < len(argv)]

workflow = yaml.safe_load(Path('.github/workflows/launch-gates.yml').read_text())
failed = 0
counted = 0
extra = 0
skipped = 0
for job in workflow['jobs'].values():
    if job['runs-on'] != 'ubuntu-latest':
        continue
    for step in job['steps']:
        shell = step.get('shell')
        if shell != 'bash' and not (shell is None and include_default_shell):
            continue
        if 'run' not in step:
            continue
        if any(s in step['name'] for s in skips):
            print('SKIP ' + step['name'])
            skipped += 1
            continue
        result = subprocess.run(['bash', '-c', step['run']], capture_output=True, text=True)
        print(('PASS ' if result.returncode == 0 else 'FAIL ') + step['name'])
        if result.returncode:
            print(result.stdout + result.stderr)
            failed += 1
        elif shell == 'bash':
            counted += 1
        else:
            extra += 1
print('bash gates %d PASS | default-shell %d PASS | %d SKIP | %d FAIL'
      % (counted, extra, skipped, failed))
raise SystemExit(bool(failed))
