import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  metadataBase: new URL("https://solana.usetend.xyz"),
  title: {
    default: "VSOL by Tend — Defined-risk markets on Solana",
    template: "%s · VSOL",
  },
  description:
    "A fully collateralized, signed-RFQ options sandbox deployed on Solana devnet.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "VSOL by Tend — Options, without the trapdoors",
    description: "Defined-risk markets for tokenized assets on Solana devnet.",
    type: "website",
    images: [{ url: "/og-vsol.png", width: 1731, height: 909, alt: "A secured VSOL payoff curve passing through fully collateralized escrow" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "VSOL by Tend — Options, without the trapdoors",
    description: "Defined-risk markets for tokenized assets on Solana devnet.",
    images: ["/og-vsol.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0b0b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
