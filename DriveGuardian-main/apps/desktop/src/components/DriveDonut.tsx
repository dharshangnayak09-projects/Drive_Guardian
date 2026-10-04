import { PieChart, Pie, Cell } from "recharts";
import { DriveInfo, formatBytes } from "../lib/api";

interface Props {
  drive: DriveInfo;
  onScan: (mount: string) => void;
  scanning: boolean;
  disabled?: boolean;
}

export default function DriveDonut({ drive, onScan, scanning, disabled }: Props) {
  const used = drive.total_space - drive.available_space;
  const data = [
    { name: "Free", value: drive.available_space },
    { name: "Used", value: used },
  ];

  return (
    <div className="card">
      <div className="donut-card__header">
        <span className="donut-card__name">{drive.mount_point}</span>
      </div>
      <div className="donut-card__legend">
        <span><span className="donut-card__dot" style={{ background: "#B6FF3C" }} />Free space</span>
        <span><span className="donut-card__dot" style={{ background: "#35A7E8" }} />Used space</span>
      </div>

      <div className="donut-card__wrap">
        <PieChart width={180} height={180}>
          <Pie data={data} dataKey="value" innerRadius={58} outerRadius={80} startAngle={90} endAngle={-270} stroke="none">
            <Cell fill="#B6FF3C" />
            <Cell fill="#1B3A52" />
          </Pie>
        </PieChart>
        <div className="donut-card__center">
          <div className="donut-card__center-value">{formatBytes(drive.available_space)}</div>
          <div className="donut-card__center-label">Free storage</div>
        </div>
      </div>

      <button
        className="donut-card__link"
        onClick={() => onScan(drive.mount_point)}
        disabled={scanning || disabled}
      >
        {scanning ? "Scanning..." : "Scan drive →"}
      </button>
    </div>
  );
}
