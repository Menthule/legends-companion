type ResourceKind = "item" | "mob" | "spell" | "ability" | "recipe";

export interface ResourceUrls {
  p99: string;
  zam: string;
  eql: string;
}

function enc(value: string): string {
  return encodeURIComponent(value.trim());
}

export function resourceUrls(
  kind: ResourceKind,
  name: string,
  eqId?: number | null,
): ResourceUrls {
  const q = name.trim();
  return {
    p99: `https://wiki.project1999.com/${enc(q.replace(/\s+/g, "_"))}`,
    // Item IDs come from the bundled ProjectEQ database and are not the same
    // ID namespace used by Allakhazam. Spell IDs do map to live spell IDs.
    zam: eqId && kind === "spell"
      ? `https://everquest.allakhazam.com/db/spell.html?spell=${eqId}`
      : `https://everquest.allakhazam.com/search.html?q=${enc(q)}`,
    eql: `https://www.google.com/search?q=${enc(`EverQuest Legends ${q}`)}`,
  };
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
  const { p99, zam, eql } = resourceUrls(kind, q, eqId);
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
