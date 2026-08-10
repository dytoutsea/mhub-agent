import type { Socket } from "node:net";

interface PendingRead {
  readonly length: number;
  readonly resolve: (value: Buffer) => void;
  readonly reject: (reason: Error) => void;
}

export class SocketReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private pending: PendingRead | null = null;

  constructor(
    private readonly socket: Socket,
    private readonly maxBufferedBytes = 64 * 1024,
  ) {
    socket.on("data", this.onData);
    socket.once("error", this.onError);
    socket.once("close", this.onClose);
  }

  readExactly(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 1 || length > this.maxBufferedBytes) {
      return Promise.reject(new Error("INVALID_READ_LENGTH"));
    }
    if (this.pending) {
      return Promise.reject(new Error("CONCURRENT_SOCKET_READ"));
    }
    if (this.buffer.length >= length) {
      return Promise.resolve(this.consume(length));
    }
    if (this.ended) {
      return Promise.reject(new Error("SOCKET_CLOSED"));
    }

    return new Promise((resolve, reject) => {
      this.pending = { length, resolve, reject };
    });
  }

  detach(): Buffer {
    if (this.pending) {
      throw new Error("PENDING_SOCKET_READ");
    }
    this.removeListeners();
    const buffered = this.buffer;
    this.buffer = Buffer.alloc(0);
    return buffered;
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBufferedBytes) {
      this.fail(new Error("SOCKET_BUFFER_LIMIT"));
      this.socket.destroy();
      return;
    }
    this.resolvePending();
  };

  private readonly onError = () => {
    this.fail(new Error("SOCKET_ERROR"));
  };

  private readonly onClose = () => {
    this.ended = true;
    this.fail(new Error("SOCKET_CLOSED"));
  };

  private resolvePending() {
    const pending = this.pending;
    if (!pending || this.buffer.length < pending.length) {
      return;
    }
    this.pending = null;
    pending.resolve(this.consume(pending.length));
  }

  private consume(length: number): Buffer {
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  private fail(error: Error) {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = null;
    pending.reject(error);
  }

  private removeListeners() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }
}
