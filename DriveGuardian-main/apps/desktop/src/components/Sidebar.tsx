import { LayoutGrid, Copy, Sparkles, ShieldCheck, MessageCircle, Settings } from "lucide-react";

export type View = "overview" | "duplicates" | "recommendations" | "quarantine" | "chat" | "settings";

interface NavItem {
  id: View;
  icon: typeof LayoutGrid;
  label: string;
}

const ITEMS: NavItem[] = [
  { id: "overview", icon: LayoutGrid, label: "Overview" },
  { id: "duplicates", icon: Copy, label: "Duplicates" },
  { id: "recommendations", icon: Sparkles, label: "Recommendations" },
  { id: "quarantine", icon: ShieldCheck, label: "Quarantine" },
  { id: "chat", icon: MessageCircle, label: "Ask DriveGuardian" },
  { id: "settings", icon: Settings, label: "Background Guardian" },
];

interface Props {
  active: View;
  onSelect: (view: View) => void;
}

export default function Sidebar({ active, onSelect }: Props) {
  return (
    <nav className="rail">
      <div className="rail__logo" />
      {ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            className={`rail__btn ${active === item.id ? "rail__btn--active" : ""}`}
            onClick={() => onSelect(item.id)}
            title={item.label}
            aria-label={item.label}
          >
            <Icon size={19} strokeWidth={2} />
          </button>
        );
      })}
      <div className="rail__spacer" />
    </nav>
  );
}
