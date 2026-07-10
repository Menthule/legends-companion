type ResourceKind = "item" | "mob" | "spell" | "ability" | "recipe";

function enc(value: string): string {
  return encodeURIComponent(value.trim());
}

export default function ResourceLinks({
  kind,
  name,
  eqId,
}: {
  kind: ResourceKind;
  name: string;
  eqId?: number | null;
}) {
  const q = name.trim();
  if (!q) return null;
  const p99 = `https://wiki.project1999.com/${enc(q.replace(/\s+/g, "_"))}`;
  const zam =
    eqId && kind === "item"
      ? `https://everquest.allakhazam.com/db/item.html?item=${eqId}`
      : eqId && kind === "spell"
        ? `https://everquest.allakhazam.com/db/spell.html?spell=${eqId}`
        : `https://everquest.allakhazam.com/search.html?q=${enc(q)}`;
  const eql = `https://www.google.com/search?q=${enc(`EverQuest Legends ${q}`)}`;
  return (
    <div className="resource-links" aria-label={`External resources for ${q}`}>
      <span className="refdb-subhead">More info</span>
      <a href={eql} target="_blank" rel="noreferrer">
        Legends web
      </a>
      <a href={p99} target="_blank" rel="noreferrer">
        P99
      </a>
      <a href={zam} target="_blank" rel="noreferrer">
        ZAM
      </a>
      <span className="hint">{kind}</span>
    </div>
  );
}
