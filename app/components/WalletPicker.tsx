"use client";

// Our own "choose a wallet" modal. Deliberately not
// @solana/wallet-adapter-react-ui's stock <WalletModal> -- this app draws
// every surface itself (see app/globals.css's design rules at the top of
// the file) and the stock modal ships its own CSS and visual language that
// doesn't match. Rendered by app/lib/wallet-bridge.tsx's
// WalletBridgeProvider whenever bridge.connect() is called.

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { Wallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";

type WalletPickerProps = {
  wallets: Wallet[];
  onSelect: (walletName: WalletName) => void;
  onClose: () => void;
};

export function WalletPicker({ wallets, onSelect, onClose }: WalletPickerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the dialog on open (accessibility requirement) and let Escape
  // dismiss it, matching the review modal's backdrop-click-to-close pattern
  // elsewhere in this app (see TendTerminal.tsx / PortfolioView.tsx).
  useEffect(() => {
    dialogRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function handleSelect(walletName: WalletName) {
    onSelect(walletName);
    onClose();
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.currentTarget === event.target && onClose()}
    >
      <div
        className="review-modal wallet-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Connect a Solana wallet"
        tabIndex={-1}
        ref={dialogRef}
      >
        <button type="button" className="icon-button close" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
        <span className="eyebrow">Connect wallet</span>
        <h2>Choose a Solana wallet</h2>
        {wallets.length === 0 ? (
          <div className="wallet-picker-empty">
            <p>No Solana wallet was detected in this browser. Install one and reload the page.</p>
            <div className="wallet-picker-list">
              <a href="https://phantom.app/download" target="_blank" rel="noreferrer">Get Phantom</a>
              <a href="https://solflare.com/download" target="_blank" rel="noreferrer">Get Solflare</a>
            </div>
          </div>
        ) : (
          <div className="wallet-picker-list">
            {wallets.map(({ adapter }) => (
              <button
                type="button"
                key={adapter.name}
                className="wallet-picker-option"
                onClick={() => handleSelect(adapter.name)}
              >
                <img src={adapter.icon} alt="" width={24} height={24} />
                <span>{adapter.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
