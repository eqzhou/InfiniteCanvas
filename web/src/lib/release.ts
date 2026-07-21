export type ReleaseItem = {
  type: string;
  content: string;
};

export type ReleaseInfo = {
  version: string;
  date: string;
  items: ReleaseItem[];
};

export function parseChangelog(markdown: string): ReleaseInfo[] {
  const releases: ReleaseInfo[] = [];
  let current: ReleaseInfo | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim();
      if (title === "Unreleased") {
        current = { version: "Unreleased", date: "", items: [] };
      } else {
        const parts = title.split(/\s+-\s+/);
        current = {
          version: parts[0]!.trim(),
          date: parts[1]?.trim() ?? "",
          items: [],
        };
      }
      releases.push(current);
      continue;
    }
    if (line.startsWith("+ [") && current) {
      const close = line.indexOf("]");
      if (close > 3) {
        const type = line.slice(3, close).trim();
        const content = line.slice(close + 1).trim();
        if (type && content) current.items.push({ type, content });
      }
    }
  }
  return releases;
}

export function isNewerVersion(latestVersion: string, currentVersion: string): boolean {
  const parse = (version: string) => {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) as [number, number, number] : null;
  };
  const latest = parse(latestVersion);
  const current = parse(currentVersion);
  if (!latest || !current) return false;
  for (let i = 0; i < 3; i += 1) {
    if (latest[i]! > current[i]!) return true;
    if (latest[i]! < current[i]!) return false;
  }
  return false;
}
