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
      "name": "burnCompleteSet",
      "docs": [
        "Burns `amount` of BOTH the UP and DOWN conditional tokens and returns",
        "`amount` collateral from the vault. This is the arbitrage that keeps",
        "UP + DOWN priced at ~1 unit of collateral, so it must work identically",
        "before AND after settlement -- it is deliberately never gated on",
        "`oracle.finalized` in either direction.",
        "",
        "Guardian: like `settle`/`close_pool_position`, this is a holder's exit",
        "path, so -- unlike `mint_complete_set` -- it must keep working even",
        "while the protocol is paused. Deliberately NOT gated on",
        "`config.paused`."
      ],
      "discriminator": [
        183,
        36,
        119,
        130,
        123,
        198,
        110,
        211
      ],
      "accounts": [
        {
          "name": "burner",
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
          "name": "market"
        },
        {
          "name": "settlementMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "upMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  112,
                  45,
                  109,
                  105,
                  110,
                  116
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
          "name": "downMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  119,
                  110,
                  45,
                  109,
                  105,
                  110,
                  116
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
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  115,
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
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "burnerUpToken",
          "writable": true
        },
        {
          "name": "burnerDownToken",
          "writable": true
        },
        {
          "name": "burnerDestination",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "cancelNonce",
      "discriminator": [
        75,
        133,
        88,
        103,
        81,
        209,
        139,
        141
      ],
      "accounts": [
        {
          "name": "maker",
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
          "name": "nonceRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "arg",
                "path": "nonce"
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
          "name": "nonce",
          "type": "u64"
        }
      ]
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
        "2. `fill_quote` and `fill_pool_quote` both hard-require",
        "`now < market.expiry` before opening a new position. Since the",
        "deadline above is strictly after `expiry`, by the time it has",
        "elapsed no new writer- or pool-backed position can ever be opened",
        "against this market again, full stop -- this holds independently",
        "of `market.enabled`/`pool_market.enabled`, which are therefore not",
        "load-bearing for \"no new obligations\": that is already guaranteed",
        "by the expiry check those two instructions perform themselves.",
        "3. The one obligation this instruction *cannot* cheaply verify",
        "on-chain is \"no already-open `Position`/`PoolPosition` still",
        "references this market\". Those are independent PDAs keyed by",
        "nonce record (not by market), so there is no bounded on-chain",
        "enumeration of \"every position that ever referenced this market\"",
        "-- unlike the pool-authorization case below, which is a single",
        "fixed-address PDA per (pool, market) pair. If an open position",
        "were left unsettled/unrefunded, closing the market would strand it",
        "forever: `settle`, `settle_pool_position`, `refund_unsettled`, and",
        "`refund_pool_position` all load the `Market` account via `has_one`",
        "and would simply fail once that account no longer exists, with no",
        "way to ever recover the position's escrowed funds.",
        "==> OFF-CHAIN ASSUMPTION (required, not enforced by this",
        "instruction): the caller -- the off-chain cleaner -- must confirm",
        "every `Position` and `PoolPosition` that ever referenced this",
        "market has already been settled or refunded (its vault closed)",
        "before calling `close_settled_market`. This is the documented gap",
        "the task that added this instruction explicitly flagged and",
        "accepted, given positions are not cheaply enumerable on-chain.",
        "`MARKET_CLEANUP_BUFFER_SECONDS` bounds the damage when that",
        "assumption is violated (a stranded position stays refundable for a",
        "week after settlement closes) but does NOT discharge it: a caller",
        "that closes a market with an open position still strands it",
        "permanently. Enumerating positions on-chain -- e.g. an",
        "`open_position_count` on `Market`, maintained by fill/settle/refund",
        "-- is the only way to actually enforce this, and remains the right",
        "fix before real money.",
        "4. UNLIKE point 3, the conditional-token (\"complete set\") collateral",
        "vault IS cheaply, fully enumerable from the market alone: it is a",
        "single deterministic PDA (`COMPLETE_SET_VAULT_SEED`, keyed only by",
        "`market.key()`), not a per-nonce record like `Position`/",
        "`PoolPosition`. `burn_complete_set` and `redeem_winning` both load",
        "`market: Box<Account<'info, Market>>`, so once this account is",
        "closed neither can ever execute again -- any balance still in the",
        "vault at that point is unrecoverable forever. Because this check",
        "IS cheap, it is a HARD on-chain requirement, not an off-chain",
        "assumption like point 3: the handler requires the vault to be",
        "either never created (nobody ever called `mint_complete_set`",
        "against this market) or fully drained (`amount == 0`) before",
        "allowing the close. See `CloseSettledMarket::collateral_vault`'s",
        "own doc comment for why checking the vault balance alone --",
        "without also inspecting `up_mint`/`down_mint` supply -- is",
        "sufficient.",
        "5. As a cheap, *additional* on-chain check (defense-in-depth, not the",
        "primary safety argument above, which already holds regardless): if",
        "the caller passes a `pool`/`pool_market` pair, it must be the",
        "authorization record for *this* market and pool, and it must have",
        "`enabled == false`. Passing `None` for both is accepted (an",
        "omitted pair is not proof no pool was ever authorized, but no",
        "cheaper on-chain check exists -- see point 3).",
        "6. Permission: the caller must be `market.creator` or `config.admin`.",
        "Rent always returns to `market.creator` (`rent_recipient` is",
        "address-constrained to it), never to an arbitrary caller-supplied",
        "account.",
        "7. Deliberately *not* gated on `config.paused`: this is maintenance",
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
          "name": "collateralVault",
          "docs": [
            "vault PDA by `seeds =`/`bump`, so a caller can neither omit it nor",
            "substitute a different (e.g. always-empty) account to dodge the",
            "balance check in the handler. Deliberately an `UncheckedAccount`, not",
            "`Box<Account<'info, TokenAccount>>` like `BurnCompleteSet`/",
            "`RedeemWinning`'s own `collateral_vault`: THIS vault may legitimately",
            "never have been created at all (a market nobody ever called",
            "`mint_complete_set` against), and `Account<TokenAccount>`",
            "deserialization fails closed on an empty/uninitialized account with",
            "no `init_if_needed` escape hatch available on a `close`-adjacent",
            "read-only check. The handler distinguishes \"never created\" (empty",
            "account data) from \"created but still holds a balance\" (blocked)",
            "itself, by inspecting the raw account.",
            "",
            "Checking ONLY this vault's balance -- not also `up_mint.supply`/",
            "`down_mint.supply` -- is sufficient, and deliberately not \"hardened\"",
            "with those two extra accounts: `vault.amount == 0` already implies",
            "every winning conditional token has been redeemed (`redeem_winning`",
            "is the only path that debits the vault post-settlement, and it always",
            "debits the vault and the winning mint's supply by the identical",
            "amount -- see its own `require!` check), so whatever supply remains",
            "outstanding on either mint at that point is entirely losing-side",
            "tokens, which are worthless by construction and carry no claim on",
            "anything. Checking the vault is checking the one number that",
            "actually matters; the mint supplies would be two more accounts for",
            "no additional safety."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  115,
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
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "pool",
          "optional": true
        },
        {
          "name": "poolMarket",
          "optional": true
        },
        {
          "name": "rentRecipient",
          "docs": [
            "constrained to the market's own creator so rent can never be",
            "redirected to an arbitrary caller-supplied account."
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
      "name": "depositWriter",
      "discriminator": [
        190,
        219,
        70,
        148,
        227,
        25,
        238,
        35
      ],
      "accounts": [
        {
          "name": "config",
          "relations": [
            "writerVault"
          ]
        },
        {
          "name": "maker",
          "writable": true,
          "signer": true,
          "relations": [
            "writerVault"
          ]
        },
        {
          "name": "settlementMint",
          "relations": [
            "writerVault"
          ]
        },
        {
          "name": "writerVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              }
            ]
          }
        },
        {
          "name": "writerToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
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
                "path": "writerVault"
              }
            ]
          }
        },
        {
          "name": "makerSource",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
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
      "name": "fillQuote",
      "discriminator": [
        12,
        116,
        225,
        132,
        142,
        74,
        167,
        253
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "maker"
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
            "market",
            "writerVault"
          ]
        },
        {
          "name": "market"
        },
        {
          "name": "settlementMint",
          "relations": [
            "market",
            "writerVault"
          ]
        },
        {
          "name": "writerVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              }
            ]
          }
        },
        {
          "name": "writerToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
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
                "path": "writerVault"
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
                  110,
                  111,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "maker"
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
              "name": "quoteArgs"
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
      "name": "initializeWriterVault",
      "discriminator": [
        64,
        80,
        177,
        226,
        118,
        156,
        61,
        17
      ],
      "accounts": [
        {
          "name": "maker",
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
          "name": "writerVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              }
            ]
          }
        },
        {
          "name": "writerToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
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
                "path": "writerVault"
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
      "args": []
    },
    {
      "name": "mintCompleteSet",
      "docs": [
        "Mints a \"complete set\": pulls `amount` of the market's settlement",
        "token into a per-market collateral vault PDA and mints `amount` of",
        "BOTH the UP and DOWN conditional tokens to the caller. Fully",
        "collateralized by construction -- `up_mint`/`down_mint`'s mint",
        "authority is the market PDA, which never signs a `mint_to` CPI",
        "anywhere except here, and this instruction always moves the vault and",
        "both supplies by the identical `amount` in one transaction, verified",
        "below by reloading all three and checking the exact expected delta",
        "(the same defensive \"reload and compare\" pattern `fill_quote` and",
        "`deposit_liquidity` already use elsewhere in this file).",
        "",
        "Gated on `!config.paused` AND `market.enabled`: like",
        "`fill_quote`/`fill_pool_quote`, this creates new economic exposure,",
        "so both the global pause guardian and the market's own admin kill",
        "switch (`set_market_enabled`) block it. `burn_complete_set` and",
        "`redeem_winning` are deliberately gated on NEITHER -- see their own",
        "doc comments for why (same reason `settle`/`refund_unsettled`/etc.",
        "never check `market.enabled` either: it only ever blocks new",
        "exposure, never an exit)."
      ],
      "discriminator": [
        70,
        222,
        130,
        148,
        234,
        103,
        137,
        61
      ],
      "accounts": [
        {
          "name": "minter",
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
            "market"
          ]
        },
        {
          "name": "market"
        },
        {
          "name": "settlementMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "upMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  112,
                  45,
                  109,
                  105,
                  110,
                  116
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
          "name": "downMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  119,
                  110,
                  45,
                  109,
                  105,
                  110,
                  116
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
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  115,
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
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "minterSource",
          "writable": true
        },
        {
          "name": "minterUpToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  115,
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
                "path": "upMint"
              },
              {
                "kind": "account",
                "path": "minter"
              }
            ]
          }
        },
        {
          "name": "minterDownToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  115,
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
                "path": "downMint"
              },
              {
                "kind": "account",
                "path": "minter"
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
          "name": "amount",
          "type": "u64"
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
      "name": "redeemUnresolved",
      "docs": [
        "Escape hatch for a market whose oracle never finalizes: once",
        "`publish_pyth_settlement` can no longer ever succeed again (see",
        "`final_settlement_deadline`), burns `amount` of EITHER conditional",
        "token for a pro-rata share of the collateral vault --",
        "`amount * vault_balance / (up_mint.supply + down_mint.supply)`",
        "(`math::calculate_pro_rata_redemption`) -- rather than requiring a",
        "winner that will never be determined. This is the conditional-token",
        "path's analogue of `refund_unsettled` for the older per-position",
        "path: without it, a holder of only one side of a market whose oracle",
        "is permanently dead has no way to ever recover anything, and",
        "`burn_complete_set` does not help them (it requires holding BOTH",
        "sides).",
        "",
        "Timing -- why the gate is `now > final_settlement_deadline(market)`,",
        "exactly, and not the earlier `settlement_deadline`",
        "`refund_unsettled`/`redeem_winning`'s sibling paths might suggest:",
        "`redeem_winning` requires `oracle.finalized`, and",
        "`publish_pyth_settlement` can still finalize the oracle for any",
        "`now <= final_settlement_deadline(market)` (tier 1 the whole way;",
        "tier 2 after its own additional `tier_two_open_at` gate). Opening",
        "THIS hatch any earlier makes the two payout paths simultaneously",
        "satisfiable, which is a real insolvency, not just a race: collateral",
        "could be paid out pro-rata AND the market could later settle with a",
        "real winner who is then owed more than the vault has left. Concretely,",
        "with `S = 100` outstanding complete sets: if the hatch opened at the",
        "bare `settlement_deadline`, Alice could pro-rata-redeem 50 UP for 25",
        "(vault: 100 -> 75), the oracle could then finalize DOWN, and Bob --",
        "holding 100 DOWN, owed 100 -- would find only 75 left; his",
        "`checked_sub` fails and he can never redeem at all, a strictly worse",
        "outcome (total lockup) than the bug this instruction exists to fix.",
        "Gating on `final_settlement_deadline` instead makes `redeem_unresolved`",
        "and `redeem_winning` strictly mutually exclusive: by the time this",
        "hatch can open, `publish_pyth_settlement` is guaranteed to already be",
        "permanently closed (see its own doc comment), so `oracle.finalized`",
        "can never subsequently flip from false to true underneath a",
        "redemption that already happened.",
        "",
        "Payout formula -- why pro-rata rather than a hardcoded `amount / 2`:",
        "- At the instant the hatch first opens, `vault == up_mint.supply ==",
        "down_mint.supply` always holds (`mint_complete_set`/",
        "`burn_complete_set` move all three by the identical amount every",
        "time -- see their own `require!` checks), so `total == 2 * vault`",
        "and the formula reduces to exactly `amount / 2` -- the standard",
        "\"unresolvable market resolves 50/50\" convention (the same rule",
        "Polymarket applies to markets UMA cannot resolve).",
        "- It stays exact under ANY redemption order, unlike a hardcoded half:",
        "floor division leaves rounding dust in the vault after most",
        "individual redemptions, but the FINAL redemption -- whichever side",
        "still has supply once the other side has fully burned/redeemed to",
        "zero -- always has `amount == total_supply`, so its payout is",
        "`amount * vault / amount == vault` exactly, draining the vault to",
        "zero with no dust left over (see `math::calculate_pro_rata_redemption`'s",
        "own doc comment and tests). A flat `amount / 2` would leave dust in",
        "the vault forever, and with `close_settled_market` now requiring an",
        "empty vault (see `CloseSettledMarket::collateral_vault`), permanent",
        "dust would mean the market -- and its rent -- could never be closed.",
        "- It cannot be manipulated by minting/burning around a redemption:",
        "`mint_complete_set` moves `vault += a` and `total_supply += 2a`;",
        "`burn_complete_set` moves `vault -= a` and `total_supply -= 2a`.",
        "Both preserve `vault / total_supply` exactly, so nobody can shift",
        "the ratio in their favor before redeeming.",
        "",
        "Guardian: like `burn_complete_set`/`redeem_winning`, this is an exit",
        "path -- deliberately NOT gated on `config.paused` or `market.enabled`."
      ],
      "discriminator": [
        94,
        144,
        129,
        29,
        214,
        131,
        149,
        78
      ],
      "accounts": [
        {
          "name": "redeemer",
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
          "relations": [
            "oracle"
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
          "name": "settlementMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "upMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  112,
                  45,
                  109,
                  105,
                  110,
                  116
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
          "name": "downMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  119,
                  110,
                  45,
                  109,
                  105,
                  110,
                  116
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
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  115,
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
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "redeemerToken",
          "writable": true
        },
        {
          "name": "redeemerDestination",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "redeemWinning",
      "docs": [
        "Redeems `amount` of the market's WINNING conditional token for",
        "`amount` collateral, once the oracle has finalized. The winner rule:",
        "UP wins if the finalized price is *strictly* above `market.strike`,",
        "DOWN otherwise (an exact tie goes to DOWN) -- see `math::up_wins`.",
        "The losing side can never redeem: `redeemer_token.mint` is checked",
        "against whichever side actually won.",
        "",
        "Guardian: like `burn_complete_set`, deliberately NOT gated on",
        "`config.paused` -- a winner must always be able to claim their",
        "payout, exactly the same rationale `settle`/`close_pool_position`",
        "document for staying pause-independent."
      ],
      "discriminator": [
        191,
        44,
        57,
        7,
        31,
        46,
        190,
        162
      ],
      "accounts": [
        {
          "name": "redeemer",
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
          "relations": [
            "oracle"
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
          "name": "settlementMint",
          "relations": [
            "market"
          ]
        },
        {
          "name": "upMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  112,
                  45,
                  109,
                  105,
                  110,
                  116
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
          "name": "downMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  119,
                  110,
                  45,
                  109,
                  105,
                  110,
                  116
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
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  115,
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
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "redeemerToken",
          "writable": true
        },
        {
          "name": "redeemerDestination",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
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
          "name": "nonceRecord",
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
      "name": "refundUnsettled",
      "discriminator": [
        24,
        76,
        163,
        75,
        241,
        208,
        12,
        204
      ],
      "accounts": [
        {
          "name": "cranker",
          "signer": true
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
          "name": "nonceRecord",
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
            "market",
            "position"
          ]
        },
        {
          "name": "buyerDestination",
          "writable": true
        },
        {
          "name": "makerDestination",
          "writable": true
        },
        {
          "name": "rentRecipient",
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
      "name": "settle",
      "discriminator": [
        175,
        42,
        185,
        87,
        144,
        131,
        102,
        212
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
            "market"
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
          "name": "nonceRecord",
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
            "market",
            "position"
          ]
        },
        {
          "name": "buyerDestination",
          "writable": true
        },
        {
          "name": "makerDestination",
          "writable": true
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
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
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
          "name": "nonceRecord",
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
          "writable": true
        },
        {
          "name": "rentRecipient",
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
    },
    {
      "name": "withdrawWriter",
      "discriminator": [
        232,
        244,
        184,
        16,
        129,
        82,
        99,
        248
      ],
      "accounts": [
        {
          "name": "config",
          "relations": [
            "writerVault"
          ]
        },
        {
          "name": "maker",
          "signer": true,
          "relations": [
            "writerVault"
          ]
        },
        {
          "name": "settlementMint",
          "relations": [
            "writerVault"
          ]
        },
        {
          "name": "writerVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "settlementMint"
              }
            ]
          }
        },
        {
          "name": "writerToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  105,
                  116,
                  101,
                  114,
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
                "path": "writerVault"
              }
            ]
          }
        },
        {
          "name": "makerDestination",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
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
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "quoteNonce",
      "discriminator": [
        26,
        217,
        189,
        138,
        190,
        234,
        161,
        245
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
    },
    {
      "name": "writerVault",
      "discriminator": [
        121,
        228,
        9,
        143,
        36,
        122,
        20,
        9
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
      "name": "completeSetBurned",
      "discriminator": [
        202,
        191,
        88,
        162,
        119,
        157,
        167,
        98
      ]
    },
    {
      "name": "completeSetMinted",
      "discriminator": [
        138,
        100,
        135,
        145,
        242,
        178,
        224,
        155
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
      "name": "nonceCancelled",
      "discriminator": [
        97,
        165,
        3,
        200,
        228,
        217,
        28,
        102
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
      "name": "positionRefunded",
      "discriminator": [
        48,
        21,
        180,
        80,
        135,
        253,
        10,
        255
      ]
    },
    {
      "name": "positionSettled",
      "discriminator": [
        75,
        100,
        92,
        189,
        245,
        116,
        252,
        221
      ]
    },
    {
      "name": "quoteFilled",
      "discriminator": [
        205,
        53,
        159,
        86,
        117,
        4,
        177,
        64
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
    },
    {
      "name": "unresolvedRedeemed",
      "discriminator": [
        45,
        128,
        62,
        73,
        20,
        116,
        3,
        220
      ]
    },
    {
      "name": "winningRedeemed",
      "discriminator": [
        46,
        214,
        83,
        245,
        144,
        28,
        187,
        212
      ]
    },
    {
      "name": "writerDeposited",
      "discriminator": [
        107,
        98,
        55,
        224,
        211,
        129,
        117,
        168
      ]
    },
    {
      "name": "writerVaultInitialized",
      "discriminator": [
        201,
        103,
        130,
        252,
        47,
        75,
        7,
        22
      ]
    },
    {
      "name": "writerWithdrawn",
      "discriminator": [
        24,
        148,
        142,
        220,
        115,
        175,
        244,
        84
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
      "name": "invalidWriterVault",
      "msg": "The writer vault is invalid."
    },
    {
      "code": 6027,
      "name": "insufficientWriterLiquidity",
      "msg": "The writer does not have enough available collateral."
    },
    {
      "code": 6028,
      "name": "collateralMismatch",
      "msg": "Escrow does not exactly equal premium plus maximum payout."
    },
    {
      "code": 6029,
      "name": "eligibilityRequired",
      "msg": "An eligibility account is required."
    },
    {
      "code": 6030,
      "name": "invalidEligibility",
      "msg": "The eligibility account is invalid."
    },
    {
      "code": 6031,
      "name": "ineligibleWallet",
      "msg": "The wallet is not eligible to trade."
    },
    {
      "code": 6032,
      "name": "invalidMarket",
      "msg": "The market account is invalid."
    },
    {
      "code": 6033,
      "name": "invalidOracle",
      "msg": "The oracle account is invalid."
    },
    {
      "code": 6034,
      "name": "oracleAlreadyFinalized",
      "msg": "The settlement oracle is already finalized."
    },
    {
      "code": 6035,
      "name": "oracleNotFinalized",
      "msg": "The settlement oracle is not finalized."
    },
    {
      "code": 6036,
      "name": "invalidOraclePrice",
      "msg": "The oracle price is invalid."
    },
    {
      "code": 6037,
      "name": "invalidObservationTime",
      "msg": "The oracle observation timestamp is outside the approved window."
    },
    {
      "code": 6038,
      "name": "settlementWindowClosed",
      "msg": "The settlement publication window is closed."
    },
    {
      "code": 6039,
      "name": "oracleConfidenceTooWide",
      "msg": "The oracle confidence interval is too wide."
    },
    {
      "code": 6040,
      "name": "settlementWindowOpen",
      "msg": "The settlement fallback window is still open."
    },
    {
      "code": 6041,
      "name": "invalidPosition",
      "msg": "The position is invalid."
    },
    {
      "code": 6042,
      "name": "positionNotOpen",
      "msg": "The position is not open."
    },
    {
      "code": 6043,
      "name": "invalidNonce",
      "msg": "The quote nonce record is invalid."
    },
    {
      "code": 6044,
      "name": "invalidDestination",
      "msg": "A settlement destination token account is invalid."
    },
    {
      "code": 6045,
      "name": "poolHasOpenPositions",
      "msg": "The liquidity pool has active collateral obligations."
    },
    {
      "code": 6046,
      "name": "invalidPoolShares",
      "msg": "The liquidity pool share amount is invalid."
    },
    {
      "code": 6047,
      "name": "poolInsolvent",
      "msg": "The liquidity pool has no assets backing outstanding shares."
    },
    {
      "code": 6048,
      "name": "depositTooSmall",
      "msg": "The deposit or withdrawal is too small after conservative rounding."
    },
    {
      "code": 6049,
      "name": "slippageExceeded",
      "msg": "The requested minimum output was not met."
    },
    {
      "code": 6050,
      "name": "deadlineExpired",
      "msg": "The transaction deadline has expired."
    },
    {
      "code": 6051,
      "name": "invalidPoolRiskLimits",
      "msg": "The liquidity pool risk limits are invalid."
    },
    {
      "code": 6052,
      "name": "poolMarketDisabled",
      "msg": "The liquidity pool is not enabled for this market."
    },
    {
      "code": 6053,
      "name": "invalidLastTradeCutoff",
      "msg": "The market's last-trade cutoff is invalid."
    },
    {
      "code": 6054,
      "name": "lastTradeCutoffReached",
      "msg": "The market's last-trade cutoff has been reached."
    },
    {
      "code": 6055,
      "name": "poolUtilizationExceeded",
      "msg": "The liquidity pool utilization limit would be exceeded."
    },
    {
      "code": 6056,
      "name": "poolPositionLimitExceeded",
      "msg": "The position exceeds the liquidity pool's per-position risk limit."
    },
    {
      "code": 6057,
      "name": "buybackExceedsMaxPayout",
      "msg": "The buyback amount cannot exceed the position's maximum payout."
    },
    {
      "code": 6058,
      "name": "marketNotCloseable",
      "msg": "The market cannot be closed yet: its settlement window has not fully elapsed, or its pool authorization is still enabled."
    },
    {
      "code": 6059,
      "name": "invalidPoolMarket",
      "msg": "The supplied pool/pool-market pair is invalid or inconsistent."
    },
    {
      "code": 6060,
      "name": "noPendingPoolUpdate",
      "msg": "There is no pending liquidity pool update to apply or cancel."
    },
    {
      "code": 6061,
      "name": "poolUpdateTimelocked",
      "msg": "The pending liquidity pool update's timelock has not yet elapsed."
    },
    {
      "code": 6062,
      "name": "invalidStrike",
      "msg": "The market strike must be positive."
    },
    {
      "code": 6063,
      "name": "losingSideNotRedeemable",
      "msg": "The supplied token account does not match the market's winning side."
    },
    {
      "code": 6064,
      "name": "marketHasOutstandingCollateral",
      "msg": "The market's collateral vault still holds outstanding complete-set collateral: redeem or burn every outstanding complete set before closing this market."
    },
    {
      "code": 6065,
      "name": "invalidConditionalTokenMint",
      "msg": "The supplied token account does not belong to either the UP or DOWN mint."
    },
    {
      "code": 6066,
      "name": "nothingToRedeem",
      "msg": "There is no outstanding conditional-token supply left to redeem."
    },
    {
      "code": 6067,
      "name": "customFeedNotYetFresh",
      "msg": "The custom price feed has not yet updated past this market's expiry."
    },
    {
      "code": 6068,
      "name": "customFeedStale",
      "msg": "The custom price feed has not updated recently enough to settle with."
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
      "name": "completeSetBurned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "burner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "completeSetMinted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "minter",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
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
      "name": "nonceCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          }
        ]
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
      "name": "position",
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
            "name": "maker",
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
      "name": "positionRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
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
      "name": "positionSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
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
            "name": "makerAmount",
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
      "name": "quoteArgs",
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
      "name": "quoteFilled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
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
            "name": "maker",
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
      "name": "quoteNonce",
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
            "name": "config",
            "type": "pubkey"
          },
          {
            "name": "maker",
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
      "name": "unresolvedRedeemed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "redeemer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "redeemedUp",
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
    },
    {
      "name": "winningRedeemed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "redeemer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "upWon",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "writerDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writerVault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "writerVault",
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
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "settlementMint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "writerVaultInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writerVault",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "settlementMint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "writerWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writerVault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
