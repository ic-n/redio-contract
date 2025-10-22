from pydantic import BaseModel, Field
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.system_program import ID as SYS_PROGRAM_ID
from solders.transaction import Transaction
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
import struct


class MerchantPool(BaseModel):
    merchant: str
    usdc_mint: str
    commission_rate: int = Field(ge=0, le=10000)
    total_volume: int = Field(ge=0)
    total_commissions_paid: int = Field(ge=0)
    bump: int
    escrow_bump: int


class AffiliateAccount(BaseModel):
    pool: str
    wallet: str
    ref_id: str = Field(max_length=32)
    total_earned: int = Field(ge=0)
    sales_count: int = Field(ge=0)
    is_active: bool
    bump: int
    created_at: int


class RedioContract:
    """Direct interaction with Redio smart contract"""

    PROGRAM_ID = Pubkey.from_string("CFQoHeX28aKhpgsLCSGM2zpou6RkRrwRoHVToWS2B6tQ")
    TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    )

    DISCRIMINATORS = {
        "initialize_pool": bytes([95, 180, 10, 172, 84, 174, 232, 40]),
        "add_affiliate": bytes([221, 239, 60, 159, 213, 45, 221, 87]),
        "process_sale": bytes([103, 228, 248, 104, 78, 46, 193, 82]),
        "remove_affiliate": bytes([146, 218, 182, 122, 118, 1, 69, 31]),
        "deposit_escrow": bytes([226, 112, 158, 176, 178, 118, 153, 128]),
        "withdraw_escrow": bytes([81, 84, 226, 128, 245, 47, 96, 104]),
    }

    def __init__(self, rpc_url: str):
        self.client = AsyncClient(rpc_url, commitment=Confirmed)

    @staticmethod
    def find_pool_pda(merchant: Pubkey) -> tuple[Pubkey, int]:
        """Find merchant pool PDA"""
        return Pubkey.find_program_address(
            [b"pool", bytes(merchant)], RedioContract.PROGRAM_ID
        )

    @staticmethod
    def find_escrow_authority_pda(pool: Pubkey) -> tuple[Pubkey, int]:
        """Find escrow authority PDA"""
        return Pubkey.find_program_address(
            [b"escrow_authority", bytes(pool)], RedioContract.PROGRAM_ID
        )

    @staticmethod
    def find_affiliate_pda(pool: Pubkey, wallet: Pubkey) -> tuple[Pubkey, int]:
        """Find affiliate account PDA"""
        return Pubkey.find_program_address(
            [b"affiliate", bytes(pool), bytes(wallet)], RedioContract.PROGRAM_ID
        )

    @staticmethod
    def find_associated_token_address(owner: Pubkey, mint: Pubkey) -> Pubkey:
        """Find associated token account address"""
        return Pubkey.find_program_address(
            [bytes(owner), bytes(RedioContract.TOKEN_PROGRAM_ID), bytes(mint)],
            RedioContract.ASSOCIATED_TOKEN_PROGRAM_ID,
        )[0]

    def initialize_pool_ix(
        self,
        merchant: Keypair,
        usdc_mint: Pubkey,
        commission_rate: int,
        initial_deposit: int,
    ) -> Instruction:
        """Create initialize_pool instruction"""

        pool_pda, _ = self.find_pool_pda(merchant.pubkey())
        escrow_authority, _ = self.find_escrow_authority_pda(pool_pda)
        merchant_usdc = self.find_associated_token_address(merchant.pubkey(), usdc_mint)
        escrow_usdc = self.find_associated_token_address(escrow_authority, usdc_mint)

        data = self.DISCRIMINATORS["initialize_pool"]
        data += struct.pack("<H", commission_rate)
        data += struct.pack("<Q", initial_deposit)

        accounts = [
            AccountMeta(pubkey=pool_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=merchant.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=merchant_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_authority, is_signer=False, is_writable=False),
            AccountMeta(pubkey=escrow_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=usdc_mint, is_signer=False, is_writable=False),
            AccountMeta(
                pubkey=self.TOKEN_PROGRAM_ID, is_signer=False, is_writable=False
            ),
            AccountMeta(
                pubkey=self.ASSOCIATED_TOKEN_PROGRAM_ID,
                is_signer=False,
                is_writable=False,
            ),
            AccountMeta(pubkey=SYS_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        return Instruction(self.PROGRAM_ID, data, accounts)

    def add_affiliate_ix(
        self, merchant: Keypair, affiliate_wallet: Pubkey, ref_id: str
    ) -> Instruction:
        """Create add_affiliate instruction"""

        pool_pda, _ = self.find_pool_pda(merchant.pubkey())
        affiliate_pda, _ = self.find_affiliate_pda(pool_pda, affiliate_wallet)

        ref_id_bytes = ref_id.encode("utf-8")
        data = self.DISCRIMINATORS["add_affiliate"]
        data += struct.pack("<I", len(ref_id_bytes))
        data += ref_id_bytes

        accounts = [
            AccountMeta(pubkey=pool_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=affiliate_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=affiliate_wallet, is_signer=False, is_writable=False),
            AccountMeta(pubkey=merchant.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=SYS_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        return Instruction(self.PROGRAM_ID, data, accounts)

    def process_sale_ix(
        self,
        authority: Keypair,
        merchant: Pubkey,
        affiliate_wallet: Pubkey,
        usdc_mint: Pubkey,
        sale_amount: int,
    ) -> Instruction:
        """Create process_sale instruction"""

        pool_pda, _ = self.find_pool_pda(merchant)
        affiliate_pda, _ = self.find_affiliate_pda(pool_pda, affiliate_wallet)
        escrow_authority, _ = self.find_escrow_authority_pda(pool_pda)
        escrow_usdc = self.find_associated_token_address(escrow_authority, usdc_mint)
        affiliate_usdc = self.find_associated_token_address(affiliate_wallet, usdc_mint)

        data = self.DISCRIMINATORS["process_sale"]
        data += struct.pack("<Q", sale_amount)

        accounts = [
            AccountMeta(pubkey=pool_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=affiliate_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=affiliate_wallet, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_authority, is_signer=False, is_writable=False),
            AccountMeta(pubkey=escrow_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=affiliate_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=usdc_mint, is_signer=False, is_writable=False),
            AccountMeta(pubkey=authority.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(
                pubkey=self.TOKEN_PROGRAM_ID, is_signer=False, is_writable=False
            ),
            AccountMeta(
                pubkey=self.ASSOCIATED_TOKEN_PROGRAM_ID,
                is_signer=False,
                is_writable=False,
            ),
            AccountMeta(pubkey=SYS_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        return Instruction(self.PROGRAM_ID, data, accounts)

    def remove_affiliate_ix(
        self, merchant: Keypair, affiliate_wallet: Pubkey
    ) -> Instruction:
        """Create remove_affiliate instruction"""

        pool_pda, _ = self.find_pool_pda(merchant.pubkey())
        affiliate_pda, _ = self.find_affiliate_pda(pool_pda, affiliate_wallet)

        data = self.DISCRIMINATORS["remove_affiliate"]

        accounts = [
            AccountMeta(pubkey=pool_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=affiliate_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=affiliate_wallet, is_signer=False, is_writable=True),
            AccountMeta(pubkey=merchant.pubkey(), is_signer=True, is_writable=False),
        ]

        return Instruction(self.PROGRAM_ID, data, accounts)

    def deposit_escrow_ix(
        self, merchant: Keypair, usdc_mint: Pubkey, amount: int
    ) -> Instruction:
        """Create deposit_escrow instruction"""

        pool_pda, _ = self.find_pool_pda(merchant.pubkey())
        escrow_authority, _ = self.find_escrow_authority_pda(pool_pda)
        merchant_usdc = self.find_associated_token_address(merchant.pubkey(), usdc_mint)
        escrow_usdc = self.find_associated_token_address(escrow_authority, usdc_mint)

        data = self.DISCRIMINATORS["deposit_escrow"]
        data += struct.pack("<Q", amount)

        accounts = [
            AccountMeta(pubkey=pool_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=merchant.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=merchant_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_authority, is_signer=False, is_writable=False),
            AccountMeta(pubkey=escrow_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=usdc_mint, is_signer=False, is_writable=False),
            AccountMeta(
                pubkey=self.TOKEN_PROGRAM_ID, is_signer=False, is_writable=False
            ),
        ]

        return Instruction(self.PROGRAM_ID, data, accounts)

    def withdraw_escrow_ix(
        self, merchant: Keypair, usdc_mint: Pubkey, amount: int
    ) -> Instruction:
        """Create withdraw_escrow instruction"""

        pool_pda, _ = self.find_pool_pda(merchant.pubkey())
        escrow_authority, _ = self.find_escrow_authority_pda(pool_pda)
        merchant_usdc = self.find_associated_token_address(merchant.pubkey(), usdc_mint)
        escrow_usdc = self.find_associated_token_address(escrow_authority, usdc_mint)

        data = self.DISCRIMINATORS["withdraw_escrow"]
        data += struct.pack("<Q", amount)

        accounts = [
            AccountMeta(pubkey=pool_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=merchant.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=merchant_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_authority, is_signer=False, is_writable=False),
            AccountMeta(pubkey=escrow_usdc, is_signer=False, is_writable=True),
            AccountMeta(pubkey=usdc_mint, is_signer=False, is_writable=False),
            AccountMeta(
                pubkey=self.TOKEN_PROGRAM_ID, is_signer=False, is_writable=False
            ),
        ]

        return Instruction(self.PROGRAM_ID, data, accounts)

    async def send_transaction(self, instruction: Instruction, signer: Keypair) -> str:
        """Send transaction with instruction"""
        recent_blockhash = (await self.client.get_latest_blockhash()).value.blockhash

        tx = Transaction.new_with_payer([instruction], signer.pubkey())
        tx.sign([signer], recent_blockhash=recent_blockhash)

        result = await self.client.send_transaction(tx)
        return str(result.value)
