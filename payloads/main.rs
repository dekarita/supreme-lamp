use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::io::Write;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use notify::{recommended_watcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot};
use tower_http::cors::CorsLayer;

const DEFAULT_PORT: u16 = 7332;
const BROADCAST_CAPACITY: usize = 64;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(200);
const PERIODIC_BROADCAST: Duration = Duration::from_secs(30);
const READ_ATTEMPTS: u32 = 3;
const READ_RETRY_DELAY: Duration = Duration::from_millis(120);
const LEGACY_URL: &str = "https://rentry.co/myurl0";

struct AppState {
    root: PathBuf,
    tx: broadcast::Sender<String>,
    clients: Arc<Mutex<usize>>,
    started: Instant,
    port: u16,
}
type SharedState = Arc<AppState>;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn log_line(msg: &str) {
    let line = format!("[{}] {}", now_iso(), msg);
    let _ = writeln!(std::io::stdout(), "{}", line);
    let _ = writeln!(std::io::stderr(), "{}", line);
    if let Ok(root) = std::env::var("GHRDP_ROOT") {
        let path = PathBuf::from(root).join("dash.log");
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
  let _ = writeln!(file, "{}", line);
        }
    }
}

fn strip_bom(bytes: Vec<u8>) -> String {
    let slice: &[u8] = if bytes.len() >= 3
        && bytes[0] == 0xEF
        && bytes[1] == 0xBB
        && bytes[2] == 0xBF
    {
        &bytes[3..]
    } else {
        &bytes[..]
    };
    String::from_utf8_lossy(slice)
        .trim_start_matches('\u{FEFF}')
        .to_owned()
}

fn read_json_retry(path: &Path) -> Option<Value> {
    let mut last_error = String::from("unknown error");
    for attempt in 1..=READ_ATTEMPTS {
        match std::fs::read(path) {
  Ok(bytes) => match serde_json::from_str::<Value>(&strip_bom(bytes)) {
      Ok(value) => return Some(value),
      Err(err) => last_error = format!("JSON parse failed: {}", err),
  },
  Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
  Err(err) => last_error = format!("IO error: {}", err),
        }
        if attempt < READ_ATTEMPTS {
  std::thread::sleep(READ_RETRY_DELAY);
        }
    }
    log_line(&format!(
        "giving up on {} after {} attempts: {}",
        path.display(),
        READ_ATTEMPTS,
        last_error
    ));
    None
}

fn cfg_str(cfg: &Value, key: &str) -> String {
    cfg.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn build_snapshot(root: &Path) -> Value {
    let cfg = read_json_retry(&root.join("config.json")).unwrap_or_else(|| json!({}));
    let prog = read_json_retry(&root.join("progress.json")).unwrap_or_else(|| {
        json!({
  "ts": "",
  "alive": false,
  "active": {"name": "", "phase": "idle", "pct": 0},
  "agg": {"total": 0, "done": 0, "failed": 0, "active": 0,
          "bytesDone": 0, "bytesTotal": 0, "overallPct": 0, "speedBps": 0},
  "telemetry": {"scans": 0, "lastScan": ""},
  "archives": [],
  "files": [],
  "log": []
        })
    });
    let mirror = cfg.get("mirror").and_then(Value::as_bool).unwrap_or(false);
    let mirror_key = if mirror {
        cfg_str(&cfg, "mirrorKey")
    } else {
        String::new()
    };
    let legacy_links: Vec<String> = cfg
        .get("legacyLinks")
        .and_then(Value::as_array)
        .map(|a| {
  a.iter()
      .filter_map(|v| v.as_str().map(|s| s.to_owned()))
      .collect()
        })
        .unwrap_or_default();

    json!({
        "serverTs": now_iso(),
        "kind": "snapshot",
        "creds": {
  "ip": cfg_str(&cfg, "rdpIp"),
  "user": cfg_str(&cfg, "rdpUser"),
  "pass": cfg_str(&cfg, "rdpPass"),
        },
        "ghrdp": cfg_str(&cfg, "ghrdp"),
        "mirror": mirror,
        "encryptMode": cfg_str(&cfg, "encryptMode"),
        "mirrorKey": mirror_key,
        "mirrorIndexUrl": cfg_str(&cfg, "mirrorIndexUrl"),
        "serveUrl": cfg_str(&cfg, "serveUrl"),
        "funnelUrl": cfg_str(&cfg, "funnelUrl"),
        "startedAt": cfg_str(&cfg, "startedAt"),
        "runStartedAt": cfg_str(&cfg, "runStartedAt"),
        "sessionStartedAt": cfg_str(&cfg, "sessionStartedAt"),
        "githubDeadline": cfg_str(&cfg, "githubDeadline"),
        "keepAliveDeadline": cfg_str(&cfg, "keepAliveDeadline"),
        "keepAlivePhase": cfg_str(&cfg, "keepAlivePhase"),
        "watcherDeadline": cfg_str(&cfg, "watcherDeadline"),
        "legacyIndexUrl": if cfg_str(&cfg, "legacyIndexUrl").is_empty() { LEGACY_URL.to_string() } else { cfg_str(&cfg, "legacyIndexUrl") },
        "legacyDecryptKey": cfg_str(&cfg, "legacyDecryptKey"),
        "legacyLinks": legacy_links,
        "rentryNewUrl": cfg_str(&cfg, "rentryNewUrl"),
        "runnerEgressIp": cfg_str(&cfg, "runnerEgressIp"),
        "pagesBase": cfg_str(&cfg, "pagesBase"),
        "progress": prog,
    })
}

fn read_uploads(root: &Path) -> Value {
    let index = read_json_retry(&root.join("mirror-index.json"))
        .unwrap_or_else(|| json!([]));
    let items = index.as_array().cloned().unwrap_or_default();
    let cfg = read_json_retry(&root.join("config.json")).unwrap_or_else(|| json!({}));

    json!({
        "serverTs": now_iso(),
        "count": items.len(),
        "mirror": cfg.get("mirror").and_then(Value::as_bool).unwrap_or(false),
        "telegraphUrl": cfg.get("mirrorIndexUrl").and_then(Value::as_str).unwrap_or(""),
        "pagesBase": cfg.get("pagesBase").and_then(Value::as_str).unwrap_or(""),
        "items": items,
    })
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<SharedState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: SharedState) {
    {
        let mut clients = state.clients.lock().unwrap_or_else(|e| e.into_inner());
        *clients += 1;
    }
    let (mut sender, mut receiver) = socket.split();
    let root = state.root.clone();

    let snapshot = tokio::task::spawn_blocking(move || build_snapshot(&root))
        .await
        .unwrap_or_else(|_| json!({ "error": "snapshot task failed" }));

    if let Ok(text) = serde_json::to_string(&snapshot) {
        if sender.send(Message::Text(text)).await.is_err() {
  let mut clients = state.clients.lock().unwrap_or_else(|e| e.into_inner());
  *clients -= 1;
  return;
        }
    }

    let mut rx = state.tx.subscribe();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let send_task = tokio::spawn(async move {
        loop {
  match rx.recv().await {
      Ok(msg) => {
          if sender.send(Message::Text(msg)).await.is_err() {
              break;
          }
      }
      Err(broadcast::error::RecvError::Lagged(skipped)) => {
          log_line(&format!("ws client lagged, skipped {} messages", skipped));
      }
      Err(broadcast::error::RecvError::Closed) => break,
  }
        }
        let _ = shutdown_tx.send(());
    });

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(message)) = receiver.next().await {
  if matches!(message, Message::Close(_)) {
      break;
  }
        }
    });

    let send_side_finished = tokio::select! {
        _ = shutdown_rx => true,
        _ = &mut recv_task => false,
    };

    if send_side_finished {
        recv_task.abort();
    } else {
        send_task.abort();
    }

    {
        let mut clients = state.clients.lock().unwrap_or_else(|e| e.into_inner());
        *clients -= 1;
    }
}

async fn health_handler(State(state): State<SharedState>) -> Json<Value> {
    let clients = *state.clients.lock().unwrap_or_else(|e| e.into_inner());
    Json(json!({
        "ok": true,
        "ws": true,
        "port": state.port,
        "pid": std::process::id(),
        "websocketClients": clients,
        "uptimeSeconds": state.started.elapsed().as_secs(),
        "ts": now_iso(),
    }))
}

async fn api_progress(State(state): State<SharedState>) -> Json<Value> {
    let root = state.root.clone();
    let snapshot = tokio::task::spawn_blocking(move || build_snapshot(&root))
        .await
        .unwrap_or_else(|_| json!({ "error": "snapshot task failed" }));
    Json(snapshot)
}

async fn api_config(State(state): State<SharedState>) -> Response {
    let path = state.root.join("config.json");
    let config = tokio::task::spawn_blocking(move || read_json_retry(&path))
        .await
        .unwrap_or(None);
    match config {
        Some(value) => Json(value).into_response(),
        None => (StatusCode::NOT_FOUND, "config.json missing").into_response(),
    }
}

async fn api_uploads(State(state): State<SharedState>) -> Json<Value> {
    let root = state.root.clone();
    let uploads = tokio::task::spawn_blocking(move || read_uploads(&root))
        .await
        .unwrap_or_else(|_| json!({ "error": "uploads task failed" }));
    Json(uploads)
}

async fn api_stats(State(state): State<SharedState>) -> Json<Value> {
    let clients = *state.clients.lock().unwrap_or_else(|e| e.into_inner());
    Json(json!({
        "server": "ghrdp-dash",
        "port": state.port,
        "websocketClients": clients,
        "root": state.root.display().to_string(),
        "ts": now_iso(),
    }))
}

async fn install_ps1_handler(State(state): State<SharedState>) -> Response {
    match tokio::fs::read(state.root.join("ghrdp-install.ps1")).await {
        Ok(bytes) => (
  StatusCode::OK,
  [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
  bytes,
        )
  .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "ghrdp-install.ps1 missing").into_response(),
    }
}

async fn flush_handler(State(state): State<SharedState>) -> Json<Value> {
    let path = state.root.join("flush.flag");
    match std::fs::write(&path, now_iso()) {
        Ok(()) => Json(json!({
  "ok": true,
  "message": "flush flag set - the watcher will upload everything on its next pass",
  "ts": now_iso(),
        })),
        Err(err) => Json(json!({
  "ok": false,
  "message": format!("flush flag write failed: {}", err),
  "ts": now_iso(),
        })),
    }
}

async fn launch_handler() -> Json<Value> {
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-ScheduledTask -TaskName 'GhrdpWatcher'; exit 0"])
        .output();
    match out {
        Ok(o) => {
  let ok = o.status.success();
  let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
  Json(json!({
      "ok": true,
      "message": if ok { "watcher task start requested".to_string() } else { format!("task start returned nonzero: {}", stderr) },
      "ts": now_iso(),
  }))
        }
        Err(err) => Json(json!({
  "ok": false,
  "message": format!("could not run task start: {}", err),
  "ts": now_iso(),
        })),
    }
}

async fn diag_handler(State(state): State<SharedState>) -> Json<Value> {
    let root = state.root.clone();
    let prog = tokio::task::spawn_blocking(move || read_json_retry(&root.join("progress.json")))
        .await
        .unwrap_or(None);
    Json(json!({
        "serverTs": now_iso(),
        "progress": prog,
    }))
}

async fn index_handler() -> Response {
    let static_path = std::env::var("GHRDP_ROOT")
        .map(|r| std::path::PathBuf::from(r).join("rust").join("static").join("index.html"))
        .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\ghrdp\rust\static\index.html"));
    if let Ok(bytes) = std::fs::read(&static_path) {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            bytes,
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        DASHBOARD_HTML,
    )
        .into_response()
}

fn spawn_file_watcher(state: SharedState) {
    let root = state.root.clone();
    let tx = state.tx.clone();
    let (event_tx, event_rx) =
        std::sync::mpsc::channel::<Result<notify::Event, notify::Error>>();

    let mut watcher = match recommended_watcher(event_tx) {
        Ok(watcher) => watcher,
        Err(err) => {
  log_line(&format!(
      "failed to create file watcher: {} (the 30s periodic broadcast still covers updates)",
      err
  ));
  return;
        }
    };

    if let Err(err) = watcher.watch(&root, RecursiveMode::NonRecursive) {
        log_line(&format!(
  "failed to watch {}: {} (the 30s periodic broadcast still covers updates)",
  root.display(),
  err
        ));
    }

    let spawned = std::thread::Builder::new()
        .name("ghrdp-file-watcher".into())
        .spawn(move || {
  let _watcher = watcher;
  let mut last_emit: Option<Instant> = None;
  for event in event_rx {
      let event = match event {
          Ok(event) => event,
          Err(err) => {
              log_line(&format!("watcher event error: {}", err));
              continue;
          }
      };

      let relevant = event.paths.iter().any(|path| {
          matches!(
              path.file_name().and_then(|name| name.to_str()),
              Some("progress.json")
                  | Some("config.json")
                  | Some("mirror-index.json")
          )
      });

      if !relevant {
          continue;
      }

      if let Some(last) = last_emit {
          if last.elapsed() < WATCH_DEBOUNCE {
              continue;
          }
      }
      last_emit = Some(Instant::now());

      if let Ok(text) = serde_json::to_string(&build_snapshot(&root)) {
          let _ = tx.send(text);
      }
  }
        });

    if let Err(err) = spawned {
        log_line(&format!("failed to spawn watcher thread: {}", err));
    }
}

async fn periodic_broadcast(state: SharedState) {
    let mut interval = tokio::time::interval(PERIODIC_BROADCAST);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let root = state.root.clone();
        let snapshot = tokio::task::spawn_blocking(move || build_snapshot(&root))
  .await
  .unwrap_or_else(|_| json!({ "error": "snapshot task failed" }));
        if let Ok(text) = serde_json::to_string(&snapshot) {
  let _ = state.tx.send(text);
        }
    }
}

async fn shutdown_signal() {
    if let Err(err) = tokio::signal::ctrl_c().await {
        log_line(&format!("failed to wait for ctrl_c: {}", err));
    }
    log_line("shutdown signal received");
}

#[tokio::main]
async fn main() {
    let root = PathBuf::from(
        std::env::var("GHRDP_ROOT").unwrap_or_else(|_| r"C:\ghrdp".to_string()),
    );
    let port: u16 = std::env::var("GHRDP_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let (tx, _rx) = broadcast::channel::<String>(BROADCAST_CAPACITY);
    let state: SharedState = Arc::new(AppState {
        root: root.clone(),
        tx,
        clients: Arc::new(Mutex::new(0)),
        started: Instant::now(),
        port,
    });

    spawn_file_watcher(state.clone());
    tokio::spawn(periodic_broadcast(state.clone()));

    let state_router: Router<Arc<AppState>> = axum::Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(health_handler))
        .route("/api/progress", get(api_progress))
        .route("/api/config", get(api_config))
        .route("/api/uploads", get(api_uploads))
        .route("/api/stats", get(api_stats))
        .route("/install.ps1", get(install_ps1_handler))
        .route("/flush", get(flush_handler))
        .route("/launch", get(launch_handler))
        .route("/diag", get(diag_handler));

    let app: axum::Router<()> = state_router
        .with_state(state)
        .layer(CorsLayer::permissive())
        .route("/", get(index_handler))
        .route("/index.html", get(index_handler));

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) => {
  log_line(&format!("bind failed on {}: {}", addr, err));
  let _ = std::fs::write(
      root.join("rust-ok.txt"),
      format!("BIND_FAIL: {} at {}", err, now_iso()),
  );
  std::process::exit(1);
        }
    };

    let _ = std::fs::write(
        root.join("rust-ok.txt"),
        format!(
  "LISTENING pid={} port={} at={}",
  std::process::id(),
  port,
  now_iso(),
        ),
    );

    log_line(&format!("listening on http://{}", addr));
    log_line(&format!("root: {}", root.display()));
    log_line(&format!("websocket endpoint: ws://<host>:{}/ws", port));

    if let Err(err) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        log_line(&format!("server error: {}", err));
        std::process::exit(1);
    }

    log_line("stopped cleanly");
}

const DASHBOARD_HTML: &str = r##"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<title>RDP Mission Control</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0}
:root{
  --bg:#05070d;
  --ink:#e6eef6;
  --mut:#93a3b8;
  --line:rgba(255,255,255,.08);
  --line-hi:rgba(255,255,255,.14);
  --glass:rgba(255,255,255,.055);
  --glass-hi:rgba(255,255,255,.09);
  --acc1:#22d3ee;
  --acc2:#34d399;
  --acc3:#a78bfa;
  --ok:#34d399;
  --warn:#fbbf24;
  --bad:#f87171;
  --shadow:0 10px 34px rgba(0,0,0,.45);
  --sheen:linear-gradient(160deg,rgba(255,255,255,.10),transparent 42%);
  --accent:linear-gradient(135deg,#22d3ee 0%,#34d399 55%,#a78bfa 100%);
  --radius:18px;
  --ease:cubic-bezier(.2,.8,.2,1);
}
body{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,"Helvetica Neue",Arial,sans-serif;font-variant-numeric:tabular-nums;
  background:var(--bg);color:var(--ink);min-height:100vh;overflow-x:hidden;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
}
.aurora{position:fixed;inset:-15%;z-index:-3;pointer-events:none;overflow:hidden}
.aurora i{position:absolute;display:block;border-radius:50%;filter:blur(90px);opacity:.45;mix-blend-mode:screen}
.aurora .a1{width:60vw;height:60vw;top:-10%;left:-8%;background:radial-gradient(circle,#22d3ee 0%,transparent 60%);animation:drift1 62s ease-in-out infinite alternate}
.aurora .a2{width:55vw;height:55vw;top:20%;right:-10%;background:radial-gradient(circle,#a78bfa 0%,transparent 60%);animation:drift2 78s ease-in-out infinite alternate}
.aurora .a3{width:70vw;height:70vw;bottom:-20%;left:20%;background:radial-gradient(circle,#34d399 0%,transparent 60%);opacity:.35;animation:drift3 54s ease-in-out infinite alternate}
@keyframes drift1{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(6vw,4vh,0) scale(1.08)}}
@keyframes drift2{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(-5vw,6vh,0) scale(1.06)}}
@keyframes drift3{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(4vw,-5vh,0) scale(1.10)}}
.noise{position:fixed;inset:0;z-index:-2;pointer-events:none;opacity:.035;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.7 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
  background-size:240px 240px;mix-blend-mode:overlay;
}
.glass{position:relative;background:var(--glass);border:1px solid var(--line);border-radius:var(--radius);
  backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);
  box-shadow:var(--shadow),inset 0 1px 0 rgba(255,255,255,.09);overflow:hidden}
.glass::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:var(--sheen);opacity:.9}
.topbar{position:sticky;top:0;z-index:40;padding:14px 22px;margin:0;border-radius:0;
  background:rgba(5,7,13,.55);backdrop-filter:blur(22px) saturate(160%);-webkit-backdrop-filter:blur(22px) saturate(160%);
  border-bottom:1px solid var(--line);display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.topbar h1{margin:0;font-size:15px;letter-spacing:.10em;text-transform:uppercase;font-weight:600;
  background:var(--accent);-webkit-background-clip:text;background-clip:text;color:transparent}
.topbar .brand-dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px rgba(52,211,153,.6)}
.topbar .brand{display:flex;align-items:center;gap:10px}
.topbar .nav{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.topbar .nav a{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;
  padding:6px 10px;border-radius:999px;border:1px solid transparent;
  transition:color .18s var(--ease),border-color .18s var(--ease),background .18s var(--ease)}
.topbar .nav a:hover{color:var(--ink);border-color:var(--line-hi);background:var(--glass-hi)}
.chip-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.chip{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;
  background:var(--glass);border:1px solid var(--line);color:var(--ink);font-size:11px;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);cursor:help;
  transition:border-color .18s var(--ease),background .18s var(--ease);
  font-variant-numeric:tabular-nums}
.chip:hover{border-color:var(--line-hi);background:var(--glass-hi)}
.chip .dot{width:6px;height:6px;border-radius:50%;background:var(--mut)}
.chip.ok .dot{background:var(--ok);animation:pulseOk 2s var(--ease) infinite}
.chip.bad .dot{background:var(--bad)}
.chip.warn .dot{background:var(--warn)}
@keyframes pulseOk{0%,100%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}50%{box-shadow:0 0 0 6px rgba(52,211,153,0)}}
main{max-width:1180px;margin:0 auto;padding:22px 22px 80px;display:flex;flex-direction:column;gap:18px}
.banner{display:none;padding:10px 16px;border-radius:14px;
  border:1px solid rgba(248,113,113,.32);background:rgba(248,113,113,.08);color:var(--bad);font-size:12.5px;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.banner.egress{display:block;color:var(--warn);border-color:rgba(251,191,36,.28);background:rgba(251,191,36,.07)}
.kpi{display:grid;grid-template-columns:auto repeat(6,1fr);gap:14px;padding:18px 20px}
.ring{width:80px;height:80px;position:relative;flex:0 0 auto}
.ring svg{width:100%;height:100%;transform:rotate(-90deg)}
.ring .track{stroke:rgba(255,255,255,.08);fill:none;stroke-width:5}
.ring .fill{stroke:url(#ringGrad);fill:none;stroke-width:5;stroke-linecap:round;transition:stroke-dashoffset .5s var(--ease)}
.ring .label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;line-height:1;pointer-events:none}
.ring .label b{font-family:'Inter',-apple-system,sans-serif;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.ring .label span{font-size:8.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.14em;margin-top:3px}
.tile{padding:12px 14px;border-radius:14px;background:var(--glass);border:1px solid var(--line);
  display:flex;flex-direction:column;gap:6px;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);min-width:0}
.tile .lab{font-size:10px;letter-spacing:.10em;text-transform:uppercase;color:var(--mut)}
.tile .val{font-family:'Inter',-apple-system,sans-serif;font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em;color:var(--ink);word-break:break-all}
.tile .sub{font-size:10px;color:var(--mut);font-variant-numeric:tabular-nums}
.tile.bad .val{color:var(--bad)}
.tile.warn .val{color:var(--warn)}
.tile.ok .val{color:var(--ok)}
section.glass{padding:18px 20px}
section.glass h2{margin:0 0 12px;font-size:11px;color:var(--acc1);text-transform:uppercase;letter-spacing:.14em;font-weight:600}
.row{display:flex;align-items:center;gap:10px;margin:7px 0;flex-wrap:wrap}
.row .k{color:var(--mut);min-width:130px;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.row .v{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;
  background:rgba(0,0,0,.35);border:1px solid var(--line);padding:6px 10px;border-radius:10px;
  word-break:break-all;font-size:12px;flex:1;min-width:0;color:var(--ink);font-variant-numeric:tabular-nums}
.timer{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;font-variant-numeric:tabular-nums;
  font-size:22px;font-weight:700;letter-spacing:.02em;
  background:linear-gradient(135deg,var(--acc1),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent;
  text-shadow:0 0 32px rgba(34,211,238,.18)}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 14px;border-radius:999px;
  background:var(--glass);border:1px solid var(--line);color:var(--ink);font-size:12px;font-family:inherit;cursor:pointer;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  transition:transform .16s var(--ease),border-color .16s var(--ease),background .16s var(--ease),box-shadow .16s var(--ease);
  text-decoration:none}
.btn:hover,button:hover{transform:translateY(-1px);border-color:var(--line-hi);background:var(--glass-hi);
  box-shadow:0 6px 18px rgba(34,211,238,.18),0 0 0 1px rgba(34,211,238,.12)}
.btn:active,button:active{transform:translateY(0) scale(.98)}
.btn:focus-visible,button:focus-visible{outline:none;box-shadow:0 0 0 2px rgba(34,211,238,.6),0 0 0 4px rgba(34,211,238,.18)}
.btn.primary,button.primary{background:var(--accent);color:#05070d;border-color:transparent;font-weight:600;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 6px 20px rgba(52,211,153,.25)}
.btn.primary:hover,button.primary:hover{box-shadow:inset 0 1px 0 rgba(255,255,255,.32),0 10px 26px rgba(52,211,153,.35)}
.btn.copied,button.copied{background:linear-gradient(135deg,rgba(52,211,153,.35),rgba(52,211,153,.20));border-color:rgba(52,211,153,.5);color:var(--ink)}
a{color:var(--acc1);text-decoration:none;transition:color .18s var(--ease)}
a:hover{color:var(--ink)}
a.grad{background:var(--accent);-webkit-background-clip:text;background-clip:text;color:transparent}
.active{padding:14px 16px;border-radius:14px;background:var(--glass);border:1px solid var(--line);margin-top:10px}
.active .head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.active .name{font-size:12px;color:var(--ink);font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.active .phase{font-size:10px;text-transform:uppercase;letter-spacing:.10em;color:var(--mut)}
.bar{position:relative;height:12px;background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:999px;overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;width:0%;background:var(--accent);transition:width .4s var(--ease);position:relative}
.bar i::after{content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.35) 50%,transparent 100%);
  transform:translateX(-100%);animation:sheen 2.4s var(--ease) infinite}
@keyframes sheen{to{transform:translateX(100%)}}
.spark-wrap{padding:14px 16px;border-radius:14px;background:var(--glass);border:1px solid var(--line);margin-top:10px}
.spark-wrap .head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.spark-wrap .head .lab{font-size:10px;text-transform:uppercase;letter-spacing:.10em;color:var(--mut)}
.spark-wrap .head .val{font-size:14px;font-variant-numeric:tabular-nums;color:var(--ink)}
canvas.spark{display:block;width:100%;height:56px}
.roots{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.roots .rchip{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border-radius:999px;
  background:rgba(0,0,0,.30);border:1px solid var(--line);font-size:10.5px;color:var(--ink);font-variant-numeric:tabular-nums}
.roots .rchip .p{font-size:9.5px;color:var(--mut)}
.pub{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
.pub .pdot{width:8px;height:8px;border-radius:50%;background:var(--mut)}
.pub .pdot.ok{background:var(--ok);box-shadow:0 0 10px rgba(52,211,153,.5)}
.pub .pdot.warn{background:var(--warn);box-shadow:0 0 10px rgba(251,191,36,.4)}
.pub .pdot.bad{background:var(--bad);box-shadow:0 0 10px rgba(248,113,113,.4)}
.pub .txt{font-size:11px;color:var(--mut)}
.tbl-wrap{margin-top:12px;border-radius:12px;overflow:hidden;border:1px solid var(--line);background:rgba(0,0,0,.20)}
.tbl-scroll{overflow:auto;max-height:340px}
table{width:100%;border-collapse:collapse;font-size:11.5px;font-variant-numeric:tabular-nums}
thead{position:sticky;top:0;z-index:2;background:rgba(10,14,22,.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--mut);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.10em}
tbody tr{transition:background .12s var(--ease)}
tbody tr:hover{background:rgba(255,255,255,.04)}
td.link a{background:var(--accent);-webkit-background-clip:text;background-clip:text;color:transparent}
.mini-bar{position:relative;width:70px;height:6px;background:rgba(0,0,0,.35);border-radius:999px;overflow:hidden;
  display:inline-block;vertical-align:middle;margin-right:6px}
.mini-bar i{display:block;height:100%;background:var(--accent);transition:width .3s var(--ease)}
.pctnum{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums;font-size:10.5px;color:var(--mut)}
.stag{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;border-radius:999px;display:inline-block}
.stag.done{background:rgba(52,211,153,.14);color:var(--ok);border:1px solid rgba(52,211,153,.28)}
.stag.active{background:rgba(34,211,238,.14);color:var(--acc1);border:1px solid rgba(34,211,238,.28)}
.stag.pending{background:rgba(148,163,184,.12);color:var(--mut);border:1px solid rgba(148,163,184,.24)}
.stag.failed{background:rgba(248,113,113,.14);color:var(--bad);border:1px solid rgba(248,113,113,.28)}
.stag.vanished{background:rgba(251,191,36,.14);color:var(--warn);border:1px solid rgba(251,191,36,.28)}
.stag.expired{background:rgba(148,163,184,.1);color:var(--mut);border:1px solid rgba(148,163,184,.2)}
tr.expired-row{opacity:.45}tr.expired-row td.link a{text-decoration:line-through}
.timer.ended{color:var(--bad)}
.banner.ended{display:none!important;color:var(--bad);border:1px solid rgba(248,113,113,.4);background:rgba(248,113,113,.08);padding:10px 14px;border-radius:8px;margin-top:8px;font-weight:600}
.banner.ended.show{display:block!important}
body.expired .timer{color:var(--bad)}
:root{--font-ui:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI Variable Display","Segoe UI","Sinhala Sangam MN","Nirmala UI","Iskoola Pota","Noto Sans Sinhala",Roboto,sans-serif;--font-mono:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace}
body{font-family:var(--font-ui);letter-spacing:-0.01em;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.row .v,.timer,pre.box,.pctnum,.row .v *{font-family:var(--font-mono)}
h1,h2,.topbar h1{letter-spacing:0.02em;font-weight:600}
.k,.lab,th{letter-spacing:0.06em}
.btn,.btn.primary{box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 6px 20px rgba(52,211,153,.22);backdrop-filter:blur(14px)}
.errmsg{color:var(--bad);font-size:10.5px}
.logwrap{display:flex;flex-direction:column;gap:8px}
.logwrap .head{display:flex;justify-content:space-between;align-items:center;font-size:10px;
  text-transform:uppercase;letter-spacing:.10em;color:var(--mut)}
pre.box{margin:0;padding:12px;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;
  font-size:11px;line-height:1.5;color:#9fd6b0;
  background:rgba(0,0,0,.45);border:1px solid var(--line);border-radius:12px;
  height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.20) transparent}
pre.box::-webkit-scrollbar{width:8px;height:8px}
pre.box::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:8px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,380px);gap:18px}
@media (max-width:900px){.grid{grid-template-columns:1fr}.kpi{grid-template-columns:auto repeat(3,1fr)}
  .topbar{padding:12px 14px}main{padding:16px 14px 60px}}
@media (max-width:560px){.kpi{grid-template-columns:1fr 1fr;gap:10px}.ring{width:64px;height:64px}.timer{font-size:20px}}
.toasts{position:fixed;top:16px;right:16px;z-index:80;display:flex;flex-direction:column;gap:10px;pointer-events:none}
.toast{pointer-events:auto;min-width:200px;max-width:360px;padding:10px 14px;border-radius:12px;
  background:var(--glass);border:1px solid var(--line);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  color:var(--ink);font-size:12px;box-shadow:var(--shadow);
  transform:translateX(120%);opacity:0;transition:transform .24s var(--ease),opacity .24s var(--ease)}
.toast.in{transform:translateX(0);opacity:1}
.toast.ok{border-color:rgba(52,211,153,.4)}
.toast.bad{border-color:rgba(248,113,113,.4)}
.toast.warn{border-color:rgba(251,191,36,.4)}
.drawer-scrim{position:fixed;inset:0;background:rgba(2,4,10,.55);opacity:0;pointer-events:none;
  transition:opacity .22s var(--ease);z-index:90;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(520px,92vw);z-index:100;
  background:rgba(10,14,22,.85);backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);
  border-left:1px solid var(--line);transform:translateX(100%);transition:transform .28s var(--ease);
  display:flex;flex-direction:column}
.drawer.open{transform:translateX(0)}
.drawer-scrim.open{opacity:1;pointer-events:auto}
.drawer header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
.drawer header h3{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--acc1);flex:1}
.drawer .body{padding:16px 20px;overflow:auto;flex:1}
.drawer pre{margin:0;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;font-size:11px;
  color:#c8d5e2;background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:10px;
  padding:12px;white-space:pre-wrap;word-break:break-all}
.note{color:var(--mut);font-size:11.5px;margin-top:8px;line-height:1.55}
.act{margin:12px 0 4px;display:flex;gap:10px;flex-wrap:wrap}
.skel{position:relative;overflow:hidden;background:rgba(255,255,255,.05);border-radius:6px;display:inline-block;min-height:14px;min-width:40px}
.skel::after{content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.10),transparent);
  transform:translateX(-100%);animation:shimmer 1.4s var(--ease) infinite}
@keyframes shimmer{to{transform:translateX(100%)}}
.stale{opacity:.55;filter:saturate(.6);transition:opacity .3s var(--ease),filter .3s var(--ease)}
@media (prefers-reduced-motion:reduce){
  .aurora i{animation:none!important}
  .bar i::after{animation:none!important;display:none}
  .chip.ok .dot{animation:none!important}
  .skel::after{animation:none!important;display:none}
  *{transition:none!important}
}
</style>
</head>
<body>
<div class="aurora" aria-hidden="true"><i class="a1"></i><i class="a2"></i><i class="a3"></i></div>
<div class="noise" aria-hidden="true"></div>
<header class="topbar">
  <div class="brand"><span class="brand-dot" aria-hidden="true"></span><h1>RDP Mission Control</h1></div>
  <div class="chip-row" role="status" aria-live="polite">
    <span class="chip" id="pillConn" title="Actual result of the last data fetch"><i class="dot"></i><span>connection: <span class="skel" style="width:60px"></span></span></span>
    <span class="chip" id="pillMirror" title="Mirror ON only when mirroring was enabled AND the watcher heartbeat is under 15s old"><i class="dot"></i><span>mirror: <span class="skel" style="width:40px"></span></span></span>
    <span class="chip" id="pillWatcher" title="Watcher heartbeats every 5s. ACTIVE = heartbeat younger than 15s"><i class="dot"></i><span>watcher: <span class="skel" style="width:50px"></span></span></span>
    <span class="chip" id="pillRust" title="Rust WebSocket bridge (port 7332). LIVE = /ws connected"><i class="dot"></i><span>ws: idle</span></span>
    <span class="chip" id="pillClock" title="Server-side timestamp of the data below"><i class="dot"></i><span>clock: <span class="skel" style="width:80px"></span></span></span>
  </div>
  <nav class="nav" aria-label="sections">
    <a href="#sec-conn">connection</a>
    <a href="#sec-keys">keys</a>
    <a href="#sec-mirror">mirror</a>
    <a href="#sec-log">log</a>
    <a href="#" onclick="openDrawer();return false">diag</a>
  </nav>
</header>
<main>
<p class="note" style="margin:0 0 -4px">
primary: <a id="primaryLink" class="grad" href="http://__IP__:7332/">http://__IP__:7332/</a> (Rust, realtime WS)
&nbsp;|&nbsp; fallback: <a id="fallbackLink" href="http://__IP__:7331/">http://__IP__:7331/</a> (PowerShell polling)
</p>
<div id="connBanner" class="banner">connection lost - cannot reach the dashboard server. Values below are the LAST KNOWN data and may be stale. Retrying...</div>
<div class="banner egress" id="egressLine">Uploads execute ON THE RUNNER (egress IP ...) - your PC's connection is never used for uploads.</div>
<section class="glass kpi" aria-label="key metrics">
  <div class="ring" title="honest overall percent (capped at 99.9 until done==total)">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#22d3ee"/><stop offset="55%" stop-color="#34d399"/><stop offset="100%" stop-color="#a78bfa"/>
      </linearGradient></defs>
      <circle class="track" cx="32" cy="32" r="28"/>
      <circle class="fill" id="ringFill" cx="32" cy="32" r="28" stroke-dasharray="175.93" stroke-dashoffset="175.93"/>
    </svg>
    <div class="label"><b id="stOverall">0%</b><span>overall</span></div>
    <b id="aggBar" style="position:absolute;left:-9999px;top:-9999px" aria-hidden="true">0%</b>
  </div>
  <div class="tile"><span class="lab">files</span><span class="val" id="stDone">0/0</span><span class="sub">done / total</span></div>
  <div class="tile" id="tileFailed"><span class="lab">failed</span><span class="val" id="stFailed">0</span><span class="sub">after 5 tries</span></div>
  <div class="tile"><span class="lab">bytes</span><span class="val" id="stBytes">0 B</span><span class="sub" id="stBytesSub">of 0 B</span></div>
  <div class="tile"><span class="lab">speed</span><span class="val" id="stSpeed">0 B/s</span><span class="sub">moving avg</span></div>
  <div class="tile"><span class="lab">scans</span><span class="val" id="stScans">0</span><span class="sub" id="stScansSub">last: -</span></div>
  <div class="tile"><span class="lab">eta</span><span class="val" id="stEta">-</span><span class="sub">time remaining</span></div>
</section>
<section class="glass" id="sec-conn">
  <h2>Connection</h2>
  <div class="row"><span class="k">Tailscale IP</span><span class="v" id="credIp">__IP__</span><button onclick="copyById('credIp',this)">copy</button></div>
  <div class="row"><span class="k">RDP username</span><span class="v" id="credUser">__USER__</span><button onclick="copyById('credUser',this)">copy</button></div>
  <div class="row"><span class="k">RDP password</span><span class="v" id="credPass">__PASS__</span><button onclick="copyById('credPass',this)">copy</button></div>
  <div class="row"><span class="k">mstsc command</span><span class="v" id="mstscVal">mstsc /v:__IP__</span><button onclick="copyById('mstscVal',this)">copy</button></div>
  <div class="row"><span class="k">Runner elapsed</span><span class="timer" id="timerElapsed">--:--:--</span></div>
  <div class="row"><span class="k">RDP logon age</span><span class="timer" id="timerRdpAge">--:--:--</span></div>
  <div class="row"><span class="k">Remaining (5h30 session)</span><span class="timer" id="timerRemaining">--:--:--</span></div>
  <div class="banner ended" id="endedBanner" style="display:none;">SESSION EXPIRED - GitHub hard cap reached. Runner termination imminent.</div>
  <div class="row"><span class="k">One-click RDP</span>
    <a id="ghrdpLink" class="btn primary" href="ghrdp://ip=__IP__&amp;user=__USER__&amp;pass=__PASS__" onclick="return openRdp(event)">open RDP via ghrdp://</a>
    <button onclick="showInstall()">handler help</button>
  </div>
</section>
<section class="glass" id="installPanel" style="display:none">
  <h2>ghrdp:// setup &amp; fallback</h2>
  <div class="note" id="installDetected">The ghrdp:// protocol handler is not installed on this PC (the browser shows the request as canceled).</div>
  <div class="note"><b>Option A</b> - on YOUR PC run:</div>
  <div class="row"><span class="v" id="instCmd">irm http://__IP__:7331/install.ps1 | iex</span><button onclick="copyById('instCmd',this)">copy</button></div>
  <div class="note"><b>Option B</b> - download <a href="/install.ps1">install.ps1</a>, run it locally, then <a id="retryLink" href="ghrdp://ip=__IP__&amp;user=__USER__&amp;pass=__PASS__" onclick="return openRdp(event)">retry the ghrdp:// link</a>.</div>
  <div class="note"><b>Option C</b> - use the mstsc command above (no install needed). Log on YOUR PC: <span style="font-family:ui-monospace,Consolas,monospace">%LOCALAPPDATA%\ghrdp\ghrdp-connect.log</span></div>
</section>
<section class="glass" id="sec-keys">
  <h2>Indexes &amp; keys</h2>
  <div class="row"><span class="k">Mirror (github.io)</span><a id="pagesLink" href="javascript:void(0)">(pages base)</a><button onclick="copyText(document.getElementById('pagesLink').textContent,this)">copy</button></div>
  <div class="row"><span class="k">Legacy Rentry (frozen)</span><a id="legacyLink" href="https://rentry.co/myurl0">https://rentry.co/myurl0</a><button onclick="copyText(document.getElementById('legacyLink').textContent,this)">copy</button></div>
  <div class="row"><span class="k">LEGACY key</span><span class="v" id="legacyKey">...</span><button onclick="copyById('legacyKey',this)">copy</button><span class="note">decrypt key for files uploaded before this run</span></div>
  <div class="row"><span class="k">New Rentry</span><a id="rentryNew" href="javascript:void(0)">(not created yet)</a><button onclick="copyText(document.getElementById('rentryNew').textContent,this)">copy</button></div>
  <div class="row"><span class="k">Telegraph</span><a id="telegraphLink" href="javascript:void(0)">__TELEGRAPH__</a><button onclick="copyText(document.getElementById('telegraphLink').textContent,this)">copy</button></div>
  <div class="row"><span class="k">Current key</span><span class="v" id="mirrorKey">__MIRRORKEY__</span><button onclick="copyById('mirrorKey',this)">copy</button><span class="note">decrypt key for THIS run's uploads</span></div>
  <div class="row" id="decryptRow" style="display:none"><span class="k">Decryptor</span><a id="decryptLink" href="javascript:void(0)" target="_blank">-</a><button onclick="copyText(document.getElementById('decryptLink').href,this)">copy</button></div>
  <div class="row" id="archiveRow" style="display:none"><span class="k">Archive</span><a id="archiveLink" href="javascript:void(0)" target="_blank">-</a><button onclick="copyText(document.getElementById('archiveLink').href,this)">copy</button></div>
  <div class="row" id="searchRow" style="display:none"><span class="k">File Search</span><a id="searchLink" href="javascript:void(0)" target="_blank">-</a><button onclick="copyText(document.getElementById('searchLink').href,this)">copy</button></div>
  <div class="row" id="explorerRow" style="display:none"><span class="k">Explorer (Win11)</span><a id="explorerLink" href="javascript:void(0)" target="_blank">-</a><button onclick="copyText(document.getElementById('explorerLink').href,this)">copy</button></div>
</section>
<div class="grid">
<section class="glass" id="sec-mirror">
  <h2>Mirror - AES-256 encrypted upload</h2>
  <div class="active" aria-label="active file">
    <div class="head"><span class="name" id="activeName">idle - no active file</span><span class="phase" id="activePhase">-</span></div>
    <div class="bar" title="active file progress"><i id="activeBar" style="width:0%"></i></div>
    <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--mut);margin-top:6px;font-variant-numeric:tabular-nums">
      <span id="activeBytes">0 B / 0 B</span><span id="activePct">0%</span>
    </div>
  </div>
  <div class="spark-wrap">
    <div class="head"><span class="lab">Speed history - last 90 samples (7.5 min @ 5s)</span><span class="val" id="sparkNow">0 B/s</span></div>
    <canvas class="spark" id="sparkline" width="800" height="112"></canvas>
  </div>
  <div class="pub"><span class="pdot" id="pubDot"></span><span class="txt" id="pubTxt">Publish status: unknown</span></div>
  <div class="roots" id="rootsWrap" aria-label="per-root telemetry"></div>
  <div class="act">
    <button class="primary" onclick="doFlush(this)">Upload everything now</button>
    <button onclick="doLaunch(this)">Start watcher</button>
    <button onclick="doDiag()">Diagnose</button>
    <button onclick="copyAllLinks(this)">Copy all links</button>
  </div>
  <div class="tbl-wrap"><div class="tbl-scroll">
    <table>
      <thead><tr><th>file</th><th>phase</th><th style="min-width:120px">progress</th><th>size</th><th>status</th><th>error</th><th>link</th></tr></thead>
      <tbody id="fileRows"><tr><td colspan="7" style="color:var(--mut);text-align:center;padding:18px">waiting for watcher...</td></tr></tbody>
    </table>
  </div></div>
</section>
<section class="glass" id="sec-log">
  <div class="logwrap">
    <div class="head"><span>Live log - last 200 lines</span>
      <div style="display:flex;gap:6px">
        <button onclick="copyLog(this)" title="copy log">copy</button>
        <button onclick="toggleLogPause(this)" id="logPauseBtn" title="pause auto-scroll">pause</button>
      </div>
    </div>
    <pre class="box" id="logBox" tabindex="0"></pre>
  </div>
</section>
</div>
</main>
<div class="toasts" id="toasts" aria-live="polite" aria-atomic="false"></div>
<div class="drawer-scrim" id="drawerScrim" onclick="closeDrawer()"></div>
<aside class="drawer" id="drawer" aria-hidden="true">
  <header>
    <h3>Diagnostics</h3>
    <button onclick="doDiag()" title="refresh">refresh</button>
    <button onclick="copyText((document.getElementById('diagBox')||{}).textContent||'',this)">copy</button>
    <button onclick="closeDrawer()">close</button>
  </header>
  <div class="body"><pre id="diagBox">click Refresh to run /diag on the server.</pre></div>
</aside>
<script>
var lastData=null,lostCount=0,ws=null,wsTimer=null,wsAlive=false,pollTimer=null;
var clockOffsetMs=0,runStartedAtMs=null,sessionStartedAtMs=null;
var speedHist=[],logPaused=false,firstRenderDone=false,ghrdpUrl='';
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];})}
function nowMs(){return (new Date()).getTime()}
function parseTs(s){if(!s)return NaN;s=String(s).trim();if(/Z$|[+-]\d{2}:\d{2}$/.test(s))return Date.parse(s);var m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[ T](\d{1,2}):(\d{2}):(\d{2})/);if(m)return Date.UTC(+m[3],+m[1]-1,+m[2],+m[4],+m[5],+m[6]);var t=Date.parse(s+'Z');return isNaN(t)?Date.parse(s):t;}
function fmtBytes(n){n=Number(n)||0;if(n<1024)return n.toFixed(0)+' B';var u=['KB','MB','GB','TB','PB'],i=-1;do{n/=1024;i++;}while(n>=1024&&i<u.length-1);return n.toFixed(n>=100?0:(n>=10?1:2))+' '+u[i]}
function fmtSpeed(n){return fmtBytes(n)+'/s'}
function fmtDurShort(s){s=Math.max(0,Math.floor(Number(s)||0));if(s<60)return s+'s';var m=Math.floor(s/60),ss=s%60;if(m<60)return m+'m '+ss+'s';var h=Math.floor(m/60);m=m%60;if(h<24)return h+'h '+m+'m';var d=Math.floor(h/24);h=h%24;return d+'d '+h+'h'}
function pad2(n){n=String(n);return n.length<2?'0'+n:n}
function toast(msg,kind){var t=document.createElement('div');t.className='toast '+(kind||'');t.textContent=msg;var stack=$('toasts');stack.appendChild(t);requestAnimationFrame(function(){t.classList.add('in')});setTimeout(function(){t.classList.remove('in');setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t)},280)},2600)}
function flashBtn(btn,msg){if(!btn)return;if(!btn.getAttribute('data-orig'))btn.setAttribute('data-orig',btn.textContent);btn.textContent=msg;btn.classList.add('copied');setTimeout(function(){btn.textContent=btn.getAttribute('data-orig');btn.classList.remove('copied')},1400)}
function legacyCopy(text,btn){var ok=false;try{var ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','readonly');ta.style.position='fixed';ta.style.left='-9999px';document.body.appendChild(ta);ta.focus();ta.select();ok=document.execCommand('copy');document.body.removeChild(ta)}catch(e){ok=false}if(ok){flashBtn(btn,'copied');toast('Copied','ok')}else{flashBtn(btn,'copy manually');window.prompt('Clipboard blocked - copy with Ctrl+C:',text);toast('Copy fallback opened','warn')}}
function copyText(text,btn){text=String(text||'');if(!text){flashBtn(btn,'nothing');toast('Nothing to copy','warn');return}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){flashBtn(btn,'copied');toast('Copied','ok')},function(){legacyCopy(text,btn)});return}legacyCopy(text,btn)}
function copyById(id,btn){var el=$(id);if(el)copyText(el.textContent,btn)}
function copyLog(btn){copyText($('logBox').textContent,btn)}
function copyAllLinks(btn){var out=[];if(lastData){if(lastData.legacyIndexUrl)out.push('LEGACY RENTRY: '+lastData.legacyIndexUrl);if(lastData.rentryNewUrl)out.push('NEW RENTRY: '+lastData.rentryNewUrl);if(lastData.mirrorIndexUrl)out.push('TELEGRAPH: '+lastData.mirrorIndexUrl);var fl=lastData.files||[];for(var i=0;i<fl.length;i++){if(fl[i].link)out.push(fl[i].name+': '+fl[i].link)}}if(out.length===0){flashBtn(btn,'no links yet');toast('No links yet','warn');return}copyText(out.join('\n'),btn)}
async function getJson(url){try{var r=await fetch(url,{cache:'no-store'});if(!r.ok)return null;return await r.json()}catch(e){return null}}
async function doFlush(btn){flashBtn(btn,'...');await getJson('/launch');var d=await getJson('/flush');if(d&&d.ok){toast('Flush requested - watcher will upload everything','ok')}else{toast('Flush failed - server not reachable','bad')}}
async function doLaunch(btn){flashBtn(btn,'...');var d=await getJson('/launch');if(d&&d.ok){toast('Watcher start requested','ok')}else{toast('Launch failed - server not reachable','bad')}}
async function doDiag(){openDrawer();var db=$('diagBox');db.textContent='running /diag...';var d=await getJson('/diag');db.textContent=d?JSON.stringify(d,null,2):'Diagnostics failed - server not reachable.'}
function openDrawer(){$('drawer').classList.add('open');$('drawer').setAttribute('aria-hidden','false');$('drawerScrim').classList.add('open')}
function closeDrawer(){$('drawer').classList.remove('open');$('drawer').setAttribute('aria-hidden','true');$('drawerScrim').classList.remove('open')}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDrawer()});
function openRdp(ev){if(!ghrdpUrl){showInstall('Cannot build the ghrdp:// link yet - wait for live data.');return true}var wasFocused=true;var lost=function(){wasFocused=false};window.addEventListener('blur',lost);var visLost=function(){if(document.hidden)wasFocused=false};document.addEventListener('visibilitychange',visLost);setTimeout(function(){window.removeEventListener('blur',lost);document.removeEventListener('visibilitychange',visLost);if(wasFocused)showInstall('ghrdp:// handler NOT detected (this page kept focus after firing the link - the browser logged the request as canceled). Install it below or use the mstsc command.')},700);return true}
function showInstall(msg){var p=$('installPanel');if(msg){var d=$('installDetected');if(d)d.textContent=msg}p.style.display='block';try{p.scrollIntoView({behavior:'smooth',block:'center'})}catch(e){}}
function chip(id,text,cls){var p=$(id);if(!p)return;p.className='chip '+(cls||'');p.innerHTML='<i class="dot"></i><span>'+esc(text)+'</span>'}
(function(){var box=$('logBox');if(!box)return;box.addEventListener('mouseenter',function(){logPaused=true});box.addEventListener('mouseleave',function(){logPaused=false})})();
function toggleLogPause(btn){logPaused=!logPaused;btn.textContent=logPaused?'resume':'pause';btn.classList.toggle('copied',logPaused)}
function drawSpark(samples){var cv=$('sparkline');if(!cv)return;var dpr=window.devicePixelRatio||1;var cssW=cv.clientWidth||800,cssH=cv.clientHeight||56;if(cv.width!==Math.floor(cssW*dpr)||cv.height!==Math.floor(cssH*dpr)){cv.width=Math.floor(cssW*dpr);cv.height=Math.floor(cssH*dpr)}var ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,cssW,cssH);if(!samples||samples.length===0){ctx.fillStyle='rgba(148,163,184,.55)';ctx.font='11px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('no samples yet',cssW/2,cssH/2);return}var maxV=1;for(var i=0;i<samples.length;i++){if(samples[i]>maxV)maxV=samples[i]}var padL=4,padR=4,padT=4,padB=6;var w=cssW-padL-padR,h=cssH-padT-padB;var n=samples.length;var pts=[];for(var j=0;j<n;j++){var x=padL+(n===1?w/2:(j*w/(n-1)));var y=padT+h-(samples[j]/maxV)*h;pts.push([x,y])}var g=ctx.createLinearGradient(0,padT,0,padT+h);g.addColorStop(0,'rgba(34,211,238,.32)');g.addColorStop(1,'rgba(34,211,238,0)');ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(pts[0][0],padT+h);for(var k=0;k<pts.length;k++)ctx.lineTo(pts[k][0],pts[k][1]);ctx.lineTo(pts[pts.length-1][0],padT+h);ctx.closePath();ctx.fill();var sg=ctx.createLinearGradient(0,0,cssW,0);sg.addColorStop(0,'#22d3ee');sg.addColorStop(.55,'#34d399');sg.addColorStop(1,'#a78bfa');ctx.strokeStyle=sg;ctx.lineWidth=1.8;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);for(var m=1;m<pts.length;m++)ctx.lineTo(pts[m][0],pts[m][1]);ctx.stroke();var last=pts[pts.length-1];ctx.fillStyle='#a78bfa';ctx.beginPath();ctx.arc(last[0],last[1],2.4,0,Math.PI*2);ctx.fill()}
var RING_C=2*Math.PI*28;
function setRing(pct){var fill=$('ringFill');if(!fill)return;var p=Math.max(0,Math.min(100,Number(pct)||0));fill.setAttribute('stroke-dashoffset',(RING_C*(1-p/100)).toFixed(2))}
function render(d){
  var banner=$('connBanner');
  if(!d){lostCount++;if(lostCount>=2){banner.style.display='block';document.body.classList.add('stale');chip('pillConn','connection: LOST (retrying)','bad')}return}
  lostCount=0;banner.style.display='none';document.body.classList.remove('stale');
  chip('pillConn','connection: live','ok');lastData=d;
  if(d.serverTs){var st=parseTs(d.serverTs);if(!isNaN(st))clockOffsetMs=st-nowMs()}
  var c=d.creds||{};
  if(c.ip){$('credIp').textContent=c.ip;$('mstscVal').textContent='mstsc /v:'+c.ip;$('instCmd').textContent='irm http://'+c.ip+':7331/install.ps1 | iex';var pl=$('primaryLink');if(pl){pl.textContent='http://'+c.ip+':7332/';pl.href='http://'+c.ip+':7332/'}var fl=$('fallbackLink');if(fl){fl.textContent='http://'+c.ip+':7331/';fl.href='http://'+c.ip+':7331/'}}
  if(c.user)$('credUser').textContent=c.user;
  if(c.pass)$('credPass').textContent=c.pass;
  if(c.ip&&c.user){
    ghrdpUrl='ghrdp://ip='+encodeURIComponent(c.ip)+'&user='+encodeURIComponent(c.user)+'&pass='+encodeURIComponent(c.pass||'');
    var a1=$('ghrdpLink');if(a1)a1.href=ghrdpUrl;
    var a2=$('retryLink');if(a2)a2.href=ghrdpUrl;
  }
  if(d.runnerEgressIp){
    $('egressLine').textContent='Uploads execute ON THE RUNNER (egress IP '+d.runnerEgressIp+') - your PC\'s connection is never used for uploads.';
    $('egressLine').className='banner egress';
  } else {
    $('egressLine').textContent='egress IP unknown (lookup failed) - uploads still run on the runner';
  }
  if(d.legacyIndexUrl){var ll=$('legacyLink');ll.textContent=d.legacyIndexUrl;ll.href=d.legacyIndexUrl;}
  if(d.legacyDecryptKey){$('legacyKey').textContent=d.legacyDecryptKey;}
  var rn=$('rentryNew');
  if(d.rentryNewUrl){rn.textContent=d.rentryNewUrl;rn.href=d.rentryNewUrl;}else{rn.textContent='(not created yet)';rn.href='javascript:void(0)';}
  var tl=$('telegraphLink');
  if(d.mirrorIndexUrl){tl.textContent=d.mirrorIndexUrl;tl.href=d.mirrorIndexUrl;}else{tl.textContent='(not created yet)';tl.href='javascript:void(0)';}
  if(d.mirrorKey){$('mirrorKey').textContent=d.mirrorKey;}
  if(d.pagesBase){var pb=d.pagesBase;var pl2=$('pagesLink');if(pl2){pl2.textContent=pb;pl2.href=pb;}var dr=$('decryptRow');if(dr){dr.style.display='';var dl=$('decryptLink');dl.href=pb+'/decrypt.html';dl.textContent='Web Decryptor';}var ar=$('archiveRow');if(ar){ar.style.display='';var al=$('archiveLink');al.href=pb+'/archive.html';al.textContent='Session Archive';}var sr=$('searchRow');if(sr){sr.style.display='';var sl=$('searchLink');sl.href=pb+'/search.html';sl.textContent='File Search';}var xr=$('explorerRow');if(xr){xr.style.display='';var xl=$('explorerLink');xl.href=pb+'/explorer.html';xl.textContent='GHRDP Explorer (Win11)';}}
  if(!runStartedAtMs&&d.runStartedAt){var rs=parseTs(d.runStartedAt);if(!isNaN(rs))runStartedAtMs=rs;}
  else if(!runStartedAtMs&&d.startedAt){var rs2=parseTs(d.startedAt);if(!isNaN(rs2))runStartedAtMs=rs2;}
  if(!sessionStartedAtMs&&d.sessionStartedAt){var ss=parseTs(d.sessionStartedAt);if(!isNaN(ss))sessionStartedAtMs=ss;}
  var pData = d.progress || d;
  var watcherStarted = (pData.alive || (pData.agg && (Number(pData.agg.total)||0) > 0) || (pData.telemetry && Number(pData.telemetry.scans) > 0));
  if (d.mirror === false) {
    chip('pillMirror','mirror: OFF','bad');
  } else {
    if(pData.alive && watcherStarted){chip('pillMirror','mirror: ON','ok');}
    else if(pData.alive){chip('pillMirror','mirror: WAITING','warn');}
    else{chip('pillMirror','mirror: ON (waiting)','warn');}
  }
  if (!watcherStarted) {
    chip('pillWatcher','watcher: not started','bad');
  } else {
    var tsMs=Date.parse(pData.ts||'');
    var age=null;
    var serverNow = nowMs() + clockOffsetMs;
    if(!isNaN(tsMs))age=Math.max(0,Math.round((serverNow - tsMs)/1000));
    var running=false,label='not started';
    if(pData.alive){
      if(age!==null&&age<15){running=true;label='ACTIVE';}
      else{label='STALE ('+(age===null?'?':age+'s')+')';}
    } else if(pData.agg&&(Number(pData.agg.total)||0)>0){label='stopped';}
    chip('pillWatcher','watcher: '+label,running?'ok':'bad');
  }
  chip('pillClock','clock: '+String(pData.ts||'never').replace('T',' ').substring(0,19),'');
  var agg=pData.agg||{};
  var tot=Number(agg.total)||0,dn=Number(agg.done)||0;
  var pct=tot>0?Math.min(dn/tot*100,dn===tot?100:99.9):0;
  $('stOverall').textContent=pct.toFixed(1)+'%';
  setRing(pct);
  $('stDone').textContent=dn+'/'+tot;
  $('stFailed').textContent=String(Number(agg.failed)||0);
  $('stBytes').textContent=fmtBytes(agg.bytesDone);
  $('stBytesSub').textContent='of '+fmtBytes(agg.bytesTotal);
  var spd = Number(agg.speedBps)||0;
  $('stSpeed').textContent=fmtSpeed(spd);
  var hs=(d.speedHistory&&d.speedHistory.length)?d.speedHistory.slice(-90):null;
  if(hs){speedHist=hs;}else{speedHist.push(spd);if(speedHist.length>90)speedHist.shift();}
  drawSpark(speedHist);
  $('sparkNow').textContent=fmtSpeed(spd);
  var t=pData.telemetry||{};
  $('stScans').textContent=String(Number(t.scans)||0);
  $('stScansSub').textContent='last: '+(t.lastScan?String(t.lastScan).substring(11,19):'-');
  if(spd > 0 && tot > dn){
    var remBytes = (Number(agg.bytesTotal)||0) - (Number(agg.bytesDone)||0);
    var etaSec = remBytes / spd;
    $('stEta').textContent=fmtDurShort(etaSec);
  } else {
    $('stEta').textContent = dn===tot && tot>0 ? 'done' : '-';
  }
  var act=pData.active||{};
  if(act && act.name){
    $('activeName').textContent=act.name;
    $('activePhase').textContent=act.phase||'-';
    var apct = Number(act.pct)||0;
    $('activeBar').style.width=apct+'%';
    $('activeBytes').textContent=fmtBytes(act.bytesDone)+' / '+fmtBytes(act.bytesTotal);
    $('activePct').textContent=apct.toFixed(0)+'%';
  } else {
    $('activeName').textContent='idle - no active file';
    $('activePhase').textContent='-';
    $('activeBar').style.width='0%';
    $('activeBytes').textContent='0 B / 0 B';
    $('activePct').textContent='0%';
  }
  var roots = t.roots || [];
  var rw=$('rootsWrap');
  if(roots && roots.length>0){
    var rhtml='';
    for(var ri=0;ri<roots.length;ri++){
      rhtml+='<span class="rchip"><span class="p">root:</span> '+esc(roots[ri])+'</span>';
    }
    rw.innerHTML=rhtml;
  } else { rw.innerHTML=''; }
  var pubDot=$('pubDot'), pubTxt=$('pubTxt');
  if(d.mirrorIndexUrl || d.rentryNewUrl){
    pubDot.className='pdot ok'; pubTxt.textContent='Indexes published';
  } else if(d.mirror) {
    pubDot.className='pdot warn'; pubTxt.textContent='Waiting for first upload...';
  } else {
    pubDot.className='pdot'; pubTxt.textContent='Mirror disabled';
  }
  var files=pData.files||[];
  var rows=$('fileRows');
  if(files.length===0){
    rows.innerHTML='<tr><td colspan="7" style="color:var(--mut);text-align:center;padding:18px">no files processed yet</td></tr>';
  } else {
    var html='';
    for(var i=0;i<Math.min(files.length,50);i++){
      var f=files[i];
      var pf=Number(f.pct)||0;
      if(f.status==='active'&&act.name&&act.name===f.name)pf=Number(act.pct)||pf;
      var isExpired=f.status==='expired';
      var linkCell=isExpired?('<span class="stag expired">expired</span>'):f.link?('<a href="'+esc(f.link)+'" target="_blank">open</a>'):'-';
      var errCell=f.error?('<span class="errmsg" title="'+esc(f.error)+'">'+esc(f.error).substring(0,40)+'</span>'):'-';
      var statusClass = f.status || 'pending';
      html+='<tr'+(isExpired?' class="expired-row"':'')+'><td>'+esc(f.name)+'</td><td>'+esc(f.phase)+'</td><td><span class="mini-bar"><i style="width:'+pf+'%"></i></span><span class="pctnum">'+pf.toFixed(0)+'%</span></td><td>'+fmtBytes(f.size)+'</td><td><span class="stag '+esc(statusClass)+'">'+esc(statusClass)+'</span></td><td>'+errCell+'</td><td class="link">'+linkCell+'</td></tr>';
    }
    rows.innerHTML=html;
  }
  if(!logPaused){
    var logBox=$('logBox');
    var logs = pData.log || [];
    logBox.textContent = logs.join('\n');
    logBox.scrollTop = logBox.scrollHeight;
  }
  if(!firstRenderDone){
    firstRenderDone=true;
    if(wsLive) connectWs();
  }
}
function serverNow(){return nowMs()+clockOffsetMs;}
async function poll(){render(await getJson('/api/progress'))}
async function probeHealth(){
  var ctrl=(typeof AbortController!=='undefined')?new AbortController():null;
  var timer=ctrl?setTimeout(function(){ctrl.abort();},3000):null;
  try{
    var r=await fetch('/health',{cache:'no-store',signal:ctrl?ctrl.signal:undefined});
    if(timer)clearTimeout(timer);
    if(!r.ok){setRust(false);return;}
    var j=await r.json();
    setRust(!!(j && j.ok===true && j.ws===true));
  }catch(e){
    if(timer)clearTimeout(timer);
    setRust(false);
  }
}
function setRust(live){
  wsLive=live;
  var p=$('pillRust');
  if(live){p.innerHTML='<i class="dot"></i><span>ws: live</span>';p.className='chip ok';}
  else{p.innerHTML='<i class="dot"></i><span>ws: idle</span>';p.className='chip';}
}
function connectWs(){
  if(!wsLive)return;
  try{ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');}catch(e){return;}
  ws.onopen=function(){var p=$('pillRust');p.innerHTML='<i class="dot"></i><span>ws: live</span>';p.className='chip ok';};
  ws.onmessage=function(evt){try{render(JSON.parse(evt.data));}catch(e){}};
  ws.onclose=function(){probeHealth();setTimeout(function(){if(wsLive)connectWs();},2000);};
  ws.onerror=function(){};
}
probeHealth();
setInterval(probeHealth,30000);
setInterval(poll,3000);
poll();
var HARD_CAP_MS=21420000;var SESSION_WINDOW_MS=19800000;
function fmtHMS(s){s=Math.max(0,Math.floor(s));var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return pad2(h)+':'+pad2(m)+':'+pad2(ss);}
function tickTimers(){
  var now=serverNow();
  var te=$('timerElapsed'),tr=$('timerRemaining'),ta=$('timerRdpAge');
  if(runStartedAtMs){
    var elSec=(now-runStartedAtMs)/1000;
    if(te)te.textContent=fmtHMS(elSec);
    var remSec=Math.max(0,SESSION_WINDOW_MS/1000-elSec);
    if(tr)tr.textContent=fmtHMS(remSec);
    var expired=remSec<=0;
    var eb=$('endedBanner');
    if(eb){
      eb.classList.toggle('show',expired);
      if(expired){eb.textContent=(window.__ghrdpLang&&window.__ghrdpLang()==='si')?'⚠️ සැසිය අවසන් - පැය 5:30 සැසි කවුළුව ඉකුත් විය; ධාවක පිරිසිදු කිරීම ආසන්නයි.':'⚠️ SESSION EXPIRED - 5h30 session window elapsed; runner cleanup imminent.';}
    }
    document.body.classList.toggle('expired',expired);
  }else{
    if(te)te.textContent='--:--:--';
    if(tr)tr.textContent=fmtHMS(SESSION_WINDOW_MS/1000);
    var eb2=$('endedBanner');if(eb2)eb2.classList.remove('show');
    document.body.classList.remove('expired');
  }
  if(ta){if(sessionStartedAtMs){ta.textContent=fmtHMS(Math.max(0,(now-sessionStartedAtMs)/1000));}else{ta.textContent='--:--:--';}}
}
setInterval(tickTimers,1000);tickTimers();
(function(){
var I18N={
'Runner elapsed':'ධාවක ගත වූ කාලය',
'RDP logon age':'RDP පිවිසුම් වයස',
'Remaining (5h30 session)':'ඉතිරි (පැය 5:30 සැසිය)',
'Connection':'සම්බන්ධතාවය',
'Tailscale IP':'Tailscale IP',
'RDP username':'RDP පරිශීලක නාමය',
'RDP password':'RDP මුරපදය',
'mstsc command':'mstsc විධානය',
'One-click RDP':'එක-ක්ලික් RDP',
'Files':'ගොනු','Speed':'වීගය','Scans':'ස්කෑන්','ETA':'ETA','Overall':'සමස්ත'
};
var LANG=localStorage.getItem('ghrdp:lang')||'en';
window.__ghrdpLang=function(){return LANG;};
function applyLang(){
  var els=document.querySelectorAll('.k,.lab,h2,th');
  for(var i=0;i<els.length;i++){
    var el=els[i];
    if(!el.hasAttribute('data-en'))el.setAttribute('data-en',el.textContent.trim());
    var en=el.getAttribute('data-en');
    if(LANG==='si'&&I18N[en])el.textContent=I18N[en];
    else if(LANG==='en')el.textContent=en;
  }
  document.documentElement.lang=LANG;
  var b=$('langToggle');if(b)b.textContent=(LANG==='si')?'EN':'සිං';
}
var tb=document.createElement('button');tb.id='langToggle';tb.className='btn';tb.style.marginLeft='8px';
tb.onclick=function(){LANG=(LANG==='si')?'en':'si';localStorage.setItem('ghrdp:lang',LANG);applyLang();};
var nav=document.querySelector('.topbar .nav')||document.querySelector('.topbar');
if(nav)nav.appendChild(tb);
applyLang();
setInterval(applyLang,3000);
})();
</script>
</body>
</html>
"##;
