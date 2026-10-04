import { useState } from "react";
import {
  startScoring, getRecommendations, cancelRunningTask, startQuarantine,
  ScoringResult, ScoringProgress, FileRecommendation, formatBytes,
} from "../lib/api";

interface Props {
  drive: string | null;
  disabled?: boolean;
  onScanningChange?: (scanning: boolean) => void;
  onQuarantineChange?: () => void;
}

const CLASSIFICATION_INFO: Record<string, { label: string; color: string; hint: string }> = {
  KEEP: { label: "Keep", color: "#22c55e", hint: "Actively used or high-value by type" },
  REVIEW: { label: "Review", color: "#f59e0b", hint: "Moderate activity — worth a look" },
  ARCHIVE: { label: "Archive", color: "#6366f1", hint: "Low recent activity, likely safe to move off primary storage" },
  DELETE_CANDIDATE: { label: "Delete Candidate", color: "#ef4444", hint: "Old, unused, or a duplicate copy — review before removing" },
};

export default function Recommendations({ drive, disabled, onScanningChange, onQuarantineChange }: Props) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScoringProgress | null>(null);
  const [result, setResult] = useState<ScoringResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedClass, setExpandedClass] = useState<string | null>(null);
  const [items, setItems] = useState<FileRecommendation[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [quarantining, setQuarantining] = useState(false);
  const [quarantineMessage, setQuarantineMessage] = useState<string | null>(null);

  async function handleComputeScores() {
    setScanning(true);
    onScanningChange?.(true);
    setProgress(null);
    setError(null);
    setResult(null);
    setExpandedClass(null);

    await startScoring(
      drive,
      (p) => setProgress(p),
      (r) => {
        setResult(r);
        setScanning(false);
        onScanningChange?.(false);
        setProgress(null);
      },
      (message) => {
        setError(message);
        setScanning(false);
        onScanningChange?.(false);
        setProgress(null);
      }
    );
  }

  async function toggleClassification(cls: string) {
    if (expandedClass === cls) {
      setExpandedClass(null);
      return;
    }
    setExpandedClass(cls);
    setSelectedIds(new Set());
    setQuarantineMessage(null);
    setLoadingItems(true);
    try {
      const data = await getRecommendations(drive, cls, 50);
      setItems(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingItems(false);
    }
  }

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleQuarantineSelected() {
    if (selectedIds.size === 0) return;
    const confirmed = window.confirm(
      `Move ${selectedIds.size} file(s) to a DriveGuardian_Quarantine folder on the same drive?\n\n` +
      `This is fully reversible — nothing is permanently deleted. You can restore any file from Quarantine later.`
    );
    if (!confirmed) return;

    setQuarantining(true);
    setQuarantineMessage(null);

    await startQuarantine(
      Array.from(selectedIds),
      () => {},
      async (result) => {
        setQuarantining(false);
        setQuarantineMessage(
          `Moved ${result.succeeded} of ${result.total} file(s) to quarantine` +
          (result.freed_bytes ? ` — ${formatBytes(result.freed_bytes)} freed from this drive` : "") +
          (result.failed > 0 ? `. ${result.failed} failed (see below).` : ".")
        );
        setSelectedIds(new Set());
        // refresh the expanded list so quarantined files drop out of view
        if (expandedClass) {
          const data = await getRecommendations(drive, expandedClass, 50);
          setItems(data);
        }
        onQuarantineChange?.();
      },
      (message) => {
        setQuarantining(false);
        setError(message);
      }
    );
  }

  return (
    <div className="recommendations">
      <div className="recommendations__header">
        <p className="recommendations__hint">
          Scores every file on {drive ?? "this drive"} by recent activity, change
          frequency, and file type — these are suggestions only, nothing is
          ever moved or deleted automatically.
        </p>
        <button className="primary-btn" onClick={handleComputeScores} disabled={scanning || disabled}>
          {scanning ? "Scoring..." : disabled ? "Wait for other task" : "Compute Recommendations"}
        </button>
      </div>

      {scanning && (
        <div className="duplicate-finder__progress">
          {progress && progress.total > 0 ? (
            <>
              <div className="progress-bar">
                <div
                  className="progress-bar__fill"
                  style={{ width: `${Math.min(100, (progress.processed / progress.total) * 100)}%` }}
                />
              </div>
              <p>{progress.processed.toLocaleString()} / {progress.total.toLocaleString()} files scored</p>
            </>
          ) : (
            <>
              <div className="progress-bar progress-bar--indeterminate">
                <div className="progress-bar__fill" />
              </div>
              <p>Starting...</p>
            </>
          )}
          <button
            className="cancel-btn"
            onClick={async () => {
              await cancelRunningTask();
              setScanning(false);
              onScanningChange?.(false);
              setProgress(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {error && <div className="banner banner--error">{error}</div>}

      {result && (
        <>
          {result.potentially_reclaimable_bytes > 0 && (
            <p className="recommendations__summary">
              <strong>{formatBytes(result.potentially_reclaimable_bytes)}</strong> potentially
              reclaimable from delete-candidate files
            </p>
          )}
          <div className="classification-groups">
            {Object.entries(CLASSIFICATION_INFO).map(([key, info]) => {
              const count = result.counts[key] ?? 0;
              return (
                <div key={key} className="classification-group">
                  <div
                    className="classification-group__header"
                    style={{ borderLeftColor: info.color }}
                    onClick={() => count > 0 && toggleClassification(key)}
                  >
                    <span className="classification-group__label" style={{ color: info.color }}>
                      {info.label}
                    </span>
                    <span className="classification-group__count">{count.toLocaleString()} files</span>
                  </div>
                  {expandedClass === key && (
                    <div className="classification-group__body">
                      <p className="classification-group__hint">{info.hint}</p>

                      {key === "DELETE_CANDIDATE" && selectedIds.size > 0 && (
                        <button
                          className="primary-btn primary-btn--danger"
                          onClick={handleQuarantineSelected}
                          disabled={quarantining}
                        >
                          {quarantining ? "Moving..." : `Move ${selectedIds.size} Selected to Quarantine`}
                        </button>
                      )}
                      {quarantineMessage && key === "DELETE_CANDIDATE" && (
                        <p className="recommendations__summary">{quarantineMessage}</p>
                      )}

                      {loadingItems ? (
                        <p className="empty-state">Loading...</p>
                      ) : items.length === 0 ? (
                        <p className="empty-state">No files in this category.</p>
                      ) : (
                        <ul className="classification-group__files">
                          {items.map((f) => (
                            <li key={f.path} title={f.path}>
                              {key === "DELETE_CANDIDATE" && (
                                <input
                                  type="checkbox"
                                  checked={selectedIds.has(f.id)}
                                  onChange={() => toggleSelected(f.id)}
                                  className="classification-group__checkbox"
                                />
                              )}
                              <span className="classification-group__filename">{f.name}</span>
                              <span className="classification-group__filesize">{formatBytes(f.size)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
