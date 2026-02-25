import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}

const GlassCard = ({ children, className, hover = false }: GlassCardProps) => {
  return (
    <div className={cn(hover ? "glass-hover" : "glass", "rounded-xl p-6", className)}>
      {children}
    </div>
  );
};

export default GlassCard;
