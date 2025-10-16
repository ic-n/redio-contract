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

describe("USDC Affiliate Escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.RedioContract as Program<RedioContract>;

  let merchant: Keypair;
  let affiliate: Keypair;
  let backend: Keypair;
  let usdcMint: PublicKey;
  let merchantUsdc: PublicKey;
  let affiliateUsdc: PublicKey;
  let escrowUsdc: PublicKey;
  let merchantPoolPda: PublicKey;
  let escrowAuthorityPda: PublicKey;
  let affiliatePda: PublicKey;

  const REF_ID = "AFF001";
  const COMMISSION_RATE = 1000;
  const INITIAL_DEPOSIT = 100_000_000;

  before(async () => {
    console.log("Setting up test environment...");

    merchant = Keypair.generate();
    affiliate = Keypair.generate();
    backend = Keypair.generate();

    await Promise.all([
      provider.connection.requestAirdrop(merchant.publicKey, 2 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(affiliate.publicKey, 2 * LAMPORTS_PER_SOL),
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

    await mintTo(
      provider.connection,
      merchant,
      usdcMint,
      merchantUsdc,
      merchant,
      1000_000_000
    );

    console.log("✓ Minted 1000 USDC to merchant");

    [merchantPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), merchant.publicKey.toBuffer()],
      program.programId
    );

    [escrowAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), merchantPoolPda.toBuffer()],
      program.programId
    );

    escrowUsdc = getAssociatedTokenAddressSync(usdcMint, escrowAuthorityPda, true);

    [affiliatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("affiliate"), merchantPoolPda.toBuffer(), affiliate.publicKey.toBuffer()],
      program.programId
    );

    console.log("✓ Derived PDAs");
  });

  describe("Initialize Pool", () => {
    it("Creates merchant pool with initial deposit", async () => {
      await program.methods
        .initializePool(COMMISSION_RATE, new anchor.BN(INITIAL_DEPOSIT))
        .accounts({
          merchantPool: merchantPoolPda,
          merchant: merchant.publicKey,
          merchantUsdc: merchantUsdc,
          escrowAuthority: escrowAuthorityPda,
          escrowUsdc: escrowUsdc,
          usdcMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([merchant])
        .rpc();

      const poolAccount = await program.account.merchantPool.fetch(merchantPoolPda);
      expect(poolAccount.merchant.toString()).to.equal(merchant.publicKey.toString());
      expect(poolAccount.commissionRate).to.equal(COMMISSION_RATE);

      const escrowAccount = await getAccount(provider.connection, escrowUsdc);
      expect(Number(escrowAccount.amount)).to.equal(INITIAL_DEPOSIT);
      console.log("✓ Pool initialized");
    });

    it("Fails with invalid commission rate", async () => {
      const invalidMerchant = Keypair.generate();
      await provider.connection.requestAirdrop(invalidMerchant.publicKey, LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [invalidPoolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), invalidMerchant.publicKey.toBuffer()],
        program.programId
      );
      const invalidMerchantTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        invalidMerchant,
        usdcMint,
        invalidMerchant.publicKey
      );
      const invalidMerchantUsdc = invalidMerchantTokenAccount.address;

      const [invalidEscrowAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_authority"), invalidPoolPda.toBuffer()],
        program.programId
      );

      const invalidEscrowUsdc = getAssociatedTokenAddressSync(usdcMint, invalidEscrowAuthorityPda, true);

      try {
        await program.methods
          .initializePool(10001, new anchor.BN(0))
          .accounts({
            merchantPool: invalidPoolPda,
            merchant: invalidMerchant.publicKey,
            merchantUsdc: invalidMerchantUsdc,
            escrowAuthority: invalidEscrowAuthorityPda,
            escrowUsdc: invalidEscrowUsdc,
            usdcMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([invalidMerchant])
          .rpc();

        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("InvalidCommissionRate");
        console.log("✓ Rejected invalid commission rate");
      }
    });
  });

  describe("Add Affiliate", () => {
    it("Successfully adds affiliate", async () => {
      await program.methods
        .addAffiliate(REF_ID)
        .accounts({
          merchantPool: merchantPoolPda,
          affiliateAccount: affiliatePda,
          affiliateWallet: affiliate.publicKey,
          merchant: merchant.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([merchant])
        .rpc();

      const affiliateAccount = await program.account.affiliateAccount.fetch(affiliatePda);
      expect(affiliateAccount.refId).to.equal(REF_ID);
      expect(affiliateAccount.isActive).to.be.true;
      console.log("✓ Affiliate added");
    });
  });

  describe("Process Sale", () => {
    const SALE_AMOUNT = 50_000_000;
    const EXPECTED_COMMISSION = 5_000_000;

    it("Processes sale and pays commission", async () => {
      const affiliateBalanceBefore = (await getAccount(provider.connection, affiliateUsdc)).amount;

      await program.methods
        .processSale(new anchor.BN(SALE_AMOUNT))
        .accounts({
          merchantPool: merchantPoolPda,
          affiliateAccount: affiliatePda,
          affiliateWallet: affiliate.publicKey,
          escrowAuthority: escrowAuthorityPda,
          escrowUsdc: escrowUsdc,
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

      const affiliateAccount = await program.account.affiliateAccount.fetch(affiliatePda);
      expect(affiliateAccount.totalEarned.toNumber()).to.equal(EXPECTED_COMMISSION);
      expect(affiliateAccount.salesCount.toNumber()).to.equal(1);
      console.log("✓ Sale processed, commission paid:", EXPECTED_COMMISSION / 1_000_000, "USDC");
    });
  });

  describe("Deposit Escrow", () => {
    it("Merchant deposits to escrow", async () => {
      const DEPOSIT = 50_000_000;
      const before = (await getAccount(provider.connection, escrowUsdc)).amount;

      await program.methods
        .depositEscrow(new anchor.BN(DEPOSIT))
        .accounts({
          merchantPool: merchantPoolPda,
          merchant: merchant.publicKey,
          merchantUsdc: merchantUsdc,
          escrowAuthority: escrowAuthorityPda,
          escrowUsdc: escrowUsdc,
          usdcMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      const after = (await getAccount(provider.connection, escrowUsdc)).amount;
      expect(Number(after - before)).to.equal(DEPOSIT);
      console.log("✓ Deposited:", DEPOSIT / 1_000_000, "USDC");
    });
  });

  describe("Withdraw Escrow", () => {
    it("Merchant withdraws from escrow", async () => {
      const WITHDRAW = 20_000_000;
      const before = (await getAccount(provider.connection, merchantUsdc)).amount;

      await program.methods
        .withdrawEscrow(new anchor.BN(WITHDRAW))
        .accounts({
          merchantPool: merchantPoolPda,
          merchant: merchant.publicKey,
          merchantUsdc: merchantUsdc,
          escrowAuthority: escrowAuthorityPda,
          escrowUsdc: escrowUsdc,
          usdcMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      const after = (await getAccount(provider.connection, merchantUsdc)).amount;
      expect(Number(after - before)).to.equal(WITHDRAW);
      console.log("✓ Withdrawn:", WITHDRAW / 1_000_000, "USDC");
    });
  });

  describe("Remove Affiliate", () => {
    it("Deactivates affiliate", async () => {
      await program.methods
        .removeAffiliate()
        .accounts({
          merchantPool: merchantPoolPda,
          affiliateAccount: affiliatePda,
          affiliateWallet: affiliate.publicKey,
          merchant: merchant.publicKey,
        })
        .signers([merchant])
        .rpc();

      const affiliateAccount = await program.account.affiliateAccount.fetch(affiliatePda);
      expect(affiliateAccount.isActive).to.be.false;
      console.log("✓ Affiliate deactivated");
    });
  });
});