import { useEffect, useState } from "react";
import { listQuarantine, restoreOperation, QuarantineOperation, formatBytes } from "../lib/api";

interface Props {
  refreshKey: number; // bump this from the parent to force a reload
}

export default function QuarantinePanel({ refreshKey }: Props) {
  const [operations, setOperations] = useState<QuarantineOperation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const ops = await listQuarantine("completed");
      setOperations(ops);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [refreshKey]);

  async function handleRestore(id: number) {
    setRestoringId(id);
    setError(null);
    try {
      const result = await restoreOperation(id);
      if (result.status === "restored") {
        await load();
      } else {
        setError(result.error ?? "Restore failed");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRestoringId(null);
    }
  }

  const totalSize = operations.reduce((sum, op) => sum + op.size, 0);

  if (loading && operations.length === 0) {
    return <p className="empty-state">Loading quarantine...</p>;
  }

  return (
    <div className="quarantine-panel">
      {error && <div className="banner banner--error">{error}</div>}

      {operations.length === 0 ? (
        <p className="empty-state">Nothing in quarantine right now.</p>
      ) : (
        <>
          <p className="recommendations__summary">
            <strong>{operations.length}</strong> file(s) in quarantine ·{" "}
            <strong>{formatBytes(totalSize)}</strong> total
          </p>
          <ul className="quarantine-panel__list">
            {operations.map((op) => (
              <li key={op.id} className="quarantine-panel__item">
                <div className="quarantine-panel__info">
                  <span className="quarantine-panel__path" title={op.original_path}>
                    {op.original_path}
                  </span>
                  <span className="quarantine-panel__meta">
                    {formatBytes(op.size)} · quarantined {new Date(op.performed_at).toLocaleDateString()}
                  </span>
                </div>
                <button
                  className="cancel-btn"
                  style={{ borderColor: "#22c55e", color: "#22c55e" }}
                  onClick={() => handleRestore(op.id)}
                  disabled={restoringId === op.id}
                >
                  {restoringId === op.id ? "Restoring..." : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
