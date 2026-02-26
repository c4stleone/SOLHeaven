import { Link, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { Hexagon, ShoppingCart, Settings, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";

const navItems = [
  { path: "/", label: "Home", icon: Hexagon },
  { path: "/buyer", label: "Buyer", icon: ShoppingCart },
  { path: "/operator", label: "Operator", icon: Settings },
];

const TopNav = () => {
  const location = useLocation();
  const [opsWalletConnected, setOpsWalletConnected] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  useEffect(() => {
    // Check if Phantom wallet is already connected
    const checkWallet = async () => {
      if ("solana" in window) {
        try {
          const response = await (window.solana as any).connect({ onlyIfTrusted: true });
          setPublicKey(response.publicKey.toString());
          setOpsWalletConnected(true);
        } catch {
          setOpsWalletConnected(false);
        }
      }
    };

    checkWallet();

    // Listen for wallet changes
    if ("solana" in window) {
      (window.solana as any).on("connect", (publicKey: any) => {
        setPublicKey(publicKey.toString());
        setOpsWalletConnected(true);
      });

      (window.solana as any).on("disconnect", () => {
        setPublicKey(null);
        setOpsWalletConnected(false);
      });
    }
  }, []);

  const handleWalletClick = async () => {
    console.log("=== 지갑 연결 버튼 클릭 ===");
    console.log("window.solana 존재:", "solana" in window);
    console.log("window.solana 값:", window.solana);
    
    try {
      if (!("solana" in window)) {
        console.log("Phantom 미설치");
        alert("Phantom 지갑을 설치하세요!");
        window.open("https://phantom.app", "_blank");
        return;
      }

      console.log("현재 연결 상태:", opsWalletConnected);

      if (opsWalletConnected) {
        console.log("지갑 연결 해제 시도...");
        await (window.solana as any).disconnect();
        setPublicKey(null);
        setOpsWalletConnected(false);
        console.log("지갑 연결 해제 완료");
      } else {
        console.log("지갑 연결 시도...");
        const response = await (window.solana as any).connect();
        console.log("연결 응답:", response);
        setPublicKey(response.publicKey.toString());
        setOpsWalletConnected(true);
        console.log("지갑 연결 완료");
      }
    } catch (error) {
      console.error("지갑 연결 오류:", error);
      alert(`오류 발생: ${error}`);
    }
  };

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass border-b border-border/50">
      <div className="container flex items-center justify-between h-16">
        <Link to="/" className="flex items-center gap-2 group">
          <div className="relative">
            <Hexagon className="w-8 h-8 text-primary" strokeWidth={1.5} />
            <div className="absolute inset-0 w-8 h-8 text-primary opacity-40 blur-sm">
              <Hexagon className="w-8 h-8" strokeWidth={1.5} />
            </div>
          </div>
          <span className="text-lg font-bold tracking-tight">
            SOL<span className="text-primary">Heaven</span>
          </span>
        </Link>

        <div className="flex items-center gap-2">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                className="relative px-4 py-2 text-sm font-medium transition-colors rounded-lg"
              >
                {isActive && (
                  <motion.div
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-lg bg-primary/10 border border-primary/20"
                    transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                  />
                )}
                <span className={`relative z-10 flex items-center gap-2 ${isActive ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                  <Icon className="w-4 h-4" />
                  {item.label}
                </span>
              </Link>
            );
          })}
          <Button
            size="sm"
            variant={opsWalletConnected ? "default" : "outline"}
            className={
              opsWalletConnected
                ? "ml-2"
                : "ml-2 border-warning/30 text-warning hover:bg-warning/10"
            }
            onClick={handleWalletClick}
            title={publicKey ? `Connected: ${publicKey.slice(0, 4)}...${publicKey.slice(-4)}` : "Phantom 지갑으로 연결"}
          >
            <Wallet className="w-4 h-4 mr-1" />
            {opsWalletConnected ? "지갑 연결됨" : "지갑 연결"}
          </Button>
        </div>
      </div>
    </nav>
  );
};

declare global {
  interface Window {
    solana?: any;
  }
}

export default TopNav;
