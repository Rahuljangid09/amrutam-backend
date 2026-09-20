import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { reencryptAll } from "../common/keyRotation";

// Key rotation, step by step:
//   1. generate a new key:          npm run gen-secrets
//   2. add it to the ring:          ENCRYPTION_KEYS=v1:<old>,v2:<new>      (old key stays so existing data can still be read)
//   3. make it the active key:      ENCRYPTION_ACTIVE_KEY_ID=v2            (deploy: new writes now use v2)
//   4. re-encrypt existing data:    npm run rotate-keys                    (this script)
//   5. once it reports 0 remaining, remove v1 from ENCRYPTION_KEYS.
async function main() {
  console.log(`Re-encrypting with active key "${env.ENCRYPTION_ACTIVE_KEY_ID}"...`);
  console.log(await reencryptAll());
}
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
