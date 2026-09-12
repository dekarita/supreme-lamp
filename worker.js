const CORS_ORIGIN = 'https://dekarita.github.io';
const RATE_LIMIT_MS = 30000;
const ipTimestamps = new Map();

function corsHeaders(origin) {
  const allowed = origin === CORS_ORIGIN ? CORS_ORIGIN : '';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function constantTimeCompare(a, b) {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const ka = await crypto.subtle.importKey('raw', enc.encode(a), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const kb = await crypto.subtle.importKey('raw', enc.encode(b), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sa = await crypto.subtle.sign('HMAC', ka, enc.encode('verify'));
  const sb = await crypto.subtle.sign('HMAC', kb, enc.encode('verify'));
  const va = new Uint8Array(sa), vb = new Uint8Array(sb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function rateLimit(ip) {
  const now = Date.now();
  const last = ipTimestamps.get(ip) || 0;
  if (now - last < RATE_LIMIT_MS) return false;
  ipTimestamps.set(ip, now);
  if (ipTimestamps.size > 10000) {
    for (const [k, v] of ipTimestamps) { if (now - v > 120000) ipTimestamps.delete(k); }
  }
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      const oh = url.pathname === '/proxy'
        ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type', 'Access-Control-Max-Age': '86400' }
        : corsHeaders(origin);
      return new Response(null, { status: 204, headers: oh });
    }

    if (url.pathname === '/proxy') {
      const target = url.searchParams.get('url') || '';
      const gm = target.match(/gofile\.io\/d\/([A-Za-z0-9]+)/);
      if (!gm) return new Response(JSON.stringify({ ok: false, message: 'need a gofile /d/ link' }), {
        status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
      const cid = gm[1];
      try {
        if (!globalThis.__gfToken || (globalThis.__gfAt || 0) < Date.now() - 3600e3) {
          const ar = await fetch('https://api.gofile.io/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          const aj = await ar.json();
          if (!aj || !aj.data || !aj.data.token) throw new Error('gofile token failed');
          globalThis.__gfToken = aj.data.token; globalThis.__gfAt = Date.now();
        }
        const token = globalThis.__gfToken;
        const ir = await fetch('https://api.gofile.io/contents/' + cid + '?wt=4fd6sg89d7s6', { headers: { Authorization: 'Bearer ' + token } });
        const ij = await ir.json();
        let direct = '';
        if (ij && ij.status === 'ok' && ij.data) {
          if (ij.data.directLink) direct = ij.data.directLink;
          else if (ij.data.children) { const k = Object.keys(ij.data.children)[0]; direct = (ij.data.children[k] && ij.data.children[k].link) || ''; }
        }
        if (!direct) return new Response(JSON.stringify({ ok: false, message: 'no direct link from gofile' }), {
          status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
        const h = new Headers();
        h.set('Cookie', 'accountToken=' + token);
        h.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
        const range = request.headers.get('Range'); if (range) h.set('Range', range);
        const up = await fetch(direct, { headers: h, redirect: 'follow' });
        if (!up.ok) return new Response(JSON.stringify({ ok: false, message: 'upstream ' + up.status }), {
          status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
        const rh = new Headers();
        rh.set('Access-Control-Allow-Origin', '*');
        rh.set('Accept-Ranges', 'bytes');
        const ct = up.headers.get('Content-Type'); if (ct) rh.set('Content-Type', ct);
        const cr = up.headers.get('Content-Range'); if (cr) rh.set('Content-Range', cr);
        const cl = up.headers.get('Content-Length'); if (cl) rh.set('Content-Length', cl);
        rh.set('Cache-Control', 'public, max-age=3600');
        return new Response(up.body, { status: up.status, headers: rh });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, message: String((e && e.message) || e) }), {
          status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    if (url.pathname === '/ping') {
      return jsonResponse({ ok: true, ts: Date.now() }, 200, origin);
    }

    if (origin !== CORS_ORIGIN) {
      return jsonResponse({ error: 'origin not allowed' }, 403, origin);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!rateLimit(ip)) {
      return jsonResponse({ error: 'rate limited (1 req / 30s)' }, 429, origin);
    }

    const accessCode = request.headers.get('X-Access-Code') || '';
    if (!accessCode) {
      return jsonResponse({ error: 'missing access code' }, 401, origin);
    }
    const codeHash = await sha256(accessCode);
    const expectedHash = env.WORKER_ACCESS_CODE_HASH || '';
    if (!await constantTimeCompare(codeHash, expectedHash)) {
      return jsonResponse({ error: 'invalid access code' }, 403, origin);
    }

    const ghToken = env.GH_PAT || '';
    const repo = env.GH_REPO || 'dekarita/supreme-lamp';
    const workflowFile = env.GH_WORKFLOW || 'main.yml';
    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ghrdp-worker',
    };

    if (url.pathname === '/dispatch' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const ref = body.ref || 'main';
      const inputs = {};
      if (body.mirror !== undefined) inputs.mirror_downloads_public = String(body.mirror);
      if (body.encrypt_mode) inputs.encrypt_mode = body.encrypt_mode;

      const resp = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`, {
        method: 'POST',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, inputs }),
      });
      if (resp.status === 204) {
        return jsonResponse({ ok: true, message: 'workflow dispatched' }, 200, origin);
      }
      const err = await resp.text();
      return jsonResponse({ ok: false, status: resp.status, error: err }, resp.status, origin);
    }

    if (url.pathname === '/cancel' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const runId = body.run_id;
      if (!runId) return jsonResponse({ error: 'missing run_id' }, 400, origin);

      const resp = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/cancel`, {
        method: 'POST',
        headers: ghHeaders,
      });
      if (resp.status === 202) {
        return jsonResponse({ ok: true, message: 'cancel requested' }, 200, origin);
      }
      const err = await resp.text();
      return jsonResponse({ ok: false, status: resp.status, error: err }, resp.status, origin);
    }

    if (url.pathname === '/workflow' && request.method === 'GET') {
      const resp = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=5&status=in_progress`, {
        headers: ghHeaders,
      });
      if (!resp.ok) {
        const err = await resp.text();
        return jsonResponse({ ok: false, error: err }, resp.status, origin);
      }
      const data = await resp.json();
      const runs = (data.workflow_runs || []).map(r => ({
        id: r.id,
        status: r.status,
        conclusion: r.conclusion,
        created_at: r.created_at,
        html_url: r.html_url,
      }));
      return jsonResponse({ ok: true, runs }, 200, origin);
    }

    return jsonResponse({ error: 'not found' }, 404, origin);
  },
};
