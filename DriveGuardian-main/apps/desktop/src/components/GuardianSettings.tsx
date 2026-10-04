import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getAutostart, setAutostart, getLowSpaceThreshold, setLowSpaceThreshold } from "../lib/api";

interface LowSpaceAlert {
  mount_point: string;
  free_pct: number;
}

export default function GuardianSettings() {
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [threshold, setThresholdState] = useState<number>(10);
  const [saving, setSaving] = useState(false);
  const [alerts, setAlerts] = useState<LowSpaceAlert[]>([]);

  useEffect(() => {
    getAutostart().then(setAutostartState).catch(() => setAutostartState(false));
    getLowSpaceThreshold().then(setThresholdState).catch(() => {});

    const unlisten = listen<LowSpaceAlert>("low-space-alert", (event) => {
      setAlerts((prev) => {
        const filtered = prev.filter((a) => a.mount_point !== event.payload.mount_point);
        return [...filtered, event.payload];
      });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  async function handleAutostartToggle() {
    if (autostart === null) return;
    setSaving(true);
    try {
      const newValue = await setAutostart(!autostart);
      setAutostartState(newValue);
    } finally {
      setSaving(false);
    }
  }

  async function handleThresholdChange(value: number) {
    setThresholdState(value); // optimistic, feels responsive while dragging
    const confirmed = await setLowSpaceThreshold(value);
    setThresholdState(confirmed);
  }

  return (
    <div className="guardian-settings">
      {alerts.length > 0 && (
        <div className="banner banner--error" style={{ marginBottom: 12 }}>
          {alerts.map((a) => (
            <div key={a.mount_point}>
              {a.mount_point} is low on space — only {a.free_pct.toFixed(1)}% free
            </div>
          ))}
        </div>
      )}

      <div className="guardian-settings__row">
        <div>
          <p className="guardian-settings__label">Launch on Windows startup</p>
          <p className="guardian-settings__hint">
            DriveGuardian runs quietly in the background (system tray) and keeps
            watching your drives even when the window is closed.
          </p>
        </div>
        <button
          className={`toggle-btn ${autostart ? "toggle-btn--on" : ""}`}
          onClick={handleAutostartToggle}
          disabled={saving || autostart === null}
        >
          {autostart ? "On" : "Off"}
        </button>
      </div>

      <div className="guardian-settings__row">
        <div>
          <p className="guardian-settings__label">Low disk space alert</p>
          <p className="guardian-settings__hint">
            Notify me when a drive's free space drops below this percentage.
            Checked automatically every 15 minutes — no manual scanning needed.
          </p>
        </div>
        <div className="guardian-settings__threshold">
          <input
            type="range"
            min={1}
            max={50}
            value={threshold}
            onChange={(e) => handleThresholdChange(Number(e.target.value))}
          />
          <span>{threshold}%</span>
        </div>
      </div>

      <p className="guardian-settings__note">
        Closing the window minimizes DriveGuardian to the system tray instead of
        quitting — right-click the tray icon to fully quit.
      </p>
    </div>
  );
}
