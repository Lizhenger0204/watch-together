/** 只排序同一個 DO 實例內尚在執行的工作。狀態與清理進度另存於 storage。 */
export class SerialQueue {
  private tail = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
