import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ShoppingCart, Settings, ArrowRight, Hexagon, Zap, Lock, BarChart3 } from "lucide-react";
import PageLayout from "@/components/layout/PageLayout";
import GlassCard from "@/components/shared/GlassCard";

const roles = [
  {
    title: "Buyer",
    description: "MCP 상품 선택, 에스크로 생성/펀딩, 결과 승인/거절까지 한 화면에서 관리합니다.",
    icon: ShoppingCart,
    path: "/buyer",
    accent: "primary" as const,
  },
  {
    title: "Operator",
    description: "MCP 연결 관리, 상품 등록, 요청 검토 후 결과 제출까지 연결합니다.",
    icon: Settings,
    path: "/operator",
    accent: "accent" as const,
  },
];

const features = [
  { icon: Zap, title: "Outcome-only Settlement", desc: "호출 수가 아닌 결과물 기준 정산" },
  { icon: Lock, title: "On-chain Escrow", desc: "Solana 기반 안전한 에스크로" },
  { icon: BarChart3, title: "Dispute Resolution", desc: "분쟁 발생 시 Ops 판정으로 안전 종료" },
];

const accentStyles = {
  primary: "border-primary/30 hover:border-primary/60 hover:shadow-[0_0_30px_hsl(174_72%_56%/0.15)]",
  accent: "border-accent/30 hover:border-accent/60 hover:shadow-[0_0_30px_hsl(265_70%_60%/0.15)]",
};

const iconAccent = {
  primary: "text-primary",
  accent: "text-accent",
};

const Index = () => {
  return (
    <PageLayout>
      <div className="container">
        {/* Hero */}
        <section className="relative py-20 text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7 }}
          >
            <div className="flex justify-center mb-6">
              <div className="relative">
                <Hexagon className="w-16 h-16 text-primary animate-float" strokeWidth={1} />
                <div className="absolute inset-0 blur-lg opacity-40">
                  <Hexagon className="w-16 h-16 text-primary" strokeWidth={1} />
                </div>
              </div>
            </div>
            <p className="text-sm font-mono text-primary tracking-widest uppercase mb-4">
              Phase 0 · Anchor + Localnet
            </p>
            <h1 className="text-5xl md:text-6xl font-bold mb-6 leading-tight">
              Outcome<span className="text-gradient">Escrow</span>
              <br />
              <span className="text-muted-foreground text-3xl md:text-4xl font-light">
                MCP 결과 기반 정산 플랫폼
              </span>
            </h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-10">
              호출 수(pay-per-call)가 아니라 검증된 결과(outcome) 기준으로 정산하는
              Solana Anchor MVP입니다.
            </p>
          </motion.div>

          {/* Feature pills */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="flex flex-wrap justify-center gap-3 mb-16"
          >
            {features.map((f) => (
              <div
                key={f.title}
                className="glass rounded-full px-5 py-2.5 flex items-center gap-2 text-sm"
              >
                <f.icon className="w-4 h-4 text-primary" />
                <span className="text-foreground font-medium">{f.title}</span>
              </div>
            ))}
          </motion.div>

          {/* Role Cards */}
          <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
            {roles.map((role, i) => (
              <motion.div
                key={role.title}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + i * 0.1, duration: 0.5 }}
              >
                <Link to={role.path} className="block group">
                  <GlassCard
                    className={`h-full text-left transition-all duration-300 ${accentStyles[role.accent]}`}
                    hover
                  >
                    <role.icon className={`w-8 h-8 mb-4 ${iconAccent[role.accent]}`} />
                    <h2 className="text-xl font-bold mb-2">{role.title}</h2>
                    <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
                      {role.description}
                    </p>
                    <span className={`inline-flex items-center gap-1 text-sm font-medium ${iconAccent[role.accent]} group-hover:gap-2 transition-all`}>
                      Open <ArrowRight className="w-4 h-4" />
                    </span>
                  </GlassCard>
                </Link>
              </motion.div>
            ))}
          </div>
        </section>
      </div>
    </PageLayout>
  );
};

export default Index;
