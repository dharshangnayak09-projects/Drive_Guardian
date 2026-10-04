import { useEffect, useState } from "react";
import { checkOllamaStatus, runAiQuery, AiFileResult, formatBytes } from "../lib/api";

interface Props {
  drive: string | null;
}

interface ChatEntry {
  question: string;
  filter?: Record<string, unknown>;
  results?: AiFileResult[];
  error?: string;
}

export default function AiChat({ drive }: Props) {
  const [ollamaRunning, setOllamaRunning] = useState<boolean | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatEntry[]>([]);

  async function checkStatus() {
    setChecking(true);
    try {
      const status = await checkOllamaStatus();
      setOllamaRunning(status.running);
      setModels(status.models);
      setLastError(status.error ?? null);
      if (status.models.length > 0 && !selectedModel) setSelectedModel(status.models[0]);
    } catch (e) {
      setOllamaRunning(false);
      setLastError(String(e));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    checkStatus();
  }, []);

  async function handleAsk() {
    if (!question.trim() || !selectedModel) return;
    setLoading(true);
    const q = question.trim();
    setQuestion("");

    try {
      const result = await runAiQuery(q, selectedModel, drive);
      if (result.status === "ok") {
        setHistory((prev) => [...prev, { question: q, filter: result.interpreted_filter, results: result.results }]);
      } else {
        setHistory((prev) => [...prev, { question: q, error: result.error ?? "Unknown error" }]);
      }
    } catch (e) {
      setHistory((prev) => [...prev, { question: q, error: String(e) }]);
    } finally {
      setLoading(false);
    }
  }

  function filterSummary(filter?: Record<string, unknown>): string {
    if (!filter) return "";
    const parts: string[] = [];
    if (filter.category) parts.push(`category: ${filter.category}`);
    if (filter.classification) parts.push(`status: ${filter.classification}`);
    if (filter.min_size_mb) parts.push(`min size: ${filter.min_size_mb}MB`);
    if (filter.max_size_mb) parts.push(`max size: ${filter.max_size_mb}MB`);
    if (filter.min_age_days) parts.push(`older than ${filter.min_age_days}d`);
    if (filter.max_age_days) parts.push(`within ${filter.max_age_days}d`);
    if (filter.name_contains) parts.push(`name contains "${filter.name_contains}"`);
    return parts.length ? parts.join(" · ") : "no specific filters";
  }

  if (ollamaRunning === null) {
    return <p className="empty-state">Checking for Ollama...</p>;
  }

  if (ollamaRunning === false) {
    return (
      <div className="ai-chat__setup">
        <p>
          Ollama isn't running. This chat is free, fully local, and needs no API key —
          it just needs Ollama installed and started.
        </p>
        <ol>
          <li>Download from <strong>ollama.com</strong> (free)</li>
          <li>Install it, then run <code>ollama pull llama3.2</code> in a terminal (one-time, ~2GB)</li>
          <li>Ollama runs in the background automatically after that — come back and refresh this panel</li>
        </ol>
        {lastError && <p className="ai-chat__error-detail">Diagnostic: {lastError}</p>}
        <button className="primary-btn" onClick={checkStatus} disabled={checking} style={{ marginTop: 10 }}>
          {checking ? "Checking..." : "Check Again"}
        </button>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="ai-chat__setup">
        <p>Ollama is running, but no models are installed yet.</p>
        <p>Run <code>ollama pull llama3.2</code> in a terminal, then refresh this panel.</p>
        <button className="primary-btn" onClick={checkStatus} disabled={checking} style={{ marginTop: 10 }}>
          {checking ? "Checking..." : "Check Again"}
        </button>
      </div>
    );
  }

  return (
    <div className="ai-chat">
      <div className="ai-chat__model-row">
        <label>Model:</label>
        <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      <div className="ai-chat__history">
        {history.length === 0 && (
          <p className="empty-state">
            Try: "find my biggest old videos" or "what can I delete" or "recent documents"
          </p>
        )}
        {history.map((entry, i) => (
          <div key={i} className="ai-chat__entry">
            <p className="ai-chat__question">{entry.question}</p>
            {entry.error ? (
              <p className="banner banner--error" style={{ marginTop: 4 }}>{entry.error}</p>
            ) : (
              <>
                <p className="ai-chat__filter">Searched: {filterSummary(entry.filter)}</p>
                {entry.results && entry.results.length === 0 ? (
                  <p className="empty-state">No matching files found.</p>
                ) : (
                  <ul className="classification-group__files">
                    {entry.results?.map((f) => (
                      <li key={f.id} title={f.path}>
                        <span className="classification-group__filename">{f.name}</span>
                        <span className="classification-group__filesize">{formatBytes(f.size)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="ai-chat__input-row">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !loading && handleAsk()}
          placeholder="Ask about your files..."
          disabled={loading}
        />
        <button className="primary-btn" onClick={handleAsk} disabled={loading || !question.trim()}>
          {loading ? "Thinking..." : "Ask"}
        </button>
      </div>
    </div>
  );
}
