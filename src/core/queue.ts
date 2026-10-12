/** Serializes related state mutations, including their persistence, without poisoning future work after a failure. */
export class MutationQueue {
  private pending:Promise<unknown>=Promise.resolve();
  run<T>(task:()=>Promise<T>):Promise<T>{const result=this.pending.then(task);this.pending=result.catch(()=>undefined);return result;}
}
