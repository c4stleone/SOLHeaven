const $ = (id) => document.getElementById(id);

const walletsView = $("wallets-view");
const configView = $("config-view");
const jobView = $("job-view");
const logView = $("log-view");
const mcpStatusView = $("mcp-status-view");
const mcpStatusChip = $("mcp-status-chip");

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
  busy: false,
  requests: [],
  services: [],
  mcpConnection: null,
  currentRequest: null,
  metrics: {
    total: 0,
    pending: 0,
    approved: 0,
    submittedOnChain: 0,
  },
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

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll("[data-busy-lock]").forEach((el) => {
    el.disabled = busy;
  });
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
  const [wallets, config] = await Promise.all([
    api("/api/wallets"),
    api("/api/config"),
  ]);
  renderJson(walletsView, wallets.roles);
  renderJson(configView, {
    configPda: config.configPda,
    config: config.config,
  });
}

function renderMetrics() {
  $("metric-total").textContent = String(state.metrics.total || 0);
  $("metric-pending").textContent = String(state.metrics.pending || 0);
  $("metric-approved").textContent = String(state.metrics.approved || 0);
  $("metric-submitted").textContent = String(
    state.metrics.submittedOnChain || 0
  );
}

function renderMcpConnection(data) {
  const connection = data && data.connection ? data.connection : data;
  if (!connection) {
    return;
  }
  state.mcpConnection = connection;

  const status = String(connection.lastStatus || "idle");
  let tone = "muted";
  if (status === "ok") {
    tone = "funded";
  } else if (status === "error") {
    tone = "disputed";
  }
  mcpStatusChip.className = `status-chip tone-${tone}`;
  mcpStatusChip.textContent =
    status === "ok"
      ? "Connected"
      : status === "error"
      ? "Connection Error"
      : "Not connected";

  const active = document.activeElement ? document.activeElement.id : "";
  const editing =
    active === "mcp-name" ||
    active === "mcp-server-url" ||
    active === "mcp-health-path" ||
    active === "mcp-auth-token";

  if (!editing) {
    $("mcp-name").value = connection.name || "";
    $("mcp-server-url").value = connection.serverUrl || "";
    $("mcp-health-path").value = connection.healthPath || "/health";
    $("mcp-price-lamports").value = connection.priceLamports || "1000000";
    if (!$("catalog-agent-price-lamports").value) {
      $("catalog-agent-price-lamports").value =
        connection.priceLamports || "1000000";
    }
  }

  const authInput = $("mcp-auth-token");
  authInput.placeholder = connection.hasAuthToken
    ? "저장된 토큰 있음 (변경 시에만 입력)"
    : "Bearer token or raw token";

  renderJson(mcpStatusView, {
    connection,
    test: data && data.test ? data.test : null,
    target: data && data.target ? data.target : null,
    durationMs: data && data.durationMs ? data.durationMs : null,
  });
}

function renderCatalog() {
  const wrap = $("catalog-list");
  wrap.innerHTML = "";

  if (!state.services.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "등록된 서비스가 없습니다.";
    wrap.appendChild(empty);
    return;
  }

  for (const svc of state.services) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-item";
    button.dataset.catalogId = svc.id;

    const top = document.createElement("div");
    top.className = "job-item-top";

    const id = document.createElement("strong");
    id.textContent = svc.title;

    const chip = document.createElement("span");
    chip.className = "status-chip tone-muted";
    chip.textContent = svc.outputFormat;

    top.append(id, chip);

    const summary = document.createElement("p");
    summary.className = "job-item-title";
    summary.textContent = svc.summary || "요약 없음";

    const foot = document.createElement("div");
    foot.className = "job-item-foot";
    foot.textContent = `${svc.id} | ${svc.category} | ${
      svc.agentPriceLamports || "-"
    } base units`;

    button.append(top, summary, foot);
    wrap.appendChild(button);
  }
}

function renderRequestList() {
  const wrap = $("request-list");
  wrap.innerHTML = "";

  if (!state.requests.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "표시할 요청이 없습니다.";
    wrap.appendChild(empty);
    return;
  }

  for (const req of state.requests) {
    const reqMeta = requestStatusMeta(req.requestStatus);
    const chainMeta = req.job
      ? onchainStatusMeta(req.job.status)
      : { label: "No job", tone: "muted" };

    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-item";
    button.dataset.requestKey = req.key;

    if (state.currentRequest && state.currentRequest.key === req.key) {
      button.classList.add("active");
    }

    const top = document.createElement("div");
    top.className = "job-item-top";

    const id = document.createElement("strong");
    id.textContent = `#${req.jobId} ${req.taskTitle || req.serviceTitle}`;

    const chip = document.createElement("span");
    chip.className = `status-chip tone-${reqMeta.tone}`;
    chip.textContent = reqMeta.label;

    top.append(id, chip);

    const title = document.createElement("p");
    title.className = "job-item-title";
    title.textContent = `${req.serviceTitle} | buyer ${shortKey(req.buyer)}`;

    const foot = document.createElement("div");
    foot.className = "job-item-foot";
    foot.textContent = `on-chain: ${chainMeta.label}`;

    button.append(top, title, foot);
    wrap.appendChild(button);
  }
}

function clearDetail() {
  state.currentRequest = null;
  $("detail-job-id").textContent = "-";
  $("detail-buyer").textContent = "-";
  $("detail-service").textContent = "-";
  $("detail-request-status").textContent = "-";
  $("detail-brief").textContent = "요청을 선택하세요.";
  $("detail-criteria").textContent = "요청을 선택하세요.";
  $("request-status-chip").className = "status-chip tone-muted";
  $("request-status-chip").textContent = "No request";
  renderJson(jobView, {});
}

function renderDetail(req) {
  if (!req) {
    clearDetail();
    return;
  }

  state.currentRequest = req;
  const reqMeta = requestStatusMeta(req.requestStatus);
  const chainMeta = req.job
    ? onchainStatusMeta(req.job.status)
    : { label: "No job", tone: "muted" };

  $("detail-job-id").textContent = String(req.jobId || "-");
  $("detail-buyer").textContent = req.buyer || "-";
  $("detail-service").textContent = req.serviceTitle || "-";
  $(
    "detail-request-status"
  ).textContent = `${reqMeta.label} / on-chain ${chainMeta.label}`;

  $("detail-brief").textContent = req.taskBrief || "요청 설명이 없습니다.";
  $("detail-criteria").textContent = JSON.stringify(
    req.criteria || {},
    null,
    2
  );

  const chip = $("request-status-chip");
  chip.className = `status-chip tone-${reqMeta.tone}`;
  chip.textContent = reqMeta.label;

  $("operator-buyer").value = req.buyer || "";
  $("operator-job-id").value = req.jobId || "";
  $("operator-submission").value =
    req.lastSubmissionPreview || "operator outcome payload";

  renderJson(jobView, req.job || { message: "on-chain job not found" });
}

async function loadCatalog() {
  const data = await api("/api/operator/catalog");
  state.services = Array.isArray(data.services) ? data.services : [];
  renderCatalog();
  return state.services;
}

function mcpPayloadFromForm() {
  const rawPrice = String($("mcp-price-lamports").value || "").trim();
  const fallbackPrice =
    state.mcpConnection && state.mcpConnection.priceLamports
      ? String(state.mcpConnection.priceLamports)
      : "1000000";
  const payload = {
    name: String($("mcp-name").value || "").trim(),
    serverUrl: String($("mcp-server-url").value || "").trim(),
    healthPath: String($("mcp-health-path").value || "").trim() || "/health",
    priceLamports: rawPrice
      ? normalizeDigits(rawPrice, "mcp price")
      : fallbackPrice,
  };
  const token = String($("mcp-auth-token").value || "").trim();
  return token ? { ...payload, authToken: token } : payload;
}

async function loadMcpConnection() {
  const data = await api("/api/operator/mcp");
  renderMcpConnection(data);
  return data.connection;
}

async function loadRequests() {
  const filter = String($("request-filter").value || "").trim();
  const query = filter ? `?status=${encodeURIComponent(filter)}` : "";
  const data = await api(`/api/operator/requests${query}`);
  state.requests = Array.isArray(data.requests) ? data.requests : [];
  state.metrics = data.metrics || {
    total: 0,
    pending: 0,
    approved: 0,
    submittedOnChain: 0,
  };
  renderMetrics();
  renderRequestList();

  if (state.currentRequest) {
    const found = state.requests.find(
      (r) => r.key === state.currentRequest.key
    );
    renderDetail(found || state.requests[0] || null);
  } else {
    renderDetail(state.requests[0] || null);
  }

  return state.requests;
}

async function withAction(name, fn) {
  if (state.busy) {
    return null;
  }
  setBusy(true);
  try {
    const result = await fn();
    appendLog(name, result);
    return result;
  } catch (e) {
    appendLog(`${name}:error`, String(e.message || e));
    return null;
  } finally {
    setBusy(false);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  clearDetail();

  await withAction("health", () => api("/api/health"));
  await withAction("refresh", async () => {
    await Promise.all([
      refreshPanels(),
      loadCatalog(),
      loadRequests(),
      loadMcpConnection(),
    ]);
    return { ok: true };
  });

  $("btn-refresh").addEventListener("click", () =>
    withAction("refresh", async () => {
      await Promise.all([
        refreshPanels(),
        loadCatalog(),
        loadRequests(),
        loadMcpConnection(),
      ]);
      return { ok: true };
    })
  );

  $("btn-mcp-save").addEventListener("click", () =>
    withAction("saveMcpConnection", async () => {
      const result = await api(
        "/api/operator/mcp",
        "POST",
        mcpPayloadFromForm()
      );
      renderMcpConnection(result);
      return result;
    })
  );

  $("btn-mcp-test").addEventListener("click", () =>
    withAction("testMcpConnection", async () => {
      const payload = mcpPayloadFromForm();
      const result = await api("/api/operator/mcp/test", "POST", {
        ...payload,
        persist: $("mcp-test-persist").checked,
      });
      renderMcpConnection(result);
      return result;
    })
  );

  $("form-mcp-connection").addEventListener("submit", (e) => {
    e.preventDefault();
  });

  $("request-filter").addEventListener("change", () => {
    withAction("filterRequests", async () => {
      const list = await loadRequests();
      return { count: list.length };
    });
  });

  $("request-list").addEventListener("click", (e) => {
    const target = e.target.closest("button[data-request-key]");
    if (!target) {
      return;
    }
    const key = target.dataset.requestKey;
    const found = state.requests.find((r) => r.key === key);
    renderDetail(found || null);
    renderRequestList();
  });

  $("btn-request-approve").addEventListener("click", () =>
    withAction("approveRequest", async () => {
      if (!state.currentRequest) {
        throw new Error("요청을 먼저 선택하세요.");
      }
      const data = await api("/api/operator/requests/decision", "POST", {
        buyer: state.currentRequest.buyer,
        jobId: state.currentRequest.jobId,
        decision: "approved",
        reason: $("decision-reason").value,
      });
      await loadRequests();
      return data;
    })
  );

  $("btn-request-reject").addEventListener("click", () =>
    withAction("rejectRequest", async () => {
      if (!state.currentRequest) {
        throw new Error("요청을 먼저 선택하세요.");
      }
      const data = await api("/api/operator/requests/decision", "POST", {
        buyer: state.currentRequest.buyer,
        jobId: state.currentRequest.jobId,
        decision: "rejected",
        reason: $("decision-reason").value,
      });
      await loadRequests();
      return data;
    })
  );

  $("form-submit").addEventListener("submit", (e) => {
    e.preventDefault();
    withAction("submitResult", async () => {
      const payload = {
        buyer: normalizePubkey($("operator-buyer").value, "buyer pubkey"),
        jobId: normalizeDigits($("operator-job-id").value, "job id"),
        submission:
          String($("operator-submission").value || "").trim() ||
          "operator outcome payload",
      };
      const result = await api("/api/jobs/submit", "POST", payload);
      await loadRequests();
      return result;
    });
  });

  $("form-catalog").addEventListener("submit", (e) => {
    e.preventDefault();
    withAction("saveCatalog", async () => {
      const rawAgentPrice = String(
        $("catalog-agent-price-lamports").value || ""
      ).trim();
      const fallbackAgentPrice =
        state.mcpConnection && state.mcpConnection.priceLamports
          ? String(state.mcpConnection.priceLamports)
          : "1000000";
      const payload = {
        id: $("catalog-id").value,
        title: String($("catalog-title").value || "").trim(),
        summary: $("catalog-summary").value,
        category: $("catalog-category").value,
        outputFormat: $("catalog-output-format").value,
        agentPriceLamports: rawAgentPrice
          ? normalizeDigits(rawAgentPrice, "catalog agent price")
          : fallbackAgentPrice,
      };
      const result = await api("/api/operator/catalog", "POST", payload);
      await loadCatalog();
      return result;
    });
  });

  $("catalog-list").addEventListener("click", (e) => {
    const target = e.target.closest("button[data-catalog-id]");
    if (!target) {
      return;
    }
    const id = target.dataset.catalogId;
    const found = state.services.find((svc) => svc.id === id);
    if (!found) {
      return;
    }
    $("catalog-id").value = found.id;
    $("catalog-title").value = found.title;
    $("catalog-summary").value = found.summary;
    $("catalog-category").value = found.category;
    $("catalog-output-format").value = found.outputFormat;
    $("catalog-agent-price-lamports").value =
      found.agentPriceLamports || "1000000";
  });
});
