const $ = (id) => document.getElementById(id);

const walletsView = $("wallets-view");
const configView = $("config-view");
const jobView = $("job-view");
const logView = $("log-view");
const phantomView = $("phantom-view");

const state = {
  provider: null,
  phantomPubkey: null,
  usePhantomBuyer: true,
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

function requiredJobId() {
  const v = $("action-job-id").value.trim().replaceAll(",", "");
  if (!v) {
    throw new Error("job id를 입력하세요.");
  }
  if (!/^\d+$/.test(v)) {
    throw new Error("job id는 숫자만 입력하세요.");
  }
  return v;
}

function getPhantomProvider() {
  if (
    window.phantom &&
    window.phantom.solana &&
    window.phantom.solana.isPhantom
  ) {
    return window.phantom.solana;
  }
  if (window.solana && window.solana.isPhantom) {
    return window.solana;
  }
  return null;
}

function base64ToUint8Array(base64) {
  const raw = String(base64 ?? "")
    .trim()
    .replaceAll("\n", "")
    .replaceAll("\r", "");
  const normalized = raw.replaceAll("-", "+").replaceAll("_", "/");
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

function uint8ArrayToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function renderPhantomState(extra) {
  const provider = getPhantomProvider();
  renderJson(phantomView, {
    available: Boolean(provider),
    connected: Boolean(state.phantomPubkey),
    wallet: state.phantomPubkey,
    usePhantomBuyer: state.usePhantomBuyer,
    rpc: "http://127.0.0.1:8899",
    ...extra,
  });
}

async function connectPhantom(options) {
  const provider = getPhantomProvider();
  if (!provider) {
    throw new Error("Phantom extension을 찾을 수 없습니다.");
  }

  const response = await provider.connect(options);
  state.provider = provider;
  state.phantomPubkey = (response.publicKey || provider.publicKey).toBase58();
  renderPhantomState();
  return state.phantomPubkey;
}

async function disconnectPhantom() {
  const provider = state.provider || getPhantomProvider();
  if (provider && provider.isConnected) {
    await provider.disconnect();
  }
  state.provider = provider;
  state.phantomPubkey = null;
  renderPhantomState();
}

async function ensurePhantomConnected() {
  if (!state.phantomPubkey) {
    await connectPhantom();
  }
  return state.phantomPubkey;
}

function activeBuyer() {
  if (!state.usePhantomBuyer) {
    return null;
  }
  return state.phantomPubkey;
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

function syncJobId(jobId) {
  if (!jobId) return;
  $("action-job-id").value = String(jobId);
  $("create-job-id").value = String(jobId);
}

async function signAndSendViaPhantom(buildPath, payload) {
  await ensurePhantomConnected();
  const provider = state.provider || getPhantomProvider();
  if (!provider) {
    throw new Error("Phantom provider not available");
  }

  const built = await api(buildPath, "POST", payload);
  if (!built.txBase64 || typeof built.txBase64 !== "string") {
    throw new Error("txBase64 missing from server response");
  }
  const tx = window.solanaWeb3.Transaction.from(
    base64ToUint8Array(built.txBase64)
  );
  const signed = await provider.signTransaction(tx);
  const signedTxBase64 = uint8ArrayToBase64(signed.serialize());
  const sent = await api("/api/tx/send", "POST", { signedTxBase64 });
  return {
    ...built,
    ...sent,
    signature: sent.signature,
  };
}

async function withAction(name, fn) {
  try {
    const result = await fn();
    appendLog(name, result);
    if (result.job) {
      renderJson(jobView, result.job);
    }
    if (result.jobId) {
      syncJobId(result.jobId);
    }
    if (result.events) {
      appendLog(`${name}:events`, result.events);
    } else if (result.signature) {
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

window.addEventListener("DOMContentLoaded", async () => {
  state.provider = getPhantomProvider();
  renderPhantomState();

  try {
    if (state.provider) {
      const response = await state.provider.connect({ onlyIfTrusted: true });
      if (response && response.publicKey) {
        state.phantomPubkey = response.publicKey.toBase58();
      }
    }
  } catch (_e) {
    // silent; user can connect explicitly
  }

  renderPhantomState();

  await withAction("health", async () => api("/api/health"));
  await withAction("refresh", async () => {
    await refreshPanels();
    return { ok: true };
  });

  $("mode-phantom").addEventListener("change", (e) => {
    state.usePhantomBuyer = Boolean(e.target.checked);
    renderPhantomState();
  });

  $("btn-phantom-connect").addEventListener("click", () =>
    withAction("phantomConnect", async () => {
      const pubkey = await connectPhantom();
      return { connected: true, pubkey };
    })
  );

  $("btn-phantom-disconnect").addEventListener("click", () =>
    withAction("phantomDisconnect", async () => {
      await disconnectPhantom();
      return { connected: false };
    })
  );

  $("btn-refresh").addEventListener("click", () =>
    withAction("refresh", async () => {
      await refreshPanels();
      return { ok: true };
    })
  );

  $("btn-bootstrap").addEventListener("click", () =>
    withAction("bootstrap", () => api("/api/bootstrap", "POST", { sol: 2 }))
  );

  $("form-airdrop").addEventListener("submit", (e) => {
    e.preventDefault();
    withAction("airdrop", () =>
      api("/api/airdrop", "POST", {
        role: $("airdrop-role").value,
        sol: Number($("airdrop-sol").value || 2),
      })
    );
  });

  $("form-create").addEventListener("submit", (e) => {
    e.preventDefault();
    const jobId = $("create-job-id").value.trim().replaceAll(",", "");
    if (jobId && !/^\d+$/.test(jobId)) {
      appendLog("createJob:validation", "job id는 숫자만 입력하세요.");
      return;
    }
    const payload = {
      jobId: jobId || undefined,
      rewardLamports: Number($("create-reward").value || 1000000),
      feeBps: Number($("create-fee-bps").value || 100),
      deadlineSeconds: Number($("create-deadline-seconds").value || 3600),
    };

    if (state.usePhantomBuyer) {
      withAction("createJob(phantom)", async () =>
        signAndSendViaPhantom("/api/tx/create", {
          ...payload,
          buyer: await ensurePhantomConnected(),
        })
      );
      return;
    }

    withAction("createJob(custodial)", () =>
      api("/api/jobs/create", "POST", payload)
    );
  });

  $("btn-fund").addEventListener("click", () => {
    const payload = { jobId: requiredJobId() };
    if (state.usePhantomBuyer) {
      withAction("fundJob(phantom)", async () =>
        signAndSendViaPhantom("/api/tx/fund", {
          ...payload,
          buyer: await ensurePhantomConnected(),
        })
      );
      return;
    }

    withAction("fundJob(custodial)", () =>
      api("/api/jobs/fund", "POST", payload)
    );
  });

  $("btn-submit").addEventListener("click", () =>
    withAction("submitResult", () => {
      const buyer = activeBuyer();
      return api("/api/jobs/submit", "POST", {
        jobId: requiredJobId(),
        submission: $("submit-payload").value,
        buyer: buyer || undefined,
      });
    })
  );

  $("btn-approve").addEventListener("click", () => {
    const payload = { jobId: requiredJobId(), approve: true };
    if (state.usePhantomBuyer) {
      withAction("reviewApprove(phantom)", async () =>
        signAndSendViaPhantom("/api/tx/review", {
          ...payload,
          buyer: await ensurePhantomConnected(),
        })
      );
      return;
    }
    withAction("reviewApprove(custodial)", () =>
      api("/api/jobs/review", "POST", payload)
    );
  });

  $("btn-reject").addEventListener("click", () => {
    const payload = { jobId: requiredJobId(), approve: false };
    if (state.usePhantomBuyer) {
      withAction("reviewReject(phantom)", async () =>
        signAndSendViaPhantom("/api/tx/review", {
          ...payload,
          buyer: await ensurePhantomConnected(),
        })
      );
      return;
    }
    withAction("reviewReject(custodial)", () =>
      api("/api/jobs/review", "POST", payload)
    );
  });

  $("btn-timeout-buyer").addEventListener("click", () => {
    if (state.usePhantomBuyer) {
      withAction("timeoutBuyer(phantom)", async () => {
        const buyer = await ensurePhantomConnected();
        return signAndSendViaPhantom("/api/tx/timeout", {
          jobId: requiredJobId(),
          actor: buyer,
          buyer,
        });
      });
      return;
    }
    withAction("timeoutBuyer(custodial)", () =>
      api("/api/jobs/timeout", "POST", {
        jobId: requiredJobId(),
        actorRole: "buyer",
      })
    );
  });

  $("btn-timeout-ops").addEventListener("click", () =>
    withAction("timeoutOps", () =>
      api("/api/jobs/timeout", "POST", {
        jobId: requiredJobId(),
        actorRole: "ops",
      })
    )
  );

  $("btn-resolve").addEventListener("click", () =>
    withAction("resolveDispute", () => {
      const buyer = activeBuyer();
      return api("/api/jobs/resolve", "POST", {
        jobId: requiredJobId(),
        payoutLamports: Number($("resolve-payout").value || 0),
        reason: $("resolve-reason").value || "manual_resolution",
        buyer: buyer || undefined,
      });
    })
  );

  $("btn-fetch-job").addEventListener("click", () =>
    withAction("fetchJob", () => {
      const buyer = activeBuyer();
      const jobId = requiredJobId();
      const query = buyer ? `?buyer=${encodeURIComponent(buyer)}` : "";
      return api(`/api/jobs/${jobId}${query}`);
    })
  );
});
