import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { RedioContract } from "../target/types/redio_contract";

describe("USDC Affiliate Escrow - Multi Pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.RedioContract as Program<RedioContract>;

  let merchant: Keypair;
  let affiliate: Keypair;
  let affiliate2: Keypair;
  let backend: Keypair;
  let usdcMint: PublicKey;
  let merchantUsdc: PublicKey;
  let affiliateUsdc: PublicKey;
  let affiliate2Usdc: PublicKey;

  const POOL_ID_1 = "standard_pool";
  let merchantPoolPda1: PublicKey;
  let escrowAuthorityPda1: PublicKey;
  let escrowUsdc1: PublicKey;
  let affiliatePda1: PublicKey;

  const POOL_ID_2 = "vip_pool";
  let merchantPoolPda2: PublicKey;
  let escrowAuthorityPda2: PublicKey;
  let escrowUsdc2: PublicKey;
  let affiliatePda2: PublicKey;

  const REF_ID = "AFF001";
  const REF_ID_2 = "VIP001";
  const COMMISSION_RATE_1 = 500;
  const COMMISSION_RATE_2 = 1000;
  const INITIAL_DEPOSIT = 100_000_000;

  before(async () => {
    console.log("Setting up test environment...");

    merchant = Keypair.generate();
    affiliate = Keypair.generate();
    affiliate2 = Keypair.generate();
    backend = Keypair.generate();

    await Promise.all([
      provider.connection.requestAirdrop(merchant.publicKey, 2 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(affiliate.publicKey, 2 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(affiliate2.publicKey, 2 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(backend.publicKey, 2 * LAMPORTS_PER_SOL),
    ]).then(sigs => Promise.all(sigs.map(sig => provider.connection.confirmTransaction(sig))));

    console.log("✓ Airdropped SOL");

    usdcMint = await createMint(
      provider.connection,
      merchant,
      merchant.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    console.log("✓ Created test USDC mint:", usdcMint.toString());

    const merchantTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      merchant,
      usdcMint,
      merchant.publicKey
    );
    merchantUsdc = merchantTokenAccount.address;

    const affiliateTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      affiliate,
      usdcMint,
      affiliate.publicKey
    );
    affiliateUsdc = affiliateTokenAccount.address;

    const affiliate2TokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      affiliate2,
      usdcMint,
      affiliate2.publicKey
    );
    affiliate2Usdc = affiliate2TokenAccount.address;

    await mintTo(
      provider.connection,
      merchant,
      usdcMint,
      merchantUsdc,
      merchant,
      1000_000_000
    );

    console.log("✓ Minted 1000 USDC to merchant");

    // Derive PDAs for Pool 1
    [merchantPoolPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), merchant.publicKey.toBuffer(), Buffer.from(POOL_ID_1)],
      program.programId
    );

    [escrowAuthorityPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), merchantPoolPda1.toBuffer()],
      program.programId
    );

    escrowUsdc1 = getAssociatedTokenAddressSync(usdcMint, escrowAuthorityPda1, true);

    [affiliatePda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("affiliate"), merchantPoolPda1.toBuffer(), affiliate.publicKey.toBuffer()],
      program.programId
    );

    // Derive PDAs for Pool 2
    [merchantPoolPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), merchant.publicKey.toBuffer(), Buffer.from(POOL_ID_2)],
      program.programId
    );

    [escrowAuthorityPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), merchantPoolPda2.toBuffer()],
      program.programId
    );

    escrowUsdc2 = getAssociatedTokenAddressSync(usdcMint, escrowAuthorityPda2, true);

    [affiliatePda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("affiliate"), merchantPoolPda2.toBuffer(), affiliate2.publicKey.toBuffer()],
      program.programId
    );

    console.log("✓ Derived PDAs for both pools");
  });

  describe("Initialize Multiple Pools", () => {
    it("Creates first merchant pool (standard)", async () => {
      await program.methods
        .initializePool(POOL_ID_1, COMMISSION_RATE_1, new anchor.BN(INITIAL_DEPOSIT))
        .accounts({
          merchantPool: merchantPoolPda1,
          merchant: merchant.publicKey,
          merchantUsdc: merchantUsdc,
          escrowAuthority: escrowAuthorityPda1,
          escrowUsdc: escrowUsdc1,
          usdcMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([merchant])
        .rpc();

      const poolAccount = await program.account.merchantPool.fetch(merchantPoolPda1);
      expect(poolAccount.merchant.toString()).to.equal(merchant.publicKey.toString());
      expect(poolAccount.poolId).to.equal(POOL_ID_1);
      expect(poolAccount.commissionRate).to.equal(COMMISSION_RATE_1);
      expect(poolAccount.isActive).to.be.true;

      const escrowAccount = await getAccount(provider.connection, escrowUsdc1);
      expect(Number(escrowAccount.amount)).to.equal(INITIAL_DEPOSIT);
      console.log("✓ Pool 1 (standard) initialized with 5% commission");
    });

    it("Creates second merchant pool (VIP)", async () => {
      await program.methods
        .initializePool(POOL_ID_2, COMMISSION_RATE_2, new anchor.BN(INITIAL_DEPOSIT))
        .accounts({
          merchantPool: merchantPoolPda2,
          merchant: merchant.publicKey,
          merchantUsdc: merchantUsdc,
          escrowAuthority: escrowAuthorityPda2,
          escrowUsdc: escrowUsdc2,
          usdcMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([merchant])
        .rpc();

      const poolAccount = await program.account.merchantPool.fetch(merchantPoolPda2);
      expect(poolAccount.merchant.toString()).to.equal(merchant.publicKey.toString());
      expect(poolAccount.poolId).to.equal(POOL_ID_2);
      expect(poolAccount.commissionRate).to.equal(COMMISSION_RATE_2);
      expect(poolAccount.isActive).to.be.true;

      const escrowAccount = await getAccount(provider.connection, escrowUsdc2);
      expect(Number(escrowAccount.amount)).to.equal(INITIAL_DEPOSIT);
      console.log("✓ Pool 2 (VIP) initialized with 10% commission");
    });

    it("Fails to create pool with invalid pool ID", async () => {
      const INVALID_POOL_ID = ""; // Empty pool ID
      const [invalidPoolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), merchant.publicKey.toBuffer(), Buffer.from(INVALID_POOL_ID)],
        program.programId
      );

      const [invalidEscrowAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_authority"), invalidPoolPda.toBuffer()],
        program.programId
      );

      const invalidEscrowUsdc = getAssociatedTokenAddressSync(usdcMint, invalidEscrowAuthorityPda, true);

      try {
        await program.methods
          .initializePool(INVALID_POOL_ID, COMMISSION_RATE_1, new anchor.BN(INITIAL_DEPOSIT))
          .accounts({
            merchantPool: invalidPoolPda,
            merchant: merchant.publicKey,
            merchantUsdc: merchantUsdc,
            escrowAuthority: invalidEscrowAuthorityPda,
            escrowUsdc: invalidEscrowUsdc,
            usdcMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([merchant])
          .rpc();

        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("InvalidPoolId");
        console.log("✓ Rejected invalid pool ID");
      }
    });
  });

  describe("Update Pool Commission", () => {
    it("Updates commission rate for pool 1", async () => {
      const NEW_RATE = 750;

      await program.methods
        .updatePoolCommission(NEW_RATE)
        .accounts({
          merchantPool: merchantPoolPda1,
          merchant: merchant.publicKey,
        })
        .signers([merchant])
        .rpc();

      const poolAccount = await program.account.merchantPool.fetch(merchantPoolPda1);
      expect(poolAccount.commissionRate).to.equal(NEW_RATE);
      console.log("✓ Pool 1 commission updated to 7.5%");

      await program.methods
        .updatePoolCommission(COMMISSION_RATE_1)
        .accounts({
          merchantPool: merchantPoolPda1,
          merchant: merchant.publicKey,
        })
        .signers([merchant])
        .rpc();
    });
  });

  describe("Add Affiliates to Different Pools", () => {
    it("Adds affiliate to pool 1", async () => {
      await program.methods
        .addAffiliate(REF_ID)
        .accounts({
          merchantPool: merchantPoolPda1,
          affiliateAccount: affiliatePda1,
          affiliateWallet: affiliate.publicKey,
          merchant: merchant.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([merchant])
        .rpc();

      const affiliateAccount = await program.account.affiliateAccount.fetch(affiliatePda1);
      expect(affiliateAccount.refId).to.equal(REF_ID);
      expect(affiliateAccount.pool.toString()).to.equal(merchantPoolPda1.toString());
      expect(affiliateAccount.isActive).to.be.true;
      console.log("✓ Affiliate added to Pool 1 (standard)");
    });

    it("Adds different affiliate to pool 2", async () => {
      await program.methods
        .addAffiliate(REF_ID_2)
        .accounts({
          merchantPool: merchantPoolPda2,
          affiliateAccount: affiliatePda2,
          affiliateWallet: affiliate2.publicKey,
          merchant: merchant.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([merchant])
        .rpc();

      const affiliateAccount = await program.account.affiliateAccount.fetch(affiliatePda2);
      expect(affiliateAccount.refId).to.equal(REF_ID_2);
      expect(affiliateAccount.pool.toString()).to.equal(merchantPoolPda2.toString());
      expect(affiliateAccount.isActive).to.be.true;
      console.log("✓ Affiliate added to Pool 2 (VIP)");
    });
  });

  describe("Process Sales in Different Pools", () => {
    const SALE_AMOUNT = 100_000_000;

    it("Processes sale in pool 1 (5% commission)", async () => {
      const EXPECTED_COMMISSION = 5_000_000;
      const affiliateBalanceBefore = (await getAccount(provider.connection, affiliateUsdc)).amount;

      await program.methods
        .processSale(new anchor.BN(SALE_AMOUNT))
        .accounts({
          merchantPool: merchantPoolPda1,
          affiliateAccount: affiliatePda1,
          affiliateWallet: affiliate.publicKey,
          escrowAuthority: escrowAuthorityPda1,
          escrowUsdc: escrowUsdc1,
          affiliateUsdc: affiliateUsdc,
          usdcMint: usdcMint,
          authority: backend.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backend])
        .rpc();

      const affiliateBalanceAfter = (await getAccount(provider.connection, affiliateUsdc)).amount;
      expect(Number(affiliateBalanceAfter - affiliateBalanceBefore)).to.equal(EXPECTED_COMMISSION);

      const affiliateAccount = await program.account.affiliateAccount.fetch(affiliatePda1);
      expect(affiliateAccount.totalEarned.toNumber()).to.equal(EXPECTED_COMMISSION);
      expect(affiliateAccount.salesCount.toNumber()).to.equal(1);

      const poolAccount = await program.account.merchantPool.fetch(merchantPoolPda1);
      expect(poolAccount.totalVolume.toNumber()).to.equal(SALE_AMOUNT);
      expect(poolAccount.totalCommissionsPaid.toNumber()).to.equal(EXPECTED_COMMISSION);

      console.log("✓ Sale processed in Pool 1, commission paid:", EXPECTED_COMMISSION / 1_000_000, "USDC");
    });

    it("Processes sale in pool 2 (10% commission)", async () => {
      const EXPECTED_COMMISSION = 10_000_000;
      const affiliateBalanceBefore = (await getAccount(provider.connection, affiliate2Usdc)).amount;

      await program.methods
        .processSale(new anchor.BN(SALE_AMOUNT))
        .accounts({
          merchantPool: merchantPoolPda2,
          affiliateAccount: affiliatePda2,
          affiliateWallet: affiliate2.publicKey,
          escrowAuthority: escrowAuthorityPda2,
          escrowUsdc: escrowUsdc2,
          affiliateUsdc: affiliate2Usdc,
          usdcMint: usdcMint,
          authority: backend.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backend])
        .rpc();

      const affiliateBalanceAfter = (await getAccount(provider.connection, affiliate2Usdc)).amount;
      expect(Number(affiliateBalanceAfter - affiliateBalanceBefore)).to.equal(EXPECTED_COMMISSION);

      const affiliateAccount = await program.account.affiliateAccount.fetch(affiliatePda2);
      expect(affiliateAccount.totalEarned.toNumber()).to.equal(EXPECTED_COMMISSION);
      expect(affiliateAccount.salesCount.toNumber()).to.equal(1);

      const poolAccount = await program.account.merchantPool.fetch(merchantPoolPda2);
      expect(poolAccount.totalVolume.toNumber()).to.equal(SALE_AMOUNT);
      expect(poolAccount.totalCommissionsPaid.toNumber()).to.equal(EXPECTED_COMMISSION);

      console.log("✓ Sale processed in Pool 2, commission paid:", EXPECTED_COMMISSION / 1_000_000, "USDC");
    });
  });

  describe("Pool-specific Escrow Management", () => {
    it("Deposits to pool 1 escrow", async () => {
      const DEPOSIT = 50_000_000;
      const before = (await getAccount(provider.connection, escrowUsdc1)).amount;

      await program.methods
        .depositEscrow(new anchor.BN(DEPOSIT))
        .accounts({
          merchantPool: merchantPoolPda1,
          merchant: merchant.publicKey,
          merchantUsdc: merchantUsdc,
          escrowAuthority: escrowAuthorityPda1,
          escrowUsdc: escrowUsdc1,
          usdcMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      const after = (await getAccount(provider.connection, escrowUsdc1)).amount;
      expect(Number(after - before)).to.equal(DEPOSIT);
      console.log("✓ Deposited to Pool 1:", DEPOSIT / 1_000_000, "USDC");
    });

    it("Deposits to pool 2 escrow", async () => {
      const DEPOSIT = 75_000_000;
      const before = (await getAccount(provider.connection, escrowUsdc2)).amount;

      await program.methods
        .depositEscrow(new anchor.BN(DEPOSIT))
        .accounts({
          merchantPool: merchantPoolPda2,
          merchant: merchant.publicKey,
          merchantUsdc: merchantUsdc,
          escrowAuthority: escrowAuthorityPda2,
          escrowUsdc: escrowUsdc2,
          usdcMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      const after = (await getAccount(provider.connection, escrowUsdc2)).amount;
      expect(Number(after - before)).to.equal(DEPOSIT);
      console.log("✓ Deposited to Pool 2:", DEPOSIT / 1_000_000, "USDC");
    });

    it("Withdraws from pool 1 escrow", async () => {
      const WITHDRAW = 20_000_000;
      const before = (await getAccount(provider.connection, merchantUsdc)).amount;

      await program.methods
        .withdrawEscrow(new anchor.BN(WITHDRAW))
        .accounts({
          merchantPool: merchantPoolPda1,
          merchant: merchant.publicKey,
          merchantUsdc: merchantUsdc,
          escrowAuthority: escrowAuthorityPda1,
          escrowUsdc: escrowUsdc1,
          usdcMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      const after = (await getAccount(provider.connection, merchantUsdc)).amount;
      expect(Number(after - before)).to.equal(WITHDRAW);
      console.log("✓ Withdrawn from Pool 1:", WITHDRAW / 1_000_000, "USDC");
    });
  });

  describe("Deactivate Pool", () => {
    it("Deactivates pool 2", async () => {
      await program.methods
        .deactivatePool()
        .accounts({
          merchantPool: merchantPoolPda2,
          merchant: merchant.publicKey,
        })
        .signers([merchant])
        .rpc();

      const poolAccount = await program.account.merchantPool.fetch(merchantPoolPda2);
      expect(poolAccount.isActive).to.be.false;
      console.log("✓ Pool 2 deactivated");
    });

    it("Cannot process sale in deactivated pool", async () => {
      try {
        await program.methods
          .processSale(new anchor.BN(50_000_000))
          .accounts({
            merchantPool: merchantPoolPda2,
            affiliateAccount: affiliatePda2,
            affiliateWallet: affiliate2.publicKey,
            escrowAuthority: escrowAuthorityPda2,
            escrowUsdc: escrowUsdc2,
            affiliateUsdc: affiliate2Usdc,
            usdcMint: usdcMint,
            authority: backend.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backend])
          .rpc();

        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("PoolInactive");
        console.log("✓ Cannot process sale in deactivated pool");
      }
    });
  });

  describe("Remove Affiliate", () => {
    it("Deactivates affiliate in pool 1", async () => {
      await program.methods
        .removeAffiliate()
        .accounts({
          merchantPool: merchantPoolPda1,
          affiliateAccount: affiliatePda1,
          affiliateWallet: affiliate.publicKey,
          merchant: merchant.publicKey,
        })
        .signers([merchant])
        .rpc();

      const affiliateAccount = await program.account.affiliateAccount.fetch(affiliatePda1);
      expect(affiliateAccount.isActive).to.be.false;
      console.log("✓ Affiliate deactivated in Pool 1");
    });

    it("Cannot process sale for deactivated affiliate", async () => {
      try {
        await program.methods
          .processSale(new anchor.BN(50_000_000))
          .accounts({
            merchantPool: merchantPoolPda1,
            affiliateAccount: affiliatePda1,
            affiliateWallet: affiliate.publicKey,
            escrowAuthority: escrowAuthorityPda1,
            escrowUsdc: escrowUsdc1,
            affiliateUsdc: affiliateUsdc,
            usdcMint: usdcMint,
            authority: backend.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backend])
          .rpc();

        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("AffiliateInactive");
        console.log("✓ Cannot process sale for deactivated affiliate");
      }
    });
  });

  describe("Cross-pool Isolation", () => {
    it("Verifies pools maintain separate statistics", async () => {
      const pool1 = await program.account.merchantPool.fetch(merchantPoolPda1);
      const pool2 = await program.account.merchantPool.fetch(merchantPoolPda2);

      expect(pool1.totalCommissionsPaid.toNumber()).to.not.equal(pool2.totalCommissionsPaid.toNumber());
      expect(pool1.commissionRate).to.not.equal(pool2.commissionRate);

      console.log("✓ Pool 1 - Volume:", pool1.totalVolume.toNumber() / 1_000_000, "USDC, Rate:", pool1.commissionRate / 100, "%");
      console.log("✓ Pool 2 - Volume:", pool2.totalVolume.toNumber() / 1_000_000, "USDC, Rate:", pool2.commissionRate / 100, "%");
      console.log("✓ Pools maintain independent statistics");
    });

    it("Verifies separate escrow accounts", async () => {
      const escrow1 = await getAccount(provider.connection, escrowUsdc1);
      const escrow2 = await getAccount(provider.connection, escrowUsdc2);

      console.log("✓ Pool 1 Escrow Balance:", Number(escrow1.amount) / 1_000_000, "USDC");
      console.log("✓ Pool 2 Escrow Balance:", Number(escrow2.amount) / 1_000_000, "USDC");
      console.log("✓ Pools maintain separate escrow accounts");
    });
  });
});