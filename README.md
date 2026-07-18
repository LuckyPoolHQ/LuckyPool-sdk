# @luckypool/draw-engine

DrawEngine SDK — a thin client for triggering and reading verifiable, VRF-backed
on-chain draws on any Soroban contract that exposes an `add_entrants` /
`draw` shape. Built for LuckyPool's own contract, but the method names are
overridable so any protocol running a similar draw primitive can reuse it.

## Install

```bash
npm install @luckypool/draw-engine @stellar/stellar-sdk
```

`@stellar/stellar-sdk` is a peer dependency (`>=11.0.0`) — bring your own version.

## Usage

```ts
import { DrawEngine } from "@luckypool/draw-engine";

const engine = new DrawEngine({
  network: "testnet", // or "mainnet"
  contractId: "C...",  // your deployed contract ID
  signer: {
    // Any wallet that can produce an address and sign a Soroban tx XDR.
    // Freighter's @stellar/freighter-api implements this shape directly.
    getAddress: () => window.freighter.getAddress(),
    signTransaction: (xdr, opts) => window.freighter.signTransaction(xdr, opts),
  },
});

// Register participants ahead of a draw.
await engine.addEntrants([
  { address: "GABC...", tickets: 3 },
  { address: "GXYZ...", tickets: 1 },
]);

// Trigger the draw and get the winner + VRF proof back.
const result = await engine.draw();
console.log(result.winner, result.vrfProof, result.entrants);

// Or look up a past draw by transaction hash.
const past = await engine.getResult(result.txHash);
```

## API

### `new DrawEngine(config)`

| Field | Type | Description |
|---|---|---|
| `network` | `"mainnet" \| "testnet"` | Selects the Soroban RPC endpoint |
| `contractId` | `string` | Deployed contract address (`C...`) |
| `signer` | `StellarSigner` | `{ getAddress(), signTransaction(xdr, opts?) }` — any wallet matching this shape works |
| `methodNames?` | `{ addEntrants?: string; draw?: string }` | Override contract method names if your contract doesn't use `add_entrants`/`draw` |

### `engine.addEntrants(entrants: Entrant[]): Promise<void>`

Registers `{ address, tickets }` pairs for the next draw. No-op (no RPC calls) for an empty array.

### `engine.draw(): Promise<DrawResult>`

Submits the draw transaction, waits for on-chain confirmation, and returns the parsed result.

### `engine.getResult(txHash: string): Promise<DrawResult>`

Fetches and parses a previously confirmed draw by transaction hash. Throws if the transaction wasn't a successful invocation.

### `DrawResult`

```ts
interface DrawResult {
  winner: string;     // winning address
  vrfProof: string;   // hex-encoded VRF proof
  txHash: string;
  timestamp: number;
  entrants: number;
}
```

## Development

```bash
npm install
npm test    # vitest — mocks the Soroban RPC layer, no network access needed
npm run build
```

## Status

Real Soroban RPC wiring (build → simulate → sign → submit → poll), unit-tested
against a mocked `rpc.Server`. Not yet published as a standalone npm package —
see `docs/plan.md` Phase 3 for the extraction plan.
