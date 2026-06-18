import 'dotenv/config';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { HttpTransport, ExchangeClient } from '@nktkas/hyperliquid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

const HL_API_URL = 'https://api.hyperliquid.xyz';

function appendToEnv(key: string, value: string) {
  let content = '';
  if (existsSync(ENV_PATH)) {
    content = readFileSync(ENV_PATH, 'utf-8');
    content = content
      .split('\n')
      .filter((line) => !line.startsWith(`${key}=`))
      .join('\n');
    if (content && !content.endsWith('\n')) content += '\n';
  }
  content += `${key}=${value}\n`;
  writeFileSync(ENV_PATH, content);
}

async function main() {
  // Get master wallet address from .env
  const masterAddress = process.env.HL_MASTER_ADDRESS;

  if (!masterAddress) {
    console.error('HL_MASTER_ADDRESS not set in .env. Make sure you ran: acp agent whoami');
    process.exit(1);
  }

  console.log('Master wallet address:', masterAddress);

  // Step 1: Generate a new API wallet
  console.log('Generating new EVM wallet pair...');
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`API wallet address: ${account.address}`);

  // Step 2: Use Hyperliquid SDK's ExchangeClient to approve the agent
  // This uses the NEW wallet to sign (viem handles it, not ACP CLI)
  console.log('\nApproving agent wallet with Hyperliquid...');
  try {
    const transport = new HttpTransport({ apiUrl: HL_API_URL });
    const exchange = new ExchangeClient({ wallet: account, transport });

    // Call approveAgent to register the wallet as an agent
    // The SDK handles EIP-712 signing internally using viem
    const result = await exchange.approveAgent({
      agentAddress: masterAddress as `0x${string}`,
      agentName: 'API Wallet',
    });

    console.log('Hyperliquid response:', JSON.stringify(result, null, 2));

    if ((result as any).status === 'ok' || !(result as any).error) {
      // Step 3: Save to .env
      appendToEnv('HL_API_WALLET_KEY', privateKey);
      appendToEnv('HL_API_WALLET_ADDRESS', account.address);
      appendToEnv('HL_MASTER_ADDRESS', masterAddress);

      console.log('\n✅ API wallet registered successfully!');
      console.log(`  Private key: ${privateKey.slice(0, 10)}...${privateKey.slice(-5)}`);
      console.log(`  Address: ${account.address}`);
      console.log(`  Saved to: ${ENV_PATH}`);
      console.log('\nYou can now trade with: npx tsx scripts/trade.ts open --pair ETH --side long --size 500');
    } else {
      console.error('\n❌ Failed to register API wallet:');
      console.error(JSON.stringify(result, null, 2));
      console.error('\nThe private key was NOT saved. Fix the issue and retry.');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('\n❌ Error during wallet approval:');
    console.error(err.message || err);
    if (err.response) {
      console.error('Response:', await err.response.text());
    }
    process.exit(1);
  }
}

main().catch(console.error);
