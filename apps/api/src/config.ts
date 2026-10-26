import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export const databasePath =
  process.env.DATABASE_PATH ?? resolve(repositoryRoot, ".data", "assessment.sqlite");
export const apiPort = Number(process.env.API_PORT ?? 3001);
export const baselineCsvPath = resolve(
  repositoryRoot,
  "fixtures",
  "assessment_requests.csv",
);
export const mockAiFixturePath = resolve(
  repositoryRoot,
  "fixtures",
  "mock-ai-responses.json",
);
