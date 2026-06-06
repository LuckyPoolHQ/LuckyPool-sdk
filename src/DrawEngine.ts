import type { DrawEngineConfig, Entrant, DrawResult } from "./types";

const RPC_URLS: Record<string, string> = {
  mainnet: "https://soroban-mainnet.stellar.org",
  testnet: "https://soroban-testnet.stellar.org",
};

export class DrawEngine {
  private config: DrawEngineConfig;
  private entrants: Entrant[] = [];

  constructor(config: DrawEngineConfig) {
    this.config = config;
  }

  // Register participants for the next draw.
  async addEntrants(entrants: Entrant[]): Promise<void> {
    // TODO: submit to contract via Soroban RPC
    this.entrants.push(...entrants);
  }

  // Trigger a VRF draw and record the result on-chain.
  async draw(): Promise<DrawResult> {
    // TODO: invoke DrawEngine contract draw() method via Soroban RPC,
    //       sign with this.config.signer, return on-chain result
    throw new Error("draw() not yet implemented — wire up Soroban contract call here");
  }

  // Fetch a past draw result by Stellar transaction hash.
  async getResult(txHash: string): Promise<DrawResult> {
    // TODO: query Stellar Horizon / Soroban RPC for the draw record
    throw new Error(`getResult(${txHash}) not yet implemented`);
  }

  // Current RPC endpoint for this network.
  get rpcUrl(): string {
    return RPC_URLS[this.config.network];
  }
}
