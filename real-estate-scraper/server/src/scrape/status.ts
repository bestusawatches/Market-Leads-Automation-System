import EventEmitter from "events";

export type ScrapeStatus = {
  running: boolean;
  scrapingId?: string;
  startedAt?: string;
  finishedAt?: string;
  current?: string;
  total?: number;
  completed?: number;
  percent?: number;
};

const emitter = new EventEmitter();

let status: ScrapeStatus = { running: false, percent: 0, total: 0, completed: 0 };

export function getStatus(): ScrapeStatus {
  return { ...status };
}

export function setRunning(running: boolean, scrapingId?: string) {
  status.running = running;
  if (running) {
    status.scrapingId = scrapingId ?? status.scrapingId;
    status.startedAt = new Date().toISOString();
    status.finishedAt = undefined;
    status.completed = 0;
    status.percent = 0;
  } else {
    status.finishedAt = new Date().toISOString();
  }
  emitter.emit("update", getStatus());
}

export function setProgress(partial: Partial<Pick<ScrapeStatus, "current" | "total" | "completed">>) {
  if (partial.current !== undefined) status.current = partial.current;
  if (partial.total !== undefined) status.total = partial.total;
  if (partial.completed !== undefined) status.completed = partial.completed;
  if (status.total && status.completed !== undefined) {
    status.percent = Math.round((status.completed! / status.total!) * 100);
  }
  emitter.emit("update", getStatus());
}

export function onUpdate(cb: (s: ScrapeStatus) => void) {
  emitter.on("update", cb);
}

export function offUpdate(cb: (s: ScrapeStatus) => void) {
  emitter.off("update", cb);
}

export default {
  getStatus,
  setRunning,
  setProgress,
  onUpdate,
  offUpdate,
};
