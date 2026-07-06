declare module "better-sqlite3" {
  namespace Database {
    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }

    interface Options {
      readonly?: boolean;
      fileMustExist?: boolean;
      timeout?: number;
      verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
    }

    interface Statement {
      run(...params: unknown[]): RunResult;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    }

    interface Database {
      close(): void;
      exec(source: string): this;
      pragma(source: string, options?: { simple?: boolean }): unknown;
      prepare(source: string): Statement;
      transaction<TArgs extends unknown[], TResult>(
        fn: (...args: TArgs) => TResult
      ): (...args: TArgs) => TResult;
    }
  }

  class Database {
    constructor(filename: string | Buffer, options?: Database.Options);
    close(): void;
    exec(source: string): this;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    prepare(source: string): Database.Statement;
    transaction<TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => TResult
    ): (...args: TArgs) => TResult;
  }

  export = Database;
}
