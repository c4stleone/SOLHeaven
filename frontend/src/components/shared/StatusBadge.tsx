import { JobStatus, JOB_STATUS_META, RequestDecision } from "@/lib/types";

const REQUEST_META: Record<RequestDecision, { label: string; tone: string }> = {
  pending: { label: "Pending", tone: "created" },
  approved: { label: "Approved", tone: "funded" },
  rejected: { label: "Rejected", tone: "disputed" },
};

export const JobStatusBadge = ({ status }: { status: JobStatus }) => {
  const safeStatus: JobStatus = status in JOB_STATUS_META ? status : 0;
  const meta = JOB_STATUS_META[safeStatus];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-medium rounded-full status-${meta.tone}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${safeStatus === 1 ? "animate-pulse-glow" : ""}`} />
      {meta.label}
    </span>
  );
};

export const RequestStatusBadge = ({ status }: { status: RequestDecision }) => {
  const meta = REQUEST_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-medium rounded-full status-${meta.tone}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {meta.label}
    </span>
  );
};
