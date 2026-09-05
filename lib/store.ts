import { PostgresRecoveryStore } from "@/lib/pg-store";
import { RecoveryStore } from "@/lib/memory-store";

export { RecoveryStore };

const globalStore = globalThis as unknown as { recoverOsStore?: RecoveryStore };

function createStore(): RecoveryStore {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) return new PostgresRecoveryStore(connectionString);
  return new RecoveryStore();
}

export const store = globalStore.recoverOsStore ?? (globalStore.recoverOsStore = createStore());
