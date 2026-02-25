import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  RefreshCw,
  Wifi,
  WifiOff,
  FileText,
  Clock,
  CheckCircle2,
  Send,
  ListFilter,
  Server,
  Activity,
  AlertCircle,
  Plus,
} from "lucide-react";
import PageLayout from "@/components/layout/PageLayout";
import GlassCard from "@/components/shared/GlassCard";
import KpiCard from "@/components/shared/KpiCard";
import { RequestStatusBadge, JobStatusBadge } from "@/components/shared/StatusBadge";
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
  decideRequest,
  getMcpConnection,
  getOperatorCatalog,
  getOperatorRequests,
  submitJobResult,
  testMcpConnection,
  updateMcpConnection,
} from "@/lib/api";
import type { JobSpec, JobStatus } from "@/lib/types";

const DEFAULT_STABLE_DECIMALS = 6;

const formatStable = (units: string, decimals = DEFAULT_STABLE_DECIMALS) => {
  const divisor = 10 ** Math.max(0, decimals);
  return (Number(units || "0") / divisor).toFixed(2);
};

type McpFormState = {
  name: string;
  serverUrl: string;
  healthPath: string;
  priceLamports: string;
  authToken: string;
};

const emptyMcpForm: McpFormState = {
  name: "",
  serverUrl: "",
  healthPath: "/health",
  priceLamports: "1000000",
  authToken: "",
};

const OperatorPage = () => {
  const queryClient = useQueryClient();
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [mcpForm, setMcpForm] = useState<McpFormState>(emptyMcpForm);

  const mcpQuery = useQuery({
    queryKey: ["operator-mcp"],
    queryFn: getMcpConnection,
  });
  const requestsQuery = useQuery({
    queryKey: ["operator-requests"],
    queryFn: () => getOperatorRequests(),
  });
  const catalogQuery = useQuery({
    queryKey: ["operator-catalog"],
    queryFn: getOperatorCatalog,
  });

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

  const metrics = requestsQuery.data?.metrics ?? {
    total: requests.length,
    pending: requests.filter((job) => job.requestStatus === "pending").length,
    approved: requests.filter((job) => job.requestStatus === "approved").length,
    rejected: requests.filter((job) => job.requestStatus === "rejected").length,
    submittedOnChain: requests.filter((job) => Number(job.onChainStatus) === 2).length,
    settledOnChain: requests.filter((job) => Number(job.onChainStatus) === 4).length,
  };

  const decideMutation = useMutation({
    mutationFn: async (payload: {
      buyer: string;
      jobId: string;
      decision: "approved" | "rejected";
      reason?: string;
    }) => decideRequest(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["operator-requests"] });
      toast({ title: "요청 상태가 업데이트되었습니다." });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "요청 처리 실패",
        description: String(error?.message ?? "unknown error"),
      });
    },
  });

  const submitMutation = useMutation({
    mutationFn: async (payload: { jobId: string; buyer: string; taskTitle: string }) => {
      const submission = `${payload.taskTitle} 결과 제출 @ ${new Date().toISOString()}`;
      return submitJobResult({
        jobId: payload.jobId,
        buyer: payload.buyer,
        submission,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["operator-requests"] });
      toast({ title: "결과 제출 완료" });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "결과 제출 실패",
        description: String(error?.message ?? "unknown error"),
      });
    },
  });

  const registerMcpMutation = useMutation({
    mutationFn: async (payload: McpFormState) => {
      const normalized = {
        name: payload.name.trim(),
        serverUrl: payload.serverUrl.trim(),
        healthPath: payload.healthPath.trim() || "/health",
        priceLamports: payload.priceLamports.trim(),
        authToken: payload.authToken.trim(),
      };

      const tested = await testMcpConnection({
        ...normalized,
        persist: false,
      });

      if (!tested.test.ok) {
        const statusInfo = tested.test.status ? ` (HTTP ${tested.test.status})` : "";
        throw new Error(`${tested.test.message}${statusInfo}`);
      }

      await updateMcpConnection(normalized);

      return testMcpConnection({
        persist: true,
      });
    },
    onSuccess: async () => {
      setMcpDialogOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["operator-mcp"] }),
        queryClient.invalidateQueries({ queryKey: ["operator-catalog"] }),
      ]);
      toast({ title: "MCP 연결 확인 및 등록 완료" });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "MCP 등록 실패",
        description: String(error?.message ?? "unknown error"),
      });
    },
  });

  const refreshAll = async () => {
    await Promise.all([mcpQuery.refetch(), requestsQuery.refetch(), catalogQuery.refetch()]);
  };

  const mcpStatus = mcpQuery.data?.connection;
  const loading = mcpQuery.isLoading || requestsQuery.isLoading || catalogQuery.isLoading;

  const openMcpDialog = () => {
    setMcpForm({
      name: mcpStatus?.name || "",
      serverUrl: mcpStatus?.serverUrl || "",
      healthPath: mcpStatus?.healthPath || "/health",
      priceLamports: mcpStatus?.priceLamports || "1000000",
      authToken: "",
    });
    setMcpDialogOpen(true);
  };

  const submitMcpRegistration = () => {
    if (!mcpForm.name.trim() || !mcpForm.serverUrl.trim()) {
      toast({
        variant: "destructive",
        title: "입력값 확인",
        description: "MCP 이름과 서버 URL은 필수입니다.",
      });
      return;
    }
    registerMcpMutation.mutate(mcpForm);
  };

  return (
    <PageLayout>
      <div className="container space-y-8">
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col lg:flex-row gap-6 items-start"
        >
          <div className="flex-1">
            <p className="text-sm font-mono text-accent tracking-widest uppercase mb-2">
              Operator Workspace
            </p>
            <h1 className="text-3xl md:text-4xl font-bold mb-3">MCP 판매자 작업 센터</h1>
            <p className="text-muted-foreground max-w-xl">
              어떤 요청이 들어왔는지 확인하고, 성공 기준 검토 후 승인/거절 및 결과 제출까지 연결합니다.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="border-accent/20 text-accent"
              onClick={openMcpDialog}
            >
              <Plus className="w-4 h-4 mr-1" /> MCP 등록
            </Button>
            <Button
              variant="outline"
              className="border-accent/20 text-accent"
              onClick={refreshAll}
              disabled={loading}
            >
              <RefreshCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
        </motion.section>

        <Dialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>MCP 환경 등록</DialogTitle>
              <DialogDescription>
                입력값으로 먼저 연결 체크를 수행한 뒤, 성공하면 MCP 설정을 등록합니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="mcp-name">MCP 이름</Label>
                <Input
                  id="mcp-name"
                  value={mcpForm.name}
                  onChange={(event) => setMcpForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="default-mcp-server"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-url">서버 URL</Label>
                <Input
                  id="mcp-url"
                  value={mcpForm.serverUrl}
                  onChange={(event) =>
                    setMcpForm((prev) => ({ ...prev, serverUrl: event.target.value }))
                  }
                  placeholder="https://mcp.example.com"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="mcp-health">헬스체크 경로</Label>
                  <Input
                    id="mcp-health"
                    value={mcpForm.healthPath}
                    onChange={(event) =>
                      setMcpForm((prev) => ({ ...prev, healthPath: event.target.value }))
                    }
                    placeholder="/health"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcp-price">기본 가격(lamports)</Label>
                  <Input
                    id="mcp-price"
                    value={mcpForm.priceLamports}
                    onChange={(event) =>
                      setMcpForm((prev) => ({ ...prev, priceLamports: event.target.value }))
                    }
                    placeholder="1000000"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-token">Auth Token (선택)</Label>
                <Input
                  id="mcp-token"
                  type="password"
                  value={mcpForm.authToken}
                  onChange={(event) =>
                    setMcpForm((prev) => ({ ...prev, authToken: event.target.value }))
                  }
                  placeholder="Bearer ..."
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setMcpDialogOpen(false)}
                disabled={registerMcpMutation.isPending}
              >
                취소
              </Button>
              <Button onClick={submitMcpRegistration} disabled={registerMcpMutation.isPending}>
                <RefreshCw
                  className={`w-4 h-4 mr-1 ${registerMcpMutation.isPending ? "animate-spin" : ""}`}
                />
                확인 후 등록
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard label="요청 총합" value={metrics.total} icon={FileText} accent="accent" />
          <KpiCard label="검토 대기" value={metrics.pending} icon={Clock} accent="warning" />
          <KpiCard label="수락됨" value={metrics.approved} icon={CheckCircle2} accent="success" />
          <KpiCard
            label="결과 제출 완료"
            value={metrics.submittedOnChain}
            icon={Send}
            accent="primary"
          />
        </div>

        <GlassCard className="border-accent/20">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Server className="w-5 h-5 text-accent" /> MCP Connection
            </h2>
            <div className="flex items-center gap-2">
              {mcpStatus?.lastStatus === "ok" ? (
                <span className="flex items-center gap-1.5 text-xs font-mono text-success">
                  <Wifi className="w-4 h-4" />
                  <span className="w-2 h-2 rounded-full bg-success animate-pulse-glow" />
                  Connected
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs font-mono text-destructive">
                  <WifiOff className="w-4 h-4" /> Disconnected
                </span>
              )}
            </div>
          </div>
          <div className="grid md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs mb-1">Server</p>
              <p className="font-mono">{mcpStatus?.name || "-"}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">URL</p>
              <p className="font-mono text-primary truncate">{mcpStatus?.serverUrl || "-"}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">Default Price</p>
              <p className="font-mono">
                {formatStable(mcpStatus?.priceLamports || "0")} {mcpStatus?.priceSymbol || "USDC"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">Health</p>
              <p className="font-mono truncate">{mcpStatus?.lastMessage || "-"}</p>
            </div>
          </div>
        </GlassCard>

        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <ListFilter className="w-5 h-5" /> 요청 목록
            </h2>
          </div>

          <div className="space-y-3">
            {requests.map((job, index) => (
              <motion.div
                key={job.key}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
              >
                <GlassCard hover className="cursor-pointer">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-muted-foreground">#{job.jobId}</span>
                        <RequestStatusBadge status={job.requestStatus} />
                        <JobStatusBadge status={(job.onChainStatus ?? 0) as JobStatus} />
                      </div>
                      <h3 className="font-semibold">{job.taskTitle}</h3>
                      <p className="text-sm text-muted-foreground">{job.taskBrief}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {job.requestStatus === "pending" && (
                        <>
                          <Button
                            size="sm"
                            className="bg-success text-success-foreground hover:bg-success/90"
                            onClick={() =>
                              decideMutation.mutate({
                                buyer: job.buyer,
                                jobId: job.jobId,
                                decision: "approved",
                              })
                            }
                            disabled={decideMutation.isPending}
                          >
                            <CheckCircle2 className="w-4 h-4 mr-1" /> 수락
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-destructive/30 text-destructive"
                            onClick={() =>
                              decideMutation.mutate({
                                buyer: job.buyer,
                                jobId: job.jobId,
                                decision: "rejected",
                              })
                            }
                            disabled={decideMutation.isPending}
                          >
                            <AlertCircle className="w-4 h-4 mr-1" /> 거절
                          </Button>
                        </>
                      )}
                      {job.requestStatus === "approved" && job.onChainStatus !== 2 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-primary/30 text-primary"
                          onClick={() =>
                            submitMutation.mutate({
                              jobId: job.jobId,
                              buyer: job.buyer,
                              taskTitle: job.taskTitle,
                            })
                          }
                          disabled={submitMutation.isPending}
                        >
                          <Send className="w-4 h-4 mr-1" /> 결과 제출
                        </Button>
                      )}
                      {job.onChainStatus === 2 && (
                        <span className="text-xs font-mono text-success flex items-center gap-1">
                          <Activity className="w-4 h-4" /> 제출 완료
                        </span>
                      )}
                    </div>
                  </div>
                  {job.lastSubmissionPreview && (
                    <div className="mt-3 pt-3 border-t border-border/30">
                      <p className="text-xs text-muted-foreground font-mono">📎 {job.lastSubmissionPreview}</p>
                    </div>
                  )}
                </GlassCard>
              </motion.div>
            ))}
            {requests.length === 0 && (
              <GlassCard className="text-center py-10 text-muted-foreground">
                등록된 요청이 없습니다.
              </GlassCard>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold mb-4">등록 서비스</h2>
          <div className="grid md:grid-cols-2 gap-4">
            {(catalogQuery.data?.services ?? []).map((service) => (
              <GlassCard key={service.id} className="border-accent/10">
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-xs font-mono text-accent/70">{service.category}</span>
                    <h3 className="font-semibold">{service.title}</h3>
                    <p className="text-sm text-muted-foreground mt-1">{service.summary}</p>
                  </div>
                  <span className="text-sm font-mono text-accent font-bold whitespace-nowrap">
                    {formatStable(service.agentPriceLamports)} {mcpStatus?.priceSymbol || "USDC"}
                  </span>
                </div>
              </GlassCard>
            ))}
          </div>
        </section>
      </div>
    </PageLayout>
  );
};

export default OperatorPage;
