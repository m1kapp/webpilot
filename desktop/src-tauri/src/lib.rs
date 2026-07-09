// Webwing 데스크톱 셸: 동봉된 node 사이드카로 server.mjs를 띄우고, 뜨면 창을 그 주소로 이동.
// node 런타임 자체를 앱에 동봉하므로 사용자 PC에 Node.js가 없어도 됨(externalBin 사이드카).
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct Sidecar(Mutex<Option<CommandChild>>);

// production(번들): resource_dir에 server.mjs가 동봉됨. dev(cargo tauri dev): 옆 프로젝트 루트를 그대로 참조.
fn resolve_server_root(app: &tauri::App) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        if res.join("server.mjs").exists() {
            return res;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let app_handle = app.handle().clone();
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("앱 데이터 폴더를 확인할 수 없습니다");
            std::fs::create_dir_all(&data_dir).ok();

            let server_root = resolve_server_root(app);
            let server_entry = server_root.join("server.mjs");
            let port_file = data_dir.join(".tmp").join("webwing.port");
            let _ = std::fs::remove_file(&port_file); // 이전 실행 잔재 제거 — 새 포트 오검출 방지

            eprintln!(
                "[webwing] sidecar node {} (data={})",
                server_entry.display(),
                data_dir.display()
            );
            let sidecar = app
                .shell()
                .sidecar("node")
                .expect("node 사이드카를 찾을 수 없습니다 (externalBin 설정 확인)")
                .arg(server_entry.to_string_lossy().to_string())
                .env("WEBPILOT_DATA_DIR", data_dir.to_string_lossy().to_string());
            match sidecar.spawn() {
                Ok((mut rx, child)) => {
                    *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
                    // 사이드카 stdout/stderr를 그대로 앱 로그에 흘려보냄(문제 진단용)
                    tauri::async_runtime::spawn(async move {
                        use tauri_plugin_shell::process::CommandEvent;
                        while let Some(event) = rx.recv().await {
                            match event {
                                CommandEvent::Stdout(line) => {
                                    eprint!("[node] {}", String::from_utf8_lossy(&line))
                                }
                                CommandEvent::Stderr(line) => {
                                    eprint!("[node:err] {}", String::from_utf8_lossy(&line))
                                }
                                CommandEvent::Error(e) => eprintln!("[node:spawn-error] {e}"),
                                _ => {}
                            }
                        }
                    });
                }
                Err(e) => eprintln!("[webwing] node 사이드카 실행 실패: {e}"),
            }

            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(25);
                loop {
                    if let Ok(text) = std::fs::read_to_string(&port_file) {
                        if let Ok(port) = text.trim().parse::<u16>() {
                            let url = format!("http://127.0.0.1:{port}");
                            if let Some(win) = app_handle.get_webview_window("main") {
                                if let Ok(u) = url.parse() {
                                    let _ = win.navigate(u);
                                }
                            }
                            return;
                        }
                    }
                    if Instant::now() >= deadline {
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.eval(
                                "document.getElementById('msg').textContent='서버 시작 실패 — 앱을 다시 설치해보세요.'",
                            );
                        }
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(300));
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // 창 닫힘 = 앱 종료. 백그라운드에 남은 node 사이드카(+ 크롬)를 같이 정리해 좀비 방지.
            if let WindowEvent::Destroyed = event {
                if let Some(child) = window.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
