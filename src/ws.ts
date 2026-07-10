export type ConnectionStatus = "connecting" | "open" | "closed";

export type BinaryCallback = (data: ArrayBuffer) => void;
export type ControlCallback = (msg: unknown) => void;
export type StatusCallback = (status: ConnectionStatus) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 5000;

export class WsClient {
  private url: string;
  private ws: WebSocket | null = null;
  private exitReceived = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private binaryCb: BinaryCallback | null = null;
  private controlCb: ControlCallback | null = null;
  private statusCb: StatusCallback | null = null;

  constructor(url: string) {
    this.url = url;
  }

  onBinary(cb: BinaryCallback): this {
    this.binaryCb = cb;
    return this;
  }

  onControl(cb: ControlCallback): this {
    this.controlCb = cb;
    return this;
  }

  onStatus(cb: StatusCallback): this {
    this.statusCb = cb;
    return this;
  }

  connect(): this {
    this._connect();
    return this;
  }

  private _connect() {
    if (this.destroyed) return;
    this.statusCb?.("connecting");

    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.statusCb?.("open");
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.binaryCb?.(ev.data);
      } else if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as { type?: string };
          if (msg.type === "exit") {
            this.exitReceived = true;
          }
          this.controlCb?.(msg);
        } catch {
          // ignore malformed JSON
        }
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.statusCb?.("closed");
      if (!this.exitReceived && !this.destroyed) {
        this._scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror, so reconnect logic lives there
    };
  }

  private _scheduleReconnect() {
    if (this.destroyed || this.exitReceived) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_CAP_MS);
      this._connect();
    }, this.reconnectDelay);
  }

  sendBinary(bytes: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
  }

  sendControl(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

export function createWsClient(url: string): WsClient {
  return new WsClient(url);
}
