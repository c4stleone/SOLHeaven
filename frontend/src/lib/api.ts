import type {
  CatalogItem,
  JobSpec,
  McpConnection,
  RoleWallets,
  SuccessCriteria,
} from "@/lib/types";

type ApiEnvelope = {
  ok: boolean;
  error?: string;
};

type ApiWithMetrics = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  submittedOnChain: number;
  settledOnChain: number;
};

export type WalletsResponse = ApiEnvelope & {
  roles: RoleWallets;
  stableSymbol: string;
  stableDecimals: number;
  stableMint: string | null;
  roleTokenAccounts: RoleWallets | null;
};

export type CatalogResponse = ApiEnvelope & {
  services: CatalogItem[];
  operatorPriceLamports: string;
  operatorPriceDisplay: string;
  operatorPriceSymbol: string;
  operatorPriceSol: string;
};

export type RequestsResponse = ApiEnvelope & {
  metrics: ApiWithMetrics;
  requests: JobSpec[];
};

export type McpResponse = ApiEnvelope & {
  connection: McpConnection;
};

export type McpTestResponse = ApiEnvelope & {
  target: string;
  durationMs: number;
  test: {
    ok: boolean;
    status: number | null;
    message: string;
    preview: string;
  };
  connection: McpConnection;
};

export type ConfigResponse = ApiEnvelope & {
  configPda: string;
  config: {
    admin: string;
    ops: string;
    treasury: string;
    stableMint: string;
    bump: number;
  } | null;
  stableSymbol: string;
  stableDecimals: number;
  stableMint: string | null;
  roleTokenAccounts: RoleWallets | null;
};

export type HealthResponse = ApiEnvelope & {
  rpcUrl: string;
  programId: string;
  version: unknown;
  stableSymbol: string;
  stableDecimals: number;
  stableMint: string | null;
};

const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

function toUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (!API_BASE_URL) {
    return path;
  }
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(toUrl(path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  let data: any = null;
  try {
    data = await response.json();
  } catch (_e) {
    data = null;
  }

  if (!response.ok || (data && data.ok === false)) {
    throw new Error(
      data?.error ||
        `API request failed: ${response.status} ${response.statusText}`
    );
  }

  return data as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

export function getWallets() {
  return apiFetch<WalletsResponse>("/api/wallets");
}

export function getHealth() {
  return apiFetch<HealthResponse>("/api/health");
}

export function getConfig() {
  return apiFetch<ConfigResponse>("/api/config");
}

export function bootstrapSystem(payload?: { sol?: number; buyerUnits?: string }) {
  return post("/api/bootstrap", payload ?? {});
}

export function airdropRole(payload?: {
  role?: "admin" | "ops" | "buyer" | "operator" | "treasury";
  sol?: number;
}) {
  return post("/api/airdrop", payload ?? {});
}

export function getOperatorCatalog() {
  return apiFetch<CatalogResponse>("/api/operator/catalog");
}

export function saveCatalogItem(payload: Partial<CatalogItem>) {
  return post<CatalogResponse>("/api/operator/catalog", payload);
}

export function getMcpConnection() {
  return apiFetch<McpResponse>("/api/operator/mcp");
}

export function testMcpConnection(payload?: {
  persist?: boolean;
  name?: string;
  serverUrl?: string;
  healthPath?: string;
  priceLamports?: string;
  authToken?: string;
}) {
  return post<McpTestResponse>("/api/operator/mcp/test", payload ?? {});
}

export function updateMcpConnection(payload?: {
  name?: string;
  serverUrl?: string;
  healthPath?: string;
  priceLamports?: string;
  authToken?: string;
}) {
  return post<McpResponse>("/api/operator/mcp", payload ?? {});
}

export function getOperatorRequests(status?: string) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetch<RequestsResponse>(`/api/operator/requests${query}`);
}

export function decideRequest(payload: {
  buyer: string;
  jobId: string;
  decision: "approved" | "rejected";
  reason?: string;
}) {
  return post("/api/operator/requests/decision", payload);
}

export function createJob(payload?: {
  serviceId?: string;
  jobId?: string;
  deadlineSeconds?: number;
  feeBps?: number;
}) {
  return post<{
    ok: boolean;
    signature: string;
    jobPda: string;
    jobId: string;
    serviceId: string | null;
    rewardLamports: string;
    pricingSource: string;
    job: unknown;
  }>("/api/jobs/create", payload ?? {});
}

export function fundJob(payload: { jobId: string }) {
  return post("/api/jobs/fund", payload);
}

export function createJobSpec(payload: {
  buyer: string;
  jobId: string;
  serviceId: string;
  serviceTitle: string;
  taskTitle: string;
  taskBrief?: string;
  criteria?: Partial<SuccessCriteria>;
}) {
  return post("/api/jobs/spec", payload);
}

export function submitJobResult(payload: {
  jobId: string;
  buyer: string;
  submission: string;
}) {
  return post("/api/jobs/submit", payload);
}

export function resolveJob(payload: {
  jobId: string;
  buyer: string;
  payoutLamports: string;
  reason?: string;
}) {
  return post("/api/jobs/resolve", payload);
}

export function timeoutJob(payload: {
  jobId: string;
  buyer: string;
  actorRole: "buyer" | "ops";
}) {
  return post("/api/jobs/timeout", payload);
}
