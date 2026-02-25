import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Shield,
  RefreshCw,
  Zap,
  Users,
  Settings2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Timer,
} from "lucide-react";
import PageLayout from "@/components/layout/PageLayout";
import GlassCard from "@/components/shared/GlassCard";
import { JobStatusBadge } from "@/components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";
import {
  bootstrapSystem,
  getConfig,
  getHealth,
  getOperatorRequests,
  getWallets,
  resolveJob,
  timeoutJob,
} from "@/lib/api";
import type { JobSpec, JobStatus } from "@/lib/types";

const formatTimestamp = () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

const lamportsToStableText = (lamports: string, decimals: number) => {
  try {
    const value = BigInt(String(lamports || "0"));
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const frac = (value % base).toString().padStart(decimals, "0").slice(0, 4);
    return `${whole}.${frac}`;
  } catch (_e) {
    return "0.0000";
  }
};

const stableTextToLamports = (value: string, decimals: number): bigint => {
  const text = String(value ?? "").trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error("환불 금액 형식이 올바르지 않습니다.");
  }
  const [wholeRaw, fracRaw = ""] = text.split(".");
  const whole = wholeRaw || "0";
  const frac = fracRaw.padEnd(decimals, "0").slice(0, decimals);
  const units = `${whole}${frac}`.replace(/^0+(\d)/, "$1");
  return BigInt(units || "0");
};

const OpsPage = () => {
  const queryClient = useQueryClient();
  const [disputeFilter, setDisputeFilter] = useState<"open" | "all">("open");
  const [activityLogs, setActivityLogs] = useState<string[]>([
    "[--:--:--] System ready. Waiting for actions...",
  ]);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectRefundAmount, setRejectRefundAmount] = useState("0");
  const [rejectTarget, setRejectTarget] = useState<JobSpec | null>(null);

  const walletsQuery = useQuery({
    queryKey: ["wallets"],
    queryFn: getWallets,
  });
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
  });
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
  });
  const requestsQuery = useQuery({
    queryKey: ["operator-requests"],
    queryFn: () => getOperatorRequests(),
  });

  const addLog = (message: string) => {
    setActivityLogs((prev) => [`[${formatTimestamp()}] ${message}`, ...prev].slice(0, 100));
  };

  const requests = useMemo(() => {
    const items = requestsQuery.data?.requests ?? [];
    return items.map((request) => {
      const status = Math.min(4, Math.max(0, Number(request.job?.status ?? 0))) as JobStatus;
      return {
        ...request,
        onChainStatus: status,
      } as JobSpec;
    });
  }, [requestsQuery.data?.requests]);

  const disputes = useMemo(() => {
    if (disputeFilter === "all") {
      return requests;
    }
    return requests.filter((request) => Number(request.onChainStatus) === 3);
  }, [disputeFilter, requests]);

  const refreshAll = async () => {
    await Promise.all([
      walletsQuery.refetch(),
      configQuery.refetch(),
      healthQuery.refetch(),
      requestsQuery.refetch(),
    ]);
    addLog("State refreshed");
  };

  const bootstrapMutation = useMutation({
    mutationFn: () => bootstrapSystem(),
    onSuccess: async () => {
      await refreshAll();
      toast({ title: "Bootstrap 완료" });
      addLog("Bootstrap config executed");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Bootstrap 실패",
        description: String(error?.message ?? "unknown error"),
      });
      addLog(`Bootstrap failed: ${String(error?.message ?? "unknown error")}`);
    },
  });

  const resolveMutation = useMutation({
    mutationFn: (payload: {
      jobId: string;
      buyer: string;
      payoutLamports: string;
      reason: string;
    }) => resolveJob(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["operator-requests"] });
      toast({ title: "분쟁 해결 처리 완료" });
      addLog("Dispute resolved");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "분쟁 해결 실패",
        description: String(error?.message ?? "unknown error"),
      });
      addLog(`Resolve failed: ${String(error?.message ?? "unknown error")}`);
    },
  });

  const timeoutMutation = useMutation({
    mutationFn: (payload: { jobId: string; buyer: string }) =>
      timeoutJob({
        jobId: payload.jobId,
        buyer: payload.buyer,
        actorRole: "ops",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["operator-requests"] });
      toast({ title: "Timeout 실행 완료" });
      addLog("Timeout triggered by ops");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Timeout 실행 실패",
        description: String(error?.message ?? "unknown error"),
      });
      addLog(`Timeout failed: ${String(error?.message ?? "unknown error")}`);
    },
  });

  const roleWallets = walletsQuery.data?.roles ?? {
    admin: "-",
    ops: "-",
    buyer: "-",
    operator: "-",
    treasury: "-",
  };

  const configPayload = {
    program: healthQuery.data?.programId || "-",
    network: healthQuery.data?.rpcUrl || "-",
    stableMint: configQuery.data?.stableMint || "-",
    stableSymbol: configQuery.data?.stableSymbol || "USDC",
    stableDecimals: configQuery.data?.stableDecimals ?? 6,
    configPda: configQuery.data?.configPda || "-",
    opsWallet: configQuery.data?.config?.ops || "-",
    treasuryWallet: configQuery.data?.config?.treasury || "-",
  };
  const stableSymbol = configPayload.stableSymbol || "USDC";
  const stableDecimals = configPayload.stableDecimals ?? 6;

  const openRejectDialog = (job: JobSpec) => {
    const rewardLamports = String(job.job?.reward ?? "0");
    const defaultRefund = lamportsToStableText(rewardLamports, stableDecimals);
    setRejectTarget(job);
    setRejectRefundAmount(defaultRefund);
    setRejectDialogOpen(true);
  };

  const submitRejectWithRefund = () => {
    if (!rejectTarget?.job) {
      toast({
        variant: "destructive",
        title: "분쟁 데이터 없음",
        description: "정산할 분쟁 데이터를 찾을 수 없습니다.",
      });
      return;
    }
    try {
      const rewardLamports = BigInt(String(rejectTarget.job.reward ?? "0"));
      const refundLamports = stableTextToLamports(rejectRefundAmount, stableDecimals);
      if (refundLamports < 0) {
        throw new Error("환불 금액은 0 이상이어야 합니다.");
      }
      if (refundLamports > rewardLamports) {
        throw new Error("환불 금액이 총 보상 금액을 초과할 수 없습니다.");
      }
      const payoutLamports = rewardLamports - refundLamports;
      resolveMutation.mutate({
        jobId: rejectTarget.jobId,
        buyer: rejectTarget.buyer,
        payoutLamports: payoutLamports.toString(),
        reason: `ops_reject_refund_${refundLamports.toString()}`,
      });
      setRejectDialogOpen(false);
      setRejectTarget(null);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "환불 금액 오류",
        description: String(error?.message ?? "invalid refund amount"),
      });
    }
  };

  const loading =
    walletsQuery.isLoading ||
    configQuery.isLoading ||
    healthQuery.isLoading ||
    requestsQuery.isLoading;

  return (
    <PageLayout>
      <div className="container space-y-8">
        <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <p className="text-sm font-mono text-warning tracking-widest uppercase mb-2">Ops Console</p>
          <h1 className="text-3xl md:text-4xl font-bold mb-3">Ops Actions</h1>
          <p className="text-muted-foreground max-w-xl mb-6">
            분쟁 해소(Resolve), Ops 타임아웃, 시스템 부트스트랩을 수행합니다.
          </p>
          <div className="flex gap-3">
            <Button
              className="bg-warning text-warning-foreground hover:bg-warning/90"
              onClick={() => bootstrapMutation.mutate()}
              disabled={bootstrapMutation.isPending}
            >
              <Zap className="w-4 h-4 mr-1" /> Bootstrap Config
            </Button>
            <Button
              variant="outline"
              className="border-warning/20 text-warning"
              onClick={refreshAll}
              disabled={loading}
            >
              <RefreshCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh State
            </Button>
          </div>
        </motion.section>

        <div className="grid md:grid-cols-2 gap-6">
          <GlassCard className="border-warning/10">
            <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Users className="w-5 h-5 text-warning" /> Role Wallets
            </h2>
            <div className="space-y-3">
              {Object.entries(roleWallets).map(([role, address]) => (
                <div key={role} className="flex items-center justify-between text-sm gap-4">
                  <span className="text-muted-foreground capitalize">{role}</span>
                  <span className="font-mono text-foreground text-right break-all">{address}</span>
                </div>
              ))}
            </div>
          </GlassCard>

          <GlassCard className="border-warning/10">
            <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-warning" /> Config
            </h2>
            <div className="font-mono text-xs bg-background/50 rounded-lg p-4 text-muted-foreground leading-relaxed overflow-x-auto">
              <pre>{JSON.stringify(configPayload, null, 2)}</pre>
            </div>
          </GlassCard>
        </div>

        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-warning" /> Dispute List
            </h2>
            <div className="flex gap-1">
              {(["open", "all"] as const).map((filter) => (
                <button
                  key={filter}
                  onClick={() => setDisputeFilter(filter)}
                  className={`px-3 py-1.5 text-xs font-mono rounded-lg transition-colors ${
                    disputeFilter === filter
                      ? "bg-warning/10 text-warning border border-warning/20"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {filter === "open" ? "open only" : "all requests"}
                </button>
              ))}
            </div>
          </div>

          {disputes.length === 0 ? (
            <GlassCard className="text-center py-12">
              <Shield className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground">분쟁 중인 요청이 없습니다</p>
            </GlassCard>
          ) : (
            <div className="space-y-3">
              {disputes.map((job, index) => (
                <motion.div
                  key={job.key}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                >
                  <GlassCard hover className="cursor-pointer">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-mono text-muted-foreground">#{job.jobId}</span>
                          <JobStatusBadge status={(job.onChainStatus ?? 0) as JobStatus} />
                        </div>
                        <h3 className="font-semibold">{job.taskTitle}</h3>
                        <p className="text-sm text-muted-foreground">{job.taskBrief}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {Number(job.onChainStatus) === 3 ? (
                          <>
                            <Button
                              size="sm"
                              className="bg-success text-success-foreground hover:bg-success/90"
                              onClick={() =>
                                resolveMutation.mutate({
                                  jobId: job.jobId,
                                  buyer: job.buyer,
                                  payoutLamports: String(job.job?.reward ?? "0"),
                                  reason: "ops_approve",
                                })
                              }
                              disabled={resolveMutation.isPending || !job.job}
                            >
                              <CheckCircle2 className="w-4 h-4 mr-1" /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-destructive/30 text-destructive"
                              onClick={() => openRejectDialog(job)}
                              disabled={resolveMutation.isPending || !job.job}
                            >
                              <XCircle className="w-4 h-4 mr-1" /> Reject
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-warning/30 text-warning"
                              onClick={() => timeoutMutation.mutate({ jobId: job.jobId, buyer: job.buyer })}
                              disabled={timeoutMutation.isPending || !job.job}
                            >
                              <Timer className="w-4 h-4 mr-1" /> Timeout
                            </Button>
                          </>
                        ) : (
                          <span className="text-xs font-mono text-muted-foreground">
                            분쟁 상태 아님
                          </span>
                        )}
                      </div>
                    </div>
                  </GlassCard>
                </motion.div>
              ))}
            </div>
          )}
        </section>

        <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Reject 환불 금액 입력</DialogTitle>
              <DialogDescription>
                Reject 처리 시 구매자에게 반환할 금액을 입력하세요.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <div className="text-xs font-mono text-muted-foreground">
                총 보상:{" "}
                {lamportsToStableText(String(rejectTarget?.job?.reward ?? "0"), stableDecimals)}{" "}
                {stableSymbol}
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-refund-amount">반환 금액 ({stableSymbol})</Label>
                <Input
                  id="reject-refund-amount"
                  type="text"
                  placeholder={`예: 1.50`}
                  value={rejectRefundAmount}
                  onChange={(event) => setRejectRefundAmount(event.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setRejectDialogOpen(false)}
                disabled={resolveMutation.isPending}
              >
                취소
              </Button>
              <Button
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={submitRejectWithRefund}
                disabled={resolveMutation.isPending}
              >
                Reject 실행
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <GlassCard className="border-warning/10">
          <h2 className="text-lg font-bold mb-4">Activity Log</h2>
          <div className="font-mono text-xs bg-background/50 rounded-lg p-4 h-40 overflow-y-auto text-muted-foreground space-y-1">
            {activityLogs.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </GlassCard>
      </div>
    </PageLayout>
  );
};

export default OpsPage;
