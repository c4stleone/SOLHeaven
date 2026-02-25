import express, { Request, Response } from "express";
import * as anchor from "@coral-xyz/anchor";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { loadKeypairFromFile, OutcomeEscrowClient } from "../sdk/src";

type RoleName = "admin" | "ops" | "buyer" | "operator" | "treasury";
type RequestDecision = "pending" | "approved" | "rejected";

type CatalogItem = {
  id: string;
  title: string;
  summary: string;
  category: string;
  outputFormat: string;
  agentPriceLamports: string;
  createdAt: string;
  updatedAt: string;
};

type SuccessCriteria = {
  minPages: number;
  minSourceLinks: number;
  minTrustedDomainRatio: number;
  requireTableOrChart: boolean;
  requiredFormat: string;
  requiredQuestions: string[];
  extraNotes: string;
};

type JobSpec = {
  key: string;
  buyer: string;
  jobId: string;
  serviceId: string;
  serviceTitle: string;
  taskTitle: string;
  taskBrief: string;
  criteria: SuccessCriteria;
  requestStatus: RequestDecision;
  decisionReason: string;
  decidedAt: string | null;
  submittedAt: string | null;
  lastSubmissionPreview: string;
  createdAt: string;
  updatedAt: string;
};

type McpConnectionStatus = "idle" | "ok" | "error";

type McpConnection = {
  name: string;
  serverUrl: string;
  healthPath: string;
  priceLamports: string;
  authToken: string;
  lastCheckedAt: string | null;
  lastStatus: McpConnectionStatus;
  lastHttpStatus: number | null;
  lastMessage: string;
};

type MetaStore = {
  version: number;
  services: CatalogItem[];
  specs: Record<string, JobSpec>;
  mcpConnection: McpConnection;
};

const PORT = Number(process.env.PORT ?? 8787);
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const ADMIN_KEYPAIR =
  process.env.ADMIN_KEYPAIR ?? join(homedir(), ".config/solana/id.json");
const ROLE_DIR = resolve(process.cwd(), ".app-wallets");
const META_DIR = resolve(process.cwd(), ".run");
const META_STORE_PATH = join(META_DIR, "request_market_store.json");

function nowIso() {
  return new Date().toISOString();
}

function slugify(value: string): string {
  const base = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return base || `svc-${Date.now()}`;
}

function specKey(buyer: string, jobId: string): string {
  return `${buyer}:${jobId}`;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => String(v ?? "").trim())
      .filter((v) => Boolean(v));
  }
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((v) => v.trim())
      .filter((v) => Boolean(v));
  }
  return [];
}

function defaultCatalog(): CatalogItem[] {
  const ts = nowIso();
  return [
    {
      id: "weekly-stock-research-mcp",
      title: "주간 주식시장 동향 리서치 MCP",
      summary: "주요 종목/섹터/매크로 이슈를 주간 리포트로 정리하고 근거 출처를 첨부합니다.",
      category: "research",
      outputFormat: "PDF",
      agentPriceLamports: defaultMcpConnection().priceLamports,
      createdAt: ts,
      updatedAt: ts,
    },
  ];
}

function defaultMcpConnection(): McpConnection {
  return {
    name: "default-mcp-server",
    serverUrl: "",
    healthPath: "/health",
    priceLamports: "1000000",
    authToken: "",
    lastCheckedAt: null,
    lastStatus: "idle",
    lastHttpStatus: null,
    lastMessage: "not connected",
  };
}

function normalizeLamports(value: unknown, field: string): string {
  const text = String(value ?? "").trim().replace(/,/g, "");
  if (!text) {
    throw new Error(`${field} is required`);
  }
  if (!/^\d+$/.test(text)) {
    throw new Error(`${field} must be digits only`);
  }
  return text;
}

function normalizeLamportsOrFallback(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim().replace(/,/g, "");
  if (!text || !/^\d+$/.test(text)) {
    return fallback;
  }
  return text;
}

function lamportsToSolText(value: string): string {
  try {
    const lamports = BigInt(value);
    const whole = lamports / 1_000_000_000n;
    const fractional = (lamports % 1_000_000_000n)
      .toString()
      .padStart(9, "0")
      .slice(0, 4);
    return `${whole}.${fractional}`;
  } catch (_e) {
    return "0.0000";
  }
}

function normalizeServerUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error("serverUrl is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch (_e) {
    throw new Error("serverUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("serverUrl must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeHealthPath(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "/health";
  }
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  return text.startsWith("/") ? text : `/${text}`;
}

function buildHealthTarget(serverUrl: string, healthPath: string): string {
  if (/^https?:\/\//i.test(healthPath)) {
    return healthPath;
  }
  return new URL(healthPath || "/health", `${serverUrl}/`).toString();
}

function serializeMcpConnection(connection: McpConnection) {
  return {
    name: connection.name,
    serverUrl: connection.serverUrl,
    healthPath: connection.healthPath,
    priceLamports: connection.priceLamports,
    priceSol: lamportsToSolText(connection.priceLamports),
    hasAuthToken: Boolean(connection.authToken),
    lastCheckedAt: connection.lastCheckedAt,
    lastStatus: connection.lastStatus,
    lastHttpStatus: connection.lastHttpStatus,
    lastMessage: connection.lastMessage,
  };
}

function serializeCatalogItem(item: CatalogItem) {
  return {
    ...item,
    agentPriceSol: lamportsToSolText(item.agentPriceLamports),
  };
}

function normalizeCatalogItem(input: any, fallbackPriceLamports: string): CatalogItem {
  const title = String(input?.title ?? "").trim();
  if (!title) {
    throw new Error("service title is required");
  }
  const idInput = String(input?.id ?? "").trim();
  const id = idInput ? slugify(idInput) : slugify(title);
  const summary = String(input?.summary ?? "").trim();
  const category = String(input?.category ?? "general").trim() || "general";
  const outputFormat = String(input?.outputFormat ?? "PDF").trim() || "PDF";
  const rawAgentPrice = String(input?.agentPriceLamports ?? "").trim();
  const agentPriceLamports = rawAgentPrice
    ? normalizeLamports(rawAgentPrice, "agentPriceLamports")
    : normalizeLamports(fallbackPriceLamports, "fallbackAgentPriceLamports");
  const ts = nowIso();

  return {
    id,
    title,
    summary,
    category,
    outputFormat,
    agentPriceLamports,
    createdAt: ts,
    updatedAt: ts,
  };
}

function normalizeCriteria(input: any): SuccessCriteria {
  return {
    minPages: Math.max(0, toNumber(input?.minPages, 0)),
    minSourceLinks: Math.max(0, toNumber(input?.minSourceLinks, 0)),
    minTrustedDomainRatio: Math.max(0, Math.min(100, toNumber(input?.minTrustedDomainRatio, 0))),
    requireTableOrChart: toBool(input?.requireTableOrChart, false),
    requiredFormat: String(input?.requiredFormat ?? "PDF").trim() || "PDF",
    requiredQuestions: toStringArray(input?.requiredQuestions),
    extraNotes: String(input?.extraNotes ?? "").trim(),
  };
}

function loadMetaStore(): MetaStore {
  mkdirSync(META_DIR, { recursive: true });
  if (!existsSync(META_STORE_PATH)) {
    const base: MetaStore = {
      version: 1,
      services: defaultCatalog(),
      specs: {},
      mcpConnection: defaultMcpConnection(),
    };
    writeFileSync(META_STORE_PATH, JSON.stringify(base, null, 2));
    return base;
  }

  try {
    const parsed = JSON.parse(readFileSync(META_STORE_PATH, "utf-8"));
    const services = Array.isArray(parsed?.services)
      ? parsed.services.map((svc: any) => ({
          id: String(svc?.id ?? "").trim(),
          title: String(svc?.title ?? "").trim(),
          summary: String(svc?.summary ?? "").trim(),
          category: String(svc?.category ?? "general").trim() || "general",
          outputFormat: String(svc?.outputFormat ?? "PDF").trim() || "PDF",
          agentPriceLamports: normalizeLamportsOrFallback(
            svc?.agentPriceLamports,
            defaultMcpConnection().priceLamports
          ),
          createdAt: String(svc?.createdAt ?? nowIso()),
          updatedAt: String(svc?.updatedAt ?? nowIso()),
        }))
      : [];
    const normalizedServices =
      services.filter((svc: CatalogItem) => Boolean(svc.id) && Boolean(svc.title)).length > 0
        ? services.filter((svc: CatalogItem) => Boolean(svc.id) && Boolean(svc.title))
        : defaultCatalog();

    return {
      version: 1,
      services: normalizedServices,
      specs: parsed?.specs && typeof parsed.specs === "object" ? parsed.specs : {},
      mcpConnection:
        parsed?.mcpConnection && typeof parsed.mcpConnection === "object"
          ? {
              ...defaultMcpConnection(),
              ...parsed.mcpConnection,
              name:
                String(parsed?.mcpConnection?.name ?? "").trim() ||
                defaultMcpConnection().name,
              serverUrl: String(parsed?.mcpConnection?.serverUrl ?? "").trim(),
              healthPath: normalizeHealthPath(parsed?.mcpConnection?.healthPath),
              priceLamports: normalizeLamportsOrFallback(
                parsed?.mcpConnection?.priceLamports,
                defaultMcpConnection().priceLamports
              ),
              authToken: String(parsed?.mcpConnection?.authToken ?? "").trim(),
              lastCheckedAt:
                parsed?.mcpConnection?.lastCheckedAt === null
                  ? null
                  : String(parsed?.mcpConnection?.lastCheckedAt ?? ""),
              lastStatus: (["idle", "ok", "error"] as const).includes(
                parsed?.mcpConnection?.lastStatus
              )
                ? parsed?.mcpConnection?.lastStatus
                : "idle",
              lastHttpStatus:
                parsed?.mcpConnection?.lastHttpStatus === null ||
                parsed?.mcpConnection?.lastHttpStatus === undefined
                  ? null
                  : Number(parsed?.mcpConnection?.lastHttpStatus),
              lastMessage: String(parsed?.mcpConnection?.lastMessage ?? ""),
            }
          : defaultMcpConnection(),
    };
  } catch (_e) {
    const base: MetaStore = {
      version: 1,
      services: defaultCatalog(),
      specs: {},
      mcpConnection: defaultMcpConnection(),
    };
    writeFileSync(META_STORE_PATH, JSON.stringify(base, null, 2));
    return base;
  }
}

function persistMetaStore(store: MetaStore) {
  writeFileSync(META_STORE_PATH, JSON.stringify(store, null, 2));
}

function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf-8")));
    return Keypair.fromSecretKey(bytes);
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

function toBn(value: unknown, field: string): anchor.BN {
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing field: ${field}`);
  }
  const normalized = String(value).trim().replace(/,/g, "");
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`invalid numeric value for ${field}: ${value}`);
  }
  return new anchor.BN(normalized);
}

function toNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return Number(value);
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return String(value).toLowerCase() === "true";
}

function pubkey(pk: PublicKey) {
  return pk.toBase58();
}

function toPubkey(value: unknown, field: string): PublicKey {
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing field: ${field}`);
  }
  try {
    return new PublicKey(String(value).trim());
  } catch (_e) {
    throw new Error(`invalid public key for ${field}`);
  }
}

function serializeConfig(config: any) {
  if (!config) {
    return null;
  }
  return {
    admin: pubkey(config.admin),
    ops: pubkey(config.ops),
    treasury: pubkey(config.treasury),
    bump: config.bump,
  };
}

function serializeJob(job: any) {
  return {
    jobId: job.jobId.toString(),
    buyer: pubkey(job.buyer),
    operator: pubkey(job.operator),
    reward: job.reward.toString(),
    feeBps: job.feeBps,
    deadlineAt: job.deadlineAt.toString(),
    status: job.status,
    submissionHashHex: Buffer.from(job.submissionHash).toString("hex"),
    submissionSet: job.submissionSet,
    payout: job.payout.toString(),
    feeAmount: job.feeAmount.toString(),
    operatorReceive: job.operatorReceive.toString(),
    buyerRefund: job.buyerRefund.toString(),
    createdAt: job.createdAt.toString(),
    updatedAt: job.updatedAt.toString(),
    bump: job.bump,
  };
}

function rolePublicKeys(roles: Record<RoleName, Keypair>) {
  return {
    admin: pubkey(roles.admin.publicKey),
    ops: pubkey(roles.ops.publicKey),
    buyer: pubkey(roles.buyer.publicKey),
    operator: pubkey(roles.operator.publicKey),
    treasury: pubkey(roles.treasury.publicKey),
  };
}

function serializeAny(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object" && typeof value.toBase58 === "function") {
    return value.toBase58();
  }
  if (typeof value === "object" && typeof value.toString === "function" && value.constructor?.name === "BN") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeAny);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeAny(v)]));
  }
  return value;
}

function serializeUnsignedTx(tx: Transaction): string {
  const raw = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  return Buffer.from(raw).toString("base64");
}

mkdirSync(ROLE_DIR, { recursive: true });
const roles: Record<RoleName, Keypair> = {
  admin: loadKeypairFromFile(ADMIN_KEYPAIR),
  ops: loadOrCreateKeypair(join(ROLE_DIR, "ops.json")),
  buyer: loadOrCreateKeypair(join(ROLE_DIR, "buyer.json")),
  operator: loadOrCreateKeypair(join(ROLE_DIR, "operator.json")),
  treasury: loadOrCreateKeypair(join(ROLE_DIR, "treasury.json")),
};
const metaStore = loadMetaStore();

const client = OutcomeEscrowClient.fromKeypair(RPC_URL, roles.admin);
const app = express();
const wrap =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: (err?: unknown) => void) =>
    handler(req, res).catch(next);

function operatorRewardLamportsBn(): anchor.BN {
  return toBn(metaStore.mcpConnection.priceLamports, "operatorPriceLamports");
}

function serviceRewardForCreate(serviceIdInput: unknown): {
  rewardLamports: anchor.BN;
  pricingSource: string;
  serviceId: string | null;
} {
  const serviceId = String(serviceIdInput ?? "").trim();
  if (!serviceId) {
    return {
      rewardLamports: operatorRewardLamportsBn(),
      pricingSource: "operator-default",
      serviceId: null,
    };
  }

  const matched =
    metaStore.services.find((svc) => svc.id === serviceId) ||
    metaStore.services.find((svc) => svc.id === slugify(serviceId));
  if (!matched) {
    return {
      rewardLamports: operatorRewardLamportsBn(),
      pricingSource: "operator-default",
      serviceId: null,
    };
  }

  return {
    rewardLamports: toBn(matched.agentPriceLamports, "serviceAgentPriceLamports"),
    pricingSource: `catalog:${matched.id}`,
    serviceId: matched.id,
  };
}

app.use(express.json());
app.use(express.static(resolve(process.cwd(), "app/public")));

app.get(
  "/api/health",
  wrap(async (_req: Request, res: Response) => {
  const version = await client.provider.connection.getVersion();
  res.json({
    ok: true,
    rpcUrl: RPC_URL,
    programId: client.programId.toBase58(),
    version,
  });
  })
);

app.get("/api/wallets", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    roles: rolePublicKeys(roles),
  });
});

app.get(
  "/api/config",
  wrap(async (_req: Request, res: Response) => {
  const config = await client.fetchConfig();
  res.json({
    ok: true,
    configPda: client.configPda.toBase58(),
    config: serializeConfig(config),
  });
  })
);

app.post(
  "/api/bootstrap",
  wrap(async (req: Request, res: Response) => {
  const bootstrapSol = toNumber(req.body?.sol, 2);
  let initSig = await client.ensureConfig(
    roles.admin,
    roles.ops.publicKey,
    roles.treasury.publicKey
  );
  let updateOpsSig: string | null = null;
  const config = await client.fetchConfig();

  if (config && !config.ops.equals(roles.ops.publicKey)) {
    updateOpsSig = await client.updateOps(roles.admin, roles.ops.publicKey);
    initSig = initSig ?? updateOpsSig;
  }

  const funded: Record<string, string | null> = {};
  for (const role of ["ops", "buyer", "operator", "treasury"] as const) {
    try {
      funded[role] = await client.airdrop(roles[role].publicKey, bootstrapSol);
    } catch (_e) {
      funded[role] = null;
    }
  }

  const latestConfig = await client.fetchConfig();
  res.json({
    ok: true,
    initialized: Boolean(initSig || updateOpsSig),
    signature: initSig,
    updateOpsSignature: updateOpsSig,
    bootstrapSol,
    funded,
    configPda: client.configPda.toBase58(),
    config: serializeConfig(latestConfig),
  });
  })
);

app.post(
  "/api/airdrop",
  wrap(async (req: Request, res: Response) => {
  const role = (req.body.role ?? "buyer") as RoleName;
  const sol = toNumber(req.body.sol, 2);
  if (!roles[role]) {
    throw new Error(`invalid role: ${role}`);
  }

  const signature = await client.airdrop(roles[role].publicKey, sol);
  res.json({
    ok: true,
    role,
    sol,
    pubkey: roles[role].publicKey.toBase58(),
    signature,
  });
  })
);

app.get("/api/operator/catalog", (_req: Request, res: Response) => {
  const services = [...metaStore.services]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((svc) => serializeCatalogItem(svc));
  res.json({
    ok: true,
    services,
    operatorPriceLamports: metaStore.mcpConnection.priceLamports,
    operatorPriceSol: lamportsToSolText(metaStore.mcpConnection.priceLamports),
  });
});

app.post(
  "/api/operator/catalog",
  wrap(async (req: Request, res: Response) => {
    const normalized = normalizeCatalogItem(req.body ?? {}, metaStore.mcpConnection.priceLamports);
    const existingIndex = metaStore.services.findIndex((svc) => svc.id === normalized.id);
    let item: CatalogItem;

    if (existingIndex >= 0) {
      const prev = metaStore.services[existingIndex];
      item = {
        ...prev,
        ...normalized,
        id: prev.id,
        createdAt: prev.createdAt,
        updatedAt: nowIso(),
      };
      metaStore.services[existingIndex] = item;
    } else {
      item = normalized;
      metaStore.services.push(item);
    }

    persistMetaStore(metaStore);
    res.json({
      ok: true,
      service: serializeCatalogItem(item),
      services: metaStore.services.map((svc) => serializeCatalogItem(svc)),
      operatorPriceLamports: metaStore.mcpConnection.priceLamports,
      operatorPriceSol: lamportsToSolText(metaStore.mcpConnection.priceLamports),
    });
  })
);

app.get("/api/operator/mcp", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    connection: serializeMcpConnection(metaStore.mcpConnection),
  });
});

app.post(
  "/api/operator/mcp",
  wrap(async (req: Request, res: Response) => {
    const nextName =
      String(req.body?.name ?? metaStore.mcpConnection.name).trim() ||
      defaultMcpConnection().name;
    const nextServerUrl =
      req.body?.serverUrl === undefined
        ? metaStore.mcpConnection.serverUrl
        : normalizeServerUrl(req.body?.serverUrl);
    const nextHealthPath =
      req.body?.healthPath === undefined
        ? metaStore.mcpConnection.healthPath
        : normalizeHealthPath(req.body?.healthPath);
    const nextPriceLamports =
      req.body?.priceLamports === undefined
        ? metaStore.mcpConnection.priceLamports
        : normalizeLamports(req.body?.priceLamports, "priceLamports");
    const nextAuthToken =
      req.body?.authToken === undefined
        ? metaStore.mcpConnection.authToken
        : String(req.body?.authToken ?? "").trim();

    metaStore.mcpConnection = {
      ...metaStore.mcpConnection,
      name: nextName,
      serverUrl: nextServerUrl,
      healthPath: nextHealthPath,
      priceLamports: nextPriceLamports,
      authToken: nextAuthToken,
      lastMessage: "configuration updated",
      lastStatus: "idle",
      lastHttpStatus: null,
    };
    persistMetaStore(metaStore);

    res.json({
      ok: true,
      connection: serializeMcpConnection(metaStore.mcpConnection),
    });
  })
);

app.post(
  "/api/operator/mcp/test",
  wrap(async (req: Request, res: Response) => {
    const persisted = toBool(req.body?.persist, false);
    const name =
      String(req.body?.name ?? metaStore.mcpConnection.name).trim() ||
      defaultMcpConnection().name;
    const serverUrl = normalizeServerUrl(
      req.body?.serverUrl ?? metaStore.mcpConnection.serverUrl
    );
    const healthPath = normalizeHealthPath(
      req.body?.healthPath ?? metaStore.mcpConnection.healthPath
    );
    const priceLamports = normalizeLamports(
      req.body?.priceLamports ?? metaStore.mcpConnection.priceLamports,
      "priceLamports"
    );
    const authToken =
      req.body?.authToken === undefined
        ? metaStore.mcpConnection.authToken
        : String(req.body?.authToken ?? "").trim();

    const target = buildHealthTarget(serverUrl, healthPath);
    const startedAt = Date.now();
    const headers: Record<string, string> = {
      accept: "application/json,text/plain,*/*",
    };
    if (authToken) {
      headers.authorization = authToken.toLowerCase().startsWith("bearer ")
        ? authToken
        : `Bearer ${authToken}`;
    }

    let ok = false;
    let status: number | null = null;
    let preview = "";
    let message = "";

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(target, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      status = response.status;
      ok = response.ok;
      const body = await response.text();
      preview = body.slice(0, 320);
      message = response.ok
        ? "mcp server reachable"
        : `mcp server responded with ${response.status}`;
    } catch (e: any) {
      ok = false;
      status = null;
      message = String(e?.message ?? "connection failed");
      preview = "";
    }

    const updated: McpConnection = {
      ...metaStore.mcpConnection,
      name,
      serverUrl,
      healthPath,
      priceLamports,
      authToken,
      lastCheckedAt: nowIso(),
      lastStatus: ok ? "ok" : "error",
      lastHttpStatus: status,
      lastMessage: message,
    };
    if (persisted) {
      metaStore.mcpConnection = updated;
    } else {
      metaStore.mcpConnection = {
        ...metaStore.mcpConnection,
        lastCheckedAt: updated.lastCheckedAt,
        lastStatus: updated.lastStatus,
        lastHttpStatus: updated.lastHttpStatus,
        lastMessage: updated.lastMessage,
      };
    }
    persistMetaStore(metaStore);

    res.json({
      ok: true,
      target,
      durationMs: Date.now() - startedAt,
      test: {
        ok,
        status,
        message,
        preview,
      },
      connection: serializeMcpConnection(metaStore.mcpConnection),
    });
  })
);

app.post(
  "/api/jobs/spec",
  wrap(async (req: Request, res: Response) => {
    const buyer = toPubkey(req.body.buyer, "buyer").toBase58();
    const jobId = toBn(req.body.jobId, "jobId").toString();
    const key = specKey(buyer, jobId);
    const serviceId = String(req.body.serviceId ?? "").trim();
    const catalog = serviceId ? metaStore.services.find((svc) => svc.id === serviceId) : null;
    const serviceTitle = String(req.body.serviceTitle ?? catalog?.title ?? "").trim();
    if (!serviceTitle) {
      throw new Error("serviceTitle is required");
    }
    const taskTitle = String(req.body.taskTitle ?? serviceTitle).trim() || serviceTitle;
    const taskBrief = String(req.body.taskBrief ?? "").trim();
    const criteria = normalizeCriteria(req.body.criteria ?? {});
    const ts = nowIso();
    const prev = metaStore.specs[key];

    const spec: JobSpec = {
      key,
      buyer,
      jobId,
      serviceId: serviceId || catalog?.id || slugify(serviceTitle),
      serviceTitle,
      taskTitle,
      taskBrief,
      criteria,
      requestStatus: "pending",
      decisionReason: "",
      decidedAt: null,
      submittedAt: prev?.submittedAt ?? null,
      lastSubmissionPreview: prev?.lastSubmissionPreview ?? "",
      createdAt: prev?.createdAt ?? ts,
      updatedAt: ts,
    };

    metaStore.specs[key] = spec;
    persistMetaStore(metaStore);

    res.json({
      ok: true,
      spec,
    });
  })
);

app.get(
  "/api/jobs/spec/:jobId",
  wrap(async (req: Request, res: Response) => {
    const jobId = toBn(req.params.jobId, "jobId").toString();
    const buyerParam = Array.isArray(req.query.buyer) ? req.query.buyer[0] : req.query.buyer;
    const buyer =
      buyerParam === undefined || buyerParam === null || buyerParam === ""
        ? roles.buyer.publicKey.toBase58()
        : toPubkey(buyerParam, "buyer").toBase58();
    const key = specKey(buyer, jobId);
    res.json({
      ok: true,
      key,
      buyer,
      jobId,
      spec: metaStore.specs[key] ?? null,
    });
  })
);

app.get(
  "/api/operator/requests",
  wrap(async (req: Request, res: Response) => {
    const statusFilterRaw = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
    const statusFilter = statusFilterRaw ? String(statusFilterRaw).trim() : "";
    const specs = Object.values(metaStore.specs)
      .filter((spec) => !statusFilter || spec.requestStatus === statusFilter)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    const requests = await Promise.all(
      specs.map(async (spec) => {
        let job: any = null;
        let jobPda: string | null = null;
        try {
          const buyerPk = new PublicKey(spec.buyer);
          const jobBn = new anchor.BN(spec.jobId);
          const account = await client.fetchJob(buyerPk, jobBn);
          job = serializeJob(account);
          jobPda = client.jobPda(buyerPk, jobBn).toBase58();
        } catch (_e) {
          job = null;
          jobPda = null;
        }
        return {
          ...spec,
          jobPda,
          job,
        };
      })
    );

    const metrics = {
      total: requests.length,
      pending: requests.filter((r) => r.requestStatus === "pending").length,
      approved: requests.filter((r) => r.requestStatus === "approved").length,
      rejected: requests.filter((r) => r.requestStatus === "rejected").length,
      submittedOnChain: requests.filter((r) => Number(r.job?.status) === 2).length,
      settledOnChain: requests.filter((r) => Number(r.job?.status) === 4).length,
    };

    res.json({
      ok: true,
      metrics,
      requests,
    });
  })
);

app.post(
  "/api/operator/requests/decision",
  wrap(async (req: Request, res: Response) => {
    const buyer = toPubkey(req.body.buyer, "buyer").toBase58();
    const jobId = toBn(req.body.jobId, "jobId").toString();
    const decisionRaw = String(req.body.decision ?? "").trim().toLowerCase();
    if (decisionRaw !== "approved" && decisionRaw !== "rejected") {
      throw new Error("decision must be approved or rejected");
    }
    const decision = decisionRaw as RequestDecision;
    const key = specKey(buyer, jobId);
    const current = metaStore.specs[key];
    if (!current) {
      throw new Error("request spec not found for buyer/job");
    }

    const updated: JobSpec = {
      ...current,
      requestStatus: decision,
      decisionReason: String(req.body.reason ?? "").trim(),
      decidedAt: nowIso(),
      updatedAt: nowIso(),
    };
    metaStore.specs[key] = updated;
    persistMetaStore(metaStore);

    res.json({
      ok: true,
      spec: updated,
    });
  })
);

app.post(
  "/api/tx/create",
  wrap(async (req: Request, res: Response) => {
  const now = Math.floor(Date.now() / 1000);
  const buyer = toPubkey(req.body.buyer, "buyer");
  const jobId =
    req.body.jobId === undefined || req.body.jobId === null || req.body.jobId === ""
      ? new anchor.BN(now)
      : toBn(req.body.jobId, "jobId");
  const pricing = serviceRewardForCreate(req.body.serviceId);
  const rewardLamports = pricing.rewardLamports;
  const feeBps = toNumber(req.body.feeBps, 100);
  const deadlineAt = toBn(
    req.body.deadlineAt ?? now + toNumber(req.body.deadlineSeconds, 3600),
    "deadlineAt"
  );

  const { tx, job } = await client.buildCreateJobTx({
    buyer,
    operator: roles.operator.publicKey,
    jobId,
    rewardLamports,
    feeBps,
    deadlineAt,
  });
  await client.hydrateTransaction(tx, buyer);

  res.json({
    ok: true,
    txBase64: serializeUnsignedTx(tx),
    buyer: buyer.toBase58(),
    operator: roles.operator.publicKey.toBase58(),
    jobPda: job.toBase58(),
    jobId: jobId.toString(),
    serviceId: pricing.serviceId,
    rewardLamports: rewardLamports.toString(),
    pricingSource: pricing.pricingSource,
  });
  })
);

app.post(
  "/api/tx/fund",
  wrap(async (req: Request, res: Response) => {
  const buyer = toPubkey(req.body.buyer, "buyer");
  const jobId = toBn(req.body.jobId, "jobId");

  const { tx, job } = await client.buildFundJobTx(buyer, jobId);
  await client.hydrateTransaction(tx, buyer);

  res.json({
    ok: true,
    txBase64: serializeUnsignedTx(tx),
    buyer: buyer.toBase58(),
    jobPda: job.toBase58(),
    jobId: jobId.toString(),
  });
  })
);

app.post(
  "/api/tx/review",
  wrap(async (req: Request, res: Response) => {
  const buyer = toPubkey(req.body.buyer, "buyer");
  const jobId = toBn(req.body.jobId, "jobId");
  const approve = toBool(req.body.approve, true);

  const { tx, job } = await client.buildReviewJobTx(
    buyer,
    roles.operator.publicKey,
    jobId,
    approve
  );
  await client.hydrateTransaction(tx, buyer);

  res.json({
    ok: true,
    txBase64: serializeUnsignedTx(tx),
    buyer: buyer.toBase58(),
    approve,
    jobPda: job.toBase58(),
    jobId: jobId.toString(),
  });
  })
);

app.post(
  "/api/tx/timeout",
  wrap(async (req: Request, res: Response) => {
  const actor = toPubkey(req.body.actor, "actor");
  const buyer = toPubkey(req.body.buyer, "buyer");
  const jobId = toBn(req.body.jobId, "jobId");

  const { tx, job } = await client.buildTriggerTimeoutTx(actor, buyer, jobId);
  await client.hydrateTransaction(tx, actor);

  res.json({
    ok: true,
    txBase64: serializeUnsignedTx(tx),
    actor: actor.toBase58(),
    buyer: buyer.toBase58(),
    jobPda: job.toBase58(),
    jobId: jobId.toString(),
  });
  })
);

app.post(
  "/api/tx/send",
  wrap(async (req: Request, res: Response) => {
  const signedTxBase64 = String(req.body.signedTxBase64 ?? "");
  if (!signedTxBase64) {
    throw new Error("missing field: signedTxBase64");
  }
  const raw = Buffer.from(signedTxBase64, "base64");
  const signature = await client.provider.connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await client.provider.connection.confirmTransaction(signature, "confirmed");

  let events: Array<{ name: string; data: unknown }> = [];
  try {
    const parsed = await client.parseEvents(signature);
    events = parsed.map((e) => ({ name: e.name, data: serializeAny(e.data) }));
  } catch (_e) {
    events = [];
  }

  res.json({
    ok: true,
    signature,
    events,
  });
  })
);

app.post(
  "/api/jobs/create",
  wrap(async (req: Request, res: Response) => {
  const now = Math.floor(Date.now() / 1000);
  const jobId =
    req.body.jobId === undefined || req.body.jobId === null || req.body.jobId === ""
      ? new anchor.BN(now)
      : toBn(req.body.jobId, "jobId");
  const pricing = serviceRewardForCreate(req.body.serviceId);
  const rewardLamports = pricing.rewardLamports;
  const feeBps = toNumber(req.body.feeBps, 100);
  const deadlineAt = toBn(
    req.body.deadlineAt ?? now + toNumber(req.body.deadlineSeconds, 3600),
    "deadlineAt"
  );

  const { signature, job } = await client.createJob({
    buyer: roles.buyer,
    operator: roles.operator.publicKey,
    jobId,
    rewardLamports,
    feeBps,
    deadlineAt,
  });

  const account = await client.fetchJob(roles.buyer.publicKey, jobId);

  res.json({
    ok: true,
    signature,
    jobPda: job.toBase58(),
    jobId: jobId.toString(),
    serviceId: pricing.serviceId,
    rewardLamports: rewardLamports.toString(),
    pricingSource: pricing.pricingSource,
    job: serializeJob(account),
  });
  })
);

app.post(
  "/api/jobs/fund",
  wrap(async (req: Request, res: Response) => {
  const jobId = toBn(req.body.jobId, "jobId");
  const { signature, job } = await client.fundJob(roles.buyer, jobId);
  const account = await client.fetchJob(roles.buyer.publicKey, jobId);
  res.json({
    ok: true,
    signature,
    jobPda: job.toBase58(),
    job: serializeJob(account),
  });
  })
);

app.post(
  "/api/jobs/submit",
  wrap(async (req: Request, res: Response) => {
  const jobId = toBn(req.body.jobId, "jobId");
  const buyer =
    req.body.buyer === undefined || req.body.buyer === null || req.body.buyer === ""
      ? roles.buyer.publicKey
      : toPubkey(req.body.buyer, "buyer");
  const submission = String(req.body.submission ?? `submission-${Date.now()}`);
  const specLookupKey = specKey(buyer.toBase58(), jobId.toString());
  const linkedSpec = metaStore.specs[specLookupKey];
  if (linkedSpec && linkedSpec.requestStatus === "rejected") {
    throw new Error("request was rejected by operator. update spec and approve request first");
  }

  const { signature, job } = await client.submitResult(buyer, roles.operator, jobId, submission);
  const account = await client.fetchJob(buyer, jobId);

  if (linkedSpec) {
    metaStore.specs[specLookupKey] = {
      ...linkedSpec,
      requestStatus: linkedSpec.requestStatus === "pending" ? "approved" : linkedSpec.requestStatus,
      submittedAt: nowIso(),
      lastSubmissionPreview: submission.slice(0, 180),
      updatedAt: nowIso(),
    };
    persistMetaStore(metaStore);
  }

  res.json({
    ok: true,
    signature,
    buyer: buyer.toBase58(),
    jobPda: job.toBase58(),
    job: serializeJob(account),
  });
  })
);

app.post(
  "/api/jobs/review",
  wrap(async (req: Request, res: Response) => {
  const jobId = toBn(req.body.jobId, "jobId");
  const buyer =
    req.body.buyer === undefined || req.body.buyer === null || req.body.buyer === ""
      ? roles.buyer
      : null;
  if (!buyer) {
    throw new Error("custodial /api/jobs/review supports only server buyer. use /api/tx/review for Phantom");
  }
  const approve = toBool(req.body.approve, true);
  const { signature, job } = await client.reviewJob(buyer, roles.operator.publicKey, jobId, approve);
  const account = await client.fetchJob(roles.buyer.publicKey, jobId);
  res.json({
    ok: true,
    signature,
    approve,
    jobPda: job.toBase58(),
    job: serializeJob(account),
  });
  })
);

app.post(
  "/api/jobs/timeout",
  wrap(async (req: Request, res: Response) => {
  const jobId = toBn(req.body.jobId, "jobId");
  const actorRole = (req.body.actorRole ?? "buyer") as "buyer" | "ops";
  const buyer =
    req.body.buyer === undefined || req.body.buyer === null || req.body.buyer === ""
      ? roles.buyer.publicKey
      : toPubkey(req.body.buyer, "buyer");

  if (actorRole === "buyer" && !buyer.equals(roles.buyer.publicKey)) {
    throw new Error("buyer timeout for external buyer must use /api/tx/timeout + wallet signature");
  }
  const actor = actorRole === "ops" ? roles.ops : roles.buyer;

  const { signature, job } = await client.triggerTimeout(actor, buyer, jobId);
  const account = await client.fetchJob(buyer, jobId);
  res.json({
    ok: true,
    signature,
    actorRole,
    buyer: buyer.toBase58(),
    jobPda: job.toBase58(),
    job: serializeJob(account),
  });
  })
);

app.post(
  "/api/jobs/resolve",
  wrap(async (req: Request, res: Response) => {
  const jobId = toBn(req.body.jobId, "jobId");
  const buyer =
    req.body.buyer === undefined || req.body.buyer === null || req.body.buyer === ""
      ? roles.buyer.publicKey
      : toPubkey(req.body.buyer, "buyer");
  const payoutLamports = toBn(req.body.payoutLamports ?? 0, "payoutLamports");
  const reason = String(req.body.reason ?? "manual_resolution");

  const { signature, job } = await client.resolveDispute({
    ops: roles.ops,
    buyer,
    operator: roles.operator.publicKey,
    jobId,
    payoutLamports,
    reason,
  });
  const account = await client.fetchJob(buyer, jobId);
  res.json({
    ok: true,
    signature,
    buyer: buyer.toBase58(),
    reason,
    jobPda: job.toBase58(),
    job: serializeJob(account),
  });
  })
);

app.get(
  "/api/jobs/:jobId",
  wrap(async (req: Request, res: Response) => {
  const jobId = toBn(req.params.jobId, "jobId");
  const buyerParam = Array.isArray(req.query.buyer) ? req.query.buyer[0] : req.query.buyer;
  const buyer =
    buyerParam === undefined || buyerParam === null || buyerParam === ""
      ? roles.buyer.publicKey
      : toPubkey(buyerParam, "buyer");
  const jobPda = client.jobPda(buyer, jobId);
  const account = await client.fetchJob(buyer, jobId);
  res.json({
    ok: true,
    buyer: buyer.toBase58(),
    jobPda: jobPda.toBase58(),
    job: serializeJob(account),
  });
  })
);

app.get(
  "/api/events/:signature",
  wrap(async (req: Request, res: Response) => {
  const signature = Array.isArray(req.params.signature)
    ? req.params.signature[0]
    : req.params.signature;
  const events = await client.parseEvents(signature);
  res.json({
    ok: true,
    events: events.map((e) => ({ name: e.name, data: serializeAny(e.data) })),
  });
  })
);

app.use((err: any, _req: Request, res: Response, _next: unknown) => {
  const message = err?.message ?? "unknown error";
  res.status(400).json({ ok: false, error: message });
});

app.listen(PORT, () => {
  console.log(`OutcomeEscrow app server listening on http://localhost:${PORT}`);
  console.log(`RPC URL: ${RPC_URL}`);
  console.log(`Program ID: ${client.programId.toBase58()}`);
  console.log("Roles:", rolePublicKeys(roles));
});
