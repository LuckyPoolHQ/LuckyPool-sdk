import { DrawEngine } from "../src";
import type { StellarSigner } from "../src";

// Any object implementing this shape works — Freighter, xBull, a server-side
// keypair signer, etc. This example stubs a signer for illustration only.
declare const signer: StellarSigner;

async function main() {
  const engine = new DrawEngine({
    network: "testnet",
    contractId: "CA...", // deployed LuckyPool / DrawEngine-compatible contract
    signer,
  });

  // Register participants ahead of a draw. Each entrant's ticket count
  // determines their odds — see docs/randomness.md in LuckyPool-docs for
  // the winner-selection algorithm.
  await engine.addEntrants([
    { address: "GABC...", tickets: 100 },
    { address: "GDEF...", tickets: 25 },
  ]);

  // Trigger the draw. This submits a transaction, waits for confirmation,
  // and parses the on-chain result.
  const result = await engine.draw();
  console.log(`Winner: ${result.winner}`);
  console.log(`VRF proof: ${result.vrfProof}`);
  console.log(`Tx: ${result.txHash}`);

  // Look up a past draw by transaction hash.
  const past = await engine.getResult(result.txHash);
  console.log(past);
}

main().catch(console.error);
