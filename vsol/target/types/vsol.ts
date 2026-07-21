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
      "name": "updateLiquidityPool",
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
