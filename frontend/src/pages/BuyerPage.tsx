import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  RefreshCw,
  Eye,
  ChevronRight,
  Search,
  Tag,
  FileText,
  DollarSign,
  Clock,
  CheckCircle2,
} from "lucide-react";
import PageLayout from "@/components/layout/PageLayout";
import GlassCard from "@/components/shared/GlassCard";
import KpiCard from "@/components/shared/KpiCard";
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
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import { mockMcpConnections } from "@/lib/mock-data";
import {
  airdropRole,
  bootstrapSystem,
  createJob,
  createJobSpec,
  fundJob,
  getOperatorCatalog,
  getOperatorRequests,
  getWallets,
} from "@/lib/api";
import type { CatalogItem, JobSpec, JobStatus } from "@/lib/types";

const DEFAULT_STABLE_DECIMALS = 6;

const formatStable = (units: string, decimals = DEFAULT_STABLE_DECIMALS) => {
  const divisor = 10 ** Math.max(0, decimals);
  return (Number(units || "0") / divisor).toFixed(2);
};

const defaultTaskTitle = (service: CatalogItem) => `${service.title} 의뢰`;
const parseRequiredQuestions = (value: string) =>
  value
    .split(/\n|,/g)
    .map((item) => item.trim())
    .filter((item) => Boolean(item));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isInsufficientLamportsError = (error: unknown) => {
  const message = String((error as any)?.message ?? error ?? "");
  return /insufficient lamports|custom program error: 0x1|attempt to debit/i.test(
    message
  );
};

const isConfigNotReadyError = (error: unknown) => {
  const message = String((error as any)?.message ?? error ?? "");
  return /config is not initialized|account not initialized|config initialization failed/i.test(
    message
  );
};

type RequestCriteriaForm = {
  minPages: string;
  minSourceLinks: string;
  minTrustedDomainRatio: string;
  requiredContent: string;
  extraNotes: string;
};

const defaultCriteriaForm: RequestCriteriaForm = {
  minPages: "3",
  minSourceLinks: "3",
  minTrustedDomainRatio: "60",
  requiredContent: "",
  extraNotes: "",
};

const BuyerPage = () => {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [selectedService, setSelectedService] = useState<CatalogItem | null>(null);
  const [criteriaForm, setCriteriaForm] = useState<RequestCriteriaForm>(defaultCriteriaForm);

  const walletsQuery = useQuery({
    queryKey: ["wallets"],
    queryFn: getWallets,
  });
  const catalogQuery = useQuery({
    queryKey: ["operator-catalog"],
    queryFn: getOperatorCatalog,
  });
  const requestsQuery = useQuery({
    queryKey: ["operator-requests"],
    queryFn: () => getOperatorRequests(),
  });

  const stableDecimals = walletsQuery.data?.stableDecimals ?? DEFAULT_STABLE_DECIMALS;
  const stableSymbol = walletsQuery.data?.stableSymbol ?? "USDC";
  const buyerWallet = walletsQuery.data?.roles?.buyer ?? "";

  const mockMcpServices = useMemo<CatalogItem[]>(() => {
    const fallbackTs = new Date().toISOString();
    return mockMcpConnections.map((mcp, index) => ({
      id: `mock-mcp-${index + 1}`,
      title: mcp.name,
      summary: `${mcp.serverUrl} · ${mcp.lastMessage}`,
      category: "mcp-mock",
      outputFormat: "Markdown",
      agentPriceLamports: mcp.priceLamports,
      createdAt: mcp.lastCheckedAt ?? fallbackTs,
      updatedAt: mcp.lastCheckedAt ?? fallbackTs,
    }));
  }, []);

  const services = useMemo(() => {
    const fromApi = catalogQuery.data?.services ?? [];
    const titleSet = new Set(fromApi.map((service) => service.title.trim().toLowerCase()));
    const merged = [...fromApi];
    for (const mockService of mockMcpServices) {
      const titleKey = mockService.title.trim().toLowerCase();
      if (!titleSet.has(titleKey)) {
        merged.push(mockService);
      }
    }
    return merged;
  }, [catalogQuery.data?.services, mockMcpServices]);
  const categories = useMemo(
    () => [...new Set(services.map((service) => service.category))],
    [services]
  );

  const filteredServices = useMemo(
    () =>
      services.filter((service) => {
        const lowerQuery = searchQuery.toLowerCase();
        const matchQuery =
          !searchQuery ||
          service.title.toLowerCase().includes(lowerQuery) ||
          service.summary.toLowerCase().includes(lowerQuery);
        const matchCategory = !selectedCategory || service.category === selectedCategory;
        return matchQuery && matchCategory;
      }),
    [searchQuery, selectedCategory, services]
  );

  const buyerJobs = useMemo(() => {
    if (!buyerWallet) {
      return [];
    }
    const requests = requestsQuery.data?.requests ?? [];
    return requests
      .filter((request) => request.buyer === buyerWallet)
      .map((request) => {
        const rawStatus = Number(request.job?.status ?? request.onChainStatus ?? 0);
        const boundedStatus = Math.min(4, Math.max(0, rawStatus)) as JobStatus;
        return {
          ...request,
          onChainStatus: boundedStatus,
        } as JobSpec;
      });
  }, [requestsQuery.data?.requests, buyerWallet]);

  const buyerMetrics = useMemo(() => {
    let escrowActiveUnits = 0;
    let inProgress = 0;
    let settled = 0;

    for (const job of buyerJobs) {
      const status = Number(job.onChainStatus ?? 0);
      const rewardUnits = Number(job.job?.reward ?? 0);
      if (status >= 1 && status < 4) {
        escrowActiveUnits += rewardUnits;
      }
      if (status >= 1 && status < 4) {
        inProgress += 1;
      }
      if (status === 4) {
        settled += 1;
      }
    }

    return {
      total: buyerJobs.length,
      escrowActiveText: formatStable(String(escrowActiveUnits), stableDecimals),
      inProgress,
      settled,
    };
  }, [buyerJobs, stableDecimals]);

  const createRequestMutation = useMutation({
    mutationFn: async (payload: {
      service: CatalogItem;
      criteria: {
        minPages: number;
        minSourceLinks: number;
        minTrustedDomainRatio: number;
        requiredQuestions: string[];
        extraNotes: string;
      };
    }) => {
      const { service, criteria } = payload;
      if (!buyerWallet) {
        throw new Error("buyer wallet is not ready yet");
      }
      let created: Awaited<ReturnType<typeof createJob>>;
      try {
        created = await createJob({
          serviceId: service.id,
          deadlineSeconds: 24 * 60 * 60,
        });
      } catch (error) {
        if (isInsufficientLamportsError(error)) {
          await airdropRole({ role: "buyer", sol: 2 });
          await sleep(1200);
          try {
            created = await createJob({
              serviceId: service.id,
              deadlineSeconds: 24 * 60 * 60,
            });
          } catch (retryError) {
            if (!isInsufficientLamportsError(retryError)) {
              throw retryError;
            }
            await sleep(1200);
            created = await createJob({
              serviceId: service.id,
              deadlineSeconds: 24 * 60 * 60,
            });
          }
        } else if (isConfigNotReadyError(error)) {
          await bootstrapSystem();
          created = await createJob({
            serviceId: service.id,
            deadlineSeconds: 24 * 60 * 60,
          });
        } else {
          throw error;
        }
      }

      await createJobSpec({
        buyer: buyerWallet,
        jobId: created.jobId,
        serviceId: service.id,
        serviceTitle: service.title,
        taskTitle: defaultTaskTitle(service),
        taskBrief: criteria.extraNotes || service.summary,
        criteria: {
          minPages: criteria.minPages,
          minSourceLinks: criteria.minSourceLinks,
          minTrustedDomainRatio: criteria.minTrustedDomainRatio,
          requireTableOrChart: true,
          requiredFormat: service.outputFormat || "PDF",
          requiredQuestions: criteria.requiredQuestions,
          extraNotes: criteria.extraNotes,
        },
      });

      let funded = false;
      let fundError = "";
      try {
        await fundJob({ jobId: created.jobId });
        funded = true;
      } catch (error: any) {
        funded = false;
        fundError = String(error?.message ?? "funding failed");
      }

      return {
        jobId: created.jobId,
        funded,
        fundError,
        serviceTitle: service.title,
      };
    },
    onSuccess: async (result) => {
      setRequestDialogOpen(false);
      setSelectedService(null);
      setCriteriaForm(defaultCriteriaForm);
      await queryClient.invalidateQueries({ queryKey: ["operator-requests"] });
      const detail = result.funded
        ? "create + fund 완료"
        : `create 완료 (fund 실패: ${result.fundError})`;
      toast({
        title: `의뢰 #${result.jobId} 생성`,
        description: `${result.serviceTitle} · ${detail}`,
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "의뢰 생성 실패",
        description: String(error?.message ?? "unknown error"),
      });
    },
  });

  const refreshAll = async () => {
    await Promise.all([
      walletsQuery.refetch(),
      catalogQuery.refetch(),
      requestsQuery.refetch(),
    ]);
  };

  const createFromService = (service: CatalogItem) => {
    setSelectedService(service);
    setCriteriaForm(defaultCriteriaForm);
    setRequestDialogOpen(true);
  };

  const submitRequestWithCriteria = () => {
    if (!selectedService) {
      return;
    }
    if (!buyerWallet || walletsQuery.isLoading) {
      toast({
        variant: "destructive",
        title: "지갑 준비 중",
        description: "지갑 정보를 불러오는 중입니다. 잠시 후 다시 시도하세요.",
      });
      return;
    }
    const minPages = Number(criteriaForm.minPages);
    const minSourceLinks = Number(criteriaForm.minSourceLinks);
    const minTrustedDomainRatio = Number(criteriaForm.minTrustedDomainRatio);
    if (
      Number.isNaN(minPages) ||
      Number.isNaN(minSourceLinks) ||
      Number.isNaN(minTrustedDomainRatio)
    ) {
      toast({
        variant: "destructive",
        title: "입력값 확인",
        description: "숫자 항목은 숫자로 입력해주세요.",
      });
      return;
    }
    createRequestMutation.mutate({
      service: selectedService,
      criteria: {
        minPages: Math.max(0, minPages),
        minSourceLinks: Math.max(0, minSourceLinks),
        minTrustedDomainRatio: Math.max(0, Math.min(100, minTrustedDomainRatio)),
        requiredQuestions: parseRequiredQuestions(criteriaForm.requiredContent),
        extraNotes: criteriaForm.extraNotes.trim(),
      },
    });
  };

  const loading =
    walletsQuery.isLoading ||
    catalogQuery.isLoading ||
    requestsQuery.isLoading;

  return (
    <PageLayout>
      <div className="container space-y-8">
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="flex-1">
            <p className="text-sm font-mono text-primary tracking-widest uppercase mb-2">
              Buyer Dashboard
            </p>
            <h1 className="text-3xl md:text-4xl font-bold mb-3">성과 기반 에이전트 발주</h1>
            <p className="text-muted-foreground max-w-xl mb-4">
              호출 수가 아니라 검증된 결과물 기준으로 정산합니다. 새 의뢰를 등록하고,
              에스크로 예치, 결과 승인/거절까지 한 화면에서 관리합니다.
            </p>
            <div className="flex flex-wrap gap-2">
              {["Outcome-only Settlement", "On-chain Audit Trail", "Dispute-safe Escrow"].map(
                (badge) => (
                  <span
                    key={badge}
                    className="text-xs font-mono px-3 py-1.5 rounded-full bg-primary/10 text-primary border border-primary/20"
                  >
                    {badge}
                  </span>
                )
              )}
            </div>
          </div>
        </motion.section>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard label="총 의뢰" value={buyerMetrics.total} icon={FileText} />
          <KpiCard
            label="에스크로 예치"
            value={buyerMetrics.escrowActiveText}
            icon={DollarSign}
            accent="success"
          />
          <KpiCard label="진행 중" value={buyerMetrics.inProgress} icon={Clock} accent="warning" />
          <KpiCard label="정산 완료" value={buyerMetrics.settled} icon={CheckCircle2} accent="accent" />
        </div>

        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold">서비스 카탈로그</h2>
            <Button
              variant="outline"
              size="sm"
              className="border-primary/20 text-primary"
              onClick={refreshAll}
              disabled={loading}
            >
              <RefreshCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="서비스 검색..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="pl-10 bg-card border-border/50"
              />
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setSelectedCategory("")}
                className={`px-3 py-2 text-xs font-mono rounded-lg transition-colors ${
                  !selectedCategory
                    ? "bg-primary/10 text-primary border border-primary/20"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                All
              </button>
              {categories.map((category) => (
                <button
                  key={category}
                  onClick={() => setSelectedCategory(category)}
                  className={`px-3 py-2 text-xs font-mono rounded-lg transition-colors ${
                    selectedCategory === category
                      ? "bg-primary/10 text-primary border border-primary/20"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {filteredServices.map((service, index) => (
              <motion.div
                key={service.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
              >
                <GlassCard hover className="cursor-pointer group">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <span className="text-xs font-mono text-primary/70 mb-1 block">
                        <Tag className="w-3 h-3 inline mr-1" />
                        {service.category}
                      </span>
                      <h3 className="font-semibold text-lg">{service.title}</h3>
                    </div>
                    <span className="text-sm font-mono text-primary font-bold">
                      {formatStable(service.agentPriceLamports, stableDecimals)} {stableSymbol}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">{service.summary}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground font-mono">
                      Output: {service.outputFormat}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs text-primary"
                      onClick={() => createFromService(service)}
                      disabled={
                        createRequestMutation.isPending ||
                        walletsQuery.isLoading ||
                        !buyerWallet
                      }
                    >
                      발주하기 <ChevronRight className="w-3 h-3 ml-1" />
                    </Button>
                  </div>
                </GlassCard>
              </motion.div>
            ))}
          </div>
        </section>

        <Dialog open={requestDialogOpen} onOpenChange={setRequestDialogOpen}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>발주 요구사항 입력</DialogTitle>
              <DialogDescription>
                {selectedService
                  ? `${selectedService.title} 발주 조건을 입력하세요.`
                  : "발주 조건을 입력하세요."}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="min-pages">최소 페이지 수</Label>
                  <Input
                    id="min-pages"
                    type="number"
                    min={0}
                    value={criteriaForm.minPages}
                    onChange={(event) =>
                      setCriteriaForm((prev) => ({
                        ...prev,
                        minPages: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="min-links">최소 출처 링크 수</Label>
                  <Input
                    id="min-links"
                    type="number"
                    min={0}
                    value={criteriaForm.minSourceLinks}
                    onChange={(event) =>
                      setCriteriaForm((prev) => ({
                        ...prev,
                        minSourceLinks: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="trusted-ratio">신뢰도 높은 도메인 비율(%)</Label>
                  <Input
                    id="trusted-ratio"
                    type="number"
                    min={0}
                    max={100}
                    value={criteriaForm.minTrustedDomainRatio}
                    onChange={(event) =>
                      setCriteriaForm((prev) => ({
                        ...prev,
                        minTrustedDomainRatio: event.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="required-content">반드시 포함해야하는 내용</Label>
                <Textarea
                  id="required-content"
                  rows={4}
                  placeholder="항목을 줄바꿈으로 입력하세요."
                  value={criteriaForm.requiredContent}
                  onChange={(event) =>
                    setCriteriaForm((prev) => ({
                      ...prev,
                      requiredContent: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="extra-notes">추가 요구사항</Label>
                <Textarea
                  id="extra-notes"
                  rows={4}
                  placeholder="추가 요구사항을 입력하세요."
                  value={criteriaForm.extraNotes}
                  onChange={(event) =>
                    setCriteriaForm((prev) => ({
                      ...prev,
                      extraNotes: event.target.value,
                    }))
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setRequestDialogOpen(false)}
                disabled={createRequestMutation.isPending}
              >
                취소
              </Button>
              <Button onClick={submitRequestWithCriteria} disabled={createRequestMutation.isPending}>
                확인
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold">의뢰 목록</h2>
          </div>

          <div className="space-y-3">
            {buyerJobs.map((job, index) => (
              <motion.div
                key={job.key}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
              >
                <GlassCard hover className="cursor-pointer">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-muted-foreground">#{job.jobId}</span>
                          <JobStatusBadge status={(job.onChainStatus ?? 0) as JobStatus} />
                        </div>
                        <h3 className="font-semibold truncate">{job.taskTitle}</h3>
                        <p className="text-sm text-muted-foreground truncate">{job.serviceTitle}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right hidden md:block">
                        <p className="text-xs text-muted-foreground font-mono">
                          {new Date(job.createdAt).toLocaleDateString("ko-KR")}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm">
                        <Eye className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </GlassCard>
              </motion.div>
            ))}
            {buyerJobs.length === 0 && (
              <GlassCard className="text-center py-10 text-muted-foreground">
                아직 생성된 의뢰가 없습니다.
              </GlassCard>
            )}
          </div>
        </section>
      </div>
    </PageLayout>
  );
};

export default BuyerPage;
