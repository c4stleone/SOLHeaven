import { ReactNode } from "react";
import TopNav from "./TopNav";

const PageLayout = ({ children }: { children: ReactNode }) => {
  return (
    <div className="min-h-screen bg-background grid-pattern">
      <TopNav />
      <main className="pt-20 pb-12">{children}</main>
    </div>
  );
};

export default PageLayout;
