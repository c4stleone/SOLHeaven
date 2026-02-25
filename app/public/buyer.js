const $ = (id) => document.getElementById(id);

const walletsView = $("wallets-view");
const configView = $("config-view");
const jobView = $("job-view");
const specView = $("spec-view");
const logView = $("log-view");
const phantomView = $("phantom-view");
const activityFeed = $("activity-feed");
const productGrid = $("product-grid");
const marketSearch = $("market-search");
const marketCategory = $("market-category");

const LAMPORTS_PER_SOL = 1_000_000_000n;
const STORAGE_RECENT_JOBS = "oe_recent_jobs_v2";
const STORAGE_JOB_META = "oe_job_meta_v1";

const STATUS_META = {
  0: {
    label: "Created",
    tone: "draft",
    nextAction: "에스크로 예치(Fund)를 먼저 실행하세요.",
  },
  1: {
    label: "Funded",
    tone: "funded",
    nextAction: "수행자의 결과 제출을 기다리세요.",
  },
  2: {
    label: "Submitted",
    tone: "submitted",
    nextAction: "결과를 확인하고 승인 또는 거절을 선택하세요.",
  },
  3: {
    label: "Disputed",
    tone: "disputed",
    nextAction: "운영자(Ops) 분쟁 판정을 기다리세요.",
  },
  4: {
    label: "Settled",
    tone: "settled",
    nextAction: "정산이 완료된 작업입니다.",
  },
};

const state = {
  provider: null,
  buyer: null,
  busy: false,
  currentJob: null,
  currentSpec: null,
  services: [],
  operatorPriceLamports: "1000000",
  selectedServiceId: "",
  serviceFilter: {
    query: "",
    category: "",
  },
  recentJobs: loadJson(STORAGE_RECENT_JOBS, []),
  jobMeta: loadJson(STORAGE_JOB_META, {}),
  activity: [],
};

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch (_e) {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_e) {
    // ignore storage errors
  }
}

function appendLog(title, payload, tone = "info") {
  const ts = new Date().toLocaleTimeString();
  const body =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  logView.textContent = `[${ts}] ${title}\n${body}\n\n${logView.textContent}`;
  state.activity.unshift({ ts, title, body, tone });
  state.activity = state.activity.slice(0, 40);
  renderActivity();
}

function renderActivity() {
  activityFeed.innerHTML = "";
  if (!state.activity.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "아직 실행된 액션이 없습니다.";
    activityFeed.appendChild(empty);
    return;
  }

  for (const entry of state.activity) {
    const item = document.createElement("article");
    item.className = `activity-item tone-${entry.tone === "error" ? "disputed" : "muted"}`;

    const head = document.createElement("div");
    head.className = "activity-head";

    const title = document.createElement("strong");
    title.textContent = entry.title;

    const time = document.createElement("span");
    time.className = "activity-time";
    time.textContent = entry.ts;

    head.append(title, time);

    const body = document.createElement("pre");
    body.className = "activity-body";
    body.textContent = entry.body;

    item.append(head, body);
    activityFeed.appendChild(item);
  }
}

function renderJson(el, value) {
  el.textContent = JSON.stringify(value, null, 2);
}

function normalizeDigits(value, field) {
  const v = String(value ?? "").trim().replace(/,/g, "");
  if (!/^\d+$/.test(v)) {
    throw new Error(`${field}는 숫자만 입력하세요.`);
  }
  return v;
}

function numberOrZero(value, field) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return 0;
  }
  return Number(normalizeDigits(raw, field));
}

function requiredJobId() {
  return normalizeDigits($("action-job-id").value, "job id");
}

function toBigInt(value) {
  try {
    return BigInt(String(value ?? "0"));
  } catch (_e) {
    return 0n;
  }
}

function lamportsToSolText(value) {
  const lamports = toBigInt(value);
  const whole = lamports / LAMPORTS_PER_SOL;
  const fractional = (lamports % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .slice(0, 4);
  return `${whole}.${fractional}`;
}

function lamportsLabel(value) {
  return `${lamportsToSolText(value)} SOL (${String(value)} lamports)`;
}

function formatUnixTs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return "-";
  }
  return new Date(n * 1000).toLocaleString();
}

function shortPubkey(key) {
  if (!key || typeof key !== "string") {
    return "-";
  }
  if (key.length < 10) {
    return key;
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function statusMeta(status) {
  const id = Number(status);
  if (Number.isFinite(id) && STATUS_META[id]) {
    return STATUS_META[id];
  }
  return {
    label: `Unknown(${String(status)})`,
    tone: "muted",
    nextAction: "작업을 다시 조회해 상태를 확인하세요.",
  };
}

function getProvider() {
  if (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) {
    return window.phantom.solana;
  }
  if (window.solana && window.solana.isPhantom) {
    return window.solana;
  }
  return null;
}

function base64ToBytes(base64) {
  const raw = String(base64 ?? "").trim().replace(/\r|\n/g, "");
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + "=".repeat(4 - (normalized.length % 4));

  let binary;
  try {
    binary = atob(padded);
  } catch (_e) {
    throw new Error("tx base64 decode failed");
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll("[data-busy-lock]").forEach((el) => {
    el.disabled = busy;
  });
}

function renderPhantom(extra) {
  const connected = Boolean(state.buyer);
  const chip = $("wallet-chip");
  const address = $("wallet-address");

  chip.className = `status-chip ${connected ? "tone-funded" : "tone-muted"}`;
  chip.textContent = connected ? "Connected" : "Disconnected";
  address.textContent = connected ? `${shortPubkey(state.buyer)} (${state.buyer})` : "Phantom 연결 필요";

  renderJson(phantomView, {
    available: Boolean(getProvider()),
    connected,
    buyer: state.buyer,
    rpc: "http://127.0.0.1:8899",
    ...extra,
  });
}

function syncJobId(jobId) {
  if (!jobId) {
    return;
  }
  $("action-job-id").value = String(jobId);
  $("create-job-id").value = String(jobId);
}

function persistRecentJobs() {
  saveJson(STORAGE_RECENT_JOBS, state.recentJobs);
}

function persistJobMeta() {
  saveJson(STORAGE_JOB_META, state.jobMeta);
}

function setJobMeta(jobId, title, brief, serviceTitle) {
  const key = String(jobId);
  state.jobMeta[key] = {
    title: String(title || "").trim(),
    brief: String(brief || "").trim(),
    serviceTitle: String(serviceTitle || "").trim(),
    updatedAtMs: Date.now(),
  };
  persistJobMeta();
}

function upsertRecentJob(job) {
  if (!job || !job.jobId || !job.buyer) {
    return;
  }

  const key = `${job.buyer}:${job.jobId}`;
  const idx = state.recentJobs.findIndex((it) => `${it.buyer}:${it.jobId}` === key);
  const merged = {
    ...(idx >= 0 ? state.recentJobs[idx] : {}),
    ...job,
    ...state.jobMeta[String(job.jobId)],
    seenAtMs: Date.now(),
  };

  if (idx >= 0) {
    state.recentJobs[idx] = merged;
  } else {
    state.recentJobs.push(merged);
  }

  state.recentJobs.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  state.recentJobs = state.recentJobs.slice(0, 30);
  persistRecentJobs();
}

function renderKpis() {
  let active = 0;
  let pendingReview = 0;
  let settled = 0;
  let locked = 0n;

  for (const job of state.recentJobs) {
    const status = Number(job.status);
    if (status === 4) {
      settled += 1;
    } else {
      active += 1;
    }
    if (status === 2) {
      pendingReview += 1;
    }
    if (status === 1 || status === 2 || status === 3) {
      locked += toBigInt(job.reward);
    }
  }

  $("metric-active").textContent = String(active);
  $("metric-pending-review").textContent = String(pendingReview);
  $("metric-settled").textContent = String(settled);
  $("metric-lock-sol").textContent = lamportsToSolText(locked);
}

function renderRecentJobs() {
  const wrap = $("recent-jobs");
  wrap.innerHTML = "";

  if (!state.recentJobs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "아직 저장된 작업이 없습니다.";
    wrap.appendChild(empty);
    return;
  }

  for (const item of state.recentJobs) {
    const meta = statusMeta(item.status);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "job-item";
    card.dataset.jobId = String(item.jobId);

    if (state.currentJob && String(state.currentJob.jobId) === String(item.jobId)) {
      card.classList.add("active");
    }

    const top = document.createElement("div");
    top.className = "job-item-top";

    const id = document.createElement("strong");
    id.textContent = `#${item.jobId}`;

    const chip = document.createElement("span");
    chip.className = `status-chip tone-${meta.tone}`;
    chip.textContent = meta.label;

    top.append(id, chip);

    const title = document.createElement("p");
    title.className = "job-item-title";
    title.textContent =
      item.title ||
      item.serviceTitle ||
      item.brief ||
      `buyer ${shortPubkey(item.buyer)}`;

    const foot = document.createElement("div");
    foot.className = "job-item-foot";
    foot.textContent = `${lamportsToSolText(item.reward)} SOL | updated ${formatUnixTs(item.updatedAt)}`;

    card.append(top, title, foot);
    wrap.appendChild(card);
  }
}

function renderSpec(spec) {
  state.currentSpec = spec || null;
  if (!spec) {
    renderJson(specView, { message: "등록된 요청 스펙이 없습니다." });
    return;
  }
  renderJson(specView, spec);
}

function resetSummary() {
  $("summary-job-id").textContent = "-";
  $("summary-reward").textContent = "-";
  $("summary-deadline").textContent = "-";
  $("summary-updated").textContent = "-";
  $("summary-operator-receive").textContent = "-";
  $("summary-buyer-refund").textContent = "-";
  $("job-status-chip").className = "status-chip tone-muted";
  $("job-status-chip").textContent = "No job selected";
  $("job-next-action").textContent = "작업을 조회하면 추천 액션이 표시됩니다.";
  renderJson(jobView, {});
  renderSpec(null);
}

function renderCurrentJob() {
  const job = state.currentJob;
  if (!job) {
    resetSummary();
    return;
  }

  const meta = statusMeta(job.status);

  $("summary-job-id").textContent = String(job.jobId);
  $("summary-reward").textContent = lamportsLabel(job.reward);
  $("summary-deadline").textContent = formatUnixTs(job.deadlineAt);
  $("summary-updated").textContent = formatUnixTs(job.updatedAt);
  $("summary-operator-receive").textContent = lamportsLabel(job.operatorReceive);
  $("summary-buyer-refund").textContent = lamportsLabel(job.buyerRefund);

  const chip = $("job-status-chip");
  chip.className = `status-chip tone-${meta.tone}`;
  chip.textContent = meta.label;

  $("job-next-action").textContent = meta.nextAction;
  renderJson(jobView, job);
}

function ingestJobBundle(bundle) {
  if (bundle && bundle.job) {
    state.currentJob = bundle.job;
    upsertRecentJob(bundle.job);
  }
  if (bundle && Object.prototype.hasOwnProperty.call(bundle, "spec")) {
    renderSpec(bundle.spec);
    if (bundle.spec && bundle.spec.serviceId) {
      selectService(String(bundle.spec.serviceId), false);
    }
  }
  renderCurrentJob();
  renderRecentJobs();
  renderKpis();
}

function suggestedRewardLamports() {
  const svc = selectedService();
  return serviceRewardLamports(svc);
}

function serviceRewardLamports(service) {
  const candidate =
    service && service.agentPriceLamports !== undefined && service.agentPriceLamports !== null
      ? String(service.agentPriceLamports)
      : String(state.operatorPriceLamports || "");
  const price = candidate.trim().replace(/,/g, "");
  if (!/^\d+$/.test(price)) {
    return "1000000";
  }
  return price;
}

function selectedService() {
  const hiddenInput = $("create-service-id");
  const serviceId = String(hiddenInput.value || state.selectedServiceId || "").trim();
  if (!serviceId) {
    return null;
  }
  return state.services.find((svc) => svc.id === serviceId) || null;
}

function criteriaFromForm() {
  return {
    minPages: numberOrZero($("criteria-min-pages").value, "최소 페이지 수"),
    minSourceLinks: numberOrZero($("criteria-min-source-links").value, "최소 출처 링크 수"),
    minTrustedDomainRatio: Math.min(
      100,
      numberOrZero($("criteria-min-trusted-ratio").value, "신뢰도 도메인 비율")
    ),
    requireTableOrChart: $("criteria-require-chart").checked,
    requiredFormat: String($("criteria-required-format").value || "PDF").trim() || "PDF",
    requiredQuestions: String($("criteria-required-questions").value || "")
      .split("\n")
      .map((v) => v.trim())
      .filter((v) => Boolean(v)),
    extraNotes: String($("criteria-extra-notes").value || "").trim(),
  };
}

function renderMarketCategoryOptions(services) {
  const categories = [...new Set(services.map((svc) => String(svc.category || "general").trim()))]
    .filter((v) => Boolean(v))
    .sort((a, b) => a.localeCompare(b));

  const current = String(state.serviceFilter.category || "").trim();
  marketCategory.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "전체 카테고리";
  marketCategory.appendChild(allOption);

  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    marketCategory.appendChild(option);
  }

  if (current && categories.includes(current)) {
    marketCategory.value = current;
  } else {
    marketCategory.value = "";
    state.serviceFilter.category = "";
  }
}

function filteredServices() {
  const query = String(state.serviceFilter.query || "").trim().toLowerCase();
  const category = String(state.serviceFilter.category || "").trim();
  return state.services.filter((svc) => {
    const matchedCategory = !category || String(svc.category || "") === category;
    if (!matchedCategory) {
      return false;
    }
    if (!query) {
      return true;
    }
    const text = `${svc.title || ""} ${svc.summary || ""} ${svc.category || ""} ${svc.outputFormat || ""}`
      .toLowerCase();
    return text.includes(query);
  });
}

function renderSelectedServiceBox() {
  const svc = selectedService();
  const title = $("selected-service-title");
  const format = $("selected-service-format");
  const summary = $("selected-service-summary");
  const category = $("selected-service-category");
  const serviceId = $("selected-service-id");
  const price = $("selected-service-price");

  if (!svc) {
    title.textContent = "상품을 선택하세요";
    format.className = "status-chip tone-muted";
    format.textContent = "-";
    summary.textContent = "위 상품 목록에서 카드를 선택하면 상세가 표시됩니다.";
    category.className = "status-chip tone-muted";
    category.textContent = "카테고리 미선택";
    serviceId.className = "status-chip tone-muted";
    serviceId.textContent = "ID -";
    price.className = "status-chip tone-muted";
    price.textContent = "가격 -";
    return;
  }

  title.textContent = svc.title;
  format.className = "status-chip tone-submitted";
  format.textContent = svc.outputFormat || "N/A";
  summary.textContent = svc.summary || "설명이 등록되지 않은 상품입니다.";
  category.className = "status-chip tone-funded";
  category.textContent = svc.category || "general";
  serviceId.className = "status-chip tone-muted";
  serviceId.textContent = `ID ${svc.id}`;
  price.className = "status-chip tone-submitted";
  price.textContent = `가격 ${serviceRewardLamports(svc)} lamports`;
}

function renderProductGrid() {
  productGrid.innerHTML = "";
  const list = filteredServices();

  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "조건에 맞는 MCP 상품이 없습니다.";
    productGrid.appendChild(empty);
    return;
  }

  for (const svc of list) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "product-card";
    card.dataset.serviceId = svc.id;
    const isActive = state.selectedServiceId === svc.id;
    if (isActive) {
      card.classList.add("active");
    }
    card.setAttribute("aria-pressed", isActive ? "true" : "false");

    const head = document.createElement("div");
    head.className = "product-card-head";

    const badgeWrap = document.createElement("div");
    badgeWrap.className = "product-card-badges";

    const badge = document.createElement("span");
    badge.className = "status-chip tone-submitted";
    badge.textContent = "MCP SERVICE";

    const format = document.createElement("span");
    format.className = "status-chip tone-muted";
    format.textContent = svc.outputFormat || "N/A";

    badgeWrap.append(badge, format);

    const cta = document.createElement("span");
    cta.className = "product-card-cta";
    cta.textContent = isActive ? "선택됨" : "선택하기";

    head.append(badgeWrap, cta);

    const title = document.createElement("h3");
    title.textContent = svc.title;

    const summary = document.createElement("p");
    summary.className = "product-card-summary";
    summary.textContent = svc.summary || "설명이 등록되지 않은 상품입니다.";

    const meta = document.createElement("div");
    meta.className = "product-card-meta";

    const category = document.createElement("span");
    category.className = "status-chip tone-funded";
    category.textContent = svc.category || "general";

    const provider = document.createElement("span");
    provider.className = "status-chip tone-muted";
    provider.textContent = "Operator Verified";

    const reward = document.createElement("strong");
    reward.textContent = `운영자 가격 ${serviceRewardLamports(svc)} lamports`;

    meta.append(category, provider, reward);
    card.append(head, title, summary, meta);
    productGrid.appendChild(card);
  }
}

function selectService(serviceId, useSuggestion = true) {
  const exists = state.services.some((svc) => svc.id === serviceId);
  if (!exists) {
    return;
  }
  state.selectedServiceId = serviceId;
  $("create-service-id").value = serviceId;
  renderProductGrid();
  renderSelectedServiceBox();
  if (useSuggestion) {
    applyServiceSuggestion();
  }
}

function renderServiceOptions(services) {
  const previous = String(state.selectedServiceId || $("create-service-id").value || "").trim();
  renderMarketCategoryOptions(services);
  if (previous && services.some((svc) => svc.id === previous)) {
    state.selectedServiceId = previous;
  } else if (services[0]) {
    state.selectedServiceId = services[0].id;
  } else {
    state.selectedServiceId = "";
  }
  $("create-service-id").value = state.selectedServiceId;
  renderProductGrid();
  renderSelectedServiceBox();
}

function applyServiceSuggestion() {
  const svc = selectedService();
  if (!svc) {
    return;
  }
  if (!$("create-title").value.trim()) {
    $("create-title").value = svc.title;
  }
  if (!$("create-brief").value.trim()) {
    $("create-brief").value = svc.summary || "";
  }
  const formatValue = String($("criteria-required-format").value || "").trim();
  if (!formatValue || formatValue === "PDF") {
    $("criteria-required-format").value = svc.outputFormat || "PDF";
  }
  const rewardInput = $("create-reward");
  rewardInput.value = suggestedRewardLamports();
}

async function loadCatalog() {
  const data = await api("/api/operator/catalog");
  const priceRaw = String(data.operatorPriceLamports ?? state.operatorPriceLamports)
    .trim()
    .replace(/,/g, "");
  state.operatorPriceLamports = /^\d+$/.test(priceRaw) ? priceRaw : "1000000";
  state.services = Array.isArray(data.services)
    ? data.services.map((svc) => {
        const raw = String(svc.agentPriceLamports ?? state.operatorPriceLamports)
          .trim()
          .replace(/,/g, "");
        return {
          ...svc,
          agentPriceLamports: /^\d+$/.test(raw) ? raw : state.operatorPriceLamports,
        };
      })
    : [];
  $("create-reward").value = suggestedRewardLamports();
  renderServiceOptions(state.services);
  applyServiceSuggestion();
  return state.services;
}

async function connectPhantom(options) {
  const provider = getProvider();
  if (!provider) {
    throw new Error("Phantom extension을 찾을 수 없습니다.");
  }
  const response = await provider.connect(options);
  state.provider = provider;
  state.buyer = (response.publicKey || provider.publicKey).toBase58();
  renderPhantom();
  return state.buyer;
}

async function ensureBuyer() {
  if (!state.buyer) {
    await connectPhantom();
  }
  return state.buyer;
}

async function disconnectPhantom() {
  const provider = state.provider || getProvider();
  if (provider && provider.isConnected) {
    await provider.disconnect();
  }
  state.provider = provider;
  state.buyer = null;
  renderPhantom();
}

async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `request failed: ${path}`);
  }
  return data;
}

async function refreshPanels() {
  const [wallets, config] = await Promise.all([api("/api/wallets"), api("/api/config")]);
  renderJson(walletsView, wallets.roles);
  renderJson(configView, { configPda: config.configPda, config: config.config });
}

async function fetchJobBundle(jobId) {
  const buyer = await ensureBuyer();
  const [jobRes, specRes] = await Promise.all([
    api(`/api/jobs/${jobId}?buyer=${encodeURIComponent(buyer)}`),
    api(`/api/jobs/spec/${jobId}?buyer=${encodeURIComponent(buyer)}`),
  ]);
  return {
    buyer,
    jobId,
    job: jobRes.job,
    spec: specRes.spec,
  };
}

async function saveSpec(jobId, payload) {
  const buyer = await ensureBuyer();
  return api("/api/jobs/spec", "POST", {
    buyer,
    jobId,
    ...payload,
  });
}

async function signAndSend(buildPath, payload) {
  const buyer = await ensureBuyer();
  const provider = state.provider || getProvider();
  if (!provider) {
    throw new Error("phantom provider not available");
  }

  const built = await api(buildPath, "POST", { ...payload, buyer });
  const tx = window.solanaWeb3.Transaction.from(base64ToBytes(built.txBase64));
  const signed = await provider.signTransaction(tx);
  const signedTxBase64 = bytesToBase64(signed.serialize());
  const sent = await api("/api/tx/send", "POST", { signedTxBase64 });
  return { ...built, ...sent, signature: sent.signature };
}

async function withAction(name, fn) {
  if (state.busy) {
    return null;
  }
  setBusy(true);
  try {
    const result = await fn();
    appendLog(name, result, "ok");

    if (result && (result.job || Object.prototype.hasOwnProperty.call(result, "spec"))) {
      ingestJobBundle({ job: result.job, spec: result.spec });
    }
    if (result && result.jobId) {
      syncJobId(result.jobId);
    }
    if (result && result.signature) {
      try {
        const events = await api(`/api/events/${result.signature}`);
        appendLog(`${name}:events`, events.events, "info");
      } catch (e) {
        appendLog(`${name}:events`, String(e.message || e), "error");
      }
    }

    return result;
  } catch (e) {
    appendLog(`${name}:error`, String(e.message || e), "error");
    return null;
  } finally {
    setBusy(false);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  state.provider = getProvider();
  renderPhantom();
  renderActivity();
  renderRecentJobs();
  renderKpis();
  resetSummary();

  try {
    if (state.provider) {
      const response = await state.provider.connect({ onlyIfTrusted: true });
      if (response && response.publicKey) {
        state.buyer = response.publicKey.toBase58();
      }
    }
  } catch (_e) {
    // ignore
  }

  renderPhantom();

  if (state.recentJobs.length > 0) {
    syncJobId(state.recentJobs[0].jobId);
  }

  await withAction("health", () => api("/api/health"));
  await withAction("refresh", async () => {
    await Promise.all([refreshPanels(), loadCatalog()]);
    return { ok: true };
  });

  $("btn-refresh").addEventListener("click", () =>
    withAction("refresh", async () => {
      await Promise.all([refreshPanels(), loadCatalog()]);
      return { ok: true };
    })
  );

  $("btn-bootstrap").addEventListener("click", () =>
    withAction("bootstrap", () => api("/api/bootstrap", "POST", { sol: 2 }))
  );

  $("btn-refresh-services").addEventListener("click", () =>
    withAction("refreshServices", async () => {
      const services = await loadCatalog();
      return { serviceCount: services.length };
    })
  );

  marketSearch.addEventListener("input", () => {
    state.serviceFilter.query = String(marketSearch.value || "");
    renderProductGrid();
  });

  marketCategory.addEventListener("change", () => {
    state.serviceFilter.category = String(marketCategory.value || "");
    renderProductGrid();
  });

  productGrid.addEventListener("click", (e) => {
    const target = e.target.closest("button[data-service-id]");
    if (!target) {
      return;
    }
    selectService(String(target.dataset.serviceId || ""), true);
  });

  $("btn-phantom-connect").addEventListener("click", () =>
    withAction("phantomConnect", async () => ({ buyer: await connectPhantom() }))
  );

  $("btn-phantom-disconnect").addEventListener("click", () =>
    withAction("phantomDisconnect", async () => {
      await disconnectPhantom();
      return { disconnected: true };
    })
  );

  $("form-create").addEventListener("submit", (e) => {
    e.preventDefault();
    withAction("createJob", async () => {
      const inputJobId = $("create-job-id").value.trim();
      const jobId = inputJobId ? normalizeDigits(inputJobId, "job id") : undefined;
      const title = $("create-title").value.trim();
      const brief = $("create-brief").value.trim();
      const autoFund = $("create-auto-fund").checked;
      const service = selectedService();
      if (!service) {
        throw new Error("선택 가능한 MCP 서비스가 없습니다. 운영자가 상품을 등록했는지 확인하세요.");
      }

  const payload = {
        jobId,
        serviceId: service.id,
        rewardLamports: suggestedRewardLamports(),
        feeBps: Number($("create-fee-bps").value || 100),
        deadlineSeconds: normalizeDigits($("create-deadline-seconds").value, "deadline"),
      };

      const created = await signAndSend("/api/tx/create", payload);
      syncJobId(created.jobId);
      setJobMeta(created.jobId, title, brief, service.title);

      const savedSpec = await saveSpec(created.jobId, {
        serviceId: service.id,
        serviceTitle: service.title,
        taskTitle: title || service.title,
        taskBrief: brief,
        criteria: criteriaFromForm(),
      });

      let fundResult = null;
      if (autoFund) {
        fundResult = await signAndSend("/api/tx/fund", { jobId: created.jobId });
      }

      const fetched = await fetchJobBundle(created.jobId);
      return {
        ...created,
        autoFund,
        fundSignature: fundResult ? fundResult.signature : null,
        specSaved: savedSpec.spec,
        jobId: created.jobId,
        job: fetched.job,
        spec: fetched.spec,
      };
    });
  });

  $("btn-fund").addEventListener("click", () =>
    withAction("fundJob", async () => {
      const jobId = requiredJobId();
      const txResult = await signAndSend("/api/tx/fund", { jobId });
      const fetched = await fetchJobBundle(jobId);
      return { ...txResult, jobId, job: fetched.job, spec: fetched.spec };
    })
  );

  $("btn-approve").addEventListener("click", () =>
    withAction("approveJob", async () => {
      const jobId = requiredJobId();
      const txResult = await signAndSend("/api/tx/review", { jobId, approve: true });
      const fetched = await fetchJobBundle(jobId);
      return { ...txResult, jobId, job: fetched.job, spec: fetched.spec };
    })
  );

  $("btn-reject").addEventListener("click", () =>
    withAction("rejectJob", async () => {
      const jobId = requiredJobId();
      const txResult = await signAndSend("/api/tx/review", { jobId, approve: false });
      const fetched = await fetchJobBundle(jobId);
      return { ...txResult, jobId, job: fetched.job, spec: fetched.spec };
    })
  );

  $("btn-timeout-buyer").addEventListener("click", () =>
    withAction("timeoutBuyer", async () => {
      const buyer = await ensureBuyer();
      const jobId = requiredJobId();
      const txResult = await signAndSend("/api/tx/timeout", {
        jobId,
        actor: buyer,
      });
      const fetched = await fetchJobBundle(jobId);
      return { ...txResult, jobId, job: fetched.job, spec: fetched.spec };
    })
  );

  $("btn-fetch-job").addEventListener("click", () =>
    withAction("fetchJob", async () => {
      const jobId = requiredJobId();
      const fetched = await fetchJobBundle(jobId);
      return { ...fetched, jobId, job: fetched.job, spec: fetched.spec };
    })
  );

  $("recent-jobs").addEventListener("click", (e) => {
    const target = e.target.closest("button[data-job-id]");
    if (!target) {
      return;
    }
    $("action-job-id").value = target.dataset.jobId || "";
    withAction("fetchJob", async () => {
      const jobId = requiredJobId();
      const fetched = await fetchJobBundle(jobId);
      return { ...fetched, jobId, job: fetched.job, spec: fetched.spec };
    });
  });
});
