export type JobStatus = 0 | 1 | 2 | 3 | 4;

export const JOB_STATUS_META: Record<JobStatus, { label: string; tone: string }> = {
  0: { label: "Created", tone: "created" },
  1: { label: "Funded", tone: "funded" },
  2: { label: "Submitted", tone: "submitted" },
  3: { label: "Disputed", tone: "disputed" },
  4: { label: "Settled", tone: "settled" },
};

export type RequestDecision = "pending" | "approved" | "rejected";

export type SuccessCriteria = {
  minPages: number;
  minSourceLinks: number;
  minTrustedDomainRatio: number;
  requireTableOrChart: boolean;
  requiredFormat: string;
  requiredQuestions: string[];
  extraNotes: string;
};

export type CatalogItem = {
  id: string;
  title: string;
  summary: string;
  category: string;
  outputFormat: string;
  agentPriceLamports: string;
  agentPriceDisplay?: string;
  agentPriceSymbol?: string;
  agentPriceSol?: string;
  createdAt: string;
  updatedAt: string;
};

export type OnChainJob = {
  jobId: string;
  buyer: string;
  operator: string;
  reward: string;
  feeBps: number;
  deadlineAt: string;
  status: number;
  submissionHashHex: string;
  submissionSet: boolean;
  payout: string;
  feeAmount: string;
  operatorReceive: string;
  buyerRefund: string;
  createdAt: string;
  updatedAt: string;
  bump: number;
};

export type JobSpec = {
  key: string;
  buyer: string;
  jobId: string;
  serviceId: string;
  serviceTitle: string;
  taskTitle: string;
  taskBrief: string;
  criteria?: SuccessCriteria;
  requestStatus: RequestDecision;
  decisionReason: string;
  decidedAt: string | null;
  submittedAt: string | null;
  lastSubmissionPreview: string;
  lastSubmissionBody?: string;
  createdAt: string;
  updatedAt: string;
  onChainStatus?: JobStatus;
  job?: OnChainJob | null;
  jobPda?: string | null;
};

export type McpConnectionStatus = "idle" | "ok" | "error";

export type McpConnection = {
  name: string;
  serverUrl: string;
  healthPath: string;
  priceLamports: string;
  priceDisplay?: string;
  priceSymbol?: string;
  priceSol?: string;
  hasAuthToken?: boolean;
  lastCheckedAt: string | null;
  lastStatus: McpConnectionStatus;
  lastHttpStatus: number | null;
  lastMessage: string;
};

export type RoleWallets = {
  admin: string;
  ops: string;
  buyer: string;
  operator: string;
  treasury: string;
};
