import asyncio
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from sdk.rediopy.contract.contract import RedioContract


async def main():
    client = RedioContract("https://api.devnet.solana.com")

    merchant = Keypair()
    usdc_mint = Pubkey.from_string(
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" # USDC devnet (circln)
    )  

    ix = client.initialize_pool_ix(
        merchant=merchant,
        usdc_mint=usdc_mint,
        commission_rate=500,  # 5%
        initial_deposit=1000000,  # 6 decimals
    )

    signature = await client.send_transaction(ix, merchant)
    print(f"Pool initialized: {signature}")


if __name__ == "__main__":
    asyncio.run(main())
