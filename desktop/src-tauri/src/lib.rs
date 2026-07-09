// Webwing 데스크톱 셸: node 사이드카(server.mjs)를 스폰하고, 뜨면 창을 그 주소로 이동.
// 프로토타입 단계 — 시스템 node 사용(사이드카 바이너리 동봉·서명은 나중 단계).
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WindowEvent};

struct Sidecar(Mutex<Option<Child>>);

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

            eprintln!("[webwing] node {} (data={})", server_entry.display(), data_dir.display());
            let spawn = Command::new("node")
                .arg(&server_entry)
                .current_dir(&server_root)
                .env("WEBPILOT_DATA_DIR", &data_dir)
                .spawn();
            match spawn {
                Ok(child) => *app.state::<Sidecar>().0.lock().unwrap() = Some(child),
                Err(e) => eprintln!("[webwing] node 사이드카 실행 실패: {e} — Node.js가 설치되어 있는지 확인하세요"),
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
                                "document.getElementById('msg').textContent='서버 시작 실패 — Node.js 설치를 확인해주세요.'",
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
                if let Some(mut child) = window.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
