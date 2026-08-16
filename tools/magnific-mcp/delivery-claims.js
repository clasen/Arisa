import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function claimPath(stateDir, jobId, index) {
  return path.join(stateDir, "delivery-claims", jobId, `${index}.json`);
}

export async function deliveryClaimed(stateDir, jobId, index) {
  try {
    await stat(claimPath(stateDir, jobId, index));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function claimDelivery(stateDir, jobId, index, identifier) {
  const filePath = claimPath(stateDir, jobId, index);
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const claim = { identifier, attemptedAt: new Date().toISOString() };
    await writeFile(filePath, `${JSON.stringify(claim, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Delivery was already attempted for this image; automatic retry is blocked");
    throw error;
  }
}
