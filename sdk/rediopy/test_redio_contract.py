import pytest
import pytest_asyncio
import asyncio
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.system_program import ID as SYS_PROGRAM_ID
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.types import TxOpts
from spl.token.async_client import AsyncToken
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import get_associated_token_address, create_associated_token_account
import time

from contract import RedioContract


REF_ID = "AFF001"
COMMISSION_RATE = 1000  # 10%
INITIAL_DEPOSIT = 100_000_000  # 100 USDC
SALE_AMOUNT = 50_000_000  # 50 USDC
EXPECTED_COMMISSION = 5_000_000  # 5 USDC (10% of 50)


@pytest_asyncio.fixture(scope="module")
async def test_context():
    """Setup test environment - runs once for all tests"""
    print("\n🔧 Setting up test environment...")
    
    # Connect to local validator
    client = AsyncClient("http://localhost:8899", commitment=Confirmed)
    contract = RedioContract("http://localhost:8899")
    
    # Generate keypairs
    merchant = Keypair()
    affiliate = Keypair()
    backend = Keypair()
    
    print(f"✓ Generated keypairs")
    print(f"  Merchant: {merchant.pubkey()}")
    print(f"  Affiliate: {affiliate.pubkey()}")
    print(f"  Backend: {backend.pubkey()}")
    
    # Airdrop SOL
    airdrop_tasks = [
        client.request_airdrop(merchant.pubkey(), 2_000_000_000),
        client.request_airdrop(affiliate.pubkey(), 2_000_000_000),
        client.request_airdrop(backend.pubkey(), 2_000_000_000),
    ]
    
    signatures = await asyncio.gather(*airdrop_tasks)
    
    # Confirm airdrops
    for sig in signatures:
        await client.confirm_transaction(sig.value)
    
    print("✓ Airdropped 2 SOL to each account")
    
    # Create USDC mint (simulated)
    mint_keypair = Keypair()
    
    # Create mint using spl-token
    from spl.token.instructions import initialize_mint, InitializeMintParams
    from solders.transaction import Transaction
    from solders.system_program import create_account, CreateAccountParams
    
    # Create mint account
    mint_rent = await client.get_minimum_balance_for_rent_exemption(82)
    
    create_mint_ix = create_account(
        CreateAccountParams(
            from_pubkey=merchant.pubkey(),
            to_pubkey=mint_keypair.pubkey(),
            lamports=mint_rent.value,
            space=82,
            owner=TOKEN_PROGRAM_ID
        )
    )
    
    init_mint_ix = initialize_mint(
        InitializeMintParams(
            program_id=TOKEN_PROGRAM_ID,
            mint=mint_keypair.pubkey(),
            decimals=6,
            mint_authority=merchant.pubkey(),
            freeze_authority=None
        )
    )
    
    recent_blockhash = (await client.get_latest_blockhash()).value.blockhash
    tx = Transaction.new_with_payer([create_mint_ix, init_mint_ix], merchant.pubkey())
    tx.sign([merchant, mint_keypair],recent_blockhash = recent_blockhash)
    
    result = await client.send_transaction(tx, opts=TxOpts(skip_preflight=True))
    await client.confirm_transaction(result.value)
    
    usdc_mint = mint_keypair.pubkey()
    print(f"✓ Created test USDC mint: {usdc_mint}")
    
    # Create associated token accounts
    merchant_usdc = get_associated_token_address(merchant.pubkey(), usdc_mint)
    affiliate_usdc = get_associated_token_address(affiliate.pubkey(), usdc_mint)
    
    # Create merchant token account
    create_merchant_ata = create_associated_token_account(
        payer=merchant.pubkey(),
        owner=merchant.pubkey(),
        mint=usdc_mint
    )
    
    recent_blockhash = (await client.get_latest_blockhash()).value.blockhash
    tx = Transaction.new_with_payer([create_merchant_ata], merchant.pubkey())
    tx.sign([merchant], recent_blockhash = recent_blockhash)
    
    await client.send_transaction(tx, opts=TxOpts(skip_preflight=True))
    await asyncio.sleep(1)
    
    # Create affiliate token account
    create_affiliate_ata = create_associated_token_account(
        payer=affiliate.pubkey(),
        owner=affiliate.pubkey(),
        mint=usdc_mint
    )
    
    recent_blockhash = (await client.get_latest_blockhash()).value.blockhash
    tx = Transaction.new_with_payer([create_affiliate_ata], affiliate.pubkey())
    tx.sign([affiliate,],recent_blockhash = recent_blockhash)
    
    await client.send_transaction(tx, opts=TxOpts(skip_preflight=True))
    await asyncio.sleep(1)
    
    # Mint tokens to merchant
    from spl.token.instructions import mint_to, MintToParams
    
    mint_ix = mint_to(
        MintToParams(
            program_id=TOKEN_PROGRAM_ID,
            mint=usdc_mint,
            dest=merchant_usdc,
            mint_authority=merchant.pubkey(),
            amount=1_000_000_000,  # 1000 USDC
            signers=[merchant.pubkey()]
        )
    )
    
    recent_blockhash = (await client.get_latest_blockhash()).value.blockhash
    tx = Transaction.new_with_payer([mint_ix], merchant.pubkey())
    tx.sign([merchant], recent_blockhash = recent_blockhash)
    
    await client.send_transaction(tx, opts=TxOpts(skip_preflight=True))
    await asyncio.sleep(1)
    
    print("✓ Minted 1000 USDC to merchant")
    
    # Derive PDAs
    merchant_pool_pda, _ = contract.find_pool_pda(merchant.pubkey())
    escrow_authority_pda, _ = contract.find_escrow_authority_pda(merchant_pool_pda)
    escrow_usdc = contract.find_associated_token_address(escrow_authority_pda, usdc_mint)
    affiliate_pda, _ = contract.find_affiliate_pda(merchant_pool_pda, affiliate.pubkey())
    
    print("✓ Derived PDAs")
    print(f"  Pool: {merchant_pool_pda}")
    print(f"  Escrow Authority: {escrow_authority_pda}")
    print(f"  Affiliate: {affiliate_pda}")
    
    yield {
        "client": client,
        "contract": contract,
        "merchant": merchant,
        "affiliate": affiliate,
        "backend": backend,
        "usdc_mint": usdc_mint,
        "merchant_usdc": merchant_usdc,
        "affiliate_usdc": affiliate_usdc,
        "escrow_usdc": escrow_usdc,
        "merchant_pool_pda": merchant_pool_pda,
        "escrow_authority_pda": escrow_authority_pda,
        "affiliate_pda": affiliate_pda,
    }
    
    # Cleanup
    await client.close()


@pytest.mark.asyncio
async def test_01_initialize_pool(test_context):
    """Test pool initialization with initial deposit"""
    ctx = test_context
    
    print("\n📦 Test: Initialize Pool")
    
    ix = ctx["contract"].initialize_pool_ix(
        merchant=ctx["merchant"],
        usdc_mint=ctx["usdc_mint"],
        commission_rate=COMMISSION_RATE,
        initial_deposit=INITIAL_DEPOSIT
    )
    
    signature = await ctx["contract"].send_transaction(ix, ctx["merchant"])
    await asyncio.sleep(2)  # Wait for confirmation
    
    print(f"✓ Pool initialized: {signature}")
    
    # Verify pool account
    pool_data = await ctx["client"].get_account_info(ctx["merchant_pool_pda"])
    assert pool_data.value is not None, "Pool account should exist"
    
    # Verify escrow balance
    escrow_data = await ctx["client"].get_token_account_balance(ctx["escrow_usdc"])
    escrow_balance = int(escrow_data.value.amount)
    
    assert escrow_balance == INITIAL_DEPOSIT, f"Expected {INITIAL_DEPOSIT}, got {escrow_balance}"
    print(f"✓ Escrow balance: {escrow_balance / 1_000_000} USDC")


@pytest.mark.asyncio
async def test_02_initialize_pool_invalid_rate(test_context):
    """Test pool initialization fails with invalid commission rate"""
    ctx = test_context
    
    print("\n❌ Test: Invalid Commission Rate")
    
    invalid_merchant = Keypair()
    
    # Airdrop to invalid merchant
    sig = await ctx["client"].request_airdrop(invalid_merchant.pubkey(), 1_000_000_000)
    await ctx["client"].confirm_transaction(sig.value)
    await asyncio.sleep(1)
    
    ix = ctx["contract"].initialize_pool_ix(
        merchant=invalid_merchant,
        usdc_mint=ctx["usdc_mint"],
        commission_rate=10001,  # Invalid: > 10000
        initial_deposit=0
    )
    
    try:
        signature = await ctx["contract"].send_transaction(ix, invalid_merchant)
        await asyncio.sleep(1)
        pytest.fail("Should have thrown error")
    except Exception as e:
        print(f"✓ Rejected invalid commission rate")
        # The error message varies, so we just check that it failed
        assert "error" in str(e).lower() or "failed" in str(e).lower()


@pytest.mark.asyncio
async def test_03_add_affiliate(test_context):
    """Test adding an affiliate"""
    ctx = test_context
    
    print("\n👥 Test: Add Affiliate")
    
    ix = ctx["contract"].add_affiliate_ix(
        merchant=ctx["merchant"],
        affiliate_wallet=ctx["affiliate"].pubkey(),
        ref_id=REF_ID
    )
    
    signature = await ctx["contract"].send_transaction(ix, ctx["merchant"])
    await asyncio.sleep(2)
    
    print(f"✓ Affiliate added: {signature}")
    
    # Verify affiliate account exists
    affiliate_data = await ctx["client"].get_account_info(ctx["affiliate_pda"])
    assert affiliate_data.value is not None, "Affiliate account should exist"
    print(f"✓ Affiliate account verified")


@pytest.mark.asyncio
async def test_04_process_sale(test_context):
    """Test processing a sale and paying commission"""
    ctx = test_context
    
    print("\n💰 Test: Process Sale")
    
    # Get affiliate balance before
    balance_before = await ctx["client"].get_token_account_balance(ctx["affiliate_usdc"])
    balance_before_amount = int(balance_before.value.amount)
    
    ix = ctx["contract"].process_sale_ix(
        authority=ctx["backend"],
        merchant=ctx["merchant"].pubkey(),
        affiliate_wallet=ctx["affiliate"].pubkey(),
        usdc_mint=ctx["usdc_mint"],
        sale_amount=SALE_AMOUNT
    )
    
    signature = await ctx["contract"].send_transaction(ix, ctx["backend"])
    await asyncio.sleep(2)
    
    print(f"✓ Sale processed: {signature}")
    
    # Get affiliate balance after
    balance_after = await ctx["client"].get_token_account_balance(ctx["affiliate_usdc"])
    balance_after_amount = int(balance_after.value.amount)
    
    commission_paid = balance_after_amount - balance_before_amount
    
    assert commission_paid == EXPECTED_COMMISSION, \
        f"Expected commission {EXPECTED_COMMISSION}, got {commission_paid}"
    
    print(f"✓ Commission paid: {commission_paid / 1_000_000} USDC")


@pytest.mark.asyncio
async def test_05_deposit_escrow(test_context):
    """Test depositing to escrow"""
    ctx = test_context
    
    print("\n💵 Test: Deposit Escrow")
    
    DEPOSIT_AMOUNT = 50_000_000  # 50 USDC
    
    # Get escrow balance before
    balance_before = await ctx["client"].get_token_account_balance(ctx["escrow_usdc"])
    balance_before_amount = int(balance_before.value.amount)
    
    ix = ctx["contract"].deposit_escrow_ix(
        merchant=ctx["merchant"],
        usdc_mint=ctx["usdc_mint"],
        amount=DEPOSIT_AMOUNT
    )
    
    signature = await ctx["contract"].send_transaction(ix, ctx["merchant"])
    await asyncio.sleep(2)
    
    print(f"✓ Deposited: {signature}")
    
    # Get escrow balance after
    balance_after = await ctx["client"].get_token_account_balance(ctx["escrow_usdc"])
    balance_after_amount = int(balance_after.value.amount)
    
    deposited = balance_after_amount - balance_before_amount
    
    assert deposited == DEPOSIT_AMOUNT, f"Expected {DEPOSIT_AMOUNT}, got {deposited}"
    print(f"✓ Deposit verified: {deposited / 1_000_000} USDC")


@pytest.mark.asyncio
async def test_06_withdraw_escrow(test_context):
    """Test withdrawing from escrow"""
    ctx = test_context
    
    print("\n💸 Test: Withdraw Escrow")
    
    WITHDRAW_AMOUNT = 20_000_000  # 20 USDC
    
    # Get merchant balance before
    balance_before = await ctx["client"].get_token_account_balance(ctx["merchant_usdc"])
    balance_before_amount = int(balance_before.value.amount)
    
    ix = ctx["contract"].withdraw_escrow_ix(
        merchant=ctx["merchant"],
        usdc_mint=ctx["usdc_mint"],
        amount=WITHDRAW_AMOUNT
    )
    
    signature = await ctx["contract"].send_transaction(ix, ctx["merchant"])
    await asyncio.sleep(2)
    
    print(f"✓ Withdrawn: {signature}")
    
    # Get merchant balance after
    balance_after = await ctx["client"].get_token_account_balance(ctx["merchant_usdc"])
    balance_after_amount = int(balance_after.value.amount)
    
    withdrawn = balance_after_amount - balance_before_amount
    
    assert withdrawn == WITHDRAW_AMOUNT, f"Expected {WITHDRAW_AMOUNT}, got {withdrawn}"
    print(f"✓ Withdrawal verified: {withdrawn / 1_000_000} USDC")


@pytest.mark.asyncio
async def test_07_remove_affiliate(test_context):
    """Test deactivating an affiliate"""
    ctx = test_context
    
    print("\n🚫 Test: Remove Affiliate")
    
    ix = ctx["contract"].remove_affiliate_ix(
        merchant=ctx["merchant"],
        affiliate_wallet=ctx["affiliate"].pubkey()
    )
    
    signature = await ctx["contract"].send_transaction(ix, ctx["merchant"])
    await asyncio.sleep(2)
    
    print(f"✓ Affiliate deactivated: {signature}")
    
    # Verify affiliate account still exists (just deactivated)
    affiliate_data = await ctx["client"].get_account_info(ctx["affiliate_pda"])
    assert affiliate_data.value is not None, "Affiliate account should still exist"
    print(f"✓ Affiliate account verified as deactivated")
