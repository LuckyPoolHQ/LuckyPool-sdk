import type {
  LuckyPoolClientConfig,
  LuckyPoolEvent,
  PoolState,
  RoundResult,
  StellarSigner,
  UserPosition,
} from "./types";
import {
  Address,
  authorizeEntry,
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
  Account,
  Keypair,
} from "@stellar/stellar-sdk";

const RPC_URLS: Record<string, string> = {
  mainnet: "https://soroban-mainnet.stellar.org",
  testnet: "https://soroban-testnet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<string, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

/** 1 USDC expressed in stroops (7 decimal places) — matches contracts/lucky_pool. */
export const STROOP = 10_000_000;

export function usdcToStroops(amountUsdc: number): bigint {
  return BigInt(Math.round(amountUsdc * STROOP));
}

export function stroopsToUsdc(stroops: bigint): number {
  return Number(stroops) / STROOP;
}

const TX_TIMEOUT_SECONDS = 30;
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 20;

// Soroban RPC only retains a rolling window of events (~7 days on testnet);
// this is a default lookback, not a hard protocol limit.
const LEDGERS_PER_DAY = 17_280; // ~5s per ledger
const DEFAULT_EVENT_LOOKBACK_LEDGERS = LEDGERS_PER_DAY * 7;

// Any syntactically valid keypair works for simulation-only reads — the
// ledger never needs to know this account exists, since simulate doesn't
// check signatures or account balances.
const SIMULATION_KEYPAIR = Keypair.random();

interface InvocationResult {
  returnValue?: xdr.ScVal;
  txHash: string;
  createdAt: number;
}

function bytesArg(value: string | Uint8Array): xdr.ScVal {
  const buf = typeof value === "string" ? Buffer.from(value, "hex") : Buffer.from(value);
  return nativeToScVal(buf, { type: "bytes" });
}

function topicFilter(...segments: string[]): string[] {
  return segments.map((s) => xdr.ScVal.scvSymbol(s).toXDR("base64"));
}

/**
 * Client for the deployed LuckyPool Soroban contract
 * (`contracts/lucky_pool/src/lib.rs`) — every method here maps 1:1 to a real
 * `#[contractimpl]` function on that contract, with the same auth
 * requirements. This is not a generic "any draw contract" abstraction; it's
 * bound to LuckyPool's actual shape.
 */
export class LuckyPoolClient {
  private config: LuckyPoolClientConfig;
  private server: rpc.Server;

  constructor(config: LuckyPoolClientConfig) {
    this.config = config;
    this.server = new rpc.Server(config.rpcUrl ?? RPC_URLS[config.network]);
  }

  /** Current RPC endpoint for this network. */
  get rpcUrl(): string {
    return this.config.rpcUrl ?? RPC_URLS[this.config.network];
  }

  // ── INITIALIZE ────────────────────────────────────────────────────────────

  /** Deploy-time setup. Must be called once, signed by `admin`. */
  async initialize(params: {
    admin: string;
    usdc: string;
    blendPool: string;
    oracle: string;
    protocolFeeBps: number;
  }): Promise<string> {
    const { txHash } = await this.invoke("initialize", [
      new Address(params.admin).toScVal(),
      new Address(params.usdc).toScVal(),
      new Address(params.blendPool).toScVal(),
      new Address(params.oracle).toScVal(),
      nativeToScVal(params.protocolFeeBps, { type: "u32" }),
    ]);
    return txHash;
  }

  // ── USER ACTIONS ──────────────────────────────────────────────────────────

  /** Deposit `amountUsdc` USDC. `user` must be the connected signer's address. */
  async deposit(user: string, amountUsdc: number): Promise<string> {
    const { txHash } = await this.invoke("deposit", [
      new Address(user).toScVal(),
      nativeToScVal(usdcToStroops(amountUsdc), { type: "i128" }),
    ]);
    return txHash;
  }

  /** Withdraw `amountUsdc` USDC. Principal is always withdrawable. */
  async withdraw(user: string, amountUsdc: number): Promise<string> {
    const { txHash } = await this.invoke("withdraw", [
      new Address(user).toScVal(),
      nativeToScVal(usdcToStroops(amountUsdc), { type: "i128" }),
    ]);
    return txHash;
  }

  // ── PROTOCOL ACTIONS ──────────────────────────────────────────────────────

  /** Harvest accrued Blend yield into the prize pool. Permissionless. */
  async harvestYield(): Promise<string> {
    const { txHash } = await this.invoke("harvest_yield", []);
    return txHash;
  }

  /** Manually fund the prize pool (sponsor top-ups, testing). */
  async fundPrizePool(from: string, amountUsdc: number): Promise<string> {
    const { txHash } = await this.invoke("fund_prize_pool", [
      new Address(from).toScVal(),
      nativeToScVal(usdcToStroops(amountUsdc), { type: "i128" }),
    ]);
    return txHash;
  }

  // ── DRAW ──────────────────────────────────────────────────────────────────

  /** Opens the draw for the current round and emits the public round seed. Permissionless. */
  async requestDraw(): Promise<string> {
    const { txHash } = await this.invoke("request_draw", []);
    return txHash;
  }

  /**
   * Executes a previously-requested draw. `vrfOutput`/`vrfProof` accept hex
   * strings or raw bytes.
   *
   * Admin-gated: proof verification isn't wired up yet (no VRF provider with
   * a verifiable on-chain interface has been confirmed — see docs/randomness.md),
   * so `vrfOutput` is effectively admin-supplied randomness today, not yet a
   * provably-fair draw.
   */
  async executeDraw(vrfOutput: string | Uint8Array, vrfProof: string | Uint8Array): Promise<string> {
    const { txHash } = await this.invoke("execute_draw", [bytesArg(vrfOutput), bytesArg(vrfProof)]);
    return txHash;
  }

  // ── ADMIN ─────────────────────────────────────────────────────────────────

  /** Pause new deposits. Withdrawals always remain open. */
  async pause(): Promise<string> {
    const { txHash } = await this.invoke("pause", []);
    return txHash;
  }

  /** Resume deposits. */
  async unpause(): Promise<string> {
    const { txHash } = await this.invoke("unpause", []);
    return txHash;
  }

  /**
   * Transfers admin rights. Unlike every other write here, `set_admin`
   * requires two independent signatures — the outgoing admin (the
   * configured signer, satisfied by the tx envelope signature) AND the
   * incoming admin, who must separately authorize via `newAdminSigner`.
   * There's no LuckyPool UI flow for this today; it's an ops action.
   */
  async setAdmin(newAdmin: string, newAdminSigner: StellarSigner): Promise<string> {
    const sourceAddress = await this.config.signer.getAddress();
    const account = await this.server.getAccount(sourceAddress);
    const contract = new Contract(this.config.contractId);

    const built = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call("set_admin", new Address(newAdmin).toScVal()))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    const prepared = await this.server.prepareTransaction(built);

    const newAdminAddress = await newAdminSigner.getAddress();
    const op = prepared.operations[0] as unknown as { auth?: xdr.SorobanAuthorizationEntry[] };
    const authEntries = op.auth ?? [];
    const needsCoSignature = authEntries.some(
      (entry) =>
        entry.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
        Address.fromScAddress(entry.credentials().address().address()).toString() === newAdminAddress,
    );

    if (needsCoSignature) {
      if (!newAdminSigner.signAuthEntry) {
        throw new Error(
          "setAdmin requires newAdminSigner.signAuthEntry — the incoming admin must independently authorize this transfer",
        );
      }
      const validUntilLedgerSeq = (await this.server.getLatestLedger()).sequence + 100;
      for (let i = 0; i < authEntries.length; i++) {
        const entry = authEntries[i];
        if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) continue;
        if (Address.fromScAddress(entry.credentials().address().address()).toString() !== newAdminAddress) continue;

        authEntries[i] = await authorizeEntry(
          entry,
          async (preimage) => {
            const signed = await newAdminSigner.signAuthEntry!(preimage.toXDR("base64"), {
              networkPassphrase: this.networkPassphrase,
            });
            return Buffer.from(signed, "base64");
          },
          validUntilLedgerSeq,
          this.networkPassphrase,
        );
      }
    }

    const signedXdr = await this.config.signer.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const sendResult = await this.server.sendTransaction(signed);
    if (sendResult.status === "ERROR") {
      throw new Error(`Failed to submit set_admin: ${JSON.stringify(sendResult.errorResult)}`);
    }
    return (await this.pollForResult(sendResult.hash)).txHash;
  }

  // ── VIEWS ─────────────────────────────────────────────────────────────────

  async getPosition(user: string): Promise<UserPosition> {
    return this.simulate("get_position", [new Address(user).toScVal()], (value) => {
      const raw = value as { principal: bigint; tickets: bigint; round_joined: bigint };
      return {
        principal: raw.principal,
        tickets: raw.tickets,
        roundJoined: Number(raw.round_joined),
      };
    });
  }

  async getPoolState(): Promise<PoolState> {
    return this.simulate("get_pool_state", [], (value) => {
      const raw = value as Record<string, unknown>;
      return {
        admin: String(raw.admin),
        usdc: String(raw.usdc),
        blendPool: String(raw.blend_pool),
        oracle: String(raw.oracle),
        totalDeposits: raw.total_deposits as bigint,
        prizePool: raw.prize_pool as bigint,
        currentRound: Number(raw.current_round),
        lastDrawLedger: Number(raw.last_draw_ledger),
        protocolFeeBps: Number(raw.protocol_fee_bps),
        paused: Boolean(raw.paused),
        drawRequested: Boolean(raw.draw_requested),
        roundSeed: Buffer.from(raw.round_seed as Uint8Array).toString("hex"),
      };
    });
  }

  /** Fetch a past round's result. Returns null if that round hasn't been drawn (or doesn't exist). */
  async getRoundResult(round: number): Promise<RoundResult | null> {
    return this.simulate("get_round_result", [nativeToScVal(round, { type: "u64" })], (value) => {
      if (value === null || value === undefined) return null;
      const raw = value as Record<string, unknown>;
      return {
        round: Number(raw.round),
        winner: String(raw.winner),
        prize: raw.prize as bigint,
        totalTickets: raw.total_tickets as bigint,
        drawLedger: Number(raw.draw_ledger),
      };
    });
  }

  /**
   * Fetch the most recent `count` completed rounds (rounds before the pool's
   * current, still-open round), most recent first. Skips any gaps.
   */
  async getRecentRounds(count: number): Promise<RoundResult[]> {
    const state = await this.getPoolState();
    const results: RoundResult[] = [];
    for (let round = state.currentRound - 1; round >= 1 && results.length < count; round--) {
      const result = await this.getRoundResult(round);
      if (result) results.push(result);
    }
    return results;
  }

  /** Deposit/withdraw history for `user`, most recent first. */
  async getUserHistory(user: string, opts?: { sinceLedger?: number }): Promise<LuckyPoolEvent[]> {
    const latest = await this.server.getLatestLedger();
    const startLedger =
      opts?.sinceLedger ?? Math.max(1, latest.sequence - DEFAULT_EVENT_LOOKBACK_LEDGERS);

    const response = await this.server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [this.config.contractId],
          topics: [topicFilter("LuckyPool", "deposit"), topicFilter("LuckyPool", "withdraw")],
        },
      ],
      limit: 200,
    });

    const events: LuckyPoolEvent[] = [];
    for (const evt of response.events) {
      const topics = evt.topic.map((t) => scValToNative(t));
      const kind = topics[1] as string;
      const data = scValToNative(evt.value) as Record<string, unknown>;
      if (String(data.user) !== user) continue;

      if (kind === "deposit") {
        events.push({
          type: "Deposit",
          user,
          amount: data.amount as bigint,
          round: Number(data.round),
          ledger: evt.ledger,
          ledgerClosedAt: evt.ledgerClosedAt,
          txHash: evt.txHash,
        });
      } else if (kind === "withdraw") {
        events.push({
          type: "Withdraw",
          user,
          amount: data.amount as bigint,
          ledger: evt.ledger,
          ledgerClosedAt: evt.ledgerClosedAt,
          txHash: evt.txHash,
        });
      }
    }

    return events.sort((a, b) => b.ledger - a.ledger);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private get networkPassphrase(): string {
    return NETWORK_PASSPHRASES[this.config.network];
  }

  private async simulate<T>(
    method: string,
    args: xdr.ScVal[],
    parse: (value: unknown) => T,
  ): Promise<T> {
    const contract = new Contract(this.config.contractId);
    const account = new Account(SIMULATION_KEYPAIR.publicKey(), "0");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`${method} simulation failed: ${sim.error}`);
    }
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
      throw new Error(`${method} simulation did not return a result`);
    }

    return parse(scValToNative(sim.result.retval));
  }

  private async invoke(method: string, args: xdr.ScVal[]): Promise<InvocationResult> {
    const sourceAddress = await this.config.signer.getAddress();
    const account = await this.server.getAccount(sourceAddress);
    const contract = new Contract(this.config.contractId);

    const built = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    const prepared = await this.server.prepareTransaction(built);

    const signedXdr = await this.config.signer.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);

    const sendResult = await this.server.sendTransaction(signed);
    if (sendResult.status === "ERROR") {
      throw new Error(`Failed to submit ${method}: ${JSON.stringify(sendResult.errorResult)}`);
    }

    return this.pollForResult(sendResult.hash);
  }

  private async pollForResult(hash: string): Promise<InvocationResult> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const tx = await this.server.getTransaction(hash);
      if (tx.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { returnValue: tx.returnValue, txHash: hash, createdAt: tx.createdAt };
      }
      if (tx.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction ${hash} failed on-chain`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out waiting for transaction ${hash} to confirm`);
  }
}
