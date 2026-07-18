import { describe, it, expect, vi, beforeEach } from "vitest";
import { Account, Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";

const { mockServer } = vi.hoisted(() => ({
  mockServer: {
    getAccount: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  },
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn(() => mockServer),
    },
  };
});

// Imported after the mock so DrawEngine picks up the mocked rpc.Server.
const { DrawEngine } = await import("../src/DrawEngine");

const CONTRACT_ID = Address.contract(Buffer.alloc(32, 7)).toString();
const SOURCE_KEYPAIR = Keypair.random();
const SOURCE_ADDRESS = SOURCE_KEYPAIR.publicKey();
const WINNER_ADDRESS = Keypair.random().publicKey();

const passThroughSigner = {
  getAddress: vi.fn(async () => SOURCE_ADDRESS),
  signTransaction: vi.fn(async (unsignedXdr: string) => unsignedXdr),
};

function drawResultScVal(overrides: Record<string, unknown> = {}) {
  const fields = {
    winner: new Address(WINNER_ADDRESS).toScVal(),
    vrf_proof: nativeToScVal(Buffer.from("cafebabe", "hex"), { type: "bytes" }),
    entrants: nativeToScVal(7, { type: "u32" }),
    ...overrides,
  };
  return xdr.ScVal.scvMap(
    Object.entries(fields).map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(key, { type: "symbol" }),
          val: val as xdr.ScVal,
        }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockServer.getAccount.mockResolvedValue(new Account(SOURCE_ADDRESS, "100"));
  mockServer.prepareTransaction.mockImplementation(async (tx) => tx);
});

describe("DrawEngine.addEntrants", () => {
  it("is a no-op for an empty entrant list — no RPC calls made", async () => {
    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await engine.addEntrants([]);

    expect(mockServer.getAccount).not.toHaveBeenCalled();
    expect(mockServer.sendTransaction).not.toHaveBeenCalled();
  });

  it("submits an add_entrants call and waits for confirmation", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "deadbeef" });
    mockServer.getTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: undefined,
      createdAt: 1234,
    });

    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await engine.addEntrants([{ address: WINNER_ADDRESS, tickets: 3 }]);

    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    const submittedTx = mockServer.prepareTransaction.mock.calls[0][0];
    const functionName = submittedTx.operations[0].func.invokeContract().functionName().toString();
    expect(functionName).toBe("add_entrants");
  });

  it("respects a custom method name override", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "deadbeef" });
    mockServer.getTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: undefined,
      createdAt: 1234,
    });

    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
      methodNames: { addEntrants: "register_players" },
    });

    await engine.addEntrants([{ address: WINNER_ADDRESS, tickets: 1 }]);

    const submittedTx = mockServer.prepareTransaction.mock.calls[0][0];
    const functionName = submittedTx.operations[0].func.invokeContract().functionName().toString();
    expect(functionName).toBe("register_players");
  });
});

describe("DrawEngine.draw", () => {
  it("parses a successful draw into a DrawResult", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc123" });
    mockServer.getTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: drawResultScVal(),
      createdAt: 1700000000,
    });

    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const result = await engine.draw();

    expect(result.winner).toBe(WINNER_ADDRESS);
    expect(result.vrfProof).toBe("cafebabe");
    expect(result.entrants).toBe(7);
    expect(result.txHash).toBe("abc123");
    expect(result.timestamp).toBe(1700000000);
  });

  it("throws when the RPC rejects submission", async () => {
    mockServer.sendTransaction.mockResolvedValue({
      status: "ERROR",
      errorResult: { message: "insufficient fee" },
    });

    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await expect(engine.draw()).rejects.toThrow(/Failed to submit draw/);
  });

  it("throws when the transaction fails on-chain", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "failhash" });
    mockServer.getTransaction.mockResolvedValue({ status: "FAILED" });

    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await expect(engine.draw()).rejects.toThrow(/failed on-chain/);
  });

  it("throws when the return value is missing", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "novalue" });
    mockServer.getTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: undefined,
      createdAt: 1,
    });

    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await expect(engine.draw()).rejects.toThrow(/returned no value/);
  });

  it("times out if the transaction never confirms", async () => {
    vi.useFakeTimers();
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "stuck" });
    mockServer.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const drawPromise = engine.draw();
    const assertion = expect(drawPromise).rejects.toThrow(/Timed out waiting/);

    await vi.runAllTimersAsync();
    await assertion;

    vi.useRealTimers();
  });
});

describe("DrawEngine.getResult", () => {
  it("parses a past successful draw by tx hash", async () => {
    mockServer.getTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: drawResultScVal({ entrants: nativeToScVal(42, { type: "u32" }) }),
      createdAt: 999,
    });

    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const result = await engine.getResult("some-hash");

    expect(result.entrants).toBe(42);
    expect(result.txHash).toBe("some-hash");
    expect(mockServer.getTransaction).toHaveBeenCalledWith("some-hash");
  });

  it("throws a descriptive error for a non-successful transaction", async () => {
    mockServer.getTransaction.mockResolvedValue({ status: "FAILED" });

    const engine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await expect(engine.getResult("bad-hash")).rejects.toThrow(
      /is not a successful draw \(status: FAILED\)/,
    );
  });
});

describe("DrawEngine.rpcUrl", () => {
  it("exposes the correct endpoint per network", () => {
    const testnetEngine = new DrawEngine({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });
    const mainnetEngine = new DrawEngine({
      network: "mainnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    expect(testnetEngine.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(mainnetEngine.rpcUrl).toBe("https://soroban-mainnet.stellar.org");
  });
});
