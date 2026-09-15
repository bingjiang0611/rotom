// Mirrors Goal's persisted state shape, not tool-dispatch acknowledgement.
export const isCleared = (goal) => goal == null;
export const isWaiting = (goal) => goal?.status === "active" && Boolean(goal.waiting);
