import { JobStatus, JOB_STATUS_META, RequestDecision } from "@/lib/types";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock,
  FileCheck,
  Wallet,
  XCircle,
} from "lucide-react";

const REQUEST_META: Record<RequestDecision, { label: string; tone: string }> = {
  pending: { label: "Pending", tone: "created" },
  approved: { label: "Approved", tone: "funded" },
  rejected: { label: "Rejected", tone: "disputed" },
};

const STATUS_ICON: Record<JobStatus, typeof Circle> = {
  0: Circle,
  1: Wallet,
  2: FileCheck,
  3: AlertTriangle,
  4: CheckCircle2,
};

const REQUEST_ICON: Record<RequestDecision, typeof Circle> = {
  pending: Clock,
  approved: CheckCircle2,
  rejected: XCircle,
};

export const JobStatusBadge = ({ status }: { status: JobStatus }) => {
  const safeStatus: JobStatus = status in JOB_STATUS_META ? status : 0;
  const meta = JOB_STATUS_META[safeStatus];
  const Icon = STATUS_ICON[safeStatus];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-medium rounded-full border border-current/20 status-${meta.tone}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {meta.label}
    </span>
  );
};

export const RequestStatusBadge = ({ status }: { status: RequestDecision }) => {
  const meta = REQUEST_META[status];
  const Icon = REQUEST_ICON[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-medium rounded-full border border-current/20 status-${meta.tone}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {meta.label}
    </span>
  );
};
