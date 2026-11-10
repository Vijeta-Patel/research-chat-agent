import type { Metadata } from "next";
import { DM_Mono, DM_Sans, Fredoka } from "next/font/google";
import "./globals.css";

// Body: DM Sans (light weights), labels/meta: DM Mono, headings: Fredoka (soft, rounded).
const sans = DM_Sans({ variable: "--font-sans-family", subsets: ["latin"], weight: ["300", "400", "500", "600"] });
const mono = DM_Mono({ variable: "--font-mono-family", subsets: ["latin"], weight: ["400", "500"] });
const display = Fredoka({ variable: "--font-display-family", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "research chat",
  description: "A web-search chat agent with memory, where every claim is cited.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
