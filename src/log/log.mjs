/**
 * 请求日志（内存环形 200 条）+ 并发闸门。
 *
 * 刻意不落盘：面板只展示最近 40 条，重启丢失可以接受，也避免日志文件无限增长。
 * 闸门限制的是"同时进行中的上游请求数"，防止一次批量调用把上游打爆。
 */
const MAX = 200;

const entries = [];

export function record(entry) {
  entries.unshift({ ts: new Date().toISOString(), ...entry });
  if (entries.length > MAX) entries.length = MAX;
}

export function recent(limit = 30) {
  return entries.slice(0, limit);
}

export function clear() {
  entries.length = 0;
}

export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  stats() {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }
}
