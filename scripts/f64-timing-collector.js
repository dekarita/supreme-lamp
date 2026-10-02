#!/usr/bin/env node
/**
 * [F64] GitHub Actions per-step timing extractor + critical-path computer.
 *
 * Reads a jobs payload (GET /repos/{o}/{r}/actions/runs/{id}/jobs) and emits
 * jsonl rows. Critical path = rdp steps from job start through
 * "Start Mission Control dashboard EARLY" (Mission Control :7331 = READY).
 *
 * This module never claims lab numbers as production. GitHub timestamps have
 * 1-second resolution; 0s steps are real (<1s), not missing data.
 *
 * Usage:
 *   node scripts/f64-timing-collector.js --jobs jobs.json --out f64-timing-baseline.jsonl
 *   node scripts/f64-timing-collector.js --jobs a.json --jobs b.json --out -
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DASHBOARD_NEEDLE = 'Start Mission Control dashboard EARLY';
const HONEST_TARGET_MEDIAN_S = { min: 7 * 60, max: 8 * 60 };
const HONEST_GATE_S = 8 * 60 + 30; // 8m30s: 30s margin above the 8m median cap

function parseIso(s) {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function secBetween(a, b) {
  const t1 = parseIso(a);
  const t2 = parseIso(b);
  if (t1 == null || t2 == null) return null;
  return (t2 - t1) / 1000;
}

function isPostStep(step) {
  const n = Number(step && step.number);
  return Number.isFinite(n) && n >= 100;
}

/**
 * Extract per-step rows + a summary from one GitHub jobs API payload.
 * `meta` may supply run_id / head_sha / event / run_started_at when the
 * payload itself is just `{ jobs: [...] }`.
 */
function extractRun(payload, meta) {
  if (!payload || !Array.isArray(payload.jobs)) {
    throw new Error('jobs payload missing .jobs[]');
  }
  const metaObj = meta && typeof meta === 'object' ? meta : {};
  const rows = [];
  // Prefer the jobs payload run_id (never digits scraped from "f64-jobs-....json").
  const payloadRunId = (payload.jobs.find((j) => j && j.run_id) || {}).run_id || null;
  let summary = {
    kind: 'summary',
    run_id: payloadRunId || metaObj.run_id || null,
    head_sha: metaObj.head_sha || null,
    event: metaObj.event || null,
    run_started_at: metaObj.run_started_at || null,
    job: 'rdp',
    reached_dashboard: false,
    dashboard_reachable_s: null,
    dashboard_reachable_min: null,
    rdp_job_status: null,
    rdp_job_conclusion: null,
    rdp_labels: [],
    ui_prebuilt_conclusion: null,
    ui_prebuilt_sec: null,
    ui_fallback_build_sec: null,
    honest_target: '7-8min-median-not-guaranteed',
    honest_gate_s: HONEST_GATE_S,
    note: null,
  };

  for (const job of payload.jobs) {
    const jobName = String(job.name || '');
    const runId = job.run_id || payloadRunId || metaObj.run_id || null;
    if (summary.run_id == null) summary.run_id = runId;
    summary.head_sha = summary.head_sha || job.head_sha || metaObj.head_sha || null;

    if (jobName === 'build-ui') {
      for (const step of job.steps || []) {
        const name = String(step.name || '');
        const sec = secBetween(step.started_at, step.completed_at);
        if (name.indexOf('Download prebuilt UI bundle') === 0) {
          summary.ui_prebuilt_conclusion = step.conclusion || step.status || null;
          summary.ui_prebuilt_sec = sec;
        }
        if (name.indexOf('Build v2 single-file bundle') === 0) {
          summary.ui_fallback_build_sec = sec;
        }
        rows.push({
          kind: 'step',
          run_id: runId,
          job: 'build-ui',
          number: step.number,
          name,
          status: step.status || null,
          conclusion: step.conclusion || null,
          started_at: step.started_at || null,
          completed_at: step.completed_at || null,
          sec,
          on_critical_path: false,
        });
      }
      continue;
    }

    if (jobName !== 'rdp') continue;

    summary.rdp_job_status = job.status || null;
    summary.rdp_job_conclusion = job.conclusion || null;
    summary.rdp_labels = Array.isArray(job.labels) ? job.labels.slice() : [];
    summary.rdp_started_at = job.started_at || null;

    const steps = Array.isArray(job.steps) ? job.steps : [];
    let dashNumber = null;
    let dashCompleted = null;
    for (const step of steps) {
      if (String(step.name || '').indexOf(DASHBOARD_NEEDLE) === 0) {
        dashNumber = step.number;
        dashCompleted = step.completed_at || null;
        if (step.conclusion === 'success' && dashCompleted) {
          summary.reached_dashboard = true;
        }
      }
    }
    if (summary.reached_dashboard && job.started_at && dashCompleted) {
      const s = secBetween(job.started_at, dashCompleted);
      summary.dashboard_reachable_s = s;
      summary.dashboard_reachable_min = s == null ? null : Math.round((s / 60) * 100) / 100;
    } else if (!steps.length && (job.conclusion === 'skipped' || job.status === 'completed')) {
      summary.note = 'rdp job skipped (no steps) - usually a failed build-ui / release-asset download';
    }

    for (const step of steps) {
      if (isPostStep(step)) continue;
      const name = String(step.name || '');
      const sec = secBetween(step.started_at, step.completed_at);
      const onCp =
        dashNumber != null &&
        Number.isFinite(Number(step.number)) &&
        Number(step.number) <= Number(dashNumber) &&
        step.status === 'completed';
      rows.push({
        kind: 'step',
        run_id: runId,
        job: 'rdp',
        number: step.number,
        name,
        status: step.status || null,
        conclusion: step.conclusion || null,
        started_at: step.started_at || null,
        completed_at: step.completed_at || null,
        sec,
        on_critical_path: Boolean(onCp),
      });
    }
  }

  if (summary.ui_prebuilt_conclusion === 'failure') {
    summary.note = summary.note || 'release-asset download FAILED - rdp did not start';
  } else if (summary.ui_fallback_build_sec && summary.ui_fallback_build_sec > 1 && summary.ui_prebuilt_conclusion === 'success') {
    summary.note = summary.note || 'ui-prebuilt step succeeded but fallback build also ran (asset miss / hit=false)';
  } else if (summary.ui_prebuilt_conclusion === 'success' && (summary.ui_fallback_build_sec === 0 || summary.ui_fallback_build_sec == null)) {
    summary.note = summary.note || 'ui-prebuilt cache/release-asset HIT';
  }

  return { rows, summary };
}

function criticalPath(rows) {
  return (rows || []).filter((r) => r.kind === 'step' && r.job === 'rdp' && r.on_critical_path);
}

function sumSec(rows) {
  let n = 0;
  for (const r of rows || []) {
    if (typeof r.sec === 'number' && Number.isFinite(r.sec)) n += r.sec;
  }
  return n;
}

function toJsonl(extractedList) {
  const lines = [];
  for (const ex of extractedList) {
    lines.push(JSON.stringify(ex.summary));
    for (const r of ex.rows) lines.push(JSON.stringify(r));
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

function summariesFromJsonl(records) {
  return (records || []).filter((r) => r && r.kind === 'summary');
}

function median(nums) {
  const a = (nums || []).filter((n) => typeof n === 'number' && Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function evaluateBaseline(summaries) {
  const reached = (summaries || []).filter((s) => s.reached_dashboard && typeof s.dashboard_reachable_s === 'number');
  const values = reached.map((s) => s.dashboard_reachable_s);
  const med = median(values);
  const gatePass = values.length > 0 && values.every((v) => v <= HONEST_GATE_S);
  return {
    n_runs: (summaries || []).length,
    n_reached_dashboard: reached.length,
    values_s: values,
    median_s: med,
    median_min: med == null ? null : Math.round((med / 60) * 100) / 100,
    honest_target_min: '7-8',
    honest_gate_s: HONEST_GATE_S,
    within_8m30s: gatePass,
    never_promise_sub7: true,
    f63_lab_savings_not_production: true,
  };
}

function loadJobsFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function cli(argv) {
  const args = argv.slice(2);
  const jobsFiles = [];
  let out = 'f64-timing-baseline.jsonl';
  let metaPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--jobs' && args[i + 1]) {
      jobsFiles.push(args[++i]);
    } else if (args[i] === '--out' && args[i + 1]) {
      out = args[++i];
    } else if (args[i] === '--meta' && args[i + 1]) {
      metaPath = args[++i];
    } else if (args[i] === '--help') {
      process.stdout.write('Usage: node scripts/f64-timing-collector.js --jobs jobs.json [--jobs more.json] [--out f64-timing-baseline.jsonl]\n');
      return 0;
    }
  }
  if (!jobsFiles.length) {
    process.stderr.write('f64-timing-collector: pass one or more --jobs <jobs-api.json>\n');
    return 2;
  }
  const metaMap = metaPath ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  const extracted = [];
  for (const f of jobsFiles) {
    const payload = loadJobsFile(f);
    const fromJob = (payload.jobs || []).find((j) => j && j.run_id);
    const m = path.basename(f).match(/(\d{10,})/);
    const runId = (fromJob && fromJob.run_id) || (m ? Number(m[1]) : null);
    const found = metaMap[String(runId)] || metaMap[runId] || metaMap[f] || {};
    const meta = Object.assign({}, found);
    if (meta.run_id == null && runId) meta.run_id = runId;
    extracted.push(extractRun(payload, meta));
  }
  const text = toJsonl(extracted);
  if (out === '-' || out === '/dev/stdout') process.stdout.write(text);
  else fs.writeFileSync(out, text);
  const ev = evaluateBaseline(extracted.map((e) => e.summary));
  process.stderr.write(
    '[F64] runs=' +
      ev.n_runs +
      ' reached_dashboard=' +
      ev.n_reached_dashboard +
      ' median=' +
      (ev.median_min != null ? ev.median_min + 'min' : 'n/a') +
      ' within_8m30s=' +
      ev.within_8m30s +
      ' (honest target 7-8min median, NOT guaranteed 6)\n'
  );
  return 0;
}

module.exports = {
  DASHBOARD_NEEDLE,
  HONEST_TARGET_MEDIAN_S,
  HONEST_GATE_S,
  parseIso,
  secBetween,
  extractRun,
  criticalPath,
  sumSec,
  toJsonl,
  parseJsonl,
  summariesFromJsonl,
  median,
  evaluateBaseline,
  loadJobsFile,
};

if (require.main === module) {
  process.exit(cli(process.argv));
}
