import { useEffect, useState, useCallback } from "react";
import Sidebar, { View } from "./components/Sidebar";
import RightPanel from "./components/RightPanel";
import DriveDonut from "./components/DriveDonut";
import StorageBreakdown from "./components/StorageBreakdown";
import LargestFiles from "./components/LargestFiles";
import DuplicateFinder from "./components/DuplicateFinder";
import AgeDistribution from "./components/AgeDistribution";
import Recommendations from "./components/Recommendations";
import QuarantinePanel from "./components/QuarantinePanel";
import AiChat from "./components/AiChat";
import GuardianSettings from "./components/GuardianSettings";
import { listDrives, startScan, getDashboard, cancelRunningTask, checkLastAccessTracking, DriveInfo, DashboardData, ScanResult, ScanProgress } from "./lib/api";

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const VIEW_TITLES: Record<View, string> = {
  overview: "Overview",
  duplicates: "Duplicate Files",
  recommendations: "Recommendations",
  quarantine: "Quarantine",
  chat: "Ask DriveGuardian",
  settings: "Background Guardian",
};

export default function App() {
  const [activeView, setActiveView] = useState<View>("overview");
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData>({ categories: [], largest_files: [], age_distribution: [] });
  const [scanningDrive, setScanningDrive] = useState<string | null>(null);
  const [lastScanResult, setLastScanResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [duplicatesScanning, setDuplicatesScanning] = useState(false);
  const [scoringActive, setScoringActive] = useState(false);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lastAccessTrackingOn, setLastAccessTrackingOn] = useState<boolean | null>(null);
  const [showAccessInstructions, setShowAccessInstructions] = useState(false);
  const [quarantineRefreshKey, setQuarantineRefreshKey] = useState(0);

  useEffect(() => {
    checkLastAccessTracking().then(setLastAccessTrackingOn).catch(() => setLastAccessTrackingOn(null));
  }, []);

  const refreshDrives = useCallback(async () => {
    try {
      const d = await listDrives();
      setDrives(d);
      if (!selectedDrive && d.length) setSelectedDrive(d[0].mount_point);
    } catch (e) {
      setError(String(e));
    }
  }, [selectedDrive]);

  const refreshDashboard = useCallback(async (drive: string | null, category?: string | null) => {
    try {
      const data = await getDashboard(drive ?? undefined, category);
      setDashboard(data);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refreshDrives();
  }, []);

  useEffect(() => {
    if (selectedDrive) refreshDashboard(selectedDrive, selectedCategory);
  }, [selectedDrive, selectedCategory, refreshDashboard]);

  useEffect(() => {
    if (!scanStartedAt) return;
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - scanStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [scanStartedAt]);

  async function handleScan(drive: string) {
    setScanningDrive(drive);
    setScanProgress(null);
    setError(null);
    setScanStartedAt(Date.now());
    setElapsedSeconds(0);

    await startScan(
      drive,
      (progress) => setScanProgress(progress),
      async (result) => {
        setLastScanResult(result);
        setScanningDrive(null);
        setScanProgress(null);
        setScanStartedAt(null);
        setSelectedCategory(null);
        await refreshDashboard(drive, null);
        await refreshDrives();
      },
      (message) => {
        setError(message);
        setScanningDrive(null);
        setScanProgress(null);
        setScanStartedAt(null);
      }
    );
  }

  async function handleCancelScan() {
    await cancelRunningTask();
    setScanningDrive(null);
    setScanProgress(null);
    setScanStartedAt(null);
  }

  const busy = scanningDrive !== null || duplicatesScanning || scoringActive;

  return (
    <div className="shell">
      <div className="shell__card">
        <Sidebar active={activeView} onSelect={setActiveView} />

        <main className="main">
          <div className="main__topbar">
            <span className="main__title">{VIEW_TITLES[activeView]}</span>
            {drives.length > 0 && (
              <div className="drive-select">
                <span>Drive</span>
                <select value={selectedDrive ?? ""} onChange={(e) => { setSelectedCategory(null); setSelectedDrive(e.target.value); }}>
                  {drives.map((d) => (
                    <option key={d.mount_point} value={d.mount_point}>{d.mount_point}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {error && <div className="banner banner--error">{error}</div>}

          {activeView === "overview" && lastAccessTrackingOn === false && (
            <div className="banner banner--info">
              Windows has last-access-time tracking turned off (default setting).
              File age is currently based on when files were last <em>modified</em>,
              not opened.
              {" "}
              <button className="link-btn" onClick={() => setShowAccessInstructions((s) => !s)}>
                {showAccessInstructions ? "hide" : "how to enable (free, built into Windows)"}
              </button>
              {showAccessInstructions && (
                <div className="banner__instructions">
                  Open Command Prompt <strong>as Administrator</strong> and run:
                  <code>fsutil behavior set disablelastaccess 0</code>
                  Then restart your PC. One-time system setting — no cost, no install.
                </div>
              )}
            </div>
          )}

          {activeView === "overview" && (
            <>
              <div className="card">
                <div className="card__title">Storage activity</div>
                <AgeDistribution buckets={dashboard.age_distribution} />
              </div>

              <div className="grid-donuts">
                {drives.slice(0, 4).map((d) => (
                  <DriveDonut
                    key={d.mount_point}
                    drive={d}
                    onScan={handleScan}
                    scanning={scanningDrive === d.mount_point}
                    disabled={busy && scanningDrive !== d.mount_point}
                  />
                ))}
              </div>

              {(scanningDrive || lastScanResult) && (
                <div className="card">
                  {scanningDrive && (
                    <div className="scan-summary" style={{ marginTop: 0 }}>
                      <h3>{scanProgress ? `Scanning ${scanningDrive}...` : `Starting scan of ${scanningDrive}...`}</h3>
                      <div className="progress-bar progress-bar--indeterminate"><div className="progress-bar__fill" /></div>
                      {scanProgress && (
                        <>
                          <p>{scanProgress.files_scanned.toLocaleString()} files scanned</p>
                          <p className="scan-summary__rate">
                            {elapsedSeconds > 0 ? `${Math.round(scanProgress.files_scanned / elapsedSeconds).toLocaleString()} files/sec · ` : ""}
                            {formatElapsed(elapsedSeconds)} elapsed
                          </p>
                          <p className="scan-summary__path" title={scanProgress.current_folder}>{scanProgress.current_folder}</p>
                        </>
                      )}
                      <button className="cancel-btn" onClick={handleCancelScan}>Cancel Scan</button>
                    </div>
                  )}
                  {lastScanResult && !scanningDrive && (
                    <div className="scan-summary" style={{ marginTop: 0 }}>
                      <h3>Last scan</h3>
                      <p>{lastScanResult.files_scanned} files scanned</p>
                      <p>{lastScanResult.files_added} added · {lastScanResult.files_updated} updated</p>
                      {lastScanResult.errors_count > 0 && (
                        <p className="scan-summary__warn">{lastScanResult.errors_count} items skipped (permissions)</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="grid-2">
                <div className="card">
                  <div className="card__title">Storage by type</div>
                  <div className="card__subtitle">Click a bar to filter largest files</div>
                  <StorageBreakdown
                    categories={dashboard.categories}
                    selectedCategory={selectedCategory}
                    onSelectCategory={setSelectedCategory}
                  />
                </div>
                <div className="card">
                  <div className="card__title">{selectedCategory ? `Largest files — ${selectedCategory}` : "Largest files"}</div>
                  <div className="card__subtitle">Top space users on {selectedDrive}</div>
                  <LargestFiles files={dashboard.largest_files} />
                </div>
              </div>
            </>
          )}

          {activeView === "duplicates" && (
            <div className="card">
              <DuplicateFinder drive={selectedDrive} disabled={scanningDrive !== null || scoringActive} onScanningChange={setDuplicatesScanning} />
            </div>
          )}

          {activeView === "recommendations" && (
            <div className="card">
              <Recommendations
                drive={selectedDrive}
                disabled={scanningDrive !== null || duplicatesScanning}
                onScanningChange={setScoringActive}
                onQuarantineChange={() => setQuarantineRefreshKey((k) => k + 1)}
              />
            </div>
          )}

          {activeView === "quarantine" && (
            <div className="card">
              <QuarantinePanel refreshKey={quarantineRefreshKey} />
            </div>
          )}

          {activeView === "chat" && (
            <div className="card">
              <AiChat drive={selectedDrive} />
            </div>
          )}

          {activeView === "settings" && (
            <div className="card">
              <GuardianSettings />
            </div>
          )}
        </main>

        <RightPanel drives={drives} categories={dashboard.categories} />
      </div>
    </div>
  );
}
