import { FileEntry, formatBytes } from "../lib/api";

interface Props {
  files: FileEntry[];
}

export default function LargestFiles({ files }: Props) {
  if (!files.length) {
    return <div className="empty-state">No files indexed yet.</div>;
  }

  return (
    <table className="file-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Category</th>
          <th>Size</th>
          <th>Modified</th>
          <th>Path</th>
        </tr>
      </thead>
      <tbody>
        {files.map((f) => (
          <tr key={f.path}>
            <td>{f.name}</td>
            <td><span className="tag">{f.category}</span></td>
            <td>{formatBytes(f.size)}</td>
            <td>{new Date(f.modified_at).toLocaleDateString()}</td>
            <td className="file-table__path" title={f.path}>{f.path}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
