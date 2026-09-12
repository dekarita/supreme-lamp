// ghrdp-worker.js — control proxy + gofile PREVIEW proxy
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const AO = env.ALLOW_ORIGIN || '*';
    const AC = {
      'Access-Control-Allow-Origin': AO,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Access-Code,Range',
      'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: AC });
    try {
      if (url.pathname === '/proxy') return await proxyGofile(request, env, AC);
      if (url.pathname === '/ping') return json({ ok: true, ts: Date.now() }, AC, 200);
      if (url.pathname === '/dispatch' || url.pathname === '/running' || url.pathname.startsWith('/cancel')) {
        const ok = await verifyCode(request, env);
        if (!ok) return json({ ok: false, message: 'invalid access code' }, AC, 401);
        if (url.pathname === '/dispatch') return await doDispatch(request, env, AC);
        if (url.pathname === '/running') return await listRunning(env, AC);
        return await doCancel(url, env, AC);
      }
      return json({ ok: false, message: 'not found' }, AC, 404);
    } catch (e) {
      return json({ ok: false, message: String((e && e.message) || e) }, AC, 500);
    }
  }
};
function json(o, AC, s) { return new Response(JSON.stringify(o), { status: s || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, AC) }); }
async function sha256hex(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function verifyCode(request, env) {
  const want = env.ACCESS_CODE_HASH; if (!want) return false;
  let code = '';
  if (request.method === 'POST') { try { code = (await request.clone().json()).code || ''; } catch (e) {} }
  if (!code) code = request.headers.get('X-Access-Code') || '';
  if (!code) return false;
  return (await sha256hex(code)).toLowerCase() === String(want).toLowerCase();
}
async function doDispatch(request, env, AC) {
  const b = await request.json(); const inputs = (b && b.inputs) || {};
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.WORKFLOW_FILE || 'main.yml'}/dispatches`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.GH_PAT, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.BRANCH || 'main', inputs: { mirror_downloads_public: String(!!inputs.mirror), encrypt_mode: inputs.encrypt || 'none' } })
  });
  return json({ ok: r.status === 204, status: r.status }, AC, r.status === 204 ? 200 : r.status);
}
async function listRunning(env, AC) {
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/runs?status=in_progress&per_page=5`, { headers: { Authorization: 'Bearer ' + env.GH_PAT, Accept: 'application/vnd.github+json' } });
  const j = await r.json();
  return json({ ok: true, runs: (j.workflow_runs || []).map(x => ({ id: x.id, created: x.created_at })) }, AC);
}
async function doCancel(url, env, AC) {
  const id = url.pathname.split('/').pop();
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/runs/${id}/cancel`, { method: 'POST', headers: { Authorization: 'Bearer ' + env.GH_PAT, Accept: 'application/vnd.github+json' } });
  return json({ ok: r.status === 202, status: r.status }, AC, r.status === 202 ? 200 : r.status);
}
/* ---------- gofile preview bridge ---------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
async function gofileToken(env) {
  const now = Date.now();
  if (globalThis.__gf && globalThis.__gf.at > now - 3600e3) return globalThis.__gf.t;
  const r = await fetch('https://api.gofile.io/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA } });
  const j = await r.json();
  const t = j && j.data && j.data.token;
  if (!t) throw new Error('gofile account token failed: ' + (j && j.status));
  globalThis.__gf = { t, at: now };
  return t;
}
async function proxyGofile(request, env, AC) {
  const q = new URL(request.url).searchParams;
  const link = q.get('url') || '';
  const m = link.match(/gofile\.io\/d\/([A-Za-z0-9]+)/);
  const code = q.get('code') || (m && m[1]);
  if (!code) return json({ ok: false, message: 'missing ?url= (a gofile /d/ link)' }, AC, 400);
  const token = await gofileToken(env);
  const wt = env.GOFILE_WT || '4fd6sg89d7s6';
  const info = await (await fetch(`https://api.gofile.io/contents/${code}?wt=${wt}`, { headers: { Authorization: 'Bearer ' + token, 'User-Agent': UA } })).json();
  if (!info || info.status !== 'ok' || !info.data) return json({ ok: false, message: 'gofile contents: ' + (info && info.status) }, AC, 502);
  let direct = info.data.directLink || '';
  if (!direct && info.data.children) { const k = Object.keys(info.data.children)[0]; if (k) direct = info.data.children[k].link || info.data.children[k].directLink || ''; }
  if (!direct) return json({ ok: false, message: 'no directLink in gofile response' }, AC, 502);
  const h = { 'User-Agent': UA, 'Cookie': 'accountToken=' + token, 'Referer': 'https://gofile.io/' };
  const range = request.headers.get('Range'); if (range) h['Range'] = range;
  const up = await fetch(direct, { headers: h, redirect: 'follow' });
  if (!up.ok) return json({ ok: false, message: 'upstream ' + up.status }, AC, 502);
  const hd = new Headers();
  Object.keys(AC).forEach(k => hd.set(k, AC[k]));
  hd.set('Content-Type', up.headers.get('Content-Type') || 'application/octet-stream');
  const cl = up.headers.get('Content-Length'); if (cl) hd.set('Content-Length', cl);
  const cr = up.headers.get('Content-Range'); if (cr) hd.set('Content-Range', cr);
  hd.set('Accept-Ranges', 'bytes');
  hd.set('Cache-Control', 'public, max-age=3600');
  return new Response(up.body, { status: up.status, headers: hd });
}
