import { useState } from "react";
import { startDuplicateScan, cancelRunningTask, DuplicateResult, DuplicateProgress, formatBytes } from "../lib/api";

interface Props {
  drive: string | null;
  disabled?: boolean;
  onScanningChange?: (scanning: boolean) => void;
}

export default function DuplicateFinder({ drive, disabled, onScanningChange }: Props) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<DuplicateProgress | null>(null);
  const [result, setResult] = useState<DuplicateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  async function handleFindDuplicates() {
    setScanning(true);
    onScanningChange?.(true);
    setProgress(null);
    setError(null);

    await startDuplicateScan(
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

  return (
    <div className="duplicate-finder">
      <div className="duplicate-finder__header">
        <p className="duplicate-finder__hint">
          Finds exact duplicate files on {drive ?? "this drive"} using staged
          hashing (size → partial hash → full hash) — cheap checks run first,
          so most files never get fully hashed.
        </p>
        <button className="primary-btn" onClick={handleFindDuplicates} disabled={scanning || disabled}>
          {scanning ? "Scanning..." : disabled ? "Wait for scan to finish" : "Find Duplicates"}
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
              <p>
                {progress.stage === "partial_hash" ? "Checking size matches" : "Verifying exact matches"}
                {" — "}{progress.processed.toLocaleString()} / {progress.total.toLocaleString()}
                {" "}({Math.round((progress.processed / progress.total) * 100)}%)
              </p>
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
          {result.total_groups === 0 ? (
            <div className="empty-state">No duplicate files found. Nice and clean.</div>
          ) : (
            <>
              <p className="duplicate-finder__summary">
                <strong>{result.total_groups}</strong> duplicate groups ·{" "}
                <strong>{formatBytes(result.total_wasted_space)}</strong> could be freed
              </p>
              <div className="duplicate-groups">
                {result.groups.map((g) => (
                  <div key={g.full_hash} className="duplicate-group">
                    <div
                      className="duplicate-group__header"
                      onClick={() => setExpandedHash(expandedHash === g.full_hash ? null : g.full_hash)}
                    >
                      <span>{g.count} copies · {formatBytes(g.size)} each</span>
                      <span className="duplicate-group__waste">wastes {formatBytes(g.wasted_space)}</span>
                    </div>
                    {expandedHash === g.full_hash && (
                      <ul className="duplicate-group__files">
                        {g.files.map((f) => (
                          <li key={f.id} title={f.path}>{f.path}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
