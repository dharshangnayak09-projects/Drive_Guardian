import { invoke } from "@tauri-apps/api/tauri";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface DriveInfo {
  name: string;
  mount_point: string;
  total_space: number;
  available_space: number;
  is_removable: boolean;
}

export interface ScanResult {
  scan_id: number;
  drive: string;
  files_scanned: number;
  files_added: number;
  files_updated: number;
  files_removed: number;
  errors_count: number;
}

export interface CategorySummary {
  category: string;
  file_count: number;
  total_size: number;
}

export interface FileEntry {
  path: string;
  name: string;
  size: number;
  category: string;
  modified_at: string;
  drive: string;
}

export interface AgeBucket {
  bucket: "last_7_days" | "last_30_days" | "last_90_days" | "last_year" | "over_a_year";
  file_count: number;
  total_size: number;
}

export interface DashboardData {
  categories: CategorySummary[];
  largest_files: FileEntry[];
  age_distribution: AgeBucket[];
}

export async function listDrives(): Promise<DriveInfo[]> {
  return invoke<DriveInfo[]>("list_drives");
}

export interface ScanProgress {
  scan_id: number;
  files_scanned: number;
  current_folder: string;
}

/**
 * Starts a scan (fire-and-forget) and wires up live progress via Tauri events.
 * onProgress fires roughly every 500 files scanned; onComplete fires once
 * with the final summary; onError fires if the scanner process fails.
 * Returns an unlisten function — call it on unmount to avoid leaks.
 */
export async function startScan(
  drive: string,
  onProgress: (p: ScanProgress) => void,
  onComplete: (result: ScanResult) => void,
  onError: (message: string) => void
): Promise<UnlistenFn> {
  const unlistenProgress = await listen<string>("scan-progress", (event) => {
    try {
      onProgress(JSON.parse(event.payload));
    } catch {
      /* non-JSON line, ignore */
    }
  });
  const unlistenComplete = await listen<string>("scan-complete", (event) => {
    try {
      onComplete(JSON.parse(event.payload));
    } catch {
      onError("Scan finished but returned an unexpected response.");
    }
  });
  const unlistenError = await listen<string>("scan-error", (event) => {
    onError(event.payload);
  });

  try {
    await invoke("scan_drive", { drive });
  } catch (e) {
    onError(`Failed to start scan: ${e}`);
  }

  return () => {
    unlistenProgress();
    unlistenComplete();
    unlistenError();
  };
}

export async function getDashboard(drive?: string, category?: string | null): Promise<DashboardData> {
  const raw = await invoke<string>("get_dashboard", { drive: drive ?? null, category: category ?? null });
  return JSON.parse(raw);
}

export interface DuplicateFile {
  id: number;
  path: string;
}

export interface DuplicateGroup {
  full_hash: string;
  size: number;
  count: number;
  wasted_space: number;
  files: DuplicateFile[];
}

export interface DuplicateResult {
  groups: DuplicateGroup[];
  total_groups: number;
  total_wasted_space: number;
}

export interface DuplicateProgress {
  stage: "partial_hash" | "full_hash";
  processed: number;
  total: number;
}

export async function startDuplicateScan(
  drive: string | null,
  onProgress: (p: DuplicateProgress) => void,
  onComplete: (result: DuplicateResult) => void,
  onError: (message: string) => void
): Promise<UnlistenFn> {
  const unlistenProgress = await listen<string>("duplicates-progress", (event) => {
    try {
      onProgress(JSON.parse(event.payload));
    } catch {
      /* ignore non-JSON line */
    }
  });
  const unlistenComplete = await listen<string>("duplicates-complete", (event) => {
    try {
      onComplete(JSON.parse(event.payload));
    } catch {
      onError("Duplicate scan finished but returned an unexpected response.");
    }
  });
  const unlistenError = await listen<string>("duplicates-error", (event) => {
    onError(event.payload);
  });

  try {
    await invoke("find_duplicates", { drive });
  } catch (e) {
    onError(`Failed to start duplicate scan: ${e}`);
  }

  return () => {
    unlistenProgress();
    unlistenComplete();
    unlistenError();
  };
}
export interface FileRecommendation {
  id: number;
  path: string;
  name: string;
  size: number;
  category: string;
  modified_at: string;
  utility_score: number;
  future_access_probability: number;
  classification: string;
}

export interface ScoringResult {
  total_scored: number;
  counts: Record<string, number>;
  potentially_reclaimable_bytes: number;
}

export interface ScoringProgress {
  processed: number;
  total: number;
}

export async function startScoring(
  drive: string | null,
  onProgress: (p: ScoringProgress) => void,
  onComplete: (result: ScoringResult) => void,
  onError: (message: string) => void
): Promise<UnlistenFn> {
  const unlistenProgress = await listen<string>("scores-progress", (event) => {
    try {
      onProgress(JSON.parse(event.payload));
    } catch {
      /* ignore */
    }
  });
  const unlistenComplete = await listen<string>("scores-complete", (event) => {
    try {
      onComplete(JSON.parse(event.payload));
    } catch {
      onError("Scoring finished but returned an unexpected response.");
    }
  });
  const unlistenError = await listen<string>("scores-error", (event) => {
    onError(event.payload);
  });

  try {
    await invoke("compute_scores", { drive });
  } catch (e) {
    onError(`Failed to start scoring: ${e}`);
  }

  return () => {
    unlistenProgress();
    unlistenComplete();
    unlistenError();
  };
}

export async function getRecommendations(
  drive: string | null,
  classification: string,
  limit = 50
): Promise<FileRecommendation[]> {
  const raw = await invoke<string>("get_recommendations", { drive, classification, limit });
  return JSON.parse(raw);
}

export interface QuarantineOperation {
  id: number;
  file_id: number | null;
  original_path: string;
  quarantine_path: string;
  size: number;
  status: "completed" | "restored" | "failed";
  performed_at: string;
  restored_at: string | null;
  error: string | null;
}

export interface QuarantineResult {
  total: number;
  succeeded: number;
  failed: number;
  freed_bytes: number;
  failures: { file_id: number; status: string; error: string }[];
}

export interface QuarantineProgress {
  processed: number;
  total: number;
}

export async function startQuarantine(
  fileIds: number[],
  onProgress: (p: QuarantineProgress) => void,
  onComplete: (result: QuarantineResult) => void,
  onError: (message: string) => void
): Promise<UnlistenFn> {
  const unlistenProgress = await listen<string>("quarantine-progress", (event) => {
    try {
      onProgress(JSON.parse(event.payload));
    } catch {
      /* ignore */
    }
  });
  const unlistenComplete = await listen<string>("quarantine-complete", (event) => {
    try {
      onComplete(JSON.parse(event.payload));
    } catch {
      onError("Quarantine finished but returned an unexpected response.");
    }
  });
  const unlistenError = await listen<string>("quarantine-error", (event) => {
    onError(event.payload);
  });

  try {
    await invoke("quarantine_files", { fileIds: fileIds.join(",") });
  } catch (e) {
    onError(`Failed to start quarantine: ${e}`);
  }

  return () => {
    unlistenProgress();
    unlistenComplete();
    unlistenError();
  };
}

export async function listQuarantine(status?: string): Promise<QuarantineOperation[]> {
  const raw = await invoke<string>("list_quarantine", { status: status ?? null });
  return JSON.parse(raw);
}

export async function restoreOperation(operationId: number): Promise<{ status: string; error?: string; restored_path?: string }> {
  const raw = await invoke<string>("restore_operation", { operationId });
  return JSON.parse(raw);
}

export interface AiFileResult {
  id: number;
  path: string;
  name: string;
  size: number;
  category: string;
  modified_at: string;
  classification: string | null;
}

export interface AiQueryResult {
  status: "ok" | "error";
  error?: string;
  interpreted_filter?: Record<string, unknown>;
  results?: AiFileResult[];
  result_count?: number;
}

export interface OllamaStatus {
  running: boolean;
  models: string[];
  error?: string | null;
}

export async function checkOllamaStatus(): Promise<OllamaStatus> {
  const raw = await invoke<string>("check_ollama_status");
  return JSON.parse(raw);
}

export async function runAiQuery(question: string, model: string, drive: string | null): Promise<AiQueryResult> {
  const raw = await invoke<string>("ai_query", { question, model, drive });
  return JSON.parse(raw);
}

export async function getAutostart(): Promise<boolean> {
  return invoke<boolean>("get_autostart");
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_autostart", { enabled });
}

export async function getLowSpaceThreshold(): Promise<number> {
  return invoke<number>("get_low_space_threshold");
}

export async function setLowSpaceThreshold(percent: number): Promise<number> {
  return invoke<number>("set_low_space_threshold", { percent });
}

export async function checkLastAccessTracking(): Promise<boolean> {
  return invoke<boolean>("check_last_access_tracking");
}

export async function cancelRunningTask(): Promise<boolean> {
  return invoke<boolean>("cancel_running_task");
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
