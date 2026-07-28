# @luckypool/draw-engine

A TypeScript client for the deployed **LuckyPool** Soroban contract (see
[LuckyPool-contracts](https://github.com/LuckyPoolHQ/LuckyPool-contracts)).
Every method here maps 1:1 to a real `#[contractimpl]` function on that
contract — same name (in `snake_case` on the wire), same auth requirements,
same argument and return shapes. This is the client
[LuckyPool-frontend](https://github.com/LuckyPoolHQ/LuckyPool-frontend)
actually uses in production; it isn't a separate, speculative abstraction.

## Install

```bash
npm install @luckypool/draw-engine @stellar/stellar-sdk
```

`@stellar/stellar-sdk` is a peer dependency (`>=11.0.0`) — bring your own version.

## Usage

```ts
import { LuckyPoolClient, usdcToStroops, stroopsToUsdc } from "@luckypool/draw-engine";

const client = new LuckyPoolClient({
  network: "testnet", // or "mainnet"
  contractId: "C...",  // deployed LuckyPool contract ID
  signer: {
    // Any wallet that can produce an address and sign a Soroban tx XDR.
    // Freighter's @stellar/freighter-api implements this shape directly.
    getAddress: () => window.freighter.getAddress(),
    signTransaction: (xdr, opts) => window.freighter.signTransaction(xdr, opts),
  },
});

// Deposit — grants 1 lottery ticket per USDC.
await client.deposit(myAddress, 100);

// Principal is always withdrawable.
await client.withdraw(myAddress, 25);

// Read live state.
const state = await client.getPoolState();
const position = await client.getPosition(myAddress);
console.log(stroopsToUsdc(state.prizePool), position.tickets);

// Draw lifecycle (permissionless open, admin-gated execute — see below).
await client.requestDraw();
await client.executeDraw(vrfOutputHex, vrfProofHex);

// Past round + user history.
const rounds = await client.getRecentRounds(5);
const history = await client.getUserHistory(myAddress);
```

## API

### `new LuckyPoolClient(config)`

| Field | Type | Description |
|---|---|---|
| `network` | `"mainnet" \| "testnet"` | Selects the default Soroban RPC endpoint |
| `contractId` | `string` | Deployed LuckyPool contract address (`C...`) |
| `signer` | `StellarSigner` | `{ getAddress(), signTransaction(xdr, opts?), signAuthEntry?(entryXdr, opts?) }` |
| `rpcUrl?` | `string` | Override the default RPC endpoint for `network` |

`signAuthEntry` is only needed for `setAdmin` (see below); every other write only needs `signTransaction`.

### User actions

- `deposit(user, amountUsdc)` — signed by `user`. Grants 1 ticket per USDC.
- `withdraw(user, amountUsdc)` — signed by `user`. Principal is always withdrawable.

### Protocol actions

- `harvestYield()` — permissionless. Pulls accrued yield into the prize pool.
- `fundPrizePool(from, amountUsdc)` — signed by `from`. Sponsor top-ups / testing.

### Draw lifecycle

- `requestDraw()` — permissionless. Opens the draw for the current round, computes and emits the public round seed.
- `executeDraw(vrfOutput, vrfProof)` — admin-gated. `vrfOutput`/`vrfProof` accept hex strings or raw bytes.

  **VRF proof verification is not wired up yet** — no VRF provider with a
  verifiable on-chain interface has been confirmed (see
  [LuckyPool-docs/randomness.md](https://github.com/LuckyPoolHQ/LuckyPool-docs/blob/main/randomness.md)).
  `vrfOutput` is effectively admin-supplied randomness today, not yet a
  provably-fair draw. `executeDraw` stays admin-gated until that's resolved.

### Admin

- `initialize({ admin, usdc, blendPool, oracle, protocolFeeBps })` — one-time deploy setup, signed by `admin`.
- `pause()` / `unpause()` — signed by the current admin.
- `setAdmin(newAdmin, newAdminSigner)` — **the one write that needs two signatures.** The contract requires both the outgoing admin (the configured `signer`) and the incoming admin to independently authorize. Pass a second `StellarSigner` (with `signAuthEntry`) for the incoming admin. There's no browser-wallet flow for this in LuckyPool today — it's an ops action, typically run from a script holding both keys.

### Views (simulated reads, no signature required)

- `getPosition(user): Promise<UserPosition>` — `{ principal, tickets, roundJoined }`, `bigint` amounts.
- `getPoolState(): Promise<PoolState>` — full contract state, including `paused`, `drawRequested`, `roundSeed` (hex).
- `getRoundResult(round): Promise<RoundResult | null>` — `null` if that round hasn't been drawn (or doesn't exist).
- `getRecentRounds(count): Promise<RoundResult[]>` — most recent completed rounds, skipping gaps.
- `getUserHistory(user, opts?): Promise<LuckyPoolEvent[]>` — deposit/withdraw events for `user`, most recent first.

### Helpers

- `usdcToStroops(amountUsdc: number): bigint`
- `stroopsToUsdc(stroops: bigint): number`
- `STROOP = 10_000_000` — stroops per USDC (7 decimals).

All `i128`/`u64` contract amounts are typed as `bigint` in this client, never
`number` — USDC stroop amounts routinely exceed
`Number.MAX_SAFE_INTEGER`-safe precision once a pool has real TVL.

## Development

```bash
npm install
npm test    # vitest — mocks the Soroban RPC layer, no network access needed
npm run build
```

## Status

Real Soroban RPC wiring (build → simulate → sign → submit → poll) for every
method on the deployed contract, unit-tested against a mocked `rpc.Server`
— including the two-party `setAdmin` auth flow, exercised against real
`xdr.SorobanAuthorizationEntry` objects rather than stubs. Not yet published
as a standalone npm package — see
[LuckyPool-docs/plan.md](https://github.com/LuckyPoolHQ/LuckyPool-docs/blob/main/plan.md)
Phase 3 for the extraction plan.

## Related repos

- [LuckyPool-contracts](https://github.com/LuckyPoolHQ/LuckyPool-contracts) — Soroban smart contracts
- [LuckyPool-frontend](https://github.com/LuckyPoolHQ/LuckyPool-frontend) — Next.js app
- [LuckyPool-docs](https://github.com/LuckyPoolHQ/LuckyPool-docs) — architecture, design docs

