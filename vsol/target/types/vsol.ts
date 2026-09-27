/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/vsol.json`.
 */
export type Vsol = {
  "address": "2SgyYptw5rMFsTKHiP95c5K3porxFrcsz6fb4mBfDa1v",
  "metadata": {
    "name": "vsol",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Fully collateralized RFQ options for tokenized assets on Solana"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "pendingAdmin",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "applyLiquidityPoolUpdate",
      "docs": [
        "Commits a pending `update_liquidity_pool` proposal once its timelock",
        "has elapsed. Requires the pool idle for the same reason",
        "`update_liquidity_pool` does: applying while `open_positions > 0`",
        "would change the risk backing an already-open position out from",
        "under it. See `update_liquidity_pool`'s doc comment for the residual",
        "gap this does not close."
      ],
      "discriminator": [
        41,
        56,
        18,
        175,
        110,
        35,
        131,
        87
      ],
      "accounts": [
        {
          "name": "manager",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "pool.settlement_mint",
                "account": "liquidityPool"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "cancelPendingPoolUpdate",
      "docs": [
        "Lets the manager clear a pending `update_liquidity_pool` proposal",
        "before its timelock elapses, so a mistaken or stale proposal is not",
        "stuck sitting there for `POOL_UPDATE_TIMELOCK_SECONDS`. Cancelling",
        "never touches the pool's live configuration -- there is nothing",
        "unsafe about allowing it regardless of whether the pool is idle."
      ],
      "discriminator": [
        239,
        238,
        72,
        105,
        31,
        66,
        74,
        144
      ],
      "accounts": [
        {
          "name": "manager",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "pool.settlement_mint",
                "account": "liquidityPool"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "captureCustomSettlementObservation",
      "discriminator": [
        135,
        123,
        185,
        104,
        224,
        179,
        28,
        184
      ],
      "accounts": [
        {
          "name": "oracleAuthority",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "market"
        },
        {
          "name": "feed",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  115,
                  116,
                  111,
                  109,
                  45,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "market.symbol",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "observation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  115,
                  116,
                  111,
                  109,
                  45,
                  111,
                  98,
                  115,
                  101,
                  114,
                  118,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market.symbol",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closePoolPosition",
      "docs": [
        "Lets a buyer exit an open pool-backed position before expiry by",
        "selling it back to the pool at a price the pool's own",
        "`quote_authority` quotes and signs one-shot, exactly like it signs",
        "fills. This is the buyer's only way out before settlement/timeout",
        "refund; today they are locked in until one of those two paths.",
        "",
        "Guardian: this is a buyer exit, so -- like `settle`/`settle_pool_position`",
        "-- it must work even while the protocol is paused. It is intentionally",
        "NOT gated on `config.paused`."
      ],
      "discriminator": [
        42,
        17,
        73,
        101,
        165,
        34,
        118,
        221
      ],
      "accounts": [
        {
          "name": "buyer",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool",
            "market"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          },
          "relations": [
            "poolMarket",
            "position"
          ]
        },
        {
          "name": "market",
          "relations": [
            "oracle",
            "poolMarket",
            "position"
          ]
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "poolMarket",
          "writable": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "position.nonce_record",
                "account": "poolPosition"
              }
            ]
          }
        },
        {
          "name": "positionVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "settlementMint",
          "relations": [
            "pool",
            "market",
            "position"
          ]
        },
        {
          "name": "buyerDestination",
          "writable": true
        },
        {
          "name": "poolToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "treasuryDestination",
          "writable": true
        },
        {
          "name": "rentRecipient",
          "writable": true
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "poolBuybackArgs"
            }
          }
        }
      ]
    },
    {
      "name": "closeSettledMarket",
      "docs": [
        "Reclaims a fully-settled market's rent by closing both the `Market`",
        "and its `SettlementOracle` accounts once nothing can ever reference",
        "either of them again. This is the rolling grid's only cleanup path:",
        "markets and oracles are otherwise never closed, so without this",
        "instruction their rent is permanently consumed as the factory keeps",
        "minting new series.",
        "",
        "Safety argument -- why this cannot strand or double-spend anything:",
        "",
        "1. `expiry + observation_window_seconds + settlement_grace_seconds` is",
        "exactly the deadline `refund_pool_position` already uses as \"the",
        "settlement fallback window is closed\" (`VsolError::SettlementWindowOpen`).",
        "NOTE (updated alongside the tier-2 timing fix): `publish_pyth_settlement`",
        "can still publish for a while past this exact point -- tier 1",
        "always, tier 2 after a short additional buffer (see",
        "`SETTLEMENT_REFUND_PRIORITY_SECONDS`) -- but never past",
        "`deadline + max_settlement_staleness_seconds`, which",
        "`create_market`'s cross-parameter bound",
        "(`MAX_SETTLEMENT_STALENESS_TO_WINDOW_RATIO`) guarantees is always",
        "`<= deadline + MARKET_CLEANUP_BUFFER_SECONDS` (both",
        "`max_settlement_staleness_seconds` and `MARKET_CLEANUP_BUFFER_SECONDS`",
        "are capped at the same 7-day ceiling). So by the time THIS",
        "instruction's own cutoff below is reached, `publish_pyth_settlement`",
        "is guaranteed to already be permanently closed and the oracle's",
        "`finalized`/`price` state frozen forever -- there is no future",
        "event that could still need this market or oracle to exist.",
        "",
        "This instruction nonetheless requires a FURTHER",
        "`MARKET_CLEANUP_BUFFER_SECONDS` on top of that deadline. Freezing",
        "the oracle is not the same as sweeping the positions: the deadline",
        "is the instant `refund_unsettled`/`refund_pool_position` first",
        "become callable, so closing the market at that same instant races",
        "every in-flight refund with no margin at all. The buffer is what",
        "makes point 3's off-chain assumption survivable rather than a",
        "coin-flip against the cleaner.",
        "2. `fill_pool_quote` hard-requires `now < market.expiry` before",
        "opening a new position. Since the deadline above is strictly after",
        "`expiry`, by the time it has elapsed no new pool-backed position",
        "can ever be opened against this market again, full stop -- this",
        "holds independently of `market.enabled`/`pool_market.enabled`,",
        "which are therefore not load-bearing for \"no new obligations\":",
        "that is already guaranteed by the expiry check `fill_pool_quote`",
        "performs itself.",
        "3. `pool` and `pool_market` are now MANDATORY (no `(None, None)`",
        "bypass -- see `CloseSettledMarket`'s own doc comment for why an",
        "earlier version of this instruction wrongly accepted omitting",
        "them). The caller must supply the authorization record for *this*",
        "market and pool; the handler requires it to have `enabled ==",
        "false` AND `pool_market.open_positions == 0` (not the legacy",
        "`UNKNOWN` sentinel either -- see `OpenPositionCount`'s doc comment",
        "on `LiquidityPoolMarket`) before closing. This is a HARD",
        "requirement, not defense-in-depth: `settle_pool_position` and",
        "`refund_pool_position` both load `market: Box<Account<'info,",
        "Market>>` via `has_one`/a manual key check, so once `Market` is",
        "closed neither can ever run again -- any `PoolPosition` still open",
        "against this market at that point has its escrowed",
        "`premium + max_payout` stranded forever, unrecoverable by any",
        "instruction in this program. That is exactly the failure this",
        "check exists to prevent, which is why it cannot be optional.",
        "Consequence: a market that was never bound to ANY pool (no",
        "`LiquidityPoolMarket` was ever created for it) can never be closed",
        "on chain -- only its own (and its oracle's) rent is permanently",
        "stuck, never any position's funds, since a market nobody ever",
        "authorized a pool against can have no `PoolPosition`s either",
        "(`fill_pool_quote` requires an enabled `pool_market`). Accepted:",
        "fills go through the pool path exclusively, so every market that",
        "ever actually traded has a binding to supply here.",
        "4. RESIDUAL GAP (documented, not fixed here): a market can legally be",
        "bound to MORE THAN ONE pool over its lifetime -- each binding is",
        "an independent `[POOL_MARKET_SEED, pool, market]` PDA, so there is",
        "no bounded on-chain enumeration of \"every pool ever authorized",
        "against this market\" (the same unenumerability problem as",
        "individual positions, one level up). This instruction only checks",
        "the ONE `(pool, pool_market)` pair the caller supplies: passing a",
        "binding that is genuinely idle does not prove every OTHER binding",
        "against this market is also idle, so a market with a second,",
        "still-open pool binding could in principle be closed, stranding",
        "that other binding's open positions. The complete fix is a",
        "market-level open-position counter (on `Market` itself, maintained",
        "across every pool's fills/settles/refunds) -- not applicable here",
        "because it would change `Market`'s layout, and live devnet",
        "accounts must keep deserializing unchanged (see this crate's",
        "layout-compatibility constraints); it is free to add on a fresh",
        "mainnet deploy with no live accounts to preserve, and should be",
        "the mainnet follow-up. Until then, this gap is bounded by two",
        "things neither of which is enforced by this instruction itself:",
        "the caller is already privileged (`market.creator` or",
        "`config.admin`, see point 5 below), and the off-chain cleaner",
        "(`vsol/scripts/lib/settlement.ts`'s `selectMarketCloseCandidates`,",
        "called from `vsol/scripts/cranker.ts`) is expected to check every",
        "pool binding for a market before requesting a close, not just one.",
        "5. Permission: the caller must be `market.creator` or `config.admin`.",
        "Rent always returns to `market.creator` (`rent_recipient` is",
        "address-constrained to it), never to an arbitrary caller-supplied",
        "account.",
        "6. Deliberately *not* gated on `config.paused`: this is maintenance",
        "cleanup, not a trading action, so it must remain callable while",
        "the protocol is paused (mirrors `close_pool_position`'s guardian",
        "rationale for staying pause-independent)."
      ],
      "discriminator": [
        223,
        102,
        55,
        116,
        87,
        131,
        141,
        161
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true,
          "relations": [
            "oracle"
          ]
        },
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "pool"
        },
        {
          "name": "poolMarket",
          "writable": true
        },
        {
          "name": "rentRecipient",
          "docs": [
            "rent. Address-constrained to the market's own creator so rent can",
            "never be redirected to an arbitrary caller-supplied account."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "createMarket",
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "arg",
                "path": "args.market_id"
              }
            ]
          }
        },
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "settlementMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createMarketArgs"
            }
          }
        }
      ]
    },
    {
      "name": "depositLiquidity",
      "discriminator": [
        245,
        99,
        59,
        25,
        151,
        71,
        233,
        249
      ],
      "accounts": [
        {
          "name": "provider",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool"
          ]
        },
        {
          "name": "settlementMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          }
        },
        {
          "name": "poolToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "providerPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "provider"
              }
            ]
          }
        },
        {
          "name": "providerSource",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "minSharesOut",
          "type": "u64"
        },
        {
          "name": "deadline",
          "type": "i64"
        }
      ]
    },
    {
      "name": "fillPoolQuote",
      "discriminator": [
        127,
        177,
        61,
        41,
        158,
        164,
        240,
        162
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "quoteAuthority"
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool",
            "market"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          },
          "relations": [
            "poolMarket"
          ]
        },
        {
          "name": "market",
          "relations": [
            "poolMarket"
          ]
        },
        {
          "name": "poolMarket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "settlementMint",
          "relations": [
            "pool",
            "market"
          ]
        },
        {
          "name": "poolToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "buyerSource",
          "writable": true
        },
        {
          "name": "nonceRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  110,
                  111,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "quoteAuthority"
              },
              {
                "kind": "arg",
                "path": "quote.nonce"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "nonceRecord"
              }
            ]
          }
        },
        {
          "name": "positionVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "eligibility",
          "optional": true
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quote",
          "type": {
            "defined": {
              "name": "poolQuoteArgs"
            }
          }
        }
      ]
    },
    {
      "name": "initCustomPriceFeed",
      "docs": [
        "One-time per symbol (e.g. SOL/BTC/ETH): creates the `CustomPriceFeed`",
        "PDA a later `update_custom_price_feed`/`publish_custom_settlement`",
        "call will read. Admin-gated, mirroring every other config-owned",
        "`init` instruction in this file. `published_at` starts at 0, which",
        "deliberately fails `publish_custom_settlement`'s freshness check",
        "forever until a real `update_custom_price_feed` call lands."
      ],
      "discriminator": [
        85,
        173,
        225,
        40,
        138,
        220,
        118,
        10
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  115,
                  116,
                  111,
                  109,
                  45,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "symbol"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "symbol",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "priceScale",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initializeConfigArgs"
            }
          }
        }
      ]
    },
    {
      "name": "initializeLiquidityPool",
      "discriminator": [
        155,
        18,
        138,
        107,
        111,
        23,
        178,
        178
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "settlementMint"
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              },
              {
                "kind": "arg",
                "path": "args.pool_id"
              }
            ]
          }
        },
        {
          "name": "poolToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initializeLiquidityPoolArgs"
            }
          }
        }
      ]
    },
    {
      "name": "nominateAdmin",
      "discriminator": [
        134,
        11,
        31,
        244,
        20,
        77,
        138,
        121
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "pendingAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "publishCustomSettlement",
      "docs": [
        "Mirrors `publish_pyth_settlement`'s shape but reads `CustomPriceFeed`",
        "instead of verifying a Pyth `price_update`. No caller signer is",
        "required: authentication already happened at `update_custom_price_feed`",
        "time -- the same permissionless-relay principle `publish_pyth_settlement`",
        "itself relies on, where the settlement CALLER isn't what's trusted,",
        "the upstream signed write is."
      ],
      "discriminator": [
        245,
        183,
        205,
        35,
        21,
        122,
        11,
        27
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market",
            "observation"
          ]
        },
        {
          "name": "market",
          "relations": [
            "oracle"
          ]
        },
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "observation",
          "docs": [
            "Closed here (rent to `rent_recipient`, i.e. `config.oracle_authority`,",
            "the account that paid for it at `capture_custom_settlement_observation`)",
            "once its data has been fully consumed into `oracle` above. Nothing else",
            "in the program ever reads a `CustomSettlementObservation` again after",
            "this point: `settle_pool_position`/`refund_pool_position`/`settle`/",
            "`refund_unsettled` all gate on `oracle.finalized`, never on this",
            "account, and the only two instructions that ever reference this type",
            "are this one and `CaptureCustomSettlementObservation`'s own `init`.",
            "`oracle.price_update` retains this account's now-stale pubkey purely",
            "as an audit-trail pointer -- like `publish_pyth_settlement`'s own",
            "`price_update` field, it is write-only and never dereferenced by any",
            "instruction, so closing the account it points to is harmless."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  115,
                  116,
                  111,
                  109,
                  45,
                  111,
                  98,
                  115,
                  101,
                  114,
                  118,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market.symbol",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "rentRecipient",
          "docs": [
            "to `config.oracle_authority`, who paid for it originally. Publication",
            "itself stays permissionless: this account is not a `Signer`, only a",
            "payout target, so anyone may still call `publish_custom_settlement`."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "publishPythSettlement",
      "discriminator": [
        118,
        173,
        113,
        184,
        10,
        0,
        231,
        81
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "relations": [
            "oracle"
          ]
        },
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "priceUpdate",
          "docs": [
            "full guardian verification, exact feed id, and serialized account length."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "refundPoolPosition",
      "discriminator": [
        45,
        46,
        150,
        218,
        231,
        109,
        150,
        242
      ],
      "accounts": [
        {
          "name": "cranker",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool",
            "market"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          },
          "relations": [
            "position"
          ]
        },
        {
          "name": "market",
          "relations": [
            "oracle",
            "position"
          ]
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "poolMarket",
          "writable": true
        },
        {
          "name": "nonceRecord",
          "docs": [
            "Closed here (rent to `rent_recipient`, i.e. the buyer). Replay safety",
            "argument is identical to `SettlePoolPosition::nonce_record`'s own doc",
            "comment: this instruction also only runs once `now >= market.expiry`",
            "(via the settlement-window deadline check below, which is itself",
            "`>= market.expiry`), strictly after `quote.quote_expiry` could ever",
            "again satisfy `fill_pool_quote`'s expiry check, so replaying the",
            "original signed quote fails closed with `QuoteExpired` regardless of",
            "whether this PDA still exists."
          ],
          "writable": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "nonceRecord"
              }
            ]
          }
        },
        {
          "name": "positionVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "settlementMint",
          "relations": [
            "pool",
            "market",
            "position"
          ]
        },
        {
          "name": "buyerDestination",
          "writable": true
        },
        {
          "name": "poolToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "rentRecipient",
          "docs": [
            "must be the buyer stored in the position."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "setEligibility",
      "discriminator": [
        101,
        95,
        132,
        213,
        175,
        252,
        123,
        46
      ],
      "accounts": [
        {
          "name": "eligibilityAuthority",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "eligibility",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  108,
                  105,
                  103,
                  105,
                  98,
                  105,
                  108,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "arg",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wallet",
          "type": "pubkey"
        },
        {
          "name": "canTrade",
          "type": "bool"
        },
        {
          "name": "expiresAt",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setLiquidityPoolMarket",
      "discriminator": [
        251,
        195,
        253,
        78,
        124,
        209,
        8,
        155
      ],
      "accounts": [
        {
          "name": "manager",
          "writable": true,
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool",
            "market"
          ]
        },
        {
          "name": "pool",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "pool.settlement_mint",
                "account": "liquidityPool"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          }
        },
        {
          "name": "market"
        },
        {
          "name": "poolMarket",
          "docs": [
            "`init_if_needed` sugar -- see the handler's own doc comment for why",
            "(that sugar's automatic `space == data_len()` equality check would",
            "hard-reject every pre-existing, legacy 82-byte `LiquidityPoolMarket`",
            "once the struct grew by `OpenPositionCount`'s 4 bytes). `seeds =`/",
            "`bump` here still fully authenticates the address -- an account can",
            "only ever exist at this exact PDA if THIS program created it (via",
            "`invoke_signed` with these same seeds), or it doesn't exist yet",
            "(owned by the System Program) -- the handler checks and handles",
            "both cases explicitly."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "setLiquidityPoolMarketArgs"
            }
          }
        }
      ]
    },
    {
      "name": "setMarketEnabled",
      "discriminator": [
        206,
        60,
        159,
        159,
        62,
        242,
        4,
        82
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "enabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setPause",
      "discriminator": [
        63,
        32,
        154,
        2,
        56,
        103,
        79,
        45
      ],
      "accounts": [
        {
          "name": "pauseAuthority",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "settlePoolPosition",
      "discriminator": [
        164,
        179,
        145,
        132,
        164,
        176,
        104,
        30
      ],
      "accounts": [
        {
          "name": "cranker",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool",
            "market"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          },
          "relations": [
            "position"
          ]
        },
        {
          "name": "market",
          "relations": [
            "oracle",
            "position"
          ]
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "poolMarket",
          "writable": true
        },
        {
          "name": "nonceRecord",
          "docs": [
            "Closed here (rent to `rent_recipient`, i.e. the buyer -- see that",
            "field's own doc comment) rather than left to rot forever. Replay",
            "safety: `fill_pool_quote` only accepts a quote while",
            "`now <= quote.quote_expiry < market.expiry`, and this instruction only",
            "runs once `now >= market.expiry`, so by the time the nonce PDA",
            "disappears the exact ed25519-signed `PoolQuoteArgs` (nonce included)",
            "that created it can never satisfy `fill_pool_quote`'s own expiry check",
            "again -- an attacker cannot forge a fresh `quote_expiry` without",
            "invalidating the signature. Re-submitting the original signed quote",
            "therefore fails closed with `QuoteExpired`, PDA or no PDA. Proven by",
            "`settle_pool_position_closes_nonce_and_original_quote_cannot_replay`.",
            "`close_pool_position` (early close, before expiry) must NOT do this:",
            "the quote can still be unexpired there, so closing the nonce would let",
            "the same signed quote be filled a second time once the PDA is gone."
          ],
          "writable": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "nonceRecord"
              }
            ]
          }
        },
        {
          "name": "positionVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "settlementMint",
          "relations": [
            "pool",
            "market",
            "position"
          ]
        },
        {
          "name": "buyerDestination",
          "writable": true
        },
        {
          "name": "poolToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "treasuryDestination",
          "docs": [
            "When `config.treasury_owner` is the position's own buyer,",
            "`buyer_destination` and `treasury_destination` are the exact same",
            "token account. Anchor 1.0.2/1.1.2's generated `try_accounts` collects",
            "every `mut` field that (a) is not marked `dup` and (b) serializes on",
            "`exit()` (see `anchor-syn`'s `generate_duplicate_mutable_checks` and",
            "`AccountsExit` impls) into a `HashSet`, erroring",
            "`ConstraintDuplicateMutableAccount` if any two collide -- this exists",
            "to stop the classic double-write bug where two `Account<'info, T>`",
            "views of the same address each independently re-serialize their own",
            "(possibly divergent) copy of the account's data on exit, and the",
            "second write silently clobbers the first.",
            "`dup` here is exactly the intended escape hatch for a case that bug",
            "cannot occur in: `TokenAccount`'s owning program is the SPL Token",
            "program, not this one, so `Account<'info, TokenAccount>::exit()`",
            "(see `exit_with_expected_owner`) is a complete no-op for it --  this",
            "program's mutations to `treasury_destination`'s and",
            "`buyer_destination`'s balances only ever happen via CPI `transfer_checked`,",
            "which writes the real on-chain bytes directly, not through Anchor's",
            "in-memory struct. Two `Account<TokenAccount>` handles aliasing the",
            "same address therefore cannot diverge or clobber each other; `dup`",
            "only tells Anchor's constraint pass that, it changes no runtime",
            "behavior. Validation the duplicate check would otherwise have",
            "provided nothing towards anyway (token-program ownership, correct",
            "mint, correct token owner) is fully carried by `token::mint =` and",
            "the `owner ==` constraint above regardless of aliasing. See",
            "`settle_pool_position`'s handler for the matching transfer logic",
            "(folds into one CPI instead of two when the keys are equal)."
          ],
          "writable": true
        },
        {
          "name": "rentRecipient",
          "docs": [
            "-- see `nonce_record`'s doc comment -- the closed nonce's rent too)",
            "and must be the buyer stored in the position."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "updateConfig",
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "updateConfigArgs"
            }
          }
        }
      ]
    },
    {
      "name": "updateCustomPriceFeed",
      "docs": [
        "Called every pusher tick to refresh `CustomPriceFeed`. The signer",
        "must equal `config.oracle_authority` -- see that account's doc",
        "comment for the full trust-model disclosure this check is the whole",
        "of."
      ],
      "discriminator": [
        216,
        177,
        206,
        143,
        69,
        217,
        255,
        16
      ],
      "accounts": [
        {
          "name": "oracleAuthority",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  115,
                  116,
                  111,
                  109,
                  45,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "feed.symbol",
                "account": "customPriceFeed"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "confidence",
          "type": "u64"
        },
        {
          "name": "observedAt",
          "type": "i64"
        }
      ]
    },
    {
      "name": "updateLiquidityPool",
      "docs": [
        "Updates a liquidity pool's risk configuration. Split into an",
        "immediate path for LP-safe tightening and a timelocked path for",
        "everything else, because pool creation is permissionless -- a",
        "pool's `manager` is an untrusted role, not an insider. Before this",
        "split, a manager could raise `max_utilization_bps` to 100% and",
        "rotate `quote_authority` to a key they control in a single",
        "instruction with zero notice, then self-sign a `fill_pool_quote`",
        "for (almost) the whole pool and extract it via `close_pool_position`",
        "in the same transaction. `MAX_POOL_UTILIZATION_BPS` closes the",
        "\"whole pool in one fill\" half of that; this timelock closes the",
        "\"zero notice\" half, which is the half that actually matters --",
        "see `POOL_UPDATE_TIMELOCK_SECONDS`.",
        "",
        "- Lowering `max_utilization_bps` and/or `max_position_bps`, with",
        "`quote_authority` left unchanged, applies immediately in this same",
        "instruction: it can only shrink what the pool is exposed to, so LPs",
        "never need advance notice of their own protection getting stricter.",
        "- Anything else -- raising either cap above its current value, or",
        "rotating `quote_authority` at all, even alongside a lowered cap --",
        "is recorded as a pending change (`pending_*` fields) with",
        "`pending_effective_at = now + POOL_UPDATE_TIMELOCK_SECONDS`, and an",
        "`LiquidityPoolUpdateProposed` event carrying `effective_at` so LPs",
        "and indexers can observe it and choose to withdraw. Nothing about",
        "the pool's *live*, currently-effective configuration changes until",
        "`apply_liquidity_pool_update` commits it. `cancel_pending_pool_update`",
        "lets the manager clear a mistaken proposal before that.",
        "",
        "RESIDUAL HOLE (documented, not fixed here): both this instruction and",
        "`apply_liquidity_pool_update` require the pool be idle",
        "(`open_positions == 0 && locked_collateral == 0`), the same gate",
        "`withdraw_liquidity` uses. During the timelock window a malicious",
        "manager can self-sign a `fill_pool_quote` to open a position, which",
        "blocks LP withdrawals for as long as it stays open, then close it",
        "again right before calling `apply_liquidity_pool_update` (which also",
        "requires idle). This does not make the window unbounded -- returning",
        "the pool to idle to apply the change is itself observable and gives",
        "LPs another chance to react between \"position closed\" and \"update",
        "applied\" -- but it is not guaranteed to give LPs a long clear window",
        "either. The complete fix is letting LPs withdraw *unlocked* capital",
        "while positions remain open, which is a larger redesign of",
        "`withdraw_liquidity`'s idle gate than this pass makes, and remains",
        "the right next step before real money."
      ],
      "discriminator": [
        255,
        60,
        178,
        169,
        154,
        62,
        55,
        243
      ],
      "accounts": [
        {
          "name": "manager",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "pool.settlement_mint",
                "account": "liquidityPool"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "updateLiquidityPoolArgs"
            }
          }
        }
      ]
    },
    {
      "name": "withdrawLiquidity",
      "discriminator": [
        149,
        158,
        33,
        185,
        47,
        243,
        253,
        31
      ],
      "accounts": [
        {
          "name": "provider",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          },
          "relations": [
            "pool"
          ]
        },
        {
          "name": "settlementMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              },
              {
                "kind": "account",
                "path": "pool.pool_id",
                "account": "liquidityPool"
              }
            ]
          },
          "relations": [
            "providerPosition"
          ]
        },
        {
          "name": "poolToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "providerPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "provider"
              }
            ]
          }
        },
        {
          "name": "providerDestination",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        },
        {
          "name": "minAmountOut",
          "type": "u64"
        },
        {
          "name": "deadline",
          "type": "i64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "customPriceFeed",
      "discriminator": [
        149,
        188,
        117,
        83,
        50,
        81,
        52,
        72
      ]
    },
    {
      "name": "customSettlementObservation",
      "discriminator": [
        171,
        39,
        252,
        232,
        120,
        205,
        2,
        119
      ]
    },
    {
      "name": "eligibility",
      "discriminator": [
        53,
        74,
        180,
        116,
        197,
        25,
        67,
        67
      ]
    },
    {
      "name": "liquidityPool",
      "discriminator": [
        66,
        38,
        17,
        64,
        188,
        80,
        68,
        129
      ]
    },
    {
      "name": "liquidityPoolMarket",
      "discriminator": [
        38,
        196,
        188,
        199,
        242,
        89,
        154,
        113
      ]
    },
    {
      "name": "liquidityProvider",
      "discriminator": [
        219,
        241,
        238,
        133,
        56,
        225,
        229,
        191
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    },
    {
      "name": "poolPosition",
      "discriminator": [
        246,
        13,
        238,
        156,
        119,
        129,
        253,
        135
      ]
    },
    {
      "name": "poolQuoteNonce",
      "discriminator": [
        24,
        11,
        175,
        255,
        135,
        37,
        170,
        6
      ]
    },
    {
      "name": "settlementOracle",
      "discriminator": [
        197,
        182,
        115,
        121,
        5,
        199,
        205,
        249
      ]
    }
  ],
  "events": [
    {
      "name": "adminAccepted",
      "discriminator": [
        174,
        12,
        76,
        139,
        158,
        99,
        110,
        254
      ]
    },
    {
      "name": "adminNominated",
      "discriminator": [
        22,
        247,
        53,
        33,
        59,
        59,
        68,
        112
      ]
    },
    {
      "name": "configInitialized",
      "discriminator": [
        181,
        49,
        200,
        156,
        19,
        167,
        178,
        91
      ]
    },
    {
      "name": "configUpdated",
      "discriminator": [
        40,
        241,
        230,
        122,
        11,
        19,
        198,
        194
      ]
    },
    {
      "name": "customPriceFeedUpdated",
      "discriminator": [
        128,
        191,
        210,
        106,
        72,
        168,
        156,
        168
      ]
    },
    {
      "name": "customSettlementPublished",
      "discriminator": [
        78,
        56,
        135,
        154,
        187,
        2,
        76,
        108
      ]
    },
    {
      "name": "eligibilityUpdated",
      "discriminator": [
        127,
        138,
        171,
        143,
        122,
        5,
        217,
        178
      ]
    },
    {
      "name": "liquidityDeposited",
      "discriminator": [
        218,
        155,
        74,
        193,
        59,
        66,
        94,
        122
      ]
    },
    {
      "name": "liquidityPoolInitialized",
      "discriminator": [
        116,
        81,
        252,
        86,
        124,
        191,
        134,
        172
      ]
    },
    {
      "name": "liquidityPoolMarketUpdated",
      "discriminator": [
        149,
        60,
        78,
        15,
        27,
        254,
        225,
        36
      ]
    },
    {
      "name": "liquidityPoolUpdateCancelled",
      "discriminator": [
        100,
        173,
        9,
        54,
        104,
        220,
        248,
        69
      ]
    },
    {
      "name": "liquidityPoolUpdateProposed",
      "discriminator": [
        132,
        219,
        43,
        236,
        198,
        107,
        180,
        255
      ]
    },
    {
      "name": "liquidityPoolUpdated",
      "discriminator": [
        127,
        207,
        196,
        210,
        214,
        37,
        235,
        177
      ]
    },
    {
      "name": "liquidityWithdrawn",
      "discriminator": [
        240,
        120,
        73,
        139,
        154,
        31,
        218,
        68
      ]
    },
    {
      "name": "marketClosed",
      "discriminator": [
        86,
        91,
        119,
        43,
        94,
        0,
        217,
        113
      ]
    },
    {
      "name": "marketCreated",
      "discriminator": [
        88,
        184,
        130,
        231,
        226,
        84,
        6,
        58
      ]
    },
    {
      "name": "marketEnabled",
      "discriminator": [
        63,
        128,
        245,
        222,
        253,
        172,
        186,
        84
      ]
    },
    {
      "name": "pauseUpdated",
      "discriminator": [
        203,
        203,
        33,
        225,
        130,
        103,
        90,
        105
      ]
    },
    {
      "name": "poolPositionClosedEarly",
      "discriminator": [
        79,
        3,
        229,
        97,
        6,
        52,
        251,
        141
      ]
    },
    {
      "name": "poolPositionRefunded",
      "discriminator": [
        25,
        37,
        54,
        232,
        212,
        43,
        5,
        170
      ]
    },
    {
      "name": "poolPositionSettled",
      "discriminator": [
        38,
        126,
        128,
        22,
        65,
        214,
        86,
        111
      ]
    },
    {
      "name": "poolQuoteFilled",
      "discriminator": [
        251,
        24,
        254,
        231,
        157,
        75,
        172,
        26
      ]
    },
    {
      "name": "settlementPublished",
      "discriminator": [
        189,
        71,
        10,
        187,
        160,
        237,
        134,
        134
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "protocolPaused",
      "msg": "The protocol is paused."
    },
    {
      "code": 6001,
      "name": "unauthorized",
      "msg": "The signer is not authorized."
    },
    {
      "code": 6002,
      "name": "invalidAuthority",
      "msg": "An authority cannot be the default public key."
    },
    {
      "code": 6003,
      "name": "feeTooHigh",
      "msg": "The protocol fee is above the configured maximum."
    },
    {
      "code": 6004,
      "name": "invalidExpiry",
      "msg": "The market expiry is invalid."
    },
    {
      "code": 6005,
      "name": "invalidObservationWindow",
      "msg": "The observation window is invalid."
    },
    {
      "code": 6006,
      "name": "invalidSettlementGrace",
      "msg": "The settlement grace period is invalid."
    },
    {
      "code": 6007,
      "name": "invalidSettlementStaleness",
      "msg": "The maximum settlement staleness is invalid."
    },
    {
      "code": 6008,
      "name": "invalidConfidence",
      "msg": "The confidence threshold is invalid."
    },
    {
      "code": 6009,
      "name": "invalidSymbol",
      "msg": "The symbol is empty."
    },
    {
      "code": 6010,
      "name": "invalidPriceScale",
      "msg": "The market price scale must be positive."
    },
    {
      "code": 6011,
      "name": "invalidPythFeed",
      "msg": "The Pyth feed identifier is invalid."
    },
    {
      "code": 6012,
      "name": "invalidPythPriceUpdate",
      "msg": "The Pyth price update is invalid, stale, or insufficiently verified."
    },
    {
      "code": 6013,
      "name": "invalidPythExponent",
      "msg": "The Pyth exponent cannot be represented safely."
    },
    {
      "code": 6014,
      "name": "invalidUnderlyingMint",
      "msg": "The underlying mint cannot be the default public key."
    },
    {
      "code": 6015,
      "name": "invalidMarketId",
      "msg": "The market id does not match the deterministic hash of its parameters."
    },
    {
      "code": 6016,
      "name": "invalidAmount",
      "msg": "The amount must be positive."
    },
    {
      "code": 6017,
      "name": "invalidWidth",
      "msg": "The payout width must be positive."
    },
    {
      "code": 6018,
      "name": "invalidDirection",
      "msg": "The direction must be up or down."
    },
    {
      "code": 6019,
      "name": "mathOverflow",
      "msg": "A checked arithmetic operation failed."
    },
    {
      "code": 6020,
      "name": "marketDisabled",
      "msg": "The market is disabled."
    },
    {
      "code": 6021,
      "name": "marketExpired",
      "msg": "The market has expired."
    },
    {
      "code": 6022,
      "name": "marketNotExpired",
      "msg": "The market has not expired."
    },
    {
      "code": 6023,
      "name": "quoteExpired",
      "msg": "The maker quote has expired."
    },
    {
      "code": 6024,
      "name": "missingMakerSignature",
      "msg": "The maker signature instruction is missing."
    },
    {
      "code": 6025,
      "name": "invalidMakerSignature",
      "msg": "The maker signature or signed quote message is invalid."
    },
    {
      "code": 6026,
      "name": "insufficientWriterLiquidity",
      "msg": "The writer does not have enough available collateral."
    },
    {
      "code": 6027,
      "name": "collateralMismatch",
      "msg": "Escrow does not exactly equal premium plus maximum payout."
    },
    {
      "code": 6028,
      "name": "eligibilityRequired",
      "msg": "An eligibility account is required."
    },
    {
      "code": 6029,
      "name": "invalidEligibility",
      "msg": "The eligibility account is invalid."
    },
    {
      "code": 6030,
      "name": "ineligibleWallet",
      "msg": "The wallet is not eligible to trade."
    },
    {
      "code": 6031,
      "name": "invalidMarket",
      "msg": "The market account is invalid."
    },
    {
      "code": 6032,
      "name": "invalidOracle",
      "msg": "The oracle account is invalid."
    },
    {
      "code": 6033,
      "name": "oracleAlreadyFinalized",
      "msg": "The settlement oracle is already finalized."
    },
    {
      "code": 6034,
      "name": "oracleNotFinalized",
      "msg": "The settlement oracle is not finalized."
    },
    {
      "code": 6035,
      "name": "invalidOraclePrice",
      "msg": "The oracle price is invalid."
    },
    {
      "code": 6036,
      "name": "invalidObservationTime",
      "msg": "The oracle observation timestamp is outside the approved window."
    },
    {
      "code": 6037,
      "name": "settlementWindowClosed",
      "msg": "The settlement publication window is closed."
    },
    {
      "code": 6038,
      "name": "oracleConfidenceTooWide",
      "msg": "The oracle confidence interval is too wide."
    },
    {
      "code": 6039,
      "name": "settlementWindowOpen",
      "msg": "The settlement fallback window is still open."
    },
    {
      "code": 6040,
      "name": "invalidPosition",
      "msg": "The position is invalid."
    },
    {
      "code": 6041,
      "name": "positionNotOpen",
      "msg": "The position is not open."
    },
    {
      "code": 6042,
      "name": "invalidNonce",
      "msg": "The quote nonce record is invalid."
    },
    {
      "code": 6043,
      "name": "invalidDestination",
      "msg": "A settlement destination token account is invalid."
    },
    {
      "code": 6044,
      "name": "poolHasOpenPositions",
      "msg": "The liquidity pool has active collateral obligations."
    },
    {
      "code": 6045,
      "name": "invalidPoolShares",
      "msg": "The liquidity pool share amount is invalid."
    },
    {
      "code": 6046,
      "name": "poolInsolvent",
      "msg": "The liquidity pool has no assets backing outstanding shares."
    },
    {
      "code": 6047,
      "name": "depositTooSmall",
      "msg": "The deposit or withdrawal is too small after conservative rounding."
    },
    {
      "code": 6048,
      "name": "slippageExceeded",
      "msg": "The requested minimum output was not met."
    },
    {
      "code": 6049,
      "name": "deadlineExpired",
      "msg": "The transaction deadline has expired."
    },
    {
      "code": 6050,
      "name": "invalidPoolRiskLimits",
      "msg": "The liquidity pool risk limits are invalid."
    },
    {
      "code": 6051,
      "name": "poolMarketDisabled",
      "msg": "The liquidity pool is not enabled for this market."
    },
    {
      "code": 6052,
      "name": "invalidLastTradeCutoff",
      "msg": "The market's last-trade cutoff is invalid."
    },
    {
      "code": 6053,
      "name": "lastTradeCutoffReached",
      "msg": "The market's last-trade cutoff has been reached."
    },
    {
      "code": 6054,
      "name": "poolUtilizationExceeded",
      "msg": "The liquidity pool utilization limit would be exceeded."
    },
    {
      "code": 6055,
      "name": "poolPositionLimitExceeded",
      "msg": "The position exceeds the liquidity pool's per-position risk limit."
    },
    {
      "code": 6056,
      "name": "buybackExceedsMaxPayout",
      "msg": "The buyback amount cannot exceed the position's maximum payout."
    },
    {
      "code": 6057,
      "name": "marketNotCloseable",
      "msg": "The market cannot be closed yet: its settlement window has not fully elapsed, or its pool authorization is still enabled."
    },
    {
      "code": 6058,
      "name": "invalidPoolMarket",
      "msg": "The supplied pool/pool-market pair is invalid or inconsistent."
    },
    {
      "code": 6059,
      "name": "noPendingPoolUpdate",
      "msg": "There is no pending liquidity pool update to apply or cancel."
    },
    {
      "code": 6060,
      "name": "poolUpdateTimelocked",
      "msg": "The pending liquidity pool update's timelock has not yet elapsed."
    },
    {
      "code": 6061,
      "name": "invalidStrike",
      "msg": "The market strike must be positive."
    },
    {
      "code": 6062,
      "name": "customFeedNotYetFresh",
      "msg": "The custom price feed has not yet updated past this market's expiry."
    },
    {
      "code": 6063,
      "name": "customFeedStale",
      "msg": "The custom price feed has not updated recently enough to settle with."
    },
    {
      "code": 6064,
      "name": "customFeedFromFuture",
      "msg": "The custom price feed timestamp is in the future."
    },
    {
      "code": 6065,
      "name": "customFeedTimestampNotIncreasing",
      "msg": "The custom price feed timestamp must increase strictly."
    }
  ],
  "types": [
    {
      "name": "adminAccepted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "adminNominated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          },
          {
            "name": "pauseAuthority",
            "type": "pubkey"
          },
          {
            "name": "oracleAuthority",
            "type": "pubkey"
          },
          {
            "name": "eligibilityAuthority",
            "type": "pubkey"
          },
          {
            "name": "treasuryOwner",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "eligibilityRequired",
            "type": "bool"
          },
          {
            "name": "domainSeparator",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "domainVersion",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "configInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "configUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "domainVersion",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "createMarketArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "underlyingMint",
            "type": "pubkey"
          },
          {
            "name": "symbol",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "priceScale",
            "type": "u64"
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "observationWindowSeconds",
            "type": "u32"
          },
          {
            "name": "settlementGraceSeconds",
            "type": "u32"
          },
          {
            "name": "maxConfidenceBps",
            "type": "u16"
          },
          {
            "name": "pythFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxSettlementStalenessSeconds",
            "type": "u32"
          },
          {
            "name": "strike",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "customPriceFeed",
      "docs": [
        "A centrally-sourced backup/demo settlement price feed, one per `symbol`",
        "(seeded off `market.symbol`, not `market.pyth_feed_id`, so it is shared",
        "across every expiry/rung of the same underlying and kept in its own",
        "namespace independent of Pyth's). It exists so the product can still",
        "settle expired markets when Pyth access is unavailable -- see",
        "`publish_custom_settlement`.",
        "",
        "Be honest about the tradeoff this is: unlike `SettlementOracle` when",
        "populated via `publish_pyth_settlement`, a price written here is NOT",
        "cryptographically verified by any independent oracle network. Its entire",
        "trust model is the signer check in `update_custom_price_feed` -- whoever",
        "holds `config.oracle_authority`'s key can write any price into this",
        "account. That is intentional, disclosed centralization -- a deliberate",
        "short-term fallback while Pyth access is unavailable, not something this",
        "comment is trying to obscure."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "symbol",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "priceScale",
            "type": "u64"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "confidence",
            "type": "u64"
          },
          {
            "name": "publishedAt",
            "type": "i64"
          },
          {
            "name": "publisher",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "customPriceFeedUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feed",
            "type": "pubkey"
          },
          {
            "name": "symbol",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "confidence",
            "type": "u64"
          },
          {
            "name": "publishedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "customSettlementObservation",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "symbol",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "observationWindowSeconds",
            "type": "u32"
          },
          {
            "name": "priceScale",
            "type": "u64"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "confidence",
            "type": "u64"
          },
          {
            "name": "observedAt",
            "type": "i64"
          },
          {
            "name": "capturedAt",
            "type": "i64"
          },
          {
            "name": "feed",
            "type": "pubkey"
          },
          {
            "name": "publisher",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "customSettlementPublished",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "confidence",
            "type": "u64"
          },
          {
            "name": "publishedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "eligibility",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "canTrade",
            "type": "bool"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "eligibilityUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "canTrade",
            "type": "bool"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "initializeConfigArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pauseAuthority",
            "type": "pubkey"
          },
          {
            "name": "oracleAuthority",
            "type": "pubkey"
          },
          {
            "name": "eligibilityAuthority",
            "type": "pubkey"
          },
          {
            "name": "treasuryOwner",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "eligibilityRequired",
            "type": "bool"
          },
          {
            "name": "domainSeparator",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "initializeLiquidityPoolArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "poolId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "quoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "maxUtilizationBps",
            "type": "u16"
          },
          {
            "name": "maxPositionBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "liquidityDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "liquidityPool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "tokenBump",
            "type": "u8"
          },
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "settlementMint",
            "type": "pubkey"
          },
          {
            "name": "quoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "poolId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "totalShares",
            "type": "u64"
          },
          {
            "name": "lockedCollateral",
            "type": "u64"
          },
          {
            "name": "openPositions",
            "type": "u64"
          },
          {
            "name": "cumulativePremium",
            "type": "u64"
          },
          {
            "name": "cumulativePayout",
            "type": "u64"
          },
          {
            "name": "maxUtilizationBps",
            "type": "u16"
          },
          {
            "name": "maxPositionBps",
            "type": "u16"
          },
          {
            "name": "manager",
            "type": "pubkey"
          },
          {
            "name": "pendingQuoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "pendingMaxUtilizationBps",
            "type": "u16"
          },
          {
            "name": "pendingMaxPositionBps",
            "type": "u16"
          },
          {
            "name": "pendingEffectiveAt",
            "type": "i64"
          },
          {
            "name": "totalAssets",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "liquidityPoolInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "settlementMint",
            "type": "pubkey"
          },
          {
            "name": "quoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "manager",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "liquidityPoolMarket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "lastTradeAt",
            "type": "i64"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "openPositions",
            "type": {
              "defined": {
                "name": "openPositionCount"
              }
            }
          }
        ]
      }
    },
    {
      "name": "liquidityPoolMarketUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "lastTradeAt",
            "type": "i64"
          },
          {
            "name": "enabled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "liquidityPoolUpdateCancelled",
      "docs": [
        "Emitted by `cancel_pending_pool_update` when a manager discards a pending",
        "proposal before its timelock elapses."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "liquidityPoolUpdateProposed",
      "docs": [
        "Emitted by `update_liquidity_pool` whenever a change is timelocked rather",
        "than applied immediately (raising a cap, or rotating `quote_authority`).",
        "Carries `effective_at` so LPs and indexers can observe a pending change",
        "and its deadline -- the timelock is worthless as a defense if nobody can",
        "see it coming. See `POOL_UPDATE_TIMELOCK_SECONDS`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "pendingQuoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "pendingMaxUtilizationBps",
            "type": "u16"
          },
          {
            "name": "pendingMaxPositionBps",
            "type": "u16"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "liquidityPoolUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "quoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "maxUtilizationBps",
            "type": "u16"
          },
          {
            "name": "maxPositionBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "liquidityProvider",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "totalDeposited",
            "type": "u64"
          },
          {
            "name": "totalWithdrawn",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "liquidityWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "market",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "underlyingMint",
            "type": "pubkey"
          },
          {
            "name": "settlementMint",
            "type": "pubkey"
          },
          {
            "name": "oracle",
            "type": "pubkey"
          },
          {
            "name": "symbol",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "priceScale",
            "type": "u64"
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "observationWindowSeconds",
            "type": "u32"
          },
          {
            "name": "settlementGraceSeconds",
            "type": "u32"
          },
          {
            "name": "maxConfidenceBps",
            "type": "u16"
          },
          {
            "name": "pythFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "settlementDecimals",
            "type": "u8"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "maxSettlementStalenessSeconds",
            "type": "u32"
          },
          {
            "name": "strike",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "marketClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "marketCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "settlementMint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "marketEnabled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "enabled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "openPositionCount",
      "type": {
        "kind": "type",
        "alias": "u32"
      }
    },
    {
      "name": "pauseUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "poolBuybackArgs",
      "docs": [
        "A one-shot, pool-`quote_authority`-signed offer to buy back an open pool",
        "position before expiry. `buyback_amount` is what the pool pays the buyer;",
        "`min_proceeds` is the buyer's slippage guard, bound into the same signed",
        "message so it can't be tampered with independently of `buyback_amount`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "buybackAmount",
            "type": "u64"
          },
          {
            "name": "minProceeds",
            "type": "u64"
          },
          {
            "name": "quoteExpiry",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "poolPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "direction",
            "type": "u8"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "nonceRecord",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "quoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "settlementMint",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "strike",
            "type": "u64"
          },
          {
            "name": "width",
            "type": "u64"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "maxPayout",
            "type": "u64"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "openedAt",
            "type": "i64"
          },
          {
            "name": "quoteExpiry",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "poolPositionClosedEarly",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "buybackAmount",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "poolAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolPositionRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "collateral",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolPositionSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "settlementPrice",
            "type": "u64"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "poolAmount",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolQuoteArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "direction",
            "type": "u8"
          },
          {
            "name": "strike",
            "type": "u64"
          },
          {
            "name": "width",
            "type": "u64"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "maxPayout",
            "type": "u64"
          },
          {
            "name": "quoteExpiry",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "poolQuoteFilled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "quoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "maxPayout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolQuoteNonce",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "quoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "position",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "setLiquidityPoolMarketArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lastTradeAt",
            "type": "i64"
          },
          {
            "name": "enabled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "settlementOracle",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "confidence",
            "type": "u64"
          },
          {
            "name": "observedAt",
            "type": "i64"
          },
          {
            "name": "publishedAt",
            "type": "i64"
          },
          {
            "name": "priceUpdate",
            "type": "pubkey"
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "finalized",
            "type": "bool"
          },
          {
            "name": "settledFromStalePrice",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "settlementPublished",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "confidence",
            "type": "u64"
          },
          {
            "name": "observedAt",
            "type": "i64"
          },
          {
            "name": "priceUpdate",
            "type": "pubkey"
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "settledFromStalePrice",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "updateConfigArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pauseAuthority",
            "type": "pubkey"
          },
          {
            "name": "oracleAuthority",
            "type": "pubkey"
          },
          {
            "name": "eligibilityAuthority",
            "type": "pubkey"
          },
          {
            "name": "treasuryOwner",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "eligibilityRequired",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "updateLiquidityPoolArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "quoteAuthority",
            "type": "pubkey"
          },
          {
            "name": "maxUtilizationBps",
            "type": "u16"
          },
          {
            "name": "maxPositionBps",
            "type": "u16"
          }
        ]
      }
    }
  ]
};
