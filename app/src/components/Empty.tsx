import type { ReactNode } from "react";

/** Iconless empty state — quiet copy instead of a blank panel. */
export default function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  /** Optional call-to-action rendered under the copy (e.g. a primary button). */
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
      {action && <div className="empty-cta">{action}</div>}
    </div>
  );
}
