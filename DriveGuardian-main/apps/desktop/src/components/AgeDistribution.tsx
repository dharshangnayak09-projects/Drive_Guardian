import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { AgeBucket, formatBytes } from "../lib/api";

const BUCKET_LABELS: Record<string, string> = {
  last_7_days: "7 days",
  last_30_days: "30 days",
  last_90_days: "90 days",
  last_year: "1 year",
  over_a_year: "1 year+",
};

const BUCKET_ORDER = ["last_7_days", "last_30_days", "last_90_days", "last_year", "over_a_year"];

interface Props {
  buckets: AgeBucket[];
}

export default function AgeDistribution({ buckets }: Props) {
  if (!buckets.length) {
    return <div className="empty-state">No scan data yet.</div>;
  }

  const byBucket = new Map(buckets.map((b) => [b.bucket, b]));
  const data = BUCKET_ORDER.map((key) => ({
    name: BUCKET_LABELS[key],
    size: byBucket.get(key as AgeBucket["bucket"])?.total_size ?? 0,
    count: byBucket.get(key as AgeBucket["bucket"])?.file_count ?? 0,
  }));

  return (
    <div>
      <p className="hero-chart__hint">
        Storage by how recently files were modified — not opened, since Windows
        disables access-time tracking by default.
      </p>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="ageGlow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#B6FF3C" stopOpacity={0.55} />
              <stop offset="100%" stopColor="#14D9A3" stopOpacity={0.02} />
            </linearGradient>
            <filter id="lineGlow" x="-20%" y="-50%" width="140%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="name" tick={{ fill: "#9AA79C", fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: "#9AA79C", fontSize: 11 }} tickFormatter={(v) => formatBytes(v)} axisLine={false} tickLine={false} width={56} />
          <Tooltip
            formatter={(value: number, _name, item) => [`${formatBytes(value)} · ${item.payload.count} files`, "Storage"]}
            contentStyle={{ background: "#141815", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, fontSize: 12 }}
          />
          <Area
            type="monotone"
            dataKey="size"
            stroke="#B6FF3C"
            strokeWidth={2.5}
            fill="url(#ageGlow)"
            filter="url(#lineGlow)"
            dot={{ r: 3, fill: "#B6FF3C", strokeWidth: 0 }}
            activeDot={{ r: 5, fill: "#B6FF3C" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
