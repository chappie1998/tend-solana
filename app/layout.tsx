import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Tend — Defined-risk markets",
    template: "%s · Tend",
  },
  description:
    "A transparent, fully collateralized options market for tokenized assets.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Tend — Options, without the trapdoors",
    description: "Defined-risk markets for tokenized assets on Robinhood Chain.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f2eb",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
