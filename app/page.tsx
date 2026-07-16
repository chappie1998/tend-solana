import type { Metadata } from "next";
import { TendTerminal } from "./components/TendTerminal";

export const metadata: Metadata = {
  title: "Tend — Defined-risk markets",
  description:
    "Trade defined-risk options on tokenized assets with transparent pricing and no liquidations.",
};

export default function Home() {
  return <TendTerminal />;
}
