export type Network = "mainnet" | "testnet";

export interface DrawEngineConfig {
  network: Network;
  contractId: string;
  signer: StellarSigner;
}

export interface Entrant {
  address: string;
  tickets: number;
}

export interface DrawResult {
  winner: string;
  vrfProof: string;
  txHash: string;
  timestamp: number;
  entrants: number;
}

// Minimal signer interface — compatible with Freighter and any Stellar wallet
export interface StellarSigner {
  getAddress(): Promise<string>;
  signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
}
