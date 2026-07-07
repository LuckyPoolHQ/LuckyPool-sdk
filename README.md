# @luckypool/draw-engine

Typed TypeScript client for driving provably-fair, VRF-backed on-chain draws on Stellar/Soroban. Built for [LuckyPool](https://github.com/LuckyPoolHQ), but designed to front any Soroban contract exposing an `add_entrants` / `draw` shape — not LuckyPool-specific.

---

## Install

```bash
npm install @luckypool/draw-engine @stellar/stellar-sdk
```

`@stellar/stellar-sdk` (`>=11.0.0`) is a peer dependency — bring your own version.

---

## Quick start

```ts
import { DrawEngine } from "@luckypool/draw-engine";

const engine = new DrawEngine({
  network: "testnet",           // "testnet" | "mainnet"
  contractId: "CA...",          // deployed contract address
  signer,                       // any StellarSigner — Freighter, xBull, a keypair, etc.
});

await engine.addEntrants([
  { address: "GABC...", tickets: 100 },
  { address: "GDEF...", tickets: 25 },
]);

const result = await engine.draw();
console.log(result.winner, result.vrfProof, result.txHash);
```

See [`examples/basic-usage.ts`](examples/basic-usage.ts) for a full runnable example.

---

## API

### `new DrawEngine(config)`

| Field | Type | Description |
|---|---|---|
| `network` | `"mainnet" \| "testnet"` | Selects the Soroban RPC endpoint and network passphrase |
| `contractId` | `string` | Address of the deployed contract |
| `signer` | `StellarSigner` | Anything implementing `getAddress()` and `signTransaction()` |
| `methodNames?` | `Partial<{ addEntrants, draw }>` | Override contract method names if your contract doesn't use the defaults (`add_entrants`, `draw`) |

### `engine.addEntrants(entrants: Entrant[]): Promise<void>`

Registers participants for the next draw. Each `Entrant` is `{ address: string, tickets: number }` — ticket count determines win probability (`P(win) = entrant_tickets / total_tickets`).

### `engine.draw(): Promise<DrawResult>`

Submits the draw transaction, polls for confirmation, and parses the result. Throws if the transaction fails on-chain or times out (20 poll attempts at 1.5s intervals).

### `engine.getResult(txHash: string): Promise<DrawResult>`

Looks up a past draw by transaction hash and parses it into a `DrawResult`. Throws if the transaction wasn't a successful draw.

### `engine.rpcUrl: string`

The Soroban RPC endpoint currently in use for this instance's network.

### Types

```ts
type Network = "mainnet" | "testnet";

interface Entrant {
  address: string;
  tickets: number;
}

interface DrawResult {
  winner: string;
  vrfProof: string;
  txHash: string;
  timestamp: number;
  entrants: number;
}

interface StellarSigner {
  getAddress(): Promise<string>;
  signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
}
```

---

## Project layout

```
src/
├── index.ts          Public exports
├── client/
│   └── DrawEngine.ts Contract invocation, polling, result parsing
└── types/
    └── index.ts       Config, Entrant, DrawResult, StellarSigner
examples/
└── basic-usage.ts     End-to-end usage example
```

---

## Development

```bash
npm install
npm run build   # tsc → dist/
npm run dev     # tsc --watch
```

No test suite yet — contributions welcome.

---

## Related repos

| Repo | What's in it |
|---|---|
| [LuckyPool-contracts](https://github.com/LuckyPoolHQ/LuckyPool-contracts) | The Soroban contract this SDK talks to |
| [LuckyPool-docs](https://github.com/LuckyPoolHQ/LuckyPool-docs) | Architecture, randomness design, contract interface |
| [LuckyPool-frontend](https://github.com/LuckyPoolHQ/LuckyPool-frontend) | Reference frontend integration |

---

## License

MIT — see [LICENSE](LICENSE).
