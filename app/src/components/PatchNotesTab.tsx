import notesText from "../../../PATCH_NOTES.md?raw";
import Empty from "./Empty";

interface Section {
  title: string;
  items: string[];
}

interface Release {
  title: string;
  sections: Section[];
}

function parsePatchNotes(raw: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let section: Section | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      release = { title: line.replace(/^##\s+/, "").trim(), sections: [] };
      releases.push(release);
      section = null;
    } else if (line.startsWith("### ") && release) {
      section = { title: line.replace(/^###\s+/, "").trim(), items: [] };
      release.sections.push(section);
    } else if (line.startsWith("- ") && section) {
      section.items.push(line.replace(/^-\s+/, "").trim());
    }
  }
  return releases;
}

/** Patch-notes card content. Rendered inside Settings → Updates (the old
 *  top-level Patch Notes tab retired into it) — the caller supplies the
 *  `.card` wrapper so the settings sub-tab show/hide applies. */
export default function PatchNotesTab() {
  const releases = parsePatchNotes(notesText);
  return (
    <>
      <div className="card-head">
        <span className="section-title">Patch notes</span>
        <span className="hint">High-level changes users should know about.</span>
      </div>
      {releases.length === 0 ? (
        <Empty
          title="No patch notes"
          body="No patch notes are available for this build."
        />
      ) : (
        releases.map((release) => (
          <div className="patch-release" key={release.title}>
            <h2>{release.title}</h2>
            <div className="patch-section-grid">
              {release.sections.map((section) => (
                <article className="patch-section" key={section.title}>
                  <h3>{section.title}</h3>
                  <ul>
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}
