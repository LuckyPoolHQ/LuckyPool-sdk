import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

const { mockServer } = vi.hoisted(() => ({
  mockServer: {
    getAccount: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
    simulateTransaction: vi.fn(),
    getLatestLedger: vi.fn(),
    getEvents: vi.fn(),
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

// Imported after the mock so LuckyPoolClient picks up the mocked rpc.Server.
const { LuckyPoolClient, usdcToStroops, stroopsToUsdc, STROOP } = await import(
  "../src/LuckyPoolClient"
);

const CONTRACT_ID = Address.contract(Buffer.alloc(32, 7)).toString();
const SOURCE_KEYPAIR = Keypair.random();
const SOURCE_ADDRESS = SOURCE_KEYPAIR.publicKey();
const OTHER_ADDRESS = Keypair.random().publicKey();

const passThroughSigner = {
  getAddress: vi.fn(async () => SOURCE_ADDRESS),
  signTransaction: vi.fn(async (unsignedXdr: string) => unsignedXdr),
};

function scMap(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(fields).map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(key, { type: "symbol" }),
          val,
        }),
    ),
  );
}

function poolStateScVal(overrides: Record<string, xdr.ScVal> = {}): xdr.ScVal {
  return scMap({
    admin: new Address(SOURCE_ADDRESS).toScVal(),
    usdc: new Address(OTHER_ADDRESS).toScVal(),
    blend_pool: new Address(OTHER_ADDRESS).toScVal(),
    oracle: new Address(OTHER_ADDRESS).toScVal(),
    total_deposits: nativeToScVal(1_000n, { type: "i128" }),
    prize_pool: nativeToScVal(50n, { type: "i128" }),
    current_round: nativeToScVal(3, { type: "u64" }),
    last_draw_ledger: nativeToScVal(100, { type: "u32" }),
    protocol_fee_bps: nativeToScVal(500, { type: "u32" }),
    paused: nativeToScVal(false, { type: "bool" }),
    draw_requested: nativeToScVal(false, { type: "bool" }),
    round_seed: nativeToScVal(Buffer.alloc(32, 1), { type: "bytes" }),
    ...overrides,
  });
}

// isSimulationSuccess() gates on "transactionData" in sim — a real response
// always has it (even if we don't care about its contents here).
function simResult(retval: xdr.ScVal) {
  return { transactionData: {}, result: { retval } };
}

function roundResultScVal(overrides: Record<string, xdr.ScVal> = {}): xdr.ScVal {
  return scMap({
    round: nativeToScVal(2, { type: "u64" }),
    winner: new Address(OTHER_ADDRESS).toScVal(),
    prize: nativeToScVal(42n, { type: "i128" }),
    total_tickets: nativeToScVal(99n, { type: "i128" }),
    draw_ledger: nativeToScVal(90, { type: "u32" }),
    ...overrides,
  });
}

function addressAuthEntry(address: string): xdr.SorobanAuthorizationEntry {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(CONTRACT_ID).toScAddress(),
        functionName: "set_admin",
        args: [],
      }),
    ),
    subInvocations: [],
  });
  const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: new Address(address).toScAddress(),
      nonce: new xdr.Int64(0),
      signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVoid(),
    }),
  );
  return new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation: invocation });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockServer.getAccount.mockResolvedValue(new Account(SOURCE_ADDRESS, "100"));
  mockServer.prepareTransaction.mockImplementation(async (tx: unknown) => tx);
});

describe("usdcToStroops / stroopsToUsdc", () => {
  it("round-trips through STROOP precision", () => {
    expect(STROOP).toBe(10_000_000);
    expect(usdcToStroops(12.5)).toBe(125_000_000n);
    expect(stroopsToUsdc(125_000_000n)).toBe(12.5);
  });
});

describe("LuckyPoolClient writes", () => {
  it("submits deposit with the real contract's method name and args", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "dep123" });
    mockServer.getTransaction.mockResolvedValue({ status: "SUCCESS", createdAt: 1 });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const txHash = await client.deposit(SOURCE_ADDRESS, 10);

    expect(txHash).toBe("dep123");
    const submittedTx = mockServer.prepareTransaction.mock.calls[0][0];
    const op = submittedTx.operations[0].func.invokeContract();
    expect(op.functionName().toString()).toBe("deposit");
  });

  it("submits withdraw with the real contract's method name", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "wd123" });
    mockServer.getTransaction.mockResolvedValue({ status: "SUCCESS", createdAt: 1 });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await client.withdraw(SOURCE_ADDRESS, 5);

    const submittedTx = mockServer.prepareTransaction.mock.calls[0][0];
    const op = submittedTx.operations[0].func.invokeContract();
    expect(op.functionName().toString()).toBe("withdraw");
  });

  it("submits harvest_yield and request_draw as no-arg permissionless calls", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "h1" });
    mockServer.getTransaction.mockResolvedValue({ status: "SUCCESS", createdAt: 1 });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await client.harvestYield();
    let op = mockServer.prepareTransaction.mock.calls[0][0].operations[0].func.invokeContract();
    expect(op.functionName().toString()).toBe("harvest_yield");
    expect(op.args()).toHaveLength(0);

    await client.requestDraw();
    op = mockServer.prepareTransaction.mock.calls[1][0].operations[0].func.invokeContract();
    expect(op.functionName().toString()).toBe("request_draw");
  });

  it("submits execute_draw with hex-decoded vrf_output/vrf_proof bytes", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "ex1" });
    mockServer.getTransaction.mockResolvedValue({ status: "SUCCESS", createdAt: 1 });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await client.executeDraw("aa".repeat(32), "bb".repeat(10));

    const op = mockServer.prepareTransaction.mock.calls[0][0].operations[0].func.invokeContract();
    expect(op.functionName().toString()).toBe("execute_draw");
    const [vrfOutputArg, vrfProofArg] = op.args();
    expect(Buffer.from(vrfOutputArg.bytes()).toString("hex")).toBe("aa".repeat(32));
    expect(Buffer.from(vrfProofArg.bytes()).toString("hex")).toBe("bb".repeat(10));
  });

  it("throws a descriptive error when the RPC rejects submission", async () => {
    mockServer.sendTransaction.mockResolvedValue({
      status: "ERROR",
      errorResult: { message: "insufficient fee" },
    });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await expect(client.deposit(SOURCE_ADDRESS, 1)).rejects.toThrow(/Failed to submit deposit/);
  });

  it("throws when the transaction fails on-chain", async () => {
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "failhash" });
    mockServer.getTransaction.mockResolvedValue({ status: "FAILED" });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    await expect(client.withdraw(SOURCE_ADDRESS, 1)).rejects.toThrow(/failed on-chain/);
  });

  it("times out if the transaction never confirms", async () => {
    vi.useFakeTimers();
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "stuck" });
    mockServer.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const drawPromise = client.requestDraw();
    const assertion = expect(drawPromise).rejects.toThrow(/Timed out waiting/);

    await vi.runAllTimersAsync();
    await assertion;

    vi.useRealTimers();
  });
});

// Builds a real, unsigned `set_admin` transaction with the given auth
// entries attached — a genuine Transaction (not a stub), because
// LuckyPoolClient.setAdmin mutates operations[0].auth in place and relies on
// that mutation flowing through to the serialized XDR, exactly like
// @stellar/stellar-sdk's own AssembledTransaction.signAuthEntries() does.
function buildSetAdminTx(newAdmin: string, auth: xdr.SorobanAuthorizationEntry[]) {
  const account = new Account(SOURCE_ADDRESS, "100");
  const op = Operation.invokeContractFunction({
    contract: CONTRACT_ID,
    function: "set_admin",
    args: [new Address(newAdmin).toScVal()],
    auth,
  });
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(30)
    .build();
}

describe("LuckyPoolClient.setAdmin", () => {
  it("submits without requiring a co-signer when no address-auth entry is needed", async () => {
    // Default beforeEach passthrough is fine — the client's own built tx has
    // no auth entries attached (simulation would fill those in on a real RPC).
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "admin1" });
    mockServer.getTransaction.mockResolvedValue({ status: "SUCCESS", createdAt: 1 });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const newAdminSigner = { getAddress: vi.fn(async () => OTHER_ADDRESS) };
    const txHash = await client.setAdmin(OTHER_ADDRESS, newAdminSigner as never);
    expect(txHash).toBe("admin1");
  });

  it("throws a clear error when co-authorization is required but no signAuthEntry is provided", async () => {
    const entry = addressAuthEntry(OTHER_ADDRESS);
    mockServer.prepareTransaction.mockImplementation(async () => buildSetAdminTx(OTHER_ADDRESS, [entry]));

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const newAdminSigner = { getAddress: vi.fn(async () => OTHER_ADDRESS) };
    await expect(client.setAdmin(OTHER_ADDRESS, newAdminSigner as never)).rejects.toThrow(
      /requires newAdminSigner.signAuthEntry/,
    );
  });

  it("signs the new admin's auth entry via signAuthEntry before submitting", async () => {
    const newAdminKeypair = Keypair.random();
    const newAdminAddress = newAdminKeypair.publicKey();
    const entry = addressAuthEntry(newAdminAddress);

    let preparedTx: ReturnType<typeof buildSetAdminTx> | undefined;
    mockServer.prepareTransaction.mockImplementation(async () => {
      preparedTx = buildSetAdminTx(newAdminAddress, [entry]);
      return preparedTx;
    });
    mockServer.getLatestLedger.mockResolvedValue({ sequence: 1000 });
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "admin2" });
    mockServer.getTransaction.mockResolvedValue({ status: "SUCCESS", createdAt: 1 });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    // `entryXdr` here is the base64 HashIdPreimage stellar-sdk's own
    // authorizeEntry() hands to the signer callback — a real wallet's
    // signAuthEntry signs sha256(preimage) and returns the raw signature,
    // base64-encoded. See @stellar/stellar-base's auth.js authorizeEntry().
    const signAuthEntry = vi.fn(async (entryXdr: string) => {
      const payload = require("crypto")
        .createHash("sha256")
        .update(Buffer.from(entryXdr, "base64"))
        .digest();
      return newAdminKeypair.sign(payload).toString("base64");
    });

    const newAdminSigner = { getAddress: vi.fn(async () => newAdminAddress), signAuthEntry };

    const txHash = await client.setAdmin(newAdminAddress, newAdminSigner as never);

    expect(txHash).toBe("admin2");
    expect(signAuthEntry).toHaveBeenCalledTimes(1);
    // The entry in place should now carry a real signature, not the stub scvVoid().
    const signedCredentials = preparedTx!.operations[0].auth![0].credentials().address();
    expect(signedCredentials.signature().switch().name).not.toBe("scvVoid");
  });
});

describe("LuckyPoolClient views", () => {
  it("parses get_pool_state into typed bigint/hex fields", async () => {
    mockServer.simulateTransaction.mockResolvedValue(simResult(poolStateScVal()));

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const state = await client.getPoolState();
    expect(state.totalDeposits).toBe(1_000n);
    expect(state.prizePool).toBe(50n);
    expect(state.currentRound).toBe(3);
    expect(state.roundSeed).toBe("01".repeat(32));
    expect(state.drawRequested).toBe(false);
  });

  it("parses get_position into typed bigint fields", async () => {
    mockServer.simulateTransaction.mockResolvedValue(
      simResult(
        scMap({
          principal: nativeToScVal(300_000_000n, { type: "i128" }),
          tickets: nativeToScVal(30n, { type: "i128" }),
          round_joined: nativeToScVal(2, { type: "u64" }),
        }),
      ),
    );

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const pos = await client.getPosition(SOURCE_ADDRESS);
    expect(pos.principal).toBe(300_000_000n);
    expect(pos.tickets).toBe(30n);
    expect(pos.roundJoined).toBe(2);
  });

  it("returns null for get_round_result on an undrawn round", async () => {
    mockServer.simulateTransaction.mockResolvedValue(simResult(xdr.ScVal.scvVoid()));

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    expect(await client.getRoundResult(999)).toBeNull();
  });

  it("parses a populated get_round_result", async () => {
    mockServer.simulateTransaction.mockResolvedValue(simResult(roundResultScVal()));

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const result = await client.getRoundResult(2);
    expect(result?.prize).toBe(42n);
    expect(result?.totalTickets).toBe(99n);
  });

  it("walks getRecentRounds backwards from currentRound, skipping gaps", async () => {
    mockServer.simulateTransaction.mockImplementation(async (tx) => {
      const op = tx.operations[0].func.invokeContract();
      const fn = op.functionName().toString();
      if (fn === "get_pool_state") {
        return simResult(poolStateScVal({ current_round: nativeToScVal(4, { type: "u64" }) }));
      }
      // get_round_result(round)
      const { scValToNative } = await import("@stellar/stellar-sdk");
      const round = Number(scValToNative(op.args()[0]));
      if (round === 2) {
        // simulate a gap: round 2 was never drawn
        return simResult(xdr.ScVal.scvVoid());
      }
      return simResult(roundResultScVal({ round: nativeToScVal(round, { type: "u64" }) }));
    });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const rounds = await client.getRecentRounds(2);
    expect(rounds.map((r) => r.round)).toEqual([3, 1]);
  });

  it("filters getUserHistory to the requested user and parses deposit/withdraw events", async () => {
    mockServer.getLatestLedger.mockResolvedValue({ sequence: 5_000_000 });
    const { scValToNative: realScValToNative } = await import("@stellar/stellar-sdk");
    void realScValToNative;

    mockServer.getEvents.mockResolvedValue({
      events: [
        {
          topic: [xdr.ScVal.scvSymbol("LuckyPool"), xdr.ScVal.scvSymbol("deposit")],
          value: scMap({
            user: new Address(SOURCE_ADDRESS).toScVal(),
            amount: nativeToScVal(100_000_000n, { type: "i128" }),
            round: nativeToScVal(3, { type: "u64" }),
          }),
          ledger: 100,
          ledgerClosedAt: "2026-01-01T00:00:00Z",
          txHash: "dep-evt",
        },
        {
          topic: [xdr.ScVal.scvSymbol("LuckyPool"), xdr.ScVal.scvSymbol("deposit")],
          value: scMap({
            user: new Address(OTHER_ADDRESS).toScVal(),
            amount: nativeToScVal(50_000_000n, { type: "i128" }),
            round: nativeToScVal(3, { type: "u64" }),
          }),
          ledger: 101,
          ledgerClosedAt: "2026-01-01T00:01:00Z",
          txHash: "other-user-evt",
        },
        {
          topic: [xdr.ScVal.scvSymbol("LuckyPool"), xdr.ScVal.scvSymbol("withdraw")],
          value: scMap({
            user: new Address(SOURCE_ADDRESS).toScVal(),
            amount: nativeToScVal(20_000_000n, { type: "i128" }),
          }),
          ledger: 102,
          ledgerClosedAt: "2026-01-01T00:02:00Z",
          txHash: "wd-evt",
        },
      ],
    });

    const client = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });

    const history = await client.getUserHistory(SOURCE_ADDRESS);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ type: "Withdraw", txHash: "wd-evt", amount: 20_000_000n });
    expect(history[1]).toMatchObject({ type: "Deposit", txHash: "dep-evt", amount: 100_000_000n });
  });
});

describe("LuckyPoolClient.rpcUrl", () => {
  it("exposes the correct endpoint per network, and honors an override", () => {
    const testnet = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });
    const mainnet = new LuckyPoolClient({
      network: "mainnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
    });
    const overridden = new LuckyPoolClient({
      network: "testnet",
      contractId: CONTRACT_ID,
      signer: passThroughSigner,
      rpcUrl: "https://custom-rpc.example.com",
    });

    expect(testnet.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(mainnet.rpcUrl).toBe("https://soroban-mainnet.stellar.org");
    expect(overridden.rpcUrl).toBe("https://custom-rpc.example.com");
  });
});
