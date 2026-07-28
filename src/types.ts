export type Network = "mainnet" | "testnet";

// Minimal signer interface — compatible with Freighter and any Stellar wallet
export interface StellarSigner {
  getAddress(): Promise<string>;
  signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
  /**
   * Signs a Soroban authorization entry directly (not a full transaction).
   * Only needed for `setAdmin`, the one write that requires a second
   * party (the incoming admin) to co-authorize independently of the tx
   * signer. Matches Freighter's `signAuthEntry(entryXdr, opts)` shape.
   */
  signAuthEntry?(entryXdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
}

export interface LuckyPoolClientConfig {
  network: Network;
  /** Deployed LuckyPool contract address (`C...`). */
  contractId: string;
  signer: StellarSigner;
  /** Override the default public RPC endpoint for `network`. */
  rpcUrl?: string;
}

// ── Contract data shapes ──────────────────────────────────────────────────
// Mirrors contracts/lucky_pool/src/storage.rs field-for-field. `i128`/`i64`
// amounts are bigint — USDC stroop amounts routinely exceed
// Number.MAX_SAFE_INTEGER-safe precision, so Number() would silently lose
// precision on a large pool.

/** Per-user state: principal deposited, tickets earned, round joined. */
export interface UserPosition {
  /** USDC deposited, in stroops (7 decimals — 1 USDC = 10_000_000). */
  principal: bigint;
  /** Lottery tickets: 1 USDC deposited = 1 ticket. */
  tickets: bigint;
  /** Round number when the user first deposited. */
  roundJoined: number;
}

/** Global contract state. */
export interface PoolState {
  admin: string;
  /** USDC token contract (SAC on testnet). */
  usdc: string;
  /** Blend lending-pool contract — yield source. */
  blendPool: string;
  /** VRF oracle contract — randomness source for draws. */
  oracle: string;
  /** Sum of all user principals, in stroops. */
  totalDeposits: bigint;
  /** Accumulated yield available to award, in stroops. */
  prizePool: bigint;
  /** Current lottery round (increments after each draw). */
  currentRound: number;
  /** Ledger sequence of the most recent draw. */
  lastDrawLedger: number;
  /** Protocol fee in basis points — capped at 1000 (10%) at init. */
  protocolFeeBps: number;
  /** When true, new deposits are blocked; withdrawals always open. */
  paused: boolean;
  /** True between `requestDraw()` and `executeDraw()` for the current round. */
  drawRequested: boolean;
  /**
   * Hex-encoded public input the VRF output for the pending draw must
   * correspond to. Only meaningful while `drawRequested` is true.
   */
  roundSeed: string;
}

/** Immutable record written after each draw. */
export interface RoundResult {
  round: number;
  winner: string;
  /** Prize paid out (post protocol-fee), in stroops. */
  prize: bigint;
  totalTickets: bigint;
  drawLedger: number;
}

export interface DepositEvent {
  type: "Deposit";
  user: string;
  amount: bigint;
  round: number;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

export interface WithdrawEvent {
  type: "Withdraw";
  user: string;
  amount: bigint;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

export type LuckyPoolEvent = DepositEvent | WithdrawEvent;
