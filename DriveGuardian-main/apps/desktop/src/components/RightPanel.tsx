import { DriveInfo, CategorySummary, formatBytes } from "../lib/api";

const CATEGORY_DOTS: Record<string, string> = {
  video: "#35A7E8", image: "#B6FF3C", audio: "#14D9A3", document: "#F2C94C",
  spreadsheet: "#F2994A", presentation: "#BB6BD9", archive: "#9AA79C",
  installer: "#E65A46", code: "#56CCF2", database: "#6FCF97",
  font: "#828282", system: "#EB5757", other: "#667167",
};

interface Props {
  drives: DriveInfo[];
  categories: CategorySummary[];
}

export default function RightPanel({ drives, categories }: Props) {
  const totalSpace = drives.reduce((sum, d) => sum + d.total_space, 0);
  const totalFree = drives.reduce((sum, d) => sum + d.available_space, 0);

  const topCategories = [...categories]
    .sort((a, b) => (b.total_size ?? 0) - (a.total_size ?? 0))
    .slice(0, 7);

  return (
    <aside className="rightbar">
      <div className="rightbar__profile">
        <div className="rightbar__avatar" />
        <div>
          <div className="rightbar__name">DriveGuardian</div>
          <div className="rightbar__role">Adaptive AI Storage</div>
        </div>
      </div>

      <div className="storage-card">
        <div className="storage-card__label">Total storage</div>
        <div className="storage-card__value">{totalSpace ? formatBytes(totalSpace) : "—"}</div>
        <div className="storage-card__sub">{totalSpace ? `${formatBytes(totalFree)} free` : "Scan a drive to see totals"}</div>
      </div>

      <div className="rightbar__section-title">Top categories</div>
      {topCategories.length === 0 ? (
        <p className="empty-state" style={{ padding: "12px 0" }}>No scan data yet.</p>
      ) : (
        <div>
          {topCategories.map((c) => (
            <div className="app-row" key={c.category}>
              <div className="app-row__left">
                <span className="app-row__dot" style={{ background: CATEGORY_DOTS[c.category] ?? "#667167" }} />
                <span className="app-row__name">{c.category ?? "other"}</span>
              </div>
              <span className="app-row__size">{formatBytes(c.total_size)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="rightbar__spacer" />
    </aside>
  );
}
