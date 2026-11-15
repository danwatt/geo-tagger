/* A client batch loop (POST a batch, read `remaining`, repeat) trusts the server
 * to make progress. A photo whose processing throws stays queued and is picked
 * again next batch, so a batch made entirely of such rows leaves `remaining`
 * unchanged and the loop would spin forever. stallGuard(label) returns
 * check(remaining), called once per batch; it throws after `maxStalls`
 * consecutive batches that didn't lower `remaining` against the previous one.
 * Compared to the previous batch rather than the best seen, so a count that jumps
 * up (a scan added photos meanwhile) and then drains again isn't a stall.
 * Port of common.js stallGuard. */
export function stallGuard(label: string, maxStalls = 3): (remaining: number) => void {
  let prev = Infinity;
  let stalls = 0;
  return (remaining) => {
    if (remaining < prev) stalls = 0;
    else if (++stalls >= maxStalls) {
      throw new Error(
        `${label} stopped: ${maxStalls} batches in a row made no progress ` +
          `(${remaining.toLocaleString()} still left). Check the server log.`,
      );
    }
    prev = remaining;
  };
}
