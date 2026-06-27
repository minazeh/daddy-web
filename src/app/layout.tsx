import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Daddy Poring — Party Builder",
  description: "Member dashboard and drag-and-drop 5-man party builder.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Full-viewport, non-scrolling shell: the builder owns its own layout
          (fixed left panel + pannable canvas). Dark neon theme.
          suppressHydrationWarning: browser extensions (e.g. Grammarly) inject
          attributes on <body> before React hydrates; this silences the benign
          warning for those attrs only — it does NOT mask real child mismatches. */}
      <body
        suppressHydrationWarning
        className="h-screen overflow-hidden bg-[#0a0a16] text-slate-100"
      >
        {children}
      </body>
    </html>
  );
}
