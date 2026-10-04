import { CategorySummary, formatBytes } from "../lib/api";

interface Props {
  categories: CategorySummary[];
  onSelectCategory?: (category: string | null) => void;
  selectedCategory?: string | null;
}

export default function StorageBreakdown({ categories, onSelectCategory, selectedCategory }: Props) {
  if (!categories.length) {
    return <div className="empty-state">No scan data yet. Scan a drive to see storage breakdown.</div>;
  }

  const sorted = [...categories].sort((a, b) => (b.total_size ?? 0) - (a.total_size ?? 0)).slice(0, 6);
  const max = Math.max(...sorted.map((c) => c.total_size ?? 0), 1);

  return (
    <div className="cat-bars">
      {sorted.map((c) => {
        const isSelected = selectedCategory === c.category;
        return (
          <div key={c.category} className={`cat-bar ${isSelected ? "cat-bar--selected" : ""}`}>
            <div className="cat-bar__row">
              <span className="cat-bar__name">{c.category ?? "other"}</span>
              <span className="cat-bar__size">{formatBytes(c.total_size)}</span>
            </div>
            <div
              className="cat-bar__track"
              onClick={() => onSelectCategory?.(isSelected ? null : c.category)}
            >
              <div className="cat-bar__fill" style={{ width: `${Math.max(4, ((c.total_size ?? 0) / max) * 100)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
