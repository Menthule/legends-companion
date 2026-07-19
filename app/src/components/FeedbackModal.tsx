import { feedbackDiagnostics, feedbackUrl, type FeedbackKind } from "../lib/feedback";
import { IconDiagnostics, IconFeedback, IconTriggers } from "./Icons";
import Modal from "./Modal";
import { useToast } from "./Toast";

const REPORT_TYPES: Array<{
  kind: FeedbackKind;
  title: string;
  description: string;
  icon: typeof IconFeedback;
}> = [
  {
    kind: "bug",
    title: "Report a bug",
    description: "Something broke, disappeared, or behaved unexpectedly.",
    icon: IconDiagnostics,
  },
  {
    kind: "idea",
    title: "Suggest an idea",
    description: "A feature or improvement that would make play better.",
    icon: IconFeedback,
  },
  {
    kind: "missing-trigger",
    title: "Missing trigger",
    description: "Paste the exact EQ message and show us what should happen.",
    icon: IconTriggers,
  },
];

export default function FeedbackModal({
  version,
  onClose,
}: {
  version: string;
  onClose: () => void;
}) {
  const [toastNode, showToast] = useToast();
  const userAgent = navigator.userAgent;

  async function copyAppDetails() {
    try {
      await navigator.clipboard.writeText(
        feedbackDiagnostics(version, userAgent),
      );
      showToast("App details copied");
    } catch {
      showToast("Could not access the clipboard");
    }
  }

  return (
    <Modal label="Send feedback" onClose={onClose} className="feedback-modal">
      <div className="feedback-head">
        <div>
          <div className="section-title">Send feedback</div>
          <p className="hint">
            GitHub opens in your browser. Paste text or screenshots with Ctrl+V,
            or drag files straight into the report.
          </p>
        </div>
        <button className="ghost small" onClick={onClose} aria-label="Close feedback">
          Close
        </button>
      </div>

      <div className="feedback-choices">
        {REPORT_TYPES.map((report) => (
          <a
            key={report.kind}
            className="feedback-choice"
            href={feedbackUrl(report.kind, version, userAgent)}
            target="_blank"
            rel="noreferrer"
          >
            <report.icon size={20} />
            <span>
              <strong>{report.title}</strong>
              <span>{report.description}</span>
            </span>
            <span className="feedback-arrow" aria-hidden="true">→</span>
          </a>
        ))}
      </div>

      <div className="feedback-privacy" role="note">
        <div>
          <strong>You control what is shared.</strong>
          <span>
            Reports are public. App details include only the app version,
            platform, WebView, and timestamp—never character names, log paths,
            or log contents.
          </span>
        </div>
        <button className="ghost small" onClick={() => void copyAppDetails()}>
          Copy app details
        </button>
      </div>
      {toastNode}
    </Modal>
  );
}
