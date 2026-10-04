// DriveGuardian - Tauri backend entry point
// Phase 1: drive enumeration + shelling out to the Python scanner core.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use sysinfo::{Disks, System};
use std::process::{Command, Stdio};
use std::path::PathBuf;
use std::io::{BufRead, BufReader};
use std::sync::Mutex;
use tauri::Manager;

/// Tracks the PID of whatever long-running Python process (scan or
/// duplicate-find) is currently active, so the frontend can cancel it
/// cleanly instead of the user having to force-close the whole app.
struct AppState {
    running_pid: Mutex<Option<u32>>,
    low_space_threshold: Mutex<f64>,       // percent free, alert below this
    alerted_drives: Mutex<std::collections::HashSet<String>>, // avoid repeat alerts every cycle
}

#[cfg(target_os = "windows")]
fn kill_pid(pid: u32) {
    // /T kills the whole process tree (Python may have no children here,
    // but this is safer if that ever changes), /F forces it.
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

#[cfg(not(target_os = "windows"))]
fn kill_pid(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
}

#[tauri::command]
fn cancel_running_task(state: tauri::State<AppState>) -> bool {
    let mut guard = state.running_pid.lock().unwrap();
    if let Some(pid) = guard.take() {
        kill_pid(pid);
        true
    } else {
        false
    }
}

/// Resolves the absolute path to core/scanner/scanner.py regardless of the
/// working directory the Tauri process happens to be launched from.
/// CARGO_MANIFEST_DIR is baked in at compile time as .../apps/desktop/src-tauri,
/// so we walk up to the repo root and back down into core/.
fn scanner_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // .../apps/desktop/src-tauri
    manifest_dir
        .parent().expect("missing apps/desktop")   // .../apps/desktop
        .parent().expect("missing apps")            // .../apps
        .parent().expect("missing repo root")        // repo root
        .join("core").join("scanner").join("scanner.py")
}

#[derive(Serialize)]
struct DriveInfo {
    name: String,
    mount_point: String,
    total_space: u64,
    available_space: u64,
    is_removable: bool,
}

#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    let disks = Disks::new_with_refreshed_list();
    disks
        .iter()
        .map(|d| DriveInfo {
            name: d.name().to_string_lossy().to_string(),
            mount_point: d.mount_point().to_string_lossy().to_string(),
            total_space: d.total_space(),
            available_space: d.available_space(),
            is_removable: d.is_removable(),
        })
        .collect()
}

/// Starts the Python scanner as a child process and streams each stderr
/// progress line to the frontend as a "scan-progress" event, so the UI
/// never sits frozen with no feedback during a long scan. Emits
/// "scan-complete" with the final JSON summary from stdout, or
/// "scan-error" if the process fails. Returns immediately (fire-and-forget)
/// — the frontend listens for events.
#[tauri::command]
fn scan_drive(window: tauri::Window, drive: String) {
    let app_handle = window.app_handle();
    std::thread::spawn(move || {
        let state = app_handle.state::<AppState>();

        if cfg!(debug_assertions) {
            let child = Command::new("python")
                .arg(scanner_path())
                .arg("scan")
                .arg(&drive)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn();

            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    let _ = window.emit("scan-error", format!("Failed to launch scanner: {e}"));
                    return;
                }
            };

            *state.running_pid.lock().unwrap() = Some(child.id());

            // Progress lines (JSON, one per update) come on stderr; the single
            // final result JSON comes on stdout. Reading them on separate
            // threads means there's no ambiguity about which line is which.
            let stderr = child.stderr.take().expect("no stderr handle");
            let stderr_window = window.clone();
            let stderr_thread = std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().flatten() {
                    if !line.trim().is_empty() {
                        let _ = stderr_window.emit("scan-progress", line);
                    }
                }
            });

            let stdout = child.stdout.take().expect("no stdout handle");
            let mut final_line = String::new();
            for line in BufReader::new(stdout).lines().flatten() {
                if !line.trim().is_empty() {
                    final_line = line;
                }
            }

            let _ = stderr_thread.join();
            let wait_result = child.wait();
            *state.running_pid.lock().unwrap() = None;

            match wait_result {
                Ok(status) if status.success() && !final_line.is_empty() => {
                    let _ = window.emit("scan-complete", final_line);
                }
                Ok(_) => {
                    let _ = window.emit("scan-error", "Scan was cancelled or the scanner exited unexpectedly".to_string());
                }
                Err(_) => {
                    let _ = window.emit("scan-error", "Scanner process exited with an error".to_string());
                }
            }
        } else {
            // Release build: same streaming shape (progress events as they
            // arrive, one final result), but sourced from the bundled
            // sidecar's event stream instead of a raw std::process::Child.
            use tauri::api::process::CommandEvent;

            let cmd = match tauri::api::process::Command::new_sidecar("driveguardian-cli") {
                Ok(c) => c,
                Err(e) => {
                    let _ = window.emit("scan-error", format!("Sidecar not found: {e}"));
                    return;
                }
            };
            let (mut rx, child) = match cmd.args(["scan", &drive]).spawn() {
                Ok(pair) => pair,
                Err(e) => {
                    let _ = window.emit("scan-error", format!("Failed to launch bundled backend: {e}"));
                    return;
                }
            };
            *state.running_pid.lock().unwrap() = Some(child.pid());

            let mut final_line = String::new();
            while let Some(event) = rx.blocking_recv() {
                match event {
                    CommandEvent::Stderr(line) => {
                        if !line.trim().is_empty() {
                            let _ = window.emit("scan-progress", line);
                        }
                    }
                    CommandEvent::Stdout(line) => {
                        if !line.trim().is_empty() {
                            final_line = line;
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        *state.running_pid.lock().unwrap() = None;
                        if payload.code == Some(0) && !final_line.is_empty() {
                            let _ = window.emit("scan-complete", final_line);
                        } else {
                            let _ = window.emit("scan-error", "Scan was cancelled or the bundled backend exited unexpectedly".to_string());
                        }
                        return;
                    }
                    _ => {}
                }
            }
            *state.running_pid.lock().unwrap() = None;
        }
    });
}

fn duplicate_finder_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent().expect("missing apps/desktop")
        .parent().expect("missing apps")
        .parent().expect("missing repo root")
        .join("core").join("scanner").join("duplicate_finder.py")
}

/// Same streaming pattern as scan_drive: runs in a background thread,
/// emits progress events, and a final "duplicates-complete" event with
/// the grouped results (or "duplicates-error" on failure).
#[tauri::command]
fn find_duplicates(window: tauri::Window, drive: Option<String>) {
    let app_handle = window.app_handle();
    std::thread::spawn(move || {
        let state = app_handle.state::<AppState>();

        if cfg!(debug_assertions) {
            let mut cmd = Command::new("python");
            cmd.arg(duplicate_finder_path());
            if let Some(d) = &drive {
                cmd.arg("--drive").arg(d);
            }
            let child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();

            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    let _ = window.emit("duplicates-error", format!("Failed to launch duplicate finder: {e}"));
                    return;
                }
            };

            *state.running_pid.lock().unwrap() = Some(child.id());

            let stderr = child.stderr.take().expect("no stderr handle");
            let stderr_window = window.clone();
            let stderr_thread = std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().flatten() {
                    if !line.trim().is_empty() {
                        let _ = stderr_window.emit("duplicates-progress", line);
                    }
                }
            });

            let stdout = child.stdout.take().expect("no stdout handle");
            let mut final_line = String::new();
            for line in BufReader::new(stdout).lines().flatten() {
                if !line.trim().is_empty() {
                    final_line = line;
                }
            }

            let _ = stderr_thread.join();
            let wait_result = child.wait();
            *state.running_pid.lock().unwrap() = None;

            match wait_result {
                Ok(status) if status.success() && !final_line.is_empty() => {
                    let _ = window.emit("duplicates-complete", final_line);
                }
                Ok(_) => {
                    let _ = window.emit("duplicates-error", "Duplicate scan was cancelled or exited unexpectedly".to_string());
                }
                Err(_) => {
                    let _ = window.emit("duplicates-error", "Duplicate finder exited with an error".to_string());
                }
            }
        } else {
            use tauri::api::process::CommandEvent;

            let cmd = match tauri::api::process::Command::new_sidecar("driveguardian-cli") {
                Ok(c) => c,
                Err(e) => {
                    let _ = window.emit("duplicates-error", format!("Sidecar not found: {e}"));
                    return;
                }
            };
            let mut args = vec!["duplicates".to_string()];
            if let Some(d) = &drive {
                args.push("--drive".to_string());
                args.push(d.clone());
            }
            let (mut rx, child) = match cmd.args(args).spawn() {
                Ok(pair) => pair,
                Err(e) => {
                    let _ = window.emit("duplicates-error", format!("Failed to launch bundled backend: {e}"));
                    return;
                }
            };
            *state.running_pid.lock().unwrap() = Some(child.pid());

            let mut final_line = String::new();
            while let Some(event) = rx.blocking_recv() {
                match event {
                    CommandEvent::Stderr(line) => {
                        if !line.trim().is_empty() {
                            let _ = window.emit("duplicates-progress", line);
                        }
                    }
                    CommandEvent::Stdout(line) => {
                        if !line.trim().is_empty() {
                            final_line = line;
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        *state.running_pid.lock().unwrap() = None;
                        if payload.code == Some(0) && !final_line.is_empty() {
                            let _ = window.emit("duplicates-complete", final_line);
                        } else {
                            let _ = window.emit("duplicates-error", "Duplicate scan was cancelled or exited unexpectedly".to_string());
                        }
                        return;
                    }
                    _ => {}
                }
            }
            *state.running_pid.lock().unwrap() = None;
        }
    });
}

/// Checks whether Windows NTFS last-access-time tracking is enabled.
/// Windows disables this by default since Vista (performance reasons),
/// which makes `last_accessed` timestamps unreliable for judging real file
/// usage. `fsutil behavior query disablelastaccess` returns 0 if tracking
/// is ON, 1 (or higher, depending on Windows version) if OFF.
/// Returns true if tracking is enabled, false if disabled or unknown.
#[tauri::command]
fn check_last_access_tracking() -> Result<bool, String> {
    let output = Command::new("fsutil")
        .args(["behavior", "query", "disablelastaccess"])
        .output()
        .map_err(|e| format!("Could not query fsutil: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    // Typical output: "DisableLastAccess = 0" (tracking ON) or "= 1" (OFF)
    if text.contains("= 0") {
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn get_dashboard(drive: Option<String>, category: Option<String>) -> Result<String, String> {
    if cfg!(debug_assertions) {
        let mut cmd = Command::new("python");
        cmd.arg(scanner_path()).arg("dashboard");
        if let Some(d) = drive {
            cmd.arg("--drive").arg(d);
        }
        if let Some(c) = category {
            cmd.arg("--category").arg(c);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to launch scanner: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let mut args = vec!["dashboard".to_string()];
        if let Some(d) = drive {
            args.push("--drive".to_string());
            args.push(d);
        }
        if let Some(c) = category {
            args.push("--category".to_string());
            args.push(c);
        }
        let output = tauri::api::process::Command::new_sidecar("driveguardian-cli")
            .map_err(|e| format!("Sidecar not found: {e}"))?
            .args(args)
            .output()
            .map_err(|e| format!("Failed to launch bundled backend: {e}"))?;
        if !output.status.success() {
            return Err(output.stderr);
        }
        Ok(output.stdout)
    }
}

fn operations_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent().expect("missing apps/desktop")
        .parent().expect("missing apps")
        .parent().expect("missing repo root")
        .join("core").join("scanner").join("operations.py")
}

/// Same streaming pattern as the others. file_ids arrive as a comma-joined
/// string from the frontend (simplest cross-boundary format for a list).
#[tauri::command]
fn quarantine_files(window: tauri::Window, file_ids: String) {
    let app_handle = window.app_handle();
    std::thread::spawn(move || {
        let state = app_handle.state::<AppState>();

        if cfg!(debug_assertions) {
            let child = Command::new("python")
                .arg(operations_path())
                .arg("quarantine")
                .arg("--ids").arg(&file_ids)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn();

            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    let _ = window.emit("quarantine-error", format!("Failed to launch operations engine: {e}"));
                    return;
                }
            };

            *state.running_pid.lock().unwrap() = Some(child.id());

            let stderr = child.stderr.take().expect("no stderr handle");
            let stderr_window = window.clone();
            let stderr_thread = std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().flatten() {
                    if !line.trim().is_empty() {
                        let _ = stderr_window.emit("quarantine-progress", line);
                    }
                }
            });

            let stdout = child.stdout.take().expect("no stdout handle");
            let mut final_line = String::new();
            for line in BufReader::new(stdout).lines().flatten() {
                if !line.trim().is_empty() {
                    final_line = line;
                }
            }

            let _ = stderr_thread.join();
            let wait_result = child.wait();
            *state.running_pid.lock().unwrap() = None;

            match wait_result {
                Ok(status) if status.success() && !final_line.is_empty() => {
                    let _ = window.emit("quarantine-complete", final_line);
                }
                Ok(_) => {
                    let _ = window.emit("quarantine-error", "Quarantine operation was cancelled or exited unexpectedly".to_string());
                }
                Err(_) => {
                    let _ = window.emit("quarantine-error", "Operations engine exited with an error".to_string());
                }
            }
        } else {
            use tauri::api::process::CommandEvent;

            let cmd = match tauri::api::process::Command::new_sidecar("driveguardian-cli") {
                Ok(c) => c,
                Err(e) => {
                    let _ = window.emit("quarantine-error", format!("Sidecar not found: {e}"));
                    return;
                }
            };
            let (mut rx, child) = match cmd.args(["quarantine", "--ids", &file_ids]).spawn() {
                Ok(pair) => pair,
                Err(e) => {
                    let _ = window.emit("quarantine-error", format!("Failed to launch bundled backend: {e}"));
                    return;
                }
            };
            *state.running_pid.lock().unwrap() = Some(child.pid());

            let mut final_line = String::new();
            while let Some(event) = rx.blocking_recv() {
                match event {
                    CommandEvent::Stderr(line) => {
                        if !line.trim().is_empty() {
                            let _ = window.emit("quarantine-progress", line);
                        }
                    }
                    CommandEvent::Stdout(line) => {
                        if !line.trim().is_empty() {
                            final_line = line;
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        *state.running_pid.lock().unwrap() = None;
                        if payload.code == Some(0) && !final_line.is_empty() {
                            let _ = window.emit("quarantine-complete", final_line);
                        } else {
                            let _ = window.emit("quarantine-error", "Quarantine operation was cancelled or exited unexpectedly".to_string());
                        }
                        return;
                    }
                    _ => {}
                }
            }
            *state.running_pid.lock().unwrap() = None;
        }
    });
}

/// Small result sets, blocking calls are fine.
#[tauri::command]
fn list_quarantine(status: Option<String>) -> Result<String, String> {
    if cfg!(debug_assertions) {
        let mut cmd = Command::new("python");
        cmd.arg(operations_path()).arg("list");
        if let Some(s) = &status {
            cmd.arg("--status").arg(s);
        }
        let output = cmd.output().map_err(|e| format!("Failed to launch operations engine: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let mut args = vec!["ops-list".to_string()];
        if let Some(s) = status {
            args.push("--status".to_string());
            args.push(s);
        }
        let output = tauri::api::process::Command::new_sidecar("driveguardian-cli")
            .map_err(|e| format!("Sidecar not found: {e}"))?
            .args(args)
            .output()
            .map_err(|e| format!("Failed to launch bundled backend: {e}"))?;
        if !output.status.success() {
            return Err(output.stderr);
        }
        Ok(output.stdout)
    }
}

#[tauri::command]
fn restore_operation(operation_id: i64) -> Result<String, String> {
    if cfg!(debug_assertions) {
        let output = Command::new("python")
            .arg(operations_path())
            .arg("restore")
            .arg("--operation-id").arg(operation_id.to_string())
            .output()
            .map_err(|e| format!("Failed to launch operations engine: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let output = tauri::api::process::Command::new_sidecar("driveguardian-cli")
            .map_err(|e| format!("Sidecar not found: {e}"))?
            .args(["restore", "--operation-id", &operation_id.to_string()])
            .output()
            .map_err(|e| format!("Failed to launch bundled backend: {e}"))?;
        if !output.status.success() {
            return Err(output.stderr);
        }
        Ok(output.stdout)
    }
}

fn ai_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent().expect("missing apps/desktop")
        .parent().expect("missing apps")
        .parent().expect("missing repo root")
        .join("core").join("ai").join("query_interpreter.py")
}

/// Checks whether Ollama is running and lists installed models. Fast,
/// blocking call is fine (just an HTTP GET with a short timeout inside).
#[tauri::command]
fn check_ollama_status() -> Result<String, String> {
    if cfg!(debug_assertions) {
        let output = Command::new("python")
            .arg(ai_path())
            .arg("status")
            .output()
            .map_err(|e| format!("Failed to launch AI module: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let output = tauri::api::process::Command::new_sidecar("driveguardian-cli")
            .map_err(|e| format!("Sidecar not found: {e}"))?
            .args(["ai-status"])
            .output()
            .map_err(|e| format!("Failed to launch bundled backend: {e}"))?;
        if !output.status.success() {
            return Err(output.stderr);
        }
        Ok(output.stdout)
    }
}

/// A single Ollama call typically takes a few seconds — blocking is fine,
/// no need for the streaming/progress pattern used for long file scans.
#[tauri::command]
fn ai_query(question: String, model: String, drive: Option<String>) -> Result<String, String> {
    if cfg!(debug_assertions) {
        let mut cmd = Command::new("python");
        cmd.arg(ai_path()).arg("query")
            .arg("--question").arg(&question)
            .arg("--model").arg(&model);
        if let Some(d) = drive {
            cmd.arg("--drive").arg(d);
        }
        let output = cmd.output().map_err(|e| format!("Failed to launch AI module: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let mut args = vec!["ai-query".to_string(), "--question".to_string(), question,
                             "--model".to_string(), model];
        if let Some(d) = drive {
            args.push("--drive".to_string());
            args.push(d);
        }
        let output = tauri::api::process::Command::new_sidecar("driveguardian-cli")
            .map_err(|e| format!("Sidecar not found: {e}"))?
            .args(args)
            .output()
            .map_err(|e| format!("Failed to launch bundled backend: {e}"))?;
        if !output.status.success() {
            return Err(output.stderr);
        }
        Ok(output.stdout)
    }
}

fn scoring_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent().expect("missing apps/desktop")
        .parent().expect("missing apps")
        .parent().expect("missing repo root")
        .join("core").join("scanner").join("scoring.py")
}

/// Same streaming pattern as scan_drive/find_duplicates: background thread,
/// progress on stderr, final JSON result on stdout via "scores-complete".
#[tauri::command]
fn compute_scores(window: tauri::Window, drive: Option<String>) {
    let app_handle = window.app_handle();
    std::thread::spawn(move || {
        let state = app_handle.state::<AppState>();

        if cfg!(debug_assertions) {
            let mut cmd = Command::new("python");
            cmd.arg(scoring_path()).arg("score");
            if let Some(d) = &drive {
                cmd.arg("--drive").arg(d);
            }
            let child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();

            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    let _ = window.emit("scores-error", format!("Failed to launch scoring engine: {e}"));
                    return;
                }
            };

            *state.running_pid.lock().unwrap() = Some(child.id());

            let stderr = child.stderr.take().expect("no stderr handle");
            let stderr_window = window.clone();
            let stderr_thread = std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().flatten() {
                    if !line.trim().is_empty() {
                        let _ = stderr_window.emit("scores-progress", line);
                    }
                }
            });

            let stdout = child.stdout.take().expect("no stdout handle");
            let mut final_line = String::new();
            for line in BufReader::new(stdout).lines().flatten() {
                if !line.trim().is_empty() {
                    final_line = line;
                }
            }

            let _ = stderr_thread.join();
            let wait_result = child.wait();
            *state.running_pid.lock().unwrap() = None;

            match wait_result {
                Ok(status) if status.success() && !final_line.is_empty() => {
                    let _ = window.emit("scores-complete", final_line);
                }
                Ok(_) => {
                    let _ = window.emit("scores-error", "Scoring was cancelled or exited unexpectedly".to_string());
                }
                Err(_) => {
                    let _ = window.emit("scores-error", "Scoring engine exited with an error".to_string());
                }
            }
        } else {
            use tauri::api::process::CommandEvent;

            let cmd = match tauri::api::process::Command::new_sidecar("driveguardian-cli") {
                Ok(c) => c,
                Err(e) => {
                    let _ = window.emit("scores-error", format!("Sidecar not found: {e}"));
                    return;
                }
            };
            let mut args = vec!["score".to_string()];
            if let Some(d) = &drive {
                args.push("--drive".to_string());
                args.push(d.clone());
            }
            let (mut rx, child) = match cmd.args(args).spawn() {
                Ok(pair) => pair,
                Err(e) => {
                    let _ = window.emit("scores-error", format!("Failed to launch bundled backend: {e}"));
                    return;
                }
            };
            *state.running_pid.lock().unwrap() = Some(child.pid());

            let mut final_line = String::new();
            while let Some(event) = rx.blocking_recv() {
                match event {
                    CommandEvent::Stderr(line) => {
                        if !line.trim().is_empty() {
                            let _ = window.emit("scores-progress", line);
                        }
                    }
                    CommandEvent::Stdout(line) => {
                        if !line.trim().is_empty() {
                            final_line = line;
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        *state.running_pid.lock().unwrap() = None;
                        if payload.code == Some(0) && !final_line.is_empty() {
                            let _ = window.emit("scores-complete", final_line);
                        } else {
                            let _ = window.emit("scores-error", "Scoring was cancelled or exited unexpectedly".to_string());
                        }
                        return;
                    }
                    _ => {}
                }
            }
            *state.running_pid.lock().unwrap() = None;
        }
    });
}

/// Recommendations lists are small (capped at `limit`), so a simple
/// blocking call is fine here — no need for the streaming pattern.
#[tauri::command]
fn get_recommendations(drive: Option<String>, classification: String, limit: u32) -> Result<String, String> {
    if cfg!(debug_assertions) {
        let mut cmd = Command::new("python");
        cmd.arg(scoring_path()).arg("recommendations");
        if let Some(d) = drive {
            cmd.arg("--drive").arg(d);
        }
        cmd.arg("--classification").arg(classification);
        cmd.arg("--limit").arg(limit.to_string());

        let output = cmd.output().map_err(|e| format!("Failed to launch scoring engine: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let mut args = vec!["recommendations".to_string()];
        if let Some(d) = drive {
            args.push("--drive".to_string());
            args.push(d);
        }
        args.push("--classification".to_string());
        args.push(classification);
        args.push("--limit".to_string());
        args.push(limit.to_string());

        let output = tauri::api::process::Command::new_sidecar("driveguardian-cli")
            .map_err(|e| format!("Sidecar not found: {e}"))?
            .args(args)
            .output()
            .map_err(|e| format!("Failed to launch bundled backend: {e}"))?;
        if !output.status.success() {
            return Err(output.stderr);
        }
        Ok(output.stdout)
    }
}

fn build_tray() -> tauri::SystemTray {
    let open = tauri::CustomMenuItem::new("open".to_string(), "Open DriveGuardian");
    let quit = tauri::CustomMenuItem::new("quit".to_string(), "Quit");
    let menu = tauri::SystemTrayMenu::new()
        .add_item(open)
        .add_native_item(tauri::SystemTrayMenuItem::Separator)
        .add_item(quit);
    tauri::SystemTray::new().with_menu(menu)
}

fn handle_tray_event(app: &tauri::AppHandle, event: tauri::SystemTrayEvent) {
    match event {
        tauri::SystemTrayEvent::LeftClick { .. } => {
            if let Some(window) = app.get_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        tauri::SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
            "open" => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        },
        _ => {}
    }
}

#[cfg(target_os = "windows")]
fn set_autostart_impl(enabled: bool) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|e| e.to_string())?;
    if enabled {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value("DriveGuardian", &exe_path.to_string_lossy().to_string())
            .map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("DriveGuardian");
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn get_autostart_impl() -> bool {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .and_then(|key| key.get_value::<String, _>("DriveGuardian"))
        .is_ok()
}

#[cfg(not(target_os = "windows"))]
fn set_autostart_impl(_enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn get_autostart_impl() -> bool {
    false
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    set_autostart_impl(enabled)?;
    Ok(enabled)
}

#[tauri::command]
fn get_autostart() -> bool {
    get_autostart_impl()
}

#[tauri::command]
fn get_low_space_threshold(state: tauri::State<AppState>) -> f64 {
    *state.low_space_threshold.lock().unwrap()
}

#[tauri::command]
fn set_low_space_threshold(state: tauri::State<AppState>, percent: f64) -> f64 {
    let clamped = percent.clamp(1.0, 50.0);
    *state.low_space_threshold.lock().unwrap() = clamped;
    clamped
}

/// Checks free space on every drive against the configured threshold.
/// Runs once immediately on startup (so alerts don't wait for the first
/// interval) and then on a loop. Only fast disk-metadata reads — never
/// triggers a full file scan on its own, since that's slow and should
/// stay a deliberate user action.
fn start_background_monitor(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            let disks = Disks::new_with_refreshed_list();
            let state = app_handle.state::<AppState>();
            let threshold = *state.low_space_threshold.lock().unwrap();

            for disk in disks.iter() {
                let total = disk.total_space();
                if total == 0 {
                    continue;
                }
                let free_pct = (disk.available_space() as f64 / total as f64) * 100.0;
                let mount = disk.mount_point().to_string_lossy().to_string();

                let mut alerted = state.alerted_drives.lock().unwrap();
                if free_pct < threshold {
                    if !alerted.contains(&mount) {
                        alerted.insert(mount.clone());
                        drop(alerted);

                        let title = "DriveGuardian: Low disk space";
                        let body = format!(
                            "{mount} has only {free_pct:.1}% free space remaining.",
                        );
                        let _ = tauri::api::notification::Notification::new("com.driveguardian.app")
                            .title(title)
                            .body(&body)
                            .show();
                        let _ = app_handle.emit_all("low-space-alert", serde_json::json!({
                            "mount_point": mount,
                            "free_pct": free_pct,
                        }));
                    }
                } else {
                    alerted.remove(&mount); // recovered — allow re-alerting if it drops again later
                }
            }

            std::thread::sleep(std::time::Duration::from_secs(900)); // 15 minutes
        }
    });
}

fn main() {
    let mut sys = System::new_all();
    sys.refresh_all();

    tauri::Builder::default()
        .manage(AppState {
            running_pid: Mutex::new(None),
            low_space_threshold: Mutex::new(10.0),
            alerted_drives: Mutex::new(std::collections::HashSet::new()),
        })
        .system_tray(build_tray())
        .on_system_tray_event(handle_tray_event)
        .on_window_event(|event| {
            // Closing the window hides it instead of exiting, so the
            // background monitor keeps running and alerts still fire.
            // Quitting for real happens only via the tray's Quit item.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                event.window().hide().unwrap();
                api.prevent_close();
            }
        })
        .setup(|app| {
            start_background_monitor(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_drives, scan_drive, get_dashboard, find_duplicates, cancel_running_task,
            check_last_access_tracking, compute_scores, get_recommendations,
            quarantine_files, list_quarantine, restore_operation,
            check_ollama_status, ai_query,
            get_autostart, set_autostart, get_low_space_threshold, set_low_space_threshold
        ])
        .run(tauri::generate_context!())
        .expect("error while running DriveGuardian");
}
