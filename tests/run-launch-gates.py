"""Run every Ubuntu bash gate verbatim; requires PyYAML. Windows lane stays CI-only."""
from pathlib import Path
import subprocess
import yaml
workflow = yaml.safe_load(Path('.github/workflows/launch-gates.yml').read_text())
failed = 0
for job in workflow['jobs'].values():
    if job['runs-on'] != 'ubuntu-latest':
        continue
    for step in job['steps']:
        if step.get('shell') != 'bash' or 'run' not in step:
            continue
        result = subprocess.run(['bash', '-c', step['run']], capture_output=True, text=True)
        print(('PASS ' if result.returncode == 0 else 'FAIL ') + step['name'])
        if result.returncode:
            print(result.stdout + result.stderr)
            failed += 1
raise SystemExit(bool(failed))
