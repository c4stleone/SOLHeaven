import { motion } from "framer-motion";
import { LucideIcon } from "lucide-react";

interface KpiCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  accent?: "primary" | "accent" | "success" | "warning" | "destructive";
}

const KpiCard = ({ label, value, icon: Icon, accent = "primary" }: KpiCardProps) => {
  const accentColors = {
    primary: "text-primary border-primary/20",
    accent: "text-accent border-accent/20",
    success: "text-success border-success/20",
    warning: "text-warning border-warning/20",
    destructive: "text-destructive border-destructive/20",
  };

  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className={`glass rounded-xl p-5 border ${accentColors[accent]}`}
    >
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        <Icon className={`w-5 h-5 ${accentColors[accent].split(" ")[0]}`} />
      </div>
      <p className="text-3xl font-bold font-mono">{value}</p>
    </motion.article>
  );
};

export default KpiCard;
