/** Iconless empty state — quiet copy instead of a blank panel. */
export default function Empty({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
    </div>
  );
}
