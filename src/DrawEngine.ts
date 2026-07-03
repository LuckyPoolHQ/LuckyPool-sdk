import type { DrawEngineConfig, Entrant, DrawResult } from "./types";
import {
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

const RPC_URLS: Record<string, string> = {
  mainnet: "https://soroban-mainnet.stellar.org",
  testnet: "https://soroban-testnet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<string, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

const TX_TIMEOUT_SECONDS = 30;
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 20;

// Method names invoked on the target contract. Overridable per-deployment —
// DrawEngine is meant to front any contract exposing this shape, not only
// LuckyPool itself (it's slated to ship as a standalone package, see
// docs/plan.md Phase 3).
export interface DrawEngineMethodNames {
  addEntrants: string;
  draw: string;
}

const DEFAULT_METHODS: DrawEngineMethodNames = {
  addEntrants: "add_entrants",
  draw: "draw",
};

interface InvocationResult {
  returnValue?: xdr.ScVal;
  txHash: string;
  createdAt: number;
}

export class DrawEngine {
  private config: DrawEngineConfig;
  private methods: DrawEngineMethodNames;
  private server: rpc.Server;

  constructor(config: DrawEngineConfig & { methodNames?: Partial<DrawEngineMethodNames> }) {
    this.config = config;
    this.methods = { ...DEFAULT_METHODS, ...config.methodNames };
    this.server = new rpc.Server(RPC_URLS[config.network]);
  }

  // Register participants for the next draw.
  async addEntrants(entrants: Entrant[]): Promise<void> {
    if (entrants.length === 0) return;

    // Each entrant is encoded as an (Address, u32 tickets) tuple — the
    // conventional XDR shape for a contract argument typed Vec<(Address, u32)>.
    const arg = xdr.ScVal.scvVec(
      entrants.map((e) =>
        xdr.ScVal.scvVec([
          new Address(e.address).toScVal(),
          nativeToScVal(e.tickets, { type: "u32" }),
        ]),
      ),
    );

    await this.invoke(this.methods.addEntrants, [arg]);
  }

  // Trigger a VRF draw and record the result on-chain.
  async draw(): Promise<DrawResult> {
    const result = await this.invoke(this.methods.draw, []);
    return this.parseDrawResult(result.returnValue, result.txHash, result.createdAt);
  }

  // Fetch a past draw result by Stellar transaction hash.
  async getResult(txHash: string): Promise<DrawResult> {
    const tx = await this.server.getTransaction(txHash);
    if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Transaction ${txHash} is not a successful draw (status: ${tx.status})`);
    }
    return this.parseDrawResult(tx.returnValue, txHash, tx.createdAt);
  }

  // Current RPC endpoint for this network.
  get rpcUrl(): string {
    return RPC_URLS[this.config.network];
  }

  // ── internals ────────────────────────────────────────────────────────────

  private get networkPassphrase(): string {
    return NETWORK_PASSPHRASES[this.config.network];
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

  private parseDrawResult(
    returnValue: xdr.ScVal | undefined,
    txHash: string,
    createdAt: number,
  ): DrawResult {
    if (!returnValue) {
      throw new Error(`Transaction ${txHash} returned no value to parse as a draw result`);
    }

    const native = scValToNative(returnValue) as Record<string, unknown>;
    const winner = native.winner;
    const vrfProof = native.vrf_proof ?? native.vrfProof;
    const entrants = native.entrants ?? native.entrant_count ?? native.entrantCount ?? 0;

    return {
      winner: winner instanceof Address ? winner.toString() : String(winner),
      vrfProof: vrfProof ? Buffer.from(vrfProof as Uint8Array).toString("hex") : "",
      txHash,
      timestamp: createdAt,
      entrants: Number(entrants),
    };
  }
}
