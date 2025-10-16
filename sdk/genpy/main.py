import json
from pathlib import Path
import subprocess
import os

# Paths
idl_path = Path("../../target/idl/redio_contract.json")
output_path = Path("./contract.json")
client_name = "../rediopy"

def fix_account(account):
    """
    Fix a single account object to match Anchor IdlAccountItem schema.
    """
    if isinstance(account, str):
        return account

    # Keep only allowed fields
    allowed_keys = {"name", "writable", "signer", "pda", "address"}
    account = {k: v for k, v in account.items() if k in allowed_keys}

    # Default writable / signer if missing
    account.setdefault('writable', False)
    account.setdefault('signer', False)

    # Flatten nested PDA seeds
    if 'pda' in account:
        pda = account['pda']
        if 'seeds' in pda:
            for seed in pda['seeds']:
                if seed.get('kind') == 'account' and 'path' in seed:
                    # Keep only the first component before a dot
                    seed['path'] = seed['path'].split('.')[0]
                # Remove any nested 'account' field in seeds
                seed.pop('account', None)
        # Ensure program is correct
        if 'program' in pda:
            prog = pda['program']
            if not (isinstance(prog, dict) and 'kind' in prog and 'value' in prog):
                pda.pop('program')
    return account

def fix_idl(idl):
    """
    Fix all instructions and their accounts.
    """
    if 'instructions' in idl:
        for instr in idl['instructions']:
            if 'accounts' in instr:
                instr['accounts'] = [fix_account(acc) for acc in instr['accounts']]
    return idl

def main():
    try:
        # Load IDL
        idl = json.loads(idl_path.read_text())
        fixed_idl = fix_idl(idl)

        # Save fixed IDL
        output_path.write_text(json.dumps(fixed_idl, indent=2))
        print(f"Fixed IDL saved to {output_path}")

        # Generate Python client using AnchorPy CLI
        print("Generating Python client with AnchorPy...")
        subprocess.run([
            "uv", "run", "anchorpy", "client-gen",
            str(output_path),
            client_name,
            "--pdas"
        ], check=True)
        print(f"Python client generated: {client_name}/")

    except subprocess.CalledProcessError as e:
        print("Error running AnchorPy client-gen:", e)
    except Exception as e:
        print("Error:", e)
    finally:
        # Remove contract.json no matter what
        try:
            output_path.unlink(missing_ok=True)
            print(f"Removed {output_path}")
        except Exception as e:
            print(f"Could not remove {output_path}: {e}")

if __name__ == "__main__":
    main()
