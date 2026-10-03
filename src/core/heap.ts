/** Binary min-heap of (priority, value) pairs stored in parallel typed-ish arrays. */
export class MinHeap {
  private pri: number[] = [];
  private val: number[] = [];

  get size(): number {
    return this.pri.length;
  }

  clear(): void {
    this.pri.length = 0;
    this.val.length = 0;
  }

  push(priority: number, value: number): void {
    const pri = this.pri, val = this.val;
    let i = pri.length;
    pri.push(priority);
    val.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (pri[p] <= priority) break;
      pri[i] = pri[p];
      val[i] = val[p];
      i = p;
    }
    pri[i] = priority;
    val[i] = value;
  }

  peekPriority(): number {
    return this.pri[0];
  }

  /** Pops the minimum; returns the value. Read `lastPriority` for its priority. */
  lastPriority = 0;
  pop(): number {
    const pri = this.pri, val = this.val;
    const topV = val[0];
    this.lastPriority = pri[0];
    const lp = pri.pop()!, lv = val.pop()!;
    const n = pri.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && pri[r] < pri[l] ? r : l;
        if (pri[c] >= lp) break;
        pri[i] = pri[c];
        val[i] = val[c];
        i = c;
      }
      pri[i] = lp;
      val[i] = lv;
    }
    return topV;
  }
}
