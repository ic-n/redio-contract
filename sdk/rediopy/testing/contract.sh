#!/bin/bash

# Setup script for running tests against local validator

echo "🚀 Setting up test environment..."

# Check if solana-test-validator is running
if ! lsof -i :8899 > /dev/null 2>&1; then
    echo "❌ Error: solana-test-validator is not running on port 8899"
    echo "Please start it in a separate terminal with: solana-test-validator"
    exit 1
fi

echo "✓ Test validator is running"

# Get the program ID from the declare_id! macro
PROGRAM_ID="8fYScBcM23tUV4fPTXo994qMpyJ86LZR7P3cU8TghY73"

echo "📦 Program ID: $PROGRAM_ID"

# Check if we need to build the program
if [ ! -f "../../target/deploy/redio_contract.so" ]; then
    echo "🔨 Building program..."
    cd ../..
    anchor build
    cd sdk/rediopy
fi

# Deploy the program to local validator
echo "🚢 Deploying program to test validator..."

# First, check if program is already deployed
PROGRAM_EXISTS=$(solana account $PROGRAM_ID --url http://localhost:8899 2>&1 | grep -c "Account does not exist")

if [ $PROGRAM_EXISTS -eq 0 ]; then
    echo "⚠️  Program already deployed, upgrading..."
else
    echo "📝 First time deployment..."
fi

# Deploy/upgrade the program
solana program deploy \
    ../../target/deploy/redio_contract.so \
    --program-id ../../target/deploy/redio_contract-keypair.json \
    --url http://localhost:8899

if [ $? -eq 0 ]; then
    echo "✅ Program deployed successfully!"
    echo ""
    echo "Now you can run the tests with:"
    echo "  uv run pytest test_redio_contract.py -v -s"
else
    echo "❌ Failed to deploy program"
    exit 1
fi