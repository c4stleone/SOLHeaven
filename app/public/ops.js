const $ = (id) => document.getElementById(id);

const walletsView = $("wallets-view");
const configView = $("config-view");
const jobView = $("job-view");
const logView = $("log-view");
const disputeListView = $("dispute-list");

const REQUEST_STATUS_META = {
  pending: { label: "Pending", tone: "draft" },
  approved: { label: "Approved", tone: "funded" },
  rejected: { label: "Rejected", tone: "disputed" },
};

const ONCHAIN_STATUS_META = {
  0: { label: "Created", tone: "draft" },
  1: { label: "Funded", tone: "funded" },
  2: { label: "Submitted", tone: "submitted" },
  3: { label: "Disputed", tone: "disputed" },
  4: { label: "Settled", tone: "settled" },
};

const state = {
  disputes: [],
  currentDispute: null,
};

function appendLog(title, payload) {
  const ts = new Date().toLocaleTimeString();
  const body =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  logView.textContent = `[${ts}] ${title}\n${body}\n\n${logView.textContent}`;
}

function renderJson(el, value) {
  el.textContent = JSON.stringify(value, null, 2);
}

function normalizeDigits(value, field) {
  const v = String(value ?? "")
    .trim()
    .replace(/,/g, "");
  if (!/^\d+$/.test(v)) {
    throw new Error(`${field}는 숫자만 입력하세요.`);
  }
  return v;
}

function normalizePubkey(value, field) {
  const v = String(value ?? "").trim();
  if (!v) {
    throw new Error(`${field}를 입력하세요.`);
  }
  return v;
}

function shortKey(key) {
  const text = String(key || "");
  if (!text) {
    return "-";
  }
  if (text.length < 12) {
    return text;
  }
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function requestStatusMeta(status) {
  return (
    REQUEST_STATUS_META[String(status)] || {
      label: String(status),
      tone: "muted",
    }
  );
}

function onchainStatusMeta(status) {
  return (
    ONCHAIN_STATUS_META[Number(status)] || {
      label: `Unknown(${String(status)})`,
      tone: "muted",
    }
  );
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

function fillBuyerDefaults(buyer) {
  if (!$("resolve-buyer").value) $("resolve-buyer").value = buyer;
  if (!$("timeout-buyer").value) $("timeout-buyer").value = buyer;
}

async function refreshPanels() {
  const [wallets, config] = await Promise.all([
    api("/api/wallets"),
    api("/api/config"),
  ]);
  renderJson(walletsView, wallets.roles);
  renderJson(configView, {
    configPda: config.configPda,
    config: config.config,
  });
  fillBuyerDefaults(wallets.roles.buyer);
}

function syncJobId(jobId) {
  if (!jobId) return;
  $("resolve-job-id").value = String(jobId);
  $("timeout-job-id").value = String(jobId);
}

function clearDisputeDetail() {
  state.currentDispute = null;
  $("dispute-detail-job-id").textContent = "-";
  $("dispute-detail-buyer").textContent = "-";
  $("dispute-detail-service").textContent = "-";
  $("dispute-detail-status").textContent = "-";
  $("dispute-detail-brief").textContent = "분쟁 항목을 선택하세요.";
  $("dispute-detail-criteria").textContent = "분쟁 항목을 선택하세요.";
  const chip = $("dispute-status-chip");
  chip.className = "status-chip tone-muted";
  chip.textContent = "No dispute";
}

function renderDisputeList() {
  disputeListView.innerHTML = "";
  if (!state.disputes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "표시할 분쟁이 없습니다.";
    disputeListView.appendChild(empty);
    return;
  }

  for (const req of state.disputes) {
    const chainMeta = req.job
      ? onchainStatusMeta(req.job.status)
      : { label: "No job", tone: "muted" };
    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-item";
    button.dataset.disputeKey = req.key;

    if (state.currentDispute && state.currentDispute.key === req.key) {
      button.classList.add("active");
    }

    const top = document.createElement("div");
    top.className = "job-item-top";
    const title = document.createElement("strong");
    title.textContent = `#${req.jobId} ${
      req.taskTitle || req.serviceTitle || ""
    }`.trim();
    const chip = document.createElement("span");
    chip.className = `status-chip tone-${chainMeta.tone}`;
    chip.textContent = chainMeta.label;
    top.append(title, chip);

    const body = document.createElement("p");
    body.className = "job-item-title";
    body.textContent = `${
      req.serviceTitle || "unknown service"
    } | buyer ${shortKey(req.buyer)}`;

    const foot = document.createElement("div");
    foot.className = "job-item-foot";
    foot.textContent = `request ${
      requestStatusMeta(req.requestStatus).label
    } | reward ${req.job?.reward || "-"} base units`;

    button.append(top, body, foot);
    disputeListView.appendChild(button);
  }
}

function renderDisputeDetail(req) {
  if (!req) {
    clearDisputeDetail();
    return;
  }
  state.currentDispute = req;
  const reqMeta = requestStatusMeta(req.requestStatus);
  const chainMeta = req.job
    ? onchainStatusMeta(req.job.status)
    : { label: "No job", tone: "muted" };

  $("dispute-detail-job-id").textContent = String(req.jobId || "-");
  $("dispute-detail-buyer").textContent = req.buyer || "-";
  $("dispute-detail-service").textContent = req.serviceTitle || "-";
  $(
    "dispute-detail-status"
  ).textContent = `${reqMeta.label} / on-chain ${chainMeta.label}`;
  $("dispute-detail-brief").textContent =
    req.taskBrief || "요청 설명이 없습니다.";
  $("dispute-detail-criteria").textContent = JSON.stringify(
    req.criteria || {},
    null,
    2
  );

  const chip = $("dispute-status-chip");
  chip.className = `status-chip tone-${chainMeta.tone}`;
  chip.textContent = chainMeta.label;

  $("resolve-buyer").value = req.buyer || $("resolve-buyer").value;
  $("timeout-buyer").value = req.buyer || $("timeout-buyer").value;
  $("resolve-job-id").value = req.jobId || $("resolve-job-id").value;
  $("timeout-job-id").value = req.jobId || $("timeout-job-id").value;
  if (req.job && req.job.reward) {
    $("resolve-payout").value = String(req.job.reward);
  }
  renderJson(jobView, req.job || { message: "on-chain job not found" });
}

async function loadDisputes() {
  const mode = String($("dispute-filter").value || "open");
  const data = await api("/api/operator/requests");
  const all = Array.isArray(data.requests) ? data.requests : [];
  const disputes =
    mode === "all"
      ? all
      : all.filter((r) => r.job && Number(r.job.status) === 3);
  state.disputes = disputes;
  renderDisputeList();

  if (state.currentDispute) {
    const found = disputes.find((d) => d.key === state.currentDispute.key);
    renderDisputeDetail(found || disputes[0] || null);
  } else {
    renderDisputeDetail(disputes[0] || null);
  }
  return disputes;
}

async function withAction(name, fn) {
  try {
    const result = await fn();
    appendLog(name, result);
    if (result.job) renderJson(jobView, result.job);
    if (result.jobId) syncJobId(result.jobId);
    if (result.signature) {
      try {
        const events = await api(`/api/events/${result.signature}`);
        appendLog(`${name}:events`, events.events);
      } catch (e) {
        appendLog(`${name}:events`, String(e.message || e));
      }
    }
  } catch (e) {
    appendLog(`${name}:error`, String(e.message || e));
  }
}

function timeoutInput() {
  return {
    buyer: normalizePubkey($("timeout-buyer").value, "buyer pubkey"),
    jobId: normalizeDigits($("timeout-job-id").value, "job id"),
  };
}

async function resolveSelectedDispute(approve) {
  if (!state.currentDispute) {
    throw new Error("분쟁 항목을 먼저 선택하세요.");
  }
  const req = state.currentDispute;
  if (!req.job || Number(req.job.status) !== 3) {
    throw new Error("선택한 작업이 on-chain Disputed 상태가 아닙니다.");
  }
  const payoutLamports = approve
    ? normalizeDigits(req.job.reward, "job reward")
    : "0";
  const reasonRaw = String($("dispute-reason").value || "").trim();
  const reason =
    reasonRaw || (approve ? "ops_dispute_approved" : "ops_dispute_rejected");
  const result = await api("/api/jobs/resolve", "POST", {
    buyer: normalizePubkey(req.buyer, "buyer pubkey"),
    jobId: normalizeDigits(req.jobId, "job id"),
    payoutLamports,
    reason,
  });
  await loadDisputes();
  return result;
}

window.addEventListener("DOMContentLoaded", async () => {
  clearDisputeDetail();

  await withAction("health", () => api("/api/health"));
  await withAction("refresh", async () => {
    await Promise.all([refreshPanels(), loadDisputes()]);
    return { ok: true, disputeCount: state.disputes.length };
  });

  $("btn-refresh").addEventListener("click", () =>
    withAction("refresh", async () => {
      await Promise.all([refreshPanels(), loadDisputes()]);
      return { ok: true, disputeCount: state.disputes.length };
    })
  );

  $("btn-bootstrap").addEventListener("click", () =>
    withAction("bootstrap", () => api("/api/bootstrap", "POST", { sol: 2 }))
  );

  $("form-resolve").addEventListener("submit", (e) => {
    e.preventDefault();
    withAction("resolveDispute", () =>
      api("/api/jobs/resolve", "POST", {
        buyer: normalizePubkey($("resolve-buyer").value, "buyer pubkey"),
        jobId: normalizeDigits($("resolve-job-id").value, "job id"),
        payoutLamports: normalizeDigits($("resolve-payout").value, "payout"),
        reason: $("resolve-reason").value || "manual_resolution",
      })
    );
  });

  $("btn-timeout-ops").addEventListener("click", () =>
    withAction("timeoutOps", () => {
      const input = timeoutInput();
      return api("/api/jobs/timeout", "POST", {
        actorRole: "ops",
        buyer: input.buyer,
        jobId: input.jobId,
      });
    })
  );

  $("btn-fetch-job").addEventListener("click", () =>
    withAction("fetchJob", () => {
      const input = timeoutInput();
      return api(
        `/api/jobs/${input.jobId}?buyer=${encodeURIComponent(input.buyer)}`
      );
    })
  );

  $("dispute-filter").addEventListener("change", () =>
    withAction("filterDisputes", async () => {
      const list = await loadDisputes();
      return { count: list.length };
    })
  );

  $("dispute-list").addEventListener("click", (e) => {
    const target = e.target.closest("button[data-dispute-key]");
    if (!target) {
      return;
    }
    const key = target.dataset.disputeKey;
    const found = state.disputes.find((d) => d.key === key);
    renderDisputeDetail(found || null);
    renderDisputeList();
  });

  $("btn-dispute-approve").addEventListener("click", () =>
    withAction("disputeApprove", () => resolveSelectedDispute(true))
  );

  $("btn-dispute-reject").addEventListener("click", () =>
    withAction("disputeReject", () => resolveSelectedDispute(false))
  );
});
