import { DriveInfo, formatBytes } from "../lib/api";

interface Props {
  drives: DriveInfo[];
  selectedDrive: string | null;
  onSelect: (mountPoint: string) => void;
  onScan: (mountPoint: string) => void;
  scanningDrive: string | null;
  disabled?: boolean;
}

export default function DriveList({ drives, selectedDrive, onSelect, onScan, scanningDrive, disabled }: Props) {
  return (
    <div className="drive-list">
      {drives.map((d) => {
        const used = d.total_space - d.available_space;
        const usedPct = d.total_space ? (used / d.total_space) * 100 : 0;
        const isSelected = selectedDrive === d.mount_point;
        const isScanning = scanningDrive === d.mount_point;

        return (
          <div
            key={d.mount_point}
            className={`drive-card ${isSelected ? "drive-card--selected" : ""}`}
            onClick={() => onSelect(d.mount_point)}
          >
            <div className="drive-card__header">
              <span className="drive-card__name">{d.mount_point}</span>
              <span className={`drive-card__pct ${usedPct > 90 ? "drive-card__pct--danger" : ""}`}>
                {usedPct.toFixed(0)}% used
              </span>
            </div>
            <div className="drive-card__bar">
              <div className="drive-card__bar-fill" style={{ width: `${usedPct}%` }} />
            </div>
            <div className="drive-card__stats">
              <span>{formatBytes(d.available_space)} free of {formatBytes(d.total_space)}</span>
            </div>
            <button
              className="drive-card__scan-btn"
              disabled={isScanning || disabled}
              onClick={(e) => {
                e.stopPropagation();
                onScan(d.mount_point);
              }}
            >
              {isScanning ? "Scanning..." : disabled ? "Busy" : "Scan Drive"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
